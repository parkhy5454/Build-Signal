const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
function harness(){
 const els=new Map(),pending=[],blobs=[];const el=id=>{if(!els.has(id))els.set(id,{value:'',innerHTML:'',textContent:'',disabled:false,events:{},addEventListener(k,fn){this.events[k]=fn;},setAttribute(){},classList:{add(){},remove(){}}});return els.get(id);};
 class TestURL extends URL{static createObjectURL(b){blobs.push(b);return 'blob:qa';}static revokeObjectURL(){}}
 const ctx={URL:TestURL,URLSearchParams,Blob,setTimeout:()=>0,document:{getElementById:el,createElement:()=>({click(){}})},fetch:async url=>{
  if(url==='/api/regions')return {ok:true,json:async()=>({regions:[]})};
  if(url==='/api/awards/status')return {ok:true,json:async()=>({enabled:true,keyConfigured:true,constructionNote:'추가 수집 미연결'})};
  return new Promise(resolve=>pending.push(d=>resolve({ok:true,json:async()=>d})));
 }};ctx.window=ctx;vm.createContext(ctx);vm.runInContext(fs.readFileSync(require.resolve('../public/awards.js'),'utf8'),ctx);return {ctx,els,pending,blobs};
}
const row={kind:'public_award',name:'=HYPERLINK("x") <img>',organization:'<svg onload=evil()>',amount:null,event_date:null,date_label:'최종낙찰일',source_url:'javascript:alert(1)'};
test('award screen escapes source values, blocks active links and exports only the last successful page with formula protection',async()=>{
 const h=harness(),run=h.ctx.loadAwards(1);await new Promise(setImmediate);h.pending[0]({rows:[row],total:1,page:1,pages:1});await run;
 const html=h.els.get('awardResults').innerHTML;assert(!html.includes('<svg'));assert(html.includes('&lt;svg'));assert(html.includes('금액 미확인'));
 h.ctx.awardDetails(0);assert(!h.els.get('modalBody').innerHTML.includes('href="javascript:'));
 h.els.get('awardExport').onclick();const csv=await h.blobs[0].text();assert(csv.includes('"\'=HYPERLINK(""x"") <img>"'));assert.equal(csv.split('\r\n').length,2);
 const history=h.ctx.awardHistoryHtml([{winner:'<svg>',award_date:null,award_amount:null,source_url:'javascript:alert(1)'}]);assert(!history.includes('<svg>'));assert(!history.includes('href="javascript:'));
});
test('slow earlier search cannot replace a later result or change its CSV export',async()=>{
 const h=harness(),first=h.ctx.loadAwards(1);await new Promise(setImmediate);
 const second=h.ctx.loadAwards(1);await new Promise(setImmediate);h.pending[1]({rows:[{...row,name:'새 조건'}],total:1,pages:1});await second;
 h.pending[0]({rows:[{...row,name:'이전 조건'}],total:1,pages:1});await first;
 assert(h.els.get('awardResults').innerHTML.includes('새 조건'));assert(!h.els.get('awardResults').innerHTML.includes('이전 조건'));
 h.els.get('awardExport').onclick();assert((await h.blobs[0].text()).includes('새 조건'));
});
