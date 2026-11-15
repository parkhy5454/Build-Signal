// Read-only identities. Source rows, notice IDs, favorites and pipeline notes remain intact.
const key=column=>`regexp_replace(normalize(COALESCE(${column},''),NFKC),'[[:space:]]','','g')`;
const UNIFIED_PROJECTS=`WITH
unified_permit_keys AS (
 SELECT p.id,${key('p.name')} AS title,${key('p.owner')} AS owner,
 ${key('p.address')} AS location,${key('p.region')} AS region
 FROM projects p WHERE p.source='arch_hub_permit'
),
unified_early_keys AS (
 SELECT p.id,${key('p.name')} AS title,${key('p.owner')} AS owner,
 ${key('p.address')} AS location,${key('p.region')} AS region
 FROM projects p WHERE p.source IN ('public_review','environment_review','seoul_review','document_review')
),
unified_early_targets AS (
 SELECT e.id,MIN(p.id) AS permit_id
 FROM unified_early_keys e JOIN unified_permit_keys p
 ON p.title=e.title AND p.location=e.location AND p.region=e.region
 AND (e.owner='' OR p.owner='' OR e.owner=p.owner)
 WHERE length(e.title)>=8 AND e.region<>''
 AND length(e.location)>=8 AND e.location~'[0-9]'
 GROUP BY e.id HAVING COUNT(DISTINCT p.id)=1
),
unified_group_keys AS (
 SELECT g.id,g.title,${key('g.title')} AS title_key,${key('g.owner')} AS owner,
 ${key('g.location')} AS location,${key('g.region')} AS region
 FROM project_groups g
),
unified_group_targets AS (
 SELECT g.id,MIN(p.id) AS permit_id FROM unified_group_keys g JOIN unified_permit_keys p
 ON p.title=g.title_key AND p.owner=g.owner AND p.location=g.location AND p.region=g.region
 WHERE length(g.title_key)>=8 AND g.owner<>'' AND g.region<>''
 AND length(g.location)>=8 AND g.location~'[0-9]'
 GROUP BY g.id HAVING COUNT(*)=1
),
unified_group_roots AS (
 SELECT g.id,g.title,COALESCE(t.permit_id,MIN(p.id)) AS canonical_id
 FROM project_groups g JOIN projects p ON p.project_group_id=g.id AND p.source='g2b_bid'
 LEFT JOIN unified_group_targets t ON t.id=g.id GROUP BY g.id,g.title,t.permit_id
),
unified_identity AS (
 SELECT p.id AS project_id,COALESCE(g.canonical_id,l.permit_id,t.permit_id,p.id) AS canonical_id
 FROM projects p LEFT JOIN unified_group_roots g ON p.source='g2b_bid' AND p.project_group_id=g.id
 LEFT JOIN project_phase_links l ON l.early_id=p.id
 LEFT JOIN unified_early_targets t ON t.id=p.id AND l.permit_id IS NULL
),
unified_contacts AS (
 SELECT i.canonical_id,c.role,c.organization,c.person_name,c.phone,c.email
 FROM unified_identity i JOIN project_contacts c ON c.project_id=i.project_id
 UNION ALL
 SELECT g.canonical_id,c.role,c.organization,c.person_name,c.phone,c.email
 FROM unified_group_roots g JOIN project_group_contacts c ON c.group_id=g.id
),
unified_stats AS (
 SELECT i.canonical_id,COUNT(*)::int AS member_count,
 COUNT(*) FILTER(WHERE p.source='g2b_bid')::int AS notice_count,
 COUNT(DISTINCT p.building_type) FILTER(WHERE p.source='g2b_bid')::int AS trade_count,
 MAX(p.updated_at) AS latest_update
 FROM unified_identity i JOIN projects p ON p.id=i.project_id GROUP BY i.canonical_id
)`;
function searchScope(clause=''){
 return UNIFIED_PROJECTS+`, unified_matches AS (
 -- Search and count original source rows; project identity matching is enrichment only.
 SELECT DISTINCT ui.project_id AS project_id FROM projects p JOIN unified_identity ui ON ui.project_id=p.id ${clause}
)`;
}
async function relatedProjects(query,id){
 const r=await query(UNIFIED_PROJECTS+` SELECT i.project_id,i.canonical_id FROM unified_identity i
 WHERE i.canonical_id=(SELECT canonical_id FROM unified_identity WHERE project_id=$1) ORDER BY i.project_id`,[id]);
 return {canonicalId:r.rows[0]?.canonical_id||id,ids:r.rows.map(x=>String(x.project_id))};
}
async function unificationSummary(query){
 return (await query(UNIFIED_PROJECTS+` SELECT
 (SELECT COUNT(*)::int FROM projects) AS source_records,
 (SELECT COUNT(DISTINCT canonical_id)::int FROM unified_identity) AS project_rows,
 (SELECT COUNT(*)::int FROM unified_stats WHERE member_count>1) AS combined_projects,
 (SELECT COUNT(*)::int FROM unified_group_targets t JOIN unified_group_roots g ON g.id=t.id) AS exact_permit_bid_groups,
 (SELECT COUNT(*)::int FROM project_phase_links) AS confirmed_phase_links`)).rows[0];
}
module.exports={UNIFIED_PROJECTS,searchScope,relatedProjects,unificationSummary};
