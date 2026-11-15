const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {readDataReadiness,registerDataReadinessRoute}=require('../src/data-readiness');
async function database(){
 const {PGlite}=require('@electric-sql/pglite'),db=new PGlite();await db.waitReady;
 const query=async(sql,args=[])=>args.length?db.query(sql,args):(await db.exec(sql)).at(-1)||{rows:[]};
 const src=fs.readFileSync(require.resolve('../src/db'),'utf8'),ctx={query};vm.createContext(ctx);vm.runInContext(src.slice(src.indexOf('async function initDb'),src.indexOf('async function transaction')),ctx);await ctx.initDb();return {db,query};
}
async function project(query,source,name='검증동 복합시설 신축사업'){
 return (await query("INSERT INTO projects(source,name,owner,address,region,stage,permit_date,area_sqm,source_url) VALUES($1,$2,'검증개발 주식회사','서울특별시 강남구 검증동 100','서울특별시',$3,'2026-01-01',12000,'https://www.hub.go.kr/') RETURNING id",[source,name,source==='g2b_bid'?'BID':'PERMIT'])).rows[0].id;
}
async function evidence(query,pid,{role='designer',organization='검증 설계사',phone='02-1111-2222',origin='automatic',fingerprint='one'}={}){
 return (await query("INSERT INTO project_party_evidence(project_id,role,organization,phone,source_url,observed_stage,contact_scope,origin,fingerprint) VALUES($1,$2,$3,$4,'https://www.hub.go.kr/','PERMIT','company',$5,$6) RETURNING id",[pid,role,organization,phone,origin,fingerprint])).rows[0].id;
}
test('readiness uses unified projects, explicit procurement provenance and distinct role coverage without inventing private ownership',async()=>{
 const {db,query}=await database();try{
 const permit=await project(query,'arch_hub_permit'),a=await project(query,'g2b_bid','검증동 복합시설 신축사업 전기공사'),b=await project(query,'g2b_bid','검증동 복합시설 신축사업 통신공사');
 const g=(await query("INSERT INTO project_groups(group_key,title,owner,region,location) VALUES('one','검증동 복합시설 신축사업','검증개발 주식회사','서울특별시','서울특별시 강남구 검증동 100') RETURNING id")).rows[0].id;
 await query('UPDATE projects SET project_group_id=$1 WHERE id=ANY($2::bigint[])',[g,[a,b]]);
 await query("INSERT INTO project_contacts(project_id,role,organization,phone,email,person_name,source) VALUES($1,'client','검증기관','02-1234-1234','work@example.invalid','담당자','g2b')",[a]);
 await query("INSERT INTO project_contacts(project_id,role,organization,phone,source) VALUES($1,'client','검증기관','02-1234-1234','g2b')",[b]);
 await evidence(query,permit);await evidence(query,permit,{fingerprint:'two'});
 const privateUnknown=await project(query,'arch_hub_permit','주식회사 이름만 있는 민간 여부 미판정 현장');await query("UPDATE projects SET region=NULL,area_sqm=NULL,permit_date=NULL,owner=NULL,designer='미확인' WHERE id=$1",[privateUnknown]);
 await project(query,'demo');await query("INSERT INTO construction_awards(event_key,notice_no,notice_ord,classification_no,rebid_no,name,winner,source_url) VALUES('test','R0001','000','1','0','검증 결과','검증 낙찰업체','https://www.g2b.go.kr/')");
 const result=await readDataReadiness(query,{provinces:[{value:'경기도',code:'41'}],env:{}}),s=result.summary;
 assert.equal(s.source_records,4);assert.equal(s.projects,2);assert.equal(s.demo_excluded,1);assert.equal(s.with_party,1);assert.equal(s.with_contact,1);assert.equal(s.missing_area,1);assert.equal(s.missing_event_date,1);
 assert.equal(result.sector.procurement_backed,1);assert.equal(result.sector.ownership_unclassified,2);assert.equal(result.sector.ownership_classification,'not_collected');assert.equal(result.hub.enabled,false);
 const designer=result.roles.find(r=>r.role==='designer'),client=result.roles.find(r=>r.role==='client');assert.equal(designer.organization,1);assert.equal(designer.phone,1);assert.equal(client.organization,1);assert.equal(client.named_contact,1);
 assert.equal(result.regions.find(r=>r.region==='지역 미확인').projects,1);assert.equal(result.regions.find(r=>r.region==='경기도').projects,0);
 assert.equal(result.awards.records,1);assert.equal(result.awards.linked_notices,0);assert.equal(result.sources.find(r=>r.source==='g2b_bid').projects,1);
 assert(!JSON.stringify(result).includes('work@example.invalid'));assert(!JSON.stringify(result).includes('02-1234-1234'));assert.equal((await query('SELECT COUNT(*)::int n FROM projects')).rows[0].n,5);
 }finally{await db.close();}
});
test('superseded HUB evidence, masked contacts and retired review facts do not inflate readiness; empty data has no invented percent',async()=>{
 const {db,query}=await database();try{
 let d=await readDataReadiness(query);assert.equal(d.summary.projects,0);assert(d.roles.every(r=>r.organization===0));assert(d.sources.some(r=>r.source==='arch_hub_permit'&&r.records===0));
 const p=await project(query,'arch_hub_permit');await query('UPDATE projects SET owner=NULL WHERE id=$1',[p]);
 const old=await evidence(query,p,{role:'contractor',origin:'hub_construction',fingerprint:'old'}),current=await evidence(query,p,{role:'supervisor',origin:'hub_construction',phone:'02-****-1234',fingerprint:'current'});
 await query("INSERT INTO hub_construction_checks(project_id,ledger_id,outcome,last_attempt_at,current_evidence_ids) VALUES($1,'100000000000000000001','matched',NOW(),$2)",[p,[current]]);
 await query("INSERT INTO project_contacts(project_id,role,organization,phone,source) VALUES($1,'contractor','과거 업체','02-5555-5555','hub_construction')",[p]);
 const retired=await project(query,'document_review','과거 안건');await query("INSERT INTO review_extract_pages(url,title) VALUES('https://www.example.go.kr/post','과거 원문')");await query("INSERT INTO review_extract_files(url,page_url,name,format) VALUES('https://www.example.go.kr/a.pdf','https://www.example.go.kr/post','old.pdf','pdf')");await query("INSERT INTO review_extracted_projects(file_url,project_id,case_key,is_current) VALUES('https://www.example.go.kr/a.pdf',$1,'one',FALSE)",[retired]);await evidence(query,retired,{role:'designer',fingerprint:'retired'});
 d=await readDataReadiness(query);assert.equal(d.summary.projects,2);assert.equal(d.summary.with_party,1);assert.equal(d.summary.with_contact,0);assert.equal(d.summary.historical_only,1);
 assert.equal(d.roles.find(r=>r.role==='contractor').organization,0);assert.equal(d.roles.find(r=>r.role==='supervisor').organization,1);assert.equal(d.roles.find(r=>r.role==='supervisor').phone,0);assert.equal(d.roles.find(r=>r.role==='designer').organization,0);
 }finally{await db.close();}
});
test('audit route requires both auth guards, uses no-store and hides internal query errors',async()=>{
 const login=()=>{},admin=()=>{};let registration;registerDataReadinessRoute({get:(...args)=>registration=args},{query:async()=>{throw Error('private database details');},loadUser:login,requireAdminRole:admin,provinces:[]});
 assert.equal(registration[0],'/api/admin/data-readiness');assert.equal(registration[1],login);assert.equal(registration[2],admin);let status,body,cache;await registration[3]({}, {set(k,v){cache=[k,v];},status(n){status=n;return this;},json(d){body=d;}});assert.equal(status,500);assert.deepEqual(cache,['Cache-Control','no-store']);assert(!JSON.stringify(body).includes('private'));
});
