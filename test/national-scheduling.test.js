const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {PGlite}=require('@electric-sql/pglite');
const {createAutoIngest}=require('../src/auto-ingest');
const {provinces}=require('../src/region-catalog');
const {REGION_STATS_SQL}=require('../src/national-coverage');
test('PostgreSQL execution rotates all provinces, isolates region failures and respects quota/authentication',async()=>{
 const db=new PGlite();await db.waitReady;
 try{
  const source=fs.readFileSync(require.resolve('../src/db'),'utf8');
  const start=source.indexOf('CREATE TABLE IF NOT EXISTS auto_ingest_state'),end=source.indexOf('CREATE TABLE IF NOT EXISTS permit_region_queues',start);
  await db.exec(source.slice(start,end));
  await db.exec('CREATE TABLE permit_region_presets(sigungu_cd TEXT,bjdong_cd TEXT,label TEXT);CREATE TABLE permit_legal_dong_codes(code TEXT,name TEXT,active BOOLEAN,catalog_origin TEXT);');
  const query=(sql,args=[])=>db.query(sql,args);
  const active=provinces.filter(p=>p.code),ids=active.map(p=>p.code+'001');
  async function reset(){
   await db.exec("TRUNCATE auto_permit_regions; UPDATE auto_ingest_state SET next_due_at=NOW(),lease_token=NULL,lease_until=NULL,last_error=NULL,last_success_at=NULL,daily_calls=0,call_day=NULL;");
   for(const id of ids)await query('INSERT INTO auto_permit_regions(sigungu_cd,bjdong_cd) VALUES($1,\'10000\')',[id]);
   // A dense province must not keep every other province waiting during initial ingestion.
   await query("INSERT INTO auto_permit_regions(sigungu_cd,bjdong_cd) SELECT '11001',g::text FROM generate_series(10001,19999) g");
  }
  const env={ARCH_HUB_SERVICE_KEY:'test-key',AUTO_PERMIT_PAGES_PER_TICK:'20'};
  let seen=[];await reset();
  let worker=createAutoIngest({query,env,busy:()=>false,bids:async()=>{},permit:async o=>{await o.beforePage();seen.push(o.sigunguCd.slice(0,2));return {status:'completed',hasMore:true,nextPage:o.startPage+1};}});
  await worker.tick();assert.equal(new Set(seen.slice(0,active.length)).size,active.length);
  const stats=await query(REGION_STATS_SQL);assert.equal(stats.rows.reduce((n,r)=>n+r.targets,0),10000+ids.length-1);
  assert.equal((await query("SELECT next_page FROM auto_permit_regions WHERE sigungu_cd='11001' AND bjdong_cd='10000'")).rows[0].next_page,2);
  await reset();seen=[];
  worker=createAutoIngest({query,env,busy:()=>false,bids:async()=>{},permit:async o=>{await o.beforePage();seen.push(o.sigunguCd);return o.sigunguCd==='11001'?{status:'failed',error:'regional timeout'}:{status:'completed',hasMore:false,nextPage:1};}});
  await worker.tick();assert(new Set(seen).size>1);
  const failed=await query("SELECT next_page,last_error,last_cycle_at FROM auto_permit_regions WHERE sigungu_cd='11001' AND bjdong_cd='10000'");assert.equal(failed.rows[0].next_page,1);assert.equal(failed.rows[0].last_cycle_at,null);assert(failed.rows[0].last_error);
  const state=(await query("SELECT last_success_at,last_error FROM auto_ingest_state WHERE source='permits'")).rows[0];assert(state.last_success_at);assert.match(state.last_error,/다른 지역 계속/);
  await reset();seen=[];
  worker=createAutoIngest({query,env,busy:()=>false,bids:async()=>{},permit:async o=>{await o.beforePage();seen.push(o.sigunguCd);return {status:'failed',error:'HTTP 403 인증 실패'};}});
  await worker.tick();assert.equal(seen.length,1);
  await reset();seen=[];
  await query("UPDATE auto_ingest_state SET call_day=(NOW() AT TIME ZONE 'Asia/Seoul')::date,daily_calls=500 WHERE source='permits'");
  worker=createAutoIngest({query,env,busy:()=>false,bids:async()=>{},permit:async o=>{await o.beforePage();seen.push(o.sigunguCd);return {status:'completed',hasMore:false};}});
  await worker.tick();assert.equal(seen.length,0);assert.equal((await query('SELECT COUNT(*)::int AS n FROM auto_permit_regions WHERE next_page<>1 OR last_cycle_at IS NOT NULL')).rows[0].n,0);
 }finally{await db.close();}
});
