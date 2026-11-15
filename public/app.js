const stageLabel={REVIEW:"심의·환경평가",PERMIT:"인허가",STARTED:"착공",COMPLETED:"준공",BID:"입찰",UNKNOWN:"확인 필요"};
const $=id=>document.getElementById(id);
let currentPage="projects",searchPage=1,searchTotalPages=1,searchRequest=0,lastSearchRows=[];
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
 const badges=[p.notice_count?`<span class="signal-tag">입찰공고 ${fmt(p.notice_count)}건 · 공종 ${fmt(p.trade_count)}개</span>`:'',p.party_count?`<span class="signal-tag">참여업체 근거 ${fmt(p.party_count)}건</span>`:'',p.has_phone?'<span class="signal-tag success">☎ 전화 확보</span>':'',p.has_email?'<span class="signal-tag success">✉ 이메일 확보</span>':'',p.contact_count>0?`<span class="signal-tag">${fmt(p.contact_count)}개 연락처</span>`:''].filter(Boolean).join('');
 return `<article class="project-card"><div class="project-main"><div class="project-topline"><span class="tag ${p.stage==="STARTED"?"green":""}">${esc(displayStage(p))}</span><span class="project-source">${esc(p.source==='g2b_bid'?'나라장터 실제 공고':p.source==='demo'?'데모 데이터':p.source==='arch_hub_permit'?'건축HUB 인허가':p.source==='public_review'?'지자체 심의자료':p.source==='document_review'?'공식 심의 PDF 원문':p.source==='seoul_review'?'서울시 건축위원회 의결조서':p.source==='environment_review'?'국립환경과학원 EIASS 공개자료':p.source||'')}</span></div><h4>${esc(p.name)}</h4><p>${esc(p.address||"현장 주소 확인 중")}</p><div class="meta"><span>${p.owner?'발주처':p.owner_evidence?'건축주(원문 추출)':p.applicant_evidence?'심의 신청인(원문 추출)':p.developer_evidence?'사업시행자(원문 추출)':'건축주'}: ${esc(p.owner||p.owner_evidence||p.applicant_evidence||p.developer_evidence||(p.source==='seoul_review'?'원문 미제공':'확인 중'))}</span><span>용도·공종: ${esc(p.source==='g2b_bid'&&p.trade_count>1?'공종 '+fmt(p.trade_count)+'개':p.building_type||"미확인")} · 연면적: ${esc(ProjectWorkspace.area(p))}</span><span>${esc(p.region||"")}</span></div><div class="signal-tags">${p.source==='document_review'&&p.review_source_current===false?'<span class="signal-tag">과거 원문 기록 · 현재 안건 재확인 필요</span>':''}${p.architectural_review_result?'<span class="signal-tag">'+esc(p.architectural_review_result)+'</span>':''}${badges||'<span class="signal-tag muted-tag">연락처 확인 중</span>'}</div>${Array.isArray(p.recommendation_reasons)?'<ul class="recommend-reasons">'+p.recommendation_reasons.map(reason=>'<li>'+esc(reason)+'</li>').join('')+'</ul>':''}</div><div class="card-actions">${score!==undefined?`<span class="score">${score}점</span>`:""}<button class="button primary" onclick="detail(${Number(p.id)})">상세·연락처 보기</button></div></article>`;
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
function minimumAreaValue(){return $('minArea').value==='custom'?$('customArea').value:$('minArea').value;}
function syncCustomArea(focus=false){
 const custom=$('minArea').value==='custom';$('customAreaWrap').hidden=!custom;$('customArea').disabled=!custom;$('customArea').required=custom;
 if(custom&&focus)$('customArea').focus();
}
async function search(page=1){
 if($('minArea').value==='custom'&&!$('customArea').reportValidity())return;
 searchPage=Math.max(1,page);const request=++searchRequest;lastSearchRows=[];$('exportPage').disabled=true;$('projectResults').setAttribute('aria-busy','true');$('resultCount').textContent='검색 조건에 맞는 프로젝트를 찾는 중입니다.';
 const period=$("searchPeriod").value;
 const today=new Date();const localDay=d=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
 const fromDate=new Date(today.getFullYear(),today.getMonth(),today.getDate()-(Number(period)||0)+1);
 const from=period==="custom"?$("searchFrom").value:period?localDay(fromDate):"";
 const to=period==="custom"?$("searchTo").value:period?localDay(today):"";
 const params=new URLSearchParams({dateField:$("dateField").value,from,to,q:$("q").value,region:$("region").value,stage:$("stage").value==='EARLY'?'':$("stage").value,phase:$("stage").value==='EARLY'?'early':'',minArea:minimumAreaValue(),unknownArea:$("unknownArea").checked?'1':'0',sort:$("projectSort").value,type:$("type").value,page:String(searchPage),limit:"30"});
 try{
  const d=await api("/api/projects?"+params);if(request!==searchRequest)return;lastSearchRows=d.rows;
  searchTotalPages=Math.max(1,d.pages||1);
  $("resultCountSummary").textContent=fmt(d.total)+"건";$("exportPage").disabled=!d.rows.length;updateFilterSummary();
  $("resultCount").textContent=`총 ${fmt(d.total)}건 · ${d.page}/${searchTotalPages} 페이지`;
  $("projectResults").innerHTML=d.rows.length?ProjectWorkspace.render(d.rows,card,displayStage):emptyProjectSearch(d);
  $("pageInfo").textContent=`${d.page} / ${searchTotalPages}`;
  $("prevPage").disabled=searchPage<=1;$("nextPage").disabled=searchPage>=searchTotalPages;
 }catch(e){if(request!==searchRequest)return;$("projectResults").innerHTML=`<div class="notice">${esc(e.message)}</div>`;$("resultCount").textContent="검색하지 못했습니다. 다시 시도해 주세요.";$("resultCountSummary").textContent="—";}finally{if(request===searchRequest)$("projectResults").setAttribute("aria-busy","false");}
}
async function recommendations(){return window.RecommendationSearch.load();}
async function favorites(){try{const d=await api("/api/favorites");$("favoriteResults").innerHTML=d.rows.length?d.rows.map(p=>card(p)).join(""):'<div class="panel">관심 현장이 없습니다. 현장 상세에서 ☆ 관심 등록을 눌러주세요.</div>';}catch(e){$("favoriteResults").innerHTML=`<div class="notice">${esc(e.message)}</div>`;}}
const roleLabels={client:'발주기관',designer:'설계사',supervisor:'감리사',contractor:'시공사'};
function contactCard(c){
 const contact=(c.person_name?`<div class="contact-person">담당자 ${esc(c.person_name)}${c.department?' · '+esc(c.department):''}</div>`:'<div class="contact-person">담당자 미확인</div>');
 const phone=c.phone&&/^[+0-9() .-]{7,25}$/.test(c.phone)?`<a class="contact-link" href="tel:${esc(c.phone.replace(/[^+0-9]/g,''))}">☎ ${esc(c.phone)}</a>`:'<span class="contact-unavailable">전화 미확인</span>';
 const email=c.email&&/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(c.email)?`<a class="contact-link" href="mailto:${esc(c.email)}">✉ ${esc(c.email)}</a>`:'<span class="contact-unavailable">이메일 미확인</span>';
 const target=ProjectSource.classify(c.source_url,c.source);
 const url=['detail','document'].includes(target.kind)&&target.url?`<a href="${esc(target.url)}" target="_blank" rel="noopener noreferrer">${esc(target.label)} ↗</a>`:'';
 const verification=c.verified_at?'검증 기록 '+esc(String(c.verified_at).slice(0,10)):'검증 기록 없음';
 return `<div class="contact-entry"><b>${esc(c.organization)}</b>${contact}<div class="contact-links">${phone}${email}</div><small>${verification} · 출처: ${esc(c.source||'미확인')} · 갱신 ${esc(c.updated_at?String(c.updated_at).slice(0,10):'미확인')} ${url}</small></div>`;
}
window.detail=async id=>{
 try{
 const p=await api("/api/projects/"+id);
 const fields=[["현장 주소",p.address],["지역",`${p.region||"-"} ${p.district||""}`],["공종·건물 용도",p.building_type],["진행 단계",displayStage(p)],[p.source==='g2b_bid'&&(p.relatedNotices||[]).length>1?"대표 공고 금액":"공사금액",p.estimated_cost?fmt(p.estimated_cost)+"원":"미확인"],[p.source==='g2b_bid'?"공고 게시일":"인허가일",p.permit_date],["착공일",p.start_date],[p.source==='g2b_bid'?"입찰 마감일":"준공일",p.completion_date],["연면적",p.area_sqm?fmt(p.area_sqm)+"㎡":null],["정보 출처",p.source]];
 if(p.source==='document_review')fields.push(['원문 현재 수록',p.review_source_current===false?'최신 분석 원문에서 확인되지 않음 · 과거 기록':'현재 확인된 심의 안건']);
 const contacts=[...new Map((p.contacts||[]).map(c=>[JSON.stringify([c.role,c.organization,c.department,c.person_name,c.phone,c.email,c.source]),c])).values()];
 const phaseHtml=phaseHistoryHtml(p.phaseProjects||[]);
 const noticesHtml=relatedNoticesHtml(p.relatedNotices||[]);
 const roles=['client','designer','supervisor','contractor'];
 const contactHtml=roles.map(role=>`<section class="role-section"><div class="role-heading"><h4>${roleLabels[role]}</h4><span class="role-count">${contacts.filter(c=>c.role===role).length}개</span></div>${contacts.filter(c=>c.role===role).length?contacts.filter(c=>c.role===role).map(contactCard).join(''):`<div class="empty-contact">현재 확인된 ${roleLabels[role]} 담당자 연락처가 없습니다. 외부 데이터 연계로 보완 예정입니다.</div>`}</section>`).join('');
 $("modalBody").innerHTML=`<span class="eyebrow">BUILD SIGNAL · 프로젝트 상세</span><h2 class="project-detail-title">${esc(p.name)}</h2><p class="muted">${esc(p.source==='g2b_bid'?'나라장터 공고 기반 프로젝트':p.source==='demo'?'가상 데모 프로젝트':'프로젝트 정보')}</p><div class="detail-grid">${fields.map(([k,v])=>`<div class="detail-item"><small>${k}</small><b>${esc(v||"확인되지 않음")}</b></div>`).join("")}</div><div class="contact-section-title"><h3>참여 업체 및 담당자 연락처</h3></div><div class="roles-grid">${contactHtml}</div>${noticesHtml?'<section><h3>관련 입찰공고</h3><p>같은 사업으로 연결된 공종별 공고와 담당자 연락처입니다.</p><div class="trade-grid">'+noticesHtml+'</div></section>':''}${environmentReviewHtml(p.environmentalReviews||[])}${architecturalReviewHtml(p.architecturalReviews||[])}${phaseHtml}${hubConstructionHtml(p.hubConstruction||[])}${window.awardHistoryHtml(p.awards||[])}<div class="pipeline"><button class="button ${p.favorite?"primary":"light"}" id="favBtn">${p.favorite?"★ 관심 해제":"☆ 관심 등록"}</button><label>영업 단계<select id="pipeStatus"><option value="NEW">신규</option><option value="CONTACTED">접촉</option><option value="MEETING">미팅</option><option value="PROPOSAL">제안</option><option value="WON">수주</option><option value="LOST">실패</option></select></label></div><label class="note-label">영업 메모<textarea id="pipeNote" rows="3">${esc(p.pipeline?.note||'')}</textarea></label><button class="button primary" id="savePipeline">영업정보 저장</button>${ProjectSource.footer(p)}`;
 $("pipeStatus").value=p.pipeline?.status||"NEW";
 $("favBtn").onclick=async()=>{await api(`/api/projects/${id}/favorite`,{method:"POST"});detail(id);};
 $("savePipeline").onclick=async()=>{await api(`/api/projects/${id}/pipeline`,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({status:$("pipeStatus").value,note:$("pipeNote").value})});alert("영업정보를 저장했습니다.");};
 $("modal").classList.remove("hidden");
 }catch(e){alert(e.message);}
};

