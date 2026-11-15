(async()=>{
 const out=document.getElementById('sourceRecord'),id=new URLSearchParams(location.search).get('projectId');
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 if(!ProjectSource.recordPath(id)){out.textContent='잘못된 현장 번호입니다.';return;}
 document.getElementById('sourceBack').href='/?projectId='+encodeURIComponent(id)+'#projects';
 try{
  const r=await fetch('/api/projects/'+encodeURIComponent(id)+'/source-record',{cache:'no-store'}),d=await r.json();
  if(r.status===401){out.innerHTML='<p>저장 자료를 보려면 로그인이 필요합니다.</p><a href="/login.html" class="button primary">로그인</a>';return;}
  if(!r.ok)throw Error(d.error||'조회 실패');
  if(String(d.id)!==id)throw Error('요청 현장과 응답 자료가 일치하지 않습니다.');
  const time=v=>{if(!v)return '기록 없음';const n=new Date(v);return Number.isFinite(+n)?n.toLocaleString('ko-KR',{timeZone:'Asia/Seoul'}):'날짜 확인 필요';};
  const stages={REVIEW:'심의·환경평가',PERMIT:'인허가',STARTED:'착공',COMPLETED:'사용승인',BID:'입찰',UNKNOWN:'확인 필요'};
  const value=f=>{if(f.value===null||f.value==='')return '미확인';if(f.key==='stage')return stages[f.value]||f.value;if(/_date$/.test(f.key)||f.key==='source_updated_at')return String(f.value).slice(0,10);return String(f.value);};
  const url=ProjectSource.safeUrl(d.external?.url);
  out.innerHTML='<section class="panel"><h2>'+esc(d.name)+'</h2><p>출처: '+esc(d.source_name)+' · 저장 현장 #'+esc(d.id)+'</p><p>최초 저장 '+esc(time(d.stored_at))+'<br>저장 갱신 '+esc(time(d.stored_updated_at))+'</p><div style="overflow-x:auto"><table><caption class="sr-only">해당 프로젝트의 저장 자료와 원천 필드</caption><tbody>'+d.fields.map(f=>'<tr><th scope="row">'+esc(f.label)+(f.origin_field?'<small>'+esc(f.origin_field)+'</small>':'')+'</th><td>'+esc(value(f))+'</td></tr>').join('')+'</tbody></table></div></section>'+
   (url?'<section class="panel"><h3>'+esc(d.external.label)+'</h3><p><a href="'+esc(url)+'" target="_blank" rel="noopener noreferrer">'+esc(d.external.label)+' ↗</a></p></section>':'')+
   '<section class="panel"><h3>자료 확인 기준</h3>'+d.notes.map(n=>'<p>'+esc(n)+'</p>').join('')+'</section>';
 }catch(e){out.textContent='저장 자료 조회 실패: '+e.message;}
})();
