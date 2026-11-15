(()=>{
 const $=id=>document.getElementById(id),form=$('recommendForm');if(!form)return;
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 let request=0;
 const fields=()=>({profile:$('profile').value,product:$('recommendProduct').value.trim(),region:$('recommendRegion').value});
 async function get(url){const r=await fetch(url);const d=await r.json();if(!r.ok)throw Error(d.error||'조회 실패');return d;}
 function status(text){$('recommendSummary').textContent=text;$('recommendSummary').hidden=!text;}
 function invalidate(){request++;$('recommendBtn').disabled=false;status('조건이 변경되었습니다. 추천 현장 분석을 눌러주세요.');$('recommendResults').innerHTML='';}
 async function load(){
  const id=++request;if(!form.reportValidity())return;
  const options=fields(),fingerprint=JSON.stringify(options);$('recommendBtn').disabled=true;status('조건에 맞는 추천 현장을 찾고 있습니다.');$('recommendResults').innerHTML='';
  try{const d=await get('/api/recommendations?'+new URLSearchParams(options));if(id!==request||fingerprint!==JSON.stringify(fields()))return;
   status('');
   $('recommendResults').innerHTML=d.rows.length?d.rows.map(p=>window.card(p,p.score)).join(''):'<div class="panel">선택한 제품·지역과 관련된 저장 자료를 찾지 못했습니다. 지역을 넓히거나 제품명을 바꾸어 검색해 주세요.</div>';
  }catch(e){if(id!==request)return;status('추천 조회 실패');$('recommendResults').innerHTML='<div class="notice">'+esc(e.message)+'</div>';}
  finally{if(id===request)$('recommendBtn').disabled=false;}
 }
 $('recommendRegion').addEventListener('change',invalidate);$('profile').addEventListener('change',invalidate);$('recommendProduct').addEventListener('input',invalidate);
 form.addEventListener('submit',e=>{e.preventDefault();void load();});window.RecommendationSearch={load};
})();
