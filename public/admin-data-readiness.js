(()=>{
 const out=document.getElementById('dataReadiness'),button=document.getElementById('refreshDataReadiness');if(!out||!button)return;
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const n=v=>Number.isFinite(Number(v))?Number(v).toLocaleString('ko-KR'):'—';
 const rate=(v,total)=>total>0?n(v)+' / '+n(total)+' ('+(100*Number(v)/total).toFixed(1)+'%)':n(v)+' / 0 (산출 대상 없음)';
 const stages={REVIEW:'심의·환경평가',PERMIT:'인허가',STARTED:'착공',COMPLETED:'사용승인',BID:'입찰',UNKNOWN:'확인 필요'};
 const roles={client:'발주기관',owner:'건축주',developer:'시행사',applicant:'심의 신청인',designer:'설계사',supervisor:'감리사',contractor:'시공사',operator:'운영·관리사'};
 const sources={g2b_bid:'나라장터 입찰',arch_hub_permit:'건축HUB 인허가',public_review:'지자체 심의',document_review:'심의 PDF 원문',seoul_review:'서울 건축위원회',environment_review:'환경평가 공람'};
 const time=v=>{if(!v)return '없음';const d=new Date(v);return Number.isFinite(+d)?d.toLocaleString('ko-KR',{timeZone:'Asia/Seoul'}):'날짜 확인 필요';};
 const table=(caption,headers,rows)=>'<div style="overflow-x:auto;margin:12px 0"><table style="width:100%;font-size:12px;text-align:left;border-collapse:collapse"><caption style="text-align:left;font-weight:700;padding:8px 0">'+esc(caption)+'</caption><thead><tr>'+headers.map(h=>'<th scope="col" style="padding:8px;border-bottom:1px solid #ddd">'+esc(h)+'</th>').join('')+'</tr></thead><tbody>'+rows.map(cells=>'<tr>'+cells.map(c=>'<td style="padding:8px;border-bottom:1px solid #eee">'+esc(c)+'</td>').join('')+'</tr>').join('')+'</tbody></table></div>';
 let request=0;
 async function load(){
  const serial=++request;button.disabled=true;out.textContent='저장 데이터 집계 중...';
  try{
   const response=await fetch('/api/admin/data-readiness',{cache:'no-store'});const d=await response.json();if(serial!==request)return;if(!response.ok)throw Error(d.error||'조회 실패');
   const s=d.summary,total=Number(s.projects),zeroRegions=d.regions.filter(r=>!r.projects).length;
   const needs=[['소유·시행주체 기준 공공/민간 미판정',d.sector.ownership_unclassified],['규모 미확인',s.missing_area],['현재 단계에 필요한 실제 날짜 누락',s.missing_event_date],['업체 정보 미확보',total-Number(s.with_party)],['전화·이메일 미확보',total-Number(s.with_contact)],['과거 심의 원문 기록만 남은 사업',s.historical_only]];
   out.innerHTML='<p>집계 '+esc(time(d.generated_at))+' · 데모 제외 '+n(s.demo_excluded)+'건</p><p><b>저장 원본 '+n(s.source_records)+'건 → 통합 프로젝트 '+n(total)+'건</b><br>업체명 보유 '+esc(rate(s.with_party,total))+' · 전화/이메일 보유 '+esc(rate(s.with_contact,total))+'</p><p><b>공공조달 공고 연결 '+n(d.sector.procurement_backed)+'개 사업</b><br>'+esc(d.sector.note)+'</p>'+
    table('우선 보완할 항목',['항목','통합 프로젝트 수'],needs.map(([label,value])=>[label,n(value)]))+
    '<p>HUB 웹 참여업체 연계: '+esc(d.hub.enabled?'활성':'비활성')+' · '+esc(({reuse_pending:'제공기관 재이용 범위 확인 대기',disabled:'활성화 설정 대기',paused:'전체 자동 수집 중지',enabled:'활성화 설정됨'})[d.hub.status]||d.hub.status)+'</p>'+
    table('역할별 업체·연락수단 보유',['역할','업체명 보유 / 전체 사업','전화 있음','이메일 있음','담당자명+연락수단 있음'],d.roles.map(r=>[roles[r.role]||r.role,rate(r.organization,total),n(r.phone),n(r.email),n(r.named_contact)]))+
    table('단계별 저장 현황',['대표 진행 단계','사업 수','업체명 있음','전화/이메일 있음'],d.stages.map(r=>[stages[r.stage]||r.stage,n(r.projects),rate(r.with_party,r.projects),rate(r.with_contact,r.projects)]))+
    '<p>저장 0건으로 표시된 지역 '+n(zeroRegions)+'개. 실제 사업이 없다는 뜻이 아닙니다.</p>'+
    table('지역별 저장 현황 · 기존 지역명은 별도',['저장 지역','사업 수','업체명 있음','전화/이메일 있음'],d.regions.map(r=>[r.region,n(r.projects),rate(r.with_party,r.projects),rate(r.with_contact,r.projects)]))+
    table('원천별 저장 현황 · 원천별 사업 수는 합산하지 않음',['원천','원본 수','연결 사업 수','최근 저장 갱신'],d.sources.map(r=>[sources[r.source]||r.source,n(r.records),n(r.projects),time(r.latest_update)]))+
    table('나라장터 최종낙찰 · 별도 결과 기록 단위',['저장 결과','공고번호 연결 결과','낙찰업체 전화 있음','최근 수신 확인'],[[n(d.awards.records),n(d.awards.linked_notices),n(d.awards.with_phone),time(d.awards.latest_checked)]])+
    '<details><summary>집계 기준과 한계</summary>'+d.notes.map(note=>'<p>'+esc(note)+'</p>').join('')+'</details>';
  }catch(e){if(serial===request)out.textContent='점검표 조회 실패: '+e.message;}
  finally{if(serial===request)button.disabled=false;}
 }
 button.addEventListener('click',()=>void load());void load();
})();
