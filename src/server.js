require("dotenv").config();
const express = require("express");
const helmet = require("helmet");
const path = require("path");
const crypto = require("crypto");
const { query, initDb } = require("./db");
const { profiles, scoreProject } = require("./scoring");

const app = express();
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, "..", "public")));

const STAGES = ["PERMIT", "STARTED", "COMPLETED", "BID", "UNKNOWN"];
const stageNames = { PERMIT: "인허가", STARTED: "착공", COMPLETED: "준공", BID: "입찰", UNKNOWN: "확인 필요" };

function requireAdmin(req, res, next) {
  const token = req.headers["x-ingest-token"];
  const expected = process.env.ADMIN_INGEST_TOKEN;
  if (!expected || !token || !safeEqual(token, expected)) return res.status(401).json({ error: "인증되지 않았습니다." });
  next();
}
function safeEqual(a, b) {
  const aa = Buffer.from(String(a)), bb = Buffer.from(String(b));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}
function normalizeDate(v) { return v ? String(v).slice(0, 10) : null; }

app.get("/api/health", async (req, res) => {
  try { await query("SELECT 1"); res.json({ ok: true, app: "BUILD SIGNAL", database: "connected" }); }
  catch (e) { res.status(503).json({ ok: false, error: e.message }); }
});

app.get("/api/dashboard", async (req, res) => {
  try {
    const total = await query("SELECT COUNT(*)::int AS n FROM projects");
    const byStage = await query("SELECT stage, COUNT(*)::int AS n FROM projects GROUP BY stage");
    const recent = await query("SELECT * FROM projects ORDER BY updated_at DESC LIMIT 6");
    const favorites = await query("SELECT COUNT(*)::int AS n FROM favorites");
    res.json({ total: total.rows[0].n, byStage: byStage.rows, recent: recent.rows, favorites: favorites.rows[0].n, demo: process.env.DATA_SOURCE_MODE === "demo" });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/projects", async (req, res) => {
  try {
    const { q = "", region = "", stage = "", type = "", page = "1", limit = "30" } = req.query;
    const p = Math.max(1, Number(page) || 1), l = Math.min(100, Math.max(1, Number(limit) || 30));
    const params = [], where = [];
    function add(value, expr) { params.push(value); where.push(expr.replace("?", `$${params.length}`)); }
    if (q) add(`%${q}%`, "(name ILIKE ? OR address ILIKE ? OR owner ILIKE ? OR designer ILIKE ? OR contractor ILIKE ?)");
    if (region) add(`%${region}%`, "region ILIKE ?");
    if (stage) add(stage, "stage = ?");
    if (type) add(`%${type}%`, "building_type ILIKE ?");
    // q needs five identical positional parameters
    if (q) {
      const idx = params.length;
      where[0] = `(name ILIKE $${idx} OR address ILIKE $${idx} OR owner ILIKE $${idx} OR designer ILIKE $${idx} OR contractor ILIKE $${idx})`;
    }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const count = await query(`SELECT COUNT(*)::int AS n FROM projects ${clause}`, params);
    const rows = await query(`SELECT * FROM projects ${clause} ORDER BY updated_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, [...params, l, (p - 1) * l]);
    res.json({ rows: rows.rows, total: count.rows[0].n, page: p, pages: Math.ceil(count.rows[0].n / l) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/projects/:id", async (req, res) => {
  try {
    const r = await query("SELECT * FROM projects WHERE id=$1", [req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: "현장을 찾을 수 없습니다." });
    const f = await query("SELECT id FROM favorites WHERE project_id=$1 AND user_key='admin'", [req.params.id]);
    const s = await query("SELECT status,note FROM sales_pipeline WHERE project_id=$1 AND user_key='admin'", [req.params.id]);
    res.json({ ...r.rows[0], favorite: !!f.rowCount, pipeline: s.rows[0] || { status: "NEW", note: "" } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/projects/:id/favorite", async (req, res) => {
  try {
    const exists = await query("SELECT id FROM favorites WHERE project_id=$1 AND user_key='admin'", [req.params.id]);
    if (exists.rowCount) await query("DELETE FROM favorites WHERE project_id=$1 AND user_key='admin'", [req.params.id]);
    else await query("INSERT INTO favorites(project_id,user_key) VALUES($1,'admin') ON CONFLICT DO NOTHING", [req.params.id]);
    res.json({ favorite: !exists.rowCount });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put("/api/projects/:id/pipeline", async (req, res) => {
  try {
    const status = String(req.body.status || "NEW").slice(0, 30);
    const note = String(req.body.note || "").slice(0, 2000);
    await query(`INSERT INTO sales_pipeline(project_id,user_key,status,note) VALUES($1,'admin',$2,$3)
      ON CONFLICT(project_id,user_key) DO UPDATE SET status=EXCLUDED.status,note=EXCLUDED.note,updated_at=NOW()`, [req.params.id, status, note]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/recommendations", async (req, res) => {
  try {
    const key = profiles[req.query.profile] ? req.query.profile : "automation";
    const rows = await query("SELECT * FROM projects ORDER BY updated_at DESC LIMIT 500");
    const ranked = rows.rows.map(x => ({ ...x, score: scoreProject(x, key), profile: profiles[key].label }))
      .sort((a,b) => b.score - a.score).slice(0, 100);
    res.json({ profile: profiles[key].label, rows: ranked });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/favorites", async (req, res) => {
  try {
    const r = await query(`SELECT p.* FROM projects p JOIN favorites f ON f.project_id=p.id WHERE f.user_key='admin' ORDER BY f.created_at DESC`);
    res.json({ rows: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/export.csv", async (req, res) => {
  try {
    const r = await query(`SELECT name AS "현장명",address AS "주소",region AS "시도",district AS "시군구",building_type AS "건물용도",stage AS "진행단계",permit_date AS "허가일",start_date AS "착공일",completion_date AS "사용승인일",owner AS "건축주/발주처",designer AS "설계사",supervisor AS "감리사",contractor AS "시공사",area_sqm AS "연면적" FROM projects ORDER BY updated_at DESC LIMIT 20000`);
    const headers = Object.keys(r.rows[0] || { "현장명": "" });
    const csv = [headers.join(","), ...r.rows.map(row => headers.map(h => `"${String(row[h] ?? "").replace(/"/g, '""')}"`).join(","))].join("\r\n");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", "attachment; filename=build-signal-projects.csv");
    res.send("\uFEFF" + csv);
  } catch (e) { res.status(500).send(e.message); }
});

