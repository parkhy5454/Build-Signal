require("dotenv").config();
const express = require("express");
const helmet = require("helmet");
const path = require("path");
const crypto = require("crypto");
const session = require("express-session");
const PgSession = require("connect-pg-simple")(session);
const bcrypt = require("bcryptjs");
const { query, initDb } = require("./db");
const { profiles, scoreProject } = require("./scoring");

const app = express();
// Render terminates HTTPS at its proxy; trust the proxy so secure session cookies are issued.
app.set("trust proxy", 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: false }));
app.use(session({
  store: new PgSession({ conString: process.env.DATABASE_URL, createTableIfMissing: true, tableName: 'user_sessions' }),
  secret: process.env.SESSION_SECRET || 'development-only-change-this-secret',
  resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: 'auto', maxAge: 8 * 60 * 60 * 1000 }
}));
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

async function loadUser(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: "로그인이 필요합니다.", code: "LOGIN_REQUIRED" });
  try {
    const r = await query("SELECT id,email,company_name,contact_name,role,status FROM users WHERE id=$1", [req.session.userId]);
    if (!r.rowCount) { req.session.destroy(()=>{}); return res.status(401).json({ error: "계정을 찾을 수 없습니다." }); }
    if (r.rows[0].status !== 'approved') return res.status(403).json({ error: "관리자 승인 대기 중인 계정입니다.", code: "PENDING_APPROVAL" });
    req.user = r.rows[0]; next();
  } catch (e) { next(e); }
}
function requireAdminRole(req,res,next) { if (req.user?.role !== 'admin') return res.status(403).json({error:'관리자 권한이 필요합니다.'}); next(); }

app.get("/api/me", loadUser, (req,res)=>res.json({user:req.user}));
app.post('/api/register', async (req,res)=>{
  try {
    const email=String(req.body.email||'').trim().toLowerCase();
    const password=String(req.body.password||'');
    const company=String(req.body.companyName||'').trim().slice(0,160);
    const contact=String(req.body.contactName||'').trim().slice(0,80);
    if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({error:'올바른 이메일을 입력해 주세요.'});
    if (password.length < 10) return res.status(400).json({error:'비밀번호는 10자 이상으로 설정해 주세요.'});
    if (!company || !contact) return res.status(400).json({error:'회사명과 담당자명을 입력해 주세요.'});
    const hash=await bcrypt.hash(password,12);
    await query("INSERT INTO users(email,password_hash,company_name,contact_name,role,status) VALUES($1,$2,$3,$4,'user','pending')",[email,hash,company,contact]);
    res.status(201).json({ok:true,message:'회원가입이 완료되었습니다. 관리자 승인 후 로그인할 수 있습니다.'});
  } catch(e) { if(e.code==='23505') return res.status(409).json({error:'이미 가입된 이메일입니다.'}); res.status(500).json({error:'회원가입 중 오류가 발생했습니다.'}); }
});
app.post('/api/login', async (req,res)=>{
  try {
    const email=String(req.body.email||'').trim().toLowerCase(), password=String(req.body.password||'');
    const r=await query('SELECT * FROM users WHERE email=$1',[email]);
    if(!r.rowCount || !(await bcrypt.compare(password,r.rows[0].password_hash))) return res.status(401).json({error:'이메일 또는 비밀번호를 확인해 주세요.'});
    const user=r.rows[0];
    if(user.status!=='approved') return res.status(403).json({error:'가입 승인 대기 중입니다. 관리자 승인 후 이용할 수 있습니다.'});
    // Regenerate the session at login and wait until PostgreSQL confirms persistence.
    req.session.regenerate((regenerateError) => {
      if (regenerateError) return res.status(500).json({error:'로그인 세션을 생성하지 못했습니다.'});
      req.session.userId = user.id;
      req.session.save((saveError) => {
        if (saveError) return res.status(500).json({error:'로그인 세션을 저장하지 못했습니다.'});
        res.json({ok:true,user:{email:user.email,role:user.role,contactName:user.contact_name}});
      });
    });
  } catch(e){res.status(500).json({error:'로그인 처리 중 오류가 발생했습니다.'});}
});
app.post('/api/logout',(req,res)=>req.session.destroy(()=>{res.clearCookie('connect.sid');res.json({ok:true});}));
app.get('/api/admin/users',loadUser,requireAdminRole,async(req,res)=>{const r=await query("SELECT id,email,company_name,contact_name,role,status,created_at FROM users ORDER BY created_at DESC");res.json({rows:r.rows});});
app.post('/api/admin/users/:id/approve',loadUser,requireAdminRole,async(req,res)=>{const r=await query("UPDATE users SET status='approved',approved_at=NOW() WHERE id=$1 AND role<>'admin' RETURNING id",[req.params.id]);if(!r.rowCount)return res.status(404).json({error:'회원을 찾을 수 없습니다.'});res.json({ok:true});});
app.post('/api/admin/users/:id/reject',loadUser,requireAdminRole,async(req,res)=>{const r=await query("DELETE FROM users WHERE id=$1 AND role<>'admin' RETURNING id",[req.params.id]);if(!r.rowCount)return res.status(404).json({error:'회원을 찾을 수 없습니다.'});res.json({ok:true});});
app.use('/api', (req,res,next)=>{ if(['/api/health','/api/login','/api/register','/api/me','/api/logout','/api/ingest/projects','/api/admin/ingest-logs','/api/admin/demo-seed'].includes(req.path)) return next(); loadUser(req,res,next); });

