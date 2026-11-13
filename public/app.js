const stageLabel={REVIEW:"심의·환경평가",PERMIT:"인허가",STARTED:"착공",COMPLETED:"준공",BID:"입찰",UNKNOWN:"확인 필요"};
const $=id=>document.getElementById(id);
let currentPage="dashboard",searchPage=1,searchTotalPages=1;
function esc(s){return String(s??"-").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}
function stageSearch(value){return ({심의:"REVIEW",환경평가:"REVIEW",환경영향평가:"REVIEW",공람:"REVIEW",인허가:"PERMIT",허가:"PERMIT",착공:"STARTED",준공:"COMPLETED",사용승인:"COMPLETED",입찰:"BID"})[String(value).trim()]||"";}
function emptyProjectSearch(d){
 const counts=d.coverage||{},stage=d.selectedStage;
 const message=stage&&counts[stage]===0?`${stageLabel[stage]} 단계로 저장된 현장이 아직 없습니다.`:'선택한 검색 조건에 맞는 현장이 없습니다. 지역·기간·연락처 조건을 확인해 주세요.';
 const coverage=d.coverage?'현재 저장 현황: '+Object.entries(stageLabel).map(([key,label])=>label+' '+fmt(counts[key])+'건').join(' · '):'';
 return `<div class="panel"><p>${esc(message)}</p><p>${esc(coverage)}</p><p>나라장터 입찰공고 수집만으로 인허가·착공·준공 현장이 확보되지는 않습니다. 인허가·착공은 건축HUB 수집 결과가 필요하며, 준공은 국토부 자료에 사용승인일이 있는 현장을 수집한 뒤 표시됩니다.</p></div>`;
}
function fmt(n){return Number(n||0).toLocaleString("ko-KR");}
function displayStage(p){return p.source==='environment_review'&&p.stage==='REVIEW'?'환경평가 공람(공개 시점)':stageLabel[p.stage]||'확인 필요';}
function card(p,score){
 const badges=[p.party_count?`<span class="signal-tag">참여업체 근거 ${fmt(p.party_count)}건</span>`:'',p.has_phone?'<span class="signal-tag success">☎ 전화 확보</span>':'',p.has_email?'<span class="signal-tag success">✉ 이메일 확보</span>':'',p.contact_count>0?`<span class="signal-tag">${fmt(p.contact_count)}개 연락처</span>`:''].filter(Boolean).join('');
 return `<article class="project-card"><div class="project-main"><div class="project-topline"><span class="tag ${p.stage==="STARTED"?"green":""}">${esc(displayStage(p))}</span><span class="project-source">${esc(p.source==='g2b_bid'?'나라장터 실제 공고':p.source==='demo'?'데모 데이터':p.source==='arch_hub_permit'?'건축HUB 인허가':p.source==='public_review'?'지자체 심의자료':p.source==='seoul_review'?'서울시 건축위원회 의결조서':p.source==='environment_review'?'국립환경과학원 EIASS 공개자료':p.source||'')}</span></div><h4>${esc(p.name)}</h4><p>${esc(p.address||"현장 주소 확인 중")}</p><div class="meta"><span>${p.owner?'발주처':p.owner_evidence?'건축주(원문 추출)':p.applicant_evidence?'심의 신청인(원문 추출)':p.developer_evidence?'사업시행자(원문 추출)':'건축주'}: ${esc(p.owner||p.owner_evidence||p.applicant_evidence||p.developer_evidence||(p.source==='seoul_review'?'원문 미제공':'확인 중'))}</span><span>공종: ${esc(p.building_type||"미확인")}</span><span>${esc(p.region||"")}</span></div><div class="signal-tags">${p.architectural_review_result?'<span class="signal-tag">'+esc(p.architectural_review_result)+'</span>':''}${badges||'<span class="signal-tag muted-tag">연락처 확인 중</span>'}</div></div><div class="card-actions">${score!==undefined?`<span class="score">${score}점</span>`:""}<button class="button primary" onclick="detail(${Number(p.id)})">상세·연락처 보기</button></div></article>`;
}
async function api(url,opts){const r=await fetch(url,opts);const d=await r.json();if(!r.ok)throw new Error(d.error||"요청에 실패했습니다.");return d;}
async function contactSummary(){
 try {
  const d=await api('/api/contacts/summary');
  const data=[['공고 프로젝트',d.total],['발주처 확보',d.client],['전화번호 확보',d.phone],['이메일 확보',d.email],['설계사 확보',d.designer],['감리사 확보',d.supervisor],['시공사 확보',d.contractor]];
  $('contactSummary').innerHTML=data.map(([k,v])=>`<div class="coverage-item"><small>${esc(k)}</small><strong>${fmt(v)}</strong></div>`).join('');
 }catch(e){$('contactSummary').innerHTML=`<div class="notice">${esc(e.message)}</div>`;}
}
async function dashboard(){try{const d=await api("/api/dashboard");$("total").textContent=fmt(d.total);const m=Object.fromEntries(d.byStage.map(x=>[x.stage,x.n]));$("permit").textContent=fmt(m.PERMIT);$("started").textContent=fmt(m.STARTED);$("favoritesCount").textContent=fmt(d.favorites);$("demoNotice").hidden=!d.demo;contactSummary();$("recent").innerHTML=d.recent.length?d.recent.map(p=>card(p)).join(""):'<div class="panel">등록된 현장이 없습니다. 실제 데이터 또는 데모 데이터를 적재해 주세요.</div>'; }catch(e){$("recent").innerHTML=`<div class="notice">${esc(e.message)}</div>`;}}
async function search(page=1){
 searchPage=Math.max(1,page);
 const period=$("searchPeriod").value;
 const today=new Date();const localDay=d=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
 const fromDate=new Date(today.getFullYear(),today.getMonth(),today.getDate()-(Number(period)||0)+1);
 const from=period==="custom"?$("searchFrom").value:period?localDay(fromDate):"";
 const to=period==="custom"?$("searchTo").value:period?localDay(today):"";
 const params=new URLSearchParams({dateField:$("dateField").value,from,to,q:$("q").value,region:$("region").value,stage:$("stage").value,type:$("type").value,contact:$("contactFilter").value,page:String(searchPage),limit:"30"});
 try{
  const d=await api("/api/projects?"+params);
  searchTotalPages=Math.max(1,d.pages||1);
  $("resultCount").textContent=`총 ${fmt(d.total)}건 · ${d.page}/${searchTotalPages} 페이지`;
  $("projectResults").innerHTML=d.rows.length?d.rows.map(p=>card(p)).join(""):emptyProjectSearch(d);
  $("pageInfo").textContent=`${d.page} / ${searchTotalPages}`;
  $("prevPage").disabled=searchPage<=1;$("nextPage").disabled=searchPage>=searchTotalPages;
 }catch(e){$("projectResults").innerHTML=`<div class="notice">${esc(e.message)}</div>`;}
}
async function recommendations(){try{const d=await api("/api/recommendations?profile="+$("profile").value);$("recommendResults").innerHTML=d.rows.length?d.rows.map(p=>card(p,p.score)).join(""):'<div class="panel">추천할 현장이 없습니다.</div>';}catch(e){$("recommendResults").innerHTML=`<div class="notice">${esc(e.message)}</div>`;}}
async function favorites(){try{const d=await api("/api/favorites");$("favoriteResults").innerHTML=d.rows.length?d.rows.map(p=>card(p)).join(""):'<div class="panel">관심 현장이 없습니다. 현장 상세에서 ☆ 관심 등록을 눌러주세요.</div>';}catch(e){$("favoriteResults").innerHTML=`<div class="notice">${esc(e.message)}</div>`;}}
const roleLabels={client:'발주기관',designer:'설계사',supervisor:'감리사',contractor:'시공사'};
function contactCard(c){
 const contact=(c.person_name?`<div class="contact-person">담당자 ${esc(c.person_name)}${c.department?' · '+esc(c.department):''}</div>`:'<div class="contact-person">담당자 미확인</div>');
 const phone=c.phone&&/^[+0-9() .-]{7,25}$/.test(c.phone)?`<a class="contact-link" href="tel:${esc(c.phone.replace(/[^+0-9]/g,''))}">☎ ${esc(c.phone)}</a>`:'<span class="contact-unavailable">전화 미확인</span>';
 const email=c.email&&/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(c.email)?`<a class="contact-link" href="mailto:${esc(c.email)}">✉ ${esc(c.email)}</a>`:'<span class="contact-unavailable">이메일 미확인</span>';
 const url=c.source_url&&/^https?:\/\//i.test(c.source_url)?`<a href="${esc(c.source_url)}" target="_blank" rel="noopener noreferrer">원본 확인 ↗</a>`:'';
 const verification=c.verified_at?'검증 기록 '+esc(String(c.verified_at).slice(0,10)):'검증 기록 없음';
 return `<div class="contact-entry"><b>${esc(c.organization)}</b>${contact}<div class="contact-links">${phone}${email}</div><small>${verification} · 출처: ${esc(c.source||'미확인')} · 갱신 ${esc(c.updated_at?String(c.updated_at).slice(0,10):'미확인')} ${url}</small></div>`;
}
window.detail=async id=>{
 try{
 const p=await api("/api/projects/"+id);
 const fields=[["현장 주소",p.address],["지역",`${p.region||"-"} ${p.district||""}`],["공종·건물 용도",p.building_type],["진행 단계",displayStage(p)],["공사금액",p.estimated_cost?fmt(p.estimated_cost)+"원":"미확인"],["인허가일",p.permit_date],["착공일",p.start_date],["준공일",p.completion_date],["연면적",p.area_sqm?fmt(p.area_sqm)+"㎡":null],["정보 출처",p.source]];
 const contacts=p.contacts||[];
 const evidenceHtml=partyEvidenceHtml(p.partyEvidence||[]);
 const phaseHtml=phaseHistoryHtml(p.phaseProjects||[]);
 const companyHtml=companyDirectoryHtml(p.companyDirectory||[],p.directoryCoverage||[]);
 const roles=['client','designer','supervisor','contractor'];
 const contactHtml=roles.map(role=>`<section class="role-section"><div class="role-heading"><h4>${roleLabels[role]}</h4><span class="role-count">${contacts.filter(c=>c.role===role).length}개</span></div>${contacts.filter(c=>c.role===role).length?contacts.filter(c=>c.role===role).map(contactCard).join(''):`<div class="empty-contact">현재 확인된 ${roleLabels[role]} 담당자 연락처가 없습니다. 외부 데이터 연계로 보완 예정입니다.</div>`}</section>`).join('');
 $("modalBody").innerHTML=`<span class="eyebrow">BUILD SIGNAL · 프로젝트 상세</span><h2 class="project-detail-title">${esc(p.name)}</h2><p class="muted">${esc(p.source==='g2b_bid'?'나라장터 공고 기반 프로젝트':p.source==='demo'?'가상 데모 프로젝트':'프로젝트 정보')}</p><div class="detail-grid">${fields.map(([k,v])=>`<div class="detail-item"><small>${k}</small><b>${esc(v||"확인되지 않음")}</b></div>`).join("")}</div><div class="contact-section-title"><h3>참여 업체 및 담당자 연락처</h3><p>공개 출처에서 확인된 정보만 표시합니다.</p></div><div class="roles-grid">${contactHtml}</div>${evidenceHtml}${companyHtml}${environmentReviewHtml(p.environmentalReviews||[])}${architecturalReviewHtml(p.architecturalReviews||[])}${phaseHtml}<div class="pipeline"><button class="button ${p.favorite?"primary":"light"}" id="favBtn">${p.favorite?"★ 관심 해제":"☆ 관심 등록"}</button><label>영업 단계<select id="pipeStatus"><option value="NEW">신규</option><option value="CONTACTED">접촉</option><option value="MEETING">미팅</option><option value="PROPOSAL">제안</option><option value="WON">수주</option><option value="LOST">실패</option></select></label></div><label class="note-label">영업 메모<textarea id="pipeNote" rows="3">${esc(p.pipeline?.note||'')}</textarea></label><button class="button primary" id="savePipeline">영업정보 저장</button>${p.source_url&&/^https?:\/\//i.test(p.source_url)?`<p class="source-footer"><a href="${esc(p.source_url)}" target="_blank" rel="noopener noreferrer">원본 공고 확인 ↗</a></p>`:''}<p class="muted">담당자 연락처는 공개 업무용 정보이며, 실제 연락 전 출처 및 최신성을 확인하세요.</p>`;
 $("pipeStatus").value=p.pipeline?.status||"NEW";
 $("favBtn").onclick=async()=>{await api(`/api/projects/${id}/favorite`,{method:"POST"});detail(id);};
 $("savePipeline").onclick=async()=>{await api(`/api/projects/${id}/pipeline`,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({status:$("pipeStatus").value,note:$("pipeNote").value})});alert("영업정보를 저장했습니다.");};
 $("modal").classList.remove("hidden");
 }catch(e){alert(e.message);}
};

