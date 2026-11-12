const {test}=require('node:test'),assert=require('node:assert/strict');
const {parsePage,fetchGyeonggi,createPublicRequest}=require('../src/gyeonggi-directory');
const {nameKey,normalizeRecord,createDirectorySync}=require('../src/organization-directory');
// Minimal anonymized structure verified against the official 2026-11-12 public page.
function pageHtml(page=1,total=31,{duplicate=false,token=true}={}){
 const start=(page-1)*30,end=Math.min(page*30,total);let rows='';
 for(let i=start;i<end;i++){
  const n=duplicate?0:i,id='경기'+String(700001+n);
  rows+='<tr><td>'+id+'</td><td>검증 개발업체 '+n+'</td><td>검증 대표</td><td>경기도 시험시 시험로 '+n+'</td><td>2026.01.01</td><td><a onclick="fnSelectRealEstateDevTelno(\''+id+'\',\'0\');">조회</a></td><td>지도</td></tr>';
 }
 return '<form id="realEstateDevForm">'+(token?'<input name="_csrf" value="example-public-session">':'')+'</form><p class="list_num">검색결과 총 <span>'+total+'</span> 건</p><table><caption>부동산개발업체 조회 목록</caption><thead><tr>'+['등록번호','상호명','대표자','소재지','등록일','전화번호','지도보기'].map(h=>'<th>'+h+'</th>').join('')+'</tr></thead><tbody>'+rows+'</tbody></table><div class="gg-pgr"><a class="on">'+page+'</a></div>';
}
test('public page preserves company office identity and never copies page government contacts',()=>{
 const page=parsePage(pageHtml(1,1)+'<footer>관리부서 031-999-9999</footer>',1);
 const row=normalizeRecord(page.rows[0],'gyeonggi_developers');assert.equal(row.registration_no,'경기700001');assert.equal(row.address,'경기도 시험시 시험로 0');assert.equal(row.phone,null);assert.equal(row.data_date,null);
 assert.throws(()=>parsePage(pageHtml(2,31),1),/페이지/);assert.throws(()=>parsePage(pageHtml().replace('상호명','다른 항목'),1),/형식 변경/);
});
test('all pages load before project-party-only telephone lookup with public CSRF form',async()=>{
 const requests=[];const rows=await fetchGyeonggi({nameKey,phoneNames:['주식회사 검증 개발업체 30'],request:async(path,options)=>{
  requests.push({path,options});if(path.includes('Telno')){assert.equal(options.method,'POST');const form=new URLSearchParams(options.body);assert.equal(form.get('edRegNo'),'경기700031');assert.equal(form.get('_csrf'),options.headers['X-CSRF-TOKEN']);return '"031-123-4567"';}
  return pageHtml(Number(new URL(path,'https://gris.gg.go.kr').searchParams.get('pageIndex')));
 }});
 assert.equal(rows.length,31);assert.equal(requests.length,3);assert(requests[2].path.includes('Telno'));assert.equal(rows[30].전화번호,'031-123-4567');assert(!rows[0].전화번호);
});
test('duplicate, truncated, moving-count and failed telephone responses never produce a replacement snapshot',async()=>{
 const load=fn=>fetchGyeonggi({nameKey,request:async path=>fn(Number(new URL(path,'https://gris.gg.go.kr').searchParams.get('pageIndex')))});
 await assert.rejects(()=>load(p=>pageHtml(p,31,{duplicate:true})),/중복/);
 await assert.rejects(()=>load(p=>pageHtml(p,p===1?31:32)),/건수 변경/);
 await assert.rejects(()=>load(p=>pageHtml(p).replace(/<tr><td>경기700030[\s\S]*?<\/tr>/,'')),/건수 불일치/);
 await assert.rejects(()=>fetchGyeonggi({nameKey,phoneNames:['검증 개발업체 0'],request:async path=>path.includes('Telno')?'<html>접속 오류</html>':pageHtml(1,1)}),/전화 응답 형식/);
 await assert.rejects(()=>fetchGyeonggi({nameKey,phoneNames:['검증 개발업체 0'],request:async()=>pageHtml(1,1,{token:false})}),/양식 변경/);
});
test('anonymous public transport carries server session, rejects redirects and limits destinations and body size',async()=>{
 const requests=[];const request=createPublicRequest(async(url,options)=>{
  requests.push({url,options});const response=new Response('ok');response.headers.append('set-cookie','JSESSIONID=example-session; Path=/; HttpOnly');return response;
 });
 await request('/reb/selectRealestateDevList.do');await request('/reb/fnSelectRealEstateDevTelno.do',{method:'POST'});
 assert.equal(requests[1].options.headers.Cookie,'JSESSIONID=example-session');assert.equal(requests[1].options.redirect,'error');
 await assert.rejects(()=>request('https://other.example/reb/selectRealestateDevList.do'),/지원하지/);
 await assert.rejects(()=>request('/private/login'),/지원하지/);
 const big=createPublicRequest(async()=>new Response('x'.repeat(2*1024*1024+1)));await assert.rejects(()=>big('/reb/selectRealestateDevList.do'),/용량/);
});
test('keyless Gyeonggi snapshot uses evidence names and activates only after full public retrieval',async()=>{
 const calls=[];const query=async(sql,args)=>{
  calls.push({sql,args});if(sql.includes('RETURNING source'))return {rows:args[0]==='gyeonggi_developers'?[{source:args[0]}]:[]};
  if(sql.includes('SELECT DISTINCT organization'))return {rows:[{organization:'검증 개발업체 0'}]};return {rows:[{}]};
 };
 const worker=createDirectorySync({env:{},query,transaction:async fn=>fn(query),gyeonggiRequest:async path=>path.includes('Telno')?'"031-123-4567"':pageHtml(1,1)});
 await worker.run();const insert=calls.find(c=>c.sql.includes('INSERT INTO organization_directory'));assert(insert);assert.equal(JSON.parse(insert.args[0])[0].phone,'031-123-4567');
 assert(calls.some(c=>c.sql.includes('SET is_current=')&&c.args[0]==='gyeonggi_developers'));
});

test('missing original office remains unavailable and cannot match a project address',()=>{
 const html=pageHtml(1,1).replace('경기도 시험시 시험로 0','');
 const row=normalizeRecord(parsePage(html,1).rows[0],'gyeonggi_developers');
 assert.equal(row.address,'');assert.equal(row.address_key,'');
 const {matchState}=require('../src/organization-directory');
 assert.equal(matchState({organization:row.organization,organization_address:'경기도 시험시 시험로 0'},{...row,is_current:true}).status,'candidate');
 assert.throws(()=>normalizeRecord({상호:'검증 업체',등록번호:'잘못된 번호'},'gyeonggi_developers'),/주소 필드/);
});
