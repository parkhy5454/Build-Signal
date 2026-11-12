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

module.exports = { query, initDb };