let groupPage=1,groupPages=1;
async function groups(page=1){
 const stage=stageSearch($('groupQ').value);
 if(stage){
  $('q').value='';$('stage').value=stage;$('region').value=$('groupRegion').value;$('type').value='';$('contactFilter').value='';$('searchPeriod').value='';
  $('searchFromWrap').hidden=true;$('searchToWrap').hidden=true;
  history.replaceState(null,'','#projects');showPage('projects');return;
 }
 groupPage=Math.max(1,page);
 const params=new URLSearchParams({q:$('groupQ').value,region:$('groupRegion').value,trade:$('groupTrade').value,page:String(groupPage)});
 try{
  const d=await api('/api/project-groups?'+params);
  groupPages=Math.max(1,d.pages||1);
  $('groupCount').textContent='총 '+fmt(d.total)+'개 · '+d.page+'/'+groupPages+' 페이지';
  $('groupResults').innerHTML=d.rows.length?d.rows.map(g=>`<article class="project-card"><div class="project-main"><span class="tag">통합 프로젝트</span><h4>${esc(g.title)}</h4><p>${esc(g.location)}</p><div class="meta"><span>발주처: ${esc(g.owner)}</span><span>연결 공고 ${fmt(g.notice_count)}건</span><span>공종 ${fmt(g.trade_count)}개</span><span>연락처 ${fmt(g.contact_count)}건</span></div></div><div class="card-actions"><button class="button primary" onclick="groupDetail(${Number(g.id)})">공종·연락처 보기</button></div></article>`).join(''):'<div class="panel">조건에 맞는 통합 프로젝트가 없습니다. 관리자 최초 일괄 연결 후 확인할 수 있습니다.</div>';
  $('groupPageInfo').textContent=d.page+' / '+groupPages;
  $('groupPrev').disabled=groupPage<=1;$('groupNext').disabled=groupPage>=groupPages;
 }catch(e){$('groupResults').innerHTML='<div class="notice">'+esc(e.message)+'</div>';}
}
window.groupDetail=async id=>{
 try{
  const g=await api('/api/project-groups/'+id);
  const roles=['client','designer','supervisor','contractor'];
  const allContacts=[...(g.contacts||[]),...(g.notices||[]).flatMap(n=>n.contacts||[])];
  const uniqueContacts=items=>[...new Map(items.map(c=>[[c.role,c.organization,c.department,c.person_name,c.phone,c.email].map(x=>String(x||'').trim()).join('|'),c])).values()];
  const byRole=role=>uniqueContacts(allContacts.filter(c=>c.role===role));
  const grouped=roles.map(role=>`<section class="role-section"><div class="role-heading"><h4>${roleLabels[role]}</h4><span class="role-count">${byRole(role).length}개</span></div>${byRole(role).length?byRole(role).map(contactCard).join(''):'<div class="empty-contact">확인된 정보 없음</div>'}</section>`).join('');
  const notices=(g.notices||[]);
  const noticeCards=notices.map(n=>{
    const contacts=uniqueContacts(n.contacts||[]);
    const hasDirect=contacts.some(c=>c.phone||c.email);
    return `<article class="trade-notice"><div class="role-heading"><span class="tag">${esc(n.building_type||'공종 미확인')}</span><span class="tag">${hasDirect?'전화·이메일 확보':contacts.length?'기관 정보 확보':'연락처 미확인'}</span></div><h4>${esc(n.notice_title)}</h4><p>발주처: ${esc(n.owner||'미확인')}</p><div class="notice-contact-list">${contacts.length?contacts.map(contactCard).join(''):'<p class="muted">해당 공고에서 확인된 담당자 연락처가 없습니다.</p>'}</div><div class="card-actions"><button class="button light" onclick="detail(${Number(n.id)})">공고 상세 보기</button>${n.source_url&&/^https?:/i.test(n.source_url)?` <a href="${esc(n.source_url)}" target="_blank" rel="noopener noreferrer">원본 공고 보기</a>`:''}</div></article>`;
  }).join('');
  const contactCount=uniqueContacts(allContacts).length;
  $('modalBody').innerHTML=`<span class="eyebrow">BUILD SIGNAL · 상위 프로젝트</span><h2 class="project-detail-title">${esc(g.title)}</h2><p class="muted">${esc(g.owner||'발주처 미확인')} · ${esc(g.location||'위치 미확인')}</p><div class="contact-section-title"><h3>공종별 원본 입찰공고 (${notices.length}건)</h3><p>연락처 ${contactCount}건 · 공고별 담당자와 확인된 출처를 함께 표시합니다. 미확인 정보는 생성하지 않습니다.</p></div><div class="trade-grid">${noticeCards}</div><div class="contact-section-title"><h3>프로젝트 전체 참여기관·연락처</h3><p>발주처·설계사·감리사·시공사별 확인된 정보만 표시합니다.</p></div><div class="roles-grid">${grouped}</div>`;
  $('modal').classList.remove('hidden');
 }catch(e){alert(e.message);}
};

