const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const unified=require('../src/unified-projects');
async function database(){
 const {PGlite}=require('@electric-sql/pglite'),db=new PGlite();await db.waitReady;
 const query=async(sql,args=[])=>{const r=args.length?await db.query(sql,args):(await db.exec(sql)).at(-1)||{rows:[]};return {...r,rowCount:r.rows.length};};
 const source=fs.readFileSync(require.resolve('../src/db'),'utf8'),ctx={query};vm.createContext(ctx);vm.runInContext(source.slice(source.indexOf('async function initDb'),source.indexOf('async function transaction')),ctx);await ctx.initDb();
 return {db,query};
}
function routes(query){
 const handlers={},ctx={...unified,...require('../src/project-search-options'),query,regionAliases:require('../src/region-catalog').regionAliases,STAGES:['REVIEW','PERMIT','STARTED','COMPLETED','BID','UNKNOWN'],directoryMatches:async()=>[],coverageSummary:()=>[],app:{get:(path,handler)=>handlers[path]=handler}};vm.createContext(ctx);
 const src=fs.readFileSync(require.resolve('../src/server'),'utf8');
 for(const [start,end]of [['app.get("/api/projects",',"app.get('/api/contacts/summary'"],['app.get("/api/projects/:id",','app.post("/api/projects/:id/favorite"']]){const a=src.indexOf(start);vm.runInContext(src.slice(a,src.indexOf(end,a)),ctx);}
 return async(path,query={},id)=>{let code=200,data;await handlers[path]({query,params:{id},user:{id:1}},{status(n){code=n;return this;},json(d){data=d;}});assert.equal(code,200,JSON.stringify(data));return data;};
}
const title='검증동 대형 호텔 신축사업',address='서울특별시 강남구 검증동 123-4',owner='검증개발 주식회사',region='서울특별시';
async function project(query,source,name=title,overrides={}){
 const r=await query(`INSERT INTO projects(source,name,owner,address,region,stage,building_type,external_id,permit_date,area_sqm) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'2026-01-10',$9) RETURNING id`,[source,name,overrides.owner??owner,overrides.address??address,overrides.region??region,source==='g2b_bid'?'BID':'PERMIT',overrides.trade||'숙박시설',overrides.external_id||null,source==='g2b_bid'?null:20000]);return r.rows[0].id;
}
async function group(query,overrides={}){return (await query('INSERT INTO project_groups(group_key,title,owner,region,location) VALUES($1,$2,$3,$4,$5) RETURNING id',[overrides.key||'main',title,overrides.owner??owner,overrides.region??region,overrides.address??address])).rows[0].id;}
test('each source record is searchable by its own filters; linked data enriches details',async()=>{
 const {db,query}=await database();try{
 const permit=await project(query,'arch_hub_permit'),g=await group(query),a=await project(query,'g2b_bid',title+' 전기공사',{trade:'전기',external_id:'R001-000'}),b=await project(query,'g2b_bid',title+' 통신공사',{trade:'통신'});
 const early=await project(query,'document_review','호텔 심의 안건'),other=await project(query,'g2b_bid','독립 공고');
 await query('UPDATE projects SET project_group_id=$1 WHERE id=ANY($2::bigint[])',[g,[a,b]]);
 const user=(await query("INSERT INTO users(email,password_hash) VALUES('fixture@example.invalid','fixture') RETURNING id")).rows[0].id;
 await query("INSERT INTO project_phase_links(early_id,permit_id,reason,reviewed_by) VALUES($1,$2,'원문 확인 완료 테스트',$3)",[early,permit,user]);
 await query("INSERT INTO project_contacts(project_id,role,organization,phone,source) VALUES($1,'client','통신 담당기관','02-1234-1234','g2b')",[b]);
 await query("INSERT INTO construction_awards(event_key,notice_no,notice_ord,classification_no,rebid_no,name,winner,source_url) VALUES('fixture','R001','000','1','0',$1,'낙찰 업체','https://www.g2b.go.kr/')",[title]);
 await query("INSERT INTO favorites(project_id,user_key) VALUES($1,'1')",[b]);await query("INSERT INTO sales_pipeline(project_id,user_key,status,note) VALUES($1,'1','CONTACTED','기존 공고 메모')",[b]);
 await query("INSERT INTO project_group_contacts(group_id,role,organization,phone,source) VALUES($1,'designer','그룹 설계사','02-9999-8888','manual')",[g]);
 const api=routes(query),all=await api('/api/projects');assert.equal(all.total,5);assert.equal(all.rows.length,5);
 const row=all.rows.find(r=>r.id===a);assert.equal(row.notice_count,2);assert.equal(row.trade_count,2);assert.equal(row.member_count,4);assert.equal(row.has_phone,true);assert.equal(row.contact_count,2);assert.equal(row.stage,'BID');assert.equal(row.estimated_cost,null);
 for(const filters of [{q:'통신공사',ids:[b]},{type:'통신',ids:[b]},{q:'통신 담당기관',ids:[b]},{q:'그룹 설계사',ids:[a,b]},{contact:'designer',ids:[a,b]},{stage:'BID',ids:[a,b,other]},{stage:'REVIEW',ids:[early]}]){
 if(filters.stage==='REVIEW')await query("UPDATE projects SET stage='REVIEW' WHERE id=$1",[early]);
 const d=await api('/api/projects',filters);for(const id of filters.ids)assert(d.rows.some(r=>r.id===id),JSON.stringify(filters));
 }
 const first=await api('/api/projects',{limit:'1',page:'1'}),second=await api('/api/projects',{limit:'1',page:'2'});assert.equal(first.pages,5);assert.notEqual(first.rows[0].id,second.rows[0].id);
 const detail=await api('/api/projects/:id',{},permit);assert.equal(detail.relatedNotices.length,2);assert.equal(detail.awards.length,1);assert(detail.contacts.some(c=>c.organization==='통신 담당기관'));assert.equal(detail.phaseProjects.length,2);
 const child=await api('/api/projects/:id',{},b);assert.equal(child.masterProjectId,permit);assert.equal(child.favorite,true);assert.equal(child.pipeline.note,'기존 공고 메모');
 const summary=await unified.unificationSummary(query);assert.deepEqual(summary,{source_records:5,project_rows:2,combined_projects:1,exact_permit_bid_groups:1,confirmed_phase_links:1});
 assert.equal((await query('SELECT COUNT(*)::int n FROM projects')).rows[0].n,5);assert.equal((await query('SELECT COUNT(*)::int n FROM favorites')).rows[0].n,1);
 }finally{await db.close();}
});
test('ambiguous permits, different owner/address/region, and province-only location never cross-merge',async()=>{
 const {db,query}=await database();try{
 const g=await group(query),a=await project(query,'g2b_bid',title+' 전기공사');await query('UPDATE projects SET project_group_id=$1 WHERE id=$2',[g,a]);
 const p=await project(query,'arch_hub_permit'),duplicate=await project(query,'arch_hub_permit');
 assert.equal((await unified.unificationSummary(query)).exact_permit_bid_groups,0);
 await query('DELETE FROM projects WHERE id=$1',[duplicate]);assert.equal((await unified.unificationSummary(query)).exact_permit_bid_groups,1);
 for(const [field,value]of [['owner','다른 개발사'],['address',address+' 별도 필지'],['region','경기도']]){
 await query(`UPDATE projects SET ${field}=$1 WHERE id=$2`,[value,p]);assert.equal((await unified.unificationSummary(query)).exact_permit_bid_groups,0);
 await query(`UPDATE projects SET ${field}=$1 WHERE id=$2`,[{owner,address,region}[field],p]);
 }
 await query('UPDATE projects SET address=$1 WHERE id=$2',[region,p]);await query('UPDATE project_groups SET location=$1 WHERE id=$2',[region,g]);assert.equal((await unified.unificationSummary(query)).exact_permit_bid_groups,0);
 const ids=await unified.relatedProjects(query,a);assert.deepEqual(ids.ids,[String(a)]);
 }finally{await db.close();}
});
test('bid group rows remain separate results and retain group context',async()=>{
 const {db,query}=await database();try{
 const g=await group(query),a=await project(query,'g2b_bid',title+' 전기공사'),b=await project(query,'g2b_bid',title+' 소방공사');await query('UPDATE projects SET project_group_id=$1,updated_at=$2 WHERE id=ANY($3::bigint[])',[g,'2026-01-01',[a,b]]);
 const other=await project(query,'g2b_bid','독립 공고');await query("UPDATE projects SET updated_at='2026-02-01' WHERE id=$1",[other]);await query("UPDATE projects SET updated_at='2026-03-01' WHERE id=$1",[b]);
 const d=await routes(query)('/api/projects',{sort:'recent'});assert.equal(d.total,3);assert.deepEqual(d.rows.map(r=>r.id).sort((x,y)=>x-y),[a,b,other].sort((x,y)=>x-y));for(const row of d.rows.filter(r=>r.id===a||r.id===b)){assert.equal(row.name,title);assert.equal(row.notice_count,2);}
 }finally{await db.close();}
});
