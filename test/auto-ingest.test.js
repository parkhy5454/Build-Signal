const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createAutoIngest,bidWindow,permitPageState}=require('../src/auto-ingest');

test('bid catch-up overlaps two hours and caps long downtime at seven days',()=>{
 const now=new Date('2026-11-12T12:00:00Z');
 const first=bidWindow(null,now);assert.equal(first.start.toISOString(),'2026-11-05T12:00:00.000Z');
 const next=bidWindow('2026-11-11T12:00:00Z',now);assert.equal(next.start.toISOString(),'2026-11-11T10:00:00.000Z');assert.equal(next.end.toISOString(),now.toISOString());
 const old=bidWindow('2026-10-01T12:00:00Z',now);assert.equal(old.end-old.start,7*86400000);
});
test('permit checkpoint advances unfinished pages and only restarts after region completion',()=>{
 assert.deepEqual(permitPageState({status:'completed',hasMore:true,nextPage:22}),{nextPage:22,complete:false});
 assert.deepEqual(permitPageState({status:'completed',hasMore:false,nextPage:1}),{nextPage:1,complete:true});
 assert.throws(()=>permitPageState({status:'failed',error:'API down'}),/API down/);
});
function harness({denyLease=false,denyBudget=false,badPermit=false,regions=true,enabled=true}={}){
 const calls=[],checks=[],region={sigungu_cd:'11680',bjdong_cd:'10300',next_page:21};let permitCalls=0,bidCalls=0;
 const query=async(sql,args=[])=>{
  checks.push({sql,args});
  if(sql.includes('RETURNING *'))return {rows:denyLease?[]:[{cursor_at:'2026-11-11T12:00:00Z'}]};
  if(sql.includes('daily_calls=CASE'))return {rows:denyBudget?[]:[{source:args[0]}]};
  if(sql.includes('SELECT r.* FROM auto_permit_regions'))return {rows:regions?[{...region}]:[]};
  if(sql.includes('SET next_page=')){region.next_page=args[2];return {rows:[{sigungu_cd:'11680'}]};}
  if(sql.includes('SET cursor_at='))return {rows:[{source:'bids'}]};
  return {rows:[]};
 };
 const worker=createAutoIngest({query,env:{AUTO_INGEST_ENABLED:enabled?'true':'false',ARCH_HUB_SERVICE_KEY:'key',G2B_SERVICE_KEY:'key',AUTO_PERMIT_PAGES_PER_TICK:'2'},busy:()=>false,
  permit:async opts=>{permitCalls++;calls.push(opts);try{await opts.beforePage();}catch(e){return {status:'failed',error:e.message};}return badPermit?{status:'failed',error:'API down'}:{status:'completed',hasMore:true,nextPage:opts.startPage+1};},
  bids:async opts=>{bidCalls++;await opts.beforePage();await opts.onWindowSuccess(opts.endedAt);}
 });
 return {worker,region,calls,checks,get permitCalls(){return permitCalls;},get bidCalls(){return bidCalls;}};
}
test('background tick persists page 21 and continues at page 23 on the next tick',async()=>{
 const h=harness();await h.worker.tick();assert.equal(h.bidCalls,1);assert.equal(h.calls[0].startPage,21);assert.equal(h.calls[1].startPage,22);assert.equal(h.region.next_page,23);
 await h.worker.tick();assert.equal(h.calls[2].startPage,23);
 assert(h.checks.some(x=>x.sql.includes('SET cursor_at=')));
});
test('denied distributed lease prevents upstream calls',async()=>{
 const h=harness({denyLease:true});await h.worker.tick();assert.equal(h.permitCalls,0);assert.equal(h.bidCalls,0);
});
test('exhausted budget and failed permit pages do not advance saved progress',async()=>{
 for(const options of [{denyBudget:true},{badPermit:true}]){
  const h=harness(options);await h.worker.tick();assert.equal(h.region.next_page,21);assert(h.checks.some(x=>x.sql.includes('SET last_error=$3')));
 }
});
test('disabled worker does no DB work; idle regions do not claim a successful data update',async()=>{
 const off=harness({enabled:false});await off.worker.tick();assert.equal(off.checks.length,0);
 const idle=harness({regions:false});await idle.worker.tick();const release=idle.checks.find(x=>x.args[0]==='permits'&&x.sql.includes('last_success_at=CASE'));assert.equal(release.args[3],false);
});
test('two overlapping ticks share one local run',async()=>{
 const h=harness();await Promise.all([h.worker.tick(),h.worker.tick()]);assert.equal(h.bidCalls,1);assert.equal(h.permitCalls,2);
});
test('automatic bid window failure stops subsequent windows and leaves failed interval uncheckpointed',async()=>{
 const fs=require('node:fs'),vm=require('node:vm'),source=fs.readFileSync(require.resolve('../src/server'),'utf8');
 const start=source.indexOf('async function g2bRunJob('),end=source.indexOf("app.post('/api/admin/g2b/sync'",start);
 for(const failure of [false,true]){
  let fetched=0,reserved=0;const checkpoints=[];
  const ctx={g2bPause:async()=>{},g2bFormatKst:d=>d.toISOString(),g2bFetchPage:async()=>{fetched++;if(failure)throw Error('API unavailable');return {items:[],total:0};},query:async()=>({rows:[]})};
  vm.createContext(ctx);vm.runInContext(source.slice(start,end),ctx);
  const job={automatic:true,beginningAt:'2026-11-12T00:00:00Z',endedAt:'2026-11-12T02:00:00Z',completedWindows:0,received:0,inserted:0,updated:0,skipped:0,pages:0,errors:[],beforePage:async()=>reserved++,onWindowSuccess:async to=>checkpoints.push(to)};
  await ctx.g2bRunJob(job);
  assert.equal(checkpoints.length,failure?0:2);assert.equal(fetched,failure?3:2);assert.equal(reserved,fetched);assert.equal(job.status,failure?'partial':'completed');
 }
});
