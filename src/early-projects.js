const crypto=require('node:crypto');
const cheerio=require('cheerio');
const {PDFParse}=require('pdf-parse');
const BOARD='https://www.ulsannamgu.go.kr/cop/bbs/selectBoardList.do?bbsId=resultBuild';
const PDF='https://www.gunsan.go.kr/_cms/board/eFileDownload/111/9829609/46d69c01c863642a17e39fe63dc98d0c';
const ROLES=['owner','developer','applicant','designer','contractor','supervisor','operator'];
const STAGES=['REVIEW','PERMIT','STARTED','COMPLETED'];
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const clean=value=>String(value||'').replace(/[\t ]+/g,' ').trim();
function officialUrl(value){try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&u.hostname.endsWith('.go.kr')?u.href:null;}catch{return null;}}
function normalizeEvidence(input){
 const role=String(input.role||''),organization=clean(input.organization),url=officialUrl(input.source_url);
 const stage=input.stage||'REVIEW',scope=input.contact_scope||'company';
 if(!ROLES.includes(role)||!STAGES.includes(stage)||!organization||organization.length>200||!url||!['company','department','project'].includes(scope))throw Error('역할·업체명·단계·공식 출처 URL을 확인하세요.');
 const organizationAddress=clean(input.organization_address),registrationNo=clean(input.registration_no);
 if(organizationAddress.length>500||registrationNo.length>100)throw Error('사업장 주소·등록번호가 너무 깁니다.');
 const phone=clean(input.phone),email=clean(input.email),person=clean(input.person_name),department=clean(input.department),excerpt=clean(input.excerpt);
 if(phone&&!/^[+0-9() .-]{7,40}$/.test(phone))throw Error('전화번호 형식을 확인하세요.');
 if(email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw Error('이메일 형식을 확인하세요.');
 if((phone||email)&&excerpt.length<4)throw Error('연락처가 기재된 원문 근거를 입력하세요.');
 if(person.length>100||department.length>120||excerpt.length>1000)throw Error('근거 정보가 너무 깁니다.');
 return {role,organization,source_url:url,stage,contact_scope:scope,phone:phone||null,email:email||null,person_name:person||null,department:department||null,excerpt,organization_address:organizationAddress||null,registration_no:registrationNo||null};
}
function parseUlsan(html){
 const $=cheerio.load(html);const root=$('.bbs-view-content').first();root.find('br').replaceWith('\n');
 const text=root.text().replace(/\r/g,'');
 const date=text.match(/심의일자\s*[:：]\s*(\d{4})\.\s*(\d{1,2})\.\s*(\d{1,2})/);
 const dateValue=date?`${date[1]}-${date[2].padStart(2,'0')}-${date[3].padStart(2,'0')}`:null;
 const records=[];
 for(const block of text.split(/\[\s*안건번호\s*[:：]/).slice(1)){
  const number=clean(block.split(']')[0]);
  const address=clean(block.match(/위\s*치\s*[:：]\s*([^\n]+)/)?.[1]);
  if(!address||!number)continue;
  const purposes=clean(block.match(/용\s*도\s*[:：]\s*([^\n]+)/)?.[1]);
  const applicant=clean(block.match(/신청인\s*[:：]\s*([^\n]+)/)?.[1]);
  const parties=applicant?[{role:'applicant',organization:applicant,excerpt:'신청인: '+applicant}]:[];
  for(const [label,role] of [['건축주','owner'],['사업시행자','developer'],['설계자','designer'],['시공자','contractor'],['감리자','supervisor']]){
   const value=clean(block.match(new RegExp(label+'\\s*[:：]\\s*([^\\n]+)'))?.[1]);
   if(value)parties.push({role,organization:value,excerpt:label+': '+value});
  }
  records.push({key:number,address:address.startsWith('울산')?address:'울산광역시 '+address,region:'울산광역시',name:address+' '+(purposes||'건축')+' 심의',buildingType:purposes,date:dateValue,parties});
 }
 return records;
}
function parseGunsan(text){
 const lines=text.split('\n').map(clean);const find=pattern=>lines.map(x=>x.match(pattern)).find(Boolean);
 // This verified single-project official document is deliberately not a generic multi-case PDF parser.
 const owner=find(/^건축주\s+성명\(법인명\)\s+(.+)$/)?.[1];
 const address=find(/^대지위치\s+(.+)$/)?.[1];
 const date=find(/심의일자\s+(\d{4})\.\s*(\d{1,2})\.\s*(\d{1,2})/);
 if(!owner||!address||lines.filter(x=>/^건축주\s+성명/.test(x)).length!==1)return [];
 return [{key:'1',address:'전북특별자치도 군산시 '+address,region:'전북특별자치도',name:address+' 건축심의',date:date?`${date[1]}-${date[2].padStart(2,'0')}-${date[3].padStart(2,'0')}`:null,parties:[{role:'owner',organization:owner,excerpt:'건축주 성명(법인명): '+owner}]}];
}
async function fetchPublic(url){
 const u=new URL(url);if(!['www.ulsannamgu.go.kr','www.gunsan.go.kr'].includes(u.hostname)||u.protocol!=='https:')throw Error('허용된 공식 수집 출처가 아닙니다.');
 const r=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(25000)});if(!r.ok)throw Error('공식 자료 HTTP '+r.status);
 const reader=r.body.getReader(),parts=[];let size=0;
 for(;;){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>8*1024*1024){await reader.cancel();throw Error('문서 용량 제한 8MB 초과');}parts.push(Buffer.from(value));}
 return Buffer.concat(parts);
}
async function saveRecords(tx,url,title,bytes,records){
 const digest=hash(bytes);
 await tx(async query=>{
  await query(`INSERT INTO early_source_documents(url,title,content_hash,record_count,last_checked_at,last_error)
   VALUES($1,$2,$3,$4,NOW(),NULL) ON CONFLICT(url) DO UPDATE SET title=EXCLUDED.title,content_hash=EXCLUDED.content_hash,record_count=EXCLUDED.record_count,last_checked_at=NOW(),last_error=NULL`,[url,title,digest,records.length]);
  for(const record of records){
   const external=hash(url+'#'+record.key);
   const p=await query(`INSERT INTO projects(source,external_id,name,address,region,building_type,stage,source_url,source_updated_at)
    VALUES('public_review',$1,$2,$3,$4,$5,'REVIEW',$6,$7)
    ON CONFLICT(source,external_id) DO UPDATE SET name=EXCLUDED.name,address=EXCLUDED.address,building_type=EXCLUDED.building_type,source_updated_at=EXCLUDED.source_updated_at,updated_at=NOW() RETURNING id`,[external,record.name,record.address,record.region,record.buildingType||null,url,record.date]);
   const id=p.rows[0].id;
   for(const input of record.parties){const evidence=normalizeEvidence({...input,source_url:url,stage:'REVIEW'});await insertEvidence(query,id,evidence,'automatic');}
  }
 });
}
async function insertEvidence(query,id,e,origin){
 const fingerprint=hash(JSON.stringify([String(id),e]));
 const r=await query(`INSERT INTO project_party_evidence(project_id,role,organization,person_name,department,phone,email,contact_scope,observed_stage,source_url,excerpt,fingerprint,origin,organization_address,registration_no)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) ON CONFLICT(fingerprint) DO NOTHING RETURNING id`,[id,e.role,e.organization,e.person_name,e.department,e.phone,e.email,e.contact_scope,e.stage,e.source_url,e.excerpt,fingerprint,origin,e.organization_address||null,e.registration_no||null]);
 return r.rows[0]?.id||null;
}
function createEarlyCollector({query,transaction,env=process.env,download=fetchPublic}){
 let active=false,timer;
 async function run(){
  if(active||env.AUTO_INGEST_ENABLED==='false')return;active=true;
  const token=crypto.randomUUID();let claimed=false;
  try{
   const claim=await query(`UPDATE auto_ingest_state SET lease_token=$1,lease_until=NOW()+INTERVAL '10 minutes',last_attempt_at=NOW()
    WHERE source='early' AND next_due_at<=NOW() AND (lease_until IS NULL OR lease_until<NOW()) RETURNING source`,[token]);
   if(!claim.rows.length)return;claimed=true;
   const load=async url=>{
    const count=await query(`UPDATE auto_ingest_state SET daily_calls=CASE WHEN call_day=(NOW() AT TIME ZONE 'Asia/Seoul')::date THEN daily_calls+1 ELSE 1 END,call_day=(NOW() AT TIME ZONE 'Asia/Seoul')::date
     WHERE source='early' AND lease_token=$1 AND lease_until>NOW() AND (call_day IS DISTINCT FROM (NOW() AT TIME ZONE 'Asia/Seoul')::date OR daily_calls<50) RETURNING source`,[token]);
    if(!count.rows.length)throw Error('심의 자료 호출 한도 또는 실행권 만료');
    return download(url);
   };
   const list=cheerio.load((await load(BOARD)).toString('utf8'));
   const urls=[];list('a[href]').each((_,el)=>{const a=list(el),href=a.attr('href');if(/건축위원회.*심의결과/.test(a.text().replace(/\s+/g,''))&&href.includes('selectBoardArticle.do')){const u=new URL(href,BOARD);if(u.searchParams.get('bbsId')==='resultBuild'&&u.hostname==='www.ulsannamgu.go.kr')urls.push(u.href);}});
   if(!urls.length)throw Error('심의 게시판 구조가 변경되었거나 게시물이 없습니다.');
   let failures=0,processed=0;
   const documents=[...new Set(urls)].slice(0,4).map(url=>({url,type:'ulsan'}));documents.push({url:PDF,type:'gunsan'});
   for(const {url,type} of documents){
    const owner=await query("SELECT 1 FROM auto_ingest_state WHERE source='early' AND lease_token=$1 AND lease_until>NOW()",[token]);if(!owner.rows.length)throw Error('심의 수집 실행권 만료');
    try{
     const bytes=await load(url),old=await query('SELECT content_hash FROM early_source_documents WHERE url=$1',[url]);
     if(old.rows[0]?.content_hash===hash(bytes)){await query('UPDATE early_source_documents SET last_checked_at=NOW(),last_error=NULL WHERE url=$1',[url]);processed++;continue;}
     let records;
     if(type==='ulsan')records=parseUlsan(bytes.toString('utf8'));
     else{const parser=new PDFParse({data:bytes});try{records=parseGunsan((await parser.getText()).text);}finally{await parser.destroy();}}
     if(!records.length)throw Error('지원 형식의 사업정보를 추출하지 못했습니다. 원문 확인이 필요합니다.');
     await saveRecords(transaction,url,type==='ulsan'?'울산 남구 건축위원회 심의결과':'군산시 공개 심의자료',bytes,records);processed++;
    }catch(e){failures++;await query(`INSERT INTO early_source_documents(url,title,last_error,last_checked_at) VALUES($1,$2,$3,NOW())
      ON CONFLICT(url) DO UPDATE SET last_error=EXCLUDED.last_error,last_checked_at=NOW()`,[url,'공식 심의자료',String(e.message).slice(0,250)]);}
   }
   await query(`UPDATE auto_ingest_state SET last_success_at=CASE WHEN $2>0 THEN NOW() ELSE last_success_at END,last_error=$3,
    lease_token=NULL,lease_until=NULL,next_due_at=NOW()+INTERVAL '24 hours' WHERE source='early' AND lease_token=$1`,[token,processed,failures?failures+'개 심의자료 처리 실패: 관리자 원문 확인 필요':null]);
  }catch(e){if(claimed)await query("UPDATE auto_ingest_state SET last_error=$2,lease_token=NULL,lease_until=NULL,next_due_at=NOW()+INTERVAL '30 minutes' WHERE source='early' AND lease_token=$1",[token,String(e.message).slice(0,250)]).catch(()=>{});}
  finally{active=false;}
 }
 return {run,start(){if(timer)return;timer=setInterval(()=>void run(),60000);timer.unref?.();void run();}};
}
module.exports={ROLES,STAGES,officialUrl,normalizeEvidence,parseUlsan,parseGunsan,insertEvidence,saveRecords,createEarlyCollector};
