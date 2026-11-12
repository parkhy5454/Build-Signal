(()=>{
 const out=document.getElementById('nationalCoverage');if(!out)return;
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const status={key_missing:'인증키 필요',queue_pending:'수집 대상 등록 대기',pending:'첫 수집 대기',initial_loading:'최초 순회 중',refresh_pending:'갱신 순회 대기',cycle_current:'최근 24시간 내 순회',unconnected:'미연결',synced:'명부 갱신 성공',retained:'일부 갱신 지연·이전 명부 유지',partial:'일부 출처'};
 let loading=false;
 async function load(){
  if(loading)return;loading=true;
  try{
   const response=await fetch('/api/ingestion/coverage');if(!response.ok)throw Error('수집 현황 조회 실패');const d=await response.json();
   const rows=d.rows.map(r=>'<tr><th scope="row">'+esc(r.label)+'</th><td>'+esc(status[r.permits.status])+'<br>순회 '+esc(r.permits.completed)+' / '+esc(r.permits.targets)+'개 법정동<br>24시간 내 '+esc(r.permits.fresh)+'개 · 오류 '+esc(r.permits.failed)+'개</td><td>'+esc(r.developers.status==='pending'?'명부 첫 수집 대기':status[r.developers.status])+(r.developers.sources.length?'<br>'+r.developers.sources.map(s=>esc(s.region)+' '+esc(s.recordCount)+'건 · '+(s.phoneMode==='project_parties'?'참여업체 회사 전화 조회':s.phoneProvided?'전화 항목 제공':'전화 항목 미제공')).join('<br>'):'')+'</td><td>'+esc(r.review.scope||status[r.review.status])+'</td></tr>').join('');
   out.innerHTML='<p>'+esc(d.enabled?'서버 자동 수집 활성':'서버 자동 수집 중지')+' · 공식 지역코드 기준 '+esc(d.catalogDate)+'<br>인허가·착공·준공은 시·도를 번갈아 순회합니다. 개발업체 명부와 심의자료는 아래 연결 범위를 확인하세요.</p><div class="coverage-scroll" tabindex="0" role="region" aria-label="전국 지역별 수집 현황"><table><thead><tr><th scope="col">지역</th><th scope="col">인허가·착공·준공</th><th scope="col">개발업체 회사 명부</th><th scope="col">건축위원회 심의자료</th></tr></thead><tbody>'+rows+'</tbody></table></div><p>국토부 자동 호출 한도 '+esc(d.dailyRequestBudget)+'회/일'+(d.initialScanMinimumDays!==null?' · 최초 순회 최소 '+esc(d.initialScanMinimumDays)+'일 (추가 페이지·재시도 제외)':'')+'</p><p>'+d.limitations.map(esc).join('<br>')+'</p><p>전국 환경·전략환경평가 공람: '+esc(d.environmentalReview.status==='pending'?'첫 조회 대기':d.environmentalReview.status==='partial'?'일부 오류·재시도 대기':'공개목록 조회 성공')+' · 저장 '+esc(d.environmentalReview.total)+'건 / 지역 미확인 '+esc(d.environmentalReview.unlocated)+'건<br>'+esc(d.environmentalReview.scope)+' · <a href="'+esc(d.environmentalReview.sourceUrl)+'" target="_blank" rel="noopener noreferrer">공식 원천</a></p><p>전국 개발업체 통합 출처: 응답·필드 검증 및 연결 대기 · <a href="'+esc(d.nationalDeveloperSource.url)+'" target="_blank" rel="noopener noreferrer">공식 원천 안내</a></p>';
  }catch{out.textContent='전국 수집 현황을 확인하지 못했습니다. 다음 자동 점검에서 다시 조회합니다.';}finally{loading=false;}
 }
 void load();setInterval(()=>{if(!document.hidden)void load();},60000);
})();