app.post("/api/ingest/projects", requireAdmin, async (req, res) => {
  const source = String(req.body.source || "external").slice(0, 200);
  const projects = Array.isArray(req.body.projects) ? req.body.projects.slice(0, 5000) : [];
  let inserted = 0;
  try {
    for (const p of projects) {
      if (!p.name) continue;
      const values = [
        source, p.externalId || null, p.name, p.address || null, p.region || null, p.district || null,
        p.buildingType || null, STAGES.includes(p.stage) ? p.stage : "UNKNOWN",
        normalizeDate(p.permitDate), normalizeDate(p.startDate), normalizeDate(p.completionDate),
        p.floorsAbove || null, p.floorsBelow || null, p.areaSqm || null, p.estimatedCost || null,
        p.owner || null, p.designer || null, p.supervisor || null, p.contractor || null,
        p.sourceUrl || null, normalizeDate(p.sourceUpdatedAt)
      ];
      const result = await query(`INSERT INTO projects(source,external_id,name,address,region,district,building_type,stage,permit_date,start_date,completion_date,floors_above,floors_below,area_sqm,estimated_cost,owner,designer,supervisor,contractor,source_url,source_updated_at)
        VALUES(${values.map((_,i)=>`$${i+1}`).join(",")})
        ON CONFLICT(source,external_id) DO UPDATE SET name=EXCLUDED.name,address=EXCLUDED.address,region=EXCLUDED.region,district=EXCLUDED.district,building_type=EXCLUDED.building_type,stage=EXCLUDED.stage,permit_date=EXCLUDED.permit_date,start_date=EXCLUDED.start_date,completion_date=EXCLUDED.completion_date,owner=EXCLUDED.owner,designer=EXCLUDED.designer,supervisor=EXCLUDED.supervisor,contractor=EXCLUDED.contractor,source_url=EXCLUDED.source_url,source_updated_at=EXCLUDED.source_updated_at,updated_at=NOW()
        RETURNING (xmax = 0) AS inserted`, values);
      if (result.rows[0]?.inserted) inserted++;
    }
    await query("INSERT INTO ingest_logs(source,received_count,inserted_count,status,message) VALUES($1,$2,$3,'SUCCESS','Ingest completed')", [source, projects.length, inserted]);
    res.json({ ok: true, received: projects.length, insertedOrUpdated: projects.length, inserted });
  } catch (e) {
    await query("INSERT INTO ingest_logs(source,received_count,inserted_count,status,message) VALUES($1,$2,$3,'ERROR',$4)", [source, projects.length, inserted, e.message]).catch(()=>{});
    res.status(500).json({ error: e.message, insertedBeforeError: inserted });
  }
});

