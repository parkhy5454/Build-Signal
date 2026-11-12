// Official ArchPmsHubService/getApBasisOulnInfo date fields.
function permitDate(value){
 const text=String(value??'').trim();
 if(!/^\d{8}$/.test(text))return null;
 const iso=`${text.slice(0,4)}-${text.slice(4,6)}-${text.slice(6,8)}`;
 const date=new Date(iso+'T00:00:00Z');
 return Number.isFinite(date.getTime())&&date.toISOString().slice(0,10)===iso?iso:null;
}
function permitLifecycle(item){
 const permit=permitDate(item.archPmsDay),started=permitDate(item.realStcnsDay),completed=permitDate(item.useAprDay);
 return {permit,started,completed,stage:completed?'COMPLETED':started?'STARTED':permit?'PERMIT':'UNKNOWN'};
}
module.exports={permitDate,permitLifecycle};
