const stageLabel={PERMIT:"인허가",STARTED:"착공",COMPLETED:"준공",BID:"입찰",UNKNOWN:"확인 필요"};
const $=id=>document.getElementById(id);
let currentPage="dashboard",searchPage=1,searchTotalPages=1;
function esc(s){return String(s??"-").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}
function fmt(n){return Number(n||0).toLocaleString("ko-KR");}
function card(p,score){
 const badges=[p.has_phone?'<span class="signal-tag success">☎ 전화 확보</span>':'',p.has_email?'<span class="signal-tag success">✉ 이메일 확보</span>':'',p.contact_count>0?`<span class="signal-tag">${fmt(p.contact_count)}개 연락처</span>`:''].filter(Boolean).join('');
 return `<article class="project-card"><div class="project-main"><div class="project-topline"><span class="tag ${p.stage==="STARTED"?"green":""}">${stageLabel[p.stage]||"확인 필요"}</span><span class="project-source">${esc(p.source==='g2b_bid'?'나라장터 실제 공고':p.source==='demo'?'데모 데이터':p.source||'')}</span></div><h4>${esc(p.name)}</h4><p>${esc(p.address||"현장 주소 확인 중")}</p><div class="meta"><span>발주처: ${esc(p.owner||"확인 중")}</span><span>공종: ${esc(p.building_type||"미확인")}</span><span>${esc(p.region||"")}</span></div><div class="signal-tags">${badges||'<span class="signal-tag muted-tag">연락처 확인 중</span>'}</div></div><div class="card-actions">${score!==undefined?`<span class="score">${score}점</span>`:""}<button class="button primary" onclick="detail(${Number(p.id)})">상세·연락처 보기</button></div></article>`;
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
  $("projectResults").innerHTML=d.rows.length?d.rows.map(p=>card(p)).join(""):'<div class="panel">검색 결과가 없습니다.</div>';
  $("pageInfo").textContent=`${d.page} / ${searchTotalPages}`;
  $("prevPage").disabled=searchPage<=1;$("nextPage").disabled=searchPage>=searchTotalPages;
 }catch(e){$("projectResults").innerHTML=`<div class="notice">${esc(e.message)}</div>`;}
}
async function recommendations(){try{const d=await api("/api/recommendations?profile="+$("profile").value);$("recommendResults").innerHTML=d.rows.length?d.rows.map(p=>card(p,p.score)).join(""):'<div class="panel">추천할 현장이 없습니다.</div>';}catch(e){$("recommendResults").innerHTML=`<div class="notice">${esc(e.message)}</div>`;}}
async function favorites(){try{const d=await api("/api/favorites");$("favoriteResults").innerHTML=d.rows.length?d.rows.map(p=>card(p)).join(""):'<div class="panel">관심 현장이 없습니다. 현장 상세에서 ☆ 관심 등록을 눌러주세요.</div>';}catch(e){$("favoriteResults").innerHTML=`<div class="notice">${esc(e.message)}</div>`;}}
const roleLabels={client:'발주처·시행사',designer:'설계사',supervisor:'감리사',contractor:'시공사'};
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
 const fields=[["현장 주소",p.address],["지역",`${p.region||"-"} ${p.district||""}`],["공종·건물 용도",p.building_type],["진행 단계",stageLabel[p.stage]],["공사금액",p.estimated_cost?fmt(p.estimated_cost)+"원":"미확인"],["인허가일",p.permit_date],["착공일",p.start_date],["준공일",p.completion_date],["연면적",p.area_sqm?fmt(p.area_sqm)+"㎡":null],["정보 출처",p.source]];
 const contacts=p.contacts||[];
 const roles=['client','designer','supervisor','contractor'];
 const contactHtml=roles.map(role=>`<section class="role-section"><div class="role-heading"><h4>${roleLabels[role]}</h4><span class="role-count">${contacts.filter(c=>c.role===role).length}개</span></div>${contacts.filter(c=>c.role===role).length?contacts.filter(c=>c.role===role).map(contactCard).join(''):`<div class="empty-contact">현재 확인된 ${roleLabels[role]} 담당자 연락처가 없습니다. 외부 데이터 연계로 보완 예정입니다.</div>`}</section>`).join('');
 $("modalBody").innerHTML=`<span class="eyebrow">BUILD SIGNAL · 프로젝트 상세</span><h2 class="project-detail-title">${esc(p.name)}</h2><p class="muted">${esc(p.source==='g2b_bid'?'나라장터 공고 기반 프로젝트':p.source==='demo'?'가상 데모 프로젝트':'프로젝트 정보')}</p><div class="detail-grid">${fields.map(([k,v])=>`<div class="detail-item"><small>${k}</small><b>${esc(v||"확인되지 않음")}</b></div>`).join("")}</div><div class="contact-section-title"><h3>참여 업체 및 담당자 연락처</h3><p>공개 출처에서 확인된 정보만 표시합니다.</p></div><div class="roles-grid">${contactHtml}</div><div class="pipeline"><button class="button ${p.favorite?"primary":"light"}" id="favBtn">${p.favorite?"★ 관심 해제":"☆ 관심 등록"}</button><label>영업 단계<select id="pipeStatus"><option value="NEW">신규</option><option value="CONTACTED">접촉</option><option value="MEETING">미팅</option><option value="PROPOSAL">제안</option><option value="WON">수주</option><option value="LOST">실패</option></select></label></div><label class="note-label">영업 메모<textarea id="pipeNote" rows="3">${esc(p.pipeline?.note||'')}</textarea></label><button class="button primary" id="savePipeline">영업정보 저장</button>${p.source_url&&/^https?:\/\//i.test(p.source_url)?`<p class="source-footer"><a href="${esc(p.source_url)}" target="_blank" rel="noopener noreferrer">원본 공고 확인 ↗</a></p>`:''}<p class="muted">담당자 연락처는 공개 업무용 정보이며, 실제 연락 전 출처 및 최신성을 확인하세요.</p>`;
 $("pipeStatus").value=p.pipeline?.status||"NEW";
 $("favBtn").onclick=async()=>{await api(`/api/projects/${id}/favorite`,{method:"POST"});detail(id);};
 $("savePipeline").onclick=async()=>{await api(`/api/projects/${id}/pipeline`,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({status:$("pipeStatus").value,note:$("pipeNote").value})});alert("영업정보를 저장했습니다.");};
 $("modal").classList.remove("hidden");
 }catch(e){alert(e.message);}
};

