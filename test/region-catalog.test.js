const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),zlib=require('node:zlib');
const {meta,provinces,regionAliases,installRegionCatalog}=require('../src/region-catalog');
test('official bundled catalog is complete and provides province and legal-dong identifiers',()=>{
 const catalog=JSON.parse(zlib.gunzipSync(fs.readFileSync(require.resolve('../data/legal-dong.json.gz'))));
 assert.equal(catalog.rows.length,meta.activeCodes);assert(catalog.rows.length>10000);
 assert.equal(new Set(catalog.rows.map(x=>x[0])).size,catalog.rows.length);
 assert(catalog.rows.every(([c,n])=>/^\d{10}$/.test(c)&&n));
 assert(catalog.rows.some(([c,n])=>c==='1168010300'&&n.includes('개포동')));
 assert.equal(catalog.rows.filter(([c])=>!c.endsWith('00000')).length,meta.collectionRegions);
 assert(provinces.some(x=>x.label==='서울'));assert(provinces.some(x=>x.label==='경기'));
});
test('simple labels, official province codes and historic names resolve consistently',()=>{
 assert.deepEqual(regionAliases(''),[]);
 assert(regionAliases('서울').includes('서울특별시'));
 assert(regionAliases('41').includes('경기도'));
 assert(regionAliases('강원도').includes('강원특별자치도'));
 assert(regionAliases('전라북도').includes('전북특별자치도'));
});
test('catalog installs in batches without deleting manual entries; same version skips work',async()=>{
 let version,codes=0;const queries=[];
 const query=async(sql,args=[])=>{queries.push(sql);if(sql.startsWith('SELECT version'))return {rows:version?[{version}]:[]};if(sql.includes('jsonb_to_recordset'))codes+=JSON.parse(args[0]).length;if(sql.includes('INSERT INTO region_catalog_state'))version=args[0];return {rows:[]};};
 await installRegionCatalog(query);assert.equal(codes,meta.activeCodes);assert.equal(version,meta.sha256);
 assert(queries.some(s=>s.includes("catalog_origin='official_bundle' AND NOT")));
 assert(!queries.some(s=>/DELETE FROM/.test(s)));
 const n=queries.length;await installRegionCatalog(query);assert.equal(queries.length,n+1);
});
test('both search APIs pass province aliases as bound arrays and all-region adds no region condition',async()=>{
 const s=fs.readFileSync(require.resolve('../src/server'),'utf8');const handlers={};let calls=[];
 const ctx={regionAliases,STAGES:['PERMIT','STARTED','COMPLETED','BID','UNKNOWN'],app:{get:(p,fn)=>handlers[p]=fn},query:async(sql,args)=>{calls.push({sql,args});return {rows:sql.includes('COUNT(*)::int AS n')?[{n:1}]:[]};}};
 vm.createContext(ctx);
 const p=s.indexOf('app.get("/api/projects",');vm.runInContext(s.slice(p,s.indexOf("app.get('/api/contacts/summary'",p)),ctx);
 const g=s.indexOf("app.get('/api/project-groups',");vm.runInContext(s.slice(g,s.indexOf("app.get('/api/project-groups/:id'",g)),ctx);
 for(const route of ['/api/projects','/api/project-groups']){
  calls=[];await handlers[route]({query:{region:'경기'}},{json(){},status(){return this;}});
  assert(calls[0].sql.includes('ILIKE ANY'));assert(calls[0].args[0].includes('%경기도%'));
  calls=[];await handlers[route]({query:{}},{json(){},status(){return this;}});assert(!calls[0].sql.includes('ILIKE ANY'));
 }
});