function showPage(page){currentPage=page;document.querySelectorAll(".page").forEach(x=>x.classList.toggle("active",x.id===page));document.querySelectorAll("nav a").forEach(x=>x.classList.toggle("active",x.dataset.page===(page==="groups"?"projects":page)));$("pageTitle").textContent=({dashboard:"대시보드",groups:"건설 프로젝트 통합 검색",projects:"건설 프로젝트 통합 검색",recommend:"AI 영업 추천",favorites:"관심 현장"})[page]||"BUILD SIGNAL";if(page==="groups")groups(1);if(page==="projects")search(1);if(page==="recommend")recommendations();if(page==="favorites")favorites();if(page==="dashboard")dashboard();}
document.querySelectorAll("[data-search-tab]").forEach(btn=>btn.addEventListener("click",()=>{history.replaceState(null,"","#"+btn.dataset.searchTab);showPage(btn.dataset.searchTab);}));
document.querySelectorAll("[data-page],[data-go]").forEach(a=>a.addEventListener("click",e=>{e.preventDefault();const p=a.dataset.page||a.dataset.go;history.replaceState(null,"","#"+p);showPage(p);}));
$('groupSearchBtn').onclick=()=>groups(1);
$('groupQ').addEventListener('keydown',e=>{if(e.key==='Enter')groups(1);});
$('groupPrev').onclick=()=>{if(groupPage>1)groups(groupPage-1);};
$('groupNext').onclick=()=>{if(groupPage<groupPages)groups(groupPage+1);};
$("searchPeriod").onchange=()=>{const custom=$("searchPeriod").value==="custom";$("searchFromWrap").hidden=!custom;$("searchToWrap").hidden=!custom;search(1);};
$("dateField").onchange=()=>search(1);
$("searchBtn").onclick=()=>search(1);
$("prevPage").onclick=()=>{if(searchPage>1)search(searchPage-1);};
$("nextPage").onclick=()=>{if(searchPage<searchTotalPages)search(searchPage+1);};$("recommendBtn").onclick=recommendations;$("closeModal").onclick=()=>$("modal").classList.add("hidden");$("modal").onclick=e=>{if(e.target===$("modal"))$("modal").classList.add("hidden");};
$("q").addEventListener("keydown",e=>{if(e.key==="Enter")search(1);});
(async()=>{
  try {
    const me=await api('/api/me');
    const actions=document.querySelector('.top-actions');
    if(actions){
      const who=document.createElement('span');who.className='pill';who.textContent=me.user.company_name||me.user.email;actions.prepend(who);
      if(me.user.role==='admin'){const a=document.createElement('a');a.className='button light';a.href='/admin.html';a.textContent='회원관리';actions.append(a);}
      const out=document.createElement('button');out.className='button light';out.textContent='로그아웃';out.onclick=async()=>{await fetch('/api/logout',{method:'POST'});location.href='/login.html';};actions.append(out);
    }
    await loadRegionChoices();
    showPage(location.hash.slice(1)||'dashboard');
    const projectId=new URLSearchParams(location.search).get('projectId');if(projectId&&/^[1-9]\d*$/.test(projectId))detail(projectId);
  } catch(e) { location.replace('/login.html'); }
})();