let groupPage=1,groupPages=1;
async function groups(page=1){
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

function showPage(page){currentPage=page;document.querySelectorAll(".page").forEach(x=>x.classList.toggle("active",x.id===page));document.querySelectorAll("nav a").forEach(x=>x.classList.toggle("active",x.dataset.page===(page==="projects"?"groups":page)));$("pageTitle").textContent=({dashboard:"대시보드",groups:"건설 프로젝트 통합 검색",projects:"건설 프로젝트 통합 검색",recommend:"AI 영업 추천",favorites:"관심 현장"})[page]||"BUILD SIGNAL";if(page==="groups")groups(1);if(page==="projects")search(1);if(page==="recommend")recommendations();if(page==="favorites")favorites();if(page==="dashboard")dashboard();}
document.querySelectorAll("[data-search-tab]").forEach(btn=>btn.addEventListener("click",()=>{history.replaceState(null,"","#"+btn.dataset.searchTab);showPage(btn.dataset.searchTab);}));
document.querySelectorAll("[data-page],[data-go]").forEach(a=>a.addEventListener("click",e=>{e.preventDefault();const p=a.dataset.page||a.dataset.go;history.replaceState(null,"","#"+p);showPage(p);}));
$('groupSearchBtn').onclick=()=>groups(1);
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
    showPage(location.hash.slice(1)||'dashboard');
  } catch(e) { location.replace('/login.html'); }
})();
