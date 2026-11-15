// Public HUB map web response, inspected 2026-11-15. This is NOT the ArchPmsHubService API.
const crypto=require('node:crypto');
const cheerio=require('cheerio');
const {permitDate}=require('./archhub');
const {normalizeEvidence,insertEvidence}=require('./early-projects');
const ORIGIN='https://www.hub.go.kr',PAGE=ORIGIN+'/portal/gis/css/idx-css-list.do';
const DETAIL='/portal/gis/restCss/select-CssDetail.do';
const ROLES={건축주:'owner',설계자:'designer',감리자:'supervisor',시공자:'contractor'};
const clean=v=>String(v??'').replace(/\s+/g,' ').trim();
const addressKey=v=>clean(v).normalize('NFKC').replace(/\s+/g,'').replace(/번지$/,'');
const hash=v=>crypto.createHash('sha256').update(v).digest('hex');
function ledgerId(value){return typeof value==='string'&&/^\d{15,30}$/.test(value)?value:null;}
function sqlDay(v){return v instanceof Date?v.toISOString().slice(0,10):String(v||'').slice(0,10);}
function config(env=process.env){
 const reuseConfirmed=env.HUB_CONSTRUCTION_REUSE_CONFIRMED==='true',requested=env.HUB_CONSTRUCTION_ENABLED==='true';
 return {reuseConfirmed,requested,enabled:env.AUTO_INGEST_ENABLED!=='false'&&reuseConfirmed&&requested,
  status:env.AUTO_INGEST_ENABLED==='false'?'paused':!reuseConfirmed?'reuse_pending':!requested?'disabled':'enabled',
  scope:'저장된 건축HUB 인허가 현장 중 숫자형 원천 관리번호·주소·허가일이 대조되는 현장만 확인합니다. 전국 신규 현장 전체 수집이 아닙니다.',
  note:'HUB 공사현장 공개 웹 조회 연계입니다. 공개 기본개요 API와 별개이며, 유료 서비스 재제공 범위를 제공기관에 확인한 뒤 활성화합니다.',sourceUrl:PAGE,termsUrl:ORIGIN+'/portal/psg/idx-policy.do'};
}
function landline(value){
 const p=clean(value).replace(/[^+\d]/g,'');
 return /^(?:0[2-6]\d{7,9}|\+82[2-6]\d{7,9})$/.test(p)?p:null;
}
function parseDetail(payload,project){
 const ledger=ledgerId(project.external_id);if(!ledger)throw Error('HUB 관리번호 형식 미연결');
 if(!payload||!Array.isArray(payload.resultList)||payload.resultList.length>100)throw Error('HUB 관계자 응답 형식 확인 필요');
 if(!payload.resultList.length)return {outcome:'not_found',ledger,parties:[],withheld:0};
 const rows=payload.resultList,first=rows[0];
 const date=permitDate(first.archPmsDate),addr=clean(first.addr);
 if(!date||!addr||!project.permit_date||date!==sqlDay(project.permit_date))throw Error('HUB 허가일 대조 불일치');
 if(![first.addr,first.jibunAddr,first.roadAddr].some(a=>a&&addressKey(a)===addressKey(project.address)))throw Error('HUB 현장 주소 대조 불일치');
 for(const r of rows){
  if(r.pmsrgstSeqno!==ledger||clean(r.addr)!==addr||r.archPmsDate!==first.archPmsDate)throw Error('HUB 관리번호·현장 식별자 혼합 또는 불일치');
  for(const k of ['stcnsPrrngDate','edcnsPrrngDate','realStcnsDate'])if(r[k]!=null&&r[k]!==''&&r[k]!==first[k])throw Error('HUB 일정 필드 혼합');
 }
 const stage=['PERMIT','STARTED','COMPLETED'].includes(project.stage)?project.stage:'PERMIT';
 const parties=[],seen=new Set();let withheld=0;
 for(const r of rows){
  const role=ROLES[clean(r.partcpnt)],organization=clean(r.offcnm);
  // Do not turn a person's name or the site manager into a construction company.
  if(!role||!organization||organization==='-'||/^(?:비공개|미공개|없음|해당없음)$/.test(organization))continue;
  if(/[*＊]/.test(organization)){withheld++;continue;}
  if(role==='owner'&&!/주식회사|유한회사|㈜|법인|조합|공사|공단|재단|학교|대학교/.test(organization)){withheld++;continue;}
  if(organization.length>200)throw Error('HUB 업체명 길이 확인 필요');
  const phone=landline(r.telno);if(clean(r.telno)&&!phone)withheld++;
  const excerpt='HUB 공사현장 · 관리번호 '+ledger+' · '+clean(r.partcpnt)+': '+organization+(phone?' · 원문 업체 전화: '+phone:'')+' · 허가일 '+date;
  const e=normalizeEvidence({role,organization,phone,source_url:PAGE,stage,contact_scope:'company',excerpt});
  const key=hash(JSON.stringify(e));if(!seen.has(key)){seen.add(key);parties.push(e);}
 }
 const plannedStart=permitDate(first.stcnsPrrngDate),plannedEnd=permitDate(first.edcnsPrrngDate);
 return {outcome:'matched',ledger,parties,withheld,plannedStart,plannedEnd,actualStart:permitDate(first.realStcnsDate),permitDate:date};
}
function createPublicClient({fetcher=fetch}={}){
 let session=null;
 async function read(path,options={}){
  let r;try{r=await fetcher(ORIGIN+path,{...options,redirect:'error',signal:AbortSignal.timeout(25000)});}catch{throw Error('HUB 공사현장 연결 실패');}
  if(!r.ok)throw Error('HUB 공사현장 HTTP '+r.status);
  const reader=r.body?.getReader();let raw='';
  if(reader){const parts=[];let size=0;for(;;){const v=await reader.read();if(v.done)break;size+=v.value.length;if(size>2*1024*1024){await reader.cancel();throw Error('HUB 응답 2MB 한도 초과');}parts.push(Buffer.from(v.value));}raw=Buffer.concat(parts).toString('utf8');}
  else{raw=await r.text();if(Buffer.byteLength(raw)>2*1024*1024)throw Error('HUB 응답 2MB 한도 초과');}
  return {r,raw};
 }
 async function detail(id,reserve=async()=>{}){
  if(!ledgerId(id))throw Error('HUB 관리번호 형식 미연결');
  if(!session||session.expires<Date.now()){
   await reserve();const {r,raw}=await read('/portal/gis/css/idx-css-list.do');const $=cheerio.load(raw);
   const header=$('meta[name="_csrf_header"]').attr('content'),token=$('meta[name="_csrf"]').attr('content');
   if(!header||!/^X-CSRF-TOKEN$/i.test(header)||!token||!raw.includes('select-CssDetail.do'))throw Error('HUB 공개 조회 화면 형식 변경');
   const cookies=(r.headers.getSetCookie?.()||[]).map(c=>c.split(';')[0]).join('; ');
   session={header,token,cookies,expires:Date.now()+10*60000};
  }
  await reserve();const {raw}=await read(DETAIL,{method:'POST',headers:{Accept:'application/json','Content-Type':'application/json;charset=UTF-8',Referer:PAGE,[session.header]:session.token,...(session.cookies?{Cookie:session.cookies}:{})},body:JSON.stringify({relateLdgrSn:id,flag:'nwcc'})});
  let parsed;try{parsed=JSON.parse(raw);}catch{session=null;throw Error('HUB 관계자 JSON 응답 확인 필요');}return parsed;
 }
 return {detail};
}
async function saveDetail(transaction,token,project,record){
 return transaction(async q=>{
  const lease=await q("SELECT source FROM auto_ingest_state WHERE source='hub_construction' AND lease_token=$1 AND lease_until>NOW() FOR UPDATE",[token]);if(!lease.rows.length)throw Error('HUB 수집 실행권 만료');
  const current=(await q("SELECT * FROM projects WHERE id=$1 AND source='arch_hub_permit' FOR UPDATE",[project.id])).rows[0];
  if(!current||current.external_id!==project.external_id||addressKey(current.address)!==addressKey(project.address)||sqlDay(current.permit_date)!==sqlDay(project.permit_date)||current.stage!==project.stage)throw Error('수집 중 인허가 식별정보 변경');
  const ids=[];
  if(record.outcome==='matched'){
   for(const e of record.parties){
    let id=await insertEvidence(q,project.id,e,'hub_construction');
    if(!id)id=(await q('SELECT id FROM project_party_evidence WHERE fingerprint=$1',[hash(JSON.stringify([String(project.id),e]))])).rows[0]?.id;
    if(!id)throw Error('HUB 참여업체 근거 저장 확인 실패');ids.push(String(id));
   }
   await q("DELETE FROM project_contacts WHERE project_id=$1 AND source='hub_construction'",[project.id]);
   for(const e of record.parties.filter(e=>['designer','contractor','supervisor'].includes(e.role)))await q(`INSERT INTO project_contacts(project_id,role,organization,phone,source,source_url)
    VALUES($1,$2,$3,$4,'hub_construction',$5) ON CONFLICT(project_id,role,organization,source) DO UPDATE SET phone=EXCLUDED.phone,source_url=EXCLUDED.source_url,updated_at=NOW()`,[project.id,e.role,e.organization,e.phone,PAGE]);
  }
  // A missing web record is not proof that a previously observed party withdrew.
  await q(`INSERT INTO hub_construction_checks(project_id,ledger_id,outcome,last_attempt_at,last_success_at,next_due_at,current_evidence_ids,planned_start,planned_completion,reported_actual_start,withheld_count)
   VALUES($1,$2,$3,NOW(),NOW(),NOW()+INTERVAL '7 days',$4::bigint[],$5,$6,$7,$8)
   ON CONFLICT(project_id) DO UPDATE SET ledger_id=$2,outcome=$3,last_attempt_at=NOW(),last_success_at=NOW(),last_error=NULL,next_due_at=NOW()+INTERVAL '7 days',
    current_evidence_ids=CASE WHEN $3='matched' THEN $4::bigint[] ELSE hub_construction_checks.current_evidence_ids END,
    planned_start=CASE WHEN $3='matched' THEN $5::date ELSE hub_construction_checks.planned_start END,
    planned_completion=CASE WHEN $3='matched' THEN $6::date ELSE hub_construction_checks.planned_completion END,
    reported_actual_start=CASE WHEN $3='matched' THEN $7::date ELSE hub_construction_checks.reported_actual_start END,withheld_count=$8`,
   [project.id,record.ledger,record.outcome,ids,record.plannedStart||null,record.plannedEnd||null,record.actualStart||null,record.withheld]);
 });
}
function createHubCollector({query,transaction,env=process.env,client=createPublicClient()}){
 let active=false,timer;
 async function run(){
  if(active||!config(env).enabled)return;active=true;const token=crypto.randomUUID();let claimed=false;
  try{
   const lease=await query("UPDATE auto_ingest_state SET lease_token=$1,lease_until=NOW()+INTERVAL '10 minutes',last_attempt_at=NOW() WHERE source='hub_construction' AND next_due_at<=NOW() AND (lease_until IS NULL OR lease_until<NOW()) RETURNING source",[token]);if(!lease.rows.length)return;claimed=true;
   const project=(await query(`WITH regions AS (
    SELECT p.region,MAX(c.last_attempt_at) AS attempted FROM projects p LEFT JOIN hub_construction_checks c ON c.project_id=p.id
    WHERE p.source='arch_hub_permit' AND p.external_id~'^[0-9]{15,30}$' GROUP BY p.region
   ) SELECT p.* FROM projects p LEFT JOIN hub_construction_checks c ON c.project_id=p.id JOIN regions r ON r.region IS NOT DISTINCT FROM p.region
    WHERE p.source='arch_hub_permit' AND p.external_id~'^[0-9]{15,30}$' AND p.permit_date IS NOT NULL AND p.address IS NOT NULL AND p.stage IN ('PERMIT','STARTED','COMPLETED')
    AND (c.next_due_at IS NULL OR c.next_due_at<=NOW())
    ORDER BY r.attempted NULLS FIRST,c.last_attempt_at NULLS FIRST,p.area_sqm DESC NULLS LAST,p.id LIMIT 1`)).rows[0];
   if(!project){await query("UPDATE auto_ingest_state SET lease_token=NULL,lease_until=NULL,next_due_at=NOW()+INTERVAL '1 hour' WHERE source='hub_construction' AND lease_token=$1",[token]);return;}
   const reserve=async()=>{const raw=Number(env.HUB_CONSTRUCTION_DAILY_REQUESTS),budget=Number.isSafeInteger(raw)&&raw>0?Math.min(raw,1000):100;const r=await query(`UPDATE auto_ingest_state SET daily_calls=CASE WHEN call_day=(NOW() AT TIME ZONE 'Asia/Seoul')::date THEN daily_calls+1 ELSE 1 END,call_day=(NOW() AT TIME ZONE 'Asia/Seoul')::date,lease_until=NOW()+INTERVAL '10 minutes'
    WHERE source='hub_construction' AND lease_token=$1 AND lease_until>NOW() AND (call_day IS DISTINCT FROM (NOW() AT TIME ZONE 'Asia/Seoul')::date OR daily_calls<$2) RETURNING source`,[token,budget]);if(!r.rows.length)throw Error('HUB 일일 호출 한도 또는 실행권 만료');};
   try{const payload=await client.detail(project.external_id,reserve);await saveDetail(transaction,token,project,parseDetail(payload,project));}
   catch(e){await query(`INSERT INTO hub_construction_checks(project_id,ledger_id,outcome,last_attempt_at,last_error,next_due_at)
    SELECT $1,$2,'error',NOW(),$3,NOW()+INTERVAL '24 hours' WHERE EXISTS(SELECT 1 FROM auto_ingest_state WHERE source='hub_construction' AND lease_token=$4 AND lease_until>NOW())
    ON CONFLICT(project_id) DO UPDATE SET outcome='error',last_attempt_at=NOW(),last_error=$3,next_due_at=NOW()+INTERVAL '24 hours'`,[project.id,project.external_id,String(e.message).slice(0,250),token]);throw e;}
   await query("UPDATE auto_ingest_state SET last_success_at=NOW(),last_error=NULL,lease_token=NULL,lease_until=NULL,next_due_at=NOW()+INTERVAL '1 minute' WHERE source='hub_construction' AND lease_token=$1",[token]);
  }catch(e){if(claimed)await query("UPDATE auto_ingest_state SET last_error=$2,lease_token=NULL,lease_until=NULL,next_due_at=NOW()+INTERVAL '30 minutes' WHERE source='hub_construction' AND lease_token=$1",[token,String(e.message).slice(0,250)]);}
  finally{active=false;}
 }
 return {run,start(){if(timer)return;timer=setInterval(()=>void run().catch(()=>{}),60000);timer.unref?.();void run().catch(()=>{});},stop(){clearInterval(timer);timer=null;}};
}
module.exports={PAGE,DETAIL,config,ledgerId,landline,parseDetail,createPublicClient,saveDetail,createHubCollector};

async function status(query,env=process.env){
 const counts=(await query(`SELECT COUNT(*)::int AS stored_permits,
 COUNT(*) FILTER(WHERE p.external_id~'^[0-9]{15,30}$' AND p.permit_date IS NOT NULL AND p.address IS NOT NULL AND p.stage IN ('PERMIT','STARTED','COMPLETED'))::int AS eligible,
 COUNT(*) FILTER(WHERE c.last_success_at IS NOT NULL)::int AS checked,
 COUNT(*) FILTER(WHERE c.outcome='matched')::int AS matched,
 COUNT(*) FILTER(WHERE c.outcome='not_found')::int AS not_found,
 COUNT(*) FILTER(WHERE c.last_error IS NOT NULL)::int AS failed,
 COALESCE(SUM(CARDINALITY(c.current_evidence_ids)),0)::int AS current_party_records
 FROM projects p LEFT JOIN hub_construction_checks c ON c.project_id=p.id WHERE p.source='arch_hub_permit'`)).rows[0]||{};
 const state=(await query("SELECT last_attempt_at,last_success_at,last_error,next_due_at,daily_calls FROM auto_ingest_state WHERE source='hub_construction'")).rows[0]||{};
 return {...config(env),counts,state};
}
module.exports.status=status;