async function loadRegionChoices(){
 try{
  const d=await api('/api/regions');
  for(const id of ['region','groupRegion']){
   const select=$(id),selected=select.value;select.replaceChildren();
   const all=document.createElement('option');all.value='';all.textContent='전체 지역';select.appendChild(all);
   for(const region of d.regions){const opt=document.createElement('option');opt.value=region.value;opt.textContent=region.label;select.appendChild(opt);}
   select.value=selected;
  }
 }catch{ /* Keep bundled HTML choices available when the region endpoint is temporarily unavailable. */ }
}
$('region').addEventListener('change',()=>{$('groupRegion').value=$('region').value;search(1);});
$('groupRegion').addEventListener('change',()=>{$('region').value=$('groupRegion').value;groups(1);});
async function loadAutomaticFreshness(){
 const out=$('autoFreshness');
 try{
  const d=await api('/api/ingestion/freshness');
  const time=v=>v?new Date(v).toLocaleString('ko-KR',{timeZone:'Asia/Seoul'}):'아직 없음';
  const parts=[d.enabled?'서버 자동 갱신 활성':'서버 자동 갱신 중지'];
  for(const row of d.sources){
   const label=row.source==='bids'?'나라장터 입찰':row.source==='early'?'건축심의 공개자료':row.source==='environment_review'?'전국 환경평가 공람':row.source==='seoul_review'?'서울 건축위원회 의결조서':row.source==='national_review'?'전국 심의 공개문서 색인':'국토부 인허가·착공·준공';
   const running=row.lease_until&&new Date(row.lease_until)>new Date();
   parts.push(label+': '+(!d.configured[row.source]?'인증키 설정 필요':running?'수집 중':row.last_error?'재시도 대기':'예약 대기')+' / 마지막 처리 성공 '+time(row.last_success_at));
  }
  if(d.seoulReview)parts.push('서울 심의 게시물 발견 '+fmt(d.seoulReview.discovered_posts)+'건 / 첨부 확인 '+fmt(d.seoulReview.checked_posts)+'건 / 지원 PDF 처리 '+fmt(d.seoulReview.processed_files)+'건 / 미지원 첨부 게시물 '+fmt(d.seoulReview.unsupported_posts)+'건 / PDF 오류 '+fmt(d.seoulReview.failed_files)+'건');
  parts.push('국토부 자동 수집 대상 '+fmt(d.coverage.regions)+'개 지역 / 전체 페이지 순회 완료 '+fmt(d.coverage.completed_regions)+'개');
  parts.push('전국 자료를 순차 적재 중입니다. 지역 선택은 저장된 자료를 검색하며, 미수집 지역은 아직 결과가 없을 수 있습니다.');
  out.textContent=parts.join(' · ');
 }catch(e){out.textContent='자동 갱신 상태를 확인하지 못했습니다. 잠시 후 다시 확인해 주세요.';}
}
loadAutomaticFreshness();
setInterval(()=>{if(!document.hidden)loadAutomaticFreshness();},60000);

