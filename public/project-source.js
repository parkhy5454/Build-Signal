(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.ProjectSource=factory();})(typeof window==='undefined'?this:window,function(){
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 function safeUrl(value){try{const u=new URL(value);if(!['https:','http:'].includes(u.protocol)||u.username||u.password)return null;
  if([...u.searchParams.keys()].some(k=>/(?:key|token|auth|password|secret|signature|cookie)/i.test(k)))return null;
  return u.href;}catch{return null;}}
 function classify(value,source,externalId){
  const url=safeUrl(value);if(!url)return {kind:'missing',url:null,label:'외부 출처 링크 미확보'};
  const u=new URL(url),host=u.hostname.toLowerCase();
  if(host==='data.go.kr'||host.endsWith('.data.go.kr'))return {kind:'provider',url,label:'데이터 제공기관 안내'};
  if((host==='hub.go.kr'||host.endsWith('.hub.go.kr'))&&/\/portal\/(?:gis|psg)|^\/$/.test(u.pathname))return {kind:'lookup',url,label:'제공기관 조회 화면'};
  if(source==='g2b_bid'&&(host==='g2b.go.kr'||host.endsWith('.g2b.go.kr'))){
   const entries=[...u.searchParams],bid=entries.find(([k])=>/^(?:bidno|bidNtceNo|bidPbancNo)$/i.test(k)),order=entries.find(([k])=>/^(?:bidseq|bidNtceOrd|bidPbancOrd)$/i.test(k));
   const id=String(externalId||'').match(/^(.*)-(\d+)$/),ord=v=>/^\d+$/.test(v)?v.replace(/^0+(?=\d)/,''):null;
   if(bid?.[1]&&id&&(bid[1]!==id[1]||order&&ord(order[1])!==ord(id[2])))return {kind:'mismatch',url:null,label:'공고 식별자 불일치'};
   if(bid?.[1]&&id&&bid[1]===id[1]&&order&&ord(order[1])===ord(id[2]))return {kind:'detail',url,label:'원문 공고 상세 확인'};
  }
  if(/\.pdf$/i.test(u.pathname)&&host.endsWith('.go.kr'))return {kind:'document',url,label:'원문 문서 확인'};
  return {kind:'reference',url,label:'출처 페이지 확인'};
 }
 function recordPath(id){const value=String(id??'');return /^[1-9]\d{0,17}$/.test(value)?'/source-record.html?projectId='+encodeURIComponent(value):null;}
 function footer(project){
  const target=classify(project.source_url,project.source,project.external_id),path=recordPath(project.id);
  const direct=['detail','document'].includes(target.kind);
  const primary=direct?'<a href="'+esc(target.url)+'" target="_blank" rel="noopener noreferrer">'+esc(target.label)+' ↗</a>':path?'<a href="'+esc(path)+'" target="_blank" rel="noopener noreferrer">프로젝트 수집 자료 확인 ↗</a>':'';
  return primary?'<p class="source-footer">'+primary+'</p>':'';
 }
 return {safeUrl,classify,recordPath,footer};
});
