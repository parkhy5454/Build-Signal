const {test}=require('node:test'),assert=require('node:assert/strict');
const x=require('../src/review-extraction');
const page='https://www.incheon.go.kr/build/BU050101/3087673';
const file='https://www.incheon.go.kr/comm/getFile?srvcId=BBSTY1&upperNo=3087673&fileTy=ATTACH&fileNo=1';
const board='<a href="/build/BU050101/3087673">2026년 제3회 건축경관공동위원회 심의결과</a>';
function article(id='3087673',name='심의결과.pdf'){return '<div class="file-preview-down-group"><span class="file-name">'+name+'</span><a href="/comm/getFile?srvcId=BBSTY1&upperNo='+id+'&fileTy=ATTACH&fileNo=1">다운로드</a></div><a href="/comm/getFile?srvcId=BBSTY1&upperNo=999&fileTy=ATTACH&fileNo=1">관련 게시물</a>';}
function agenda({number=1,owner='검증 건축주 주식회사',date='2026. 9. 8.',address='인천광역시 미추홀구 시험동\n1번지 외 2필지'}={}){return '['+number+'호 안건: 검증 복합시설 신축]\n운영기관 인천광역시 건축과 심의일자 '+date+'\n건축주 성명(법인명) '+owner+'\n대지현황\n'+address+' 관련지번\n주용도 공동주택(아파트)\n근린생활시설 구조 철근콘크리트\n연면적 합계 43,034.07㎡\n심의내용\n설계자: 본문 일반 지침 회사\n행정담당: 032-123-4567 admin@example.go.kr\n심의결과\n[ ] 원안 의결 [ ○ ] 조건부 의결 [ ] 재검토 의결 [ ] 부결\n※ 작성기준\n설계자는 반영할 것\n';}
const text=()=> '2026년 제3회 건축경관공동위원회 심의 결과\n'+agenda();
test('discovery only queues official same-post attachments, not related articles or arbitrary URLs',()=>{
 assert.equal(x.discoverArticles(board).length,1);assert.equal(x.discoverFiles(article(),page).length,1);
 assert.throws(()=>x.discoverFiles(article('999'),page),/불일치/);assert.throws(()=>x.discoverFiles(article(),'https://evil.example/a'),/출처/);
 assert.equal(x.articleUrl('https://www.incheon.go.kr.evil.example/build/BU050101/3087673'),null);
 assert.equal(x.discoverFiles(article('3087673','심의결과.hwpx'),page)[0].format,'hangul');
});
test('verified PDF extracts explicit owner, site, actual review date and selected decision without inventing other parties or contacts',()=>{
 const r=x.parseIncheon(text())[0];assert.equal(r.name,'검증 복합시설 신축');assert.equal(r.address,'인천광역시 미추홀구 시험동 1번지 외 2필지');assert.equal(r.date,'2026-09-08');assert.equal(r.area,43034.07);assert.equal(r.result,'조건부 의결');assert.equal(r.parties[0].role,'owner');assert.equal(r.parties[0].organization,'검증 건축주 주식회사');
 assert.equal(r.parties.length,1);assert(!JSON.stringify(r).includes('032-123-4567'));assert(!JSON.stringify(r).includes('admin@example.go.kr'));assert(!JSON.stringify(r).includes('본문 일반 지침 회사'));assert(!r.permit_date);
 assert.equal(x.parseIncheon('2026년 제3회 건축경관공동위원회 심의 결과\n'+agenda({owner:'김○○'}))[0].parties.length,0);
});
test('case boundaries prevent cross-project owner transfer; ambiguous, invalid or unsupported PDFs fail closed',()=>{
 const rows=x.parseIncheon(text()+agenda({number:2,owner:'두번째 건축주'}));assert.equal(rows.length,2);assert.equal(rows[1].parties[0].organization,'두번째 건축주');assert.notEqual(rows[0].key,rows[1].key);
 assert.throws(()=>x.parseIncheon(text()+agenda()),/중복/);
 assert.throws(()=>x.parseIncheon(text(),'2025년 제1회 심의.pdf'),/불일치/);
 assert.throws(()=>x.parseIncheon(text().replace('2026. 9. 8.','2026. 2. 30.')),/심의일/);
 assert.throws(()=>x.parseIncheon(text().replace('[ ] 부결','[ ○ ] 부결')),/의결 결과/);
 assert.throws(()=>x.parseIncheon('구조·해체안전 전문위원회 심의 결과\n건축주 미제공'),/서식/);
 assert.throws(()=>x.parseIncheon(text().replace('심의내용','다른 표')),/경계/);
});
test('disabled, leased and expired extraction jobs do not request or save data',async()=>{
 let calls=0;await x.createReviewExtractor({env:{AUTO_INGEST_ENABLED:'false'},query:async()=>{calls++;}}).run();assert.equal(calls,0);
 await x.createReviewExtractor({query:async()=>({rows:[]}),load:async()=>{calls++;}}).run();assert.equal(calls,0);
 await assert.rejects(()=>x.saveExtracted(async fn=>fn(async()=>({rows:[]})),{url:file},Buffer.from('pdf'),[],'expired'),/실行권|실행권/);
 await assert.rejects(()=>x.extractPdf(Buffer.from('not PDF')),/PDF 응답/);
});
test('PostgreSQL persists sourced project and immutable owner evidence, deduplicates and rolls back failed writes',async()=>{
 const {PGlite}=require('@electric-sql/pglite'),fs=require('node:fs'),vm=require('node:vm');const db=new PGlite();await db.waitReady;
 try{
  const query=async(sql,args=[])=>args.length?db.query(sql,args):(await db.exec(sql)).at(-1)||{rows:[]};const src=fs.readFileSync(require.resolve('../src/db'),'utf8'),ctx={query};vm.createContext(ctx);vm.runInContext(src.slice(src.indexOf('async function initDb'),src.indexOf('async function transaction')),ctx);await ctx.initDb();
  let fail=false,content=text(),bytes='pdf-v1',requests=0;
  const transaction=async fn=>{await db.exec('BEGIN');try{await fn(async(sql,args)=>{if(fail&&sql.includes('INSERT INTO project_party_evidence'))throw Error('evidence write failed');return query(sql,args);});await db.exec('COMMIT');}catch(e){await db.exec('ROLLBACK');throw e;}};
  const load=async url=>{requests++;return Buffer.from(url===x.BOARD?board:url===page?article():bytes);};
  const run=async()=>{await query("UPDATE auto_ingest_state SET next_due_at=NOW() WHERE source='review_extract'");await x.createReviewExtractor({query,transaction,load,pdfText:async()=>content,env:{}}).run();};
  await run();let p=(await query('SELECT * FROM projects')).rows;assert.equal(p.length,1);assert.equal(p[0].source,'document_review');assert.equal(p[0].stage,'REVIEW');assert.equal(p[0].owner,null);assert.equal(p[0].permit_date,null);const updated=String(p[0].updated_at);
  let e=(await query('SELECT * FROM project_party_evidence')).rows;assert.equal(e.length,1);assert.equal(e[0].role,'owner');assert.equal(e[0].source_url,file);assert.equal(e[0].phone,null);assert.equal(e[0].email,null);
  await query('UPDATE review_extract_files SET next_due_at=NOW()');await run();assert.equal(String((await query('SELECT updated_at FROM projects')).rows[0].updated_at),updated);assert.equal((await query('SELECT COUNT(*)::int n FROM project_party_evidence')).rows[0].n,1);
  bytes='pdf-v2';content=text().replace('검증 건축주 주식회사','변경 건축주');fail=true;await query('UPDATE review_extract_files SET next_due_at=NOW()');await run();assert.equal((await query('SELECT COUNT(*)::int n FROM project_party_evidence')).rows[0].n,1);assert.equal((await query('SELECT content_hash FROM review_extract_files')).rows[0].content_hash,require('node:crypto').createHash('sha256').update('pdf-v1').digest('hex'));
  fail=false;await query('UPDATE review_extract_files SET next_due_at=NOW()');await run();assert.equal((await query('SELECT COUNT(*)::int n FROM project_party_evidence')).rows[0].n,2);assert.equal((await query('SELECT COUNT(*)::int n FROM projects')).rows[0].n,1);
  bytes='pdf-v3';content+=agenda({number:2,owner:'별도 안건 법인'});await query('UPDATE review_extract_files SET next_due_at=NOW()');await run();assert.equal((await query('SELECT COUNT(*)::int n FROM projects')).rows[0].n,2);
  bytes='pdf-v4';content=text().replace('검증 건축주 주식회사','변경 건축주');await query('UPDATE review_extract_files SET next_due_at=NOW()');await run();assert.equal((await query('SELECT COUNT(*)::int n FROM review_extracted_projects WHERE is_current')).rows[0].n,1);assert.equal((await query('SELECT COUNT(*)::int n FROM review_extracted_projects WHERE NOT is_current')).rows[0].n,1);
  const server=fs.readFileSync(require.resolve('../src/server'),'utf8'),start=server.indexOf("app.get('/api/review-extraction',"),end=server.indexOf("app.get('/api/ingestion/freshness'",start);let handler;const c={app:{get:(_,fn)=>{handler=fn;}},query};vm.createContext(c);vm.runInContext(server.slice(start,end),c);let status=200,body;await handler({}, {status(n){status=n;return this;},json(v){body=v;}});assert.equal(status,200);assert.equal(body.files[0].projects.length,1);assert.equal(body.files[0].status,'extracted');
  await query("INSERT INTO national_review_notices(doc_id,title,publisher,published_date,index_url,original_url,status) VALUES('CLIKC1793267176008506','검증 문서','검증시청','2026-11-01','https://clik.nanet.go.kr/potal/search/searchView.do?collection=policyinfo&DOCID=CLIKC1793267176008506',$1,'checked')",[page]);
  const routeStart=server.indexOf("app.get('/api/review-notices',"),routeEnd=server.indexOf("app.get('/api/review-notices/coverage'",routeStart);let noticeHandler;const noticeCtx={app:{get:(_,fn)=>{noticeHandler=fn;}},query,regionAliases:require('../src/region-catalog').regionAliases};vm.createContext(noticeCtx);vm.runInContext(server.slice(routeStart,routeEnd),noticeCtx);
  await noticeHandler({query:{}},{status(n){status=n;return this;},json(v){body=v;}});assert.equal(status,200);assert.equal(body.rows[0].extracted_projects.length,1);
  await query("UPDATE auto_ingest_state SET daily_calls=100,call_day=(NOW() AT TIME ZONE 'Asia/Seoul')::date WHERE source='review_extract'");await query('UPDATE review_extract_files SET next_due_at=NOW()');const before=requests;await run();assert.equal(requests,before);assert.equal((await query('SELECT COUNT(*)::int n FROM projects')).rows[0].n,2);
 }finally{await db.close();}
});
test('an oversized PDF is recorded as unsupported and does not block the next document',async()=>{
 const writes=[],other=file.replace('fileNo=1','fileNo=2');const query=async(sql,args)=>{
  writes.push({sql,args});if(sql.startsWith('SELECT next_discovery_at'))return {rows:[{due:false}]};if(sql.startsWith('SELECT original_url')||sql.startsWith('SELECT * FROM review_extract_pages'))return {rows:[]};
  if(sql.startsWith('SELECT * FROM review_extract_files'))return {rows:[{url:file,page_url:page,name:'1.pdf'},{url:other,page_url:page,name:'2.pdf'}]};
  if(sql.startsWith('SELECT content_hash'))return {rows:[]};if(sql.includes('INSERT INTO projects'))return {rows:[{id:1}]};return {rows:[{}]};
 };
 await x.createReviewExtractor({query,transaction:async fn=>fn(query),env:{},load:async url=>Buffer.from(url===file?'oversized':'good'),pdfText:async b=>{if(b.toString()==='oversized')throw Error('심의 PDF 60페이지 처리 한도');return text();}}).run();
 assert(writes.some(w=>w.sql.startsWith('UPDATE review_extract_files SET status=$2')&&w.args[0]===file&&w.args[1]==='unsupported'));
 assert(writes.some(w=>w.sql.startsWith("UPDATE review_extract_files SET status='extracted'")&&w.args[0]===other));
});
