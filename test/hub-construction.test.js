const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {config,ledgerId,parseDetail,createPublicClient,saveDetail,createHubCollector}=require('../src/hub-construction');
const ledger='1000000000000000000123';
const project={id:1,external_id:ledger,source:'arch_hub_permit',address:'서울특별시 강남구 검증동 1-1',permit_date:'2026-01-10',stage:'PERMIT'};
const row={pmsrgstSeqno:ledger,addr:project.address,archPmsDate:'20260110',stcnsPrrngDate:'20260501',edcnsPrrngDate:'20270501',realStcnsDate:null,partcpnt:'시공자',offcnm:'검증 건설 주식회사',telno:'02-1234-5678'};
const response=rows=>({resultList:rows});
test('exact ledger/address/permit checks reject mixed identity and do not turn forecasts into actual construction',()=>{
 const r=parseDetail(response([row]),project);assert.equal(r.outcome,'matched');assert.equal(r.actualStart,null);assert.equal(r.plannedStart,'2026-05-01');assert.equal(r.parties[0].stage,'PERMIT');
 assert.throws(()=>parseDetail(response([{...row,pmsrgstSeqno:ledger+'0'}]),project),/식별자|관리번호/);
 assert.throws(()=>parseDetail(response([row,{...row,addr:'다른 현장'}]),project),/식별자/);
 assert.throws(()=>parseDetail(response([row]),{...project,permit_date:'2025-01-10'}),/허가일/);
 assert.throws(()=>parseDetail(response([row]),{...project,address:'다른 주소'}),/주소/);
 assert.equal(ledgerId(Number(ledger)),null);assert.equal(ledgerId('11680-'+ledger),null);
});
test('only explicit company roles and landlines are retained; personal owners, site managers and masked companies are excluded',()=>{
 const rows=[row,{...row,partcpnt:'설계자',offcnm:'검증 건축사사무소',telno:'010-1234-5678',nm:'개인 이름'},
 {...row,partcpnt:'감리자',offcnm:'검증 감리사',telno:'02-****-1234'},
 {...row,partcpnt:'현장관리인',offcnm:'현장소장',nm:'이름',telno:'010-1234-5678'},
 {...row,partcpnt:'건축주',offcnm:'개인건축주',nm:'이름'},
 {...row,partcpnt:'건축주',offcnm:'검증 개발 주식회사'},
 {...row,partcpnt:'설계자',offcnm:'****사무소'}];
 const r=parseDetail(response(rows),project);assert.deepEqual(r.parties.map(p=>p.role),['contractor','designer','supervisor','owner']);assert.equal(r.parties[0].phone,'0212345678');assert.equal(r.parties[1].phone,null);assert.equal(r.parties[2].phone,null);assert(r.parties.every(p=>!p.person_name));assert(!JSON.stringify(r).includes('010-1234'));assert(!JSON.stringify(r).includes('****'));
});
test('missing records, malformed responses and missing API identity are distinct outcomes',()=>{
 assert.equal(parseDetail(response([]),project).outcome,'not_found');
 assert.throws(()=>parseDetail({},project),/형식/);assert.throws(()=>parseDetail(response([{...row,archPmsDate:'20260230'}]),project),/허가일/);
 assert.throws(()=>parseDetail(response([row]),{...project,external_id:'new-pk-format'}),/관리번호/);
});
test('collector is off until both reuse confirmation and enable flag are set; global disable wins',async()=>{
 for(const env of [{},{HUB_CONSTRUCTION_ENABLED:'true'},{HUB_CONSTRUCTION_REUSE_CONFIRMED:'true'},{HUB_CONSTRUCTION_ENABLED:'true',HUB_CONSTRUCTION_REUSE_CONFIRMED:'true',AUTO_INGEST_ENABLED:'false'}]){
 let n=0;await createHubCollector({env,query:async()=>{n++;},transaction:async()=>{}}).run();assert.equal(n,0);assert.equal(config(env).enabled,false);
 }
});
test('public client uses only the observed fixed path, reserves GET/POST calls and keeps session metadata out of errors',async()=>{
 let reserved=0,calls=0;const client=createPublicClient({fetcher:async(url,opts)=>{
 calls++;assert(url.startsWith('https://www.hub.go.kr/'));assert.equal(opts.redirect,'error');
 if(calls===1)return {ok:true,headers:{getSetCookie:()=>['anon=safe; Path=/']},text:async()=>'<meta name="_csrf_header" content="X-CSRF-TOKEN"><meta name="_csrf" content="nonsecret-fixture-token">select-CssDetail.do'};
 assert(url.endsWith('/portal/gis/restCss/select-CssDetail.do'));assert.equal(opts.headers.Cookie,'anon=safe');assert.equal(JSON.parse(opts.body).relateLdgrSn,ledger);return {ok:true,text:async()=>JSON.stringify(response([row]))};
 }});
 assert.equal((await client.detail(ledger,async()=>reserved++)).resultList.length,1);assert.equal(reserved,2);
 await assert.rejects(client.detail('bad'),/관리번호/);
 const failed=createPublicClient({fetcher:async()=>{throw Error('session token private');}});await assert.rejects(failed.detail(ledger),e=>!e.message.includes('private'));
});
test('PostgreSQL refresh preserves historical evidence, updates only HUB contacts, and excludes removed contractors from award view',async()=>{
 const {PGlite}=require('@electric-sql/pglite'),db=new PGlite();await db.waitReady;
 try{
  const query=async(sql,args=[])=>args.length?db.query(sql,args):(await db.exec(sql)).at(-1)||{rows:[]};
  const transaction=async fn=>{await db.exec('BEGIN');try{const v=await fn(query);await db.exec('COMMIT');return v;}catch(e){await db.exec('ROLLBACK');throw e;}};
  const src=fs.readFileSync(require.resolve('../src/db'),'utf8'),ctx={query};vm.createContext(ctx);vm.runInContext(src.slice(src.indexOf('async function initDb'),src.indexOf('async function transaction')),ctx);await ctx.initDb();
  const p=(await query("INSERT INTO projects(source,external_id,name,address,permit_date,start_date,stage,area_sqm,region) VALUES('arch_hub_permit',$1,'검증 현장',$2,'2026-01-10','2026-05-10','STARTED',12000,'서울특별시') RETURNING *",[ledger,project.address])).rows[0];
  await query("INSERT INTO project_contacts(project_id,role,organization,phone,source) VALUES($1,'designer','관리자 등록 사무소','02-2222-3333','manual')",[p.id]);
  await query("UPDATE auto_ingest_state SET lease_token='test',lease_until=NOW()+INTERVAL '10 minutes' WHERE source='hub_construction'");
  const record=parseDetail(response([row,{...row,partcpnt:'설계자',offcnm:'검증 건축사사무소'}]),p);
  await saveDetail(transaction,'test',p,record);await saveDetail(transaction,'test',p,record);
  assert.equal((await query('SELECT COUNT(*)::int n FROM project_party_evidence')).rows[0].n,2);
  assert.equal((await query("SELECT COUNT(*)::int n FROM project_contacts WHERE source='hub_construction'")).rows[0].n,2);
  const {AWARD_RECORDS}=require('../src/award-routes');let awards=(await query(AWARD_RECORDS+" SELECT * FROM records WHERE kind='construction_contractor'")).rows;assert.equal(awards.length,1);assert.equal(awards[0].organization,row.offcnm);assert.equal(awards[0].amount,null);
  await saveDetail(transaction,'test',p,parseDetail(response([{...row,partcpnt:'設計者',offcnm:'잘못된 역할'},{...row,partcpnt:'설계자',offcnm:'변경 설계사'}]),p));
  assert.equal((await query('SELECT COUNT(*)::int n FROM project_party_evidence')).rows[0].n,3);
  assert.equal((await query("SELECT COUNT(*)::int n FROM project_contacts WHERE source='hub_construction'")).rows[0].n,1);
  assert.equal((await query("SELECT COUNT(*)::int n FROM project_contacts WHERE source='manual'")).rows[0].n,1);
  assert.equal((await query(AWARD_RECORDS+" SELECT * FROM records WHERE kind='construction_contractor'")).rows.length,0);
  const oldIds=(await query('SELECT current_evidence_ids FROM hub_construction_checks')).rows[0].current_evidence_ids;
  await saveDetail(transaction,'test',p,parseDetail(response([]),p));assert.deepEqual((await query('SELECT current_evidence_ids FROM hub_construction_checks')).rows[0].current_evidence_ids,oldIds);
  const unchanged=(await query('SELECT stage,start_date,completion_date,contractor FROM projects WHERE id=$1',[p.id])).rows[0];assert.equal(unchanged.stage,'STARTED');assert.equal(new Date(unchanged.start_date).toISOString().slice(0,10),'2026-05-10');assert.equal(unchanged.completion_date,null);assert.equal(unchanged.contractor,null);
  await query("UPDATE auto_ingest_state SET lease_until=NOW()-INTERVAL '1 minute' WHERE source='hub_construction'");await assert.rejects(saveDetail(transaction,'test',p,record),/실행권/);
  assert.equal((await query('SELECT COUNT(*)::int n FROM project_party_evidence')).rows[0].n,3);
  await query('UPDATE hub_construction_checks SET next_due_at=NOW()');
  let fetched=0;const env={HUB_CONSTRUCTION_ENABLED:'true',HUB_CONSTRUCTION_REUSE_CONFIRMED:'true'};
  await createHubCollector({query,transaction,env,client:{detail:async(id,reserve)=>{await reserve();fetched++;assert.equal(id,ledger);return response([row]);}}}).run();
  assert.equal(fetched,1);const state=(await query("SELECT * FROM auto_ingest_state WHERE source='hub_construction'")).rows[0];assert(state.last_success_at);assert.equal(state.daily_calls,1);assert.equal(state.last_error,null);
  const info=await require('../src/hub-construction').status(query,env);assert.equal(info.counts.matched,1);assert.equal(info.counts.current_party_records,1);
 }finally{await db.close();}
});
test('budget/lease failures never fetch or write facts; no eligible project is not a successful data scan',async()=>{
 for(const variant of ['lease','budget','idle']){
  let requests=0,transactions=0;const calls=[];const query=async(sql,args)=>{calls.push(sql);if(sql.includes('RETURNING source')&&sql.includes('last_attempt_at'))return {rows:variant==='lease'?[]:[{source:'hub_construction'}]};if(sql.includes('WITH regions'))return {rows:variant==='idle'?[]:[project]};return {rows:[]};};
  await createHubCollector({query,transaction:async()=>{transactions++;},env:{HUB_CONSTRUCTION_ENABLED:'true',HUB_CONSTRUCTION_REUSE_CONFIRMED:'true'},client:{detail:async(id,reserve)=>{await reserve();requests++;return response([row]);}}}).run();
  assert.equal(requests,0);assert.equal(transactions,0);assert(!calls.some(s=>s.includes('last_success_at=NOW()')));
 }
});
