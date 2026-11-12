const crypto=require('node:crypto');
const {fetchGyeonggi}=require('./gyeonggi-directory');
// Registry fields verified against each publisher's ODCloud OpenAPI manifest (2026-11-12).
const SOURCES={
 gyeonggi_developers:{label:'경기 부동산개발업체',region:'경기',url:'https://gris.gg.go.kr/reb/selectRealestateDevList.do',phoneProvided:true,phoneMode:'project_parties',addressFields:['사무소 소재지']},
 architects:{label:'전국 건축사사무소',url:'https://www.data.go.kr/data/15129439/standard.do',region:'전국',phoneProvided:true},
 busan_developers:{label:'부산 부동산개발업체',region:'부산',dataset:'15134260',phoneProvided:true,addressFields:['주사무소 소재지']},
 daegu_developers:{label:'대구 부동산개발업체',region:'대구',dataset:'15074138',phoneProvided:true,addressFields:['주사무소 소재지']},
 incheon_developers:{label:'인천 부동산개발업체',region:'인천',dataset:'15103000',phoneProvided:false,addressFields:['사무소 소재지','영업소재지']},
 ulsan_developers:{label:'울산 부동산개발업체',region:'울산',dataset:'15047634',phoneProvided:false,addressFields:['영업소소재지']},
 chungnam_developers:{label:'충남 부동산개발업체',region:'충남',dataset:'15018881',phoneProvided:true,addressFields:['영업소재지']}
};
for(const entry of Object.values(SOURCES))if(entry.dataset)entry.url='https://www.data.go.kr/data/'+entry.dataset+'/fileData.do';
function inactiveRegistration(value){return /폐업|말소|취소|정지/.test(text(value));}
function coverageSummary(states){
 return Object.entries(SOURCES).map(([source,info])=>{
  const state=states.find(x=>x.source===source);
  return {source,label:info.label,region:info.region,url:info.url,phoneProvided:info.phoneProvided,phoneMode:info.phoneMode||'directory',
   status:state?.last_success_at?(state.last_error?'retained':'synced'):'pending',
   recordCount:Number(state?.record_count||0),lastSuccessAt:state?.last_success_at||null};
 });
}
const text=v=>String(v??'').normalize('NFKC').trim().replace(/\s+/g,' ');
const digest=v=>crypto.createHash('sha256').update(v).digest('hex');
function nameKey(value){return text(value).toLowerCase().replace(/^(?:주식회사|유한회사|유한책임회사|\(주\)|\(유\))\s*/,'').replace(/\s*(?:주식회사|유한회사|\(주\)|\(유\))$/,'').replace(/[\s.,·ㆍ()]/g,'');}
function addressKey(value){return text(value).replace(/강원도/g,'강원특별자치도').replace(/전라북도/g,'전북특별자치도').replace(/[\s,()]/g,'');}
function validPhone(value){const raw=text(value);if(!/^[+\d() .-]+$/.test(raw))return null;const digits=raw.replace(/\D/g,'');return digits.length>=8&&digits.length<=13&&!/0{6,}$/.test(digits)?raw:null;}
function read(row,...keys){const entries=new Map(Object.entries(row).map(([k,v])=>[k.replace(/_/g,'').toLowerCase(),v]));for(const k of keys){const v=entries.get(k.replace(/_/g,'').toLowerCase());if(v!==undefined&&v!==null&&text(v))return text(v);}return '';}
function normalizeRecord(row,source){
 const architecture=source==='architects';
 if(!SOURCES[source])throw Error('지원하지 않는 명부 출처');
 const organization=architecture?read(row,'CO_NM','사무소명'):read(row,'상호');
 const address=architecture?read(row,'LCTN_ROAD_NM','소재지도로명주소','LCTN_LOTNO_ADDR','소재지지번주소'):read(row,...SOURCES[source].addressFields);
 const officeMissingAllowed=source==='gyeonggi_developers'&&/^경기\d{6}$/.test(read(row,'등록번호'));
 if(!organization||!address&&!officeMissingAllowed||organization.length>200||address.length>500)throw Error('업체명·사업장 주소 필드 누락 또는 형식 변경');
 const record={source,organization,name_key:nameKey(organization),address,address_key:addressKey(address),registration_status:read(row,'등록상태','상태')||null,registration_no:read(row,'부동산개발업등록번호','등록번호','신고번호')||null,
  representative:read(row,'RPRSV_NM','대표자명','대표자')||null,phone:!architecture&&(!SOURCES[source].phoneProvided||inactiveRegistration(read(row,'등록상태','상태')))?null:validPhone(read(row,'TELNO','전화번호')),data_date:architecture?read(row,'DATA_CRTR_YMD','데이터기준일자')||null:row.__directoryDate||null,source_url:SOURCES[source].url};
 record.fingerprint=digest(JSON.stringify(record));return record;
}
async function json(url,options={}){
 const u=new URL(url);if(!['www.data.go.kr','api.data.go.kr','api.odcloud.kr','infuser.odcloud.kr'].includes(u.hostname)||u.protocol!=='https:')throw Error('지원하지 않는 공식 명부 주소');
 let response;try{response=await fetch(u,{...options,redirect:'error',signal:AbortSignal.timeout(30000)});}catch{throw Error('공식 업체 명부 연결 실패');}
 if(!response.ok)throw Error('공식 업체 명부 HTTP '+response.status+' (활용신청·인증키 확인)');
 const parts=[];let size=0;const reader=response.body.getReader();for(;;){const r=await reader.read();if(r.done)break;size+=r.value.length;if(size>10*1024*1024){await reader.cancel();throw Error('업체 명부 응답 용량 제한 초과');}parts.push(Buffer.from(r.value));}
 try{return JSON.parse(Buffer.concat(parts).toString('utf8'));}catch{throw Error('업체 명부 JSON 응답 형식 변경');}
}
async function fetchArchitects(env,request=json){
 if(!env.ARCHITECT_DIRECTORY_KEY){
  // Public download requests used by the official portal's JSON download button; no sign-in bypass.
  const header=await request('https://www.data.go.kr/download/columList.json?pk=15129439&ext=JSON');
  const total=Number(header.totalCount),columns=header.tableVO?.colNmList,table=header.tableVO?.svcTableNm;
  if(!Number.isInteger(total)||total<1||total>20000||!Array.isArray(columns)||!columns.includes('CO_NM')||!columns.includes('TELNO')||!/^\w+$/.test(table||''))throw Error('공식 다운로드 명세 변경: 건축사 API 키 연결 필요');
  const rows=[];
  for(let page=1;rows.length<total;page++){
   if(page>20)throw Error('공식 다운로드 페이지 제한 초과');
   const u=new URL('https://www.data.go.kr/download/standard.json');u.searchParams.set('publicDataPk','15129439');u.searchParams.set('totalCount',String(total));u.searchParams.set('svcTableNm',table);u.searchParams.set('perPage','10000');u.searchParams.set('page',String(page));for(const col of columns)u.searchParams.append('colNmList',col);
   const batch=await request(u);if(!Array.isArray(batch)||!batch.length)throw Error('공식 다운로드 일부 페이지 누락');rows.push(...batch);
  }
  if(rows.length!==total)throw Error('공식 다운로드 전체 건수 불일치');return rows;
 }
 const rows=[];let total;
 for(let page=1;page<=20;page++){
  const u=new URL('https://api.data.go.kr/openapi/tn_pubr_public_architect_api');for(const [k,v] of Object.entries({serviceKey:env.ARCHITECT_DIRECTORY_KEY,type:'json',pageNo:String(page),numOfRows:'1000'}))u.searchParams.set(k,v);
  const d=await request(u),body=d.response?.body,code=String(d.response?.header?.resultCode??'');if(!['00','0'].includes(code)||!body)throw Error('건축사 API 승인·응답 확인 필요');
  const batch=Array.isArray(body.items)?body.items:body.items?.item||[];if(!Array.isArray(batch))throw Error('건축사 API 목록 형식 변경');
  const count=Number(body.totalCount);if(!Number.isInteger(count)||count<1||total!==undefined&&count!==total)throw Error('건축사 API 건수 확인 필요');total=count;rows.push(...batch);
  if(rows.length===total)return rows;if(rows.length>total||!batch.length)throw Error('건축사 API 일부 페이지 누락');
 }
 throw Error('건축사 API 20페이지 제한: 이전 명부 유지');
}
async function fetchDevelopers(env,request=json,source='busan_developers'){
 const info=SOURCES[source];if(!info?.dataset)throw Error('지원하지 않는 개발업체 명부');
 if(!env.DEVELOPER_DIRECTORY_KEY)throw Error('DEVELOPER_DIRECTORY_KEY 설정·'+info.label+' API 활용신청 필요');
 const spec=await request('https://infuser.odcloud.kr/oas/docs?namespace='+info.dataset+'/v1');
 const versions=Object.entries(spec.paths||{}).filter(([path,item])=>new RegExp('^/'+info.dataset+'/v1/uddi:[a-f0-9-]+(?:_[0-9]+)?$').test(path)&&/부동산개발업/.test(item.get?.summary||'')).map(([path,item])=>({path,date:(item.get.summary.match(/(20\d{6})/)||[])[1]})).filter(x=>x.date&&Number(x.date.slice(4,6))>=1&&Number(x.date.slice(4,6))<=12&&Number(x.date.slice(6))>=1&&Number(x.date.slice(6))<=31).sort((a,b)=>b.date.localeCompare(a.date));
 if(!versions.length)throw Error('개발업체 API 파일 버전 명세 확인 필요');
 const version=versions[0],date=version.date.slice(0,4)+'-'+version.date.slice(4,6)+'-'+version.date.slice(6,8);
 const rows=[];let total;
 for(let page=1;page<=20;page++){
  const u=new URL('https://api.odcloud.kr/api'+version.path);u.searchParams.set('page',String(page));u.searchParams.set('perPage','1000');u.searchParams.set('serviceKey',env.DEVELOPER_DIRECTORY_KEY);
  const d=await request(u);if(!Array.isArray(d.data))throw Error('개발업체 API 승인·응답 확인 필요');const n=Number(d.totalCount);if(!Number.isInteger(n)||n<1||total!==undefined&&total!==n)throw Error('개발업체 API 전체 건수 확인 필요');total=n;rows.push(...d.data);
  if(rows.length===total)return rows.map(row=>({...row,__directoryDate:date}));if(rows.length>total||!d.data.length)throw Error('개발업체 API 일부 페이지 누락');
 }
 throw Error('개발업체 API 페이지 제한 초과');
}
function matchState(e,row,decision){
 if(decision?.decision==='rejected')return {status:'rejected',reason:decision.reason};
 if(inactiveRegistration(row.registration_status))return {status:'inactive',reason:'명부 등록상태: '+row.registration_status+' · 영업 연락처 사용 제외'};
 if(!row.is_current)return {status:'historical',reason:'이전 명부 기록: 최신 정보 재확인 필요'};
 if(decision?.decision==='confirmed')return {status:'confirmed',reason:decision.reason};
 if(nameKey(e.organization)!==row.name_key)return {status:'candidate',reason:'업체명 불일치: 직접 확인 필요'};
 if(e.registration_no&&row.registration_no&&text(e.registration_no)===row.registration_no)return {status:'matched',reason:'업체명과 등록번호 일치'};
 if(e.organization_address&&addressKey(e.organization_address)===row.address_key)return {status:'matched',reason:'업체명과 사업장 주소 일치'};
 return {status:'candidate',reason:'동일·유사 상호만 확인됨: 사업장 주소·등록번호 확인 필요'};
}
async function directoryMatches(query,evidence){
 if(!evidence.length)return [];
 const keys=[...new Set(evidence.map(e=>nameKey(e.organization)).filter(Boolean))];
 const result=await query('SELECT * FROM organization_directory WHERE name_key=ANY($1::text[]) AND is_current=TRUE ORDER BY source,organization,address LIMIT 200',[keys]);
 const choices=await query(`SELECT DISTINCT ON(c.evidence_id,c.directory_id) c.*,d.source AS directory_source,d.name_key AS directory_name_key,d.address_key AS directory_address_key,d.registration_no AS directory_registration_no FROM party_contact_decisions c JOIN organization_directory d ON d.id=c.directory_id WHERE c.evidence_id=ANY($1::bigint[]) ORDER BY c.evidence_id,c.directory_id,c.id DESC`,[evidence.map(e=>e.id)]);
 const confirmedIds=[...new Set(choices.rows.filter(x=>x.decision==='confirmed').map(x=>String(x.directory_id)))];
 const historic=confirmedIds.length?await query('SELECT * FROM organization_directory WHERE id=ANY($1::bigint[]) AND is_current=FALSE',[confirmedIds]):{rows:[]};
 const out=[];for(const e of evidence){for(const row of [...result.rows,...historic.rows]){const decision=choices.rows.filter(x=>String(x.evidence_id)===String(e.id)&&(String(x.directory_id)===String(row.id)||(x.directory_source===row.source&&x.directory_name_key===row.name_key&&x.directory_address_key===row.address_key&&String(x.directory_registration_no||'')===String(row.registration_no||'')))).sort((a,b)=>BigInt(a.id)>BigInt(b.id)?-1:BigInt(a.id)<BigInt(b.id)?1:0)[0];if(row.name_key!==nameKey(e.organization)&&!decision)continue;const state=matchState(e,row,decision);if(state.status==='rejected')continue;out.push({...row,evidence_id:e.id,role:e.role,match_status:state.status,match_reason:state.reason});}}return out;
}
function createDirectorySync({query,transaction,env=process.env,request=json,gyeonggiRequest}){
 let active=false,timer;
 async function run(){
  if(active||env.AUTO_INGEST_ENABLED==='false')return;active=true;
  try{for(const source of Object.keys(SOURCES)){
   // Keep the secret out of operational status; persist only a one-way change marker.
   const key=source==='architects'?env.ARCHITECT_DIRECTORY_KEY:source==='gyeonggi_developers'?'public-form-v1':env.DEVELOPER_DIRECTORY_KEY;
   const revision=digest(source+':'+(key||'public-or-unconfigured'));
   await query(`UPDATE directory_sync_state SET config_revision=$2,next_due_at=NOW(),last_error=NULL
    WHERE source=$1 AND config_revision IS DISTINCT FROM $2 AND (lease_until IS NULL OR lease_until<NOW())`,[source,revision]);
   const token=crypto.randomUUID();const claim=await query(`UPDATE directory_sync_state SET lease_token=$2,lease_until=NOW()+INTERVAL '20 minutes',last_attempt_at=NOW() WHERE source=$1 AND next_due_at<=NOW() AND (lease_until IS NULL OR lease_until<NOW()) RETURNING source`,[source,token]);if(!claim.rows.length)continue;
   try{
    const phoneNames=source==='gyeonggi_developers'?(await query('SELECT DISTINCT organization FROM project_party_evidence')).rows.map(x=>x.organization):[];
    const raw=await (source==='gyeonggi_developers'?fetchGyeonggi({phoneNames,nameKey,request:gyeonggiRequest}):source==='architects'?fetchArchitects(env,request):fetchDevelopers(env,request,source));
    const records=[...new Map(raw.map(row=>{const r=normalizeRecord(row,source);return [r.fingerprint,r];})).values()];
    if(!records.length)throw Error('빈 명부는 반영하지 않습니다.');
    await transaction(async q=>{
     const owner=await q('SELECT source FROM directory_sync_state WHERE source=$1 AND lease_token=$2 AND lease_until>NOW() FOR UPDATE',[source,token]);if(!owner.rows.length)throw Error('명부 갱신 실행권 만료');
     for(let i=0;i<records.length;i+=1000)await q(`INSERT INTO organization_directory(source,organization,name_key,address,address_key,registration_no,representative,phone,data_date,source_url,fingerprint,registration_status)
      SELECT source,organization,name_key,address,address_key,registration_no,representative,phone,data_date,source_url,fingerprint,registration_status FROM jsonb_to_recordset($1::jsonb) AS r(source TEXT,organization TEXT,name_key TEXT,address TEXT,address_key TEXT,registration_no TEXT,representative TEXT,phone TEXT,data_date TEXT,source_url TEXT,fingerprint TEXT,registration_status TEXT)
      ON CONFLICT(fingerprint) DO UPDATE SET last_seen_at=NOW()`,[JSON.stringify(records.slice(i,i+1000))]);
     await q('UPDATE organization_directory SET is_current=(fingerprint=ANY($2::text[])) WHERE source=$1',[source,records.map(x=>x.fingerprint)]);
     await q(`UPDATE directory_sync_state SET last_success_at=NOW(),last_error=NULL,record_count=$3,lease_token=NULL,lease_until=NULL,next_due_at=NOW()+CASE WHEN source='gyeonggi_developers' THEN INTERVAL '1 day' ELSE INTERVAL '7 days' END WHERE source=$1 AND lease_token=$2`,[source,token,records.length]);
    });
   }catch(e){await query(`UPDATE directory_sync_state SET last_error=$3,lease_token=NULL,lease_until=NULL,next_due_at=NOW()+INTERVAL '2 hours' WHERE source=$1 AND lease_token=$2`,[source,token,String(e.message).replaceAll(env.ARCHITECT_DIRECTORY_KEY||'__no_key__','[redacted]').replaceAll(env.DEVELOPER_DIRECTORY_KEY||'__no_key__','[redacted]').slice(0,250)]);}
  }}catch(e){console.error('Directory sync failed:',e.message);}finally{active=false;}
 }
 return {run,start(){if(timer)return;timer=setInterval(()=>void run(),60000);timer.unref?.();void run();}};
}
module.exports={SOURCES,coverageSummary,inactiveRegistration,nameKey,addressKey,validPhone,normalizeRecord,fetchArchitects,fetchDevelopers,matchState,directoryMatches,createDirectorySync};
