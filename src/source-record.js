const {classify}=require('../public/project-source');
const COLUMNS='id,source,external_id,name,address,region,district,building_type,stage,permit_date,start_date,completion_date,area_sqm,floors_above,floors_below,estimated_cost,owner,designer,supervisor,contractor,source_url,source_updated_at,created_at,updated_at';
const LABELS={id:'저장 현장 ID',external_id:'원천 관리번호',name:'저장 프로젝트명',address:'현장 주소',region:'지역',district:'시·군·구',building_type:'건물 용도·공종',stage:'저장 진행 단계',permit_date:'인허가일',start_date:'실제 착공일',completion_date:'사용승인일',area_sqm:'연면적 (㎡)',floors_above:'지상 층수',floors_below:'지하 층수',estimated_cost:'저장 금액 (원)',owner:'저장 건축주·발주처',designer:'저장 설계사',supervisor:'저장 감리사',contractor:'저장 시공사',source_updated_at:'원천 제공 기준일'};
const ARCH_FIELDS={external_id:'mgmPmsrgstPk',name:'bldNm 또는 주소 기반 생성명',address:'platPlc',region:'platPlc에서 분리',district:'platPlc에서 분리',building_type:'mainPurpsCdNm',permit_date:'archPmsDay',start_date:'realStcnsDay',completion_date:'useAprDay',area_sqm:'totArea',source_updated_at:'crtnDay'};
const SOURCES={arch_hub_permit:'국토교통부 건축HUB 건축인허가정보',g2b_bid:'조달청 나라장터 입찰공고',public_review:'지자체 공개 심의자료',document_review:'공식 심의 PDF 원문',seoul_review:'서울 건축위원회 공개자료',environment_review:'EIASS 환경평가 공람자료',demo:'데모 자료'};
async function readSourceRecord(query,id){
 if(!/^[1-9]\d{0,17}$/.test(String(id||''))){const e=Error('잘못된 현장 번호입니다.');e.status=400;throw e;}
 const row=(await query(`SELECT ${COLUMNS} FROM projects WHERE id=$1`,[String(id)])).rows[0];if(!row){const e=Error('저장 자료를 찾을 수 없습니다.');e.status=404;throw e;}
 const source=classify(row.source_url,row.source,row.external_id),arch=row.source==='arch_hub_permit',bid=row.source==='g2b_bid';
 const fields=Object.entries(LABELS).map(([key,label])=>({key,label:bid&&key==='permit_date'?'공고 게시일':bid&&key==='completion_date'?'입찰 마감일':arch&&key==='source_updated_at'?'원천 생성일 (crtnDay)':label,value:row[key]??null,origin_field:arch?ARCH_FIELDS[key]||null:null}));
 return {id:String(row.id),name:row.name,source_code:row.source,source_name:SOURCES[row.source]||'기타 저장 출처',external:source,
  fields,stored_at:row.created_at,stored_updated_at:row.updated_at,raw_response_available:false,
  notes:['이 화면은 해당 현장 ID에 저장된 프로젝트 자료입니다. 수집·정리한 항목이며 원천 API 응답 전문이나 외부 기관의 공식 원문 화면이 아닙니다.',
   '원천 관리번호를 기준으로 확인하며, 같은 사업으로 묶인 다른 공고·심의 자료를 이 현장의 원본으로 바꾸어 표시하지 않습니다.',
   ['provider','lookup','reference','missing','mismatch'].includes(source.kind)?'현재 저장된 외부 링크는 이 프로젝트의 개별 상세 주소로 확인된 링크가 아닙니다. 안내·조회·출처 페이지는 별도로 표시하며 상세 URL을 추측해 만들지 않습니다.':'외부 원문과 저장 자료는 갱신 시점에 따라 내용이 다를 수 있습니다.',
   '저장 갱신일은 우리 DB의 반영 시점이며 원천 자료의 작성일이나 현장 진행 사실을 새로 검증한 날짜가 아닙니다.',
   arch?'건물명 미제공 시 주소로 이름을 생성합니다. 날짜·용도·면적은 API 필드를 정리해 저장하며, 누락값은 추정하지 않습니다.':bid?'입찰 게시일·마감일은 인허가·준공일이 아닙니다. 저장 금액은 전체 사업 계약금액이나 낙찰금액으로 확정하지 않습니다.':'누락된 항목은 미확인으로 표시합니다.']};
}
function registerSourceRecordRoute(app,{query,loadUser}){
 app.get('/api/projects/:id/source-record',loadUser,async(req,res)=>{
  res.set('Cache-Control','no-store');try{res.json(await readSourceRecord(query,req.params.id));}
  catch(e){res.status(e.status||500).json({error:e.status?e.message:'프로젝트 저장 자료를 조회하지 못했습니다.'});}
 });
}
module.exports={readSourceRecord,registerSourceRecordRoute};
