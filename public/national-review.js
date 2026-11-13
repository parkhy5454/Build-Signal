(()=>{
 const form=document.getElementById('reviewNoticeForm');if(!form)return;
 const out=document.getElementById('reviewNoticeResults'),summary=document.getElementById('reviewNoticeSummary'),region=document.getElementById('reviewNoticeRegion'),keyword=document.getElementById('reviewNoticeKeyword');
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const link=u=>{try{const v=new URL(u);return ['http:','https:'].includes(v.protocol)&&!v.username&&!v.password&&v.hostname.endsWith('.go.kr')?v.href:null;}catch{return null;}};
 let page=1,total=0,request=0;
 async function load(next=1){
  const serial=++request;summary.textContent='전국 심의 공개문서 조회 중...';
  try{
   const r=await fetch('/api/review-notices?'+new URLSearchParams({region:region.value,q:keyword.value,page:String(next)}));if(!r.ok)throw Error();const d=await r.json();if(serial!==request)return;page=d.page;total=d.total;
   summary.textContent='심의 공개문서 '+total.toLocaleString('ko-KR')+'건 · '+page+' / '+Math.max(1,Math.ceil(total/20))+'페이지. 발행기관 지역 기준이며 현장 위치·프로젝트 수와 다릅니다.';
   out.innerHTML=d.rows.length?d.rows.map(row=>{const original=row.status==='checked'?link(row.original_url):null,index=link(row.index_url);return '<article class="project-card"><div class="project-main"><span class="tag">심의 공개문서 · 프로젝트 추출 대기</span><h4>'+esc(row.title)+'</h4><p>'+esc(row.publisher)+' · 발행지역 '+esc(row.publisher_region||'미확인')+' · 게시일 '+esc(String(row.published_date).slice(0,10))+'</p><p class="muted">발주처·설계사·담당 연락처는 이 문서 목록에서 확인된 정보가 아닙니다.</p><div class="actions">'+(original?'<a class="button primary" target="_blank" rel="noopener noreferrer" href="'+esc(original)+'">지자체 원문 보기</a>':'<span>원문 링크 '+(row.status==='error'?'재확인 중':'확인 대기')+'</span>')+(index?'<a class="button light" target="_blank" rel="noopener noreferrer" href="'+esc(index)+'">국회도서관 출처</a>':'')+'</div></div></article>';}).join(''):'<p class="empty">현재 저장된 공개문서가 없습니다. 자동 탐색 진행 중이며, 해당 지역에 심의 사업이 없다는 뜻은 아닙니다.</p>';
   document.getElementById('reviewNoticePrev').disabled=page<=1;document.getElementById('reviewNoticeNext').disabled=page*20>=total;
  }catch{if(serial===request)summary.textContent='공개문서를 불러오지 못했습니다. 잠시 후 다시 조회해 주세요.';}
 }
 form.addEventListener('submit',e=>{e.preventDefault();void load(1);});region.addEventListener('change',()=>void load(1));
 document.getElementById('reviewNoticePrev').addEventListener('click',()=>void load(Math.max(1,page-1)));document.getElementById('reviewNoticeNext').addEventListener('click',()=>void load(page+1));
 fetch('/api/regions').then(r=>{if(!r.ok)throw Error();return r.json();}).then(d=>{for(const r of d.regions){const o=document.createElement('option');o.value=r.value;o.textContent=r.label;region.appendChild(o);}}).catch(()=>{summary.textContent='지역 목록을 불러오지 못했습니다. 전체 지역으로 조회합니다.';});
 void load();
})();
