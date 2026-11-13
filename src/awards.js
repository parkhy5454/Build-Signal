// Official operation and fields: https://www.data.go.kr/data/15129397/openapi.do
const crypto=require('node:crypto');
const ENDPOINT='https://apis.data.go.kr/1230000/as/ScsbidInfoService/getScsbidListSttusCnstwk';
const SOURCE_URL='https://www.data.go.kr/data/15129397/openapi.do';
const DAY=86400000, clean=v=>String(v??'').trim();
function awardKey(env=process.env){return env.G2B_AWARD_SERVICE_KEY||env.G2B_SERVICE_KEY||'';}
function dateOnly(value){const s=clean(value).replace(/[-./\s:]/g,'');if(!/^\d{8}(\d{4}(\d{2})?)?$/.test(s))return null;const iso=s.slice(0,4)+'-'+s.slice(4,6)+'-'+s.slice(6,8),d=new Date(iso+'T00:00:00Z');return Number.isFinite(+d)&&d.toISOString().slice(0,10)===iso?iso:null;}
function normalizeAward(row){
 if(!row||typeof row!=='object'||Array.isArray(row))throw Error('낙찰 항목 형식 확인 필요');
 const notice=clean(row.bidNtceNo),ord=clean(row.bidNtceOrd),classification=clean(row.bidClsfcNo),rebid=clean(row.rbidNo);
 const name=clean(row.bidNtceNm),winner=clean(row.bidwinnrNm);
 if(!/^[A-Za-z0-9-]{5,50}$/.test(notice)||!/^\d{1,5}$/.test(ord)||!/^\d{0,10}$/.test(classification)||!/^\d{0,10}$/.test(rebid)||!name||name.length>1000||!winner||winner.length>500)throw Error('최종낙찰 공고 식별자·업체명 누락 또는 형식 변경');
 const amountRaw=clean(row.sucsfbidAmt).replaceAll(',',''),amount=amountRaw===''?null:/^\d+(\.\d{1,2})?$/.test(amountRaw)?amountRaw:null;
 if(amountRaw&&(!amount||!Number.isFinite(Number(amount))||Number(amount)>1e16))throw Error('낙찰금액 형식 확인 필요');
 const day=dateOnly(row.fnlSucsfDate);if(clean(row.fnlSucsfDate)&&!day)throw Error('최종낙찰일 형식 확인 필요');
 const text=(v,max)=>clean(v).slice(0,max)||null;
 return {key:crypto.createHash('sha256').update(JSON.stringify([notice,ord,classification,rebid])).digest('hex'),notice,ord,classification,rebid,name,winner,amount,day,
  bizno:text(row.bidwinnrBizno,20),phone:text(row.bidwinnrTelNo,80),person:text(row.fnlSucsfCorpOfcl,100),companyAddress:text(row.bidwinnrAdrs,500),owner:text(row.dminsttNm,500)};
}
function parseAwardPage(payload,page,size=100){
 const root=payload?.response,header=root?.header,body=root?.body;
 if(!header||!['00','0'].includes(String(header.resultCode)))throw Error('나라장터 낙찰 API 오류 ('+String(header?.resultCode??'응답 형식 확인 필요').slice(0,30)+') · 활용승인·호출한도를 확인하세요.');
 const total=Number(body?.totalCount),returnedPage=Number(body?.pageNo);
 if(body?.totalCount==null||!Number.isInteger(total)||total<0||total>50000||returnedPage!==page)throw Error('낙찰 응답 건수·페이지 또는 50,000건 범위 한도 확인 필요');
 const raw=body.items?.item??body.items;let items;
 if(Array.isArray(raw))items=raw;else if(raw&&typeof raw==='object'&&Object.keys(raw).length)items=[raw];else if(total===0||raw===''||raw==null)items=[];else throw Error('낙찰 응답 항목 구조 확인 필요');
 const expected=Math.max(0,Math.min(size,total-(page-1)*size));if(items.length!==expected)throw Error('낙찰 응답 페이지 누락·잘림 확인 필요');
 const rows=items.map(normalizeAward);if(new Set(rows.map(r=>r.key)).size!==rows.length)throw Error('낙찰 페이지 공고 식별자 중복');
 return {rows,total};
}
function formatKst(d){return new Date(+d+9*3600000).toISOString().slice(0,16).replace(/[-T:]/g,'');}
function awardWindow(cursor,now=new Date()){
 const endNow=Math.floor(+now/60000)*60000,parsed=Date.parse(cursor||'');
 const from=Math.floor((Number.isFinite(parsed)?Math.min(parsed,endNow)-2*3600000:endNow-7*DAY)/60000)*60000;
 return {from:new Date(from).toISOString(),to:new Date(Math.min(endNow,from+DAY-60000)).toISOString()};
}
async function fetchAwardPage({from,to,page,key},fetcher=fetch){
 const params=new URLSearchParams({serviceKey:key,pageNo:String(page),numOfRows:'100',inqryDiv:'1',inqryBgnDt:formatKst(new Date(from)),inqryEndDt:formatKst(new Date(to)),type:'json'});
 let response;try{response=await fetcher(ENDPOINT+'?'+params,{redirect:'error',signal:AbortSignal.timeout(30000),headers:{Accept:'application/json'}});}catch{throw Error('나라장터 낙찰 API 연결 실패');}
 if(!response.ok)throw Error('나라장터 낙찰 HTTP '+response.status+' · 활용승인·호출한도를 확인하세요.');
 let data;try{const raw=await response.text();if(raw.length>4*1024*1024)throw Error();data=JSON.parse(raw);}catch{throw Error('나라장터 낙찰 JSON 응답 확인 필요');}
 return parseAwardPage(data,page);
}
async function saveAwardPage(transaction,token,scan,result){
 return transaction(async q=>{
  const lease=await q("SELECT source FROM auto_ingest_state WHERE source='awards' AND lease_token=$1 AND lease_until>NOW() FOR UPDATE",[token]);if(!lease.rows.length)throw Error('낙찰 수집 실행권 만료');
  const known=new Set(scan.seen_keys||[]);for(const r of result.rows){if(known.has(r.key))throw Error('낙찰 페이지 간 공고 식별자 중복');known.add(r.key);}
  if(scan.total_count!==null&&scan.total_count!==undefined&&Number(scan.total_count)!==result.total)throw Error('낙찰 조회 중 전체 건수 변경 · 다시 조회합니다.');
  for(const r of result.rows)await q(`INSERT INTO construction_awards(event_key,notice_no,notice_ord,classification_no,rebid_no,name,winner,business_no,company_phone,company_person,company_address,owner,award_amount,award_date,source_url)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
   ON CONFLICT(event_key) DO UPDATE SET name=EXCLUDED.name,winner=EXCLUDED.winner,business_no=EXCLUDED.business_no,company_phone=EXCLUDED.company_phone,company_person=EXCLUDED.company_person,company_address=EXCLUDED.company_address,owner=EXCLUDED.owner,award_amount=EXCLUDED.award_amount,award_date=EXCLUDED.award_date,last_seen_at=NOW()`,
   [r.key,r.notice,r.ord,r.classification,r.rebid,r.name,r.winner,r.bizno,r.phone,r.person,r.companyAddress,r.owner,r.amount,r.day,SOURCE_URL]);
  const complete=scan.next_page*100>=result.total;
  if(complete){await q("UPDATE auto_ingest_state SET cursor_at=$2 WHERE source='awards' AND lease_token=$1",[token,scan.window_to]);await q('DELETE FROM award_scan WHERE id=1');}
  else await q('UPDATE award_scan SET next_page=next_page+1,total_count=$1,seen_keys=$2::jsonb WHERE id=1',[result.total,JSON.stringify([...known])]);
  return complete;
 });
}
function createAwardCollector({query,transaction,env=process.env,fetchPage=fetchAwardPage}){
 let active=false,timer;
 async function run(){
  if(active||env.AUTO_INGEST_ENABLED==='false'||!awardKey(env))return;active=true;const token=crypto.randomUUID();let claimed=false;
  try{
   const claim=await query("UPDATE auto_ingest_state SET lease_token=$1,lease_until=NOW()+INTERVAL '10 minutes',last_attempt_at=NOW() WHERE source='awards' AND next_due_at<=NOW() AND (lease_until IS NULL OR lease_until<NOW()) RETURNING *",[token]);if(!claim.rows.length)return;claimed=true;
   let scan=(await query('SELECT * FROM award_scan WHERE id=1')).rows[0];
   if(!scan){const w=awardWindow(claim.rows[0].cursor_at);scan=(await query('INSERT INTO award_scan(id,window_from,window_to) VALUES(1,$1,$2) RETURNING *',[w.from,w.to])).rows[0];}
   const budget=Number(env.AUTO_G2B_AWARD_DAILY_REQUESTS)||200;let complete=false;
   for(let i=0;i<5;i++){
    const reserved=await query(`UPDATE auto_ingest_state SET lease_until=NOW()+INTERVAL '10 minutes',daily_calls=CASE WHEN call_day=(NOW() AT TIME ZONE 'Asia/Seoul')::date THEN daily_calls+1 ELSE 1 END,call_day=(NOW() AT TIME ZONE 'Asia/Seoul')::date
     WHERE source='awards' AND lease_token=$1 AND lease_until>NOW() AND (call_day IS DISTINCT FROM (NOW() AT TIME ZONE 'Asia/Seoul')::date OR daily_calls<$2) RETURNING source`,[token,Math.max(1,Math.min(1000,budget))]);if(!reserved.rows.length)throw Error('낙찰 일일 호출 한도 또는 수집 실행권 만료');
    const result=await fetchPage({from:scan.window_from,to:scan.window_to,page:scan.next_page,key:awardKey(env)});
    complete=await saveAwardPage(transaction,token,scan,result);if(complete)break;
    scan={...scan,next_page:scan.next_page+1,total_count:result.total,seen_keys:[...(scan.seen_keys||[]),...result.rows.map(r=>r.key)]};
   }
   const caughtUp=complete&&Date.parse(scan.window_to)>Date.now()-2*3600000;
   await query("UPDATE auto_ingest_state SET last_success_at=NOW(),last_error=NULL,lease_token=NULL,lease_until=NULL,next_due_at=NOW()+($2::int*INTERVAL '1 second') WHERE source='awards' AND lease_token=$1",[token,caughtUp?21600:60]);
  }catch(e){if(claimed){
   // Rescan a stable bounded window after an upstream paging inconsistency; never advance its cursor.
   if(/중복|건수 변경|누락·잘림/.test(e.message))await query("UPDATE award_scan SET next_page=1,total_count=NULL,seen_keys='[]'::jsonb WHERE id=1 AND EXISTS(SELECT 1 FROM auto_ingest_state WHERE source='awards' AND lease_token=$1 AND lease_until>NOW())",[token]);
   await query("UPDATE auto_ingest_state SET last_error=$2,lease_token=NULL,lease_until=NULL,next_due_at=NOW()+INTERVAL '30 minutes' WHERE source='awards' AND lease_token=$1",[token,String(e.message).slice(0,250)]);
  }}finally{active=false;}
 }
 return {run,start(){if(timer)return;timer=setInterval(()=>void run().catch(()=>{}),60000);timer.unref?.();void run().catch(()=>{});},stop(){clearInterval(timer);timer=null;}};
}
module.exports={ENDPOINT,SOURCE_URL,awardKey,normalizeAward,parseAwardPage,awardWindow,fetchAwardPage,saveAwardPage,createAwardCollector};
