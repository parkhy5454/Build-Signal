const crypto=require('node:crypto');
const {PDFParse}=require('pdf-parse');
const {municipalitiesForProvince}=require('./region-catalog');
const ORIGIN='https://seoulboard.seoul.go.kr',BOARD='14637';
const clean=v=>String(v??'').normalize('NFKC').replace(/\s+/g,' ').trim();
const digest=v=>crypto.createHash('sha256').update(v).digest('hex');
function listPosts(d){
 if(d.listAuthorCheck!==true||String(d.bbsSettingVO?.bbsNo)!==BOARD||!Array.isArray(d.listVO?.listObject)||Number(d.listVO.curPage)!==1)throw Error('서울 건축심의 공개목록 명세·권한 변경');
 return d.listVO.listObject.filter(r=>r.secretAt==='N').map(r=>{if(String(r.bbsNo)!==BOARD||(!Number.isSafeInteger(Number(r.nttNo))||Number(r.nttNo)<=0))throw Error('서울 심의 게시물 식별정보 변경');return Number(r.nttNo);}).slice(0,10);
}
function postFiles(d,id){
 const r=d.bbsTypeVO,rights=d.bbsSettingVO?.nmbrAuthor;
 if(!r||String(r.bbsNo)!==BOARD||Number(r.nttNo)!==id||r.secretAt!=='N'||r.deleteAt!=='N'||!Array.isArray(rights)||!rights.includes('_view')||!rights.includes('_dwld'))throw Error('서울 심의 게시물 비공개·권한 또는 식별정보 변경');
 if(!Array.isArray(r.bbsFileList))throw Error('서울 심의 첨부목록 변경');
 return r.bbsFileList.filter(f=>f.useAt==='Y'&&/^심의의결조서\(.+\)\.pdf$/i.test(f.orginlFileNm||'')&&f.fileExtsn==='pdf').map(f=>{
  if(String(f.bbsNo)!==BOARD||Number(f.upperNo)!==id||f.srvcId!=='BBSTY1'||f.fileTy!=='ATTACH'||!Number.isSafeInteger(Number(f.fileNo))||Number(f.fileNo)<=0||!Number.isFinite(Number(f.fileSize))||Number(f.fileSize)<=0||Number(f.fileSize)>2*1024*1024)throw Error('서울 심의 첨부파일 식별정보·크기 확인 필요');
  const url=ORIGIN+'/comm/getFile?'+new URLSearchParams({srvcId:'BBSTY1',upperNo:String(id),fileTy:'ATTACH',fileNo:String(f.fileNo),bbsNo:BOARD});
  return {url,name:f.orginlFileNm,postId:id,fileNo:Number(f.fileNo),revision:digest(JSON.stringify([f.streFileNm,f.creatDttm,f.fileSize,f.orginlFileNm])),postUrl:'https://news.seoul.go.kr/citybuild/architecture-committee-result#view/'+id};
 });
}
function single(values,label){const unique=[...new Set(values.map(clean))];if(unique.length!==1||!unique[0])throw Error('서울 의결조서 '+label+' 누락·복수 안건·서식 변경');return unique[0];}
function parseDecision(text,file){
 const t=text.replace(/\r/g,'');if(!/^건축위원회[ \t]+심의의결조서[ \t]*$/m.test(t))throw Error('지원하지 않는 서울 심의 PDF 서식');
 const name=single([...t.matchAll(/^사[ \t]*업[ \t]*명[ \t]+([^\n]+)/gm)].map(m=>m[1]),'사업명');
 const location=single([...t.matchAll(/^신청위치[ \t]+([^\n]+)/gm)].map(m=>m[1]),'신청위치');
 const dates=[...t.matchAll(/^심의일시\/장소[ \t]+(\d{4})\.[ \t]*(\d{1,2})\.[ \t]*(\d{1,2})\./gm)].map(m=>m[1]+'-'+m[2].padStart(2,'0')+'-'+m[3].padStart(2,'0'));
 const date=single(dates,'심의일');const parsed=new Date(date+'T00:00:00Z');if(!Number.isFinite(+parsed)||parsed.toISOString().slice(0,10)!==date)throw Error('서울 심의일 형식 변경');
 const decisions=[...t.matchAll(/^의결번호[ \t]+(\d{4}-\d{1,3}-\d{1,3})[ \t]+심의결과[ \t]+([^\n]+)/gm)];
 const number=single(decisions.map(m=>m[1]),'의결번호'),result=single(decisions.map(m=>m[2]),'심의결과');
 const expected=(file.name.match(/^심의의결조서\((.+)\)\.pdf$/i)||[])[1];if(!expected||clean(expected).replace(/\s/g,'')!==name.replace(/\s/g,''))throw Error('서울 PDF 파일명·본문 사업명 불일치');
 const address=location.startsWith('서울특별시 ')?location:'서울특별시 '+location;
 const district=address.split(' ')[1];if(!municipalitiesForProvince('11').includes(district)||name.length>500||address.length>500||result.length>200)throw Error('서울 의결조서 사업위치·필드 확인 필요');
 const subjects=[...t.matchAll(/^\[심의[ \t]*내용\][ \t]+([^\n]+)/gm)].map(m=>m[1]);
 return {name,address,date,number,result,subject:subjects.length?single(subjects,'심의내용'):null,file};
}
async function download(url){
 const u=new URL(url);if(u.origin!==ORIGIN||u.username||u.password||!(u.pathname==='/front/bbs.json'||/^\/front\/\d+\/bbs\.json$/.test(u.pathname)||u.pathname==='/comm/getFile')||u.searchParams.get('bbsNo')!==BOARD)throw Error('허용되지 않은 서울 공개 출처');
 let r;try{r=await fetch(u,{redirect:'error',signal:AbortSignal.timeout(25000)});}catch{throw Error('서울 심의자료 연결 실패');}if(!r.ok)throw Error('서울 심의자료 HTTP '+r.status);
 const chunks=[];let bytes=0;const reader=r.body.getReader();for(;;){const p=await reader.read();if(p.done)break;bytes+=p.value.length;if(bytes>2*1024*1024){await reader.cancel();throw Error('서울 심의자료 2MB 한도 초과');}chunks.push(Buffer.from(p.value));}return Buffer.concat(chunks);
}
async function extract(bytes){if(bytes.subarray(0,5).toString()!=='%PDF-')throw Error('서울 의결조서가 PDF 응답이 아닙니다.');const p=new PDFParse({data:bytes});try{return (await p.getText()).text;}finally{await p.destroy();}}
async function saveDecision(transaction,record,token){
 await transaction(async q=>{
  const owner=await q("SELECT source FROM auto_ingest_state WHERE source='seoul_review' AND lease_token=$1 AND lease_until>NOW() FOR UPDATE",[token]);if(!owner.rows.length)throw Error('서울 심의 수집 실행권 만료');
  const fingerprint=digest(JSON.stringify(record));const old=await q('SELECT content_hash FROM early_source_documents WHERE url=$1',[record.file.url]);
  if(old.rows[0]?.content_hash!==fingerprint){
   const p=await q(`INSERT INTO projects(source,external_id,name,address,region,building_type,stage,source_url,source_updated_at)
    VALUES('seoul_review',$1,$2,$3,'서울특별시',$4,'REVIEW',$5,$6) ON CONFLICT(source,external_id) DO UPDATE SET name=EXCLUDED.name,address=EXCLUDED.address,building_type=EXCLUDED.building_type,source_url=EXCLUDED.source_url,source_updated_at=EXCLUDED.source_updated_at,updated_at=NOW() RETURNING id`,[record.number,record.name,record.address,record.subject,record.file.url,record.date]);
   await q(`INSERT INTO architectural_review_details(project_id,committee_name,decision_no,decision_result,post_url) VALUES($1,'서울특별시 건축위원회',$2,$3,$4)
    ON CONFLICT(project_id) DO UPDATE SET decision_result=EXCLUDED.decision_result,post_url=EXCLUDED.post_url`,[p.rows[0].id,record.number,record.result,record.file.postUrl]);
  }
  await q(`INSERT INTO early_source_documents(url,title,content_hash,record_count,last_checked_at,last_error) VALUES($1,$2,$3,1,NOW(),NULL)
   ON CONFLICT(url) DO UPDATE SET title=EXCLUDED.title,content_hash=EXCLUDED.content_hash,record_count=1,last_checked_at=NOW(),last_error=NULL`,[record.file.url,record.name,fingerprint]);
  await q("UPDATE seoul_review_files SET status='processed',last_error=NULL,last_processed_at=NOW(),next_due_at=NOW()+INTERVAL '7 days' WHERE url=$1",[record.file.url]);
 });
}
function createSeoulCollector({query,transaction,env=process.env,load=download,pdfText=extract}){
 let active=false,timer;
 async function run(){
  if(active||env.AUTO_INGEST_ENABLED==='false')return;active=true;const token=crypto.randomUUID();let claimed=false;
  try{
   const claim=await query("UPDATE auto_ingest_state SET lease_token=$1,lease_until=NOW()+INTERVAL '10 minutes',last_attempt_at=NOW() WHERE source='seoul_review' AND next_due_at<=NOW() AND (lease_until IS NULL OR lease_until<NOW()) RETURNING source",[token]);if(!claim.rows.length)return;claimed=true;
   const deadline=Date.now()+8*60000;
   const fetchBytes=async url=>{if(Date.now()>deadline)throw Error('서울 심의 실행시간 한도');const n=await query(`UPDATE auto_ingest_state SET daily_calls=CASE WHEN call_day=(NOW() AT TIME ZONE 'Asia/Seoul')::date THEN daily_calls+1 ELSE 1 END,call_day=(NOW() AT TIME ZONE 'Asia/Seoul')::date WHERE source='seoul_review' AND lease_token=$1 AND lease_until>NOW() AND (call_day IS DISTINCT FROM (NOW() AT TIME ZONE 'Asia/Seoul')::date OR daily_calls<100) RETURNING source`,[token]);if(!n.rows.length)throw Error('서울 심의 호출 한도 또는 실행권 만료');return load(url);};
   const json=async url=>{try{return JSON.parse((await fetchBytes(url)).toString('utf8'));}catch(e){if(e instanceof SyntaxError)throw Error('서울 공개 JSON 응답 변경');throw e;}};
   let processed=0,failed=0,discovered=false;
   const due=await query('SELECT next_discovery_at<=NOW() AS due FROM seoul_review_state WHERE id=1');
   if(due.rows[0]?.due){
    try{
     const ids=listPosts(await json(ORIGIN+'/front/bbs.json?bbsNo='+BOARD+'&curPage=1&cntPerPage=10'));
     let discoveryFailures=0;
     for(const id of ids){try{for(const file of postFiles(await json(ORIGIN+'/front/'+id+'/bbs.json?bbsNo='+BOARD+'&nttNo='+id),id)){
      await query(`INSERT INTO seoul_review_files(url,post_id,file_no,original_name,post_url,revision) VALUES($1,$2,$3,$4,$5,$6)
       ON CONFLICT(url) DO UPDATE SET original_name=EXCLUDED.original_name,revision=EXCLUDED.revision,
       status=CASE WHEN seoul_review_files.revision<>EXCLUDED.revision THEN 'pending' ELSE seoul_review_files.status END,
       next_due_at=CASE WHEN seoul_review_files.revision<>EXCLUDED.revision THEN NOW() ELSE seoul_review_files.next_due_at END`,[file.url,file.postId,file.fileNo,file.name,file.postUrl,file.revision]);
     }}catch(e){discoveryFailures++;await query(`INSERT INTO early_source_documents(url,title,last_error,last_checked_at) VALUES($1,$2,$3,NOW()) ON CONFLICT(url) DO UPDATE SET last_error=EXCLUDED.last_error,last_checked_at=NOW()`,['https://news.seoul.go.kr/citybuild/architecture-committee-result#view/'+id,'서울시 건축위원회 게시물',String(e.message).slice(0,250)]);}}
     failed+=discoveryFailures;
     await query("UPDATE seoul_review_state SET next_discovery_at=NOW()+($1::int*INTERVAL '1 hour') WHERE id=1",[discoveryFailures?2:24]);discovered=true;
    }catch{failed++;await query("UPDATE seoul_review_state SET next_discovery_at=NOW()+INTERVAL '2 hours' WHERE id=1");}
   }
   const fileError=async(row,e)=>{await query("UPDATE seoul_review_files SET status='error',last_error=$2,next_due_at=NOW()+INTERVAL '2 days' WHERE url=$1",[row.url,String(e.message).slice(0,250)]);await query(`INSERT INTO early_source_documents(url,title,last_error,last_checked_at) VALUES($1,$2,$3,NOW()) ON CONFLICT(url) DO UPDATE SET last_error=EXCLUDED.last_error,last_checked_at=NOW()`,[row.url,row.original_name,String(e.message).slice(0,250)]);};
   const files=await query("SELECT * FROM seoul_review_files WHERE next_due_at<=NOW() ORDER BY CASE status WHEN 'pending' THEN 0 WHEN 'error' THEN 1 ELSE 2 END,next_due_at,post_id DESC,file_no LIMIT 10");
   for(const row of files.rows){
    let bytes;try{bytes=await fetchBytes(row.url);}catch(e){failed++;if(/한도|실행권/.test(e.message))break;await fileError(row,e);continue;}
    try{const file={url:row.url,name:row.original_name,postId:Number(row.post_id),fileNo:row.file_no,postUrl:row.post_url,revision:row.revision};await saveDecision(transaction,parseDecision(await pdfText(bytes),file),token);processed++;}
    catch(e){failed++;await fileError(row,e);}
   }
   const pending=await query("SELECT COUNT(*) FILTER (WHERE next_due_at<=NOW())::int AS n,COUNT(*) FILTER (WHERE status='error')::int AS errors FROM seoul_review_files");
   await query(`UPDATE auto_ingest_state SET last_success_at=CASE WHEN $2 THEN NOW() ELSE last_success_at END,last_error=$3,lease_token=NULL,lease_until=NULL,
    next_due_at=NOW()+($4::int*INTERVAL '1 second') WHERE source='seoul_review' AND lease_token=$1`,[token,discovered||processed>0,failed||pending.rows[0]?.errors?'서울 심의 처리 실패 '+failed+'건 / 오류 파일 '+(pending.rows[0]?.errors||0)+'건 · 자동 재시도':null,failed?7200:pending.rows[0]?.n?60:3600]);
  }catch(e){if(claimed)await query("UPDATE auto_ingest_state SET last_error=$2,lease_token=NULL,lease_until=NULL,next_due_at=NOW()+INTERVAL '2 hours' WHERE source='seoul_review' AND lease_token=$1",[token,String(e.message).slice(0,250)]).catch(()=>{});}finally{active=false;}
 }
 return {run,start(){if(timer)return;timer=setInterval(()=>void run(),60000);timer.unref?.();void run();}};
}
module.exports={BOARD,ORIGIN,listPosts,postFiles,parseDecision,download,extract,saveDecision,createSeoulCollector};
