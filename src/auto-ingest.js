const crypto=require('node:crypto');
const DAY=86400000;
function limit(value,fallback,max){const n=Number(value);return Number.isInteger(n)&&n>0?Math.min(n,max):fallback;}
function permitPageState(job){
 if(job.status!=='completed')throw Error(job.error||'국토부 수집 실패');
 return {nextPage:job.hasMore?job.nextPage:1,complete:!job.hasMore};
}
function bidWindow(cursor,now=new Date()){
 const parsed=Date.parse(cursor||'');
 const start=Number.isFinite(parsed)?Math.min(parsed,now.getTime())-2*3600000:now.getTime()-7*DAY;
 return {start:new Date(start),end:new Date(Math.min(now.getTime(),start+7*DAY))};
}
function createAutoIngest({query,permit,bids,busy,env=process.env}){
 let timer,active=false,seededAt=0;
 const enabled=()=>env.AUTO_INGEST_ENABLED!=='false';
 async function seed(){
  await query(`UPDATE auto_permit_regions r SET enabled=FALSE WHERE EXISTS(
   SELECT 1 FROM permit_legal_dong_codes c WHERE c.code=r.sigungu_cd||r.bjdong_cd
   AND c.catalog_origin='official_bundle' AND c.active=FALSE)`);
  await query(`INSERT INTO auto_permit_regions(sigungu_cd,bjdong_cd,label)
   SELECT sigungu_cd,bjdong_cd,label FROM permit_region_presets
   UNION SELECT LEFT(code,5),RIGHT(code,5),name FROM permit_legal_dong_codes
    WHERE active=TRUE AND RIGHT(code,5)<>'00000'
   ON CONFLICT(sigungu_cd,bjdong_cd) DO NOTHING`);

 }
 async function leased(source,work){
  const token=crypto.randomUUID();
  const claim=await query(`UPDATE auto_ingest_state SET lease_token=$2,lease_until=NOW()+INTERVAL '15 minutes',last_attempt_at=NOW()
   WHERE source=$1 AND next_due_at<=NOW() AND (lease_until IS NULL OR lease_until<NOW()) RETURNING *`,[source,token]);
  if(!claim.rows.length)return;
  let lost=false,heartbeatRunning=false;
  const beat=setInterval(async()=>{
   if(heartbeatRunning)return;heartbeatRunning=true;
   try{const r=await query("UPDATE auto_ingest_state SET lease_until=NOW()+INTERVAL '15 minutes' WHERE source=$1 AND lease_token=$2 AND lease_until>NOW() RETURNING source",[source,token]);if(!r.rows.length)lost=true;}catch{lost=true;}finally{heartbeatRunning=false;}
  },30000);beat.unref?.();
  const assertOwner=()=>{if(lost)throw Error('자동 수집 실행권이 만료되었습니다. 다음 실행에서 재개합니다.');};
  const reserve=async()=>{
   assertOwner();
   const budget=source==='permits'?limit(env.AUTO_PERMIT_DAILY_REQUESTS,500,10000):limit(env.AUTO_G2B_DAILY_REQUESTS,1000,10000);
   const r=await query(`UPDATE auto_ingest_state SET daily_calls=CASE WHEN call_day=(NOW() AT TIME ZONE 'Asia/Seoul')::date THEN daily_calls+1 ELSE 1 END,
    call_day=(NOW() AT TIME ZONE 'Asia/Seoul')::date
    WHERE source=$1 AND lease_token=$2 AND lease_until>NOW()
    AND (call_day IS DISTINCT FROM (NOW() AT TIME ZONE 'Asia/Seoul')::date OR daily_calls<$3) RETURNING source`,[source,token,budget]);
   if(!r.rows.length)throw Error('자동 수집 일일 호출 한도 또는 실행권 만료: 다음 실행에서 재시도합니다.');
  };
  const checkpoint=async cursor=>{
   assertOwner();const r=await query(`UPDATE auto_ingest_state SET cursor_at=CASE WHEN cursor_at IS NULL OR cursor_at<$3::timestamptz THEN $3::timestamptz ELSE cursor_at END
    WHERE source=$1 AND lease_token=$2 AND lease_until>NOW() RETURNING source`,[source,token,cursor]);
   if(!r.rows.length)throw Error('자동 수집 실행권이 만료되었습니다.');
  };
  try{
   const outcome=await work({state:claim.rows[0],reserve,checkpoint,assertOwner,token});
   const delay=typeof outcome==='number'?outcome:outcome.delay,processed=typeof outcome==='number'?true:outcome.processed;
   await query(`UPDATE auto_ingest_state SET last_success_at=CASE WHEN $4 THEN NOW() ELSE last_success_at END,last_error=NULL,lease_token=NULL,lease_until=NULL,next_due_at=NOW()+($3::int*INTERVAL '1 second') WHERE source=$1 AND lease_token=$2`,[source,token,delay,processed]);
  }catch(e){
   await query(`UPDATE auto_ingest_state SET last_error=$3,lease_token=NULL,lease_until=NULL,next_due_at=NOW()+INTERVAL '30 minutes' WHERE source=$1 AND lease_token=$2`,[source,token,String(e.message).slice(0,300)]);
  }finally{clearInterval(beat);}
 }
 async function tick(){
  if(active||!enabled())return;active=true;
  try{
   if(Date.now()-seededAt>3600000){await seed();seededAt=Date.now();}
   if(env.G2B_SERVICE_KEY&&!busy('bids'))await leased('bids',async({state,reserve,checkpoint})=>{
    const range=bidWindow(state.cursor_at);
    await bids({beginningAt:range.start.toISOString(),endedAt:range.end.toISOString(),beforePage:reserve,onWindowSuccess:checkpoint,automatic:true});
    return range.end.getTime()<Date.now()-3600000?60:86400;
   });
   if(env.ARCH_HUB_SERVICE_KEY&&!busy('permits'))await leased('permits',async({reserve,token,assertOwner})=>{
    const pages=limit(env.AUTO_PERMIT_PAGES_PER_TICK,5,20);let handled=0;
    for(let i=0;i<pages;i++){
     const result=await query(`SELECT * FROM auto_permit_regions WHERE enabled=TRUE AND next_due_at<=NOW()
      ORDER BY next_due_at,last_attempt_at NULLS FIRST,sigungu_cd,bjdong_cd LIMIT 1`);
     const region=result.rows[0];if(!region)break;
     const job=await permit({sigunguCd:region.sigungu_cd,bjdongCd:region.bjdong_cd,startPage:region.next_page,pageBudget:1,beforePage:reserve,automatic:true});
     assertOwner();
     if(job.status!=='completed'){
      await query(`UPDATE auto_permit_regions SET last_error=$3,failures=failures+1,last_attempt_at=NOW(),next_due_at=NOW()+(LEAST(360,30*(failures+1))*INTERVAL '1 minute')
       WHERE sigungu_cd=$1 AND bjdong_cd=$2 AND EXISTS(SELECT 1 FROM auto_ingest_state WHERE source='permits' AND lease_token=$4 AND lease_until>NOW())`,[region.sigungu_cd,region.bjdong_cd,String(job.error||'수집 실패').slice(0,300),token]);
      throw Error(job.error||'국토부 수집 실패');
     }
     const next=permitPageState(job);
     const saved=await query(`UPDATE auto_permit_regions SET next_page=$3,last_attempt_at=NOW(),last_success_at=NOW(),last_cycle_at=CASE WHEN $4 THEN NOW() ELSE last_cycle_at END,
      next_due_at=CASE WHEN $4 THEN NOW()+INTERVAL '24 hours' ELSE NOW() END,last_error=NULL,failures=0
      WHERE sigungu_cd=$1 AND bjdong_cd=$2 AND EXISTS(SELECT 1 FROM auto_ingest_state WHERE source='permits' AND lease_token=$5 AND lease_until>NOW()) RETURNING sigungu_cd`,[region.sigungu_cd,region.bjdong_cd,next.nextPage,next.complete,token]);
     if(!saved.rows.length)throw Error('국토부 자동 수집 진행 저장 실패');
     handled++;
    }
    return {delay:60,processed:handled>0};
   });
  }catch(e){console.error('Automatic ingestion:',e.message);}finally{active=false;}
 }
 return {tick,enabled,start(){if(timer)return;timer=setInterval(()=>void tick(),60000);timer.unref?.();void tick();},stop(){clearInterval(timer);timer=null;}};
}
module.exports={createAutoIngest,bidWindow,permitPageState};
