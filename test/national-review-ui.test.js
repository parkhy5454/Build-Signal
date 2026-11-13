const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require.resolve('../public/national-review.js'),'utf8');
function harness(rows){
 const elements=new Map(),urls=[];function element(id){if(!elements.has(id))elements.set(id,{value:'',textContent:'',innerHTML:'',disabled:false,events:{},addEventListener(name,fn){this.events[name]=fn;},appendChild(){}});return elements.get(id);}
 const ctx={URL,URLSearchParams,document:{getElementById:element,createElement:()=>({})},fetch:async url=>{urls.push(url);return {ok:true,json:async()=>url==='/api/regions'?{regions:[{value:'경기도',label:'경기'}]}:{rows,total:rows.length,page:1}};}};vm.createContext(ctx);vm.runInContext(source,ctx);return {elements,urls};
}
test('public document view escapes metadata, blocks nonofficial links and labels source region separately',async()=>{
 const h=harness([{title:'<img src=x onerror=alert(1)>',publisher:'검증시청',publisher_region:'경기도',published_date:'2026-11-01',index_url:'https://clik.nanet.go.kr/potal/search/searchView.do?collection=policyinfo&DOCID=CLIKC1793267176008506',original_url:'javascript:alert(1)',status:'error'}]);await new Promise(setImmediate);
 const html=h.elements.get('reviewNoticeResults').innerHTML;assert(html.includes('&lt;img'));assert(!html.includes('<img'));assert(!html.includes('href="javascript:'));assert(html.includes('발행지역 경기도'));assert(html.includes('프로젝트 추출 대기'));assert(html.includes('원문 링크 재확인 중'));
});
test('empty results do not advertise no construction projects; region and keyword use the document API',async()=>{
 const h=harness([]);await new Promise(setImmediate);assert(h.elements.get('reviewNoticeResults').innerHTML.includes('심의 사업이 없다는 뜻은 아닙니다'));
 h.elements.get('reviewNoticeRegion').value='경기도';h.elements.get('reviewNoticeKeyword').value='건축위원회';h.elements.get('reviewNoticeForm').events.submit({preventDefault(){}});await new Promise(setImmediate);
 const url=new URL(h.urls.at(-1),'https://example.com');assert.equal(url.searchParams.get('region'),'경기도');assert.equal(url.searchParams.get('q'),'건축위원회');assert(h.elements.get('reviewNoticePrev').disabled);assert(h.elements.get('reviewNoticeNext').disabled);
});