function relatedNoticesHtml(notices){
 if(!notices.length)return "";
 return notices.map(n=>{
    const contacts=(n.contacts||[]);
    const hasDirect=contacts.some(c=>c.phone||c.email);
    return `<article class="trade-notice"><div class="role-heading"><span class="tag">${esc(n.building_type||'공종 미확인')}</span><span class="tag">${hasDirect?'전화·이메일 확보':contacts.length?'기관 정보 확보':'연락처 미확인'}</span></div><h4>${esc(n.notice_title)}</h4><p>발주처: ${esc(n.owner||'미확인')}</p><div class="notice-contact-list">${contacts.length?contacts.map(contactCard).join(''):'<p class="muted">해당 공고에서 확인된 담당자 연락처가 없습니다.</p>'}</div><div class="card-actions"><button class="button light" onclick="detail(${Number(n.id)})">공고 상세 보기</button>${ProjectSource.footer(n)}</div></article>`;
  }).join('');
}
function showPage(page){if(page==="groups"){page="projects";$("stage").value="BID";history.replaceState(null,"","#projects");}if(!["dashboard","projects","recommend","favorites","awards"].includes(page))page="projects";currentPage=page;document.querySelectorAll(".page").forEach(x=>x.classList.toggle("active",x.id===page));document.querySelectorAll("nav a").forEach(x=>x.classList.toggle("active",x.dataset.page===page));$("pageTitle").textContent=({dashboard:"대시보드",awards:"수주·낙찰 DB",projects:"건설 프로젝트",recommend:"영업 추천",favorites:"관심·영업관리"})[page]||"BUILD SIGNAL";if(page==="awards")loadAwards(1);if(page==="projects")search(1);if(page==="recommend")recommendations();if(page==="favorites")favorites();if(page==="dashboard")dashboard();}
document.querySelectorAll("[data-page],[data-go]").forEach(a=>a.addEventListener("click",e=>{e.preventDefault();const p=a.dataset.page||a.dataset.go;history.replaceState(null,"","#"+p);showPage(p);}));
$("searchPeriod").onchange=()=>{const custom=$("searchPeriod").value==="custom";$("searchFromWrap").hidden=!custom;$("searchToWrap").hidden=!custom;search(1);};
$("dateField").onchange=()=>search(1);
$("projectSearchForm").addEventListener("submit",e=>{e.preventDefault();search(1);});
$("prevPage").onclick=()=>{if(searchPage>1)search(searchPage-1);};
$("nextPage").onclick=()=>{if(searchPage<searchTotalPages)search(searchPage+1);};$("closeModal").onclick=()=>$("modal").classList.add("hidden");$("modal").onclick=e=>{if(e.target===$("modal"))$("modal").classList.add("hidden");};

