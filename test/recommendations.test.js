const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {recommendationOptions,registerRecommendationRoutes}=require('../src/recommendations');
const {regionAliases}=require('../src/region-catalog');
async function database(){const {PGlite}=require('@electric-sql/pglite'),db=new PGlite();await db.waitReady;const query=async(sql,args=[])=>args.length?db.query(sql,args):(await db.exec(sql)).at(-1)||{rows:[]};const src=fs.readFileSync(require.resolve('../src/db'),'utf8'),ctx={query};vm.createContext(ctx);vm.runInContext(src.slice(src.indexOf('async function initDb'),src.indexOf('async function transaction')),ctx);await ctx.initDb();return {db,query};}
function api(query){const handlers={};registerRecommendationRoutes({get:(path,handler)=>handlers[path]=handler},{query,regionAliases});return async(path,params={})=>{let code=200,body;await handlers[path]({query:params},{status(n){code=n;return this;},json(d){body=d;}});return {code,body};};}
async function project(query,name,type,region='경기도',district='성남시 분당구',area=12000){return (await query("INSERT INTO projects(source,name,building_type,stage,region,district,area_sqm) VALUES('arch_hub_permit',$1,$2,'PERMIT',$3,$4,$5) RETURNING id",[name,type,region,district,area])).rows[0].id;}
test('free text selects explainable product intent while unsupported text stays literal; invalid inputs fail before SQL',()=>{
 assert.equal(recommendationOptions({product:'호텔 객실제어'}).intentLabel,'호텔 객실제어');assert.equal(recommendationOptions({product:'냉난방 밸브'}).intentLabel,'공조·기계설비');assert.equal(recommendationOptions({product:'JUNG 스위치'}).mode,'related');assert.equal(recommendationOptions({product:'맞춤 특수제품 ZX'}).mode,'literal');
 for(const input of [{profile:'__proto__'},{product:'가'.repeat(121)},{district:'강남구'},{region:'가'.repeat(81)}])assert.throws(()=>recommendationOptions(input));
});
test('PostgreSQL filters product and region before ranking, preserves older relevant records and collapses related bid notices',async()=>{
 const {db,query}=await database();try{
 const older=await project(query,'오래된 숙박시설','숙박시설');await query("UPDATE projects SET updated_at='2020-01-01' WHERE id=$1",[older]);await project(query,'서울 호텔','숙박시설','서울특별시','강남구');await project(query,'경기 사무실','업무시설');await project(query,'수원 리조트','숙박시설','경기도','수원시 영통구');
 await query("INSERT INTO projects(source,name,building_type,stage,region,district) SELECT 'arch_hub_permit','최근 무관한 업무시설 '||g,'업무시설','PERMIT','경기도','성남시 분당구' FROM generate_series(1,510) g");
 const call=api(query);let r=await call('/api/recommendations',{product:'호텔 객실제어',region:'경기',district:'성남시 분당구'});assert.equal(r.code,200,JSON.stringify(r.body));assert.equal(r.body.total,1);assert.equal(r.body.rows[0].id,older);assert(r.body.rows[0].recommendation_reasons.some(v=>v.includes('제품')));assert(!r.body.rows.some(v=>v.name.includes('사무실')));
 r=await call('/api/recommendations',{product:'호텔 객실제어',region:'경기'});assert.equal(r.body.total,2);
 const g=(await query("INSERT INTO project_groups(group_key,title,owner,region,location) VALUES('bid','분당 호텔 신축사업','검증기관','경기도','성남시 분당구 검증동 123') RETURNING id")).rows[0].id;
 await query("INSERT INTO projects(source,name,building_type,stage,region,district,project_group_id) VALUES('g2b_bid','분당 호텔 신축사업 전기공사','전기','BID','경기도','성남시 분당구 검증동',$1),('g2b_bid','분당 호텔 신축사업 통신공사','통신','BID','경기도','성남시 분당구 검증동',$1)",[g]);
 r=await call('/api/recommendations',{product:'호텔 객실제어',region:'경기',district:'성남시 분당구'});assert.equal(r.body.total,2);assert.equal(r.body.rows.filter(v=>v.source==='g2b_bid').length,1);assert.equal(r.body.rows.find(v=>v.source==='g2b_bid').name,'분당 호텔 신축사업');
 r=await call('/api/recommendations',{region:'경기'});assert(r.body.total>500);assert.equal(r.body.rows.length,100);assert(r.body.rows.every((row,i)=>i===0||r.body.rows[i-1].score>=row.score));
 const districts=await call('/api/recommendation-districts',{region:'경기'});assert.deepEqual(districts.body.districts,['성남시 분당구','수원시 영통구']);
 }finally{await db.close();}
});
test('literal products do not silently fall back to unrelated industry results; LIKE wildcards remain literal and district lookup is scoped',async()=>{
 const {db,query}=await database();try{
 await project(query,'노후 밸브 교체공사','기타');
 await project(query,'ZX 특수제품 100%_현장','기타');await project(query,'유사 ZX 제품 100XX현장','기타');await project(query,'서울 자료','숙박시설','서울특별시','강남구');
 const call=api(query);let r=await call('/api/recommendations',{product:'특수제품 100%_',region:'경기'});assert.equal(r.body.rows.length,1);assert.equal(r.body.match_mode,'literal');
 r=await call('/api/recommendations',{product:'밸브',region:'경기'});assert(r.body.rows.some(p=>p.name==='노후 밸브 교체공사'));
 r=await call('/api/recommendations',{product:'없는제품',region:'경기'});assert.equal(r.body.total,0);assert.deepEqual(r.body.rows,[]);
 assert.equal((await call('/api/recommendations',{district:'강남구'})).code,400);assert.equal((await call('/api/recommendation-districts',{region:'서울'})).body.districts[0],'강남구');
 }finally{await db.close();}
});
