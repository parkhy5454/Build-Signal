const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {permitDate,permitLifecycle}=require('../src/archhub');

test('only valid actual dates define the latest stage',()=>{
 assert.equal(permitDate('20260230'),null);
 assert.equal(permitDate('00000000'),null);
 assert.equal(permitDate(' 20240229 '),'2024-02-29');
 assert.equal(permitLifecycle({archPmsDay:'20260101'}).stage,'PERMIT');
 assert.equal(permitLifecycle({realStcnsDay:'20260301',stcnsSchedDay:'20260101'}).stage,'STARTED');
 assert.equal(permitLifecycle({stcnsSchedDay:'20260101'}).stage,'UNKNOWN');
 assert.deepEqual(permitLifecycle({archPmsDay:'20260101',realStcnsDay:'20260301',useAprDay:'20261031'}),{permit:'2026-01-01',started:'2026-03-01',completed:'2026-10-31',stage:'COMPLETED'});
});
function harness(items,options={}){
 const source=fs.readFileSync(require.resolve('../src/server'),'utf8');
 const stored=new Map(),urls=[];
 const ctx={permitLifecycle,permitDate,URL,AbortSignal,process:{env:{ARCH_HUB_SERVICE_KEY:'test-key'}},savePermitJob:async()=>{},
  fetch:async url=>{urls.push(new URL(url));return {ok:true,text:async()=>JSON.stringify({response:{header:{resultCode:options.error||'00'},body:{items:{item:items},totalCount:items.length}}})};},
  query:async(sql,args)=>{
   assert.equal(args.length,13);assert(sql.includes('completion_date=COALESCE(EXCLUDED.completion_date,projects.completion_date)'));
   const old=stored.get(args[0]),dates=[args[7]||old?.dates[0],args[8]||old?.dates[1],args[9]||old?.dates[2]];
   const stage=dates[2]?'COMPLETED':dates[1]?'STARTED':dates[0]?'PERMIT':'UNKNOWN';
   stored.set(args[0],{dates,stage});return {rows:[{inserted:!old,stage}]};
  }};
 vm.createContext(ctx);
 const start=source.indexOf('async function permitSync('),end=source.indexOf("app.post('/api/admin/permits/sync'",start);
 vm.runInContext(source.slice(start,end),ctx);
 const run=async opts=>{const job={status:'running',received:0,inserted:0,updated:0,skipped:0};await ctx.permitSync(job,{sigunguCd:'11680',bjdongCd:'10300',...opts});return job;};
 return {run,stored,urls};
}
test('initial regional load stores all three stages, skips missing identity and updates duplicates',async()=>{
 const items=[{mgmPmsrgstPk:'p',platPlc:'서울특별시 강남구',archPmsDay:'20260101'},
 {mgmPmsrgstPk:'s',platPlc:'서울특별시 강남구',realStcnsDay:'20260301'},
 {mgmPmsrgstPk:'c',platPlc:'서울특별시 강남구',useAprDay:'20261031'},{}];
 const h=harness(items),job=await h.run();
 assert.equal(job.status,'completed');assert.equal(job.inserted,3);assert.equal(job.skipped,1);assert.equal(job.byStage.COMPLETED,1);
 assert.equal(h.urls[0].searchParams.has('startDate'),false);
 assert.equal(h.stored.get('c').dates[2],'2026-10-31');
 items[2].useAprDay='';const again=await h.run({startDate:'20261001',endDate:'20261030'});
 assert.equal(again.updated,3);assert.equal(h.stored.size,3);assert.equal(h.stored.get('c').stage,'COMPLETED');
 assert.equal(h.urls[1].searchParams.get('startDate'),'20261001');
});
test('zero results and upstream failure are distinct outcomes',async()=>{
 const empty=await harness([]).run();assert.equal(empty.status,'completed');assert.match(empty.note,/조회된 원천 자료가 없습니다/);
 const bad=await harness([],{error:'30'}).run();assert.equal(bad.status,'failed');assert.match(bad.error,/API 오류 30/);
});
test('first-load mode still requires valid region codes; date mode keeps its 30-day bound',async()=>{
 const source=fs.readFileSync(require.resolve('../src/server'),'utf8');let handler,lastOpts;
 const ctx={process:{env:{ARCH_HUB_SERVICE_KEY:'test-key'}},permitDate,permitJob:null,loadUser(){},requireAdminRole(){},savePermitJob:async()=>{},permitSync:async(job,opts)=>{lastOpts=opts;job.status='completed';},app:{post:(path,...handlers)=>{handler=handlers.at(-1);}}};
 vm.createContext(ctx);const a=source.indexOf("app.post('/api/admin/permits/sync'");vm.runInContext(source.slice(a,source.indexOf("app.get('/api/admin/permits/data-quality'",a)),ctx);
 const call=body=>{const res={code:200,status(n){this.code=n;return this;},json(d){this.data=d;return this;}};handler({body},res);return res;};
 assert.equal(call({sigunguCd:'bad',bjdongCd:'10300',initialLoad:true}).code,400);
 assert.equal(call({sigunguCd:'11680',bjdongCd:'10300',startDate:'20260101',endDate:'20260301'}).code,400);
 const r=call({sigunguCd:'11680',bjdongCd:'10300',initialLoad:true});assert.equal(r.code,202);
 await new Promise(resolve=>setImmediate(resolve));assert.equal(lastOpts.startDate,undefined);
});