(async()=>{
  try {
    const me=await api('/api/me');
    const actions=document.querySelector('.top-actions');
    if(actions){
      const who=document.createElement('span');who.className='pill';who.textContent=me.user.company_name||me.user.email;actions.prepend(who);
      if(me.user.role==='admin'){const a=document.createElement('a');a.className='button light';a.href='/admin.html';a.textContent='관리자';actions.append(a);}
      const out=document.createElement('button');out.className='button light';out.textContent='로그아웃';out.onclick=async()=>{await fetch('/api/logout',{method:'POST'});location.href='/login.html';};actions.append(out);
    }
    await loadRegionChoices();
    showPage(location.hash.slice(1)||'projects');
    const projectId=new URLSearchParams(location.search).get('projectId');if(projectId&&/^[1-9]\d*$/.test(projectId))detail(projectId);
  } catch(e) { location.replace('/login.html'); }
})();

async function loadRegionChoices(){
 try{
  const d=await api('/api/regions');
  for(const id of ['region','recommendRegion']){
   const select=$(id),selected=select.value;select.replaceChildren();
   const all=document.createElement('option');all.value='';all.textContent=id==='recommendRegion'?'전국 전체':'전체 지역';select.appendChild(all);
   for(const region of d.regions){const opt=document.createElement('option');opt.value=region.value;opt.textContent=region.label;select.appendChild(opt);}
   select.value=selected;
  }
 }catch{ /* Keep bundled HTML choices available when the region endpoint is temporarily unavailable. */ }
}
$('region').addEventListener('change',()=>search(1));

