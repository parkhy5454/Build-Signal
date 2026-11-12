const {test}=require('node:test'),assert=require('node:assert/strict');
const {FEEDS,parseList,parseDetail,explicitLocation,saveRecord,createEnvironmentCollector}=require('../src/environment-review');
function list({total=1,page=1,names=['검증 복합시설 조성사업'],duplicate=false}={}){
 return '<div class="tbl01_wrap"><span>검색결과 : '+total+'건</span><table><caption>평가항목 결정내용 공람 게시글 리스트 - 번호, 협의기관, 사업명, 공람기관 정보를 제공하는 표</caption><thead><tr>'+['번호','협의기관','사업명','공람기간'].map(t=>'<th>'+t+'</th>').join('')+'</tr></thead><tbody>'+names.map((name,i)=>'<tr><td>1</td><td>검증 협의기관</td><td><a href="javascript:view(\'RE2026'+String(duplicate?1:(page-1)*10+i+1).padStart(4,'0')+'\', \'1\')">'+name+'</a></td><td>2026.11.01~2026.11.20</td></tr>').join('')+'</tbody></table><ul class="paging"><li class="on"><a>'+page+'</a></li></ul></div>';
}
function detail({code='RE20260001',name='검증 복합시설 조성사업',developer='검증 시행사',location='경기도 화성시 시험읍 시험리 1',date='2026.11.01'}={}){
 return '<input name="BIZ_CD" value="'+code+'"><input name="BIZ_SEQ" value="1"><table><caption>협의진행현황 사업명 - 사업명 ,사업시행자 ,협의기관 ,승인기관 ,결정내용 ,결정내용파일의 정보를 제공하는 표</caption><tbody>'+[['사업명',name],['사업시행자',developer],['협의기관','서울 소재 검증 행정기관'],['승인기관','검증 승인기관'],['결정내용','<div>위 치 : '+location+'\n다. 규 모 : 10000㎡\n담당자: 행정담당 02-123-4567 office@example.go.kr</div>']].map(([k,v])=>'<tr><th><span>*</span> '+k+'</th><td>'+v+'</td></tr>').join('')+'</tbody></table><table><caption>결정내용공개 - 공고일 ,공람기간 ,의견제출기간 ,부서명의 정보를 제공하는 표</caption><tbody><tr><th>* 공고일</th><td>'+date+'</td></tr><tr><th>* 공람기간</th><td>2026.11.01~2026.11.20</td></tr></tbody></table>';
}
const entry={code:'RE20260001',sequence:'1',name:'검증 복합시설 조성사업',period:'2026.11.01~2026.11.20'};
test('official metadata supplies developer identity without copying administrative contact or approval stage',()=>{
 const r=parseDetail(detail(),entry,FEEDS[0]);assert.equal(r.parties[0].role,'developer');assert.equal(r.parties[0].organization,'검증 시행사');assert.equal(r.date,'2026-11-01');assert.equal(r.region,'경기도');
 assert(!JSON.stringify(r).includes('02-123-4567'));assert(!JSON.stringify(r).includes('office@example.go.kr'));assert(!r.permit_date);assert(!r.start_date);assert(!r.parties[0].organization_address);
 assert(r.url.includes('BIZ_CD=RE20260001'));assert(r.buildingType.includes('환경영향평가'));
});
test('unknown or ambiguous site locations cannot be inferred from project name, agency or developer',()=>{
 assert.equal(explicitLocation('위치 및 규모 : 강원도 동해시 망상동 일원').region,'강원특별자치도');
 assert.equal(explicitLocation('위치 : 서산시 관내').region,'충청남도');
 assert.deepEqual(explicitLocation('위치 : 경기도 화성시 시험리, 서울특별시 중구 시험동'),{address:null,region:null});
 assert.deepEqual(explicitLocation('위치 : 고성군 시험리'),{address:null,region:null});
 assert.deepEqual(explicitLocation('위치 : 아직 확인 중'),{address:null,region:null});
 assert.deepEqual(explicitLocation('위치 : 경기도 화성시 시험리\n위치 : 서울특별시 중구 시험동'),{address:null,region:null});
 const r=parseDetail(detail({location:'미공개'}),entry,FEEDS[1]);assert.equal(r.region,null);assert.equal(r.address,null);assert(r.buildingType.includes('전략환경영향평가'));
 assert.equal(parseDetail(detail({developer:''}),entry,FEEDS[0]).parties.length,0);
});
test('list and detail validation rejects shifted columns, wrong business identity, date and pagination',()=>{
 assert.equal(parseList(list(),1).total,1);assert.throws(()=>parseList(list({page:2}),1),/페이지/);
 assert.throws(()=>parseList(list().replace('협의기관</th>','시행사</th>'),1),/표 형식/);
 assert.equal(parseList(list({total:0,names:[]}),1).rows.length,0);
 assert.throws(()=>parseDetail(detail({code:'RE20260002'}),entry,FEEDS[0]),/사업코드/);
 assert.throws(()=>parseDetail(detail({name:'다른 사업'}),entry,FEEDS[0]),/사업명/);
 assert.throws(()=>parseDetail(detail({date:'2026.02.30'}),entry,FEEDS[0]),/공고일/);
});
test('public collector is disabled or lease protected without making external requests',async()=>{
 let requests=0;const download=async()=>{requests++;return list();};
 await createEnvironmentCollector({query:async()=>({rows:[]}),transaction:async()=>{},download}).run();assert.equal(requests,0);
 let calls=0;await createEnvironmentCollector({env:{AUTO_INGEST_ENABLED:'false'},query:async()=>{calls++;},transaction:async()=>{},download}).run();assert.equal(calls,0);
});
test('bad list pagination never reaches project writes while another national feed continues',async()=>{
 let transactions=0;const messages=[];
 const query=async(sql,args)=>{messages.push({sql,args});return {rows:[{}]};};
 const download=async url=>url.includes('resultEiassListData')?list({total:11}):list({total:0,names:[]});
 await createEnvironmentCollector({query,transaction:async()=>{transactions++;},download}).run();
 assert.equal(transactions,0);assert(messages.some(m=>m.sql.includes('INSERT INTO early_source_documents')&&m.args[0].includes('ListData')));
 const release=messages.find(m=>m.sql.includes('last_success_at=CASE'));assert.equal(release.args[1],1);assert(release.args[2].includes('처리 실패'));
});
test('expired ownership never permits project or evidence updates',async()=>{
 let writes=0;await assert.rejects(()=>saveRecord(async fn=>fn(async sql=>{if(sql.startsWith('SELECT source'))return {rows:[]};writes++;return {rows:[]};}),parseDetail(detail(),entry,FEEDS[0]),'expired'),/실행권/);assert.equal(writes,0);
});
test('PostgreSQL worker persists one sourced project, deduplicates unchanged facts and rolls back failed evidence writes',async()=>{
 const {PGlite}=require('@electric-sql/pglite'),fs=require('node:fs'),vm=require('node:vm');const db=new PGlite();await db.waitReady;
 try{
  const query=async(sql,args=[])=>args.length?db.query(sql,args):(await db.exec(sql)).at(-1)||{rows:[]};
  const dbSource=fs.readFileSync(require.resolve('../src/db'),'utf8');const ctx={query};vm.createContext(ctx);vm.runInContext(dbSource.slice(dbSource.indexOf('async function initDb'),dbSource.indexOf('async function transaction')),ctx);await ctx.initDb();
  let developer='검증 시행사',failEvidence=false;
  const tx=async fn=>{await db.exec('BEGIN');try{await fn(async(sql,args)=>{if(failEvidence&&sql.includes('INSERT INTO project_party_evidence'))throw Error('test evidence failure');return query(sql,args);});await db.exec('COMMIT');}catch(e){await db.exec('ROLLBACK');throw e;}};
  const download=async url=>url.includes('resultSperssListData')?list({total:0,names:[]}):url.includes('ListData')?list():detail({developer});
  const worker=createEnvironmentCollector({query,transaction:tx,env:{},download});
  async function collect(){await query("UPDATE auto_ingest_state SET next_due_at=NOW() WHERE source='environment_review'");await worker.run();}
  await collect();let rows=(await query("SELECT * FROM projects WHERE source='environment_review'")).rows;assert.equal(rows.length,1);assert.equal(rows[0].stage,'REVIEW');assert.equal(rows[0].owner,null);assert.equal(rows[0].permit_date,null);
  const id=rows[0].id,updated=String(rows[0].updated_at);await collect();assert.equal(String((await query('SELECT updated_at FROM projects WHERE id=$1',[id])).rows[0].updated_at),updated);
  assert.equal((await query('SELECT COUNT(*)::int AS n FROM project_party_evidence')).rows[0].n,1);
  developer='변경된 검증 시행사';await collect();assert.equal((await query('SELECT COUNT(*)::int AS n FROM project_party_evidence')).rows[0].n,2);
  assert.equal((await query('SELECT COUNT(*)::int AS n FROM projects')).rows[0].n,1);
  assert.equal((await query('SELECT COUNT(*)::int AS n FROM project_party_evidence WHERE phone IS NOT NULL OR email IS NOT NULL')).rows[0].n,0);
  failEvidence=true;developer='저장 실패할 시행사';await collect();assert.equal((await query('SELECT COUNT(*)::int AS n FROM project_party_evidence')).rows[0].n,2);
  assert.equal((await query('SELECT COUNT(*)::int AS n FROM environment_review_details')).rows[0].n,1);
  assert((await query("SELECT last_error FROM auto_ingest_state WHERE source='environment_review'")).rows[0].last_error);
 }finally{await db.close();}
});