app.get("/api/health", async (req, res) => {
  try { await query("SELECT 1"); res.json({ ok: true, app: "BUILD SIGNAL", database: "connected" }); }
  catch (e) { res.status(503).json({ ok: false, error: e.message }); }
});

app.get("/api/dashboard", async (req, res) => {
  try {
    const total = await query("SELECT COUNT(*)::int AS n FROM projects");
    const byStage = await query("SELECT stage, COUNT(*)::int AS n FROM projects GROUP BY stage");
    const recent = await query("SELECT * FROM projects ORDER BY updated_at DESC LIMIT 6");
    const favorites = await query("SELECT COUNT(*)::int AS n FROM favorites WHERE user_key=$1", [String(req.user.id)]);
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
    const f = await query("SELECT id FROM favorites WHERE project_id=$1 AND user_key=$2", [req.params.id, String(req.user.id)]);
    const s = await query("SELECT status,note FROM sales_pipeline WHERE project_id=$1 AND user_key=$2", [req.params.id, String(req.user.id)]);
    res.json({ ...r.rows[0], favorite: !!f.rowCount, pipeline: s.rows[0] || { status: "NEW", note: "" } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/projects/:id/favorite", async (req, res) => {
  try {
    const exists = await query("SELECT id FROM favorites WHERE project_id=$1 AND user_key=$2", [req.params.id, String(req.user.id)]);
    if (exists.rowCount) await query("DELETE FROM favorites WHERE project_id=$1 AND user_key=$2", [req.params.id, String(req.user.id)]);
    else await query("INSERT INTO favorites(project_id,user_key) VALUES($1,$2) ON CONFLICT DO NOTHING", [req.params.id, String(req.user.id)]);
    res.json({ favorite: !exists.rowCount });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put("/api/projects/:id/pipeline", async (req, res) => {
  try {
    const status = String(req.body.status || "NEW").slice(0, 30);
    const note = String(req.body.note || "").slice(0, 2000);
    await query(`INSERT INTO sales_pipeline(project_id,user_key,status,note) VALUES($1,$2,$3,$4)
      ON CONFLICT(project_id,user_key) DO UPDATE SET status=EXCLUDED.status,note=EXCLUDED.note,updated_at=NOW()`, [req.params.id, String(req.user.id), status, note]);
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
    const r = await query(`SELECT p.* FROM projects p JOIN favorites f ON f.project_id=p.id WHERE f.user_key=$1 ORDER BY f.created_at DESC`, [String(req.user.id)]);
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

app.post("/api/ingest/projects", requireAdminRole, requireAdmin, async (req, res) => {
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
async function start() {
  await initDb();
  if (process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) {
    const email=String(process.env.ADMIN_EMAIL).trim().toLowerCase();
    const hash=await bcrypt.hash(String(process.env.ADMIN_PASSWORD),12);
    await query(`INSERT INTO users(email,password_hash,company_name,contact_name,role,status,approved_at)
      VALUES($1,$2,'BUILD SIGNAL 운영팀','관리자','admin','approved',NOW())
      ON CONFLICT(email) DO UPDATE SET password_hash=EXCLUDED.password_hash,role='admin',status='approved'`,[email,hash]);
  }
  const port = process.env.PORT || 10000;
  app.listen(port, () => console.log(`BUILD SIGNAL listening on ${port}`));
}
start().catch(e => { console.error("Startup failed:", e); process.exit(1); });