function phaseHistoryHtml(rows){
 const events=[];
 for(const p of rows){
  if(p.stage==='REVIEW')events.push({date:p.source_updated_at,label:p.source==='environment_review'?'환경평가 공람 공개':'건축심의 공개자료',id:p.id});
  for(const [field,label] of [['permit_date','인허가'],['start_date','착공'],['completion_date','사용승인']])if(p[field])events.push({date:p[field],label,id:p.id});
 }
 events.sort((a,b)=>String(a.date||'').localeCompare(String(b.date||'')));
 return '<section><h3>프로젝트 진행 이력</h3>'+events.map(e=>'<p>'+esc(e.date?String(e.date).slice(0,10):'날짜 미확인')+' · '+esc(e.label)+' · 현장 #'+esc(e.id)+'</p>').join('')+'</section>';
}

function environmentReviewHtml(rows){
 if(!rows.length)return '';
 return '<section><h3>환경평가 공람 정보</h3><p>환경평가 항목·범위의 결정내용 공개 시점 정보입니다. 건축심의 의결·건축허가·착공 완료를 뜻하지 않습니다. 출처: 기후에너지환경부 국립환경과학원 EIASS.</p>'+rows.map(r=>'<p>'+esc(r.kind==='strategic'?'전략환경영향평가':'환경영향평가')+' · 사업코드 '+esc(r.result_code)+'<br>공고일 '+esc(String(r.notice_date||'미제공').slice(0,10))+' · 공람기간 '+esc(r.public_period||'미제공')+'<br>승인기관 '+esc(r.approving_authority||'미제공')+' · 협의기관 '+esc(r.consulting_authority||'미제공')+'</p>').join('')+'</section>';
}

