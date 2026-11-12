const crypto=require('node:crypto');
const cheerio=require('cheerio');
const {provinces,locationRegion}=require('./region-catalog');
const {normalizeEvidence,insertEvidence}=require('./early-projects');
const ORIGIN='https://eiass.go.kr';
const FEEDS=[{kind:'environment',label:'환경영향평가',base:'/partcptn/result/resultEiass'},{kind:'strategic',label:'전략환경영향평가',base:'/partcptn/result/resultSperss'}];
const clean=v=>String(v??'').replace(/\s+/g,' ').trim();
const hash=v=>crypto.createHash('sha256').update(v).digest('hex');
function parseList(html,page){
 const $=cheerio.load(html),table=$('table').filter((_,t)=>$(t).find('caption').text().includes('평가항목 결정내용 공람 게시글 리스트'));
 if(table.length!==1||table.find('thead th').map((_,t)=>clean($(t).text())).get().join('|')!=='번호|협의기관|사업명|공람기간')throw Error('환경평가 공개목록 표 형식 변경');
 const count=clean($('.tbl01_wrap > span').text()).match(/^검색결과\s*:\s*([\d,]+)건$/),total=count?Number(count[1].replaceAll(',','')):NaN;
 if(!Number.isInteger(total)||total<0||total>200)throw Error('환경평가 공개목록 건수 확인 또는 200건 한도 초과');
 const current=Number($('.paging li.on a').text());if(total&&current!==page)throw Error('환경평가 공개목록 페이지 불일치');
 const rows=[];
 table.find('tbody tr').each((_,tr)=>{
  const cells=$(tr).children('td'),a=cells.eq(2).find('a');
  if(!a.length&&total===0)return;
  const m=(a.attr('href')||'').match(/^javascript:view\('([A-Z]{2}\d{8})',\s*'(\d+)'\)$/);
  if(cells.length!==4||!m||!clean(a.text()))throw Error('환경평가 공개목록 사업 식별정보 누락');
  rows.push({code:m[1],sequence:m[2],name:clean(a.text()),period:clean(cells.eq(3).text())});
 });
 if(rows.length>10||total===0&&rows.length||total>0&&!rows.length)throw Error('환경평가 공개목록 페이지 누락');
 return {total,rows};
}
function dateValue(v){const m=clean(v).match(/^(\d{4})[.\/-]\s*(\d{1,2})[.\/-]\s*(\d{1,2})\.?$/);if(!m)return null;const iso=m[1]+'-'+m[2].padStart(2,'0')+'-'+m[3].padStart(2,'0');const d=new Date(iso+'T00:00:00Z');return Number.isFinite(+d)&&d.toISOString().slice(0,10)===iso?iso:null;}
function explicitLocation(text){
 const matches=[...text.matchAll(/(?:사업\s*위\s*치|위\s*치|소\s*재\s*지)(?:\s*및\s*규\s*모)?\s*[:：]\s*([^\n]+)/g)].map(m=>clean(m[1].split(/(?:[가-하]\.|[○●■])\s*(?:규\s*모|면\s*적|사업|시행)/)[0]).slice(0,500));
 const locations=[];
 for(const address of matches){
  const names=provinces.flatMap(p=>p.aliases.map(a=>({name:a,province:p}))).sort((a,b)=>b.name.length-a.name.length);
  const spaced=' '+address.replace(/[,;()]/g,' ').replace(/\s+/g,' ')+' ';
  const mentioned=new Set(names.filter(x=>spaced.includes(' '+x.name+' ')).map(x=>(provinces.find(p=>p.code&&p.aliases.includes(x.province.value))||x.province).value));
  if(mentioned.size>1)return {address:null,region:null};
  const match=names.find(x=>address.startsWith(x.name+' '));
  if(!match){const region=locationRegion(address);if(region)locations.push({address,region});continue;}
  const active=provinces.find(p=>p.code&&p.aliases.includes(match.province.value))||match.province;
  locations.push({address,region:active.value});
 }
 const unique=[...new Map(locations.map(x=>[x.address,x])).values()];return unique.length===1?unique[0]:{address:null,region:null};
}
function parseDetail(html,entry,feed){
 const $=cheerio.load(html);
 const codes=$('input[name="BIZ_CD"]').map((_,x)=>clean($(x).val())).get().filter(Boolean);
 const sequences=$('input[name="BIZ_SEQ"]').map((_,x)=>clean($(x).val())).get().filter(Boolean);
 if(new Set(codes).size!==1||codes[0]!==entry.code||new Set(sequences).size!==1||sequences[0]!==entry.sequence)throw Error('환경평가 상세 사업코드·문서번호 불일치');
 const tables=$('table').filter((_,t)=>$(t).children('caption').text().includes('협의진행현황 사업명 -'));
 if(tables.length!==1)throw Error('환경평가 사업 상세 표 형식 변경');
 const values=new Map();tables.find('> tbody > tr').each((_,tr)=>{const th=$(tr).children('th').first(),td=$(tr).children('td').first();const key=clean(th.text()).replace(/^[*\s]+/,'');if(key){if(values.has(key))throw Error('환경평가 상세 항목 중복');values.set(key,{text:td.text().replace(/\r/g,''),html:td.html()||''});}});
 const name=clean(values.get('사업명')?.text),developer=clean(values.get('사업시행자')?.text);
 if(!name||!values.has('사업시행자')||name!==entry.name)throw Error('환경평가 목록·상세 사업명 불일치 또는 필드 누락');
 if(developer.length>200)throw Error('환경평가 사업시행자 필드 확인 필요');
 const dates=$('table').filter((_,t)=>$(t).children('caption').text().startsWith('결정내용공개 -'));
 if(dates.length!==1)throw Error('환경평가 공개일 표 형식 변경');
 const extra=new Map();dates.find('> tbody > tr').each((_,tr)=>extra.set(clean($(tr).children('th').text()).replace(/^[*\s]+/,''),clean($(tr).children('td').text())));
 const date=dateValue(extra.get('공고일'));if(extra.get('공고일')&&!date)throw Error('환경평가 공고일 형식 변경');
 const content=$('<div>'+ (values.get('결정내용')?.html||'')+'</div>');content.find('br').replaceWith('\n');content.find('script,style').remove();const text=content.text().replace(/\r/g,'');
 const location=explicitLocation(text),url=ORIGIN+feed.base+'View.do?'+new URLSearchParams({BIZ_CD:entry.code,BIZ_SEQ:entry.sequence});
 return {key:entry.code,name,...location,date,url,kind:feed.kind,buildingType:feed.label+' 평가항목 결정내용 공람',
  period:extra.get('공람기간')||entry.period,approvingAuthority:clean(values.get('승인기관')?.text),consultingAuthority:clean(values.get('협의기관')?.text),
  parties:developer?[{role:'developer',organization:developer,excerpt:'EIASS '+feed.label+' 공개 표의 사업시행자: '+developer+' (사업코드 '+entry.code+')'}]:[]};
}
async function fetchPublic(url){
 const u=new URL(url),paths=FEEDS.flatMap(f=>[f.base+'ListData.do',f.base+'View.do']);
 if(u.origin!==ORIGIN||u.username||u.password||!paths.includes(u.pathname))throw Error('허용하지 않는 환경평가 공개 경로');
 let response;try{response=await fetch(u,{redirect:'error',signal:AbortSignal.timeout(25000)});}catch{throw Error('환경평가 공개자료 연결 실패');}
 if(!response.ok)throw Error('환경평가 공개자료 HTTP '+response.status);
 const reader=response.body.getReader(),parts=[];let size=0;
 for(;;){const r=await reader.read();if(r.done)break;size+=r.value.length;if(size>2*1024*1024){await reader.cancel();throw Error('환경평가 공개자료 2MB 한도 초과');}parts.push(Buffer.from(r.value));}
 return Buffer.concat(parts).toString('utf8');
}
async function saveRecord(transaction,record,token){
 const digest=hash(JSON.stringify(record));
 await transaction(async q=>{
  const owner=await q("SELECT source FROM auto_ingest_state WHERE source='environment_review' AND lease_token=$1 AND lease_until>NOW() FOR UPDATE",[token]);if(!owner.rows.length)throw Error('환경평가 수집 실행권 만료');
  const old=await q('SELECT content_hash FROM early_source_documents WHERE url=$1',[record.url]);
  if(old.rows[0]?.content_hash===digest){await q('UPDATE early_source_documents SET last_checked_at=NOW(),last_error=NULL WHERE url=$1',[record.url]);return;}
  const p=await q(`INSERT INTO projects(source,external_id,name,address,region,building_type,stage,source_url,source_updated_at)
   VALUES('environment_review',$1,$2,$3,$4,$5,'REVIEW',$6,$7)
   ON CONFLICT(source,external_id) DO UPDATE SET name=EXCLUDED.name,address=EXCLUDED.address,region=EXCLUDED.region,building_type=EXCLUDED.building_type,source_url=EXCLUDED.source_url,source_updated_at=EXCLUDED.source_updated_at,updated_at=NOW() RETURNING id`,[record.key,record.name,record.address,record.region,record.buildingType,record.url,record.date]);
  const id=p.rows[0].id;
  await q(`INSERT INTO environment_review_details(project_id,result_code,kind,public_period,approving_authority,consulting_authority)
   VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(project_id) DO UPDATE SET kind=EXCLUDED.kind,public_period=EXCLUDED.public_period,approving_authority=EXCLUDED.approving_authority,consulting_authority=EXCLUDED.consulting_authority`,[id,record.key,record.kind,record.period,record.approvingAuthority,record.consultingAuthority]);
  for(const input of record.parties)await insertEvidence(q,id,normalizeEvidence({...input,source_url:record.url,stage:'REVIEW'}),'automatic');
  await q(`INSERT INTO early_source_documents(url,title,content_hash,record_count,last_checked_at,last_error) VALUES($1,$2,$3,1,NOW(),NULL)
   ON CONFLICT(url) DO UPDATE SET title=EXCLUDED.title,content_hash=EXCLUDED.content_hash,record_count=1,last_checked_at=NOW(),last_error=NULL`,[record.url,record.name,digest]);
 });
}
function createEnvironmentCollector({query,transaction,env=process.env,download=fetchPublic}){
 let active=false,timer;
 async function run(){
  if(active||env.AUTO_INGEST_ENABLED==='false')return;active=true;
  const token=crypto.randomUUID();let claimed=false;
  try{
   const claim=await query("UPDATE auto_ingest_state SET lease_token=$1,lease_until=NOW()+INTERVAL '10 minutes',last_attempt_at=NOW() WHERE source='environment_review' AND next_due_at<=NOW() AND (lease_until IS NULL OR lease_until<NOW()) RETURNING source",[token]);
   if(!claim.rows.length)return;claimed=true;const deadline=Date.now()+8*60000;let stop=false;
   const load=async url=>{
    if(Date.now()>deadline){stop=true;throw Error('환경평가 수집 8분 한도 초과');}
    const limit=await query(`UPDATE auto_ingest_state SET daily_calls=CASE WHEN call_day=(NOW() AT TIME ZONE 'Asia/Seoul')::date THEN daily_calls+1 ELSE 1 END,call_day=(NOW() AT TIME ZONE 'Asia/Seoul')::date
     WHERE source='environment_review' AND lease_token=$1 AND lease_until>NOW() AND (call_day IS DISTINCT FROM (NOW() AT TIME ZONE 'Asia/Seoul')::date OR daily_calls<300) RETURNING source`,[token]);
    if(!limit.rows.length){stop=true;throw Error('환경평가 호출 한도 또는 실행권 만료');}return download(url);
   };
   let checked=0,processed=0,failures=0;const seen=new Set();
   for(const feed of FEEDS){
    try{
     const entries=[];let total;
     for(let page=1;page<=20;page++){
      const result=parseList(await load(ORIGIN+feed.base+'ListData.do?currentPage='+page),page);
      if(total!==undefined&&total!==result.total)throw Error('환경평가 공개목록 조회 중 건수 변경');total=result.total;
      entries.push(...result.rows);if(entries.length>total)throw Error('환경평가 공개목록 전체 건수 불일치');
      if(entries.length===total)break;if(result.rows.length!==10)throw Error('환경평가 공개목록 일부 페이지 누락');
     }
     if(entries.length!==total||new Set(entries.map(x=>x.code)).size!==entries.length)throw Error('환경평가 공개목록 중복·누락');checked++;
     for(const entry of entries){
      if(seen.has(entry.code))continue;seen.add(entry.code);
      const url=ORIGIN+feed.base+'View.do?'+new URLSearchParams({BIZ_CD:entry.code,BIZ_SEQ:entry.sequence});
      try{const record=parseDetail(await load(url),entry,feed);await saveRecord(transaction,record,token);processed++;}
      catch(e){if(stop)throw e;failures++;await query(`INSERT INTO early_source_documents(url,title,last_error,last_checked_at) VALUES($1,$2,$3,NOW()) ON CONFLICT(url) DO UPDATE SET last_error=EXCLUDED.last_error,last_checked_at=NOW()`,[url,entry.name,String(e.message).slice(0,250)]);}
     }
    }catch(e){failures++;await query(`INSERT INTO early_source_documents(url,title,last_error,last_checked_at) VALUES($1,$2,$3,NOW()) ON CONFLICT(url) DO UPDATE SET last_error=EXCLUDED.last_error,last_checked_at=NOW()`,[ORIGIN+feed.base+'ListData.do',feed.label+' 공개목록',String(e.message).slice(0,250)]);}
    if(stop)break;
   }
   await query(`UPDATE auto_ingest_state SET last_success_at=CASE WHEN $2>0 THEN NOW() ELSE last_success_at END,last_error=$3,lease_token=NULL,lease_until=NULL,
    next_due_at=NOW()+CASE WHEN $4 THEN INTERVAL '2 hours' ELSE INTERVAL '24 hours' END WHERE source='environment_review' AND lease_token=$1`,[token,checked,failures?'환경평가 공개자료 '+failures+'건 처리 실패 / 저장 '+processed+'건':null,failures>0]);
  }catch(e){if(claimed)await query("UPDATE auto_ingest_state SET last_error=$2,lease_token=NULL,lease_until=NULL,next_due_at=NOW()+INTERVAL '2 hours' WHERE source='environment_review' AND lease_token=$1",[token,String(e.message).slice(0,250)]).catch(()=>{});}
  finally{active=false;}
 }
 return {run,start(){if(timer)return;timer=setInterval(()=>void run(),60000);timer.unref?.();void run();}};
}
module.exports={ORIGIN,FEEDS,parseList,parseDetail,explicitLocation,fetchPublic,saveRecord,createEnvironmentCollector};
