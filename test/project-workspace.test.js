const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const options=require('../src/project-search-options');
test('search rejects invalid area and sort before querying and safely accepts explicit filters',()=>{
 for(const minArea of ['-1','Infinity','NaN','10000000001'])assert.throws(()=>options.opportunityOptions({minArea}));
 assert.throws(()=>options.opportunityOptions({sort:'area; DROP TABLE projects'}));
 assert.throws(()=>options.opportunityOptions({phase:'other'}));
 assert.equal(options.opportunityOptions({}).minArea,null);
 assert.equal(options.opportunityOptions({minArea:'10000',unknownArea:'1'}).includeUnknownArea,true);
});
test('desktop/mobile output escapes source data and CSV neutralizes spreadsheet formulas',()=>{
 const ctx={window:{}};vm.createContext(ctx);vm.runInContext(fs.readFileSync(require.resolve('../public/project-workspace.js'),'utf8'),ctx);
 const w=ctx.window.ProjectWorkspace,p={id:1,name:'<img src=x onerror=alert(1)>',owner:'=HYPERLINK("x")',area_sqm:null,stage:'REVIEW',updated_at:'bad'};
 const html=w.render([p],()=>'<div>mobile-card</div>',()=> '심의');
 assert(!html.includes('<img'));assert(html.includes('&lt;img'));assert(html.includes('규모 미확인'));assert(html.includes('mobile-card'));assert(!html.includes('전화 확보'));
 const csv=w.csv([p],()=> '심의');assert(csv.startsWith('\ufeff'));assert(csv.includes('"\'=HYPERLINK(""x"")"'));
 assert.equal(w.area({area_sqm:'12000'}),'12,000㎡');
});
test('real PostgreSQL combines scale, unknown scale, early stage, region and sorting without parameter gaps',async()=>{
 const {PGlite}=require('@electric-sql/pglite'),db=new PGlite();await db.waitReady;
 try{
  const query=async(sql,args=[])=>args.length?db.query(sql,args):(await db.exec(sql)).at(-1)||{rows:[]};
  const schema=fs.readFileSync(require.resolve('../src/db'),'utf8'),init={query};vm.createContext(init);vm.runInContext(schema.slice(schema.indexOf('async function initDb'),schema.indexOf('async function transaction')),init);await init.initDb();
  await query("INSERT INTO projects(name,stage,area_sqm,region,building_type) VALUES ('큰 호텔','PERMIT',20000,'서울특별시','숙박시설'),('작은 호텔','PERMIT',3000,'서울특별시','숙박시설'),('미확인 호텔','REVIEW',NULL,'서울특별시','숙박시설'),('착공 호텔','STARTED',50000,'경기도','숙박시설')");
  let handler;const ctx={...options,query,regionAliases:require('../src/region-catalog').regionAliases,STAGES:['REVIEW','PERMIT','STARTED','COMPLETED','BID','UNKNOWN'],app:{get:(p,h)=>handler=h}};vm.createContext(ctx);
  const src=fs.readFileSync(require.resolve('../src/server'),'utf8'),start=src.indexOf('app.get("/api/projects",');vm.runInContext(src.slice(start,src.indexOf("app.get('/api/contacts/summary'",start)),ctx);
  async function search(params){let data,code=200;await handler({query:params},{status(n){code=n;return this;},json(v){data=v;}});assert.equal(code,200,JSON.stringify(data));return data;}
  assert.equal((await search({minArea:'10000',phase:'early'})).total,1);
  assert.equal((await search({minArea:'10000',phase:'early',unknownArea:'1'})).total,2);
  const scoped=await search({q:'호텔',region:'서울',minArea:'10000',unknownArea:'1',type:'숙박',sort:'area'});assert.equal(scoped.total,2);assert.equal(scoped.rows[0].name,'큰 호텔');assert.equal(scoped.rows[1].name,'미확인 호텔');
  assert.equal((await search({sort:'area'})).rows[0].name,'착공 호텔');
  assert.equal((await search({sort:'priority'})).rows[0].stage,'REVIEW');
  assert.equal((await search({q:'착공',sort:'recent'})).total,1);
 }finally{await db.close();}
});
