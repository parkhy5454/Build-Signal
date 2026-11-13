const {test}=require('node:test'),assert=require('node:assert/strict');
const {FIELDS,summarize,recordAudit,auditView}=require('../src/archhub-audit');
test('API inspection records only fixed field presence and validity, never source values or credentials',()=>{
 const s=summarize([{mgmPmsrgstPk:'sensitive-id',platPlc:'private address',bldNm:'private project',totArea:'23000',archPmsDay:'20260230',realStcnsDay:'20260101',useAprDay:'',serviceKey:'secret',ownerNm:'private owner',tel:'010-1111-2222'},{mgmPmsrgstPk:'',platPlc:'',totArea:0}]);
 assert.equal(s.sampleSize,2);assert.equal(s.validIdentity,1);assert.equal(s.fields.archPmsDay.present,1);assert.equal(s.fields.archPmsDay.usable,0);assert.equal(s.fields.realStcnsDay.usable,1);assert.equal(s.fields.totArea.present,2);assert.equal(s.fields.totArea.usable,1);
 const json=JSON.stringify(s);for(const v of ['sensitive-id','private','secret','010-1111-2222','serviceKey'])assert(!json.includes(v));assert.equal(Object.keys(s.fields).length,FIELDS.length);assert.equal(s.unmapped.ownerNm,1);assert.equal(s.unmapped.serviceKey,undefined);
});
test('no observed response, empty-only response and usable sample are separate states; parties remain unmapped',()=>{
 assert.equal(auditView().status,'not_observed');assert.equal(auditView({last_response_at:new Date()}).status,'empty_only');
 const a=auditView({last_nonempty_at:new Date(),sample_size:1,field_counts:{bldNm:{present:1,usable:1}}});assert.equal(a.status,'sample_observed');assert.equal(a.fields.find(f=>f.key==='bldNm').usable,1);assert.equal(a.parties.status,'not_mapped');
});
test('PostgreSQL preserves last nonempty sample on zero rows and the normal ingestion path records it after successful storage',async()=>{
 const {PGlite}=require('@electric-sql/pglite'),fs=require('node:fs'),vm=require('node:vm');const db=new PGlite();await db.waitReady;
 try{
  const query=async(sql,args=[])=>args.length?db.query(sql,args):(await db.exec(sql)).at(-1)||{rows:[]};const src=fs.readFileSync(require.resolve('../src/db'),'utf8'),ctx={query};vm.createContext(ctx);vm.runInContext(src.slice(src.indexOf('async function initDb'),src.indexOf('async function transaction')),ctx);await ctx.initDb();
  await recordAudit(query,[{mgmPmsrgstPk:'id',platPlc:'site',totArea:25000}],100);await recordAudit(query,[],0);
  const row=(await query('SELECT * FROM archhub_api_audit')).rows[0];assert.equal(row.sample_size,1);assert.equal(row.last_received_count,0);assert.equal(Number(row.responses_seen),2);assert.equal(row.field_counts.totArea.usable,1);assert(row.last_nonempty_at);
  await recordAudit(query,[],null);assert.equal((await query('SELECT last_total_count FROM archhub_api_audit')).rows[0].last_total_count,null);
  const server=fs.readFileSync(require.resolve('../src/server'),'utf8'),start=server.indexOf('async function permitSync('),end=server.indexOf("app.post('/api/admin/permits/sync'",start);let captured,stageQueries=0;
  const c={URL,AbortSignal,process:{env:{ARCH_HUB_SERVICE_KEY:'test-secret'}},permitDate:require('../src/archhub').permitDate,permitLifecycle:require('../src/archhub').permitLifecycle,savePermitJob:async()=>{},recordAudit:async(q,items,total)=>{captured={items,total};assert.equal(stageQueries,1);},fetch:async()=>({ok:true,text:async()=>JSON.stringify({response:{header:{resultCode:'00'},body:{items:{item:{mgmPmsrgstPk:'id',platPlc:'site',archPmsDay:'20260101'}},totalCount:1}}})}),query:async sql=>{if(sql.includes('INSERT INTO projects')){stageQueries++;return {rows:[{inserted:true,stage:'PERMIT'}]};}return {rows:[]};}};
  const handlers={},adminCtx={query,auditView,summarizeArchhubProbe:summarize,URL,AbortSignal,loadUser(){},requireAdminRole(){},process:{env:{ARCH_HUB_SERVICE_KEY:'secret-key'}},app:{get:(url,...h)=>{handlers[url]=h.at(-1);},post:(url,...h)=>{handlers[url]=h.at(-1);}},fetch:async url=>{assert(!url.searchParams.has('startDate'));assert(!url.searchParams.has('endDate'));return {status:200,headers:{get:()=> 'application/json'},text:async()=>JSON.stringify({response:{header:{resultCode:'00'},body:{items:{item:{mgmPmsrgstPk:'PRIVATE-ID',platPlc:'PRIVATE-ADDRESS',bldNm:'PRIVATE-NAME'}},totalCount:1}}})};}};
  vm.createContext(adminCtx);const aa=server.indexOf("app.get('/api/admin/permits/status'"),bb=server.indexOf('let permitJob=null;',aa);vm.runInContext(server.slice(aa,bb),adminCtx);let body,status=200;const response={status(n){status=n;return this;},json(v){body=v;}};
  await handlers['/api/admin/permits/status']({},response);assert.equal(body.configured,true);assert.equal(body.seumteo.status,'sample_observed');
  await handlers['/api/admin/permits/test']({},response);assert.equal(status,200);assert.equal(body.sample.sampleSize,1);assert(!JSON.stringify(body).includes('PRIVATE'));assert(!JSON.stringify(body).includes('secret-key'));assert.equal(Number((await query('SELECT responses_seen FROM archhub_api_audit')).rows[0].responses_seen),3);
  vm.createContext(c);vm.runInContext(server.slice(start,end),c);const job={received:0,inserted:0,updated:0,skipped:0};await c.permitSync(job,{automatic:true,sigunguCd:'11680',bjdongCd:'10300'});assert.equal(job.status,'completed');assert.equal(captured.items.length,1);assert.equal(captured.total,1);
 }finally{await db.close();}
});
