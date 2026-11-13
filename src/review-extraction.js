const crypto=require('node:crypto'),cheerio=require('cheerio');
const {PDFParse}=require('pdf-parse');
const {normalizeEvidence,insertEvidence}=require('./early-projects');
const ORIGIN='https://www.incheon.go.kr',BOARD=ORIGIN+'/build/BU050101',VERSION='incheon-agenda-owner-v1';
const clean=v=>String(v??'').normalize('NFKC').replace(/\s+/g,' ').trim();
const hash=v=>crypto.createHash('sha256').update(v).digest('hex');
function articleUrl(value){try{const u=new URL(value);return u.origin===ORIGIN&&!u.username&&!u.password&&/^\/build\/BU050101\/\d+$/.test(u.pathname)&&!u.search?u.href:null;}catch{return null;}}
function discoverArticles(html){
 const $=cheerio.load(html),found=new Map();$('a[href]').each((_,el)=>{const a=$(el),title=clean(a.text()),u=new URL(a.attr('href'),BOARD);
  if(/건축.*위원회.*심의.*결과/.test(title)&&articleUrl(u.href))found.set(u.href,{url:u.href,title});
 });if(!found.size)throw Error('인천 건축위원회 공개 목록 서식 변경');return [...found.values()].slice(0,10);
}
function discoverFiles(html,url){
 const page=articleUrl(url);if(!page)throw Error('지원하지 않는 심의 원문 출처');
 const id=new URL(page).pathname.split('/').at(-1),$=cheerio.load(html),files=[];
 $('.file-preview-down-group').each((_,el)=>{const root=$(el),name=clean(root.find('.file-name').text()),links=root.find('a[href]').map((_,a)=>new URL($(a).attr('href'),ORIGIN).href).get();
  const downloads=links.filter(value=>new URL(value).pathname==='/comm/getFile');if(downloads.length!==1)throw Error('심의 첨부 다운로드 경로 변경');
  const u=new URL(downloads[0]);if(u.origin!==ORIGIN||u.searchParams.get('upperNo')!==id||u.searchParams.get('srvcId')!=='BBSTY1'||u.searchParams.get('fileTy')!=='ATTACH'||!/^\d+$/.test(u.searchParams.get('fileNo')||''))throw Error('심의 첨부 게시물 식별정보 불일치');
  if(!name||name.length>500)throw Error('심의 첨부 파일명 변경');files.push({url:u.href,pageUrl:page,name,format:/\.pdf$/i.test(name)?'pdf':/\.hwpx?$/i.test(name)?'hangul':'other'});
 });if(!files.length)throw Error('심의 원문 첨부 목록을 확인하지 못했습니다.');
 if(new Set(files.map(f=>f.url)).size!==files.length||files.length>20)throw Error('심의 첨부 중복 또는 처리 한도 초과');return files;
}
function exactly(values,label){const v=[...new Set(values.map(clean))];if(v.length!==1||!v[0])throw Error('심의 PDF '+label+' 누락·복수 값·서식 변경');return v[0];}
function parseIncheon(text,fileName){
 const t=text.replace(/\r/g,'').replace(/[\t ]+/g,' '),meeting=t.match(/^(\d{4})년 제(\d{1,3})회 건축경관공동위원회 심의 결과\s*$/m);
 if(!meeting)throw Error('지원하지 않는 심의 PDF 서식');
 const named=clean(fileName).match(/(\d{4})년 제(\d{1,3})회/);if(named&&(named[1]!==meeting[1]||Number(named[2])!==Number(meeting[2])))throw Error('심의 PDF 파일명·본문 회차 불일치');
 const markers=[...t.matchAll(/^\[(\d{1,3})호 안건: (.+)\]\s*$/gm)];if(!markers.length||markers.length>30||new Set(markers.map(m=>m[1])).size!==markers.length)throw Error('심의 PDF 안건 경계 누락·중복');
 // Each agenda is parsed as an independent block. Recommendation text is never a party field.
 return markers.map((marker,i)=>{
  const block=t.slice(marker.index,markers[i+1]?.index??t.length),end=block.indexOf('\n심의내용\n');if(end<0)throw Error('심의 PDF 기본정보 표 경계 변경');const header=block.slice(0,end);
  const dates=[...header.matchAll(/심의일자 (\d{4})\.\s*(\d{1,2})\.\s*(\d{1,2})\./g)].map(m=>m[1]+'-'+m[2].padStart(2,'0')+'-'+m[3].padStart(2,'0'));
  const date=exactly(dates,'심의일');if(!Number.isFinite(+new Date(date+'T00:00:00Z'))||new Date(date+'T00:00:00Z').toISOString().slice(0,10)!==date||date.slice(0,4)!==meeting[1])throw Error('심의 PDF 심의일 형식 변경');
  const address=exactly([...header.matchAll(/^대지현황\n([\s\S]{1,400}?) 관련지번\s*$/gm)].map(m=>m[1]),'대지현황');if(!/^인천광역시 [가-힣]+(?:구|군) /.test(address))throw Error('심의 PDF 현장 주소 형식 변경');
  const owners=[...header.matchAll(/^건축주 성명\(법인명\) (.+)$/gm)].map(m=>m[1]);const owner=exactly(owners,'건축주');
  const resultBlock=block.split('\n심의결과\n').at(-1).split('※ 작성기준')[0];const checks=[...resultBlock.matchAll(/\[\s*[○◯]\s*\]\s*(원안 의결|조건부 의결|재검토 의결|부결)/g)].map(m=>m[1]);const result=exactly(checks,'의결 결과');
  const purposes=header.match(/^주용도 ([\s\S]{1,120}?) 구조 /m)?.[1],area=header.match(/연면적 합계 ([\d,]+(?:\.\d+)?)m?2?/);
  if(area&&!Number.isFinite(Number(area[1].replace(/,/g,''))))throw Error('심의 PDF 연면적 형식 변경');
  const name=clean(marker[2]);if(name.length>500||address.length>500||owner.length>200)throw Error('심의 PDF 필드 길이 초과');
  const parties=/[*○◯●□]|비공개|미제공|해당없음/.test(owner)?[]:[{role:'owner',organization:owner,excerpt:'건축주 성명(법인명): '+owner}];
  return {key:meeting[1]+'-'+meeting[2]+'-'+marker[1],name,address,date,region:'인천광역시',buildingType:purposes?clean(purposes):null,area:area?Number(area[1].replace(/,/g,'')):null,result,parties};
 });
}
async function extractPdf(bytes){if(bytes.subarray(0,5).toString()!=='%PDF-')throw Error('첨부가 PDF 응답이 아닙니다.');const p=new PDFParse({data:bytes});try{const info=await p.getInfo();if(info.total>60)throw Error('심의 PDF 60페이지 처리 한도');const text=(await p.getText()).text;if(text.length>300000)throw Error('심의 PDF 텍스트 처리 한도');return text;}finally{await p.destroy();}}
async function download(url){
 const u=new URL(url),article=articleUrl(url),board=u.href===BOARD,file=u.pathname==='/comm/getFile'&&u.searchParams.get('srvcId')==='BBSTY1'&&u.searchParams.get('fileTy')==='ATTACH'&&/^\d+$/.test(u.searchParams.get('upperNo')||'')&&/^\d+$/.test(u.searchParams.get('fileNo')||'');
 if(u.origin!==ORIGIN||u.username||u.password||!(article||board||file))throw Error('허용되지 않은 심의 첨부 출처');
 const r=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(25000)});if(!r.ok)throw Error('심의 원문 HTTP '+r.status);const parts=[];let n=0;
 for await(const chunk of r.body){n+=chunk.length;if(n>5*1024*1024)throw Error('심의 원문 5MB 한도');parts.push(Buffer.from(chunk));}return Buffer.concat(parts);
}
async function saveExtracted(transaction,file,bytes,records,token){
 await transaction(async q=>{
  const owned=await q("SELECT source FROM auto_ingest_state WHERE source='review_extract' AND lease_token=$1 AND lease_until>NOW() FOR UPDATE",[token]);if(!owned.rows.length)throw Error('심의 원문 실행권 만료');
  const contentHash=hash(bytes),previous=await q('SELECT content_hash,parser_version FROM review_extract_files WHERE url=$1',[file.url]);
  if(previous.rows[0]?.content_hash!==contentHash||previous.rows[0]?.parser_version!==VERSION){
   await q('UPDATE review_extracted_projects SET is_current=FALSE WHERE file_url=$1',[file.url]);
   for(const r of records){const p=await q(`INSERT INTO projects(source,external_id,name,address,region,building_type,area_sqm,stage,source_url,source_updated_at)
    VALUES('document_review',$1,$2,$3,$4,$5,$6,'REVIEW',$7,$8) ON CONFLICT(source,external_id) DO UPDATE SET name=EXCLUDED.name,address=EXCLUDED.address,building_type=EXCLUDED.building_type,area_sqm=EXCLUDED.area_sqm,source_updated_at=EXCLUDED.source_updated_at,updated_at=NOW() RETURNING id`,[hash(file.url+'#'+r.key),r.name,r.address,r.region,r.buildingType,r.area,file.url,r.date]);
    const projectId=p.rows[0].id;await q(`INSERT INTO architectural_review_details(project_id,committee_name,decision_no,decision_result,post_url) VALUES($1,'인천광역시 건축경관공동위원회',$2,$3,$4) ON CONFLICT(project_id) DO UPDATE SET decision_result=EXCLUDED.decision_result,post_url=EXCLUDED.post_url`,[projectId,r.key,r.result,file.page_url]);
    for(const party of r.parties)await insertEvidence(q,projectId,normalizeEvidence({...party,source_url:file.url,stage:'REVIEW'}),'automatic');
    await q('INSERT INTO review_extracted_projects(file_url,project_id,case_key) VALUES($1,$2,$3) ON CONFLICT(file_url,case_key) DO UPDATE SET is_current=TRUE',[file.url,projectId,r.key]);
   }
  }
  await q("UPDATE review_extract_files SET status='extracted',content_hash=$2,parser_version=$3,record_count=$4,last_error=NULL,last_checked_at=NOW(),next_due_at=NOW()+INTERVAL '7 days' WHERE url=$1",[file.url,contentHash,VERSION,records.length]);
 });
}
function createReviewExtractor({query,transaction,env=process.env,load=download,pdfText=extractPdf}){
 let active=false,timer;
 async function run(){
  if(active||env.AUTO_INGEST_ENABLED==='false')return;active=true;const token=crypto.randomUUID();let claimed=false;
  try{
   const c=await query("UPDATE auto_ingest_state SET lease_token=$1,lease_until=NOW()+INTERVAL '10 minutes',last_attempt_at=NOW() WHERE source='review_extract' AND next_due_at<=NOW() AND (lease_until IS NULL OR lease_until<NOW()) RETURNING source",[token]);if(!c.rows.length)return;claimed=true;
   const end=Date.now()+8*60000;let successes=0,errors=0;
   const request=async url=>{if(Date.now()>end)throw Error('심의 원문 실행시간 한도');const r=await query(`UPDATE auto_ingest_state SET daily_calls=CASE WHEN call_day=(NOW() AT TIME ZONE 'Asia/Seoul')::date THEN daily_calls+1 ELSE 1 END,call_day=(NOW() AT TIME ZONE 'Asia/Seoul')::date WHERE source='review_extract' AND lease_token=$1 AND lease_until>NOW() AND (call_day IS DISTINCT FROM (NOW() AT TIME ZONE 'Asia/Seoul')::date OR daily_calls<100) RETURNING source`,[token]);if(!r.rows.length)throw Error('심의 원문 호출 한도 또는 실행권 만료');return load(url);};
   const owned=async q=>{const r=await q("SELECT source FROM auto_ingest_state WHERE source='review_extract' AND lease_token=$1 AND lease_until>NOW() FOR UPDATE",[token]);if(!r.rows.length)throw Error('심의 원문 실행권 만료');};
   const state=(await query('SELECT next_discovery_at<=NOW() AS due FROM review_extract_state WHERE id=1')).rows[0];
   if(state?.due){try{
    const pages=discoverArticles((await request(BOARD)).toString('utf8'));
    await transaction(async q=>{await owned(q);for(const page of pages)await q('INSERT INTO review_extract_pages(url,title) VALUES($1,$2) ON CONFLICT(url) DO NOTHING',[page.url,page.title]);await q("UPDATE review_extract_state SET next_discovery_at=NOW()+INTERVAL '24 hours' WHERE id=1");});successes++;
   }catch(e){errors++;await query("UPDATE review_extract_state SET next_discovery_at=NOW()+INTERVAL '2 hours' WHERE id=1");}}
   const notices=await query("SELECT original_url,title FROM national_review_notices WHERE status='checked' AND original_url IS NOT NULL");
   for(const notice of notices.rows)if(articleUrl(notice.original_url))await query('INSERT INTO review_extract_pages(url,title) VALUES($1,$2) ON CONFLICT(url) DO NOTHING',[notice.original_url,notice.title]);
   const pages=await query("SELECT * FROM review_extract_pages WHERE next_due_at<=NOW() ORDER BY last_checked_at NULLS FIRST,next_due_at LIMIT 5");
   for(const page of pages.rows){try{
    const files=discoverFiles((await request(page.url)).toString('utf8'),page.url);
    await transaction(async q=>{await owned(q);for(const f of files)await q(`INSERT INTO review_extract_files(url,page_url,name,format,status,last_error) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(url) DO UPDATE SET name=EXCLUDED.name`,[f.url,f.pageUrl,f.name,f.format,f.format==='pdf'?'pending':'unsupported',f.format==='pdf'?null:'PDF 외 첨부는 아직 자동 분석하지 않습니다.']);await q("UPDATE review_extract_pages SET last_checked_at=NOW(),last_error=NULL,next_due_at=NOW()+INTERVAL '7 days' WHERE url=$1",[page.url]);});successes++;
   }catch(e){errors++;if(/호출 한도|실행시간 한도|실행권/.test(e.message))break;await query("UPDATE review_extract_pages SET last_error=$2,last_checked_at=NOW(),next_due_at=NOW()+INTERVAL '2 days' WHERE url=$1",[page.url,String(e.message).slice(0,250)]);}}
   const files=await query("SELECT * FROM review_extract_files WHERE format='pdf' AND next_due_at<=NOW() ORDER BY CASE status WHEN 'pending' THEN 0 WHEN 'error' THEN 1 ELSE 2 END,last_checked_at NULLS FIRST LIMIT 5");
   for(const file of files.rows){try{const bytes=await request(file.url),records=parseIncheon(await pdfText(bytes),file.name);await saveExtracted(transaction,file,bytes,records,token);successes++;}
   catch(e){errors++;if(/호출 한도|실행시간 한도|실행권/.test(e.message))break;const unsupported=/서식|경계|기본정보|누락|중복|형식|의결 결과|처리 한도|5MB/.test(e.message);await query("UPDATE review_extract_files SET status=$2,last_error=$3,last_checked_at=NOW(),next_due_at=NOW()+($4::int*INTERVAL '1 day') WHERE url=$1",[file.url,unsupported?'unsupported':'error',String(e.message).slice(0,250),unsupported?7:2]);}}
   await query(`UPDATE auto_ingest_state SET last_success_at=CASE WHEN $2>0 THEN NOW() ELSE last_success_at END,last_error=$3,lease_token=NULL,lease_until=NULL,next_due_at=NOW()+($4::int*INTERVAL '1 second') WHERE source='review_extract' AND lease_token=$1`,[token,successes,errors?errors+'개 심의 원문 미처리 · 형식별 상태 확인':null,errors?3600:60]);
  }catch(e){if(claimed)await query("UPDATE auto_ingest_state SET last_error=$2,lease_token=NULL,lease_until=NULL,next_due_at=NOW()+INTERVAL '2 hours' WHERE source='review_extract' AND lease_token=$1",[token,String(e.message).slice(0,250)]).catch(()=>{});}finally{active=false;}
 }
 return {run,start(){if(timer)return;timer=setInterval(()=>void run(),60000);timer.unref?.();void run();}};
}
module.exports={BOARD,VERSION,articleUrl,discoverArticles,discoverFiles,parseIncheon,extractPdf,download,saveExtracted,createReviewExtractor};
