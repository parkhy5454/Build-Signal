const {awardKey,SOURCE_URL}=require('./awards');
const AWARD_RECORDS=`WITH records AS (
 SELECT 'award:'||a.id AS record_id,'public_award'::text AS kind,a.name,a.winner AS organization,a.owner,
 a.award_amount AS amount,a.award_date AS event_date,'최종낙찰일'::text AS date_label,
 a.company_phone AS phone,a.company_person AS person,a.company_address AS company_address,a.business_no,
 a.notice_no,a.notice_ord,a.classification_no,a.rebid_no,a.source_url,a.last_seen_at AS checked_at,p.id AS project_id,p.region,
 NULL::numeric AS area_sqm,NULL::date AS start_date,NULL::date AS completion_date
 FROM construction_awards a LEFT JOIN projects p ON p.source='g2b_bid' AND p.external_id=a.notice_no||'-'||a.notice_ord
 UNION ALL
 SELECT 'construction:'||p.id,'construction_contractor',p.name,COALESCE(e.organization,NULLIF(BTRIM(p.contractor),'')),p.owner,
 NULL::numeric,p.start_date,'실제착공일',e.phone,e.person_name,NULL::text,NULL::text,
 NULL::text,NULL::text,NULL::text,NULL::text,COALESCE(e.source_url,p.source_url),p.updated_at,p.id,p.region,p.area_sqm,p.start_date,p.completion_date
 FROM projects p LEFT JOIN LATERAL (
  SELECT pe.organization,pe.source_url,pe.phone,pe.person_name FROM project_party_evidence pe WHERE pe.project_id=p.id AND pe.role='contractor' AND pe.observed_stage IN ('STARTED','COMPLETED') ORDER BY pe.observed_at DESC,pe.id DESC LIMIT 1
 ) e ON TRUE
 WHERE p.source<>'demo' AND p.stage IN ('STARTED','COMPLETED') AND p.start_date IS NOT NULL
 AND (e.organization IS NOT NULL OR (NULLIF(BTRIM(p.contractor),'') IS NOT NULL AND p.source_url LIKE 'https://%'))
 AND (SELECT BOOL_OR(rp.is_current) FROM review_extracted_projects rp WHERE rp.project_id=p.id) IS DISTINCT FROM FALSE
)`;
function awardFilters(input,regionAliases){
 const params=[],where=[];const add=(value,sql)=>{params.push(value);where.push(sql.replaceAll('?',`$${params.length}`));};
 const kind=String(input.kind||'');if(!['','public_award','construction_contractor'].includes(kind))throw Error('잘못된 수주 정보 구분입니다.');if(kind)add(kind,'kind=?');
 const keyword=String(input.q||'').trim().slice(0,120);if(keyword)add('%'+keyword+'%','(name ILIKE ? OR organization ILIKE ? OR owner ILIKE ? OR notice_no ILIKE ?)');
 if(input.region)add(regionAliases(String(input.region).slice(0,60)).map(x=>'%'+x+'%'),'region ILIKE ANY(?::text[])');
 if(input.minAmount!==undefined&&String(input.minAmount).trim()!==''){const n=Number(input.minAmount);if(!Number.isFinite(n)||n<0||n>1e16)throw Error('최소 낙찰금액을 확인하세요.');add(n,'amount>=?');}
 for(const [v,op] of [[input.from,'>='],[input.to,'<=']]){if(!v)continue;const s=String(v),d=new Date(s+'T00:00:00Z');if(!/^\d{4}-\d{2}-\d{2}$/.test(s)||!Number.isFinite(+d)||d.toISOString().slice(0,10)!==s)throw Error('날짜를 확인하세요.');add(s,'event_date'+op+'?::date');}
 if(input.from&&input.to&&input.from>input.to)throw Error('시작일이 종료일보다 늦습니다.');
 const page=Number(input.page||1);if(!Number.isSafeInteger(page)||page<1||page>1000000)throw Error('페이지를 확인하세요.');
 const sort=String(input.sort||'recent');if(!['recent','amount'].includes(sort))throw Error('정렬 조건을 확인하세요.');
 return {params,clause:where.length?' WHERE '+where.join(' AND '):'',page,order:sort==='amount'?'amount DESC NULLS LAST,event_date DESC NULLS LAST,record_id':'event_date DESC NULLS LAST,record_id'};
}
function registerAwardRoutes(app,{query,regionAliases,env=process.env}){
 app.get('/api/awards/status',async(req,res)=>{try{
  const row=(await query("SELECT last_attempt_at,last_success_at,last_error,next_due_at,lease_until FROM auto_ingest_state WHERE source='awards'")).rows[0]||{};
  res.json({enabled:env.AUTO_INGEST_ENABLED!=='false',keyConfigured:!!awardKey(env),...row,sourceUrl:SOURCE_URL,
   constructionNote:'착공 시공사 목록은 출처가 있는 저장 자료만 표시합니다. HUB 관계자 추가 수집은 연결 검증 전이며, 공개 기본개요 API만으로 시공사가 채워지지 않습니다. 공공·민간 구분과 계약금액은 착공 기록만으로 확정하지 않습니다.'});
 }catch{res.status(500).json({error:'낙찰 수집 상태 조회 실패'});}});
 app.get('/api/awards',async(req,res)=>{
  let filter;try{filter=awardFilters(req.query,regionAliases);}catch(e){return res.status(400).json({error:e.message});}
  try{const {params,clause,page,order}=filter;
   const count=await query(AWARD_RECORDS+' SELECT COUNT(*)::int AS n FROM records'+clause,params);
   const rows=await query(AWARD_RECORDS+' SELECT * FROM records'+clause+` ORDER BY ${order} LIMIT 30 OFFSET $${params.length+1}`,[...params,(page-1)*30]);
   res.json({rows:rows.rows,total:count.rows[0].n,page,pages:Math.ceil(count.rows[0].n/30),note:'공공 낙찰은 공사 최종낙찰 결과이며 계약 체결·착공 완료를 뜻하지 않습니다. 착공 시공사 확인은 수주금액·계약일 미확인 자료이며 공공·민간을 자동 판정하지 않습니다. 지역은 연결된 현장·공고의 저장 지역이며 업체 사업장 주소를 현장 위치로 사용하지 않습니다.'});
  }catch{res.status(500).json({error:'수주·낙찰 정보를 조회하지 못했습니다.'});}
 });
}
module.exports={AWARD_RECORDS,awardFilters,registerAwardRoutes};
