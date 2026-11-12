const cheerio=require('cheerio');
const ORIGIN='https://gris.gg.go.kr';
const LIST='/reb/selectRealestateDevList.do';
const PHONE='/reb/fnSelectRealEstateDevTelno.do';
const clean=v=>String(v??'').normalize('NFKC').replace(/\s+/g,' ').trim();
function parsePage(html,page){
 const $=cheerio.load(html),table=$('table').filter((_,t)=>$(t).find('caption').text().trim()==='부동산개발업체 조회 목록');
 const headers=table.find('thead th').map((_,t)=>clean($(t).text())).get();
 if(table.length!==1||headers.join('|')!=='등록번호|상호명|대표자|소재지|등록일|전화번호|지도보기')throw Error('경기 공개 명부 표 형식 변경');
 const countText=clean($('.list_num span').text()).replace(/,/g,'');
 const total=Number(countText),current=Number($('.gg-pgr a.on').text());
 if(!/^\d+$/.test(countText)||total<1||total>10000||current!==page)throw Error('경기 명부 전체 건수·페이지 확인 필요');
 const rows=[];table.find('tbody tr').each((_,tr)=>{
  const cells=$(tr).children('td');if(cells.length!==7)throw Error('경기 명부 행 형식 변경');
  const values=cells.map((_,td)=>clean($(td).text())).get();
  const [registration,organization,representative,address]=values;
  if(!/^경기\d{6}$/.test(registration)||!organization)throw Error('경기 명부 업체 식별정보 누락');
  const handler=cells.eq(5).find('a').attr('onclick')||'';
  if(!handler.includes("fnSelectRealEstateDevTelno('"+registration+"',"))throw Error('경기 명부 전화 조회 연결 변경');
  rows.push({등록번호:registration,상호:organization,대표자:representative,'사무소 소재지':address});
 });
 const token=$('form#realEstateDevForm input[name="_csrf"]').val();
 return {rows,total,token:typeof token==='string'?token.trim():''};
}
function createPublicRequest(fetchImpl=fetch){
 const cookies=new Map();let requests=0;const deadline=Date.now()+8*60*1000;
 return async(path,options={})=>{
  const url=new URL(path,ORIGIN);
  if(url.origin!==ORIGIN||![LIST,PHONE].includes(url.pathname))throw Error('지원하지 않는 경기 명부 경로');
  if(++requests>1000||Date.now()>deadline)throw Error('경기 명부 요청 한도·실행시간 초과: 이전 자료 유지');
  const headers={'Accept':url.pathname===PHONE?'application/json':'text/html',...options.headers};
  if(cookies.size)headers.Cookie=[...cookies].map(([k,v])=>k+'='+v).join('; ');
  let response;
  try{response=await fetchImpl(url,{...options,headers,redirect:'error',signal:AbortSignal.timeout(Math.min(30000,Math.max(1,deadline-Date.now())))});}catch{throw Error('경기 공개 명부 연결 실패');}
  if(!response.ok)throw Error('경기 공개 명부 HTTP '+response.status);
  for(const cookie of response.headers.getSetCookie?.()||[]){const pair=cookie.split(';',1)[0],eq=pair.indexOf('=');if(eq>0)cookies.set(pair.slice(0,eq),pair.slice(eq+1));}
  const parts=[];let size=0;const reader=response.body.getReader();
  for(;;){const r=await reader.read();if(r.done)break;size+=r.value.length;if(size>2*1024*1024){await reader.cancel();throw Error('경기 명부 응답 용량 제한 초과');}parts.push(Buffer.from(r.value));}
  return Buffer.concat(parts).toString('utf8');
 };
}
async function fetchGyeonggi({phoneNames=[],nameKey,request=createPublicRequest()}={}){
 if(typeof nameKey!=='function')throw Error('업체명 비교 함수 필요');
 const names=new Set(phoneNames.map(nameKey)),rows=[],ids=new Set();let total,token;
 for(let page=1;page<=334;page++){
  const result=parsePage(await request(LIST+'?pageIndex='+page+'&pageUnit=30'),page);
  if(total!==undefined&&total!==result.total)throw Error('경기 명부 조회 중 전체 건수 변경');total=result.total;
  if(!result.rows.length||result.rows.length>30)throw Error('경기 명부 일부 페이지 누락');
  token=result.token;
  for(const row of result.rows){if(ids.has(row.등록번호))throw Error('경기 명부 페이지 중복: 이전 자료 유지');ids.add(row.등록번호);rows.push(row);}
  if(rows.length>total||rows.length<total&&result.rows.length!==30)throw Error('경기 명부 전체 건수 불일치');
  if(rows.length===total)break;
 }
 if(rows.length!==total)throw Error('경기 명부 페이지 제한 초과');
 for(const row of rows){
  if(!names.has(nameKey(row.상호)))continue;
  if(!token)throw Error('경기 공개 전화 조회 양식 변경');
  // Same anonymous form and CSRF session used by the public telephone button. No login bypass.
  const body=new URLSearchParams({initGb:'1',pageIndex:'1',pageUnit:'30',sggNm:'',sggCd:'',edRegNo:row.등록번호,ofcAddr:'',searchCondition:'00',searchKeyword:'',_csrf:token});
  const raw=await request(PHONE,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','X-CSRF-TOKEN':token,Referer:ORIGIN+LIST},body:body.toString()});
  let phone;try{phone=JSON.parse(raw);}catch{throw Error('경기 공개 전화 응답 형식 변경');}
  if(phone!==null&&typeof phone!=='string')throw Error('경기 공개 전화 응답 형식 변경');
  row.전화번호=phone||'';
 }
 return rows;
}
module.exports={parsePage,createPublicRequest,fetchGyeonggi};
