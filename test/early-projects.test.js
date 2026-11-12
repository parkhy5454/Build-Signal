const {test}=require('node:test'),assert=require('node:assert/strict');
const {parseUlsan,parseGunsan,normalizeEvidence,saveRecords,insertEvidence,createEarlyCollector}=require('../src/early-projects');
const sample=`<div class="info">담당부서 건축주택과 연락처 052-226-5962</div><div class="bbs-view-content">심의일자 : 2026. 10. 22.<br>[안건번호 : 5-1]<br>- 신청인 : 울산 남구청장<br>- 위 치 : 남구 무거동 579-1번지<br>- 용 도 : 자동차관련시설(주차장)<br>- 규 모 : 연면적 3,100㎡<br>□ 심의결과 : 조건부의결</div>`;
const pdfText='운영기관 군산시 심의일자 2026. 5. 21.\n건축주 성명(법인명) 한국농어촌공사 군산지사\n대지위치 옥도면 선유도리 474';
test('official HTML preserves applicant role and excludes government-page telephone',()=>{
 const rows=parseUlsan(sample);assert.equal(rows.length,1);assert.equal(rows[0].date,'2026-10-22');assert.equal(rows[0].parties[0].role,'applicant');assert.equal(rows[0].parties[0].organization,'울산 남구청장');assert(!JSON.stringify(rows).includes('052-226'));
 assert.equal(rows[0].address,'울산광역시 남구 무거동 579-1번지');
});
test('case boundaries do not leak parties between projects; absent identity is not invented',()=>{
 const html=sample.replace('</div>', '</div>') .replace('□ 심의결과 : 조건부의결','[안건번호 : 5-2]<br>- 위 치 : 남구 신정동 10<br>- 용 도 : 업무시설');
 const rows=parseUlsan(html);assert.equal(rows.length,2);assert.equal(rows[1].parties.length,0);
 assert.equal(parseUlsan('<p>연락처 052-226-5962</p>').length,0);
});
test('verified PDF schema extracts owner without promoting to developer and rejects multiple owner blocks',()=>{
 const rows=parseGunsan(pdfText);assert.equal(rows[0].parties[0].role,'owner');assert.equal(rows[0].parties[0].organization,'한국농어촌공사 군산지사');assert.equal(rows[0].date,'2026-05-21');
 assert.equal(parseGunsan(pdfText+'\n건축주 성명(법인명) 다른 사업').length,0);
});
test('evidence requires a real role, HTTPS official source and attributable contact',()=>{
 assert.throws(()=>normalizeEvidence({role:'developer',organization:'테스트',source_url:'javascript:alert(1)'}));
 assert.throws(()=>normalizeEvidence({role:'owner',organization:'테스트',source_url:'https://evil.example/go.kr'}));
 assert.throws(()=>normalizeEvidence({role:'owner',organization:'테스트',source_url:'https://www.gunsan.go.kr/x',phone:'02-123-4567'}),/근거/);
 const e=normalizeEvidence({role:'designer',organization:'테스트 설계사',stage:'PERMIT',contact_scope:'company',source_url:'https://www.gunsan.go.kr/x',phone:'02-123-4567',excerpt:'설계사 회사 전화번호 기재'});assert.equal(e.contact_scope,'company');
});
test('document/project writes share one transaction and party fingerprints deduplicate repeated evidence',async()=>{
 let transactionCalls=0;const fingerprints=new Set(),queries=[];
 const query=async(sql,args)=>{queries.push(sql);if(sql.includes('RETURNING id')&&sql.includes('INSERT INTO projects('))return {rows:[{id:10}]};if(sql.includes('INSERT INTO project_party_evidence')){if(fingerprints.has(args[11]))return {rows:[]};fingerprints.add(args[11]);return {rows:[{id:1}]};}return {rows:[]};};
 const tx=async fn=>{transactionCalls++;await fn(query);};const rows=parseUlsan(sample);
 await saveRecords(tx,'https://www.ulsannamgu.go.kr/x','심의',Buffer.from('x'),rows);await saveRecords(tx,'https://www.ulsannamgu.go.kr/x','심의',Buffer.from('x'),rows);
 assert.equal(transactionCalls,2);assert.equal(fingerprints.size,1);assert(!queries.some(x=>x.includes('UPDATE project_party_evidence')));
});
test('collector is bounded, lease protected, and does not execute when disabled',async()=>{
 let downloads=0;const denied=createEarlyCollector({query:async()=>({rows:[]}),transaction:async fn=>fn(),download:async()=>{downloads++;}});await denied.run();assert.equal(downloads,0);
 let db=0;const off=createEarlyCollector({env:{AUTO_INGEST_ENABLED:'false'},query:async()=>{db++;},transaction:async()=>{}});await off.run();assert.equal(db,0);
});
test('scheduled collection discovers the supported article, persists evidence and reuses unchanged PDF',async()=>{
 const crypto=require('crypto');let saved=0;const statements=[];
 const query=async(sql,args=[])=>{statements.push({sql,args});
  if(sql.includes("SELECT content_hash"))return {rows:args[0].includes('gunsan')?[{content_hash:crypto.createHash('sha256').update('cached-pdf').digest('hex')}]:[]};
  if(sql.includes('INSERT INTO projects('))return {rows:[{id:100}]};
  if(sql.includes('INSERT INTO project_party_evidence')){saved++;return {rows:[{id:1}]};}
  return {rows:[{source:'early'}]};
 };
 const download=async url=>Buffer.from(url.includes('selectBoardList')?'<a href="/cop/bbs/selectBoardArticle.do?bbsId=resultBuild&amp;nttId=538022">2026년 건축위원회 심의결과</a>':url.includes('gunsan')?'cached-pdf':sample);
 const collector=createEarlyCollector({query,transaction:fn=>fn(query),download});await collector.run();
 assert.equal(saved,1);const completed=statements.find(x=>x.sql.includes('last_success_at=CASE'));assert.equal(completed.args[1],2);assert.equal(completed.args[2],null);
 assert(!statements.some(x=>x.sql.includes('INSERT INTO project_phase_links')));
});
test('admin linking only permits a distinct review source to an ArchHUB permit and never overwrites a link',async()=>{
 const fs=require('fs'),vm=require('vm'),s=fs.readFileSync(require.resolve('../src/server'),'utf8');let handler,queries=0;
 const ctx={loadUser(){},requireAdminRole(){},app:{post:(path,...args)=>{handler=args.at(-1);}},query:async(sql,args)=>{queries++;assert(sql.includes("a.source='public_review'"));assert(sql.includes("b.source='arch_hub_permit'"));assert(sql.includes('ON CONFLICT(early_id) DO NOTHING'));return {rowCount:0,rows:[]};}};
 vm.createContext(ctx);const a=s.indexOf("app.post('/api/admin/early-projects/link'");vm.runInContext(s.slice(a,s.indexOf('app.get("/api/projects/:id"',a)),ctx);
 const res={status(code){this.code=code;return this;},json(data){this.data=data;}};
 await handler({body:{early_id:1,permit_id:1,reason:'같은 주소와 공식 사업명을 대조했습니다.'},user:{id:1}},res);assert.equal(res.code,400);assert.equal(queries,0);
 await handler({body:{early_id:1,permit_id:2,reason:'같은 주소와 공식 사업명을 대조했습니다.'},user:{id:1}},res);assert.equal(res.code,409);assert.equal(queries,1);
});
