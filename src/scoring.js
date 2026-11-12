const profiles = {
  automation: { label: "자동제어·스마트빌딩", types: ["숙박시설", "업무시설", "의료시설", "교육연구시설", "판매시설"], stages: ["REVIEW", "PERMIT", "BID"], terms: ["호텔", "리조트", "스마트", "업무"] },
  electrical: { label: "전기·통신·소방", types: ["업무시설", "공동주택", "숙박시설", "의료시설", "공장"], stages: ["REVIEW", "PERMIT", "STARTED", "BID"], terms: ["전기", "통신", "소방"] },
  hvac: { label: "조명·공조·HVAC", types: ["업무시설", "숙박시설", "판매시설", "의료시설", "교육연구시설"], stages: ["REVIEW", "PERMIT", "STARTED"], terms: ["공조", "냉난방", "에너지"] },
  materials: { label: "건축자재·설비", types: ["공동주택", "업무시설", "공장", "판매시설", "숙박시설"], stages: ["REVIEW", "PERMIT", "STARTED", "BID"], terms: ["신축", "증축", "개발"] }
};

function scoreProject(project, profileKey = "automation") {
  const p = profiles[profileKey] || profiles.automation;
  let score = 0;
  const type = project.building_type || "";
  if (p.types.some(t => type.includes(t))) score += 30;
  if (Number(project.area_sqm || 0) >= 5000) score += 20;
  else if (Number(project.area_sqm || 0) >= 1000) score += 12;
  if (p.stages.includes(project.stage)) score += 20;
  const text = `${project.name || ""} ${project.building_type || ""}`;
  if (p.terms.some(t => text.includes(t))) score += 20;
  if (project.region) score += 10;
  return Math.min(100, score);
}
module.exports = { profiles, scoreProject };