function partyEvidenceHtml(rows){
 const labels={owner:'건축주',developer:'사업시행자',applicant:'심의 신청인',designer:'설계사',contractor:'시공사',supervisor:'감리사',operator:'운영·관리사'};
 const scopes={company:'회사 대표 연락처',department:'부서 연락처',project:'프로젝트 담당 연락처'};
 return '<section><h3>단계별 참여업체 근거</h3><p>원문에 기재된 역할로 구분합니다. 자동 추출 자료는 원문 확인이 필요하며, 아래는 시점별 기록입니다.</p>'+(!rows.length?'<p>확보된 참여업체 근거가 없습니다.</p>':rows.map(e=>'<article class="contact-entry"><b>'+esc(labels[e.role]||e.role)+' · '+esc(e.organization)+'</b><p>'+esc(stageLabel[e.observed_stage])+' / '+esc(e.origin==='automatic'?'원문 자동 추출·미확인':'관리자 근거 등록')+' / 확인 '+esc(new Date(e.observed_at).toLocaleDateString('ko-KR',{timeZone:'Asia/Seoul'}))+'</p><p>'+esc(scopes[e.contact_scope])+' · '+esc(e.person_name||'담당자 미확인')+' · '+esc(e.phone||'전화 미확인')+' · '+esc(e.email||'이메일 미확인')+'</p><p>'+esc(e.excerpt)+'</p><a href="'+esc(e.source_url)+'" target="_blank" rel="noopener noreferrer">근거 원문</a></article>').join(''))+'</section>';
}
function phaseHistoryHtml(rows){
 const events=[];
 for(const p of rows){
  if(p.stage==='REVIEW')events.push({date:p.source_updated_at,label:p.source==='environment_review'?'환경평가 공람 공개':'건축심의 공개자료',id:p.id});
  for(const [field,label] of [['permit_date','인허가'],['start_date','착공'],['completion_date','사용승인']])if(p[field])events.push({date:p[field],label,id:p.id});
 }
 events.sort((a,b)=>String(a.date||'').localeCompare(String(b.date||'')));
 return '<section><h3>프로젝트 진행 이력</h3><p>서로 다른 출처의 현장은 같은 사업으로 확인해 연결한 경우에만 함께 표시합니다.</p>'+events.map(e=>'<p>'+esc(e.date?String(e.date).slice(0,10):'날짜 미확인')+' · '+esc(e.label)+' · 현장 #'+esc(e.id)+'</p>').join('')+'</section>';
}

