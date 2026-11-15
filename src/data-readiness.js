const {UNIFIED_PROJECTS}=require('./unified-projects');
const {config:hubConfig}=require('./hub-construction');
const known=c=>`NULLIF(BTRIM(COALESCE(${c},'')),'') IS NOT NULL AND BTRIM(${c}) NOT IN ('-','미확인','확인 중','확인중','원문 미제공','정보 없음','없음','비공개')`;
const phone=c=>`COALESCE(${c},'')~'^[+0-9() .-]{7,25}$' AND COALESCE(${c},'')~'[0-9]{2}'`;
const email=c=>`COALESCE(${c},'')~'^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'`;
const DATA_READINESS_SQL=UNIFIED_PROJECTS+`,
audit_projects AS (
 SELECT p.*,i.canonical_id,(SELECT BOOL_OR(r.is_current) FROM review_extracted_projects r WHERE r.project_id=p.id) IS DISTINCT FROM FALSE AS source_current
 FROM projects p JOIN unified_identity i ON i.project_id=p.id WHERE p.source<>'demo'
),
audit_parties AS (
 SELECT p.canonical_id,c.role,c.organization,c.phone,c.email,c.person_name FROM audit_projects p JOIN project_contacts c ON c.project_id=p.id
 WHERE p.source_current AND ${known('c.organization')}
 AND (c.source<>'hub_construction' OR EXISTS(SELECT 1 FROM project_party_evidence pe JOIN hub_construction_checks h ON h.project_id=pe.project_id
  WHERE pe.project_id=p.id AND pe.role=c.role AND pe.organization=c.organization AND pe.id=ANY(h.current_evidence_ids)))
 UNION ALL
 SELECT p.canonical_id,e.role,e.organization,e.phone,e.email,e.person_name FROM audit_projects p JOIN project_party_evidence e ON e.project_id=p.id
 WHERE p.source_current AND ${known('e.organization')}
 AND (e.origin<>'hub_construction' OR EXISTS(SELECT 1 FROM hub_construction_checks h WHERE h.project_id=p.id AND e.id=ANY(h.current_evidence_ids)))
 UNION ALL
 SELECT DISTINCT p.canonical_id,c.role,c.organization,c.phone,c.email,c.person_name FROM audit_projects p JOIN project_group_contacts c ON c.group_id=p.project_group_id
 WHERE p.source='g2b_bid' AND p.source_current AND ${known('c.organization')}
 UNION ALL
 SELECT p.canonical_id,v.role,v.organization,NULL::text,NULL::text,NULL::text FROM audit_projects p
 CROSS JOIN LATERAL (VALUES(CASE WHEN p.source='g2b_bid' THEN 'client' ELSE 'owner' END,p.owner),('designer',p.designer),('supervisor',p.supervisor),('contractor',p.contractor)) v(role,organization)
 WHERE p.source_current AND p.source_url~'^https?://' AND ${known('v.organization')}
),
audit_role_counts AS (
 SELECT role,COUNT(DISTINCT canonical_id)::int AS organization,
 COUNT(DISTINCT canonical_id) FILTER(WHERE ${phone('phone')})::int AS phone,
 COUNT(DISTINCT canonical_id) FILTER(WHERE ${email('email')})::int AS email,
 COUNT(DISTINCT canonical_id) FILTER(WHERE (${phone('phone')} OR ${email('email')}) AND ${known('person_name')})::int AS named_contact
 FROM audit_parties GROUP BY role
),
audit_business AS (
 SELECT p.id,p.region,p.stage,p.area_sqm,
 BOOL_OR(a.source='g2b_bid') AS procurement_backed,
 BOOL_OR(a.source_current) AS source_current,
 BOOL_OR(a.stage='PERMIT' AND a.permit_date IS NULL OR a.stage='STARTED' AND a.start_date IS NULL OR a.stage='COMPLETED' AND a.completion_date IS NULL) AS missing_event_date,
 EXISTS(SELECT 1 FROM audit_parties r WHERE r.canonical_id=p.id) AS has_party,
 EXISTS(SELECT 1 FROM audit_parties r WHERE r.canonical_id=p.id AND (${phone('r.phone')} OR ${email('r.email')})) AS has_contact
 FROM audit_projects a JOIN projects p ON p.id=a.canonical_id GROUP BY p.id
),
audit_regions AS (
 SELECT COALESCE(NULLIF(BTRIM(region),''),'지역 미확인') AS region,COUNT(*)::int AS projects,
 COUNT(*) FILTER(WHERE has_party)::int AS with_party,COUNT(*) FILTER(WHERE has_contact)::int AS with_contact
 FROM audit_business GROUP BY COALESCE(NULLIF(BTRIM(region),''),'지역 미확인')
),
audit_stages AS (
 SELECT stage,COUNT(*)::int AS projects,COUNT(*) FILTER(WHERE has_party)::int AS with_party,
 COUNT(*) FILTER(WHERE has_contact)::int AS with_contact FROM audit_business GROUP BY stage
),
audit_sources AS (
 SELECT source,COUNT(*)::int AS records,COUNT(DISTINCT canonical_id)::int AS projects,MAX(updated_at) AS latest_update
 FROM audit_projects GROUP BY source
)
SELECT json_build_object(
 'generated_at',NOW(),
 'summary',json_build_object('source_records',(SELECT COUNT(*)::int FROM audit_projects),'projects',(SELECT COUNT(*)::int FROM audit_business),
  'demo_excluded',(SELECT COUNT(*)::int FROM projects WHERE source='demo'),
  'with_party',(SELECT COUNT(*)::int FROM audit_business WHERE has_party),'with_contact',(SELECT COUNT(*)::int FROM audit_business WHERE has_contact),
  'missing_area',(SELECT COUNT(*)::int FROM audit_business WHERE area_sqm IS NULL OR area_sqm<=0),
  'missing_event_date',(SELECT COUNT(*)::int FROM audit_business WHERE missing_event_date),
  'historical_only',(SELECT COUNT(*)::int FROM audit_business WHERE NOT source_current),
  'procurement_backed',(SELECT COUNT(*)::int FROM audit_business WHERE procurement_backed)),
 'roles',COALESCE((SELECT json_agg(r ORDER BY r.role) FROM audit_role_counts r),'[]'::json),
 'regions',COALESCE((SELECT json_agg(r ORDER BY r.region) FROM audit_regions r),'[]'::json),
 'stages',COALESCE((SELECT json_agg(s ORDER BY s.stage) FROM audit_stages s),'[]'::json),
 'sources',COALESCE((SELECT json_agg(s ORDER BY s.source) FROM audit_sources s),'[]'::json),
 'awards',(SELECT json_build_object('records',COUNT(*)::int,'linked_notices',COUNT(*) FILTER(WHERE EXISTS(SELECT 1 FROM projects p WHERE p.source='g2b_bid' AND p.external_id=a.notice_no||'-'||a.notice_ord))::int,
  'with_phone',COUNT(*) FILTER(WHERE ${phone('a.company_phone')})::int,'latest_checked',MAX(a.last_seen_at)) FROM construction_awards a),
 'collection',COALESCE((SELECT json_agg(json_build_object('source',source,'last_success_at',last_success_at,'has_error',last_error IS NOT NULL) ORDER BY source) FROM auto_ingest_state),'[]'::json)
) AS report`;
const ROLES=['client','owner','developer','applicant','designer','supervisor','contractor','operator'];
const STAGES=['REVIEW','PERMIT','STARTED','COMPLETED','BID','UNKNOWN'];
async function readDataReadiness(query,{provinces=[],env=process.env}={}){
 const data=(await query(DATA_READINESS_SQL)).rows[0].report;
 const roles=new Map(data.roles.map(r=>[r.role,r]));data.roles=ROLES.map(role=>roles.get(role)||{role,organization:0,phone:0,email:0,named_contact:0});
 const stages=new Map(data.stages.map(r=>[r.stage,r]));data.stages=[...STAGES,...[...stages.keys()].filter(s=>!STAGES.includes(s))].map(stage=>stages.get(stage)||{stage,projects:0,with_party:0,with_contact:0});
 const regions=new Map(data.regions.map(r=>[r.region,r]));
 for(const p of provinces.filter(p=>p.code))if(!regions.has(p.value))regions.set(p.value,{region:p.value,projects:0,with_party:0,with_contact:0});
 data.regions=[...regions.values()].sort((a,b)=>a.region.localeCompare(b.region,'ko'));
 const sources=new Map(data.sources.map(r=>[r.source,r]));
 for(const source of ['g2b_bid','arch_hub_permit','public_review','document_review','seoul_review','environment_review'])if(!sources.has(source))sources.set(source,{source,records:0,projects:0,latest_update:null});
 data.sources=[...sources.values()];
 const total=data.summary.projects;
 data.sector={ownership_classification:'not_collected',ownership_unclassified:total,procurement_backed:data.summary.procurement_backed,
  note:'공공조달 공고 연결은 공공·민간 소유/시행주체 판정과 다릅니다. 현재 소유/시행주체 구분 자료를 수집하지 않아 전체가 미판정이며, HUB 출처나 회사명으로 민간을 추정하지 않습니다.'};
 data.hub={enabled:hubConfig(env).enabled,status:hubConfig(env).status};
 data.notes=['건수·확보율의 분모는 데모를 제외한 저장 자료의 통합 프로젝트입니다. 전국 실제 사업 전체에 대한 수집률이 아닙니다.',
 '지역·단계는 목록 대표 프로젝트 기준입니다. 지역명이 없거나 기존 지역명으로 저장된 자료는 따로 표시하며, 0건이 해당 지역 사업 부재를 뜻하지 않습니다.',
 '업체 확보는 원문/저장 연락처의 업체명 보유 기준이며 동일 업체 확정이나 연락처 유효성 검증을 뜻하지 않습니다. 담당자명+연락수단도 현장 직통번호를 보장하지 않습니다.',
 'HUB 과거 업체 근거와 최신 원문에서 빠진 심의 안건의 업체 정보는 확보 건수에서 제외합니다. 낙찰 건수는 별도 결과 기록 단위로 프로젝트 수와 합산하지 않습니다.'];
 return data;
}
function registerDataReadinessRoute(app,{query,loadUser,requireAdminRole,provinces,env=process.env}){
 app.get('/api/admin/data-readiness',loadUser,requireAdminRole,async(req,res)=>{
  res.set('Cache-Control','no-store');try{res.json(await readDataReadiness(query,{provinces,env}));}
  catch{res.status(500).json({error:'저장 데이터 점검표를 조회하지 못했습니다.'});}
 });
}
module.exports={DATA_READINESS_SQL,readDataReadiness,registerDataReadinessRoute};
