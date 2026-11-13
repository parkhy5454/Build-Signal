function opportunityOptions(input={}){
 const raw=String(input.minArea??'').trim(),minArea=raw===''?null:Number(raw);
 if(minArea!==null&&(!Number.isFinite(minArea)||minArea<0||minArea>1e10))throw Error('최소 연면적은 0~100억㎡의 숫자로 입력해 주세요.');
 const sort=String(input.sort||'priority');if(!['priority','area','recent'].includes(sort))throw Error('잘못된 정렬 조건입니다.');
 const phase=String(input.phase||'');if(!['','early'].includes(phase))throw Error('잘못된 영업 단계 조건입니다.');
 return {minArea,includeUnknownArea:input.unknownArea==='1',sort,phase};
}
function opportunityOrder(sort){return {priority:"CASE p.stage WHEN 'REVIEW' THEN 0 WHEN 'PERMIT' THEN 1 WHEN 'STARTED' THEN 2 WHEN 'BID' THEN 3 ELSE 4 END",area:'p.area_sqm DESC NULLS LAST',recent:'p.updated_at DESC'}[sort];}
module.exports={opportunityOptions,opportunityOrder};