function companyDirectoryHtml(rows,coverage=[]){
 const stateLabel={inactive:'폐업·말소·취소·정지 확인 필요',candidate:'동일 상호 후보·미확인',matched:'업체 식별정보 일치',confirmed:'관리자 동일 업체 확인',historical:'이전 명부·갱신 확인 필요'};
 const sourceLabel={gyeonggi_developers:'경기부동산포털 공개 업체 명부',architects:'전국 건축사사무소 명부',busan_developers:'부산 개발업체 명부',daegu_developers:'대구 개발업체 명부',incheon_developers:'인천 개발업체 명부',ulsan_developers:'울산 개발업체 명부',chungnam_developers:'충남 개발업체 명부'};
 return '<section><h3>참여업체 회사 연락처</h3><p>명부 번호는 회사 연락처이며 현장 담당자 직통번호가 아닙니다. 동일 상호 후보는 같은 업체인지 확인해야 합니다.</p><p>개발업체 명부는 전국 연결 완료 상태가 아닙니다. '+coverage.filter(x=>x.source!=='architects').map(x=>esc(x.region)+': '+(x.status==='pending'?'아직 수집 성공 없음':esc(x.recordCount)+'건'+(x.status==='retained'?'·갱신 지연':''))+(x.phoneMode==='project_parties'?'·참여업체 회사 전화 조회':x.phoneProvided?'':'·전화 항목 미제공')).join(' / ')+' · 그 외 지역 미연결. 명부 부재가 업체 부재를 뜻하지 않습니다.</p>'+(!rows.length?'<p>연결 가능한 업체 명부가 아직 없습니다. 명부 갱신 상태 또는 업체명·사업장 주소를 확인하세요.</p>':rows.map(r=>'<article class="contact-entry"><b>'+esc(r.organization)+' · '+esc(stateLabel[r.match_status])+'</b><p>참여업체 근거 #'+esc(r.evidence_id)+' / 업체 명부 #'+esc(r.id)+'</p><p>'+esc(r.address||'사업장 주소 미제공')+' / 등록번호 '+esc(r.registration_no||'미제공')+'</p><p>회사 전화: '+esc(r.phone||'전화 미확인·미제공')+'</p><p>'+esc(r.match_reason)+' · 명부 기준일 '+esc(r.data_date||'미제공')+'</p><small>'+esc(sourceLabel[r.source]||r.source)+' · 수집 '+esc(String(r.fetched_at||'').slice(0,10))+'</small><p><a href="'+esc(r.source_url)+'" target="_blank" rel="noopener noreferrer">명부 출처</a></p></article>').join(''))+'</section>';
}

