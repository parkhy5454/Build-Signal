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
function normalizeG2bDate(v) {
  if (!v) return null;
  const s = String(v).replace(/\D/g, "");
  if (s.length < 8) return null;
  return `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}`;
}
function firstValue(obj, keys) {
  for (const k of keys) {
    const v = obj?.[k];
    if (v !== undefined && v !== null && String(v).trim() !== "") return String(v).trim();
  }
  return null;
}
function classifyBid(title) {
  const t = String(title || "").toLowerCase();
  if (/자동제어|빌딩자동제어|건물자동제어|bms|스마트빌딩/.test(t)) return "자동제어·스마트빌딩";
  if (/소방|전기공사|전기설비|통신공사|정보통신/.test(t)) return "전기·통신·소방";
  if (/공조|냉난방|기계설비|환기|에어컨|hvac/.test(t)) return "조명·공조·HVAC";
  if (/조명|led|등기구/.test(t)) return "조명·공조·HVAC";
  if (/건축자재|창호|도어|배관|밸브|펌프|승강기/.test(t)) return "건축자재·설비";
  return "건설공사";
}
function parseG2bItems(payload) {
  const body = payload?.response || payload?.Response || payload?.data?.response || payload?.data?.Response || payload;
  const header = body?.header || body?.Header;
  const resultCode = String(header?.resultCode ?? header?.RESULTCODE ?? "00");
  const resultMsg = String(header?.resultMsg ?? header?.RESULTMSG ?? "");
  if (resultCode !== "00" && resultCode !== "0") {
    throw new Error(`나라장터 API 오류(${resultCode}): ${resultMsg || "응답 오류"}`);
  }
  const raw = body?.body || body?.Body || payload?.body || payload?.Body || {};
  const candidates = [
    raw?.items?.item, raw?.items?.Item, raw?.items,
    raw?.Items?.item, raw?.Items?.Item, raw?.Items,
    body?.items?.item, body?.items?.Item, body?.items,
    payload?.items?.item, payload?.items?.Item, payload?.items
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate;
    if (candidate && typeof candidate === "object") {
      if (Array.isArray(candidate.item)) return candidate.item;
      if (Array.isArray(candidate.Item)) return candidate.Item;
      if (candidate.item && typeof candidate.item === "object") return [candidate.item];
      if (candidate.Item && typeof candidate.Item === "object") return [candidate.Item];
    }
  }
  return [];
}
function getG2bResponseDiagnostics(payload) {
  const root = payload?.response || payload?.Response || payload?.data?.response || payload?.data?.Response || payload;
  const body = root?.body || root?.Body || payload?.body || payload?.Body || {};
  const header = root?.header || root?.Header || {};
  const responseError =
    root?.["nkoneps.com.response.ResponseError"] ??
    root?.["ResponseError"] ??
    payload?.["nkoneps.com.response.ResponseError"] ??
    payload?.["ResponseError"] ??
    null;
  const errorText = responseError == null
    ? null
    : (typeof responseError === "string" ? responseError : JSON.stringify(responseError)).slice(0, 1200);
  return {
    resultCode: header?.resultCode ?? header?.RESULTCODE ?? null,
    resultMsg: header?.resultMsg ?? header?.RESULTMSG ?? null,
    totalCount: body?.totalCount ?? body?.TotalCount ?? body?.total_count ?? null,
    responseError: errorText,
    rootKeys: Object.keys(root || {}).slice(0, 20),
    bodyKeys: Object.keys(body || {}).slice(0, 20)
  };
}


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

