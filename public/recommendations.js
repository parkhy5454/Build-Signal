(()=>{
 const $=id=>document.getElementById(id),form=$('recommendForm');if(!form)return;
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 let request=0,districtRequest=0,districtPending=Promise.resolve();
 const fields=()=>({profile:$('profile').value,product:$('recommendProduct').value.trim(),region:$('recommendRegion').value,district:$('recommendDistrict').value});
 async function get(url){const r=await fetch(url);const d=await r.json();if(!r.ok)throw Error(d.error||'조회 실패');return d;}
 function invalidate(){request++;$('recommendBtn').disabled=false;$('recommendSummary').textContent='조건이 변경되었습니다. 추천 현장 분석을 눌러주세요.';$('recommendResults').innerHTML='';}
 async function districts(){
  const id=++districtRequest,region=$('recommendRegion').value,select=$('recommendDistrict');select.disabled=true;select.innerHTML='<option value="">'+(region?'시·군·구 불러오는 중…':'시·도 먼저 선택')+'</option>';select.value='';
  if(!region)return;
  try{const d=await get('/api/recommendation-districts?'+new URLSearchParams({region}));if(id!==districtRequest||region!==$('recommendRegion').value)return;
   select.innerHTML='<option value="">시·군·구 전체</option>'+d.districts.map(v=>'<option value="'+esc(v)+'">'+esc(v)+'</option>').join('');select.disabled=!d.districts.length;
   if(!d.districts.length)select.innerHTML='<option value="">저장된 시·군·구 없음</option>';
  }catch(e){if(id!==districtRequest)return;select.innerHTML='<option value="">시·도 전체로 검색</option>';$('recommendSummary').textContent='시·군·구를 불러오지 못했습니다. 시·도 전체로 검색할 수 있습니다.';}
 }
 async function load(){
  const id=++request;await districtPending;if(id!==request||!form.reportValidity())return;
  const options=fields(),fingerprint=JSON.stringify(options);$('recommendBtn').disabled=true;$('recommendSummary').textContent='조건에 맞는 추천 현장을 찾고 있습니다.';$('recommendResults').innerHTML='';
  try{const d=await get('/api/recommendations?'+new URLSearchParams(options));if(id!==request||fingerprint!==JSON.stringify(fields()))return;
   const label=[d.product||d.profile,d.region||'전국',d.district||''].filter(Boolean).join(' · ');
   $('recommendSummary').textContent=label+' | '+(d.match_mode==='related'?'제품 연관 분류: '+d.intent+' · ':'')+'후보 '+Number(d.total||0).toLocaleString('ko-KR')+'개 중 '+d.rows.length+'개 추천 (최대 100개). '+d.note;
   $('recommendResults').innerHTML=d.rows.length?d.rows.map(p=>window.card(p,p.score)).join(''):'<div class="panel">선택한 제품·지역과 관련된 저장 자료를 찾지 못했습니다. 지역을 넓히거나 제품명을 바꾸어 검색해 주세요.</div>';
  }catch(e){if(id!==request)return;$('recommendSummary').textContent='추천 조회 실패';$('recommendResults').innerHTML='<div class="notice">'+esc(e.message)+'</div>';}
  finally{if(id===request)$('recommendBtn').disabled=false;}
 }
 $('recommendRegion').addEventListener('change',()=>{invalidate();districtPending=districts();});
 $('recommendDistrict').addEventListener('change',invalidate);$('profile').addEventListener('change',invalidate);$('recommendProduct').addEventListener('input',invalidate);
 form.addEventListener('submit',e=>{e.preventDefault();void load();});window.RecommendationSearch={load};
})();
