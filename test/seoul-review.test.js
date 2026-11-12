const {test}=require('node:test'),assert=require('node:assert/strict');
const {parsePage,listPosts,postFiles,parseDecision,saveDecision,createSeoulCollector}=require('../src/seoul-review');
const fixture=(id=1)=>({bbsTypeVO:{bbsNo:14637,nttNo:id,secretAt:'N',deleteAt:'N',bbsFileList:[{bbsNo:14637,upperNo:id,srvcId:'BBSTY1',fileTy:'ATTACH',fileNo:1,fileSize:500,useAt:'Y',orginlFileNm:'심의의결조서(검증 사업).pdf',fileExtsn:'pdf',streFileNm:'a.pdf',creatDttm:'20261101'}]},bbsSettingVO:{nmbrAuthor:['_view','_dwld']}});
const list=()=>({listAuthorCheck:true,bbsSettingVO:{bbsNo:14637},listVO:{curPage:1,totalCount:2,totalPage:1,cntPerPage:10,listObject:[{bbsNo:14637,nttNo:1,secretAt:'N'},{bbsNo:14637,nttNo:2,secretAt:'N'}]}});
const text=(no='2026-19-1')=>'건축위원회\t심의의결조서\n심의일시/장소\t2026.10.27.(화) 서울시청\n사 업 명\t검증 사업\n신청위치\t서초구 잠원동 157번지\n의결번호\t'+no+'\t심의결과\t보류 의결\n[심의 내용]\t건축+경관\n건축주 및 감리자는 관련 규정을 준수\n문의: 행정담당 02-111-2222';
test('public board, download rights and attachment identity are mandatory',()=>{
 assert.deepEqual(listPosts(list()),[1,2]);assert.equal(postFiles(fixture(),1).length,1);
 const privatePost=fixture();privatePost.bbsTypeVO.secretAt='Y';assert.throws(()=>postFiles(privatePost,1),/권한/);
 const noRights=fixture();noRights.bbsSettingVO.nmbrAuthor=['_view'];assert.throws(()=>postFiles(noRights,1),/권한/);
 const swapped=fixture();swapped.bbsTypeVO.bbsFileList[0].upperNo=3;assert.throws(()=>postFiles(swapped,1),/식별/);
 assert.throws(()=>listPosts({...list(),listAuthorCheck:false}),/권한/);
});
test('repeated PDF headers yield facts without inventing permit completion, parties or administrative contact',()=>{
 const file=postFiles(fixture(),1)[0],r=parseDecision(text()+'\n'+text(),file);
 assert.equal(r.date,'2026-10-27');assert.equal(r.number,'2026-19-1');assert.equal(r.address,'서울특별시 서초구 잠원동 157번지');assert.equal(r.result,'보류 의결');
 assert(!JSON.stringify(r).includes('02-111-2222'));assert(!r.parties);assert(!r.owner);assert(!r.permit_date);
 assert.throws(()=>parseDecision(text()+'\n'+text('2026-19-2'),file),/복수/);
 assert.throws(()=>parseDecision(text().replace('2026.10.27.','2026.02.30.'),file),/심의일/);
 assert.throws(()=>parseDecision(text().replace('서초구','다른구'),file),/사업위치/);
 assert.throws(()=>parseDecision(text(),{...file,name:'심의의결조서(다른 사업).pdf'}),/불일치/);
});
test('disabled, leased or expired collectors cannot write facts',async()=>{
 let calls=0;await createSeoulCollector({env:{AUTO_INGEST_ENABLED:'false'},query:async()=>{calls++;}}).run();assert.equal(calls,0);
 await createSeoulCollector({query:async()=>({rows:[]}),load:async()=>{calls++;}}).run();assert.equal(calls,0);
 await assert.rejects(()=>saveDecision(async fn=>fn(async()=>({rows:[]})),{},'expired'),/실행권/);
});
test('PostgreSQL queue isolates bad PDF, deduplicates, survives restart and rolls back failed details',async()=>{
 const {PGlite}=require('@electric-sql/pglite'),fs=require('node:fs'),vm=require('node:vm');const db=new PGlite();await db.waitReady;
 try{
  const query=async(sql,args=[])=>args.length?db.query(sql,args):(await db.exec(sql)).at(-1)||{rows:[]};
  const src=fs.readFileSync(require.resolve('../src/db'),'utf8'),ctx={query};vm.createContext(ctx);vm.runInContext(src.slice(src.indexOf('async function initDb'),src.indexOf('async function transaction')),ctx);await ctx.initDb();
  let failDetails=false,pdfCalls=0;
  const transaction=async fn=>{await db.exec('BEGIN');try{await fn(async(sql,args)=>{if(failDetails&&sql.includes('INSERT INTO architectural_review_details'))throw Error('test rollback');return query(sql,args);});await db.exec('COMMIT');}catch(e){await db.exec('ROLLBACK');throw e;}};
  const load=async url=>{if(url.includes('/comm/')){pdfCalls++;return Buffer.from(url.includes('upperNo=2')?'bad':'good');}return Buffer.from(JSON.stringify(url.includes('/front/bbs.json')?list():fixture(Number(url.match(/front\/(\d+)/)[1]))));};
  const worker=()=>createSeoulCollector({query,transaction,load,pdfText:async bytes=>{if(bytes.toString()==='bad')throw Error('unsupported PDF');return text();},env:{}});
  await worker().run();const p=(await query('SELECT * FROM projects')).rows;assert.equal(p.length,1);assert.equal(p[0].stage,'REVIEW');assert.equal(p[0].owner,null);assert.equal(p[0].permit_date,null);
  assert.equal((await query('SELECT COUNT(*)::int n FROM project_party_evidence')).rows[0].n,0);
  assert.equal((await query("SELECT COUNT(*)::int n FROM seoul_review_files WHERE status='error'")).rows[0].n,1);
  const updated=String(p[0].updated_at);await query("UPDATE auto_ingest_state SET next_due_at=NOW() WHERE source='seoul_review'");await worker().run();assert.equal(pdfCalls,2);
  await query("UPDATE seoul_review_files SET next_due_at=NOW() WHERE status='processed'");await query("UPDATE auto_ingest_state SET next_due_at=NOW() WHERE source='seoul_review'");await worker().run();assert.equal(String((await query('SELECT updated_at FROM projects')).rows[0].updated_at),updated);
  failDetails=true;const record=parseDecision(text('2026-19-3'),postFiles(fixture(),1)[0]);await query("UPDATE auto_ingest_state SET lease_token='test',lease_until=NOW()+INTERVAL '1 minute' WHERE source='seoul_review'");await assert.rejects(()=>saveDecision(transaction,record,'test'),/rollback/);assert.equal((await query('SELECT COUNT(*)::int n FROM projects')).rows[0].n,1);
  await query("UPDATE auto_ingest_state SET lease_token=NULL,lease_until=NULL,next_due_at=NOW(),call_day=(NOW() AT TIME ZONE 'Asia/Seoul')::date,daily_calls=100 WHERE source='seoul_review'");await query('UPDATE seoul_review_files SET next_due_at=NOW()');const before=pdfCalls;await worker().run();assert.equal(pdfCalls,before);assert.equal((await query("SELECT COUNT(*)::int n FROM seoul_review_files WHERE next_due_at<=NOW()")).rows[0].n,2);
 }finally{await db.close();}
});
test('archive pagination validates counts, page identity, duplicate and truncated results',()=>{
 const page={...list(),listVO:{...list().listVO,totalCount:12,totalPage:2,curPage:2}};
 assert.equal(parsePage(page,2).pages,2);assert.throws(()=>parsePage(page,1),/페이지/);
 assert.throws(()=>parsePage({...page,listVO:{...page.listVO,totalCount:13}},2),/누락/);
 assert.throws(()=>parsePage({...page,listVO:{...page.listVO,listObject:[page.listVO.listObject[0],page.listVO.listObject[0]]}},2),/중복/);
 assert.throws(()=>parsePage({...page,listVO:{...page.listVO,totalPage:3}},2),/페이지/);
});
test('PostgreSQL archive checkpoint survives list failure, post retry, daily quota and restarts',async()=>{
 const {PGlite}=require('@electric-sql/pglite'),fs=require('node:fs'),vm=require('node:vm');const db=new PGlite();await db.waitReady;
 try{
  const query=async(sql,args=[])=>args.length?db.query(sql,args):(await db.exec(sql)).at(-1)||{rows:[]};
  const src=fs.readFileSync(require.resolve('../src/db'),'utf8'),ctx={query};vm.createContext(ctx);vm.runInContext(src.slice(src.indexOf('async function initDb'),src.indexOf('async function transaction')),ctx);await ctx.initDb();
  const transaction=async fn=>{await db.exec('BEGIN');try{await fn(query);await db.exec('COMMIT');}catch(e){await db.exec('ROLLBACK');throw e;}};
  let failPage3=true,failPost14=true,requests=0;
  const load=async url=>{requests++;const u=new URL(url);if(u.pathname==='/front/bbs.json'){
   const page=Number(u.searchParams.get('curPage'));if(page===3&&failPage3)throw Error('test list offline');
   const ids=Array.from({length:22},(_,i)=>30-i).slice((page-1)*10,page*10);
   return Buffer.from(JSON.stringify({listAuthorCheck:true,bbsSettingVO:{bbsNo:14637},listVO:{curPage:page,totalCount:22,totalPage:3,cntPerPage:10,listObject:ids.map(nttNo=>({nttNo,bbsNo:14637,secretAt:'N'}))}}));
  }const id=Number(u.pathname.match(/front\/(\d+)/)[1]);if(id===14&&failPost14)throw Error('test post offline');const d=fixture(id);d.bbsTypeVO.bbsFileList=[];return Buffer.from(JSON.stringify(d));};
  const run=async()=>{await query("UPDATE auto_ingest_state SET next_due_at=NOW() WHERE source='seoul_review'");await createSeoulCollector({query,transaction,load,env:{}}).run();};
  await run();let state=(await query('SELECT * FROM seoul_review_state')).rows[0];assert.equal(state.archive_page,3);assert.equal(state.archive_completed_at,null);
  assert.equal((await query('SELECT COUNT(*)::int n FROM seoul_review_posts')).rows[0].n,20);
  await query('UPDATE seoul_review_state SET next_archive_at=NOW()');await run();assert.equal((await query('SELECT archive_page FROM seoul_review_state')).rows[0].archive_page,3);
  assert.equal((await query("SELECT status FROM seoul_review_posts WHERE post_id=14")).rows[0].status,'error');
  failPage3=false;failPost14=false;await query('UPDATE seoul_review_state SET next_archive_at=NOW()');await run();state=(await query('SELECT * FROM seoul_review_state')).rows[0];assert.equal(state.archive_page,2);assert(state.archive_completed_at);
  assert.equal((await query('SELECT COUNT(*)::int n FROM seoul_review_posts')).rows[0].n,22);
  await query('UPDATE seoul_review_posts SET next_due_at=NOW() WHERE post_id=14');await run();assert.equal((await query("SELECT COUNT(*)::int n FROM seoul_review_posts WHERE status='processed' AND supported_files=0")).rows[0].n,22);
  await query("UPDATE auto_ingest_state SET daily_calls=100,call_day=(NOW() AT TIME ZONE 'Asia/Seoul')::date WHERE source='seoul_review'");await query('UPDATE seoul_review_state SET next_archive_at=NOW()');const before=requests;await run();assert.equal(requests,before);assert.equal((await query('SELECT archive_page FROM seoul_review_state')).rows[0].archive_page,2);
  await query("UPDATE auto_ingest_state SET daily_calls=0 WHERE source='seoul_review'");await query('UPDATE seoul_review_state SET next_archive_at=NOW()');await run();assert.equal((await query('SELECT COUNT(*)::int n FROM seoul_review_posts')).rows[0].n,22);
 }finally{await db.close();}
});
