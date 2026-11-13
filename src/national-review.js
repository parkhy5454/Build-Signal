const crypto=require('node:crypto');
const cheerio=require('cheerio');
const {provinces}=require('./region-catalog');
const ORIGIN='https://clik.nanet.go.kr';
// These are the source portal's own public region filters, not legal-dong codes.
const STREAMS=[['all','전국·지역 미분류'],['002','서울특별시'],['065','전남광주통합특별시'],['051','부산광역시'],['053','대구광역시'],['032','인천광역시'],['042','대전광역시'],['052','울산광역시'],['044','세종특별자치시'],['031','경기도'],['033','강원특별자치도'],['043','충청북도'],['041','충청남도'],['063','전북특별자치도'],['054','경상북도'],['055','경상남도'],['064','제주특별자치도'],['062','광주광역시'],['061','전라남도']].map(([id,region])=>({id,region}));
const clean=v=>String(v??'').replace(/\s+/g,' ').trim();
const validId=id=>/^CLIKC\d{12,20}$/.test(id);
function listUrl(stream,page=1){
 if(!STREAMS.some(s=>s.id===stream)||!Number.isSafeInteger(page)||page<1||page>10000)throw Error('전국 심의 탐색 조건 오류');
 const p=new URLSearchParams({collection:'policyinfo',query:'건축위원회',searchSelect:'Y',searchGubun:'pi',searchType:'C_ALL',pageIndex:String(page),pageSize:'10',sort:'CDATE/DESC,TITLE/ASC'});
 if(stream!=='all')p.set('piSearch','PQ@@REGION@@'+stream);
 return ORIGIN+'/potal/search/searchList.do?'+p;
}
const detailUrl=id=>{if(!validId(id))throw Error('문서 식별자 오류');return ORIGIN+'/potal/search/searchView.do?collection=policyinfo&DOCID='+id;};
function embeddedResult(html){
 const match=/\bvar\s+result\s*=\s*eval\(\s*/.exec(html);if(!match)throw Error('전국 정책목록 JSON 누락');
 let start=match.index+match[0].length,depth=0,quoted=false,escape=false;
 if(html[start]!=='[')throw Error('전국 정책목록 JSON 형식 변경');
 for(let i=start;i<html.length;i++){
  const c=html[i];if(quoted){if(escape)escape=false;else if(c==='\\')escape=true;else if(c==='"')quoted=false;continue;}
  if(c==='"')quoted=true;else if(c==='['||c==='{')depth++;else if(c===']'||c==='}'){
   depth--;if(depth===0){if(!/^\s*\);/.test(html.slice(i+1,i+20)))throw Error('전국 정책목록 JSON 경계 변경');try{return JSON.parse(html.slice(start,i+1));}catch{throw Error('전국 정책목록 JSON 파싱 실패');}}
  }
 }
 throw Error('전국 정책목록 JSON 종료 누락');
}
function validDate(v){const date=clean(v);if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(+new Date(date+'T00:00:00Z'))||new Date(date+'T00:00:00Z').toISOString().slice(0,10)!==date)throw Error('심의 공개문서 게시일 변경');return date;}
function isReview(title){const t=title.replace(/\s/g,'');return /건축.*(?:위원회|심의).*(?:심의.{0,8}결과|개최.{0,8}결과|회의.{0,8}결과)/.test(t)&&!/(?:후보자|위원모집|공개모집|심의기준|운영기준)/.test(t);}
function parseIndex(html,stream,page=1){
 const $=cheerio.load(html),data=embeddedResult(html);
 const filters=$('input[name=piSearch]').map((_,el)=>$(el).val().replace(/\s/g,'')).get().filter(v=>/^PQ@@REGION@@/.test(v));
 if($('#sSearch_keyword').val()!=='건축위원회'||Number($('#sPageIndex').val())!==page||$('#sCollection').val()!=='policyinfo'||$('#sSearchGubun').val()!=='pi'||(stream==='all'?filters.length:filters.length!==1||filters[0]!=='PQ@@REGION@@'+stream))throw Error('전국 정책목록 검색·지역 조건 불일치');
 if(!Array.isArray(data)||data.length!==1||data[0].collection!=='policyinfo'||!Array.isArray(data[0].list))throw Error('전국 정책목록 컬렉션 변경');
 const d=data[0],raw=clean(d.total);if(!/^\d[\d,]*$/.test(raw))throw Error('전국 정책목록 건수 변경');const total=Number(raw.replace(/,/g,''));
 if(!Number.isSafeInteger(total)||total<0||total>100000||d.list.length!==Math.min(10,Math.max(0,total-(page-1)*10)))throw Error('전국 정책목록 페이지 누락');
 const ids=[],records=[];
 for(const [i,row] of d.list.entries()){
  if(typeof row.row!=='string')throw Error('전국 정책목록 행 변경');const r=cheerio.load(row.row),a=r('dt a[onclick]').first();
  const title=clean(a.text()),m=(a.attr('onclick')||'').match(/fn_detailView\("([^"\n]+)"\)/);
  if(!m)throw Error('전국 정책목록 상세 링크 변경');const u=new URL(m[1],ORIGIN),id=u.searchParams.get('DOCID');
  if(u.origin!==ORIGIN||u.pathname!=='/potal/search/searchView.do'||u.searchParams.get('collection')!=='policyinfo'||!validId(id)||!title||title.length>1000||Number(r('b.ml15').first().text().replace('.',''))!==(page-1)*10+i+1)throw Error('전국 정책목록 식별·순서 변경');
  ids.push(id);const meta=r('dd').filter((_,el)=>r(el).children('b').length).first();meta.children('b').remove();const fields=meta.text().split('|').map(clean);
  if(fields.length!==3||!fields[0])throw Error('전국 정책목록 발행기관 변경');const date=validDate(fields[2]);
  if(isReview(title))records.push({id,title,publisher:fields[0],publishedDate:date,indexUrl:detailUrl(id),publisherRegion:stream==='all'?null:STREAMS.find(s=>s.id===stream).region});
 }
 const listed=String(d.cnList?.cnList||'').split(',').map(clean).filter(Boolean);if(JSON.stringify(ids)!==JSON.stringify(listed)||new Set(ids).size!==ids.length)throw Error('전국 정책목록 중복·목록 불일치');
 return {total,pages:Math.max(1,Math.ceil(total/10)),records};
}
function officialSource(value){try{const u=new URL(value);if(!['https:','http:'].includes(u.protocol)||u.username||u.password||u.port||!u.hostname.endsWith('.go.kr'))return null;return u.href;}catch{return null;}}
function parseDetail(html,record){
 const $=cheerio.load(html),info=String($('#dataInfo').val()||'').split('┼');
 const cells=new Map();$('table.boardview tr').each((_,el)=>{const th=$(el).children('th'),td=$(el).children('td');if(th.length===1&&td.length===1){const key=clean(th.text());if(cells.has(key))throw Error('전국 심의 상세 필드 중복');cells.set(key,td);}});
 if(info[0]!==record.id||info[1]!=='policyinfo'||clean($('#contentSj').text())!==record.title||clean(cells.get('제어번호')?.text())!==record.id||clean(cells.get('수집사이트명')?.text())!==record.publisher||validDate(cells.get('게시일')?.text())!==record.publishedDate)throw Error('전국 심의 상세 문서 식별정보 변경');
 const urls=cells.get('원문URL')?.find('a.content_url').map((_,el)=>officialSource($(el).attr('href'))).get()||[];
 if(urls.length!==1||!urls[0])throw Error('공식 지자체 원문 링크 확인 필요');
 return {...record,originalUrl:urls[0]};
}
async function download(url){
 const u=new URL(url);if(u.origin!==ORIGIN||u.username||u.password||!['/potal/search/searchList.do','/potal/search/searchView.do'].includes(u.pathname)||u.searchParams.get('collection')!=='policyinfo')throw Error('허용하지 않은 전국 심의 출처');
 const r=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(25000)});if(!r.ok)throw Error('전국 심의 공개목록 HTTP '+r.status);
 const parts=[];let size=0;for await(const b of r.body){size+=b.length;if(size>2*1024*1024)throw Error('전국 심의 응답 2MB 초과');parts.push(Buffer.from(b));}return Buffer.concat(parts).toString('utf8');
}
function createNationalReviewCollector({query,transaction,env=process.env,load=download}){
 let active=false,timer;
 async function run(){
  if(active||env.AUTO_INGEST_ENABLED==='false')return;active=true;const token=crypto.randomUUID();let claimed=false;
  try{
   const c=await query("UPDATE auto_ingest_state SET lease_token=$1,lease_until=NOW()+INTERVAL '10 minutes',last_attempt_at=NOW() WHERE source='national_review' AND next_due_at<=NOW() AND (lease_until IS NULL OR lease_until<NOW()) RETURNING source",[token]);if(!c.rows.length)return;claimed=true;
   for(const s of STREAMS)await query('INSERT INTO national_review_streams(id,region) VALUES($1,$2) ON CONFLICT(id) DO NOTHING',[s.id,s.region]);
   const end=Date.now()+8*60000;
   const request=async url=>{if(Date.now()>end)throw Error('전국 심의 실행시간 한도');const r=await query(`UPDATE auto_ingest_state SET daily_calls=CASE WHEN call_day=(NOW() AT TIME ZONE 'Asia/Seoul')::date THEN daily_calls+1 ELSE 1 END,call_day=(NOW() AT TIME ZONE 'Asia/Seoul')::date WHERE source='national_review' AND lease_token=$1 AND lease_until>NOW() AND (call_day IS DISTINCT FROM (NOW() AT TIME ZONE 'Asia/Seoul')::date OR daily_calls<300) RETURNING source`,[token]);if(!r.rows.length)throw Error('전국 심의 호출 한도 또는 실행권 만료');return load(url);};
   const owned=async q=>{const r=await q("SELECT source FROM auto_ingest_state WHERE source='national_review' AND lease_token=$1 AND lease_until>NOW() FOR UPDATE",[token]);if(!r.rows.length)throw Error('전국 심의 실행권 만료');};
   let success=0,failures=0;
   const pending=(await query("SELECT COUNT(*)::int n FROM national_review_notices WHERE status='pending'")).rows[0].n;
   const streams=await query(`SELECT *,next_latest_at<=NOW() AS latest_due FROM national_review_streams WHERE retry_at<=NOW() AND (next_latest_at<=NOW() OR (next_archive_at<=NOW() AND $1<100)) ORDER BY last_attempt_at NULLS FIRST,id LIMIT 4`,[pending]);
   for(const s of streams.rows){
    const page=s.latest_due?1:s.archive_page;
    try{
     const d=parseIndex(await request(listUrl(s.id,page)),s.id,page);
     await transaction(async q=>{await owned(q);
      for(const r of d.records){const publisherRegion=r.publisherRegion?provinces.find(p=>p.aliases.includes(r.publisherRegion))?.value||r.publisherRegion:null;
       await q(`INSERT INTO national_review_notices(doc_id,title,publisher,publisher_region,published_date,index_url) VALUES($1,$2,$3,$4,$5,$6)
        ON CONFLICT(doc_id) DO UPDATE SET title=EXCLUDED.title,publisher=EXCLUDED.publisher,publisher_region=COALESCE(EXCLUDED.publisher_region,national_review_notices.publisher_region),published_date=EXCLUDED.published_date,
        status=CASE WHEN national_review_notices.title<>EXCLUDED.title OR national_review_notices.publisher<>EXCLUDED.publisher OR national_review_notices.published_date<>EXCLUDED.published_date THEN 'pending' ELSE national_review_notices.status END,
        next_due_at=CASE WHEN national_review_notices.title<>EXCLUDED.title OR national_review_notices.publisher<>EXCLUDED.publisher OR national_review_notices.published_date<>EXCLUDED.published_date THEN NOW() ELSE national_review_notices.next_due_at END`,[r.id,r.title,r.publisher,publisherRegion,r.publishedDate,r.indexUrl]);
       if(publisherRegion)await q('INSERT INTO national_review_notice_regions(doc_id,region) VALUES($1,$2) ON CONFLICT DO NOTHING',[r.id,publisherRegion]);
      }
      if(s.latest_due)await q("UPDATE national_review_streams SET last_attempt_at=NOW(),last_success_at=NOW(),last_error=NULL,index_count=$2,next_latest_at=NOW()+INTERVAL '24 hours' WHERE id=$1",[s.id,d.total]);
      else await q(`UPDATE national_review_streams SET last_attempt_at=NOW(),last_success_at=NOW(),last_error=NULL,index_count=$2,archive_page=$3,next_archive_at=NOW()+($4::int*INTERVAL '1 second'),last_cycle_at=CASE WHEN $5 THEN NOW() ELSE last_cycle_at END WHERE id=$1`,[s.id,d.total,page>=d.pages?2:page+1,page>=d.pages?604800:60,page>=d.pages]);
     });success++;
    }catch(e){failures++;if(/한도|실행권/.test(e.message))break;await query("UPDATE national_review_streams SET last_attempt_at=NOW(),last_error=$2,retry_at=NOW()+INTERVAL '2 hours' WHERE id=$1",[s.id,String(e.message).slice(0,250)]);}
   }
   const docs=await query("SELECT * FROM national_review_notices WHERE next_due_at<=NOW() ORDER BY CASE status WHEN 'pending' THEN 0 WHEN 'error' THEN 1 ELSE 2 END,published_date DESC,doc_id LIMIT 10");
   for(const row of docs.rows){try{
    const record={id:row.doc_id,title:row.title,publisher:row.publisher,publishedDate:typeof row.published_date==='string'?row.published_date.slice(0,10):row.published_date.toISOString().slice(0,10),publisherRegion:row.publisher_region,indexUrl:row.index_url};
    const d=parseDetail(await request(detailUrl(row.doc_id)),record);
    await transaction(async q=>{await owned(q);await q("UPDATE national_review_notices SET original_url=$2,status='checked',last_error=NULL,last_checked_at=NOW(),next_due_at=NOW()+INTERVAL '30 days' WHERE doc_id=$1",[row.doc_id,d.originalUrl]);});success++;
   }catch(e){failures++;if(/한도|실행권/.test(e.message))break;await query("UPDATE national_review_notices SET status='error',last_error=$2,next_due_at=NOW()+INTERVAL '2 days' WHERE doc_id=$1",[row.doc_id,String(e.message).slice(0,250)]);}}
   await query(`UPDATE auto_ingest_state SET last_success_at=CASE WHEN $2>0 THEN NOW() ELSE last_success_at END,last_error=$3,lease_token=NULL,lease_until=NULL,next_due_at=NOW()+($4::int*INTERVAL '1 second') WHERE source='national_review' AND lease_token=$1`,[token,success,failures?failures+'개 전국 심의 조회 실패 · 자동 재시도':null,failures?600:60]);
  }catch(e){if(claimed)await query("UPDATE auto_ingest_state SET last_error=$2,lease_token=NULL,lease_until=NULL,next_due_at=NOW()+INTERVAL '10 minutes' WHERE source='national_review' AND lease_token=$1",[token,String(e.message).slice(0,250)]).catch(()=>{});}finally{active=false;}
 }
 return {run,start(){if(timer)return;timer=setInterval(()=>void run(),60000);timer.unref?.();void run();}};
}
module.exports={STREAMS,ORIGIN,listUrl,detailUrl,embeddedResult,parseIndex,parseDetail,isReview,officialSource,download,createNationalReviewCollector};