app.get("/api/admin/ingest-logs", requireAdmin, async (req,res) => {
  const r = await query("SELECT * FROM ingest_logs ORDER BY created_at DESC LIMIT 100");
  res.json({ rows: r.rows });
});

app.post("/api/admin/demo-seed", requireAdmin, async (req,res) => {
  const demo = [
    ["DEMO-001","강남 업무시설 신축 프로젝트","서울특별시 강남구 테헤란로","서울특별시","강남구","업무시설","PERMIT","2026-10-12",null,null,22,5,28000,"가상 건축주 A","가상 설계사 B","가상 감리사 C",null],
    ["DEMO-002","부산 해운대 호텔 신축 프로젝트","부산광역시 해운대구 해운대로","부산광역시","해운대구","숙박시설","STARTED","2026-06-03","2026-09-18",null,18,3,19000,"가상 시행사 D","가상 설계사 E","가상 감리사 F","가상 시공사 G"],
    ["DEMO-003","인천 물류센터 증축 프로젝트","인천광역시 서구 산업로","인천광역시","서구","창고시설","BID","2026-10-29",null,null,4,1,14000,"가상 발주처 H",null,null,null],
    ["DEMO-004","제주 리조트 신축 프로젝트","제주특별자치도 서귀포시 중문관광로","제주특별자치도","서귀포시","숙박시설","PERMIT","2026-10-20",null,null,12,2,16000,"가상 건축주 I","가상 설계사 J","가상 감리사 K",null],
    ["DEMO-005","대전 연구시설 신축 프로젝트","대전광역시 유성구 대학로","대전광역시","유성구","교육연구시설","COMPLETED","2026-03-10","2026-05-01","2026-10-25",10,2,11000,"가상 기관 L","가상 설계사 M","가상 감리사 N","가상 시공사 O"]
  ];
  let n=0;
  for (const d of demo) {
    await query(`INSERT INTO projects(source,external_id,name,address,region,district,building_type,stage,permit_date,start_date,completion_date,floors_above,floors_below,area_sqm,owner,designer,supervisor,contractor)
      VALUES('demo',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
      ON CONFLICT(source,external_id) DO NOTHING`, d);
    n++;
  }
  res.json({ ok:true, attempted:n, notice:"데모 데이터는 실제 현장정보가 아닙니다." });
});

app.get("/login", (req,res)=>res.sendFile(path.join(__dirname,"..","public","login.html")));
app.post("/api/login", (req,res)=>{
  const email=String(req.body.email||""), password=String(req.body.password||"");
  if (!process.env.ADMIN_EMAIL || !process.env.ADMIN_PASSWORD || !safeEqual(email,process.env.ADMIN_EMAIL) || !safeEqual(password,process.env.ADMIN_PASSWORD))
    return res.status(401).json({error:"로그인 정보를 확인해 주세요."});
  // MVP UI gate only. Replace with secure server-side sessions before public commercial launch.
  res.cookie("bs_admin", crypto.createHmac("sha256",process.env.SESSION_SECRET||"dev-only").update(email).digest("hex"), {httpOnly:true,sameSite:"lax",secure:process.env.NODE_ENV==="production",maxAge:8*60*60*1000});
  res.json({ok:true});
});

async function start() {
  await initDb();
  const port = process.env.PORT || 10000;
  app.listen(port, () => console.log(`BUILD SIGNAL listening on ${port}`));
}
start().catch(e => { console.error("Startup failed:", e); process.exit(1); });
