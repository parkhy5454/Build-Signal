const {provinces,meta}=require('./region-catalog');
const {SOURCES,coverageSummary}=require('./organization-directory');
const REGION_STATS_SQL=`SELECT LEFT(sigungu_cd,2) AS province,
 COUNT(*)::int AS targets,COUNT(last_attempt_at)::int AS attempted,
 COUNT(last_cycle_at)::int AS completed,
 COUNT(*) FILTER (WHERE last_cycle_at>=NOW()-INTERVAL '24 hours')::int AS fresh,
 COUNT(*) FILTER (WHERE last_error IS NOT NULL)::int AS failed,
 MAX(last_attempt_at) AS last_attempt_at,MIN(last_cycle_at) AS oldest_cycle
 FROM auto_permit_regions WHERE enabled=TRUE GROUP BY LEFT(sigungu_cd,2)`;
function dailyBudget(env){const n=Number(env.AUTO_PERMIT_DAILY_REQUESTS);return Number.isInteger(n)&&n>0?Math.min(n,10000):500;}
function nationalCoverage({regions=provinces,stats=[],directories=[],environment=null,configured=false,enabled=true,env={}}={}){
 const sources=coverageSummary(directories),active=regions.filter(p=>p.code);
 const rows=active.map(p=>{
  const s=stats.find(x=>String(x.province)===p.code)||{};
  const targets=Number(s.targets||0),attempted=Number(s.attempted||0),completed=Number(s.completed||0),fresh=Number(s.fresh||0),failed=Number(s.failed||0);
  const labels=new Set([p.value,p.label,...p.aliases]);
  const developerSources=sources.filter(x=>x.source!=='architects'&&(labels.has(x.region)||p.aliases.some(a=>a===SOURCES[x.source]?.region)));
  const review=p.aliases.includes('울산광역시')?'울산 남구 공개 본문 일부':p.aliases.includes('전북특별자치도')?'군산 공개 PDF 1건':null;
  return {code:p.code,name:p.value,label:p.label,permits:{targets,attempted,completed,fresh,failed,lastAttemptAt:s.last_attempt_at||null,oldestCycle:s.oldest_cycle||null,
   status:!configured?'key_missing':!targets?'queue_pending':!attempted?'pending':completed<targets?'initial_loading':fresh<targets?'refresh_pending':'cycle_current'},
   developers:{status:!developerSources.length?'unconnected':developerSources.every(x=>x.status==='synced')?'synced':developerSources.some(x=>x.status!=='pending')?'retained':'pending',sources:developerSources},
   review:{status:review?'partial':'unconnected',scope:review}};
 });
 const queueKnown=rows.length>0&&rows.every(r=>r.permits.targets>0);
 const remaining=rows.reduce((n,r)=>n+r.permits.targets-r.permits.completed,0),budget=dailyBudget(env);
 return {enabled,configured,environmentalReview:{status:environment?.last_success_at?(environment.last_error?'partial':'checked'):'pending',lastCheckedAt:environment?.last_success_at||null,total:Number(environment?.total||0),unlocated:Number(environment?.unlocated||0),sourceUrl:'https://eiass.go.kr/partcptn/result/resultEiassList.do',scope:'전국 공개목록 기본 조회에 노출된 환경·전략환경평가 공람사업. 건축위원회 심의 전체를 대체하지 않습니다.'},catalogDate:meta.retrievedOn,rows,dailyRequestBudget:budget,
  initialScanMinimumDays:configured&&queueKnown?Math.ceil(remaining/budget):null,
  limitations:['순회 완료는 해당 법정동의 마지막 전체 페이지 조회 완료입니다. 모든 실제 현장 확보를 보장하지 않습니다.','최초 순회 최소 일수는 미완료 법정동당 1회 호출을 가정한 하한입니다. 여러 페이지·실패·기존 지역 갱신 호출은 추가됩니다.','개발업체·심의 출처가 미연결인 지역을 현장이나 업체가 없는 지역으로 판단하지 않습니다.'],
  nationalDeveloperSource:{url:'https://www.data.go.kr/data/15123996/openapi.do',status:'connection_unverified',note:'전국 단위 원천은 확인했으나 실제 응답·필드 검증 및 수집 연결이 끝나지 않았습니다.'}};
}
module.exports={REGION_STATS_SQL,nationalCoverage,dailyBudget};
