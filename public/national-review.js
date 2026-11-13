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
   out.innerHTML=d.rows.length?d.rows.map(row=>{const projects=row.extracted_projects||[];const original=row.status==='checked'?link(row.original_url):null,index=link(row.index_url);return '<article class="project-card"><div class="project-main"><span class="tag">심의 공개문서 · '+(projects.length?'현장정보 추출 '+projects.length+'건':'프로젝트 정보 미분석')+'</span><h4>'+esc(row.title)+'</h4><p>'+esc(row.publisher)+' · 발행지역 '+esc(row.publisher_region||'미확인')+' · 게시일 '+esc(String(row.published_date).slice(0,10))+'</p><p class="muted">발주처·설계사·담당 연락처는 이 문서 목록에서 확인된 정보가 아닙니다.</p><div class="actions">'+projects.map(p=>'<a class="button primary" href="/?projectId='+Number(p.id)+'#projects">추출 현장: '+esc(p.name)+'</a>').join('')+(original?'<a class="button primary" target="_blank" rel="noopener noreferrer" href="'+esc(original)+'">지자체 원문 보기</a>':'<span>원문 링크 '+(row.status==='error'?'재확인 중':'확인 대기')+'</span>')+(index?'<a class="button light" target="_blank" rel="noopener noreferrer" href="'+esc(index)+'">국회도서관 출처</a>':'')+'</div></div></article>';}).join(''):'<p class="empty">현재 저장된 공개문서가 없습니다. 자동 탐색 진행 중이며, 해당 지역에 심의 사업이 없다는 뜻은 아닙니다.</p>';
   document.getElementById('reviewNoticePrev').disabled=page<=1;document.getElementById('reviewNoticeNext').disabled=page*20>=total;
  }catch{if(serial===request)summary.textContent='공개문서를 불러오지 못했습니다. 잠시 후 다시 조회해 주세요.';}
 }
 form.addEventListener('submit',e=>{e.preventDefault();void load(1);});region.addEventListener('change',()=>void load(1));
 document.getElementById('reviewNoticePrev').addEventListener('click',()=>void load(Math.max(1,page-1)));document.getElementById('reviewNoticeNext').addEventListener('click',()=>void load(page+1));
 fetch('/api/regions').then(r=>{if(!r.ok)throw Error();return r.json();}).then(d=>{for(const r of d.regions){const o=document.createElement('option');o.value=r.value;o.textContent=r.label;region.appendChild(o);}}).catch(()=>{summary.textContent='지역 목록을 불러오지 못했습니다. 전체 지역으로 조회합니다.';});
 void load();
})();
(()=>{
 const out=document.getElementById('reviewExtractionResults');if(!out)return;
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const safe=url=>{try{const u=new URL(url);return u.protocol==='https:'&&u.hostname==='www.incheon.go.kr'&&!u.username&&!u.password?u.href:null;}catch{return null;}};
 async function refresh(){try{
  const r=await fetch('/api/review-extraction');if(!r.ok)throw Error();const d=await r.json(),labels={extracted:'안건 추출 완료',unsupported:'미지원 형식',error:'오류·재시도 대기',pending:'분석 대기'};
  out.innerHTML='<p>'+d.counts.map(c=>esc(labels[c.status]||c.status)+' PDF·첨부 '+esc(c.files)+'건 / 안건 '+esc(c.records)+'건').join(' · ')+'</p><p>'+esc(d.note)+'</p>'+(d.files.length?d.files.map(f=>'<div class="detail-item"><b>'+esc(f.name)+'</b><p>'+esc(labels[f.status]||f.status)+(f.last_error?' · '+esc(f.last_error):'')+'</p>'+f.projects.map(p=>'<p><a href="/?projectId='+Number(p.id)+'#projects">추출한 현장: '+esc(p.name)+'</a></p>').join('')+(safe(f.page_url)?'<a target="_blank" rel="noopener noreferrer" href="'+esc(safe(f.page_url))+'">공식 게시물</a>':'')+'</div>').join(''):'<p>공식 첨부파일을 자동 확인하고 있습니다.</p>');
 }catch{out.textContent='심의 원문 분석 상태를 불러오지 못했습니다.';}}
 void refresh();setInterval(()=>{if(!document.hidden)void refresh();},60000);
})();
