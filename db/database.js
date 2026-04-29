/**
 * db/database.js  — sql.js (pure JavaScript SQLite, no compilation needed)
 */
const path = require('path');
const fs   = require('fs');
const DB_PATH = path.join(__dirname, 'pms.db');

let _db = null;

function saveToDisk() {
  const data = _db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

function namedToPositional(sql, obj) {
  const params = [];
  const converted = sql.replace(/@(\w+)/g, (_, key) => {
    params.push(obj.hasOwnProperty(key) ? obj[key] : null);
    return '?';
  });
  return { sql: converted, params };
}

function zipRow(cols, vals) {
  const obj = {};
  cols.forEach((c, i) => { obj[c] = vals[i]; });
  return obj;
}

function flattenArgs(sql, params) {
  if (params.length === 1 && params[0] !== null && params[0] !== undefined
      && typeof params[0] === 'object' && !Array.isArray(params[0])) {
    return namedToPositional(sql, params[0]);
  }
  return { sql, params };
}

function prepare(sql) {
  return {
    run(...params) {
      const flat = flattenArgs(sql, params);
      _db.run(flat.sql, flat.params);
      // Get lastInsertRowid BEFORE saveToDisk — export() may reset last_insert_rowid()
      const meta = _db.exec('SELECT last_insert_rowid() as id, changes() as ch');
      const row = meta[0]?.values[0];
      saveToDisk();
      return { lastInsertRowid: row?.[0] ?? 0, changes: row?.[1] ?? 0 };
    },
    // runBatch: like run() but skips disk save (call db.saveToDisk() manually after bulk ops)
    runBatch(...params) {
      const flat = flattenArgs(sql, params);
      _db.run(flat.sql, flat.params);
      const meta = _db.exec('SELECT last_insert_rowid() as id, changes() as ch');
      const row = meta[0]?.values[0];
      return { lastInsertRowid: row?.[0] ?? 0, changes: row?.[1] ?? 0 };
    },
    get(...params) {
      const flat = flattenArgs(sql, params);
      const res = _db.exec(flat.sql, flat.params);
      if (!res.length || !res[0].values.length) return undefined;
      return zipRow(res[0].columns, res[0].values[0]);
    },
    all(...params) {
      const flat = flattenArgs(sql, params);
      const res = _db.exec(flat.sql, flat.params);
      if (!res.length) return [];
      return res[0].values.map(row => zipRow(res[0].columns, row));
    },
  };
}

// Run multiple semicolon-separated statements
function execMulti(sql) {
  const statements = sql.split(';').map(s => s.trim()).filter(s => s.length > 0);
  for (const stmt of statements) {
    try { _db.run(stmt); } catch(e) { /* ignore duplicate index etc */ }
  }
}

// Transaction: runs fn, saves to disk once at end
// Uses a simple in-memory batch — no BEGIN/COMMIT (sql.js wasm is finicky with those)
function transaction(fn) {
  return function(...args) {
    fn(...args);   // just run directly — sql.js auto-handles consistency in-memory
    saveToDisk();  // single save at end for performance
  };
}

function logAudit(userId, action, entity, entityId, detail, ip) {
  prepare(`INSERT INTO audit_log(user_id,action,entity,entity_id,detail,ip) VALUES(?,?,?,?,?,?)`)
    .run(userId, action, entity||null, entityId||null,
        detail ? JSON.stringify(detail) : null, ip||null);
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, emp_no INTEGER UNIQUE NOT NULL,
  name TEXT NOT NULL, designation TEXT, grade TEXT, dept TEXT,
  company TEXT NOT NULL, division TEXT, cluster TEXT, reports_to INTEGER, reports_to_name TEXT,
  role TEXT NOT NULL DEFAULT 'employee', password_hash TEXT,
  must_change_pw INTEGER NOT NULL DEFAULT 1, temp_token TEXT, temp_token_expiry INTEGER,
  is_active INTEGER NOT NULL DEFAULT 1, last_login INTEGER,
  failed_attempts INTEGER NOT NULL DEFAULT 0, locked_until INTEGER,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, user_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  expires_at INTEGER NOT NULL, ip TEXT, user_agent TEXT
);
CREATE TABLE IF NOT EXISTS goal_sheets (
  id INTEGER PRIMARY KEY AUTOINCREMENT, emp_no INTEGER NOT NULL,
  cycle TEXT NOT NULL DEFAULT '2026-27', status TEXT NOT NULL DEFAULT 'draft',
  submitted_at INTEGER, approved_at INTEGER, approved_by INTEGER,
  supervisor_comments TEXT,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE TABLE IF NOT EXISTS kras (
  id INTEGER PRIMARY KEY AUTOINCREMENT, sheet_id INTEGER NOT NULL,
  ref INTEGER NOT NULL, kra_name TEXT NOT NULL, kra_weight REAL NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE TABLE IF NOT EXISTS kpis (
  id INTEGER PRIMARY KEY AUTOINCREMENT, kra_id INTEGER NOT NULL,
  desc TEXT NOT NULL, track_freq TEXT NOT NULL DEFAULT 'Monthly',
  assess_freq TEXT NOT NULL DEFAULT 'Quarterly', kpi_weight REAL NOT NULL,
  mid_ach REAL, end_ach REAL, mgr_mid_ach REAL, mgr_end_ach REAL,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT, sheet_id INTEGER NOT NULL,
  review_type TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
  self_went_well TEXT, self_improve TEXT, self_support_needed TEXT,
  self_submitted_at INTEGER, mgr_comments TEXT, mgr_strengths TEXT,
  mgr_develop TEXT, mgr_submitted_at INTEGER, mgr_reviewed_by INTEGER,
  overall_score REAL, system_rating TEXT, override_rating TEXT, final_rating TEXT,
  calibrated_by INTEGER, calibrated_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER,
  action TEXT NOT NULL, entity TEXT, entity_id INTEGER,
  detail TEXT, ip TEXT,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_users_emp_no  ON users(emp_no);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_gs_emp        ON goal_sheets(emp_no, cycle);
CREATE INDEX IF NOT EXISTS idx_kras_sheet    ON kras(sheet_id);
CREATE INDEX IF NOT EXISTS idx_kpis_kra      ON kpis(kra_id);
CREATE TABLE IF NOT EXISTS monthly_progress (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sheet_id INTEGER NOT NULL,
  kpi_id INTEGER NOT NULL,
  month INTEGER NOT NULL,
  fy_year TEXT NOT NULL DEFAULT '2026-27',
  increment_ach REAL,
  notes TEXT,
  entered_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  UNIQUE(sheet_id, kpi_id, month, fy_year)
);
CREATE INDEX IF NOT EXISTS idx_mp_sheet ON monthly_progress(sheet_id);
CREATE INDEX IF NOT EXISTS idx_mp_kpi ON monthly_progress(kpi_id);
CREATE INDEX IF NOT EXISTS idx_reviews_sheet ON reviews(sheet_id)
`;

async function init() {
  const SQL = await require('sql.js')();
  if (fs.existsSync(DB_PATH)) {
    _db = new SQL.Database(fs.readFileSync(DB_PATH));
  } else {
    _db = new SQL.Database();
  }
  execMulti(SCHEMA);
  saveToDisk();
  console.log('  Database ready:', DB_PATH);
  return db;
}

const db = { prepare, exec: execMulti, transaction, logAudit, init, pragma: () => {}, saveToDisk };
module.exports = db;

// Phase 1 schema additions — run after init()
async function migrate() {
  const statements = `
    -- Cycle phase control (HR activates/deactivates windows)
    CREATE TABLE IF NOT EXISTS cycle_settings (
      id          INTEGER PRIMARY KEY,
      cycle       TEXT NOT NULL DEFAULT '2026-27',
      goal_setting_open   INTEGER NOT NULL DEFAULT 1,
      mid_year_open       INTEGER NOT NULL DEFAULT 0,
      year_end_open       INTEGER NOT NULL DEFAULT 0,
      -- Date ranges (ISO strings e.g. '2026-04-01')
      gs_start    TEXT,
      gs_end      TEXT,
      mid_start   TEXT,
      mid_end     TEXT,
      ye_start    TEXT,
      ye_end      TEXT,
      -- Notes / reason for extension
      gs_note     TEXT,
      mid_note    TEXT,
      ye_note     TEXT,
      updated_at  INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      updated_by  INTEGER
    );
    INSERT OR IGNORE INTO cycle_settings(id,cycle,goal_setting_open,mid_year_open,year_end_open,gs_start,gs_end,mid_start,mid_end,ye_start,ye_end)
      VALUES(1,'2026-27',1,0,0,'2026-04-01','2026-04-30','2026-10-01','2026-10-31','2027-03-15','2027-03-31');
    UPDATE cycle_settings SET cycle='2026-27' WHERE id=1 AND cycle != '2026-27';
    -- Add new columns to existing DB if they don't exist yet
    ALTER TABLE cycle_settings ADD COLUMN gs_start TEXT;
    ALTER TABLE cycle_settings ADD COLUMN gs_end TEXT;
    ALTER TABLE cycle_settings ADD COLUMN mid_start TEXT;
    ALTER TABLE cycle_settings ADD COLUMN mid_end TEXT;
    ALTER TABLE cycle_settings ADD COLUMN ye_start TEXT;
    ALTER TABLE cycle_settings ADD COLUMN ye_end TEXT;
    ALTER TABLE cycle_settings ADD COLUMN gs_note TEXT;
    ALTER TABLE cycle_settings ADD COLUMN mid_note TEXT;
    ALTER TABLE cycle_settings ADD COLUMN ye_note TEXT;
    ALTER TABLE cycle_settings ADD COLUMN updated_by INTEGER;
    -- Set default dates if null
    UPDATE cycle_settings SET
      gs_start=COALESCE(gs_start,'2026-04-01'), gs_end=COALESCE(gs_end,'2026-04-30'),
      mid_start=COALESCE(mid_start,'2026-10-01'), mid_end=COALESCE(mid_end,'2026-10-31'),
      ye_start=COALESCE(ye_start,'2027-03-15'), ye_end=COALESCE(ye_end,'2027-03-31')
    WHERE id=1;

    -- Development goals (employee side, part of goal sheet)
    CREATE TABLE IF NOT EXISTS dev_goals (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      sheet_id  INTEGER NOT NULL,
      goal_text TEXT NOT NULL,
      target_date TEXT,
      status    TEXT DEFAULT 'in_progress',
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );

    -- Competency ratings (year-end)
    CREATE TABLE IF NOT EXISTS competency_ratings (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      sheet_id      INTEGER NOT NULL,
      competency_id INTEGER NOT NULL,
      review_type   TEXT NOT NULL DEFAULT 'year_end',
      self_rating   INTEGER,   -- 1-5
      mgr_rating    INTEGER,   -- 1-5
      self_comment  TEXT,
      mgr_comment   TEXT,
      updated_at    INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );

    -- Career aspirations (year-end)
    CREATE TABLE IF NOT EXISTS career_aspirations (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      sheet_id      INTEGER NOT NULL,
      aspiration    TEXT,
      timeline_years INTEGER,
      created_at    INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );

    -- Add promo recommendation to reviews
    ALTER TABLE reviews ADD COLUMN promo_recommended INTEGER DEFAULT 0;
    ALTER TABLE reviews ADD COLUMN promo_justification TEXT;
    ALTER TABLE reviews ADD COLUMN promo_status TEXT DEFAULT 'pending';
    ALTER TABLE reviews ADD COLUMN promo_decision_by INTEGER;
    ALTER TABLE reviews ADD COLUMN promo_decision_at INTEGER;
    ALTER TABLE reviews ADD COLUMN promo_decision_reason TEXT
    ALTER TABLE reviews ADD COLUMN employee_comments TEXT;
    ALTER TABLE reviews ADD COLUMN supervisor_agrees INTEGER DEFAULT 1;
    ALTER TABLE reviews ADD COLUMN supervisor_comments_review TEXT;
    -- Add kpi_status for mid-year tracking
    ALTER TABLE kpis ADD COLUMN mid_status TEXT DEFAULT 'on_track';
    -- Allow supervisor feedback to be marked as released to employee
    ALTER TABLE reviews ADD COLUMN feedback_released INTEGER DEFAULT 0;

    -- Monthly Progress Tracker
    CREATE TABLE IF NOT EXISTS monthly_progress (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sheet_id INTEGER NOT NULL,
      kpi_id INTEGER NOT NULL,
      month INTEGER NOT NULL,
      fy_year TEXT NOT NULL DEFAULT '2026-27',
      increment_ach REAL,
      notes TEXT,
      entered_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      UNIQUE(sheet_id, kpi_id, month, fy_year)
    );
    -- Pushback support (supervisor returns review to employee)
    ALTER TABLE reviews ADD COLUMN pushback_reason TEXT;

    -- Goal Change Requests (employee requests mid-cycle changes after approval)
    CREATE TABLE IF NOT EXISTS goal_change_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sheet_id INTEGER NOT NULL,
      emp_no INTEGER NOT NULL,
      cycle TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      reason TEXT NOT NULL,
      requested_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      reviewed_at INTEGER,
      reviewed_by INTEGER,
      reviewer_comments TEXT,
      kras_snapshot TEXT,
      approved_kras_snapshot TEXT,
      is_post_midyear INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_gcr_sheet ON goal_change_requests(sheet_id);
    CREATE INDEX IF NOT EXISTS idx_gcr_emp ON goal_change_requests(emp_no);

    -- Notifications (in-app alerts + email log)
    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      emp_no INTEGER NOT NULL,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      message TEXT,
      link TEXT,
      is_read INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_notif_emp ON notifications(emp_no);
    CREATE INDEX IF NOT EXISTS idx_notif_read ON notifications(emp_no, is_read);

    -- Users email field
    ALTER TABLE users ADD COLUMN email TEXT
    CREATE TABLE IF NOT EXISTS precal_adjustments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sheet_id INTEGER NOT NULL,
      emp_no INTEGER NOT NULL,
      adjusted_by INTEGER NOT NULL,
      reason TEXT NOT NULL,
      kpis_snapshot TEXT,
      adjusted_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
    ALTER TABLE reviews ADD COLUMN precal_adjusted INTEGER DEFAULT 0;
    ALTER TABLE reviews ADD COLUMN precal_adjusted_at INTEGER
    ALTER TABLE goal_sheets ADD COLUMN version INTEGER DEFAULT 1;
    ALTER TABLE goal_sheets ADD COLUMN last_changed_at INTEGER;
    ALTER TABLE goal_sheets ADD COLUMN change_count INTEGER DEFAULT 0;
    ALTER TABLE reviews ADD COLUMN pushback_at INTEGER;
    ALTER TABLE reviews ADD COLUMN pushback_by INTEGER;
    ALTER TABLE reviews ADD COLUMN pushback_count INTEGER DEFAULT 0
  `;
  statements.split(';').map(s => s.trim()).filter(s => s.length > 0).forEach(stmt => {
    try { db.exec(stmt); } catch(e) { /* column may already exist */ }
  });
  db.saveToDisk();
}

db.migrate = migrate;
