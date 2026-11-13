// Presence counts for the existing official basic-overview mapping. No raw values or credentials.
const {permitDate}=require('./archhub');
const FIELDS=[
 ['mgmPmsrgstPk','인허가 관리번호','identity'],['bldNm','건물명','text'],['platPlc','현장 주소','text'],
 ['mainPurpsCdNm','주용도','text'],['totArea','연면적','positive'],['archPmsDay','허가일','date'],
 ['realStcnsDay','실제 착공일','date'],['useAprDay','사용승인일','date'],['crtnDay','원천 생성일','date']
];
function summarize(items){
 const counts=Object.fromEntries(FIELDS.map(([key])=>[key,{present:0,usable:0}])),unmapped=Object.create(null);let validIdentity=0;
 for(const item of items){
  if(!item||typeof item!=='object'||Array.isArray(item))continue;
  for(const key of Object.keys(item)){if(!Object.hasOwn(counts,key)&&/^[a-z][a-z0-9_]{0,79}$/i.test(key)&&!/(servicekey|token|secret|password|authorization)/i.test(key)&&(Object.hasOwn(unmapped,key)||Object.keys(unmapped).length<200))unmapped[key]=(unmapped[key]||0)+1;}
  if(String(item.mgmPmsrgstPk??'').trim()&&String(item.platPlc??'').trim())validIdentity++;
  for(const [key,,type] of FIELDS){const v=item[key];if(v===undefined||v===null||String(v).trim()==='')continue;counts[key].present++;
   if(type==='date'?!!permitDate(v):type==='positive'?Number.isFinite(Number(v))&&Number(v)>0:['string','number'].includes(typeof v)&&String(v).trim()!=='')counts[key].usable++;
  }
 }
 return {sampleSize:items.length,validIdentity,fields:counts,unmapped};
}
async function recordAudit(query,items,total){
 const snapshot=summarize(items),safeTotal=total!==null&&total!==undefined&&Number.isSafeInteger(Number(total))&&Number(total)>=0?Number(total):null;
 await query(`INSERT INTO archhub_api_audit(operation,last_response_at,last_nonempty_at,last_received_count,last_total_count,sample_size,valid_identity,field_counts,unmapped_field_counts,responses_seen)
  VALUES('getApBasisOulnInfo',NOW(),CASE WHEN $1>0 THEN NOW() ELSE NULL END,$1,$2,$1,$3,$4::jsonb,$5::jsonb,1)
  ON CONFLICT(operation) DO UPDATE SET last_response_at=NOW(),last_received_count=$1,last_total_count=$2,responses_seen=archhub_api_audit.responses_seen+1,
  last_nonempty_at=CASE WHEN $1>0 THEN NOW() ELSE archhub_api_audit.last_nonempty_at END,
  sample_size=CASE WHEN $1>0 THEN $1 ELSE archhub_api_audit.sample_size END,
  valid_identity=CASE WHEN $1>0 THEN $3 ELSE archhub_api_audit.valid_identity END,
  field_counts=CASE WHEN $1>0 THEN $4::jsonb ELSE archhub_api_audit.field_counts END,
  unmapped_field_counts=CASE WHEN $1>0 THEN $5::jsonb ELSE archhub_api_audit.unmapped_field_counts END`,[snapshot.sampleSize,safeTotal,snapshot.validIdentity,JSON.stringify(snapshot.fields),JSON.stringify(snapshot.unmapped)]);
}
function auditView(row){
 return {operation:'getApBasisOulnInfo',status:!row?'not_observed':row.last_nonempty_at?'sample_observed':'empty_only',
  lastResponseAt:row?.last_response_at||null,lastNonemptyAt:row?.last_nonempty_at||null,lastReceivedCount:row?.last_received_count??null,
  lastRegionTotal:row?.last_total_count??null,sampleSize:row?.sample_size||0,validIdentity:row?.valid_identity||0,responsesSeen:row?.responses_seen||0,
  fields:FIELDS.map(([key,label])=>({key,label,present:Number(row?.field_counts?.[key]?.present||0),usable:Number(row?.field_counts?.[key]?.usable||0)})),
  unmappedFields:Object.entries(row?.unmapped_field_counts||{}).map(([key,count])=>({key,present:Number(count)})),
  parties:{status:'not_mapped',note:'이 기본개요 수집기는 건축주·시행사·설계사·시공사·감리사·연락처를 매핑하지 않습니다. 세움터 내부 보유정보와 공개 API 제공범위는 구분해야 합니다.'},
  note:'기존 건축HUB 기본개요의 마지막 비어 있지 않은 정상 수집 페이지 표본입니다. 전국 전체·고유 프로젝트 수 또는 원천 갱신 완료를 뜻하지 않습니다. 원문 값이나 인증키는 저장하지 않습니다. 공식 제공목록은 월간 갱신으로 안내하므로 서버의 매일 조회와 원천 갱신주기를 구분합니다.'};
}
module.exports={FIELDS,summarize,recordAudit,auditView};
