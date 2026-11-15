const {profiles}=require('./scoring');
const {UNIFIED_PROJECTS}=require('./unified-projects');
const FAMILIES=[
 {label:'호텔 객실제어',aliases:['호텔객실제어','객실제어','객실관리','grms'],types:['숙박시설'],terms:['호텔','리조트','객실']},
 {label:'조명·조명제어',aliases:['조명','lighting'],types:['업무시설','숙박시설','판매시설','교육연구시설','의료시설'],terms:['조명','전기공사','스마트빌딩']},
 {label:'공조·기계설비',aliases:['냉난방','공조','hvac','밸브','환기','냉동기','보일러','히트펌프'],types:['업무시설','숙박시설','의료시설','판매시설','공장','교육연구시설'],terms:['기계설비','공조','냉난방','환기','에너지']},
 {label:'자동제어·빌딩관리',aliases:['자동제어','빌딩제어','bems','bms','스마트빌딩','scada'],types:['업무시설','숙박시설','의료시설','교육연구시설','판매시설','공장'],terms:['자동제어','스마트','빌딩','에너지','감시제어']},
 {label:'전기·통신·소방',aliases:['전기','통신','소방','화재','cctv','출입통제','스위치','콘센트'],types:['업무시설','공동주택','숙박시설','의료시설','공장'],terms:['전기','통신','소방','보안']},
 {label:'승강기·주차설비',aliases:['엘리베이터','승강기','주차설비','주차관제'],types:['공동주택','업무시설','숙박시설','판매시설','의료시설'],terms:['승강기','엘리베이터','주차']},
 {label:'건축자재·설비',aliases:['건축자재','창호','단열','방수','외장재','내장재'],types:['공동주택','업무시설','숙박시설','공장','판매시설'],terms:['신축','증축','창호','단열','방수']}
];
const compact=v=>String(v).normalize('NFKC').toLowerCase().replace(/\s+/g,'');
function recommendationOptions(input={}){
 const profile=String(input.profile||'automation');if(!Object.hasOwn(profiles,profile))throw Error('영업 업종을 확인해 주세요.');
 const product=String(input.product||'').normalize('NFKC').trim();if(product.length>120)throw Error('제품·서비스는 120자 이내로 입력해 주세요.');
 const region=String(input.region||'').trim(),district=String(input.district||'').trim();if(region.length>80||district.length>80)throw Error('지역을 확인해 주세요.');if(district&&!region)throw Error('시·도를 먼저 선택해 주세요.');
 const base=profiles[profile],family=product?FAMILIES.find(f=>f.aliases.some(a=>compact(product).includes(a))):null;
 const terms=product?(family?[...new Set([...family.terms,product,...family.aliases.filter(a=>compact(product).includes(a))])]:[product]):base.terms,types=product?(family?family.types:[]):base.types;
 return {profile,product,region,district,types,terms,stages:base.stages,mode:!product?'industry':family?'related':'literal',intentLabel:family?.label||product||base.label};
}
function districtExpression(alias='p'){
 const first=`split_part(regexp_replace(BTRIM(COALESCE(${alias}.district,'')),'[[:space:]]+',' ','g'),' ',1)`,second=`split_part(regexp_replace(BTRIM(COALESCE(${alias}.district,'')),'[[:space:]]+',' ','g'),' ',2)`;
 return `CASE WHEN ${first}~'^[가-힣0-9·]+[시군구]$' THEN CASE WHEN ${first}~'시$' AND ${second}~'^[가-힣0-9·]+구$' THEN ${first}||' '||${second} ELSE ${first} END ELSE NULL END`;
}
const pattern=v=>'%'+v.replace(/[\\%_]/g,'\\$&')+'%';
function recommendationQuery(options,regionAliases){
 const args=[],bind=v=>{args.push(v);return '$'+args.length;};
 const types=bind(options.types.map(pattern)),terms=bind(options.terms.map(pattern)),stages=bind(options.stages);
 const typeMatch=`COALESCE(p.building_type,'') ILIKE ANY(${types}::text[])`,termMatch=`(COALESCE(p.name,'')||' '||COALESCE(p.building_type,'')) ILIKE ANY(${terms}::text[])`;
 const where=["p.source<>'demo'","(SELECT BOOL_OR(r.is_current) FROM review_extracted_projects r WHERE r.project_id=p.id) IS DISTINCT FROM FALSE"];
 if(options.region)where.push(`p.region ILIKE ANY(${bind(regionAliases(options.region).map(pattern))}::text[])`);
 if(options.district)where.push(`${districtExpression()}=${bind(options.district)}`);
 const cte=UNIFIED_PROJECTS+`, recommendation_signals AS (
 SELECT i.canonical_id,BOOL_OR(${typeMatch}) AS type_match,BOOL_OR(${termMatch}) AS term_match
 FROM projects p JOIN unified_identity i ON i.project_id=p.id WHERE p.source<>'demo'
 AND (SELECT BOOL_OR(r.is_current) FROM review_extracted_projects r WHERE r.project_id=p.id) IS DISTINCT FROM FALSE
 AND (${typeMatch} OR ${termMatch}) GROUP BY i.canonical_id
), recommendation_ranked AS (
 SELECT p.*,CASE WHEN p.source='g2b_bid' THEN COALESCE((SELECT g.title FROM unified_group_roots g WHERE g.canonical_id=p.id LIMIT 1),p.name) ELSE p.name END AS display_name,s.type_match,s.term_match,(p.stage=ANY(${stages}::text[])) AS stage_match,
 (CASE WHEN s.type_match THEN 30 ELSE 0 END+CASE WHEN s.term_match THEN 20 ELSE 0 END+
 CASE WHEN p.area_sqm>=5000 THEN 20 WHEN p.area_sqm>=1000 THEN 12 ELSE 0 END+
 CASE WHEN p.stage=ANY(${stages}::text[]) THEN 20 ELSE 0 END+CASE WHEN NULLIF(BTRIM(p.region),'') IS NOT NULL THEN 10 ELSE 0 END)::int AS score,
 us.notice_count,us.trade_count,us.member_count,us.latest_update,
 (SELECT COUNT(*)::int FROM unified_contacts c WHERE c.canonical_id=p.id) AS contact_count,
 EXISTS(SELECT 1 FROM unified_contacts c WHERE c.canonical_id=p.id AND NULLIF(BTRIM(c.phone),'') IS NOT NULL) AS has_phone,
 EXISTS(SELECT 1 FROM unified_contacts c WHERE c.canonical_id=p.id AND NULLIF(BTRIM(c.email),'') IS NOT NULL) AS has_email
 FROM projects p JOIN recommendation_signals s ON s.canonical_id=p.id JOIN unified_stats us ON us.canonical_id=p.id
 WHERE ${where.join(' AND ')}
)`;
 return {args,sql:cte+` SELECT r.*,(SELECT COUNT(*)::int FROM recommendation_ranked) AS candidate_total FROM recommendation_ranked r ORDER BY score DESC,latest_update DESC,id DESC LIMIT 100`};
}
function reasons(p,options){
 const result=[];
 if(p.type_match)result.push(options.product?'입력 제품과 관련된 건물 용도·공종':'선택 업종과 관련된 건물 용도·공종');
 if(p.term_match)result.push(options.mode==='literal'?'입력 제품 문구가 프로젝트명·용도에 포함':'프로젝트명·용도에 관련 키워드 포함');
 if(p.stage_match)result.push(({REVIEW:'심의·환경평가 공개 단계',PERMIT:'인허가 단계 · 착공 전 영업 검토',STARTED:'착공 단계',BID:'입찰공고 확인 단계'})[p.stage]||'선택 업종의 관심 단계');
 if(Number(p.area_sqm)>0)result.push('저장 연면적 '+Number(p.area_sqm).toLocaleString('ko-KR')+'㎡');
 if(options.region)result.push('선택 지역: '+options.region+(options.district?' '+options.district:''));
 return result;
}
function registerRecommendationRoutes(app,{query,regionAliases}){
 app.get('/api/recommendation-districts',async(req,res)=>{
  const region=String(req.query.region||'').trim();if(!region||region.length>80)return res.status(400).json({error:'시·도를 먼저 선택해 주세요.'});
  try{const result=await query(`SELECT DISTINCT ${districtExpression()} AS district FROM projects p WHERE p.source<>'demo' AND p.region ILIKE ANY($1::text[]) ORDER BY district`,[regionAliases(region).map(pattern)]);res.json({districts:result.rows.map(r=>r.district).filter(Boolean),note:'저장된 현장에 확인된 시·군·구입니다.'});}catch{res.status(500).json({error:'시·군·구를 조회하지 못했습니다.'});}
 });
 app.get('/api/recommendations',async(req,res)=>{
  let options;try{options=recommendationOptions(req.query);}catch(e){return res.status(400).json({error:e.message});}
  try{const q=recommendationQuery(options,regionAliases),result=await query(q.sql,q.args);
   const rows=result.rows.map(p=>{const {candidate_total,...record}=p;return {...record,name:record.display_name||record.name,profile:profiles[options.profile].label,recommendation_reasons:reasons(record,options)};});
   res.json({rows,total:result.rows[0]?.candidate_total||0,limit:100,profile:profiles[options.profile].label,product:options.product,region:options.region,district:options.district,match_mode:options.mode,intent:options.intentLabel,
    note:options.mode==='literal'?'제품 자동 연관 규칙이 없어 입력 문구가 저장된 프로젝트명·용도에 포함된 자료를 찾았습니다. 업종을 바꾸거나 제품을 구체화해 주세요.':'저장 용도·공종·규모·진행 단계에 따른 연관 추천이며, 해당 제품의 발주·구매 필요가 확인된 것은 아닙니다.'});
  }catch{res.status(500).json({error:'추천 현장을 조회하지 못했습니다.'});}
 });
}
module.exports={recommendationOptions,recommendationQuery,districtExpression,reasons,registerRecommendationRoutes};
