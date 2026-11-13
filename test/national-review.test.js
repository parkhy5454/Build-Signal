const {test}=require('node:test'),assert=require('node:assert/strict');
const {STREAMS,listUrl,detailUrl,embeddedResult,parseIndex,parseDetail,isReview,officialSource,createNationalReviewCollector}=require('../src/national-review');
const title='2026년 제1회 건축위원회 심의 주요 결과',id='CLIKC1793267176008506';
const record={id,title,publisher:'검증시청',publishedDate:'2026-11-01'};
function index({stream='all',page=1,total=1,ids=[id],heading=title,publisher='검증시청'}={}){
 const data=[{collection:'policyinfo',total:String(total),cnList:{cnList:ids.join(', ')},list:ids.map((doc,i)=>({row:'<li><dl><dt><b class="ml15">'+((page-1)*10+i+1)+'.</b><a onclick=\'fn_detailView("/potal/search/searchView.do?collection=policyinfo&DOCID='+doc+'")\'>'+heading+'</a></dt><dd><b>[정책/매뉴얼/업무자료]</b>'+publisher+' | 행정담당 | 2026-11-01</dd><dd>행정담당 전화 02-111-2222</dd></dl></li>'}))}];
 return '<input id="sSearch_keyword" value="건축위원회"><input id="sPageIndex" value="'+page+'"><input id="sCollection" value="policyinfo"><input id="sSearchGubun" value="pi"><input name="piSearch" value="'+(stream==='all'?'':'PQ@@REGION@@'+stream)+'"><script>var result = eval('+JSON.stringify(data)+');</script>';
}
function detail(r=record,url='https://www.jeju.go.kr/news/news/news.htm?act=view&seq=2039769'){
 return '<input id="dataInfo" value="'+r.id+'┼policyinfo┼200"><span id="contentSj">'+r.title+'</span><table class="boardview">'+[['제어번호',r.id],['수집사이트명',r.publisher],['게시일',r.publishedDate],['원문URL','<a class="content_url" href="'+url+'">공식 출처</a>'],['내용','담당자 전화 02-111-2222 admin@example.go.kr']].map(([k,v])=>'<tr><th>'+k+'</th><td>'+v+'</td></tr>').join('')+'</table>';
}
test('every public source region filter including legacy and unclassified is registered',()=>{
 assert.equal(STREAMS.length,19);assert.equal(new Set(STREAMS.map(s=>s.id)).size,19);
 for(const s of STREAMS){const u=new URL(listUrl(s.id,2));assert.equal(u.searchParams.get('searchGubun'),'pi');assert.equal(u.searchParams.get('pageIndex'),'2');assert.equal(u.searchParams.get('piSearch'),s.id==='all'?null:'PQ@@REGION@@'+s.id);}
 assert.throws(()=>listUrl('localhost'));assert.throws(()=>detailUrl('not-an-id'));
});
test('JSON is decoded without evaluating source scripts; ignored regional filters and missing pages fail closed',()=>{
 const html=index();assert.equal(embeddedResult(html)[0].collection,'policyinfo');assert.equal(parseIndex(html,'all').records.length,1);
 assert.throws(()=>parseIndex(html,'002'),/지역/);assert.throws(()=>parseIndex(index({stream:'002'}),'all'),/지역/);
 assert.throws(()=>parseIndex(html,'all',2),/지역/);assert.throws(()=>parseIndex(index({total:12}),'all'),/누락/);
 assert.throws(()=>parseIndex(index({ids:[id,id],total:2}),'all'),/중복/);
 assert.throws(()=>embeddedResult('<script>var result=eval(globalThis.compromised=true);</script>'),/형식/);assert.equal(globalThis.compromised,undefined);
 assert.equal(parseIndex(index({total:0,ids:[]}),'all').total,0);
});
test('only review result notices are stored; publisher and publication date never become project parties or event dates',()=>{
 assert(isReview(title));assert(!isReview('건축위원회 위원 공개모집'));assert(!isReview('제269회 행정위원회 결과'));
 const r=parseIndex(index(),'all').records[0];assert.equal(r.publisher,'검증시청');assert.equal(r.publisherRegion,null);assert(!r.owner);assert(!r.parties);assert(!r.review_date);assert(!JSON.stringify(r).includes('02-111-2222'));
 assert.equal(parseIndex(index({heading:'건축위원회 위원 모집'}),'all').records.length,0);
 const d=parseDetail(detail(),record);assert(d.originalUrl.includes('jeju.go.kr'));assert(!JSON.stringify(d).includes('admin@example.go.kr'));
 assert.throws(()=>parseDetail(detail({...record,id:'CLIKC1793267176008507'}),record),/식별/);
 assert.throws(()=>parseDetail(detail(record,'https://evil.example/data'),record),/링크/);
 for(const url of ['file:///etc/passwd','https://www.jeju.go.kr.evil.example/x','https://a:b@www.jeju.go.kr/x','javascript:alert(1)'])assert.equal(officialSource(url),null);
});
test('disabled or leased national collector performs no network requests',async()=>{
 let n=0;await createNationalReviewCollector({env:{AUTO_INGEST_ENABLED:'false'},query:async()=>{n++;}}).run();assert.equal(n,0);
 await createNationalReviewCollector({query:async()=>({rows:[]}),load:async()=>{n++;}}).run();assert.equal(n,0);
});
test('PostgreSQL worker rotates nationwide, isolates one failed filter, resumes archives and respects daily budget',async()=>{
 const {PGlite}=require('@electric-sql/pglite'),fs=require('node:fs'),vm=require('node:vm');const db=new PGlite();await db.waitReady;
 try{
  const query=async(sql,args=[])=>args.length?db.query(sql,args):(await db.exec(sql)).at(-1)||{rows:[]};const src=fs.readFileSync(require.resolve('../src/db'),'utf8'),ctx={query};vm.createContext(ctx);vm.runInContext(src.slice(src.indexOf('async function initDb'),src.indexOf('async function transaction')),ctx);await ctx.initDb();
  let failRegion=true,requests=0;const visited=new Set();
  const transaction=async fn=>{await db.exec('BEGIN');try{await fn(query);await db.exec('COMMIT');}catch(e){await db.exec('ROLLBACK');throw e;}};
  const load=async url=>{requests++;const u=new URL(url);if(u.pathname.endsWith('searchView.do'))return detail();
   const stream=u.searchParams.get('piSearch')?.split('@@').at(-1)||'all',page=Number(u.searchParams.get('pageIndex'));visited.add(stream);
   if(stream==='002'&&failRegion)throw Error('one regional source offline');return index({stream,page,total:page===1?1:0,ids:page===1?[id]:[]});};
  const run=async()=>{await query("UPDATE auto_ingest_state SET next_due_at=NOW() WHERE source='national_review'");await createNationalReviewCollector({query,transaction,load,env:{}}).run();};
  for(let i=0;i<6;i++)await run();assert.equal(visited.size,19);assert.equal((await query('SELECT COUNT(*)::int n FROM national_review_streams WHERE last_success_at IS NOT NULL')).rows[0].n,18);
  assert.equal((await query('SELECT COUNT(*)::int n FROM national_review_notices')).rows[0].n,1);assert.equal((await query('SELECT COUNT(*)::int n FROM projects')).rows[0].n,0);assert.equal((await query('SELECT COUNT(*)::int n FROM project_party_evidence')).rows[0].n,0);
  assert.equal((await query('SELECT status,original_url FROM national_review_notices')).rows[0].status,'checked');
  const server=fs.readFileSync(require.resolve('../src/server'),'utf8'),routeStart=server.indexOf("app.get('/api/review-notices',"),routeEnd=server.indexOf("app.get('/api/ingestion/freshness'",routeStart),handlers={};
  const routes={app:{get:(url,fn)=>{handlers[url]=fn;}},query,regionAliases:require('../src/region-catalog').regionAliases,reviewStreams:STREAMS};vm.createContext(routes);vm.runInContext(server.slice(routeStart,routeEnd),routes);
  let status=200,body;const response={status(n){status=n;return this;},json(v){body=v;}};
  await handlers['/api/review-notices']({query:{region:'경기도',q:'건축'}},response);assert.equal(status,200);assert.equal(body.total,1);assert(body.rows[0].publisher_region.includes('경기도'));
  await handlers['/api/review-notices']({query:{q:"' OR TRUE --"}},response);assert.equal(body.total,0);
  await handlers['/api/review-notices/coverage']({},response);assert.equal(body.streams.length,19);assert(body.counts.length>0);
  failRegion=false;await query("UPDATE national_review_streams SET retry_at=NOW() WHERE id='002'");await run();assert.equal((await query("SELECT last_error FROM national_review_streams WHERE id='002'")).rows[0].last_error,null);
  await query('UPDATE national_review_streams SET next_archive_at=NOW()');const before=(await query('SELECT id,archive_page FROM national_review_streams ORDER BY id')).rows;
  await query("UPDATE auto_ingest_state SET daily_calls=300,call_day=(NOW() AT TIME ZONE 'Asia/Seoul')::date WHERE source='national_review'");const old=requests;await run();assert.equal(requests,old);assert.deepEqual((await query('SELECT id,archive_page FROM national_review_streams ORDER BY id')).rows,before);
 }finally{await db.close();}
});
test('public transport stays on official search paths and limits response size',async()=>{
 const {download}=require('../src/national-review'),saved=global.fetch;let calls=0;
 try{
  global.fetch=async(url,opts)=>{calls++;assert.equal(opts.redirect,'error');return new Response('ok');};
  await assert.rejects(()=>download('https://evil.example/potal/search/searchList.do?collection=policyinfo'),/출처/);assert.equal(calls,0);
  assert.equal(await download(listUrl('all')),'ok');global.fetch=async()=>new Response('x'.repeat(2*1024*1024+1));await assert.rejects(()=>download(listUrl('all')),/2MB/);
 }finally{global.fetch=saved;}
});
