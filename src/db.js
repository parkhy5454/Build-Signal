const { Pool } = require("pg");

let pool;
function getPool() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL 환경변수가 설정되지 않았습니다.");
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL.includes("localhost") ? false : { rejectUnauthorized: false },
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000
    });
  }
  return pool;
}

async function query(sql, params = []) {
  return getPool().query(sql, params);
}

async function initDb() {
  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGSERIAL PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      company_name TEXT NOT NULL DEFAULT '',
      contact_name TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL DEFAULT 'user',
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      approved_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);
    CREATE TABLE IF NOT EXISTS auto_ingest_state (
      source TEXT PRIMARY KEY, cursor_at TIMESTAMPTZ, next_due_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_attempt_at TIMESTAMPTZ,last_success_at TIMESTAMPTZ,last_error TEXT,
      lease_token TEXT,lease_until TIMESTAMPTZ,call_day DATE,daily_calls INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO auto_ingest_state(source) VALUES('permits'),('bids'),('early') ON CONFLICT DO NOTHING;
    CREATE TABLE IF NOT EXISTS auto_permit_regions (
      sigungu_cd CHAR(5) NOT NULL,bjdong_cd CHAR(5) NOT NULL,label TEXT NOT NULL DEFAULT '',
      enabled BOOLEAN NOT NULL DEFAULT TRUE,next_page INTEGER NOT NULL DEFAULT 1 CHECK(next_page>0),
      next_due_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),last_attempt_at TIMESTAMPTZ,last_success_at TIMESTAMPTZ,
      last_cycle_at TIMESTAMPTZ,last_error TEXT,failures INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(sigungu_cd,bjdong_cd)
    );
    CREATE INDEX IF NOT EXISTS idx_auto_permit_due ON auto_permit_regions(next_due_at) WHERE enabled=TRUE;
    CREATE TABLE IF NOT EXISTS permit_region_queues (
      id BIGSERIAL PRIMARY KEY,
      label TEXT NOT NULL,
      query_text TEXT NOT NULL,
      regions JSONB NOT NULL,
      status TEXT NOT NULL DEFAULT 'prepared',
      next_batch INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE permit_region_queues ADD COLUMN IF NOT EXISTS run_token TEXT;
    ALTER TABLE permit_region_queues ADD COLUMN IF NOT EXISTS last_error TEXT;
    ALTER TABLE permit_region_queues ADD COLUMN IF NOT EXISTS failed_region TEXT;
    ALTER TABLE permit_region_queues ADD COLUMN IF NOT EXISTS failed_at TIMESTAMPTZ;
    ALTER TABLE permit_region_queues ADD COLUMN IF NOT EXISTS next_region INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE permit_region_queues ADD COLUMN IF NOT EXISTS run_start_date CHAR(8);
    ALTER TABLE permit_region_queues ADD COLUMN IF NOT EXISTS run_end_date CHAR(8);
    CREATE TABLE IF NOT EXISTS permit_legal_dong_codes (
      code CHAR(10) PRIMARY KEY,
      name TEXT NOT NULL,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE permit_legal_dong_codes ADD COLUMN IF NOT EXISTS catalog_origin TEXT NOT NULL DEFAULT 'manual';
    CREATE TABLE IF NOT EXISTS region_catalog_state(id INTEGER PRIMARY KEY CHECK(id=1),version TEXT NOT NULL,loaded_at TIMESTAMPTZ NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_permit_legal_dong_name ON permit_legal_dong_codes(name);
    CREATE TABLE IF NOT EXISTS permit_region_presets (
      id BIGSERIAL PRIMARY KEY,
      label TEXT NOT NULL,
      sigungu_cd CHAR(5) NOT NULL,
      bjdong_cd CHAR(5) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(sigungu_cd,bjdong_cd)
    );
    CREATE TABLE IF NOT EXISTS permit_ingest_jobs (
      id BIGSERIAL PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'running',
      job_data JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_permit_ingest_jobs_created ON permit_ingest_jobs(created_at DESC);
    CREATE TABLE IF NOT EXISTS projects (
      id BIGSERIAL PRIMARY KEY,
      source TEXT NOT NULL DEFAULT 'manual',
      external_id TEXT,
      name TEXT NOT NULL,
      address TEXT,
      region TEXT,
      district TEXT,
      building_type TEXT,
      stage TEXT NOT NULL DEFAULT 'UNKNOWN',
      permit_date DATE,
      start_date DATE,
      completion_date DATE,
      floors_above INTEGER,
      floors_below INTEGER,
      area_sqm NUMERIC,
      estimated_cost NUMERIC,
      owner TEXT,
      designer TEXT,
      supervisor TEXT,
      contractor TEXT,
      source_url TEXT,
      source_updated_at DATE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(source, external_id)
    );
    CREATE INDEX IF NOT EXISTS idx_projects_region ON projects(region, district);
    CREATE INDEX IF NOT EXISTS idx_projects_stage ON projects(stage);
    CREATE INDEX IF NOT EXISTS idx_projects_updated ON projects(updated_at DESC);
    CREATE TABLE IF NOT EXISTS early_source_documents (
      url TEXT PRIMARY KEY,title TEXT NOT NULL,content_hash TEXT,record_count INTEGER NOT NULL DEFAULT 0,
      last_checked_at TIMESTAMPTZ,last_error TEXT
    );
    CREATE TABLE IF NOT EXISTS project_party_evidence (
      id BIGSERIAL PRIMARY KEY,project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK(role IN ('owner','developer','applicant','designer','contractor','supervisor','operator')),
      organization TEXT NOT NULL,person_name TEXT,department TEXT,phone TEXT,email TEXT,
      contact_scope TEXT NOT NULL CHECK(contact_scope IN ('company','department','project')),
      observed_stage TEXT NOT NULL CHECK(observed_stage IN ('REVIEW','PERMIT','STARTED','COMPLETED')),
      source_url TEXT NOT NULL,excerpt TEXT NOT NULL DEFAULT '',fingerprint TEXT NOT NULL UNIQUE,
      origin TEXT NOT NULL,observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_party_evidence_project ON project_party_evidence(project_id,observed_at DESC);
    ALTER TABLE project_party_evidence ADD COLUMN IF NOT EXISTS organization_address TEXT;
    ALTER TABLE project_party_evidence ADD COLUMN IF NOT EXISTS registration_no TEXT;
    CREATE TABLE IF NOT EXISTS organization_directory (
      id BIGSERIAL PRIMARY KEY,source TEXT NOT NULL,organization TEXT NOT NULL,name_key TEXT NOT NULL,
      address TEXT NOT NULL,address_key TEXT NOT NULL,registration_no TEXT,representative TEXT,phone TEXT,data_date TEXT,
      source_url TEXT NOT NULL,fingerprint TEXT NOT NULL UNIQUE,is_current BOOLEAN NOT NULL DEFAULT FALSE,
      fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_directory_name ON organization_directory(name_key) WHERE is_current=TRUE;
    CREATE TABLE IF NOT EXISTS directory_sync_state (
      source TEXT PRIMARY KEY,next_due_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),last_attempt_at TIMESTAMPTZ,last_success_at TIMESTAMPTZ,
      lease_token TEXT,lease_until TIMESTAMPTZ,last_error TEXT,record_count INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO directory_sync_state(source) VALUES('architects'),('busan_developers') ON CONFLICT DO NOTHING;
    CREATE TABLE IF NOT EXISTS party_contact_decisions (
      id BIGSERIAL PRIMARY KEY,evidence_id BIGINT NOT NULL REFERENCES project_party_evidence(id) ON DELETE CASCADE,
      directory_id BIGINT NOT NULL REFERENCES organization_directory(id),decision TEXT NOT NULL CHECK(decision IN ('confirmed','rejected')),
      reason TEXT NOT NULL,reviewed_by BIGINT NOT NULL REFERENCES users(id),created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_party_contact_decisions ON party_contact_decisions(evidence_id,directory_id,id DESC);
    CREATE TABLE IF NOT EXISTS project_phase_links (
      early_id BIGINT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
      permit_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      reason TEXT NOT NULL,reviewed_by BIGINT NOT NULL REFERENCES users(id),created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),CHECK(early_id<>permit_id)
    );
    CREATE TABLE IF NOT EXISTS favorites (
      id BIGSERIAL PRIMARY KEY,
      project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      user_key TEXT NOT NULL DEFAULT 'admin',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(project_id, user_key)
    );
    CREATE TABLE IF NOT EXISTS sales_pipeline (
      id BIGSERIAL PRIMARY KEY,
      project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      user_key TEXT NOT NULL DEFAULT 'admin',
      status TEXT NOT NULL DEFAULT 'NEW',
      note TEXT DEFAULT '',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(project_id, user_key)
    );
    ALTER TABLE sales_pipeline ADD COLUMN IF NOT EXISTS next_contact_date DATE;
    ALTER TABLE sales_pipeline ADD COLUMN IF NOT EXISTS priority TEXT NOT NULL DEFAULT 'NORMAL';
    CREATE TABLE IF NOT EXISTS sales_stage_history (
      id BIGSERIAL PRIMARY KEY,
      project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      user_key TEXT NOT NULL,
      from_status TEXT,
      to_status TEXT NOT NULL,
      changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_sales_stage_history_user_project
      ON sales_stage_history(user_key,project_id,changed_at DESC);
    CREATE OR REPLACE FUNCTION record_sales_stage_change() RETURNS TRIGGER AS $$
    BEGIN
      IF TG_OP='INSERT' THEN
        INSERT INTO sales_stage_history(project_id,user_key,from_status,to_status)
        VALUES(NEW.project_id,NEW.user_key,NULL,NEW.status);
      ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
        INSERT INTO sales_stage_history(project_id,user_key,from_status,to_status)
        VALUES(NEW.project_id,NEW.user_key,OLD.status,NEW.status);
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
    DROP TRIGGER IF EXISTS trg_sales_stage_change ON sales_pipeline;
    CREATE TRIGGER trg_sales_stage_change AFTER INSERT OR UPDATE OF status ON sales_pipeline
      FOR EACH ROW EXECUTE FUNCTION record_sales_stage_change();
    CREATE TABLE IF NOT EXISTS sales_activities (
      id BIGSERIAL PRIMARY KEY,
      project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      user_key TEXT NOT NULL,
      activity_type TEXT NOT NULL,
      detail TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_sales_activities_user_project ON sales_activities(user_key,project_id,created_at DESC);
    CREATE TABLE IF NOT EXISTS project_contacts (
      id BIGSERIAL PRIMARY KEY,
      project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('client','designer','supervisor','contractor')),
      organization TEXT NOT NULL,
      department TEXT,
      person_name TEXT,
      phone TEXT,
      email TEXT,
      source TEXT NOT NULL,
      source_url TEXT,
      verified_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(project_id,role,organization,source)
    );
    CREATE INDEX IF NOT EXISTS idx_project_contacts_project ON project_contacts(project_id);
    CREATE INDEX IF NOT EXISTS idx_project_contacts_role ON project_contacts(role);
    CREATE TABLE IF NOT EXISTS project_groups (
      id BIGSERIAL PRIMARY KEY,
      group_key TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      owner TEXT NOT NULL,
      region TEXT NOT NULL,
      location TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS project_group_contacts (
      id BIGSERIAL PRIMARY KEY,
      group_id BIGINT NOT NULL REFERENCES project_groups(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK(role IN ('client','designer','supervisor','contractor')),
      organization TEXT NOT NULL,
      department TEXT,
      person_name TEXT,
      phone TEXT,
      email TEXT,
      source TEXT NOT NULL DEFAULT 'manual',
      source_url TEXT,
      verified_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(group_id,role,organization,source)
    );
    CREATE INDEX IF NOT EXISTS idx_group_contacts_group ON project_group_contacts(group_id);
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS project_group_id BIGINT REFERENCES project_groups(id) ON DELETE SET NULL;
    CREATE INDEX IF NOT EXISTS idx_projects_group ON projects(project_group_id);
    CREATE TABLE IF NOT EXISTS ingest_logs (
      id BIGSERIAL PRIMARY KEY,
      source TEXT NOT NULL,
      received_count INTEGER NOT NULL DEFAULT 0,
      inserted_count INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      message TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

async function transaction(work){
 const client=await getPool().connect();
 try{await client.query('BEGIN');const result=await work((sql,args=[])=>client.query(sql,args));await client.query('COMMIT');return result;}
 catch(e){await client.query('ROLLBACK');throw e;}
 finally{client.release();}
}
module.exports = { query, initDb, transaction };