// 7일 전체 수집은 Render HTTP 응답 제한을 피하도록 백그라운드에서 진행합니다.
// 단일 프로세스 실행 기준이며 서버 재시작 시 작업은 중단됩니다.
let g2bJob = null;
const g2bFormatKst = d => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(d);
  const v = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return `${v.year}${v.month}${v.day}${v.hour}${v.minute}`;
};
const g2bPause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function g2bFetchPage(start, end, page) {
  const params = new URLSearchParams({
    serviceKey: process.env.G2B_SERVICE_KEY,
    pageNo: String(page), numOfRows: '100', inqryDiv: '1',
    inqryBgnDt: g2bFormatKst(start), inqryEndDt: g2bFormatKst(end), type: 'json'
  });
  const endpoint = 'https://apis.data.go.kr/1230000/ad/BidPublicInfoService02/getBidPblancListInfoCnstwk02';
  const response = await fetch(`${endpoint}?${params}`, {
    headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(30000)
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(`나라장터 HTTP ${response.status}: ${raw.replace(/<[^>]*>/g, ' ').slice(0, 180)}`);
  let payload;
  try { payload = JSON.parse(raw); } catch { throw new Error('나라장터 JSON 응답을 읽지 못했습니다.'); }
  const diagnostic = getG2bResponseDiagnostics(payload);
  if (diagnostic.responseError) throw new Error(`나라장터 API 오류: ${diagnostic.responseError}`);
  const items = parseG2bItems(payload);
  const total = Number(diagnostic.totalCount);
  if (Number.isFinite(total) && total > 0 && items.length === 0) throw new Error(`공고 ${total}건의 항목 구조를 읽지 못했습니다.`);
  return { items, total: Number.isFinite(total) ? total : null };
}

const PROJECT_TRADES = [
  ['소방', /(?:소방(?:시설)?(?:전기|기계)?공사|소방공사)$/],
  ['통신', /(?:정보통신공사|통신공사)$/],
  ['전기', /(?:전기(?:설비)?공사)$/],
  ['기계설비', /(?:기계설비공사|기계공사|설비공사)$/],
  ['건축', /(?:건축공사|건설공사|토목공사)$/]
];
function projectGroupIdentity(p) {
  if (p.source !== 'g2b_bid' || !p.name || !p.owner || !p.address || !p.region) return null;
  let title = String(p.name).normalize('NFKC').replace(/\s+/g,' ').trim();
  let trade = null;
  // 오직 말미에 명시된 공종만 제거합니다. 불확실한 이름은 개별 프로젝트로 유지합니다.
  for (const [label, re] of PROJECT_TRADES) {
    const match = re.exec(title);
    if (match) {
      trade=label;
      title=title.slice(0,match.index).replace(/[\s()\[\]·,/-]+$/g,'').trim();
      break;
    }
  }
  if (!trade || title.length < 8) return null;
  const owner=String(p.owner).normalize('NFKC').replace(/\s+/g,'').trim();
  const location=String(p.address).normalize('NFKC').replace(/\s+/g,'').trim();
  const region=String(p.region).normalize('NFKC').trim();
  if (!owner || !location || location.length < 3) return null;
  const key=crypto.createHash('sha256').update([title.replace(/\s+/g,''),owner,region,location].join('|')).digest('hex');
  return {key,title,owner:p.owner,region:p.region,location:p.address,trade};
}
async function linkProjectGroup(p) {
  const identity=projectGroupIdentity(p);
  if (!identity) return null;
  const r=await query(`INSERT INTO project_groups(group_key,title,owner,region,location)
    VALUES($1,$2,$3,$4,$5)
    ON CONFLICT(group_key) DO UPDATE SET updated_at=NOW()
    RETURNING id`,[identity.key,identity.title,identity.owner,identity.region,identity.location]);
  await query('UPDATE projects SET project_group_id=$1 WHERE id=$2 AND project_group_id IS DISTINCT FROM $1',[r.rows[0].id,p.id]);
  return r.rows[0].id;
}

async function g2bRunJob(job) {
  try {
    // 성공 확인된 1시간 조회 범위로 고정. 마지막 1시간은 분 경계에서 겹치지 않도록 처리.
    const end = new Date(job.endedAt);
    const beginning = new Date(end.getTime() - 7 * 24 * 60 * 60 * 1000);
    const windowMs = 60 * 60 * 1000;
    job.totalWindows = Math.ceil((end - beginning) / windowMs);
    for (let i = 0; i < job.totalWindows; i++) {
      const from = new Date(beginning.getTime() + i * windowMs);
      const to = new Date(Math.min(from.getTime() + windowMs - 60000, end.getTime()));
      let page = 1;
      try {
        while (true) {
          // 과도한 페이지 반복을 방지하고, 누락 가능성은 오류로 보고합니다.
          if (page > 100) throw new Error('한 시간 구간에서 100페이지를 초과했습니다.');
          let result;
          for (let attempt = 0; attempt < 3; attempt++) {
            try { result = await g2bFetchPage(from, to, page); break; }
            catch (e) { if (attempt === 2) throw e; await g2bPause(1500 * (attempt + 1)); }
          }
          const { items, total } = result;
          job.received += items.length;
          let inserted = 0, updated = 0, skipped = 0;
    for (const item of items) {
      const bidNo = firstValue(item, ["bidNtceNo","BIDNTCENO"]);
      const bidOrd = firstValue(item, ["bidNtceOrd","BIDNTCEORD"]) || "00";
      const title = firstValue(item, ["bidNtceNm","BIDNTCENM","bidNtceNmPrt"]) ;
      if (!bidNo || !title) { skipped++; continue; }
      const externalId = `${bidNo}-${bidOrd}`;
      const agency = firstValue(item, ["ntceInsttNm","NTCEINSTTNM","dminsttNm","DMINSTTNM"]);
      const demandAgency = firstValue(item, ["dminsttNm","DMINSTTNM"]);
      const location = firstValue(item, ["cnstrtsiteRgnNm","CNSTRTSITERGNM","prtcptLmtRgnNm","PRTCPTLMTRGNM"]);
      const noticeDate = normalizeG2bDate(firstValue(item, ["bidNtceDt","BIDNTCEDT","rgstDt","RGSTDT"]));
      const closeDate = normalizeG2bDate(firstValue(item, ["bidClseDt","BIDCLSEDT"]));
      const sourceUrl = firstValue(item, ["bidNtceDtlUrl","BIDNTCEDTLURL","ntceDtlUrl","NTCEDTLURL"]);
      const estimated = firstValue(item, ["presmptPrce","PRESMPTPRCE","asignBdgtAmt","ASIGNBDGTAMT"]);
      const region = location ? location.split(/\s+/)[0] : null;
      const district = location && location.split(/\s+/).length > 1 ? location.split(/\s+/).slice(1).join(" ") : null;
      const vals = ["g2b_bid", externalId, title, location, region, district, classifyBid(title), "BID",
        noticeDate, null, closeDate, null, null, null, estimated ? Number(estimated.replace(/,/g,"")) || null : null,
        demandAgency || agency, null, null, null, sourceUrl, noticeDate];
      const r = await query(`INSERT INTO projects(source,external_id,name,address,region,district,building_type,stage,permit_date,start_date,completion_date,floors_above,floors_below,area_sqm,estimated_cost,owner,designer,supervisor,contractor,source_url,source_updated_at)
        VALUES(${vals.map((_,i)=>`$${i+1}`).join(",")})
        ON CONFLICT(source,external_id) DO UPDATE SET name=EXCLUDED.name,address=EXCLUDED.address,region=EXCLUDED.region,district=EXCLUDED.district,building_type=EXCLUDED.building_type,stage='BID',completion_date=EXCLUDED.completion_date,estimated_cost=EXCLUDED.estimated_cost,owner=EXCLUDED.owner,source_url=EXCLUDED.source_url,source_updated_at=EXCLUDED.source_updated_at,updated_at=NOW()
        RETURNING (xmax = 0) AS inserted`, vals);
      // 원본 공고는 보존하고, 근거가 충분한 경우에만 상위 프로젝트에 연결합니다.
      try {
        const pr=await query("SELECT id,source,name,owner,address,region FROM projects WHERE source=$1 AND external_id=$2",['g2b_bid',externalId]);
        if (pr.rows[0]) await linkProjectGroup(pr.rows[0]);
      } catch(groupError) { console.warn('Project group linking skipped:',groupError.message); }
      // 나라장터가 공개한 발주기관 연락처만 저장합니다. 미확인 설계/감리/시공 담당자는 생성하지 않습니다.
      const agencyName = demandAgency || agency;
      if (agencyName) {
        const person = firstValue(item, ['ntceInsttOfclNm','ntceInsttOfclName','dminsttOfclNm']);
        const phone = firstValue(item, ['ntceInsttOfclTelNo','ntceInsttOfclTel','dminsttOfclTelNo']);
        const email = firstValue(item, ['ntceInsttOfclEmailAdrs','ntceInsttOfclEmail','dminsttOfclEmailAdrs']);
        const department = firstValue(item, ['ntceInsttOfclDeptNm','dminsttOfclDeptNm']);
        await query(`INSERT INTO project_contacts(project_id,role,organization,department,person_name,phone,email,source,source_url)
          VALUES ((SELECT id FROM projects WHERE source=$1 AND external_id=$2),'client',$3,$4,$5,$6,$7,'g2b_bid',$8)
          ON CONFLICT(project_id,role,organization,source) DO UPDATE SET
            department=COALESCE(EXCLUDED.department,project_contacts.department),
            person_name=COALESCE(EXCLUDED.person_name,project_contacts.person_name),
            phone=COALESCE(EXCLUDED.phone,project_contacts.phone),
            email=COALESCE(EXCLUDED.email,project_contacts.email),
            source_url=COALESCE(EXCLUDED.source_url,project_contacts.source_url),updated_at=NOW()`,
          ['g2b_bid',externalId,agencyName,department,person,phone,email,sourceUrl]);
      }
      if (r.rows[0]?.inserted) inserted++; else updated++;
    }

          job.inserted += inserted;
          job.updated += updated;
          job.skipped += skipped;
          job.pages++;
          job.current = `${g2bFormatKst(from)} ~ ${g2bFormatKst(to)} (${page}페이지)`;
          if (!items.length || items.length < 100 || (total !== null && page * 100 >= total)) break;
          page++;
          await g2bPause(150);
        }
      } catch (e) {
        job.errors.push(`${g2bFormatKst(from)}~${g2bFormatKst(to)}: ${e.message}`.slice(0, 300));
      }
      job.completedWindows++;
      await g2bPause(120);
    }
    job.status = job.errors.length ? 'partial' : 'completed';
    await query("INSERT INTO ingest_logs(source,received_count,inserted_count,status,message) VALUES($1,$2,$3,$4,$5)",
      ['g2b_bid', job.received, job.inserted, job.errors.length ? 'ERROR' : 'SUCCESS',
       `7day sync: updated=${job.updated}, skipped=${job.skipped}, failed_windows=${job.errors.length}`]);
  } catch (e) {
    job.status = 'failed'; job.errors.push(String(e.message));
  } finally { job.finishedAt = new Date().toISOString(); }
}
app.post('/api/admin/g2b/sync', loadUser, requireAdminRole, (req, res) => {
  if (!process.env.G2B_SERVICE_KEY) return res.status(400).json({ error: 'G2B_SERVICE_KEY 환경변수가 없습니다.' });
  if (g2bJob?.status === 'running') return res.json({ ok: true, started: false, job: g2bJob });
  g2bJob = {
    status: 'running', startedAt: new Date().toISOString(), endedAt: new Date().toISOString(),
    completedWindows: 0, totalWindows: 168, received: 0, inserted: 0, updated: 0,
    skipped: 0, pages: 0, current: '', errors: [], finishedAt: null
  };
  void g2bRunJob(g2bJob);
  res.status(202).json({ ok: true, started: true, job: g2bJob });
});
app.get('/api/admin/g2b/progress', loadUser, requireAdminRole, (req, res) => {
  res.json({ job: g2bJob });
});
app.get("/api/admin/g2b/status", loadUser, requireAdminRole, async (req,res) => {
  try {
    const r = await query("SELECT COUNT(*)::int AS total, MAX(updated_at) AS last_sync FROM projects WHERE source='g2b_bid'");
    const log = await query("SELECT status,message,created_at FROM ingest_logs WHERE source='g2b_bid' ORDER BY created_at DESC LIMIT 1");
    res.json({ ...r.rows[0], lastLog: log.rows[0] || null, configured: !!process.env.G2B_SERVICE_KEY });
  } catch(e) { res.status(500).json({error:e.message}); }
});


// Read-only building permit ingestion readiness. Never expose the API key.
app.get('/api/admin/permits/status',loadUser,requireAdminRole,async(req,res)=>{
 try{
  const result=await query("SELECT COUNT(*)::int AS total, MAX(updated_at) AS last_updated FROM projects WHERE source='arch_hub_permit'");
  res.json({configured:!!process.env.ARCH_HUB_SERVICE_KEY,total:result.rows[0].total,last_updated:result.rows[0].last_updated,ingestion_enabled:false});
 }catch(e){res.status(500).json({error:'건축허가 수집 상태를 확인하지 못했습니다.'});}
});


// Admin-only safe probe of the official ArchPmsHubService operation.
// The operation URL is configured separately because the API service root is not callable.
app.post('/api/admin/permits/test',loadUser,requireAdminRole,async(req,res)=>{
 const key=process.env.ARCH_HUB_SERVICE_KEY;
 const endpoint='https://apis.data.go.kr/1613000/ArchPmsHubService/getApBasisOulnInfo';
 if(!key)return res.status(400).json({error:'ARCH_HUB_SERVICE_KEY가 설정되지 않았습니다.'});
 let url;
 try{url=new URL(endpoint);}catch{return res.status(400).json({error:'오퍼레이션 URL 형식이 올바르지 않습니다.'});}
 if(url.protocol!=='https:'||url.hostname!=='apis.data.go.kr'||!url.pathname.startsWith('/1613000/ArchPmsHubService/'))
  return res.status(400).json({error:'공식 건축HUB 오퍼레이션 URL만 허용됩니다.'});
 const today=new Date(),yesterday=new Date(today.getTime()-86400000);
 const ymd=d=>d.toISOString().slice(0,10).replace(/-/g,'');
 url.searchParams.set('serviceKey',key);
 url.searchParams.set('numOfRows','1');url.searchParams.set('pageNo','1');
 url.searchParams.set('_type','json');url.searchParams.set('sigunguCd','11680');url.searchParams.set('bjdongCd','10300');url.searchParams.set('startDate',ymd(yesterday));url.searchParams.set('endDate',ymd(today));
 try{
  const response=await fetch(url,{signal:AbortSignal.timeout(15000)});
  const raw=await response.text();
  // Return only metadata, not the response body or URL, to avoid accidental key disclosure.
  let parsed;try{parsed=JSON.parse(raw)}catch{}
  const header=parsed?.response?.header||{};
  res.json({httpStatus:response.status,contentType:response.headers.get('content-type')||'',json:!!parsed,
   resultCode:String(header.resultCode||''),resultMsg:String(header.resultMsg||'').slice(0,160),
   hasItems:!!parsed?.response?.body?.items,hasTotalCount:parsed?.response?.body?.totalCount!==undefined,
   note:'공식 가이드의 강남구 개포동 샘플 지역에 대한 읽기 전용 연결 시험입니다. 데이터 저장은 하지 않습니다.'});
 }catch(e){res.status(502).json({error:e.name==='TimeoutError'?'API 응답 시간 초과':'건축HUB API 연결 실패'});}
});


let permitJob=null;
async function savePermitJob(job){
 try{
  if(!job.dbId){
   const result=await query("INSERT INTO permit_ingest_jobs(status,job_data) VALUES($1,$2::jsonb) RETURNING id",[job.status,JSON.stringify(job)]);
   job.dbId=String(result.rows[0].id);
  }
  await query("UPDATE permit_ingest_jobs SET status=$1,job_data=$2::jsonb,updated_at=NOW() WHERE id=$3",[job.status,JSON.stringify(job),job.dbId]);
 }catch(e){console.error('Permit job log:',e.message);}
}

const permitDate=v=>{const x=String(v||'');if(!/^\d{8}$/.test(x))return null;const iso=`${x.slice(0,4)}-${x.slice(4,6)}-${x.slice(6,8)}`;const d=new Date(iso+'T00:00:00Z');return Number.isFinite(d.getTime())&&d.toISOString().slice(0,10)===iso?iso:null;};
async function permitSync(job,opts){
 try{
  const key=process.env.ARCH_HUB_SERVICE_KEY;
  for(let page=1;page<=20;page++){
   const url=new URL('https://apis.data.go.kr/1613000/ArchPmsHubService/getApBasisOulnInfo');
   for(const [k,v] of Object.entries({serviceKey:key,_type:'json',sigunguCd:opts.sigunguCd,bjdongCd:opts.bjdongCd,startDate:opts.startDate,endDate:opts.endDate,numOfRows:'100',pageNo:String(page)}))url.searchParams.set(k,v);
   const response=await fetch(url,{signal:AbortSignal.timeout(20000)});
   if(!response.ok)throw Error('HTTP '+response.status);
   const raw=await response.text();let data;
   try{data=JSON.parse(raw);}catch{throw Error('JSON 응답이 아닙니다. XML/오류 응답을 확인해야 합니다.');}
   const header=data?.response?.header||{};
   if(String(header.resultCode)!=='00')throw Error('API 오류 코드 '+String(header.resultCode||'unknown'));
   const body=data?.response?.body||{};
   const entries=body.items?.item;
   const items=Array.isArray(entries)?entries:entries?[entries]:[];
   job.received+=items.length;job.pages=page;
   for(const item of items){
    const id=String(item.mgmPmsrgstPk||'').trim();
    const address=String(item.platPlc||'').trim();
    if(!id||!address){job.skipped++;continue;}
    const permit=permitDate(item.archPmsDay),started=permitDate(item.realStcnsDay);
    const stage=started?'STARTED':permit?'PERMIT':'UNKNOWN';
    const name=String(item.bldNm||'').trim()||address+' 건축인허가';
    const region=address.split(/\s+/)[0]||null;
    const area=Number(item.totArea);
    const result=await query(`INSERT INTO projects(source,external_id,name,address,region,district,building_type,stage,permit_date,start_date,area_sqm,source_url,source_updated_at)
      VALUES('arch_hub_permit',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      ON CONFLICT(source,external_id) DO UPDATE SET name=EXCLUDED.name,address=EXCLUDED.address,region=EXCLUDED.region,district=EXCLUDED.district,building_type=EXCLUDED.building_type,stage=EXCLUDED.stage,permit_date=EXCLUDED.permit_date,start_date=EXCLUDED.start_date,area_sqm=EXCLUDED.area_sqm,source_url=EXCLUDED.source_url,source_updated_at=EXCLUDED.source_updated_at,updated_at=NOW()
      RETURNING (xmax=0) AS inserted`,
      [id,name.slice(0,500),address,region,address.split(/\s+/)[1]||null,String(item.mainPurpsCdNm||'').slice(0,300)||null,stage,permit,started,Number.isFinite(area)&&area>0?area:null,
      'https://www.data.go.kr/data/15136267/openapi.do',permitDate(item.crtnDay)]);
    if(result.rows[0]?.inserted)job.inserted++;else job.updated++;
   }
   job.total=Number(body.totalCount)||0;
   if(!items.length||(job.total>0&&page*100>=job.total)||items.length<100)break;
   if(page===20)throw Error('안전 제한 2000건에 도달했습니다. 더 좁은 날짜 범위로 수집하세요.');
  }
  job.status='completed';
 }catch(e){job.status='failed';job.error=String(e.message).slice(0,200);}
 finally{job.finishedAt=new Date().toISOString();await savePermitJob(job);}
}
app.post('/api/admin/permits/sync',loadUser,requireAdminRole,(req,res)=>{
 if(!process.env.ARCH_HUB_SERVICE_KEY)return res.status(400).json({error:'ARCH_HUB_SERVICE_KEY 미설정'});
 if(permitJob?.status==='running')return res.status(409).json({error:'이미 수집 중입니다.'});
 const {sigunguCd,bjdongCd,startDate,endDate}=req.body||{};
 if(!/^\d{5}$/.test(String(sigunguCd||''))||!/^\d{5}$/.test(String(bjdongCd||'')))return res.status(400).json({error:'시군구코드와 법정동코드는 각각 5자리여야 합니다.'});
 if(!/^\d{8}$/.test(String(startDate||''))||!/^\d{8}$/.test(String(endDate||''))||startDate>endDate)return res.status(400).json({error:'날짜는 YYYYMMDD 형식이어야 합니다.'});
 const from=Date.parse(startDate.slice(0,4)+'-'+startDate.slice(4,6)+'-'+startDate.slice(6,8));
 const to=Date.parse(endDate.slice(0,4)+'-'+endDate.slice(4,6)+'-'+endDate.slice(6,8));
 if(!permitDate(startDate)||!permitDate(endDate)||!Number.isFinite(from)||!Number.isFinite(to)||to-from>29*86400000)return res.status(400).json({error:'한 번에 최대 30일까지만 수집할 수 있습니다.'});
 permitJob={status:'running',received:0,inserted:0,updated:0,skipped:0,pages:0,total:0,startedAt:new Date().toISOString()};
 void (async()=>{await savePermitJob(permitJob);await permitSync(permitJob,{sigunguCd,bjdongCd,startDate,endDate});})();
 res.status(202).json({job:permitJob});
});






app.get('/api/admin/permits/data-quality',loadUser,requireAdminRole,async(req,res)=>{
 try{
  const totals=await query(`SELECT COUNT(*)::int AS total,
   COUNT(*) FILTER (WHERE permit_date IS NULL)::int AS missing_permit_date,
   COUNT(*) FILTER (WHERE address IS NULL OR BTRIM(address)='')::int AS missing_address,
   COUNT(*) FILTER (WHERE building_type IS NULL OR BTRIM(building_type)='')::int AS missing_building_type,
   COUNT(*) FILTER (WHERE area_sqm IS NULL OR area_sqm<=0)::int AS missing_area,
   COUNT(*) FILTER (WHERE stage='UNKNOWN')::int AS unknown_stage,
   COUNT(*) FILTER (WHERE external_id IS NULL OR BTRIM(external_id)='')::int AS missing_external_id
   FROM projects WHERE source='arch_hub_permit'`);
  const duplicates=await query(`SELECT COUNT(*)::int AS duplicate_groups FROM (
    SELECT external_id FROM projects WHERE source='arch_hub_permit' AND external_id IS NOT NULL GROUP BY external_id HAVING COUNT(*)>1
   ) d`);
  const recent=await query(`SELECT id,name,address,permit_date AS "permitDate",building_type AS "buildingType",area_sqm AS "areaSqm",stage,
   CASE WHEN permit_date IS NULL THEN '허가일 없음'
        WHEN building_type IS NULL OR BTRIM(building_type)='' THEN '용도 없음'
        WHEN area_sqm IS NULL OR area_sqm<=0 THEN '면적 없음'
        WHEN stage='UNKNOWN' THEN '단계 미확인'
        ELSE '기타' END AS issue
   FROM projects WHERE source='arch_hub_permit'
    AND (permit_date IS NULL OR building_type IS NULL OR BTRIM(building_type)='' OR area_sqm IS NULL OR area_sqm<=0 OR stage='UNKNOWN')
   ORDER BY updated_at DESC LIMIT 30`);
  res.json({summary:{...totals.rows[0],duplicateGroups:duplicates.rows[0].duplicate_groups},recentIssues:recent.rows,
   note:'누락값은 원천 API 미제공일 수 있으며 실제 수집 누락을 뜻하지 않습니다. 외부 원천 데이터와 대조한 완전성 검증은 포함되지 않습니다.'});
 }catch(e){res.status(500).json({error:'건축허가 데이터 품질 분석 실패'});}
});

app.get('/api/admin/permits/region-queues',loadUser,requireAdminRole,async(req,res)=>{
 try{const r=await query("SELECT id,label,query_text AS \"queryText\",status,next_batch AS \"nextBatch\",jsonb_array_length(regions) AS \"regionCount\",created_at AS \"createdAt\" FROM permit_region_queues ORDER BY id DESC LIMIT 50");res.json({queues:r.rows});}
 catch(e){res.status(500).json({error:'저장된 수집 목록 조회 실패'});}
});
app.post('/api/admin/permits/region-queues',loadUser,requireAdminRole,async(req,res)=>{
 const q=String(req.body?.q||'').trim(),label=String(req.body?.label||q).trim();
 if(q.length<2||q.length>100||!label||label.length>100)return res.status(400).json({error:'지역 검색어와 목록 이름은 2~100자여야 합니다.'});
 try{
  const r=await query("SELECT code,name FROM permit_legal_dong_codes WHERE active=TRUE AND name ILIKE $1 ORDER BY code LIMIT 200",['%'+q+'%']);
  if(!r.rows.length)return res.status(404).json({error:'일치하는 법정동이 없습니다.'});
  const regions=r.rows.map(x=>({name:x.name,code:x.code,sigunguCd:x.code.slice(0,5),bjdongCd:x.code.slice(5,10)}));
  const saved=await query("INSERT INTO permit_region_queues(label,query_text,regions) VALUES($1,$2,$3::jsonb) RETURNING id",[label,q,JSON.stringify(regions)]);
  res.json({id:saved.rows[0].id,regionCount:regions.length,batchCount:Math.ceil(regions.length/20),status:'prepared'});
 }catch(e){res.status(500).json({error:'수집 목록 저장 실패'});}
});



app.get('/api/admin/permits/region-queues/:id/status',loadUser,requireAdminRole,async(req,res)=>{
 if(!/^\d+$/.test(req.params.id))return res.status(400).json({error:'잘못된 목록 ID'});
 try{
  const r=await query("SELECT id,label,status,next_batch AS \"nextBatch\",jsonb_array_length(regions) AS \"regionCount\",next_region AS \"nextRegion\",updated_at AS \"updatedAt\",last_error AS \"lastError\",failed_region AS \"failedRegion\",failed_at AS \"failedAt\" FROM permit_region_queues WHERE id=$1",[req.params.id]);
  if(!r.rows.length)return res.status(404).json({error:'저장 목록 없음'});
  const q=r.rows[0],batchCount=Math.ceil(q.regionCount/20);
  const active=permitJob?.status==='running'&&String(permitJob.queueId)===String(q.id)?{
   completedRegions:permitJob.completedRegions||0,regionCount:permitJob.regionCount||0,
   received:permitJob.received||0,inserted:permitJob.inserted||0,updated:permitJob.updated||0,
   startedAt:permitJob.startedAt||null
  }:null;
  res.json({queue:{...q,batchCount,percent:batchCount?Math.round(q.nextBatch/batchCount*100):100},active});
 }catch(e){res.status(500).json({error:'작업 진행 상태 조회 실패'});}
});

app.post('/api/admin/permits/region-queues/:id/run-next',loadUser,requireAdminRole,async(req,res)=>{
 if(!process.env.ARCH_HUB_SERVICE_KEY)return res.status(400).json({error:'ARCH_HUB_SERVICE_KEY 미설정'});
 if(permitJob?.status==='running')return res.status(409).json({error:'다른 수집 작업이 진행 중입니다.'});
 if(!/^\d+$/.test(req.params.id))return res.status(400).json({error:'잘못된 목록 ID'});
 const {startDate,endDate}=req.body||{};
 if(!permitDate(startDate)||!permitDate(endDate)||startDate>endDate||Date.parse(permitDate(endDate))-Date.parse(permitDate(startDate))>29*86400000)return res.status(400).json({error:'수집 기간은 최대 30일이어야 합니다.'});
 const runToken=crypto.randomUUID();
 let queue;
 try{
  const result=await query("SELECT id,regions,next_batch,next_region,run_start_date,run_end_date,status FROM permit_region_queues WHERE id=$1",[req.params.id]);
  queue=result.rows[0];
  if(!queue)return res.status(404).json({error:'저장 목록 없음'});
  if(queue.status==='completed'||queue.next_batch*20>=queue.regions.length)return res.status(409).json({error:'모든 묶음이 완료되었습니다.'});
  if(queue.run_start_date&&(queue.run_start_date!==startDate||queue.run_end_date!==endDate))return res.status(409).json({error:'이 목록은 이전에 선택한 기간으로만 이어서 수집할 수 있습니다. 새 기간은 새 목록으로 저장하세요.'});
  const locked=await query("UPDATE permit_region_queues SET status='running',run_token=$3,run_start_date=COALESCE(run_start_date,$4),run_end_date=COALESCE(run_end_date,$5),last_error=NULL,failed_region=NULL,failed_at=NULL,updated_at=NOW() WHERE id=$1 AND next_batch=$2 AND status IN ('prepared','failed') AND (run_start_date IS NULL OR (run_start_date=$4 AND run_end_date=$5)) RETURNING id",[queue.id,queue.next_batch,runToken,startDate,endDate]);
  if(!locked.rows.length)return res.status(409).json({error:'수집 목록 상태를 확인하세요.'});
 }catch(e){return res.status(500).json({error:'수집 목록 준비 실패'});}
 const regions=queue.regions.slice(queue.next_batch*20,(queue.next_batch+1)*20);
 permitJob={status:'running',queueId:queue.id,runToken,batchNumber:queue.next_batch+1,regionCount:regions.length,completedRegions:queue.next_region||0,received:0,inserted:0,updated:0,skipped:0,pages:0,total:0,startedAt:new Date().toISOString()};
 const job=permitJob;
 // Refresh the persisted lease timestamp while a region's API pages are in flight.
 // A stale recovery may only run after 60 minutes without this heartbeat.
 let heartbeatBusy=false;
 const heartbeat=setInterval(()=>{
  if(heartbeatBusy||job.status!=='running')return;
  heartbeatBusy=true;
  query("UPDATE permit_region_queues SET updated_at=NOW() WHERE id=$1 AND next_batch=$2 AND status='running' AND run_token=$3",[queue.id,queue.next_batch,runToken])
   .catch(e=>{console.error('Permit queue heartbeat failed:',e.message);})
   .finally(()=>{heartbeatBusy=false;});
 },30000);
 heartbeat.unref?.();
 void (async()=>{
  try{
   await savePermitJob(job);
   let currentRegion=null;
   for(let regionIndex=queue.next_region||0;regionIndex<regions.length;regionIndex++){
    const region=regions[regionIndex];
    currentRegion=region;
    const child={status:'running',received:0,inserted:0,updated:0,skipped:0,pages:0,total:0,startedAt:new Date().toISOString()};
    const owner=await query("SELECT 1 FROM permit_region_queues WHERE id=$1 AND next_batch=$2 AND status='running' AND run_token=$3",[queue.id,queue.next_batch,runToken]);
    if(!owner.rows.length)throw Error('작업 실행 권한이 만료되었습니다.');
    await permitSync(child,{sigunguCd:region.sigunguCd,bjdongCd:region.bjdongCd,startDate,endDate});
    for(const key of ['received','inserted','updated','skipped','pages'])job[key]+=child[key];
    if(child.status!=='completed')throw Error(region.name+': '+(child.error||'수집 실패'));
    job.completedRegions++;
    const checkpoint=await query("UPDATE permit_region_queues SET next_region=$4,updated_at=NOW() WHERE id=$1 AND next_batch=$2 AND status='running' AND run_token=$3 RETURNING id",[queue.id,queue.next_batch,runToken,regionIndex+1]);
    if(!checkpoint.rows.length)throw Error('수집 실행 권한이 만료되었습니다.');
    await savePermitJob(job);
   }
   const advanced=await query("UPDATE permit_region_queues SET next_batch=next_batch+1,next_region=0,run_token=NULL,status=CASE WHEN (next_batch+1)*20>=jsonb_array_length(regions) THEN 'completed' ELSE 'prepared' END,updated_at=NOW() WHERE id=$1 AND next_batch=$2 AND status='running' AND run_token=$3 RETURNING next_batch",[queue.id,queue.next_batch,runToken]);
   if(!advanced.rows.length)throw Error('완료 위치 저장 충돌');
   job.status='completed';
  }catch(e){
   job.status='failed';job.error=String(e.message).slice(0,500);
   await query("UPDATE permit_region_queues SET status='failed',run_token=NULL,updated_at=NOW() WHERE id=$1 AND next_batch=$2 AND status='running' AND run_token=$3",[queue.id,queue.next_batch,runToken]).catch(()=>{});
  }finally{clearInterval(heartbeat);job.finishedAt=new Date().toISOString();await savePermitJob(job).catch(()=>{});}
 })();
 res.status(202).json({job});
});


app.post('/api/admin/permits/region-queues/:id/recover-stale',loadUser,requireAdminRole,async(req,res)=>{
 if(!/^\d+$/.test(req.params.id))return res.status(400).json({error:'잘못된 목록 ID'});
 if(permitJob?.status==='running'&&String(permitJob.queueId)===req.params.id)return res.status(409).json({error:'현재 서버에서 수집 중이므로 복구할 수 없습니다.'});
 try{
  const r=await query("UPDATE permit_region_queues SET status='failed',run_token=NULL,updated_at=NOW() WHERE id=$1 AND status='running' AND updated_at < NOW()-INTERVAL '60 minutes' RETURNING id,next_batch AS \"nextBatch\"",[req.params.id]);
  if(!r.rows.length)return res.status(409).json({error:'중단된 작업이 없거나 마지막 시작 후 60분이 지나지 않았습니다.'});
  res.json({queue:r.rows[0],message:'중단된 작업을 재시도 가능 상태로 변경했습니다. 완료 위치는 유지됩니다.'});
 }catch(e){res.status(500).json({error:'중단 작업 복구 실패'});}
});

app.post('/api/admin/permits/region-queues/:id/checkpoint',loadUser,requireAdminRole,async(req,res)=>{
 if(!/^\d+$/.test(req.params.id))return res.status(400).json({error:'잘못된 목록 ID'});
 const nextBatch=Number(req.body?.nextBatch);
 if(!Number.isSafeInteger(nextBatch)||nextBatch<0)return res.status(400).json({error:'완료 묶음 수는 0 이상의 정수여야 합니다.'});
 try{
  const r=await query("UPDATE permit_region_queues SET next_batch=$2,status=CASE WHEN $2>=CEIL(jsonb_array_length(regions)/20.0) THEN 'completed' ELSE 'prepared' END,updated_at=NOW() WHERE id=$1 AND $2<=CEIL(jsonb_array_length(regions)/20.0) AND $2>=next_batch AND status <> 'running' RETURNING id,next_batch AS \"nextBatch\",status",[req.params.id,nextBatch]);
  if(!r.rows.length)return res.status(409).json({error:'목록이 없거나 완료 위치가 유효하지 않습니다. 이미 완료한 위치로 되돌릴 수 없습니다.'});
  res.json({queue:r.rows[0]});
 }catch(e){res.status(500).json({error:'완료 위치 저장 실패'});}
});

app.get('/api/admin/permits/region-queues/:id',loadUser,requireAdminRole,async(req,res)=>{
 if(!/^\d+$/.test(req.params.id))return res.status(400).json({error:'잘못된 목록 ID'});
 try{const r=await query("SELECT id,label,query_text AS \"queryText\",regions,status,next_batch AS \"nextBatch\" FROM permit_region_queues WHERE id=$1",[req.params.id]);if(!r.rows.length)return res.status(404).json({error:'목록 없음'});res.json({queue:r.rows[0]});}
 catch(e){res.status(500).json({error:'수집 목록 상세 조회 실패'});}
});

app.get('/api/admin/permits/legal-dong/queue-preview',loadUser,requireAdminRole,async(req,res)=>{
 const q=String(req.query.q||'').trim();
 if(q.length<2||q.length>100)return res.status(400).json({error:'지역 검색어는 2~100자여야 합니다.'});
 try{
  const pattern='%'+q+'%';
  const result=await query("SELECT code,name FROM permit_legal_dong_codes WHERE active=TRUE AND name ILIKE $1 ORDER BY code LIMIT 200",[pattern]);
  const total=await query("SELECT COUNT(*)::int AS total FROM permit_legal_dong_codes WHERE active=TRUE AND name ILIKE $1",[pattern]);
  const regions=result.rows.map(x=>({name:x.name,code:x.code,sigunguCd:x.code.slice(0,5),bjdongCd:x.code.slice(5,10)}));
  const batches=[];
  for(let i=0;i<regions.length;i+=20)batches.push({number:batches.length+1,regions:regions.slice(i,i+20)});
  res.json({total:total.rows[0].total,prepared:regions.length,truncated:total.rows[0].total>200,batches});
 }catch(e){res.status(500).json({error:'수집 작업 목록 생성 실패'});}
});

app.get('/api/admin/permits/legal-dong/batch-preview',loadUser,requireAdminRole,async(req,res)=>{
 const q=String(req.query.q||'').trim();
 const offset=Number(req.query.offset||0);
 if(q.length<2||q.length>100||!Number.isSafeInteger(offset)||offset<0||offset>100000)return res.status(400).json({error:'검색어 2자 이상 및 유효한 시작 위치가 필요합니다.'});
 try{
  const pattern='%'+q+'%';
  const r=await query("SELECT code,name FROM permit_legal_dong_codes WHERE active=TRUE AND name ILIKE $1 ORDER BY code LIMIT 20 OFFSET $2",[pattern,offset]);
  const count=await query("SELECT COUNT(*)::int AS total FROM permit_legal_dong_codes WHERE active=TRUE AND name ILIKE $1",[pattern]);
  res.json({total:count.rows[0].total,offset,regions:r.rows.map(x=>({name:x.name,code:x.code,sigunguCd:x.code.slice(0,5),bjdongCd:x.code.slice(5,10)}))});
 }catch(e){res.status(500).json({error:'수집 대상 미리보기 실패'});}
});

app.get('/api/admin/permits/legal-dong',loadUser,requireAdminRole,async(req,res)=>{
 const term=String(req.query.q||'').trim();
 if(term.length<2)return res.json({regions:[]});
 try{
  const pattern='%'+term.replace(/[\\%_]/g,'\\$&')+'%';
  const r=await query("SELECT code,name FROM permit_legal_dong_codes WHERE active=TRUE AND (name ILIKE $1 OR code LIKE $2) ORDER BY name LIMIT 50",[pattern,term+'%']);
  res.json({regions:r.rows.map(x=>({name:x.name,code:x.code,sigunguCd:x.code.slice(0,5),bjdongCd:x.code.slice(5,10)}))});
 }catch(e){res.status(500).json({error:'법정동 검색 실패'});}
});
app.post('/api/admin/permits/legal-dong/import',loadUser,requireAdminRole,async(req,res)=>{
 const rows=req.body?.rows;
 if(!Array.isArray(rows)||rows.length<1||rows.length>1000)return res.status(400).json({error:'한 번에 1~1000개 코드만 등록할 수 있습니다.'});
 const normalized=rows.map(x=>({code:String(x?.code||'').trim(),name:String(x?.name||'').trim(),active:x?.active!==false&&String(x?.active||'')!=='폐지'}));
 if(normalized.some(x=>!/^\d{10}$/.test(x.code)||!x.name||x.name.length>250))return res.status(400).json({error:'10자리 법정동코드와 250자 이내 지역명이 필요합니다.'});
 try{
  let count=0;
  for(const x of normalized){await query("INSERT INTO permit_legal_dong_codes(code,name,active) VALUES($1,$2,$3) ON CONFLICT(code) DO UPDATE SET name=EXCLUDED.name,active=EXCLUDED.active,updated_at=NOW()",[x.code,x.name,x.active]);count++;}
  res.json({imported:count});
 }catch(e){res.status(500).json({error:'법정동 등록 실패: '+e.message});}
});

app.get('/api/admin/permits/regions',loadUser,requireAdminRole,async(req,res)=>{
 try{const r=await query("SELECT id,label,sigungu_cd AS \"sigunguCd\",bjdong_cd AS \"bjdongCd\" FROM permit_region_presets ORDER BY label ASC LIMIT 500");res.json({regions:r.rows});}
 catch(e){res.status(500).json({error:'지역 목록 조회 실패'});}
});
app.post('/api/admin/permits/regions',loadUser,requireAdminRole,async(req,res)=>{
 const label=String(req.body?.label||'').trim(),sigunguCd=String(req.body?.sigunguCd||''),bjdongCd=String(req.body?.bjdongCd||'');
 if(!label||label.length>100||!/^\d{5}$/.test(sigunguCd)||!/^\d{5}$/.test(bjdongCd))return res.status(400).json({error:'지역명(100자 이내)과 5자리 코드 두 개가 필요합니다.'});
 try{const r=await query("INSERT INTO permit_region_presets(label,sigungu_cd,bjdong_cd) VALUES($1,$2,$3) ON CONFLICT(sigungu_cd,bjdong_cd) DO UPDATE SET label=EXCLUDED.label RETURNING id",[label,sigunguCd,bjdongCd]);res.json({id:r.rows[0].id});}
 catch(e){res.status(500).json({error:'지역 저장 실패'});}
});
app.delete('/api/admin/permits/regions/:id',loadUser,requireAdminRole,async(req,res)=>{
 if(!/^\d+$/.test(req.params.id))return res.status(400).json({error:'잘못된 지역 ID'});
 try{await query("DELETE FROM permit_region_presets WHERE id=$1",[req.params.id]);res.json({ok:true});}
 catch(e){res.status(500).json({error:'지역 삭제 실패'});}
});

app.get('/api/admin/permits/quality-history',loadUser,requireAdminRole,async(req,res)=>{
 try{
  const history=await query(`SELECT id,status,created_at AS "createdAt",updated_at AS "updatedAt",
    job_data->>'queueId' AS "queueId",job_data->>'batchNumber' AS "batchNumber",
    job_data->>'error' AS "error",
    COALESCE(NULLIF(job_data->>'received','')::int,0) AS received,
    COALESCE(NULLIF(job_data->>'inserted','')::int,0) AS inserted,
    COALESCE(NULLIF(job_data->>'updated','')::int,0) AS updated
    FROM permit_ingest_jobs ORDER BY id DESC LIMIT 30`);
  const quality=await query(`SELECT COUNT(*)::int AS total,
    COUNT(*) FILTER (WHERE permit_date IS NULL)::int AS "missingPermitDate",
    COUNT(*) FILTER (WHERE address IS NULL OR BTRIM(address)='')::int AS "missingAddress",
    COUNT(*) FILTER (WHERE area_sqm IS NULL OR area_sqm<=0)::int AS "missingArea"
    FROM projects WHERE source='arch_hub_permit'`);
  res.json({history:history.rows,quality:quality.rows[0],
   note:'수집 이력은 작업별 처리량이고 품질 집계는 현재 DB 전체의 스냅샷입니다.'});
 }catch(e){res.status(500).json({error:'수집 이력 및 품질 조회 실패'});}
});
app.get('/api/admin/permits/history',loadUser,requireAdminRole,async(req,res)=>{try{const result=await query("SELECT id,status,job_data,created_at,updated_at FROM permit_ingest_jobs ORDER BY id DESC LIMIT 30");res.json({jobs:result.rows});}catch(e){res.status(500).json({error:e.message});}});
app.get('/api/admin/permits/progress',loadUser,requireAdminRole,(req,res)=>res.json({job:permitJob}));


app.post('/api/admin/permits/recover',loadUser,requireAdminRole,async(req,res)=>{
 if(!process.env.ARCH_HUB_SERVICE_KEY)return res.status(400).json({error:'ARCH_HUB_SERVICE_KEY 미설정'});
 if(permitJob?.status==='running')return res.status(409).json({error:'현재 수집 작업이 진행 중입니다.'});
 try{
  const result=await query("SELECT id,job_data FROM permit_ingest_jobs WHERE status IN ('failed','partial') ORDER BY id DESC LIMIT 30");
  const found=result.rows.find(row=>Array.isArray(row.job_data?.failedWindows)&&row.job_data.failedWindows.length);
  if(!found)return res.status(404).json({error:'DB에 재수집 가능한 실패 구간이 없습니다.'});
  const failed=found.job_data.failedWindows;
  if(failed.length>500)return res.status(400).json({error:'실패 구간이 너무 많습니다.'});
  const retry=failed.filter(w=>/^\d{5}$/.test(String(w.sigunguCd||''))&&/^\d{5}$/.test(String(w.bjdongCd||''))&&permitDate(w.startDate)&&permitDate(w.endDate)&&w.startDate<=w.endDate);
  if(!retry.length)return res.status(400).json({error:'유효한 실패 구간이 없습니다.'});
  permitJob={status:'running',received:0,inserted:0,updated:0,skipped:0,pages:0,completedWindows:0,totalWindows:retry.length,errors:[],failedWindows:[],recoveredFrom:String(found.id),startedAt:new Date().toISOString()};
  const job=permitJob;
  void (async()=>{
   await savePermitJob(job);
   for(const opts of retry){
    const child={status:'running',received:0,inserted:0,updated:0,skipped:0,pages:0,total:0};
    await permitSync(child,opts);
    for(const k of ['received','inserted','updated','skipped','pages'])job[k]+=child[k];
    job.completedWindows++;
    if(child.status!=='completed'){job.errors.push(opts.sigunguCd+'/'+opts.bjdongCd+' '+opts.startDate+'~'+opts.endDate+': '+(child.error||'오류'));job.failedWindows.push(opts);}
    await savePermitJob(job);
   }
   job.status=job.failedWindows.length?(job.failedWindows.length===retry.length?'failed':'partial'):'completed';
   job.finishedAt=new Date().toISOString();
   await savePermitJob(job);
  })().catch(async e=>{job.status='failed';job.error=String(e.message).slice(0,200);job.finishedAt=new Date().toISOString();await savePermitJob(job);});
  res.status(202).json({job,sourceJobId:String(found.id)});
 }catch(e){res.status(500).json({error:'저장된 실패 구간 조회 실패: '+e.message});}
});

app.post('/api/admin/permits/retry',loadUser,requireAdminRole,(req,res)=>{
 if(!process.env.ARCH_HUB_SERVICE_KEY)return res.status(400).json({error:'ARCH_HUB_SERVICE_KEY 미설정'});
 if(!permitJob||permitJob.status==='running')return res.status(409).json({error:'재시도 가능한 완료 작업이 없습니다.'});
 const failed=Array.isArray(permitJob.failedWindows)?permitJob.failedWindows:[];
 if(!failed.length)return res.status(400).json({error:'재시도할 실패 구간이 없습니다.'});
 if(failed.length>500)return res.status(400).json({error:'실패 구간이 너무 많습니다.'});
 const retry=failed.map(w=>({...w}));
 permitJob={status:'running',received:0,inserted:0,updated:0,skipped:0,pages:0,completedWindows:0,totalWindows:retry.length,errors:[],failedWindows:[],startedAt:new Date().toISOString(),retry:true};
 const job=permitJob;
 void (async()=>{await savePermitJob(job);
  for(const opts of retry){
   const child={status:'running',received:0,inserted:0,updated:0,skipped:0,pages:0,total:0};
   await permitSync(child,opts);
   for(const k of ['received','inserted','updated','skipped','pages'])job[k]+=child[k];
   job.completedWindows++;
   await savePermitJob(job);
   if(child.status!=='completed'){job.errors.push(opts.sigunguCd+'/'+opts.bjdongCd+' '+opts.startDate+'~'+opts.endDate+': '+(child.error||'오류'));job.failedWindows.push(opts);}
  }
  job.status=job.failedWindows.length?(job.failedWindows.length===retry.length?'failed':'partial'):'completed';
  job.finishedAt=new Date().toISOString();await savePermitJob(job);
 })().catch(e=>{job.status='failed';job.error=String(e.message).slice(0,200);job.finishedAt=new Date().toISOString();});
 res.status(202).json({job});
});


app.post('/api/admin/permits/windowed',loadUser,requireAdminRole,(req,res)=>{
 if(!process.env.ARCH_HUB_SERVICE_KEY)return res.status(400).json({error:'ARCH_HUB_SERVICE_KEY 미설정'});
 if(permitJob?.status==='running')return res.status(409).json({error:'이미 수집 중입니다.'});
 const {regions,startDate,endDate}=req.body||{};
 if(!Array.isArray(regions)||regions.length<1||regions.length>20)return res.status(400).json({error:'지역은 1~20개까지 지정하세요.'});
 const unique=[...new Map(regions.map(r=>({sigunguCd:String(r?.sigunguCd||''),bjdongCd:String(r?.bjdongCd||'')})).map(r=>[r.sigunguCd+':'+r.bjdongCd,r])).values()];
 if(unique.some(r=>!/^\d{5}$/.test(r.sigunguCd)||!/^\d{5}$/.test(r.bjdongCd)))return res.status(400).json({error:'지역코드는 5자리 숫자여야 합니다.'});
 if(!permitDate(startDate)||!permitDate(endDate)||startDate>endDate)return res.status(400).json({error:'날짜는 YYYYMMDD 형식이어야 합니다.'});
 const start=Date.parse(permitDate(startDate)),end=Date.parse(permitDate(endDate));
 if(end-start>365*86400000)return res.status(400).json({error:'한 번에 최대 1년까지만 조회할 수 있습니다.'});
 const windows=[];
 for(let from=start;from<=end;from+=30*86400000){
  const to=Math.min(from+29*86400000,end);
  const compact=t=>new Date(t).toISOString().slice(0,10).replace(/-/g,'');
  windows.push({startDate:compact(from),endDate:compact(to)});
 }
 permitJob={status:'running',received:0,inserted:0,updated:0,skipped:0,pages:0,completedWindows:0,totalWindows:windows.length*unique.length,errors:[],failedWindows:[],startedAt:new Date().toISOString()};
 const job=permitJob;
 void (async()=>{await savePermitJob(job);
  for(const region of unique)for(const window of windows){
   const child={status:'running',received:0,inserted:0,updated:0,skipped:0,pages:0,total:0};
   await permitSync(child,{...region,...window});
   for(const k of ['received','inserted','updated','skipped','pages'])job[k]+=child[k];
   job.completedWindows++;
   await savePermitJob(job);
   if(child.status!=='completed'){job.errors.push(region.sigunguCd+'/'+region.bjdongCd+' '+window.startDate+'~'+window.endDate+': '+(child.error||'오류'));job.failedWindows.push({...region,...window});}
  }
  job.status=job.errors.length?(job.errors.length===job.totalWindows?'failed':'partial'):'completed';
  job.finishedAt=new Date().toISOString();await savePermitJob(job);
 })().catch(e=>{job.status='failed';job.error=String(e.message).slice(0,200);job.finishedAt=new Date().toISOString();});
 res.status(202).json({job});
});


app.post('/api/admin/permits/batch',loadUser,requireAdminRole,(req,res)=>{
 if(!process.env.ARCH_HUB_SERVICE_KEY)return res.status(400).json({error:'ARCH_HUB_SERVICE_KEY 미설정'});
 if(permitJob?.status==='running')return res.status(409).json({error:'이미 수집 중입니다.'});
 const {regions,startDate,endDate}=req.body||{};
 if(!Array.isArray(regions)||regions.length<1||regions.length>20)return res.status(400).json({error:'지역은 한 번에 1~20개까지 지정할 수 있습니다.'});
 const cleaned=regions.map(r=>({sigunguCd:String(r?.sigunguCd||''),bjdongCd:String(r?.bjdongCd||'')}));
 if(cleaned.some(r=>!/^\d{5}$/.test(r.sigunguCd)||!/^\d{5}$/.test(r.bjdongCd)))return res.status(400).json({error:'지역코드는 각각 5자리 숫자여야 합니다.'});
 if(!permitDate(startDate)||!permitDate(endDate)||startDate>endDate)return res.status(400).json({error:'유효한 YYYYMMDD 기간을 지정하세요.'});
 const days=(Date.parse(permitDate(endDate))-Date.parse(permitDate(startDate)))/86400000;
 if(days>29)return res.status(400).json({error:'한 번에 최대 30일까지만 수집할 수 있습니다.'});
 const unique=[...new Map(cleaned.map(r=>[r.sigunguCd+':'+r.bjdongCd,r])).values()];
 permitJob={status:'running',received:0,inserted:0,updated:0,skipped:0,pages:0,total:0,completedRegions:0,regionCount:unique.length,errors:[],startedAt:new Date().toISOString()};
 void (async()=>{
  const aggregate=permitJob;
  await savePermitJob(aggregate);
  for(const region of unique){
   const child={status:'running',received:0,inserted:0,updated:0,skipped:0,pages:0,total:0};
   await permitSync(child,{...region,startDate,endDate});
   for(const key of ['received','inserted','updated','skipped','pages'])aggregate[key]+=child[key];
   aggregate.completedRegions++;
   await savePermitJob(aggregate);
   if(child.status!=='completed')aggregate.errors.push(region.sigunguCd+'-'+region.bjdongCd+': '+(child.error||'수집 실패'));
  }
  aggregate.status=aggregate.errors.length?(aggregate.completedRegions===aggregate.errors.length?'failed':'partial'):'completed';
  aggregate.finishedAt=new Date().toISOString();await savePermitJob(aggregate);
 })().catch(e=>{permitJob.status='failed';permitJob.error=String(e.message).slice(0,200);permitJob.finishedAt=new Date().toISOString();});
 res.status(202).json({job:permitJob});
});


// 관리자 전용 연락처 확보율과 현장별 담당자 목록
app.get('/api/admin/contacts/coverage', loadUser, requireAdminRole, async (req,res) => {
  try {
    const summary = await query(`SELECT COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM project_contacts c WHERE c.project_id=p.id AND c.role='client'))::int AS client_org,
      COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM project_contacts c WHERE c.project_id=p.id AND c.role='client' AND c.phone IS NOT NULL))::int AS client_phone,
      COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM project_contacts c WHERE c.project_id=p.id AND c.role='client' AND c.email IS NOT NULL))::int AS client_email,
      COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM project_contacts c WHERE c.project_id=p.id AND c.role='designer'))::int AS designer,
      COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM project_contacts c WHERE c.project_id=p.id AND c.role='supervisor'))::int AS supervisor,
      COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM project_contacts c WHERE c.project_id=p.id AND c.role='contractor'))::int AS contractor
      FROM projects p WHERE p.source='g2b_bid'`);
    const contacts = await query(`SELECT p.id AS project_id,p.name AS project_name,c.role,c.organization,c.department,c.person_name,c.phone,c.email,c.source,c.source_url
      FROM project_contacts c JOIN projects p ON p.id=c.project_id WHERE p.source='g2b_bid'
      ORDER BY c.updated_at DESC LIMIT 100`);
    res.json({summary:summary.rows[0],contacts:contacts.rows});
  } catch(e) {res.status(500).json({error:e.message});}
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

// 회원 화면: 프로젝트명 우선 검색, 연락처 확보 여부 및 공종 필터
app.get("/api/projects", async (req, res) => {
  try {
    const { q = "", region = "", stage = "", type = "", contact = "", dateField = "event", from = "", to = "", page = "1", limit = "30" } = req.query;
    const p = Math.max(1, Number(page) || 1), l = Math.min(100, Math.max(1, Number(limit) || 30));
    const params = [], where = [];
    function add(v, sql) { where.push(sql.replace(/\?/g, () => { params.push(v); return `$${params.length}`; })); }
    const keyword = String(q).trim().slice(0,120);
    if (keyword) add(`%${keyword}%`, "(p.name ILIKE ? OR p.address ILIKE ? OR p.owner ILIKE ? OR p.designer ILIKE ? OR p.contractor ILIKE ? OR EXISTS (SELECT 1 FROM project_contacts pc WHERE pc.project_id=p.id AND (pc.organization ILIKE ? OR pc.person_name ILIKE ?)))");
    if (region) add(`%${String(region).slice(0,60)}%`, "p.region ILIKE ?");
    if (stage) add(String(stage).slice(0,30), "p.stage = ?");
    if (type) add(`%${String(type).slice(0,80)}%`, "p.building_type ILIKE ?");
    if (contact === 'any') where.push("EXISTS (SELECT 1 FROM project_contacts pc WHERE pc.project_id=p.id)");
    if (['client','designer','supervisor','contractor'].includes(contact)) add(contact, "EXISTS (SELECT 1 FROM project_contacts pc WHERE pc.project_id=p.id AND pc.role=?)");
    const dateColumn = dateField === "collected" ? "p.created_at::date" : "CASE WHEN p.stage = 'PERMIT' THEN p.permit_date WHEN p.stage = 'STARTED' THEN p.start_date WHEN p.stage = 'BID' THEN p.source_updated_at ELSE COALESCE(p.permit_date,p.start_date,p.source_updated_at) END";
    for (const [value,op] of [[from,">="],[to,"<="]]) {
      if (!value) continue;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value)) || !Number.isFinite(Date.parse(String(value)))) return res.status(400).json({error:"날짜 형식은 YYYY-MM-DD이어야 합니다."});
      add(String(value), `(${dateColumn}) ${op} ?::date`);
    }
    if(from && to && from>to)return res.status(400).json({error:"시작일이 종료일보다 늦습니다."});
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const count = await query(`SELECT COUNT(*)::int AS n FROM projects p ${clause}`, params);
    const rows = await query(`SELECT p.*,
      (SELECT COUNT(*)::int FROM project_contacts pc WHERE pc.project_id=p.id) AS contact_count,
      EXISTS(SELECT 1 FROM project_contacts pc WHERE pc.project_id=p.id AND pc.phone IS NOT NULL AND pc.phone<>'') AS has_phone,
      EXISTS(SELECT 1 FROM project_contacts pc WHERE pc.project_id=p.id AND pc.email IS NOT NULL AND pc.email<>'') AS has_email
      FROM projects p ${clause}
      ORDER BY CASE WHEN $${params.length+1}::text <> '' AND p.name ILIKE $${params.length+2} THEN 0 ELSE 1 END,
        p.updated_at DESC LIMIT $${params.length+3} OFFSET $${params.length+4}`,
      [...params, keyword, `${keyword}%`, l, (p-1)*l]);
    res.json({rows:rows.rows,total:count.rows[0].n,page:p,pages:Math.ceil(count.rows[0].n/l)});
  } catch(e) {res.status(500).json({error:e.message});}
});

app.get('/api/contacts/summary', async (req,res) => {
  try {
    const r=await query(`SELECT COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE EXISTS(SELECT 1 FROM project_contacts c WHERE c.project_id=p.id AND c.role='client'))::int AS client,
      COUNT(*) FILTER (WHERE EXISTS(SELECT 1 FROM project_contacts c WHERE c.project_id=p.id AND c.role='designer'))::int AS designer,
      COUNT(*) FILTER (WHERE EXISTS(SELECT 1 FROM project_contacts c WHERE c.project_id=p.id AND c.role='supervisor'))::int AS supervisor,
      COUNT(*) FILTER (WHERE EXISTS(SELECT 1 FROM project_contacts c WHERE c.project_id=p.id AND c.role='contractor'))::int AS contractor,
      COUNT(*) FILTER (WHERE EXISTS(SELECT 1 FROM project_contacts c WHERE c.project_id=p.id AND c.phone IS NOT NULL AND c.phone<>''))::int AS phone,
      COUNT(*) FILTER (WHERE EXISTS(SELECT 1 FROM project_contacts c WHERE c.project_id=p.id AND c.email IS NOT NULL AND c.email<>''))::int AS email
      FROM projects p WHERE p.source='g2b_bid'`);
    res.json(r.rows[0]);
  } catch(e){res.status(500).json({error:e.message});}
});

app.get('/api/project-groups', async(req,res)=>{
 try{
  const q=String(req.query.q||'').slice(0,120), region=String(req.query.region||'').slice(0,80);
  const trade=String(req.query.trade||'').slice(0,60);
  const page=Math.max(1,parseInt(req.query.page,10)||1);
  const limit=24;
  const where=['1=1'],args=[];
  if(q){args.push('%'+q+'%');where.push(`(g.title ILIKE $${args.length} OR g.owner ILIKE $${args.length})`);}
  if(region){args.push('%'+region+'%');where.push(`g.region ILIKE $${args.length}`);}
  if(trade){args.push('%'+trade+'%');where.push(`EXISTS(SELECT 1 FROM projects p WHERE p.project_group_id=g.id AND p.building_type ILIKE $${args.length})`);}
  const clause=where.join(' AND ');
  const total=await query(`SELECT COUNT(*)::int AS n FROM project_groups g WHERE ${clause}`,args);
  const rows=await query(`SELECT g.id,g.title,g.owner,g.region,g.location,
    COUNT(DISTINCT p.id)::int AS notice_count,
    COUNT(DISTINCT p.building_type)::int AS trade_count,
    COUNT(DISTINCT c.id)::int AS contact_count,
    MAX(p.updated_at) AS latest_notice
    FROM project_groups g JOIN projects p ON p.project_group_id=g.id
    LEFT JOIN project_contacts c ON c.project_id=p.id
    WHERE ${clause}
    GROUP BY g.id ORDER BY notice_count DESC,latest_notice DESC
    LIMIT $${args.length+1} OFFSET $${args.length+2}`,[...args,limit,(page-1)*limit]);
  res.json({rows:rows.rows,total:total.rows[0].n,page,pages:Math.ceil(total.rows[0].n/limit)});
 }catch(e){res.status(500).json({error:e.message});}
});
app.get('/api/project-groups/:id',async(req,res)=>{
 try{
  if(!/^\d+$/.test(req.params.id))return res.status(400).json({error:'잘못된 프로젝트 번호'});
  const g=await query('SELECT * FROM project_groups WHERE id=$1',[req.params.id]);
  if(!g.rowCount)return res.status(404).json({error:'프로젝트를 찾을 수 없습니다.'});
  const notices=await query(`SELECT p.id,p.name AS notice_title,p.building_type,p.stage,p.estimated_cost,p.source_url,p.owner,p.address,
    COALESCE(json_agg(json_build_object('role',c.role,'organization',c.organization,'department',c.department,'person_name',c.person_name,'phone',c.phone,'email',c.email,'source',c.source,'source_url',c.source_url,'verified_at',c.verified_at,'updated_at',c.updated_at)) FILTER (WHERE c.id IS NOT NULL),'[]'::json) AS contacts
    FROM projects p LEFT JOIN project_contacts c ON c.project_id=p.id
    WHERE p.project_group_id=$1 GROUP BY p.id ORDER BY p.updated_at DESC`,[req.params.id]);
  const contacts=await query('SELECT role,organization,department,person_name,phone,email,source,source_url,verified_at,updated_at FROM project_group_contacts WHERE group_id=$1 ORDER BY role,updated_at DESC',[req.params.id]);
  res.json({...g.rows[0],notices:notices.rows,contacts:contacts.rows});
 }catch(e){res.status(500).json({error:e.message});}
});
// Read-only monitoring: does not regroup or mutate existing notices.
app.get('/api/admin/project-groups/health',loadUser,requireAdminRole,async(req,res)=>{
 try{
  const summary=await query(`SELECT
    (SELECT COUNT(*)::int FROM projects WHERE source='g2b_bid') AS total_notices,
    (SELECT COUNT(*)::int FROM project_groups) AS total_groups,
    (SELECT COUNT(*)::int FROM projects WHERE source='g2b_bid' AND project_group_id IS NOT NULL) AS linked_notices,
    (SELECT COUNT(*)::int FROM projects WHERE source='g2b_bid' AND project_group_id IS NULL) AS unlinked_notices,
    (SELECT COUNT(*)::int FROM project_groups g WHERE EXISTS(SELECT 1 FROM projects p WHERE p.project_group_id=g.id)) AS active_groups`);
  const recent=await query(`SELECT id,name,owner,region,address,updated_at
    FROM projects WHERE source='g2b_bid' AND project_group_id IS NULL
    ORDER BY updated_at DESC NULLS LAST,id DESC LIMIT 40`);
  const candidates=recent.rows.map(p=>{
    const identity=projectGroupIdentity({...p,source:'g2b_bid'});
    return {id:p.id,name:p.name,owner:p.owner,region:p.region,updated_at:p.updated_at,
      matchable:!!identity,reason:identity?'통합 규칙 충족 (아직 연결되지 않음)':'보수적 매칭 기준 미충족'};
  });
  res.json({summary:summary.rows[0],recent_unlinked:candidates,
    note:'통합 기준은 공고명 말미 공종, 발주처, 지역 및 위치 일치입니다. 이 화면은 읽기 전용입니다.'});
 }catch(e){res.status(500).json({error:e.message});}
});

// Preview matching decisions without writing any data.
app.get('/api/admin/project-groups/preview',loadUser,requireAdminRole,async(req,res)=>{
 try{
  const limit=Math.min(100,Math.max(1,Number.parseInt(req.query.limit,10)||40));
  const cursor=Math.max(0,Number.parseInt(req.query.cursor,10)||0);
  const r=await query(`SELECT id,source,name,owner,address,region
    FROM projects WHERE source='g2b_bid' AND project_group_id IS NULL AND id>$1
    ORDER BY id LIMIT $2`,[cursor,limit]);
  const identities=r.rows.map(p=>({p,identity:projectGroupIdentity(p)}));
  const keys=[...new Set(identities.filter(x=>x.identity).map(x=>x.identity.key))];
  const found=keys.length?await query('SELECT id,group_key,title FROM project_groups WHERE group_key=ANY($1::text[])',[keys]):{rows:[]};
  const existing=new Map(found.rows.map(g=>[g.group_key,g]));
  const occurrences=new Map();
  for(const {identity} of identities){if(identity)occurrences.set(identity.key,(occurrences.get(identity.key)||0)+1);}
  const rows=identities.map(({p,identity})=>{
    const group=identity?existing.get(identity.key):null;
    return {id:p.id,notice_name:p.name,owner:p.owner,region:p.region,
      proposed_group_name:identity?.title||null,existing_group_id:group?.id||null,
      status:!identity?'manual_review':group?'existing_group':occurrences.get(identity.key)>1?'new_group_candidate':'unmatched_candidate',
      explanation:!identity?'명칭·공종·발주처·위치 등 필수 기준 미충족':group?'동일 식별키를 가진 기존 그룹 존재':'기존 그룹 없음: 자동 병합 전 검토 필요'};
  });
  res.json({rows,processed:rows.length,next_cursor:r.rows.length?r.rows[r.rows.length-1].id:cursor,done:r.rows.length<limit,read_only:true,
    warning:'이 미리보기는 DB를 변경하지 않습니다. 같은 페이지에 없는 공고는 후보 집계에 포함되지 않습니다.'});
 }catch(e){res.status(500).json({error:e.message});}
});

// Explicit admin approval: only a strict identity-key match to an existing group is accepted.
app.post('/api/admin/project-groups/approve',loadUser,requireAdminRole,async(req,res)=>{
 try{
  const noticeId=Number(req.body?.notice_id),groupId=Number(req.body?.group_id);
  if(!Number.isSafeInteger(noticeId)||noticeId<=0||!Number.isSafeInteger(groupId)||groupId<=0)
    return res.status(400).json({error:'유효한 공고 ID와 프로젝트 ID가 필요합니다.'});
  const p=await query('SELECT id,source,name,owner,address,region,project_group_id FROM projects WHERE id=$1',[noticeId]);
  if(!p.rowCount)return res.status(404).json({error:'공고를 찾을 수 없습니다.'});
  if(p.rows[0].project_group_id!==null)return res.status(409).json({error:'이미 연결된 공고입니다. 변경하지 않았습니다.'});
  const identity=projectGroupIdentity(p.rows[0]);
  if(!identity)return res.status(422).json({error:'엄격한 자동 매칭 기준을 충족하지 않습니다. 연결하지 않았습니다.'});
  const updated=await query(`UPDATE projects AS p SET project_group_id=g.id
    FROM project_groups AS g
    WHERE p.id=$1 AND p.source='g2b_bid' AND p.project_group_id IS NULL
      AND g.id=$2 AND g.group_key=$3
    RETURNING p.id,p.project_group_id`,[noticeId,groupId,identity.key]);
  if(!updated.rowCount)return res.status(409).json({error:'그룹 식별키 불일치 또는 다른 관리자가 먼저 변경했습니다. 다시 조회하세요.'});
  console.info('Project group approved', {noticeId,groupId,adminId:req.user?.id});
  res.json({ok:true,notice_id:noticeId,group_id:groupId});
 }catch(e){res.status(500).json({error:e.message});}
});

// Store only attributable, manually reviewed public organization details.
app.post('/api/admin/project-groups/:id/contacts',loadUser,requireAdminRole,async(req,res)=>{
 try{
  const groupId=Number(req.params.id);
  if(!Number.isSafeInteger(groupId)||groupId<=0)return res.status(400).json({error:'잘못된 프로젝트 ID'});
  const role=String(req.body?.role||'').trim();
  const organization=String(req.body?.organization||'').trim().slice(0,200);
  const department=String(req.body?.department||'').trim().slice(0,120)||null;
  const personName=String(req.body?.person_name||'').trim().slice(0,100)||null;
  const phone=String(req.body?.phone||'').trim().slice(0,80)||null;
  const email=String(req.body?.email||'').trim().slice(0,200)||null;
  const sourceUrl=String(req.body?.source_url||'').trim().slice(0,1000);
  if(!['client','designer','supervisor','contractor'].includes(role)||!organization)
    return res.status(400).json({error:'참여기관 유형과 기관명은 필수입니다.'});
  let url;
  try{url=new URL(sourceUrl);}catch{return res.status(400).json({error:'근거가 되는 공개자료 URL을 입력하세요.'});}
  if(!['http:','https:'].includes(url.protocol)||!url.hostname.includes('.'))
    return res.status(400).json({error:'HTTP(S) 공개자료 URL만 허용됩니다.'});
  if(email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return res.status(400).json({error:'이메일 형식을 확인하세요.'});
  const g=await query('SELECT id FROM project_groups WHERE id=$1',[groupId]);
  if(!g.rowCount)return res.status(404).json({error:'프로젝트를 찾을 수 없습니다.'});
  const result=await query(`INSERT INTO project_group_contacts
    (group_id,role,organization,department,person_name,phone,email,source,source_url)
    VALUES($1,$2,$3,$4,$5,$6,$7,'manual_public',$8)
    ON CONFLICT(group_id,role,organization,source) DO UPDATE SET
      department=EXCLUDED.department,person_name=EXCLUDED.person_name,
      phone=EXCLUDED.phone,email=EXCLUDED.email,source_url=EXCLUDED.source_url,
      verified_at=NULL,updated_at=NOW()
    RETURNING id,group_id,role,organization,source,source_url,verified_at`,
    [groupId,role,organization,department,personName,phone,email,url.href]);
  res.status(201).json({ok:true,contact:result.rows[0],note:'출처 URL이 등록되었습니다. 실제 내용의 검증 완료를 의미하지 않습니다.'});
 }catch(e){res.status(500).json({error:e.message});}
});

app.post('/api/admin/project-groups/backfill',loadUser,requireAdminRole,async(req,res)=>{
 try{
  const limit=Math.min(500,Math.max(1,parseInt(req.body?.limit,10)||200));
  const cursor=Math.max(0,parseInt(req.body?.cursor,10)||0);
  const r=await query(`SELECT id,source,name,owner,address,region FROM projects
    WHERE source='g2b_bid' AND id>$1 ORDER BY id LIMIT $2`,[cursor,limit]);
  let linked=0,unmatched=0,errors=0;
  for(const p of r.rows){try{if(await linkProjectGroup(p))linked++;else unmatched++;}catch(e){errors++;console.warn('Group backfill:',p.id,e.message);}}
  res.json({processed:r.rows.length,linked,unmatched,errors,nextCursor:r.rows.length?r.rows[r.rows.length-1].id:cursor,done:r.rows.length<limit});
 }catch(e){res.status(500).json({error:e.message});}
});

app.get("/api/projects/:id", async (req, res) => {
  try {
    const r = await query("SELECT * FROM projects WHERE id=$1", [req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: "현장을 찾을 수 없습니다." });
    const f = await query("SELECT id FROM favorites WHERE project_id=$1 AND user_key=$2", [req.params.id, String(req.user.id)]);
    const s = await query("SELECT status,note FROM sales_pipeline WHERE project_id=$1 AND user_key=$2", [req.params.id, String(req.user.id)]);
    const contacts = await query(`SELECT role,organization,department,person_name,phone,email,source,source_url,verified_at,updated_at
      FROM project_contacts WHERE project_id=$1 ORDER BY CASE role WHEN 'client' THEN 1 WHEN 'designer' THEN 2 WHEN 'supervisor' THEN 3 ELSE 4 END, updated_at DESC`,[req.params.id]);
    res.json({ ...r.rows[0], contacts: contacts.rows, favorite: !!f.rowCount, pipeline: s.rows[0] || { status: "NEW", note: "" } });
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





app.post('/api/permits/leads/:id/activity',loadUser,async(req,res)=>{
 if(!/^\d+$/.test(req.params.id))return res.status(400).json({error:'잘못된 현장 ID'});
 const type=String(req.body?.type||'').trim();
 const detail=String(req.body?.detail||'').trim();
 const nextDate=req.body?.nextContactDate===null||req.body?.nextContactDate===''?null:String(req.body?.nextContactDate||'');
 if(!['CALL','EMAIL','MEETING','NOTE','FOLLOW_UP'].includes(type)||!detail||detail.length>1000)
  return res.status(400).json({error:'활동 유형과 1~1000자 내용을 입력하세요.'});
 if(nextDate!==null&&(!/^\d{4}-\d{2}-\d{2}$/.test(nextDate)||!Number.isFinite(Date.parse(nextDate))||new Date(nextDate).toISOString().slice(0,10)!==nextDate))
  return res.status(400).json({error:'연락 예정일은 YYYY-MM-DD 형식이어야 합니다.'});
 try{
  const project=await query("SELECT id FROM projects WHERE id=$1 AND source='arch_hub_permit'",[req.params.id]);
  if(!project.rows.length)return res.status(404).json({error:'건축허가 현장을 찾을 수 없습니다.'});
  const userKey=String(req.user.id);
  const pipeline=await query("SELECT id FROM sales_pipeline WHERE project_id=$1 AND user_key=$2",[req.params.id,userKey]);
  if(!pipeline.rows.length)return res.status(409).json({error:'먼저 영업 관리에 등록하세요.'});
  const activity=await query(`INSERT INTO sales_activities(project_id,user_key,activity_type,detail)
   VALUES($1,$2,$3,$4) RETURNING id,created_at AS "createdAt"`,[req.params.id,userKey,type,detail]);
  if(nextDate!==null)await query("UPDATE sales_pipeline SET next_contact_date=$3,updated_at=NOW() WHERE project_id=$1 AND user_key=$2",[req.params.id,userKey,nextDate]);
  res.status(201).json({ok:true,activity:activity.rows[0],nextContactDate:nextDate});
 }catch(e){res.status(500).json({error:'영업 활동 기록 실패'});}
});
app.get('/api/permits/leads/:id/activities',loadUser,async(req,res)=>{
 if(!/^\d+$/.test(req.params.id))return res.status(400).json({error:'잘못된 현장 ID'});
 try{
  const rows=await query(`SELECT a.id,a.activity_type AS type,a.detail,a.created_at AS "createdAt"
   FROM sales_activities a JOIN projects p ON p.id=a.project_id
   WHERE a.project_id=$1 AND a.user_key=$2 AND p.source='arch_hub_permit'
   ORDER BY a.created_at DESC LIMIT 100`,[req.params.id,String(req.user.id)]);
  res.json({rows:rows.rows});
 }catch(e){res.status(500).json({error:'영업 활동 이력 조회 실패'});}
});




app.patch('/api/permits/leads/:id/priority',loadUser,async(req,res)=>{
 if(!/^\d+$/.test(req.params.id))return res.status(400).json({error:'잘못된 현장 ID'});
 const priority=String(req.body?.priority||'').toUpperCase();
 if(!['HIGH','NORMAL','LOW'].includes(priority))return res.status(400).json({error:'중요도는 HIGH, NORMAL, LOW 중 선택하세요.'});
 try{
  const result=await query(`UPDATE sales_pipeline sp SET priority=$3,updated_at=NOW()
   FROM projects p WHERE p.id=sp.project_id AND p.source='arch_hub_permit'
   AND sp.project_id=$1 AND sp.user_key=$2
   RETURNING sp.project_id AS "projectId",sp.priority`,[req.params.id,String(req.user.id),priority]);
  if(!result.rows.length)return res.status(404).json({error:'등록된 영업 현장이 없습니다.'});
  res.json({ok:true,...result.rows[0]});
 }catch(e){res.status(500).json({error:'영업 중요도 변경 실패'});}
});

app.patch('/api/permits/leads/:id/followup',loadUser,async(req,res)=>{
 if(!/^\d+$/.test(req.params.id))return res.status(400).json({error:'잘못된 현장 ID'});
 const raw=req.body?.nextContactDate;
 if(raw!==null&&raw!==''&&typeof raw!=='string')return res.status(400).json({error:'날짜를 입력하거나 비워 주세요.'});
 const date=raw||null;
 if(date!==null&&(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(Date.parse(date))||new Date(date).toISOString().slice(0,10)!==date))
  return res.status(400).json({error:'연락 예정일은 YYYY-MM-DD 형식이어야 합니다.'});
 try{
  const updated=await query(`UPDATE sales_pipeline sp SET next_contact_date=$3,updated_at=NOW()
   FROM projects p WHERE p.id=sp.project_id AND p.source='arch_hub_permit'
   AND sp.project_id=$1 AND sp.user_key=$2
   RETURNING sp.project_id AS "projectId",sp.next_contact_date AS "nextContactDate"`,
   [req.params.id,String(req.user.id),date]);
  if(!updated.rows.length)return res.status(404).json({error:'등록된 영업 현장이 없습니다.'});
  res.json({ok:true,...updated.rows[0]});
 }catch(e){res.status(500).json({error:'연락 예정일 변경 실패'});}
});


app.get('/api/permits/sales-overview',loadUser,async(req,res)=>{
 try{
  const userKey=String(req.user.id);
  const base="FROM sales_pipeline sp JOIN projects p ON p.id=sp.project_id WHERE sp.user_key=$1 AND p.source='arch_hub_permit'";
  const summary=await query(`SELECT COUNT(*)::int AS total,
   COUNT(*) FILTER (WHERE sp.priority='HIGH')::int AS "highPriority",
   COUNT(*) FILTER (WHERE sp.status='NEW')::int AS "newLeads",
   COUNT(*) FILTER (WHERE sp.status='CONTACTED')::int AS contacted,
   COUNT(*) FILTER (WHERE sp.status='QUALIFIED')::int AS qualified,
   COUNT(*) FILTER (WHERE sp.status='PROPOSAL')::int AS proposals,
   COUNT(*) FILTER (WHERE sp.status='WON')::int AS won,
   COUNT(*) FILTER (WHERE sp.status='LOST')::int AS lost,
   COUNT(*) FILTER (WHERE sp.status NOT IN ('WON','LOST') AND sp.next_contact_date<(NOW() AT TIME ZONE 'Asia/Seoul')::date)::int AS overdue,
   COUNT(*) FILTER (WHERE sp.status NOT IN ('WON','LOST') AND sp.next_contact_date=(NOW() AT TIME ZONE 'Asia/Seoul')::date)::int AS today
   ${base}`,[userKey]);
  const urgent=await query(`SELECT p.id,p.name,p.region,sp.status,sp.priority,sp.next_contact_date AS "nextContactDate",
   GREATEST(0,((NOW() AT TIME ZONE 'Asia/Seoul')::date-sp.next_contact_date))::int AS "overdueDays"
   ${base} AND sp.status NOT IN ('WON','LOST') AND sp.next_contact_date<=(NOW() AT TIME ZONE 'Asia/Seoul')::date
   ORDER BY sp.next_contact_date ASC,CASE sp.priority WHEN 'HIGH' THEN 0 WHEN 'NORMAL' THEN 1 ELSE 2 END ASC,p.id DESC LIMIT 20`,[userKey]);
  const important=await query(`SELECT p.id,p.name,p.region,sp.status,sp.priority,sp.next_contact_date AS "nextContactDate"
   ${base} AND sp.priority='HIGH' AND sp.status NOT IN ('WON','LOST')
   ORDER BY sp.updated_at DESC LIMIT 20`,[userKey]);
  res.json({summary:summary.rows[0],urgent:urgent.rows,highPriority:important.rows,timezone:'Asia/Seoul'});
 }catch(e){res.status(500).json({error:'영업 통합 현황 조회 실패'});}
});

app.get('/api/permits/followups',loadUser,async(req,res)=>{
 try{
  const limit=Math.min(100,Math.max(1,Number.parseInt(req.query.limit,10)||50));
  const offset=Math.max(0,Math.min(100000,Number.parseInt(req.query.offset,10)||0));
  const status=String(req.query.when||'all');
  if(!['all','overdue','today','upcoming'].includes(status))return res.status(400).json({error:'잘못된 일정 필터'});
  const filters={all:'',overdue:" AND sp.next_contact_date<(NOW() AT TIME ZONE 'Asia/Seoul')::date",today:" AND sp.next_contact_date=(NOW() AT TIME ZONE 'Asia/Seoul')::date",upcoming:" AND sp.next_contact_date>(NOW() AT TIME ZONE 'Asia/Seoul')::date"};
  const base="FROM sales_pipeline sp JOIN projects p ON p.id=sp.project_id WHERE sp.user_key=$1 AND p.source='arch_hub_permit' AND sp.next_contact_date IS NOT NULL AND sp.status NOT IN ('WON','LOST')";
  const totals=await query(`SELECT COUNT(*)::int AS total,
   COUNT(*) FILTER (WHERE sp.next_contact_date<(NOW() AT TIME ZONE 'Asia/Seoul')::date)::int AS overdue,
   COUNT(*) FILTER (WHERE sp.next_contact_date=(NOW() AT TIME ZONE 'Asia/Seoul')::date)::int AS today,
   COUNT(*) FILTER (WHERE sp.next_contact_date>(NOW() AT TIME ZONE 'Asia/Seoul')::date)::int AS upcoming ${base}`,[String(req.user.id)]);
  const rows=await query(`SELECT p.id,p.name,p.address,p.region,sp.status,sp.note,sp.priority,
   sp.next_contact_date AS "nextContactDate",sp.updated_at AS "updatedAt",
   GREATEST(0,((NOW() AT TIME ZONE 'Asia/Seoul')::date-sp.next_contact_date))::int AS "overdueDays",
   CASE WHEN sp.next_contact_date<(NOW() AT TIME ZONE 'Asia/Seoul')::date THEN 'OVERDUE'
    WHEN sp.next_contact_date=(NOW() AT TIME ZONE 'Asia/Seoul')::date THEN 'TODAY'
    ELSE 'UPCOMING' END AS "urgency"
   ${base}${filters[status]} ORDER BY CASE WHEN sp.next_contact_date<=(NOW() AT TIME ZONE 'Asia/Seoul')::date THEN 0 ELSE 1 END ASC,CASE sp.priority WHEN 'HIGH' THEN 0 WHEN 'NORMAL' THEN 1 ELSE 2 END ASC,sp.next_contact_date ASC,p.id DESC LIMIT $2 OFFSET $3`,
   [String(req.user.id),limit,offset]);
  res.json({summary:totals.rows[0],rows:rows.rows,when:status,limit,offset,
   note:'날짜는 한국 표준시(Asia/Seoul)를 기준으로 계산합니다.'});
 }catch(e){res.status(500).json({error:'영업 연락 일정 조회 실패'});}
});

app.get('/api/permits/pipeline',loadUser,async(req,res)=>{
 try{
  const allowed=['ALL','NEW','CONTACTED','QUALIFIED','PROPOSAL','WON','LOST'];
  const status=String(req.query.status||'ALL').toUpperCase();
  if(!allowed.includes(status))return res.status(400).json({error:'잘못된 영업 단계'});
  const limit=Math.min(100,Math.max(1,Number.parseInt(req.query.limit,10)||50));
  const offset=Math.max(0,Math.min(100000,Number.parseInt(req.query.offset,10)||0));
  const args=[String(req.user.id)];
  let filter='';
  if(status!=='ALL'){args.push(status);filter=' AND sp.status=$2';}
  const count=await query(`SELECT COUNT(*)::int AS total FROM sales_pipeline sp JOIN projects p ON p.id=sp.project_id WHERE sp.user_key=$1 AND p.source='arch_hub_permit'${filter}`,args);
  const rows=await query(`SELECT p.id,p.name,p.address,p.region,p.building_type AS "buildingType",p.stage,p.permit_date AS "permitDate",p.area_sqm AS "areaSqm",p.owner,
   sp.status,sp.note,sp.priority,sp.next_contact_date AS "nextContactDate",sp.updated_at AS "updatedAt"
   FROM sales_pipeline sp JOIN projects p ON p.id=sp.project_id
   WHERE sp.user_key=$1 AND p.source='arch_hub_permit'${filter}
   ORDER BY sp.updated_at DESC,p.id DESC LIMIT $${args.length+1} OFFSET $${args.length+2}`,[...args,limit,offset]);
  res.json({rows:rows.rows,total:count.rows[0].total,limit,offset});
 }catch(e){res.status(500).json({error:'건축허가 영업 목록 조회 실패'});}
});

app.post('/api/permits/leads/:id/pipeline',loadUser,async(req,res)=>{
 if(!/^\d+$/.test(req.params.id))return res.status(400).json({error:'잘못된 현장 ID'});
 const status=String(req.body?.status||'NEW');
 if(!['NEW','CONTACTED','QUALIFIED','PROPOSAL','WON','LOST'].includes(status))
  return res.status(400).json({error:'지원하지 않는 영업 상태입니다.'});
 const note=String(req.body?.note||'').slice(0,1000);
 try{
  const p=await query("SELECT id FROM projects WHERE id=$1 AND source='arch_hub_permit'",[req.params.id]);
  if(!p.rows.length)return res.status(404).json({error:'건축허가 현장을 찾을 수 없습니다.'});
  await query(`INSERT INTO sales_pipeline(project_id,user_key,status,note) VALUES($1,$2,$3,$4)
   ON CONFLICT(project_id,user_key) DO UPDATE SET status=EXCLUDED.status,note=EXCLUDED.note,updated_at=NOW()`,
   [req.params.id,String(req.user.id),status,note]);
  res.json({ok:true,projectId:Number(req.params.id),status});
 }catch(e){res.status(500).json({error:'영업 대상 등록 실패'});}
});

// Early-stage ArchHUB permit lead ranking: transparent heuristic, not a sales forecast.
app.get('/api/permits/leads',async(req,res)=>{
 try{
  const profile=profiles[req.query.profile]?req.query.profile:'automation';
  const limit=Math.min(100,Math.max(1,Number.parseInt(req.query.limit,10)||30));
  const rows=await query(`SELECT p.*,
   (SELECT COUNT(*)::int FROM project_contacts c WHERE c.project_id=p.id) AS contact_count,
   (SELECT sp.status FROM sales_pipeline sp WHERE sp.project_id=p.id AND sp.user_key=$1) AS pipeline_status
   FROM projects p WHERE p.source='arch_hub_permit' ORDER BY p.updated_at DESC LIMIT 2000`,[String(req.user.id)]);
  const now=Date.now();
  const ranked=rows.rows.map(p=>{
   const base=scoreProject(p,profile);
   const days=p.permit_date?Math.floor((now-new Date(p.permit_date).getTime())/86400000):null;
   const freshness=days!==null&&days>=0&&days<=90?15:days!==null&&days<=365&&days>=0?8:0;
   const early=p.stage==='PERMIT'?10:0;
   const dataQuality=(p.address?3:0)+(p.permit_date?2:0)+(p.owner?3:0)+(Number(p.contact_count)>0?2:0);
   const score=Math.min(100,Math.round(base*0.65+freshness+early+dataQuality));
   const reasons=[];
   if(early)reasons.push('허가 단계');
   if(freshness)reasons.push('최근 허가일');
   if(base>=50)reasons.push('업종·규모 적합');
   if(Number(p.contact_count)>0)reasons.push('연락처 등록');
   return {id:p.id,name:p.name,address:p.address,region:p.region,buildingType:p.building_type,
    stage:p.stage,permitDate:p.permit_date,areaSqm:p.area_sqm,owner:p.owner,
    contactCount:p.contact_count,pipelineStatus:p.pipeline_status,score,reasons};
  }).sort((a,b)=>b.score-a.score||(new Date(b.permitDate||0)-new Date(a.permitDate||0))).slice(0,limit);
  res.json({profile:profiles[profile].label,rows:ranked,scanned:rows.rows.length,
   note:'최근 갱신 2,000건 내 휴리스틱 순위입니다. 실제 수주 가능성이나 전국 전체 현장 순위를 보장하지 않습니다.'});
 }catch(e){res.status(500).json({error:'건축허가 영업 우선순위 조회 실패'});}
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
        ON CONFLICT(source,external_id) DO UPDATE SET name=EXCLUDED.name,address=EXCLUDED.address,region=EXCLUDED.region,district=EXCLUDED.district,building_type=EXCLUDED.building_type,stage=EXCLUDED.stage,permit_date=EXCLUDED.permit_date,start_date=EXCLUDED.start_date,completion_date=EXCLUDED.completion_date,owner=EXCLUDED.owner,designer=EXCLUDED.designer,supervisor=EXCLUDED.supervisor,source_url=EXCLUDED.source_url,source_updated_at=EXCLUDED.source_updated_at,updated_at=NOW()
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