function environmentReviewHtml(rows){
 if(!rows.length)return '';
 return '<section><h3>환경평가 공람 정보</h3><p>환경평가 항목·범위의 결정내용 공개 시점 정보입니다. 건축심의 의결·건축허가·착공 완료를 뜻하지 않습니다. 출처: 기후에너지환경부 국립환경과학원 EIASS.</p>'+rows.map(r=>'<p>'+esc(r.kind==='strategic'?'전략환경영향평가':'환경영향평가')+' · 사업코드 '+esc(r.result_code)+'<br>공고일 '+esc(String(r.notice_date||'미제공').slice(0,10))+' · 공람기간 '+esc(r.public_period||'미제공')+'<br>승인기관 '+esc(r.approving_authority||'미제공')+' · 협의기관 '+esc(r.consulting_authority||'미제공')+'</p>').join('')+'</section>';
}

function architecturalReviewHtml(rows){
 if(!rows.length)return '';
 return '<section><h3>건축위원회 심의의결 기록</h3><p>심의 결과는 건축허가·착공 완료와 구분합니다. 공개 의결조서에 참여업체·담당 연락처가 없으면 임의로 채우지 않습니다.</p>'+rows.map(r=>'<p>'+esc(r.committee_name)+' · 심의일 '+esc(String(r.review_date||'미제공').slice(0,10))+'<br>의결번호 '+esc(r.decision_no)+' · 결과 '+esc(r.decision_result)+'<br><a href="'+esc(r.post_url)+'" target="_blank" rel="noopener noreferrer">서울시 공개 게시물</a></p>').join('')+'</section>';
}