function architecturalReviewHtml(rows){
 if(!rows.length)return '';
 return '<section><h3>건축위원회 심의의결 기록</h3>'+rows.map(r=>'<p>'+esc(r.committee_name)+' · 심의일 '+esc(String(r.review_date||'미제공').slice(0,10))+'<br>의결번호 '+esc(r.decision_no)+' · 결과 '+esc(r.decision_result)+'<br><a href="'+esc(r.post_url)+'" target="_blank" rel="noopener noreferrer">공식 심의 공개 게시물</a></p>').join('')+'</section>';
}

function updateFilterSummary(){
 const labels=[];if($('region').value)labels.push($('region').selectedOptions[0].textContent);if($('stage').value)labels.push($('stage').selectedOptions[0].textContent);if($('type').value)labels.push('용도·공종 '+$('type').value);if(minimumAreaValue()!=='')labels.push('연면적 '+fmt(minimumAreaValue())+'㎡ 이상'+($('unknownArea').checked?' · 미확인 포함':' · 미확인 제외'));if($('q').value)labels.push('검색어 '+$('q').value);
 const period=$('searchPeriod').value,basis=$('dateField').selectedOptions[0]?.textContent||'';if(period==='custom'){const from=$('searchFrom').value,to=$('searchTo').value;if(from||to)labels.push((from||'시작일 미지정')+' ~ '+(to||'종료일 미지정')+' · '+basis);}else if(period)labels.push(({7:'최근 7일',30:'최근 30일',90:'최근 3개월',365:'최근 1년'})[period]+' · '+basis);
 $('activeFilterSummary').textContent=labels.join(' / ');$('activeFilterSummary').hidden=!labels.length;
 document.querySelectorAll('[data-quick]').forEach(b=>{const k=b.dataset.quick;const on=k==='large'?minimumAreaValue()!==''&&Number(minimumAreaValue())===10000:k==='bid'?$('stage').value==='BID':k==='early'?$('stage').value==='EARLY':k==='hotel'?$('type').value==='숙박시설':k==='office'?$('type').value==='업무시설':$('searchPeriod').value==='30'&&$('dateField').value==='collected';b.classList.toggle('selected',on);b.setAttribute('aria-pressed',String(on));});
}
for(const id of ['unknownArea','projectSort','stage'])$(id).addEventListener('change',()=>search(1));
$('minArea').addEventListener('change',()=>{syncCustomArea(true);if($('minArea').value!=='custom'||$('customArea').value!=='')search(1);});
$('customArea').addEventListener('change',()=>search(1));
syncCustomArea();
$('resetSearch').addEventListener('click',()=>{$('projectSearchForm').reset();syncCustomArea();$('projectSort').value='priority';$('searchFromWrap').hidden=true;$('searchToWrap').hidden=true;search(1);});
document.querySelectorAll('[data-quick]').forEach(b=>b.addEventListener('click',()=>{const k=b.dataset.quick;if(k==='bid')$('stage').value=$('stage').value==='BID'?'':'BID';if(k==='large'){$('minArea').value=minimumAreaValue()==='10000'?'':'10000';syncCustomArea();}if(k==='early')$('stage').value=$('stage').value==='EARLY'?'':'EARLY';if(k==='hotel'||k==='office'){const v=k==='hotel'?'숙박시설':'업무시설';$('type').value=$('type').value===v?'':v;}if(k==='recent'){$('searchPeriod').value=$('searchPeriod').value==='30'?'':'30';$('dateField').value='collected';$('searchFromWrap').hidden=true;$('searchToWrap').hidden=true;}search(1);}));
$('exportPage').addEventListener('click',()=>{if(!lastSearchRows.length)return;const blob=new Blob([ProjectWorkspace.csv(lastSearchRows,displayStage)],{type:'text/csv;charset=utf-8;'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='BUILD-SIGNAL_현재페이지.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);});

function hubConstructionHtml(rows){
 if(!rows.length)return '';
 return '<section class="panel"><h3>HUB 공사현장 대조 기록</h3><p>예정일은 실제 착공·사용승인과 구분합니다. 업체 연락처는 공개 원문 기준이며 직통 담당자 번호로 보장하지 않습니다.</p>'+rows.map(r=>'<p>현장 #'+esc(r.project_id)+' · '+esc(({matched:'관리번호·주소·허가일 대조 성공',not_found:'HUB 조회 결과 없음 · 기존 근거 유지',error:'재확인 대기'})[r.outcome]||'확인 중')+'<br>마지막 정상 조회 '+esc(r.last_success_at?new Date(r.last_success_at).toLocaleString('ko-KR',{timeZone:'Asia/Seoul'}):'없음')+'<br>HUB 착공예정일 '+esc(r.planned_start||'미제공')+' · 준공예정일 '+esc(r.planned_completion||'미제공')+(r.last_error?'<br>'+esc(r.last_error):'')+'</p>').join('')+'<a href="https://www.hub.go.kr/portal/gis/css/idx-css-list.do" target="_blank" rel="noopener noreferrer">HUB 공사현장 조회 ↗</a></section>';
}
