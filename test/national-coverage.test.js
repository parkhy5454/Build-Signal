const {test}=require('node:test'),assert=require('node:assert/strict');
const {nationalCoverage}=require('../src/national-coverage');
const {provinces}=require('../src/region-catalog');
test('every current official province is represented even when no records have been collected',()=>{
 const data=nationalCoverage();assert.deepEqual(data.rows.map(r=>r.code),provinces.filter(p=>p.code).map(p=>p.code));
 assert(data.rows.every(r=>r.permits.status==='key_missing'));assert.equal(data.initialScanMinimumDays,null);
 const seoul=data.rows.find(r=>r.label==='서울');assert.equal(seoul.developers.status,'unconnected');assert.equal(seoul.review.status,'partial');
 assert.equal(data.nationalDeveloperSource.status,'connection_unverified');
});
test('a completed initial scan is distinct from current refresh and incomplete coverage is never marked current',()=>{
 const data=nationalCoverage({regions:provinces.filter(p=>['11','41'].includes(p.code)),configured:true,stats:[{province:'11',targets:100,attempted:100,completed:100,fresh:99,failed:1},{province:'41',targets:100,attempted:90,completed:80,fresh:80,failed:0}],env:{AUTO_PERMIT_DAILY_REQUESTS:'10'}});
 assert.equal(data.rows.find(r=>r.code==='11').permits.status,'refresh_pending');assert.equal(data.rows.find(r=>r.code==='41').permits.status,'initial_loading');assert.equal(data.initialScanMinimumDays,2);
});
test('regional directory success and limited review parsers cannot be promoted into national coverage',()=>{
 const data=nationalCoverage({configured:true,directories:[{source:'gyeonggi_developers',last_success_at:'2026-11-13',record_count:554},{source:'architects',last_success_at:'2026-11-13',record_count:8279}]});
 const gg=data.rows.find(r=>r.code==='41');assert.equal(gg.developers.status,'synced');assert.equal(gg.developers.sources[0].recordCount,554);assert.equal(gg.review.status,'unconnected');
 assert.equal(data.rows.find(r=>r.code==='31').review.status,'partial');assert.equal(data.rows.find(r=>r.code==='52').review.status,'partial');
 assert.equal(data.rows.find(r=>r.code==='11').developers.status,'unconnected');
});

test('unseeded queues never advertise a zero-day national scan',()=>{
 const data=nationalCoverage({configured:true});assert.equal(data.initialScanMinimumDays,null);assert(data.rows.every(r=>r.permits.status==='queue_pending'));
});
test('shared coverage view renders missing connections and partial review as separate columns',async()=>{
 const fs=require('node:fs'),vm=require('node:vm');
 const out={innerHTML:'',textContent:''},data=nationalCoverage({configured:true});
 const context={document:{getElementById:()=>out,hidden:false},fetch:async()=>({ok:true,json:async()=>data}),setInterval:()=>0};
 vm.createContext(context);vm.runInContext(fs.readFileSync(require.resolve('../public/national-coverage.js'),'utf8'),context);
 await new Promise(setImmediate);
 assert(out.innerHTML.includes('서울'));assert(out.innerHTML.includes('개발업체 회사 명부'));assert(out.innerHTML.includes('미연결'));assert(out.innerHTML.includes('군산 공개 PDF 1건'));
 assert(out.innerHTML.includes('응답·필드 검증 및 연결 대기'));assert(!out.innerHTML.includes('전국 수집 완료'));
});
test('national environment source success cannot turn unconnected architectural review into completed coverage',()=>{
 const data=nationalCoverage({environment:{last_success_at:'2026-11-13',last_error:null,total:14,unlocated:7}});
 assert.equal(data.environmentalReview.status,'checked');assert.equal(data.environmentalReview.total,14);assert.equal(data.environmentalReview.unlocated,7);
 assert.equal(data.rows.find(r=>r.code==='11').review.status,'partial');assert(data.environmentalReview.scope.includes('건축위원회 심의 전체를 대체하지 않습니다'));
});
test('national index query success and zero hits cannot claim project or contact extraction completion',()=>{
 const {STREAMS}=require('../src/national-review');const d=nationalCoverage({reviewStreams:STREAMS.map(s=>({id:s.id,last_success_at:'2026-11-13',index_count:0})),reviewDocuments:[]});
 const row=d.rows.find(x=>x.name==='경상남도');assert.equal(row.review.discovery.status,'checked');assert.equal(row.review.discovery.documents,0);assert.equal(row.review.status,'unconnected');assert.equal(row.developers.status,'unconnected');
});
