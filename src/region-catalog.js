const fs=require('node:fs'),path=require('node:path'),zlib=require('node:zlib'),crypto=require('node:crypto');
const meta=require('../data/legal-dong-meta.json');
const bytes=zlib.gunzipSync(fs.readFileSync(path.join(__dirname,'../data/legal-dong.json.gz')));
if(crypto.createHash('sha256').update(bytes).digest('hex')!==meta.sha256)throw Error('Region catalog integrity check failed');
const catalog=JSON.parse(bytes);
const legacy=[['서울특별시','서울'],['부산광역시','부산'],['대구광역시','대구'],['인천광역시','인천'],['광주광역시','광주'],['대전광역시','대전'],['울산광역시','울산'],['세종특별자치시','세종'],['경기도','경기'],['강원특별자치도','강원'],['충청북도','충북'],['충청남도','충남'],['전북특별자치도','전북'],['전라남도','전남'],['경상북도','경북'],['경상남도','경남'],['제주특별자치도','제주']];
const historic={'강원특별자치도':['강원도'],'전북특별자치도':['전라북도'],'전남광주통합특별시':['전라남도','광주광역시']};
const provinces=catalog.rows.filter(([code])=>code.endsWith('00000000')).map(([code,name])=>({code:code.slice(0,2),value:name,label:legacy.find(x=>x[0]===name)?.[1]||name,aliases:[name,legacy.find(x=>x[0]===name)?.[1]||name,...(historic[name]||[])]}));
for(const [name,label] of legacy)if(!provinces.some(x=>x.value===name))provinces.push({code:null,value:name,label:label+' (기존 자료)',aliases:[name,label,...(historic[name]||[])]});
function regionAliases(value){const text=String(value||'').trim();if(!text)return [];return provinces.find(x=>x.value===text||x.label===text||x.code===text||x.aliases.includes(text))?.aliases||[text];}
async function installRegionCatalog(query){
 const old=await query("SELECT version FROM region_catalog_state WHERE id=1");
 if(old.rows[0]?.version===meta.sha256)return;
 for(let i=0;i<catalog.rows.length;i+=1000){
  const batch=catalog.rows.slice(i,i+1000).map(([code,name])=>({code,name}));
  await query(`INSERT INTO permit_legal_dong_codes(code,name,active,catalog_origin)
   SELECT code,name,TRUE,'official_bundle' FROM jsonb_to_recordset($1::jsonb) AS x(code TEXT,name TEXT)
   ON CONFLICT(code) DO UPDATE SET name=EXCLUDED.name,active=TRUE,catalog_origin='official_bundle',updated_at=NOW()`,[JSON.stringify(batch)]);
 }
 // Only previously bundled codes may be retired; keep separately managed entries intact.
 await query("UPDATE permit_legal_dong_codes SET active=FALSE,updated_at=NOW() WHERE catalog_origin='official_bundle' AND NOT (code=ANY($1::text[]))",[catalog.rows.map(x=>x[0])]);
 await query(`INSERT INTO region_catalog_state(id,version,loaded_at) VALUES(1,$1,NOW()) ON CONFLICT(id) DO UPDATE SET version=EXCLUDED.version,loaded_at=NOW()`,[meta.sha256]);
}
module.exports={meta,provinces,regionAliases,installRegionCatalog};
