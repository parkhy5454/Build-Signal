const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {normalizeAward,parseAwardPage,awardWindow,fetchAwardPage,saveAwardPage,createAwardCollector,SOURCE_URL}=require('../src/awards');
const {registerAwardRoutes}=require('../src/award-routes');
const sample=(i=1)=>({bidNtceNo:'T'+String(i).padStart(8,'0'),bidNtceOrd:'000',bidClsfcNo:'1',rbidNo:'0',bidNtceNm:'검증 공사 '+i,bidwinnrNm:'검증 건설사',sucsfbidAmt:'1,200,000,000',fnlSucsfDate:'2026-11-12',bidwinnrAdrs:'부산광역시 업체 사업장 주소',bidwinnrTelNo:'02-1234-5678',dminsttNm:'검증 수요기관'});
const payload=(items,total=items.length,page=1)=>({response:{header:{resultCode:'00'},body:{items,totalCount:total,pageNo:page}}});
test('final-award schema preserves notice order/classification/rebid identity and never promotes bid rank or opening date',()=>{
 const r=normalizeAward(sample());assert.equal(r.amount,'1200000000');assert.equal(r.day,'2026-11-12');
 assert.notEqual(r.key,normalizeAward({...sample(),rbidNo:'1'}).key);
 assert.notEqual(r.key,normalizeAward({...sample(),bidClsfcNo:'2'}).key);
 assert.throws(()=>normalizeAward({bidNtceNo:'T12345678',bidNtceOrd:'000',bidNtceNm:'개찰',opengCorpInfo:'1순위 업체'}));
 assert.equal(normalizeAward({...sample(),fnlSucsfDate:'',rlOpengDt:'2026-11-10'}).day,null);
 for(const item of [{...sample(),fnlSucsfDate:'2026-02-30'},{...sample(),sucsfbidAmt:'-1'},{...sample(),bidNtceOrd:''}])assert.throws(()=>normalizeAward(item));
});
test('normal singleton/empty/list pages work, while unauthorized, malformed, truncated and duplicate pages fail closed',()=>{
 assert.equal(parseAwardPage(payload(sample(),1),1).rows.length,1);
 assert.equal(parseAwardPage(payload([],0),1).rows.length,0);
 assert.throws(()=>parseAwardPage({},1));
 assert.throws(()=>parseAwardPage({response:{header:{resultCode:'30'},body:{items:[],totalCount:0,pageNo:1}}},1));
 assert.throws(()=>parseAwardPage(payload([sample()],101),1),/누락/);
 assert.throws(()=>parseAwardPage(payload([sample(),sample()],2),1),/중복/);
 assert.throws(()=>parseAwardPage(payload([sample()],1,2),1),/페이지/);
 assert.throws(()=>parseAwardPage(payload([],50001),1),/한도/);
});
test('collection windows stay below the new seven-day service limit and HTTP failures never expose keys',async()=>{
 for(const cursor of [null,'2020-01-01','2026-11-13T00:00:00Z']){const w=awardWindow(cursor,new Date('2026-11-13T01:00:00Z'));assert(Date.parse(w.to)-Date.parse(w.from)<86400000);}
 let url;await fetchAwardPage({from:'2026-11-12T00:00:00Z',to:'2026-11-12T23:59:00Z',page:1,key:'secret+/='},async u=>{url=new URL(u);return {ok:true,text:async()=>JSON.stringify(payload([],0))};});
 assert.equal(url.searchParams.get('serviceKey'),'secret+/=');assert.equal(url.searchParams.get('inqryDiv'),'1');assert.equal(url.searchParams.get('inqryBgnDt'),'202611120900');
 await assert.rejects(fetchAwardPage({from:'2026-11-12',to:'2026-11-13',page:1,key:'secret'},async()=>{throw Error('secret URL');}),e=>!e.message.includes('secret'));
});
test('disabled or missing-key collectors do not access the DB, and denied leases never call upstream',async()=>{
 for(const env of [{AUTO_INGEST_ENABLED:'false',G2B_SERVICE_KEY:'x'},{}]){let calls=0;const worker=createAwardCollector({env,query:async()=>{calls++;},transaction:async()=>{}});await worker.run();assert.equal(calls,0);}
 let calls=0;await createAwardCollector({env:{G2B_SERVICE_KEY:'key'},query:async()=>({rows:[]}),transaction:async()=>{},fetchPage:async()=>calls++}).run();assert.equal(calls,0);
});
test('PostgreSQL persists pages across restart, rejects expired leases, deduplicates awards and joins late notices exactly',async()=>{
 const {PGlite}=require('@electric-sql/pglite'),db=new PGlite();await db.waitReady;
 try{
  const query=async(sql,args=[])=>args.length?db.query(sql,args):(await db.exec(sql)).at(-1)||{rows:[]};
  const transaction=async fn=>{await db.exec('BEGIN');try{const r=await fn(query);await db.exec('COMMIT');return r;}catch(e){await db.exec('ROLLBACK');throw e;}};
  const src=fs.readFileSync(require.resolve('../src/db'),'utf8'),ctx={query};vm.createContext(ctx);vm.runInContext(src.slice(src.indexOf('async function initDb'),src.indexOf('async function transaction')),ctx);await ctx.initDb();
  await query("UPDATE auto_ingest_state SET lease_token='test',lease_until=NOW()+INTERVAL '10 minutes' WHERE source='awards'");
  let scan=(await query("INSERT INTO award_scan(id,window_from,window_to) VALUES(1,'2026-11-11T00:00:00Z','2026-11-11T23:59:00Z') RETURNING *")).rows[0];
  await saveAwardPage(transaction,'test',scan,{rows:Array.from({length:100},(_,i)=>normalizeAward(sample(i+1))),total:201});
  scan=(await query('SELECT * FROM award_scan')).rows[0];assert.equal(scan.next_page,2);assert.equal(scan.seen_keys.length,100);assert.equal((await query('SELECT COUNT(*)::int n FROM construction_awards')).rows[0].n,100);
  await query("UPDATE auto_ingest_state SET lease_until=NOW()-INTERVAL '1 minute' WHERE source='awards'");
  await assert.rejects(saveAwardPage(transaction,'test',scan,{rows:[normalizeAward(sample(101))],total:201}),/실행권/);
  const called=[];const worker=createAwardCollector({query,transaction,env:{G2B_SERVICE_KEY:'key'},fetchPage:async({page})=>{called.push(page);return {rows:Array.from({length:page===2?100:1},(_,i)=>normalizeAward(sample((page-1)*100+i+1))),total:201};}});
  await worker.run();assert.deepEqual(called,[2,3]);assert.equal((await query('SELECT COUNT(*)::int n FROM construction_awards')).rows[0].n,201);assert.equal((await query('SELECT * FROM award_scan')).rows.length,0);
  const state=(await query("SELECT * FROM auto_ingest_state WHERE source='awards'")).rows[0];assert(state.cursor_at);assert.equal(state.last_error,null);assert.equal(state.daily_calls,2);
  // Replay a completed window is an upsert, not another contract.
  await query("UPDATE auto_ingest_state SET lease_token='again',lease_until=NOW()+INTERVAL '10 minutes' WHERE source='awards'");
  await query("INSERT INTO award_scan(id,window_from,window_to) VALUES(1,'2026-11-11','2026-11-12')");
  scan=(await query('SELECT * FROM award_scan')).rows[0];await saveAwardPage(transaction,'again',scan,{rows:[normalizeAward(sample(1))],total:1});
  assert.equal((await query('SELECT COUNT(*)::int n FROM construction_awards')).rows[0].n,201);
  await query("INSERT INTO projects(source,external_id,name,region,stage) VALUES('g2b_bid','T00000001-000','동일 공고','서울특별시','BID'),('g2b_bid','T00000002-001','다른 공고 차수','경기도','BID')");
  await query("INSERT INTO projects(source,name,contractor,start_date,stage,source_url) VALUES ('manual','착공 시공사 확인','검증 시공사','2026-11-10','STARTED','https://www.example.go.kr/record'),('demo','데모 제외','가상 업체','2026-11-10','STARTED','https://www.example.go.kr/record'),('manual','출처 없는 시공사','업체','2026-11-10','STARTED',NULL)");
  const handlers={};registerAwardRoutes({get:(p,h)=>handlers[p]=h},{query,regionAliases:require('../src/region-catalog').regionAliases,env:{G2B_SERVICE_KEY:'key'}});
  async function get(params={}){let code=200,data;await handlers['/api/awards']({query:params},{status(n){code=n;return this;},json(d){data=d;}});return {code,data};}
  let r=await get({q:'T00000001'});assert.equal(r.code,200,JSON.stringify(r));assert.equal(r.data.rows[0].region,'서울특별시');assert(r.data.rows[0].project_id);assert.equal(r.data.rows[0].company_address,'부산광역시 업체 사업장 주소');
  r=await get({q:'T00000002'});assert.equal(r.data.rows[0].project_id,null);assert.equal(r.data.rows[0].region,null);
  r=await get({kind:'construction_contractor'});assert.equal(r.data.total,1);assert.equal(r.data.rows[0].amount,null);assert.equal(r.data.rows[0].date_label,'실제착공일');
  r=await get({kind:'construction_contractor',minAmount:'1'});assert.equal(r.data.total,0);
  r=await get({region:'서울',kind:'public_award',minAmount:'1000000000'});assert.equal(r.data.total,1);
  r=await get({from:'2026-02-30'});assert.equal(r.code,400);
  r=await get({sort:'amount; DROP TABLE projects'});assert.equal(r.code,400);
  r=await get({page:'1.5'});assert.equal(r.code,400);
  assert.equal((await query('SELECT COUNT(*)::int n FROM projects')).rows[0].n,5);
 }finally{await db.close();}
});
test('failed upstream pages retain cursor and pending page rather than reporting an empty successful window',async()=>{
 const checks=[];const query=async(sql,args=[])=>{checks.push({sql,args});if(sql.includes('RETURNING *')&&sql.includes('auto_ingest_state'))return {rows:[{cursor_at:'2026-11-11'}]};if(sql.startsWith('SELECT * FROM award_scan'))return {rows:[{window_from:'2026-11-11',window_to:'2026-11-12',next_page:4,total_count:500,seen_keys:[]}]};if(sql.includes('daily_calls=CASE'))return {rows:[{source:'awards'}]};return {rows:[]};};
 await createAwardCollector({query,transaction:async()=>{throw Error('should not save');},env:{G2B_AWARD_SERVICE_KEY:'key'},fetchPage:async()=>{throw Error('upstream unavailable');}}).run();
 assert(checks.some(c=>c.sql.includes('SET last_error=')&&c.args[1]==='upstream unavailable'));assert(!checks.some(c=>c.sql.includes('SET cursor_at=')));assert(!checks.some(c=>c.sql.includes('last_success_at=NOW()')));
});
