+(async()=>{
 const out=document.getElementById('sourceRecord'),id=new URLSearchParams(location.search).get('recordId');
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 if(!/^(?:award|construction):[1-9]\d{0,17}$/.test(String(id||''))){out.textContent='잘못된 수주 자료 번호입니다.';return;}
 document.getElementById('sourceBack').href='/#awards';
 try{
  const r=await fetch('/api/awards/'+encodeURIComponent(id)+'/source-record',{cache:'no-store'}),d=await r.json();
  if(r.status===401){out.innerHTML='<p>저장 자료를 보려면 로그인이 필요합니다.</p><a href="/login.html" class="button primary">로그인</a>';return;}
  if(!r.ok)throw Error(d.error||'조회 실패');
  if(d.record_id!==id)throw Error('요청 자료와 응답 기록이 일치하지 않습니다.');
  const date=v=>v?String(v).slice(0,10):'미확인';
  const value=f=>f.value===null||f.value===''?'미확인':f.label.includes('금액')||f.label.includes('연면적')?String(f.value).replace(/\B(?=(\d{3})+(?!\d))/g,','):f.label.includes('일')?date(f.value):String(f.value);
  const url=ProjectSource.safeUrl(d.external?.url);
  out.innerHTML='<section class="panel"><h2>'+esc(d.name)+'</h2><p>출처: '+esc(d.source_name)+' · 자료 구분: '+esc(d.kind==='public_award'?'공공 최종낙찰':'착공 시공사 확인')+'</p><p>자료 식별자: '+esc(d.record_id)+'</p><div style="overflow-x:auto"><table><caption class="sr-only">저장된 해당 수주·낙찰 자료</caption><tbody>'+d.fields.map(f=>'<tr><th scope="row">'+esc(f.label)+'</th><td>'+esc(value(f))+'</td></tr>').join('')+'</tbody></table></div>'+(d.project_id?'<p><a class="button primary" href="/?projectId='+encodeURIComponent(d.project_id)+'#projects">연결된 프로젝트 보기 ↗</a></p>':'')+'</section>'+
   (url?'<section class="panel"><h3>공식 출처 안내</h3><p><a href="'+esc(url)+'" target="_blank" rel="noopener noreferrer">'+esc(d.external.label)+' ↗</a></p></section>':'')+
   '<section class="panel"><h3>자료 안내</h3>'+d.notes.map(n=>'<p>'+esc(n)+'</p>').join('')+'</section>';
 }catch(e){out.textContent='저장 자료 조회 실패: '+e.message;}
})();
