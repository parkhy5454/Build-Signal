const {test}=require('node:test'),assert=require('node:assert/strict');
const {nameKey,addressKey,validPhone,normalizeRecord,fetchArchitects,fetchDevelopers,matchState,directoryMatches,createDirectorySync}=require('../src/organization-directory');
const record={CO_NM:'테스트 건축사사무소',LCTN_ROAD_NM:'서울특별시 중구 시험로 10',TELNO:'02-123-4567',DATA_CRTR_YMD:'2026-08-05'};
test('conservative names preserve branches and meaningful parts; invalid phones stay unavailable',()=>{
 assert.equal(nameKey('㈜ 테스트 건축사사무소'),nameKey('주식회사 테스트건축사사무소'));
 assert.notEqual(nameKey('테스트 건축사사무소 부산지점'),nameKey('테스트 건축사사무소'));
 assert.equal(validPhone('02-0000-0000'),null);assert.equal(validPhone('비공개'),null);assert.equal(validPhone('02-123-4567 / 02-123-4568'),null);
 assert.equal(normalizeRecord(record,'architects').phone,'02-123-4567');assert.throws(()=>normalizeRecord({CO_NM:'자료'},'architects'));
});
test('name alone is never an identity match; project site is not a company address',()=>{
 const row={...normalizeRecord(record,'architects'),is_current:true};
 const e={organization:record.CO_NM,address:record.LCTN_ROAD_NM};assert.equal(matchState(e,row).status,'candidate');
 assert.equal(matchState({...e,organization_address:record.LCTN_ROAD_NM},row).status,'matched');
 assert.equal(matchState({...e,registration_no:'123'},{...row,registration_no:'123'}).status,'matched');
 assert.equal(matchState(e,{...row,is_current:false},{decision:'confirmed',reason:'이전에 동일 업체 확인함'}).status,'historical');
 assert.equal(matchState(e,row,{decision:'rejected',reason:'다른 업체입니다'}).status,'rejected');
});
test('public architect download follows official one-based pagination and validates completeness',async()=>{
 const seen=[];const request=async value=>{const u=new URL(value);seen.push(u);if(u.pathname.includes('columList'))return {totalCount:1,tableVO:{colNmList:['CO_NM','TELNO'],svcTableNm:'tn_pubr_public_architect_svc'}};return [record];};
 assert.equal((await fetchArchitects({},request)).length,1);assert.equal(seen[1].searchParams.get('page'),'1');assert.equal(seen[1].searchParams.get('perPage'),'10000');
 await assert.rejects(()=>fetchArchitects({},async()=>({totalCount:0})),/명세 변경/);
});
test('architect API and developer API accept valid schemas, require approval and reject truncated snapshots',async()=>{
 const a=await fetchArchitects({ARCHITECT_DIRECTORY_KEY:'test'},async()=>({response:{header:{resultCode:'00'},body:{items:[record],totalCount:1}}}));assert.equal(a.length,1);
 await assert.rejects(()=>fetchDevelopers({},async()=>{}),/활용신청/);
 const d=await fetchDevelopers({DEVELOPER_DIRECTORY_KEY:'test'},async url=>String(url).includes('infuser')?{paths:{'/15134260/v1/uddi:074f89a9-7979-414f-ade0-d17f659857d2':{get:{summary:'부산광역시_부동산개발업 등록 현황_20260831'}}}}:({data:[{상호:'개발업체','주사무소 소재지':'부산광역시 중구 시험로 1',전화번호:'051-123-4567'}],totalCount:1}));assert.equal(d.length,1);
 let pages=0;await assert.rejects(()=>fetchArchitects({ARCHITECT_DIRECTORY_KEY:'test'},async()=>({response:{header:{resultCode:'00'},body:{items:pages++?[]:[record],totalCount:2}}})),/페이지 누락/);
});
test('refresh failure never activates a partial snapshot or clears old directory data',async()=>{
 const calls=[];let writes=0;const query=async(sql,args)=>{calls.push({sql,args});return {rows:[{source:'architects'}]};};
 const worker=createDirectorySync({query,transaction:async()=>{writes++;},request:async()=>{throw Error('source unavailable');}});
 await worker.run();assert.equal(writes,0);assert(calls.some(x=>x.sql.includes('SET last_error=')));assert(!calls.some(x=>x.sql.includes('SET is_current=')));
});
test('complete snapshot activates in one transaction and retains historical records',async()=>{
 let txCount=0;const queries=[];const query=async(sql,args)=>{queries.push({sql,args});if(sql.includes('RETURNING source'))return {rows:args?.[0]==='architects'?[{source:'architects'}]:[]};return {rows:[{source:'architects'}]};};
 const request=async url=>String(url).includes('columList')?{totalCount:1,tableVO:{colNmList:['CO_NM','TELNO'],svcTableNm:'table'}}:[record];
 const worker=createDirectorySync({query,transaction:async fn=>{txCount++;await fn(query);},request});await worker.run();assert.equal(txCount,1);
 assert(queries.some(x=>x.sql.includes('SET is_current=')));assert(!queries.some(x=>x.sql.includes('DELETE FROM')));
});
test('candidate lookup preserves project role and excludes rejected matches',async()=>{
 const row={id:8,...normalizeRecord(record,'architects'),is_current:true};
 const query=async sql=>({rows:sql.includes('party_contact_decisions')?[]:[row]});
 const out=await directoryMatches(query,[{id:1,role:'designer',organization:record.CO_NM}]);assert.equal(out[0].role,'designer');assert.equal(out[0].match_status,'candidate');
});
test('company identity decisions survive phone snapshot changes while old numbers remain historical',async()=>{
 const old={id:8,...normalizeRecord(record,'architects'),is_current:false},fresh={...old,id:9,is_current:true,phone:'02-123-4568'};
 const decisions=[{id:3,evidence_id:1,directory_id:8,decision:'confirmed',reason:'공식 사업장 주소와 업체명을 대조함',directory_source:old.source,directory_name_key:old.name_key,directory_address_key:old.address_key,directory_registration_no:old.registration_no}];
 const query=async sql=>({rows:sql.includes('party_contact_decisions')?decisions:sql.includes('AND is_current=FALSE')?[old]:[fresh]});
 const matches=await directoryMatches(query,[{id:1,role:'designer',organization:record.CO_NM}]);assert.equal(matches.find(x=>x.id===9).match_status,'confirmed');assert.equal(matches.find(x=>x.id===8).match_status,'historical');
 decisions[0].decision='rejected';assert.equal((await directoryMatches(query,[{id:1,role:'designer',organization:record.CO_NM}])).length,0);
});
test('official developer manifest selects newest supported version and retains its data date',async()=>{
 let selected='';const request=async url=>{const s=String(url);if(s.includes('infuser'))return {paths:{'/15134260/v1/uddi:aaaa-1111':{get:{summary:'부산광역시_부동산개발업_20240828'}},'/15134260/v1/uddi:bbbb-2222':{get:{summary:'부산광역시_부동산개발업_20260831'}}}};selected=s;return {data:[{상호:'업체','주사무소 소재지':'부산광역시'}],totalCount:1};};
 const rows=await fetchDevelopers({DEVELOPER_DIRECTORY_KEY:'test'},request);assert(selected.includes('bbbb-2222'));assert.equal(rows[0].__directoryDate,'2026-08-31');
});
