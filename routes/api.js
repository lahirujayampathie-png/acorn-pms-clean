/**
 * routes/api.js
 * PMS data API: employees, goals, reviews, calibration.
 * All routes require authentication. Some require elevated roles.
 */

const express = require('express');
const db      = require('../db/database');
const {
  verifyToken, requireRole, requireHR,
  requireSelfOrManager, isInHierarchy, ROLE_LEVELS
} = require('../middleware/auth');

const router = express.Router();
router.use(verifyToken);   // All API routes require auth

// ── Auto-create new tables on startup (safe — IF NOT EXISTS) ─────────────
(function initNewTables() {
  // Per-employee review unlock overrides (Feature: HR unlocks mid/year-end for specific employees)
  db.prepare(`CREATE TABLE IF NOT EXISTS review_overrides (
    emp_no      INTEGER NOT NULL,
    cycle       TEXT NOT NULL,
    review_type TEXT NOT NULL,
    state       TEXT NOT NULL,
    reason      TEXT,
    set_by      INTEGER,
    set_at      INTEGER,
    PRIMARY KEY (emp_no, cycle, review_type)
  )`).run();

  // KPI target version history (Feature: track target changes mid-year with effective dates)
  db.prepare(`CREATE TABLE IF NOT EXISTS kpi_target_history (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    kpi_id         INTEGER NOT NULL,
    target         REAL NOT NULL,
    unit           TEXT,
    effective_from TEXT NOT NULL,
    effective_to   TEXT,
    changed_by     INTEGER,
    reason         TEXT,
    created_at     INTEGER
  )`).run();

  // Add effective date columns to kras (safe — ignore if already exists)
  try { db.prepare('ALTER TABLE kras ADD COLUMN effective_from TEXT').run(); } catch(e){}
  try { db.prepare('ALTER TABLE kras ADD COLUMN effective_to   TEXT').run(); } catch(e){}

  // Add effective date columns to kpis
  try { db.prepare('ALTER TABLE kpis ADD COLUMN effective_from TEXT').run(); } catch(e){}
  try { db.prepare('ALTER TABLE kpis ADD COLUMN effective_to   TEXT').run(); } catch(e){}

  // Add join/proration columns to goal_sheets
  try { db.prepare('ALTER TABLE goal_sheets ADD COLUMN join_date     TEXT').run(); } catch(e){}
  try { db.prepare('ALTER TABLE goal_sheets ADD COLUMN fy_start_date TEXT').run(); } catch(e){}
  try { db.prepare('ALTER TABLE goal_sheets ADD COLUMN fy_end_date   TEXT').run(); } catch(e){}
  try { db.prepare('ALTER TABLE goal_sheets ADD COLUMN skip_mid_year INTEGER DEFAULT 0').run(); } catch(e){}

  // Add sup_approved columns to goal_change_requests for Option D two-step flow
  try { db.prepare('ALTER TABLE goal_change_requests ADD COLUMN sup_approved_at INTEGER').run(); } catch(e){}
  try { db.prepare('ALTER TABLE goal_change_requests ADD COLUMN sup_approved_by INTEGER').run(); } catch(e){}
  try { db.prepare('ALTER TABLE goal_change_requests ADD COLUMN sup_comments TEXT').run(); } catch(e){}

  // System settings table — stores runtime toggles like email_enabled
  db.prepare(`CREATE TABLE IF NOT EXISTS system_settings (
    key    TEXT PRIMARY KEY,
    value  TEXT NOT NULL,
    updated_at INTEGER,
    updated_by INTEGER
  )`).run();
  // Default: email enabled
  db.prepare(`INSERT OR IGNORE INTO system_settings(key, value, updated_at) VALUES('email_enabled','1',strftime('%s','now'))`).run();

  // Reset stale failed_attempts on startup (prevent spurious lockouts after server restart)
  // Only clear if locked_until has already expired — active locks remain
  const now = Math.floor(Date.now()/1000);
  db.prepare('UPDATE users SET failed_attempts=0, locked_until=NULL WHERE failed_attempts>0 AND (locked_until IS NULL OR locked_until <= ?)').run(now);
})();

// Reports access: sbu_head (own companies via subtree), exco + hr_admin (group-wide)
// senior_manager and below cannot access reports
function requireReportsAccess(req, res, next) {
  const allowed = ['sbu_head','exco','hr_admin'];
  if (!req.user || !allowed.includes(req.user.role)) {
    return res.status(403).json({ error: 'Access denied — SBU Head or above required' });
  }
  next();
}

// For sbu_head: returns list of companies in their reporting subtree.
// For exco/hr_admin: returns null (meaning no filter — see all).
function getSbuCompanies(user) {
  if (user.role !== 'sbu_head') return null;
  const allEmps = db.prepare('SELECT emp_no, reports_to, company FROM users WHERE is_active=1').all();
  const subtree = getSubtree(user.emp_no, allEmps);
  const companies = [...new Set(subtree.map(e => e.company).filter(Boolean))];
  return companies.length ? companies : null;
}

// Builds WHERE clause and params for company scoping.
// sbuCompanies=null → no filter. sbuCompanies=[...] → AND u.company IN (?,?,...)
function companyScope(sbuCompanies, baseParams = []) {
  if (!sbuCompanies) return { clause: '', params: baseParams };
  const placeholders = sbuCompanies.map(() => '?').join(',');
  return {
    clause: ` AND u.company IN (${placeholders})`,
    params: [...baseParams, ...sbuCompanies]
  };
}

const { notify, saveNotification } = require('../notifications');

const CYCLE = '2026-27';

const RATING_SCALE = [
  { r: 'A', min: 125.01, label: 'Exceptional',   desc: 'Significantly above performance expectations. At the very top against peers.' },
  { r: 'B', min: 101,    label: 'Strong',         desc: 'Consistently operating well above performance expectations against peers.' },
  { r: 'C', min: 85,     label: 'Competent',      desc: 'Consistently achieving or above performance expectations against peers.' },
  { r: 'D', min: 60,     label: 'Inconsistent',   desc: 'Inconsistently meeting performance expectations and/or below their peers.' },
  { r: 'E', min: 0,      label: 'Below Expectations', desc: 'Not meeting performance expectations. Significantly below their peers.' },
];

// ════════════════════════════════════════════════════════════
// EMPLOYEES
// ════════════════════════════════════════════════════════════

// GET /api/employees — list employees (scope depends on role)
router.get('/employees', (req, res) => {
  const u = req.user;
  let sql, params = [];

  if (u.role === 'hr_admin' || ROLE_LEVELS[u.role] >= ROLE_LEVELS['exco']) {
    // Full visibility
    sql = `SELECT u.emp_no, u.name, u.designation, u.grade, u.dept,
                  u.company, u.division, u.cluster, u.role, u.reports_to,
                  u.is_active, u.email, m.name as manager_name,
                  gs.status as goal_status
           FROM users u
           LEFT JOIN users m ON u.reports_to = m.emp_no
           LEFT JOIN goal_sheets gs ON gs.emp_no = u.emp_no AND gs.cycle = ?
           WHERE u.is_active = 1
           ORDER BY u.cluster, u.company, u.name`;
    params = [CYCLE];
  } else if (ROLE_LEVELS[u.role] >= ROLE_LEVELS['manager']) {
    // Their entire reporting subtree
    sql = `SELECT u.emp_no, u.name, u.designation, u.grade, u.dept,
                  u.company, u.division, u.cluster, u.role, u.reports_to,
                  m.name as manager_name, gs.status as goal_status
           FROM users u
           LEFT JOIN users m ON u.reports_to = m.emp_no
           LEFT JOIN goal_sheets gs ON gs.emp_no = u.emp_no AND gs.cycle = ?
           WHERE u.is_active = 1
           ORDER BY u.name`;
    // We'll filter in JS for subtree (simpler than recursive SQL)
    params = [CYCLE];
    const allEmps = db.prepare(sql).all(...params);
    const subtree = getSubtree(u.emp_no, allEmps);
    return res.json(subtree);
  } else {
    // Employee sees only themselves + direct manager
    sql = `SELECT emp_no, name, designation, grade, dept, company, division, cluster, role, reports_to
           FROM users WHERE emp_no = ? OR emp_no = ? ORDER BY name`;
    params = [u.emp_no, u.reports_to || 0];
  }

  const result = db.prepare(sql).all(...params);
  res.json(result);
});

// GET /api/employees/:empNo — single employee (access controlled)
router.get('/employees/:empNo', (req, res) => {
  const targetEmpNo = parseInt(req.params.empNo);
  const u = req.user;

  // Access check
  if (u.role !== 'hr_admin' &&
      u.emp_no !== targetEmpNo &&
      ROLE_LEVELS[u.role] < ROLE_LEVELS['supervisor']) {
    return res.status(403).json({ error: 'Access denied.' });
  }
  if (ROLE_LEVELS[u.role] >= ROLE_LEVELS['supervisor'] &&
      u.role !== 'hr_admin' &&
      u.emp_no !== targetEmpNo &&
      !isInHierarchy(targetEmpNo, u.emp_no)) {
    return res.status(403).json({ error: 'This employee is not in your reporting hierarchy.' });
  }

  const emp = db.prepare(
    `SELECT u.emp_no, u.name, u.designation, u.grade, u.dept, u.company,
            u.division, u.role, u.reports_to, m.name as manager_name
     FROM users u LEFT JOIN users m ON u.reports_to = m.emp_no
     WHERE u.emp_no = ?`
  ).get(targetEmpNo);

  if (!emp) return res.status(404).json({ error: 'Employee not found.' });

  // Get direct reports
  const reports = db.prepare(
    'SELECT emp_no, name, designation FROM users WHERE reports_to = ? AND is_active = 1'
  ).all(targetEmpNo);

  res.json({ ...emp, direct_reports: reports });
});

// GET /api/employees/my-team — current user's direct + indirect reports
router.get('/my/team', (req, res) => {
  const u = req.user;
  const allEmps = db.prepare(
    `SELECT u.emp_no, u.name, u.designation, u.grade, u.dept,
            u.company, u.division, u.cluster, u.role, u.reports_to,
            m.name as manager_name, gs.status as goal_status,
            r_mid.self_submitted_at as mid_submitted,
            r_mid.mgr_submitted_at as mid_mgr_submitted,
            r_ye.self_submitted_at as ye_submitted,
            r_ye.mgr_submitted_at as ye_mgr_submitted,
            r_ye.precal_adjusted as precal_adjusted,
            r_ye.overall_score as overall_score
     FROM users u
     LEFT JOIN users m ON u.reports_to = m.emp_no
     LEFT JOIN goal_sheets gs ON gs.emp_no = u.emp_no AND gs.cycle = ?
     LEFT JOIN reviews r_mid ON r_mid.sheet_id = gs.id AND r_mid.review_type = 'mid_year'
     LEFT JOIN reviews r_ye ON r_ye.sheet_id = gs.id AND r_ye.review_type = 'year_end'
     WHERE u.is_active = 1`
  ).all(CYCLE);

  const subtree = getSubtree(u.emp_no, allEmps);
  res.json(subtree);
});

// ════════════════════════════════════════════════════════════
// GOAL SHEETS
// ════════════════════════════════════════════════════════════

// GET /api/goals/my — current user's goal sheet
router.get('/goals/my', (req, res) => {
  const sheet = getFullGoalSheet(req.user.emp_no);
  res.json(sheet || null);
});

// GET /api/goals/:empNo — goal sheet for an employee (access controlled)
router.get('/goals/:empNo', (req, res) => {
  const targetEmpNo = parseInt(req.params.empNo);
  const u = req.user;

  if (!canAccessEmployee(u, targetEmpNo)) {
    return res.status(403).json({ error: 'Access denied.' });
  }
  const sheet = getFullGoalSheet(targetEmpNo);
  res.json(sheet || null);
});

// POST /api/goals — create or replace goal sheet (self or HR)
router.post('/goals', (req, res) => {
  const u = req.user;
  const { emp_no, kras, draft } = req.body;
  const targetEmpNo = emp_no ? parseInt(emp_no) : u.emp_no;

  if (targetEmpNo !== u.emp_no && u.role !== 'hr_admin') {
    return res.status(403).json({ error: 'Only HR can create goals for other employees.' });
  }

  // Only validate weights when NOT saving as draft
  if (!draft) {
    const totalKraWt = kras.reduce((s, k) => s + (k.kra_weight != null ? k.kra_weight : (k.kraWeight || 0)), 0);
    if (Math.abs(totalKraWt - 100) > 0.5) {
      return res.status(400).json({ error: `KRA weights must sum to 100%. Current total: ${totalKraWt}%` });
    }
    for (const kra of kras) {
      const kpiTotal = (kra.kpis || []).reduce((s, k) => s + (k.kpi_weight != null ? k.kpi_weight : (k.kpiWeight || 0)), 0);
      if (Math.abs(kpiTotal - 100) > 0.5) {
        return res.status(400).json({
          error: `KPI weights in KRA "${kra.kra_name || kra.kra}" must sum to 100%. Current: ${kpiTotal}%`
        });
      }
    }
  }

  const now = Math.floor(Date.now()/1000);

  // Upsert goal sheet
  let sheet = db.prepare('SELECT * FROM goal_sheets WHERE emp_no = ? AND cycle = ?').get(targetEmpNo, CYCLE);

  if (sheet && sheet.status === 'approved') {
    if (u.role !== 'hr_admin') {
      return res.status(400).json({ error: 'Cannot edit an approved goal sheet. Contact HR to reopen.' });
    }
  }

  const saveGoals = db.transaction(() => {
    if (sheet) {
      db.prepare('UPDATE goal_sheets SET status = ?, updated_at = ? WHERE id = ?')
        .run('draft', now, sheet.id);
      // Delete KPIs first (no FK cascade), then KRAs
      const oldKraIds = db.prepare('SELECT id FROM kras WHERE sheet_id = ?').all(sheet.id).map(k => k.id);
      if (oldKraIds.length) {
        db.prepare(`DELETE FROM kpis WHERE kra_id IN (${oldKraIds.map(() => '?').join(',')})`).run(...oldKraIds);
      }
      db.prepare('DELETE FROM kras WHERE sheet_id = ?').run(sheet.id);
    } else {
      const result = db.prepare(
        'INSERT INTO goal_sheets(emp_no, cycle, status, created_at, updated_at) VALUES(?,?,?,?,?)'
      ).run(targetEmpNo, CYCLE, 'draft', now, now);
      sheet = { id: result.lastInsertRowid };
    }

    kras.forEach((kra, i) => {
      // Accept both old format (kra.kra, kra.kraWeight) and new format (kra.kra_name, kra.kra_weight)
      const kraName   = kra.kra_name   || kra.kra   || 'KRA ' + (i+1);
      const kraWeight = kra.kra_weight != null ? kra.kra_weight : (kra.kraWeight != null ? kra.kraWeight : 0);
      const kraRes = db.prepare(
        'INSERT INTO kras(sheet_id, ref, kra_name, kra_weight, created_at) VALUES(?,?,?,?,?)'
      ).run(sheet.id, i + 1, kraName, kraWeight, now);

      (kra.kpis || []).forEach(kpi => {
        const kpiDesc    = kpi.desc      || '';
        const trackFreq  = kpi.track_freq || kpi.trackFreq  || 'Monthly';
        const assessFreq = kpi.assess_freq|| kpi.assessFreq || 'Quarterly';
        const kpiWeight  = kpi.kpi_weight != null ? kpi.kpi_weight : (kpi.kpiWeight != null ? kpi.kpiWeight : 0);
        db.prepare(
          'INSERT INTO kpis(kra_id, desc, track_freq, assess_freq, kpi_weight, created_at, updated_at) VALUES(?,?,?,?,?,?,?)'
        ).run(kraRes.lastInsertRowid, kpiDesc, trackFreq, assessFreq, kpiWeight, now, now);
      });
    });
  });

  saveGoals();
  db.logAudit(u.id, 'goals_saved', 'goal_sheet', sheet.id, { emp_no: targetEmpNo }, req.ip);
  res.json({ success: true, sheet_id: sheet.id });
});

// POST /api/goals/:empNo/submit — submit for approval
router.post('/goals/:empNo/submit', (req, res) => {
  const targetEmpNo = parseInt(req.params.empNo);
  const u = req.user;

  if (targetEmpNo !== u.emp_no && u.role !== 'hr_admin') {
    return res.status(403).json({ error: 'Can only submit your own goals.' });
  }

  const sheet = db.prepare('SELECT * FROM goal_sheets WHERE emp_no = ? AND cycle = ?').get(targetEmpNo, CYCLE);
  if (!sheet) return res.status(404).json({ error: 'No goal sheet found.' });
  if (sheet.status === 'submitted' || sheet.status === 'approved') {
    return res.status(400).json({ error: `Goals already ${sheet.status}.` });
  }

  const now = Math.floor(Date.now()/1000);
  db.prepare('UPDATE goal_sheets SET status = ?, submitted_at = ?, updated_at = ? WHERE id = ?')
    .run('submitted', now, now, sheet.id);
  db.logAudit(u.id, 'goals_submitted', 'goal_sheet', sheet.id, { emp_no: targetEmpNo }, req.ip);

  // Notify supervisor that goals are pending their approval
  try {
    const emp = db.prepare('SELECT emp_no, name, reports_to FROM users WHERE emp_no=?').get(targetEmpNo);
    if (emp && emp.reports_to) {
      const supervisor = db.prepare('SELECT emp_no, email FROM users WHERE emp_no=?').get(emp.reports_to);
      if (supervisor) {
        // Count total pending for this supervisor
        const pendingCount = db.prepare(`SELECT COUNT(*) as n FROM goal_sheets gs
          JOIN users u ON u.emp_no=gs.emp_no WHERE u.reports_to=? AND gs.cycle=? AND gs.status='submitted'`).get(emp.reports_to, CYCLE);
        notify(db, 'goals_pending_approval', [supervisor], {
          count: pendingCount ? pendingCount.n : 1,
          names: [emp.name]
        }).catch(()=>{});
      }
    }
  } catch(e) { /* non-critical */ }

  res.json({ success: true });
});

// POST /api/goals/:empNo/approve — manager approves
router.post('/goals/:empNo/approve', (req, res) => {
  const targetEmpNo = parseInt(req.params.empNo);
  const u = req.user;
  const { comments } = req.body;

  // Must be their direct manager or HR
  const emp = db.prepare('SELECT reports_to FROM users WHERE emp_no = ?').get(targetEmpNo);
  if (u.role !== 'hr_admin' && emp?.reports_to !== u.emp_no) {
    return res.status(403).json({ error: 'Only the direct manager or HR can approve goals.' });
  }

  const sheet = db.prepare('SELECT * FROM goal_sheets WHERE emp_no = ? AND cycle = ?').get(targetEmpNo, CYCLE);
  if (!sheet) return res.status(404).json({ error: 'No goal sheet found.' });
  if (sheet.status !== 'submitted') return res.status(400).json({ error: 'Goals are not in submitted status.' });

  const now = Math.floor(Date.now()/1000);
  db.prepare(
    'UPDATE goal_sheets SET status = ?, approved_at = ?, approved_by = ?, supervisor_comments = ?, updated_at = ? WHERE id = ?'
  ).run('approved', now, u.emp_no, comments || '', now, sheet.id);

  db.logAudit(u.id, 'goals_approved', 'goal_sheet', sheet.id,
    { emp_no: targetEmpNo, by: u.emp_no }, req.ip);
  // Notify employee their goals were approved
  const empUser = db.prepare('SELECT emp_no, email, name FROM users WHERE emp_no=?').get(targetEmpNo);
  if (empUser) notify(db, 'goal_approved', [empUser], {}).catch(()=>{});
  res.json({ success: true });
});

// POST /api/goals/:empNo/reject — manager rejects
router.post('/goals/:empNo/reject', (req, res) => {
  const targetEmpNo = parseInt(req.params.empNo);
  const u = req.user;
  const { comments } = req.body;

  const emp = db.prepare('SELECT reports_to FROM users WHERE emp_no = ?').get(targetEmpNo);
  if (u.role !== 'hr_admin' && emp?.reports_to !== u.emp_no) {
    return res.status(403).json({ error: 'Only the direct manager or HR can reject goals.' });
  }

  const sheet = db.prepare('SELECT * FROM goal_sheets WHERE emp_no = ? AND cycle = ?').get(targetEmpNo, CYCLE);
  if (!sheet) return res.status(404).json({ error: 'No goal sheet found.' });

  const now = Math.floor(Date.now()/1000);
  db.prepare('UPDATE goal_sheets SET status = ?, supervisor_comments = ?, updated_at = ? WHERE id = ?')
    .run('rejected', comments || '', now, sheet.id);

  db.logAudit(u.id, 'goals_rejected', 'goal_sheet', sheet.id,
    { emp_no: targetEmpNo, reason: comments }, req.ip);
  const empUserR = db.prepare('SELECT emp_no, email FROM users WHERE emp_no=?').get(targetEmpNo);
  if (empUserR) notify(db, 'goal_rejected', [empUserR], {comments}).catch(()=>{});
  res.json({ success: true });
});

// POST /api/goals/:empNo/reopen — HR reopens
router.post('/goals/:empNo/reopen', requireRole('hr_admin'), (req, res) => {
  const targetEmpNo = parseInt(req.params.empNo);
  const sheet = db.prepare('SELECT * FROM goal_sheets WHERE emp_no = ? AND cycle = ?').get(targetEmpNo, CYCLE);
  if (!sheet) return res.status(404).json({ error: 'No goal sheet found.' });

  db.prepare('UPDATE goal_sheets SET status = ?, updated_at = ? WHERE id = ?')
    .run('draft', Math.floor(Date.now()/1000), sheet.id);
  db.logAudit(req.user.id, 'goals_reopened', 'goal_sheet', sheet.id, { by: req.user.emp_no }, req.ip);
  res.json({ success: true });
});

// POST /api/goals/:empNo/reset — HR deletes goal sheet entirely so employee can start fresh
router.post('/goals/:empNo/reset', requireRole('hr_admin'), (req, res) => {
  const targetEmpNo = parseInt(req.params.empNo);
  const sheet = db.prepare('SELECT * FROM goal_sheets WHERE emp_no = ? AND cycle = ?').get(targetEmpNo, CYCLE);
  if (!sheet) return res.status(404).json({ error: 'No goal sheet found.' });

  const kras = db.prepare('SELECT id FROM kras WHERE sheet_id = ?').all(sheet.id);
  kras.forEach(k => db.prepare('DELETE FROM kpis WHERE kra_id = ?').run(k.id));
  db.prepare('DELETE FROM kras WHERE sheet_id = ?').run(sheet.id);
  db.prepare('DELETE FROM goal_sheets WHERE id = ?').run(sheet.id);

  db.logAudit(req.user.id, 'goals_reset', 'goal_sheet', sheet.id, { emp_no: targetEmpNo }, req.ip);
  res.json({ success: true });
});

// POST /api/reviews/:empNo/reset — HR resets a specific review phase (mid_year or year_end)
router.post('/reviews/:empNo/reset', requireRole('hr_admin'), (req, res) => {
  const empNo = parseInt(req.params.empNo);
  const { review_type } = req.body;
  if (!review_type || !['mid_year','year_end'].includes(review_type)) {
    return res.status(400).json({error:'Invalid review_type. Must be mid_year or year_end.'});
  }
  const sheet = db.prepare('SELECT * FROM goal_sheets WHERE emp_no=? AND cycle=?').get(empNo, CYCLE);
  if (!sheet) return res.status(404).json({error:'No goal sheet found.'});

  const now = Math.floor(Date.now()/1000);
  const existing = db.prepare('SELECT id FROM reviews WHERE sheet_id=? AND review_type=?').get(sheet.id, review_type);
  if (existing) {
    db.prepare('DELETE FROM reviews WHERE id=?').run(existing.id);
  }
  // Also reset KPI achievements for that phase
  const kras = db.prepare('SELECT id FROM kras WHERE sheet_id=?').all(sheet.id);
  kras.forEach(kra => {
    const kpis = db.prepare('SELECT id FROM kpis WHERE kra_id=?').all(kra.id);
    kpis.forEach(kpi => {
      if (review_type === 'mid_year') {
        try {
          db.prepare('UPDATE kpis SET mid_ach=NULL, mgr_mid_ach=NULL, mid_status=NULL, updated_at=? WHERE id=?').run(now, kpi.id);
        } catch(e) {
          db.prepare('UPDATE kpis SET mid_ach=NULL, mgr_mid_ach=NULL, updated_at=? WHERE id=?').run(now, kpi.id);
        }
      } else {
        db.prepare('UPDATE kpis SET end_ach=NULL, mgr_end_ach=NULL, updated_at=? WHERE id=?').run(now, kpi.id);
      }
    });
  });

  db.logAudit(req.user.id, 'review_reset', 'review', sheet.id, {emp_no: empNo, review_type}, req.ip);
  res.json({success: true, message: `${review_type === 'mid_year' ? 'Mid-year' : 'Year-end'} review reset successfully.`});
});

// ════════════════════════════════════════════════════════════
// KPI ACHIEVEMENTS
// ════════════════════════════════════════════════════════════

// PUT /api/goals/:empNo/kpis — update achievement percentages
router.put('/goals/:empNo/kpis', (req, res) => {
  const targetEmpNo = parseInt(req.params.empNo);
  const u = req.user;
  const { kpis, review_type, is_manager } = req.body;

  const isOwnUpdate = targetEmpNo === u.emp_no;
  const targetEmp = db.prepare('SELECT reports_to FROM users WHERE emp_no = ?').get(targetEmpNo);
  const isDirectMgr = targetEmp && targetEmp.reports_to === u.emp_no;
  if (!isOwnUpdate && !isDirectMgr && u.role !== 'hr_admin') {
    return res.status(403).json({ error: 'Access denied.' });
  }

  const sheet = db.prepare('SELECT * FROM goal_sheets WHERE emp_no = ? AND cycle = ?').get(targetEmpNo, CYCLE);
  if (!sheet) return res.status(404).json({ error: 'No goal sheet found.' });
  if (sheet.status !== 'approved') {
    return res.status(400).json({ error: 'Goal sheet must be approved before entering achievements.' });
  }

  const now = Math.floor(Date.now()/1000);
  const phase = review_type === 'year_end' ? 'end' : 'mid';

  try {
    kpis.forEach(k => {
      if (is_manager) {
        if (phase === 'end') {
          db.prepare('UPDATE kpis SET mgr_end_ach = ?, updated_at = ? WHERE id = ?').run(
            k.mgr_end_ach !== undefined ? k.mgr_end_ach : null, now, k.id);
        } else {
          db.prepare('UPDATE kpis SET mgr_mid_ach = ?, updated_at = ? WHERE id = ?').run(
            k.mgr_mid_ach !== undefined ? k.mgr_mid_ach : null, now, k.id);
        }
      } else {
        if (phase === 'end') {
          db.prepare('UPDATE kpis SET end_ach = ?, updated_at = ? WHERE id = ?').run(
            k.end_ach !== undefined ? k.end_ach : null, now, k.id);
        } else {
          const midAch = k.mid_ach !== undefined ? k.mid_ach : null;
          // mid_status added in migrate — use safe fallback
          try {
            const midStatus = k.mid_status || 'on_track';
            db.prepare('UPDATE kpis SET mid_ach = ?, mid_status = ?, updated_at = ? WHERE id = ?').run(
              midAch, midStatus, now, k.id);
          } catch(e) {
            // mid_status column missing — update without it
            db.prepare('UPDATE kpis SET mid_ach = ?, updated_at = ? WHERE id = ?').run(midAch, now, k.id);
          }
        }
      }
    });
  } catch(err) {
    console.error('KPI update error:', err);
    return res.status(500).json({ error: 'Failed to save KPI achievements: ' + err.message });
  }

  db.logAudit(u.id, 'kpi_updated', 'goal_sheet', sheet.id,
    { emp_no: targetEmpNo, review_type, is_manager }, req.ip);

  const scores = computeScores(sheet.id, phase);
  if (scores.overall !== null) {
    db.prepare('UPDATE goal_sheets SET updated_at = ? WHERE id = ?').run(now, sheet.id);
  }
  res.json({ success: true, scores });
});

// ════════════════════════════════════════════════════════════
// REVIEWS
// ════════════════════════════════════════════════════════════

// ── Review access helper — checks global window + per-employee override ──────
function canAccessReview(empNo, reviewType, cycle) {
  // Check for HR override first
  const override = db.prepare(
    'SELECT state FROM review_overrides WHERE emp_no=? AND cycle=? AND review_type=?'
  ).get(empNo, cycle, reviewType);
  if (override) {
    return override.state === 'open'; // HR explicitly opened or locked
  }
  // Fall back to global cycle window
  const c = db.prepare('SELECT * FROM cycle_settings WHERE cycle=?').get(cycle);
  if (!c) return false;
  if (reviewType === 'mid_year') return !!c.mid_year_open;
  if (reviewType === 'year_end') return !!c.year_end_open;
  return false;
}

// POST /api/reviews/:empNo/submit-self — employee submits self-evaluation
router.post('/reviews/:empNo/submit-self', (req, res) => {
  const targetEmpNo = parseInt(req.params.empNo);
  const u = req.user;
  const { review_type, went_well, improve, support } = req.body;

  if (targetEmpNo !== u.emp_no) {
    return res.status(403).json({ error: 'Can only submit your own self-evaluation.' });
  }

  const sheet = db.prepare('SELECT * FROM goal_sheets WHERE emp_no = ? AND cycle = ?').get(targetEmpNo, CYCLE);
  if (!sheet || sheet.status !== 'approved') {
    return res.status(400).json({ error: 'No approved goal sheet found.' });
  }

  const now = Math.floor(Date.now()/1000);
  const existing = db.prepare('SELECT * FROM reviews WHERE sheet_id = ? AND review_type = ?').get(sheet.id, review_type);

  if (existing) {
    db.prepare(
      `UPDATE reviews SET self_went_well=?, self_improve=?, self_support_needed=?,
       self_submitted_at=?, status='self_submitted', updated_at=? WHERE id=?`
    ).run(went_well, improve, support, now, now, existing.id);
  } else {
    const scores = computeScores(sheet.id);
    db.prepare(
      `INSERT INTO reviews(sheet_id, review_type, status, self_went_well, self_improve,
       self_support_needed, self_submitted_at, overall_score, system_rating, created_at, updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?)`
    ).run(sheet.id, review_type, 'self_submitted', went_well, improve, support, now,
      scores.overall, scores.rating, now, now);
  }

  db.logAudit(u.id, 'self_review_submitted', 'review', sheet.id, { review_type }, req.ip);
  res.json({ success: true });
});

// POST /api/reviews/:empNo/manager-review — manager submits assessment
router.post('/reviews/:empNo/manager-review', (req, res) => {
  const targetEmpNo = parseInt(req.params.empNo);
  const u = req.user;
  const { review_type, comments, strengths, develop } = req.body;

  const emp = db.prepare('SELECT reports_to FROM users WHERE emp_no = ?').get(targetEmpNo);
  if (u.role !== 'hr_admin' && emp?.reports_to !== u.emp_no) {
    return res.status(403).json({ error: 'Only the direct manager or HR can submit manager review.' });
  }

  const sheet = db.prepare('SELECT * FROM goal_sheets WHERE emp_no = ? AND cycle = ?').get(targetEmpNo, CYCLE);
  if (!sheet) return res.status(404).json({ error: 'No goal sheet found.' });

  const now = Math.floor(Date.now()/1000);
  const review = db.prepare('SELECT * FROM reviews WHERE sheet_id = ? AND review_type = ?').get(sheet.id, review_type);
  const scores = computeScores(sheet.id);

  if (review) {
    db.prepare(
      `UPDATE reviews SET mgr_comments=?, mgr_strengths=?, mgr_develop=?,
       mgr_submitted_at=?, mgr_reviewed_by=?, status='mgr_submitted',
       overall_score=?, system_rating=?, final_rating=?, updated_at=? WHERE id=?`
    ).run(comments, strengths, develop, now, u.emp_no,
      scores.overall, scores.rating, scores.rating, now, review.id);
  } else {
    db.prepare(
      `INSERT INTO reviews(sheet_id, review_type, status, mgr_comments, mgr_strengths,
       mgr_develop, mgr_submitted_at, mgr_reviewed_by, overall_score, system_rating, final_rating,
       created_at, updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(sheet.id, review_type, 'mgr_submitted', comments, strengths, develop,
      now, u.emp_no, scores.overall, scores.rating, scores.rating, now, now);
  }

  db.logAudit(u.id, 'mgr_review_submitted', 'review', sheet.id,
    { emp_no: targetEmpNo, review_type }, req.ip);
  res.json({ success: true, scores });
});

// ════════════════════════════════════════════════════════════
// CALIBRATION (HR only)
// ════════════════════════════════════════════════════════════

// GET /api/calibration — year-end only with emp/mgr/precal scores
router.get('/calibration', requireRole('senior_manager'), (req, res) => {
  const { company } = req.query;
  let sql = `SELECT u.emp_no, u.name, u.designation, u.company, u.grade,
                    gs.id as sheet_id, gs.status as goal_status,
                    r.overall_score, r.system_rating, r.override_rating,
                    r.final_rating, r.status as review_status,
                    r.precal_adjusted,
                    r.self_went_well, r.self_improve, r.employee_comments,
                    r.mgr_comments, r.mgr_strengths, r.mgr_develop,
                    r.promo_recommended,
                    m.name as manager_name, m.emp_no as manager_emp_no
             FROM users u
             LEFT JOIN goal_sheets gs ON gs.emp_no = u.emp_no AND gs.cycle = ?
             LEFT JOIN reviews r ON r.sheet_id = gs.id AND r.review_type = 'year_end'
             LEFT JOIN users m ON u.reports_to = m.emp_no
             WHERE u.is_active = 1`;
  const params = [CYCLE];
  if (company) { sql += ' AND u.company = ?'; params.push(company); }
  sql += ' ORDER BY u.company, u.name';

  const rows = db.prepare(sql).all(...params);

  // For each row, compute emp_score and mgr_score separately
  const result = rows.map(row => {
    if (!row.sheet_id) return {...row, emp_score: null, mgr_score: null, ye_score: null};
    const empScores = computeScores(row.sheet_id, 'end');
    const mgrScores = computeScores(row.sheet_id, 'end');
    return {
      ...row,
      emp_score: empScores.overall,
      mgr_score: mgrScores.mgr_overall || empScores.overall, // use overall as fallback
      ye_score: row.overall_score
    };
  });

  res.json(result);
});

// POST /api/calibration/set-rating — HR sets override rating (year-end only)
router.post('/calibration/set-rating', requireHR, (req, res) => {
  const { emp_no, override_rating } = req.body;
  const review_type = 'year_end'; // always year-end
  const validRatings = ['A', 'B', 'C', 'D', 'E', null, ''];
  if (!validRatings.includes(override_rating)) {
    return res.status(400).json({ error: 'Invalid rating.' });
  }

  const sheet = db.prepare('SELECT * FROM goal_sheets WHERE emp_no = ? AND cycle = ?')
    .get(parseInt(emp_no), CYCLE);
  if (!sheet) return res.status(404).json({ error: 'No goal sheet.' });

  const now = Math.floor(Date.now()/1000);
  const overrideVal = override_rating || null;
  const sysRating = db.prepare('SELECT system_rating FROM reviews WHERE sheet_id=? AND review_type=?')
    .get(sheet.id, review_type)?.system_rating;
  const final = overrideVal || sysRating;

  const existing = db.prepare('SELECT id FROM reviews WHERE sheet_id=? AND review_type=?').get(sheet.id, review_type);
  if (existing) {
    db.prepare(`UPDATE reviews SET override_rating=?,final_rating=?,calibrated_by=?,calibrated_at=?,status='calibrated',updated_at=? WHERE id=?`)
      .run(overrideVal, final, req.user.emp_no, now, now, existing.id);
  } else {
    db.prepare(`INSERT INTO reviews(sheet_id,review_type,status,override_rating,final_rating,calibrated_by,calibrated_at,created_at,updated_at) VALUES(?,'year_end','calibrated',?,?,?,?,?,?)`)
      .run(sheet.id, overrideVal, final, req.user.emp_no, now, now, now);
  }

  db.logAudit(req.user.id, 'rating_calibrated', 'review', sheet.id,
    { emp_no, override_rating: overrideVal, final }, req.ip);
  res.json({ success: true, final_rating: final });
});

// POST /api/calibration/publish — unlock ratings (HR)
router.post('/calibration/publish', requireHR, (req, res) => {
  const { published } = req.body; // true = unlock, false = lock
  // Store in a simple settings table (or just trust the front-end session state + audit)
  // For simplicity: we return success and the front-end manages visibility
  db.logAudit(req.user.id, published ? 'ratings_published' : 'ratings_locked',
    'calibration', null, null, req.ip);
  res.json({ success: true, published });
});

// POST /api/goals/:empNo/amend — supervisor amends KRA/KPI weights and descriptions before approving
router.post('/goals/:empNo/amend', (req, res) => {
  const targetEmpNo = parseInt(req.params.empNo);
  const u = req.user;
  const { kras } = req.body;
  const emp = db.prepare('SELECT reports_to FROM users WHERE emp_no = ?').get(targetEmpNo);
  if (u.role !== 'hr_admin' && emp?.reports_to !== u.emp_no) {
    return res.status(403).json({ error: 'Only the direct supervisor or HR can amend goals.' });
  }
  const sheet = db.prepare('SELECT * FROM goal_sheets WHERE emp_no = ? AND cycle = ?').get(targetEmpNo, CYCLE);
  if (!sheet) return res.status(404).json({ error: 'No goal sheet found.' });
  if (sheet.status !== 'submitted') {
    return res.status(400).json({ error: 'Can only amend submitted goals.' });
  }
  const now = Math.floor(Date.now()/1000);
  (kras || []).forEach(kra => {
    db.prepare('UPDATE kras SET kra_name = ?, kra_weight = ? WHERE id = ?')
      .run(kra.kra_name, kra.kra_weight, kra.id);
    (kra.kpis || []).forEach(kpi => {
      db.prepare('UPDATE kpis SET desc = ?, kpi_weight = ?, updated_at = ? WHERE id = ?')
        .run(kpi.desc, kpi.kpi_weight, now, kpi.id);
    });
  });
  db.logAudit(u.id, 'goals_amended', 'goal_sheet', sheet.id, { emp_no: targetEmpNo }, req.ip);
  res.json({ success: true });
});

// POST /api/reviews/:empNo/release-feedback — release mid-year feedback to employee
router.post('/reviews/:empNo/release-feedback', (req, res) => {
  const empNo = parseInt(req.params.empNo);
  const u = req.user;
  const { review_type } = req.body;
  const emp = db.prepare('SELECT reports_to FROM users WHERE emp_no = ?').get(empNo);
  if (u.role !== 'hr_admin' && emp?.reports_to !== u.emp_no) {
    return res.status(403).json({ error: 'Access denied.' });
  }
  const sheet = db.prepare('SELECT * FROM goal_sheets WHERE emp_no = ? AND cycle = ?').get(empNo, CYCLE);
  if (!sheet) return res.status(404).json({ error: 'No goal sheet.' });
  db.prepare('UPDATE reviews SET feedback_released = 1, updated_at = ? WHERE sheet_id = ? AND review_type = ?')
    .run(Math.floor(Date.now()/1000), sheet.id, review_type || 'mid_year');
  db.logAudit(u.id, 'feedback_released', 'review', sheet.id, { emp_no: empNo, review_type }, req.ip);

  // Notify employee their feedback is available
  try {
    const empUser = db.prepare('SELECT emp_no, email FROM users WHERE emp_no=?').get(empNo);
    if (empUser) notify(db, 'midyear_feedback_released', [empUser], {}).catch(()=>{});
  } catch(e) {}

  res.json({ success: true });
});

// ════════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════════

function getFullGoalSheet(empNo) {
  const sheet = db.prepare('SELECT * FROM goal_sheets WHERE emp_no = ? AND cycle = ?').get(empNo, CYCLE);
  if (!sheet) return null;

  const kras = db.prepare('SELECT * FROM kras WHERE sheet_id = ? ORDER BY ref').all(sheet.id);
  const kraIds = kras.map(k => k.id);

  let kpis = [];
  if (kraIds.length) {
    kpis = db.prepare(
      `SELECT * FROM kpis WHERE kra_id IN (${kraIds.map(() => '?').join(',')}) ORDER BY id`
    ).all(...kraIds);
  }

  const kpisByKra = {};
  kpis.forEach(k => {
    if (!kpisByKra[k.kra_id]) kpisByKra[k.kra_id] = [];
    kpisByKra[k.kra_id].push(k);
  });

  const reviews = db.prepare('SELECT * FROM reviews WHERE sheet_id = ?').all(sheet.id);
  const approver = sheet.approved_by
    ? db.prepare('SELECT name FROM users WHERE emp_no = ?').get(sheet.approved_by)
    : null;

  return {
    ...sheet,
    approved_by_name: approver?.name,
    kras: kras.map(k => ({ ...k, kpis: kpisByKra[k.id] || [] })),
    reviews,
    scores: computeScores(sheet.id),
  };
}

function computeScores(sheetId, phase) {
  const useEnd = phase === 'end';
  const sheet  = db.prepare('SELECT * FROM goal_sheets WHERE id=?').get(sheetId);
  // FY dates — fall back to full year if not set
  const fyStart = sheet?.fy_start_date || null;
  const fyEnd   = sheet?.fy_end_date   || null;
  const kras    = db.prepare('SELECT * FROM kras WHERE sheet_id = ?').all(sheetId);
  let overallWeighted = 0, totalKraWt = 0;

  // Helper: get target version history for a KPI
  function getTargetHistory(kpiId) {
    return db.prepare(
      'SELECT * FROM kpi_target_history WHERE kpi_id=? ORDER BY effective_from ASC'
    ).all(kpiId);
  }

  // Helper: compute weighted score using versioned targets + monthly progress
  // Returns null if no data, or the blended achievement %
  function versionedScore(kpi, monthlyEntries, fyStartDate, fyEndDate) {
    const history = getTargetHistory(kpi.id);
    if (!history.length) return null; // no versioned targets — use legacy ach fields

    // Build monthly target map: month 1-12 → target (from version active that month)
    const cycleYear = parseInt((CYCLE||'2026-27').split('-')[0]);
    const fyS = fyStartDate ? new Date(fyStartDate) : new Date(`${cycleYear}-04-01`);
    const fyE = fyEndDate   ? new Date(fyEndDate)   : new Date(`${cycleYear+1}-03-31`);

    let totalTarget = 0;
    let totalAchieved = 0;
    let hasData = false;

    for (let m = 1; m <= 12; m++) {
      // Calendar date of this FY month
      const mDate = new Date(fyS);
      mDate.setMonth(fyS.getMonth() + (m - 1));
      if (mDate > fyE) break; // beyond employee's FY end

      // Find which target version was active this month
      const mStr = mDate.toISOString().slice(0, 7); // YYYY-MM
      let activeTarget = null;
      for (const v of history) {
        const vFrom = v.effective_from ? v.effective_from.slice(0,7) : '0000-00';
        const vTo   = v.effective_to   ? v.effective_to.slice(0,7)   : '9999-99';
        if (mStr >= vFrom && mStr <= vTo) { activeTarget = v.target; break; }
      }
      if (activeTarget === null) continue;

      totalTarget += activeTarget / 12; // monthly slice of annual target

      // Find monthly achievement for this month
      const entry = monthlyEntries.find(e => e.kpi_id === kpi.id && e.month === m);
      if (entry?.increment_ach != null) {
        totalAchieved += parseFloat(entry.increment_ach);
        hasData = true;
      }
    }
    if (!hasData || totalTarget === 0) return null;
    return Math.round((totalAchieved / totalTarget * 100) * 10) / 10;
  }

  // Load monthly progress for blended scoring
  const monthlyEntries = db.prepare(
    'SELECT * FROM monthly_progress WHERE sheet_id=? AND fy_year=?'
  ).all(sheetId, CYCLE);

  const kraScores = kras.map(kra => {
    const kpis = db.prepare('SELECT * FROM kpis WHERE kra_id = ?').all(kra.id);
    let empKraAch = 0, empHasAny = false;
    let mgrKraAch = 0, mgrHasAny = false;

    kpis.forEach(kpi => {
      // Try versioned score first; fall back to legacy ach fields
      const versioned = versionedScore(kpi, monthlyEntries, fyStart, fyEnd);

      let empAch;
      if (versioned !== null) {
        empAch = versioned;
      } else {
        empAch = useEnd ? (kpi.end_ach != null ? kpi.end_ach : kpi.mid_ach) : kpi.mid_ach;
      }
      if (empAch != null) { empKraAch += empAch * (kpi.kpi_weight / 100); empHasAny = true; }

      const mgrAch = useEnd ? (kpi.mgr_end_ach != null ? kpi.mgr_end_ach : kpi.mgr_mid_ach) : kpi.mgr_mid_ach;
      if (mgrAch != null) { mgrKraAch += mgrAch * (kpi.kpi_weight / 100); mgrHasAny = true; }
    });

    const empNorm = empHasAny ? Math.round(empKraAch * 10) / 10 : null;
    const mgrNorm = mgrHasAny ? Math.round(mgrKraAch * 10) / 10 : null;

    if (empNorm !== null) { overallWeighted += empNorm * (kra.kra_weight / 100); totalKraWt += kra.kra_weight; }

    return {
      kra_id: kra.id,
      kra_name: kra.kra_name,
      kra_weight: kra.kra_weight,
      effective_from: kra.effective_from || null,
      effective_to:   kra.effective_to   || null,
      score: empNorm,
      mgr_score: mgrNorm,
      rating: empNorm !== null ? getSystemRating((empNorm / kra.kra_weight) * 100) : null,
      mgr_rating: mgrNorm !== null ? getSystemRating((mgrNorm / kra.kra_weight) * 100) : null,
    };
  });

  const overall = totalKraWt > 0
    ? Math.round((totalKraWt === 100 ? overallWeighted : overallWeighted / totalKraWt * 100) * 10) / 10
    : null;
  const rating     = overall !== null ? getSystemRating(overall) : null;
  const ratingInfo = rating ? RATING_SCALE.find(r => r.r === rating) : null;

  return {
    kra_scores: kraScores, overall, rating,
    rating_label: ratingInfo?.label, rating_desc: ratingInfo?.desc,
    is_prorated: !!(sheet?.join_date || sheet?.fy_start_date)
  };
}

function getSystemRating(pct) {
  if (pct > 125)  return 'A';
  if (pct >= 101) return 'B';
  if (pct >= 85)  return 'C';
  if (pct >= 60)  return 'D';
  return 'E';
}

function getSubtree(managerEmpNo, allEmps) {
  const result = [];
  const queue  = [managerEmpNo];
  const visited = new Set();

  while (queue.length) {
    const current = queue.shift();
    if (visited.has(current)) continue;
    visited.add(current);
    allEmps.filter(e => e.reports_to === current).forEach(e => {
      result.push(e);
      queue.push(e.emp_no);
    });
  }
  return result;
}

function canAccessEmployee(u, targetEmpNo) {
  if (u.role === 'hr_admin') return true;
  if (u.emp_no === targetEmpNo) return true;
  if (ROLE_LEVELS[u.role] >= ROLE_LEVELS['exco']) return true; // exco can view everyone
  if (ROLE_LEVELS[u.role] >= ROLE_LEVELS['supervisor'] && isInHierarchy(targetEmpNo, u.emp_no)) return true;
  return false;
}

// POST /api/reviews/:empNo/pushback — supervisor pushes review back to employee for revision
router.post('/reviews/:empNo/pushback', (req, res) => {
  const empNo = parseInt(req.params.empNo);
  const emp = db.prepare('SELECT reports_to FROM users WHERE emp_no=?').get(empNo);
  if (req.user.role !== 'hr_admin' && emp?.reports_to !== req.user.emp_no) {
    return res.status(403).json({error:'Only the direct supervisor or HR can push back this review.'});
  }
  const { review_type, reason } = req.body;
  if (!reason || !reason.trim()) return res.status(400).json({error:'A reason is required when pushing back a review.'});
  const sheet = db.prepare('SELECT * FROM goal_sheets WHERE emp_no=? AND cycle=?').get(empNo, CYCLE);
  if (!sheet) return res.status(404).json({error:'No goal sheet found.'});
  const now = Math.floor(Date.now()/1000);
  const existing = db.prepare('SELECT * FROM reviews WHERE sheet_id=? AND review_type=?').get(sheet.id, review_type);
  if (existing) {
    try {
      db.prepare(`UPDATE reviews SET status='pushed_back', pushback_reason=?, pushback_at=?, pushback_by=?, self_submitted_at=NULL, updated_at=? WHERE id=?`)
        .run(reason, now, req.user.emp_no, now, existing.id);
    } catch(e) {
      // pushback columns may not exist — add them
      db.prepare(`UPDATE reviews SET status='pushed_back', updated_at=? WHERE id=?`).run(now, existing.id);
    }
  } else {
    db.prepare(`INSERT INTO reviews(sheet_id,review_type,status,pushback_reason,pushback_at,pushback_by,created_at,updated_at) VALUES(?,?,'pushed_back',?,?,?,?,?)`)
      .run(sheet.id, review_type, reason, now, req.user.emp_no, now, now);
  }
  db.logAudit(req.user.id, 'review_pushed_back', 'review', sheet.id, {empNo, review_type, reason}, req.ip);

  // Notify employee their review was pushed back
  try {
    const empUser = db.prepare('SELECT emp_no, email FROM users WHERE emp_no=?').get(empNo);
    if (empUser) notify(db, 'review_pushed_back', [empUser], {reason}).catch(()=>{});
  } catch(e) {}

  res.json({success:true});
});


// ════════════════════════════════════════════════════════════
// CYCLE SETTINGS (HR controls which windows are open)
// ════════════════════════════════════════════════════════════

// GET /api/cycle — get current cycle status (all users)
router.get('/cycle', (req, res) => {
  let s = db.prepare('SELECT * FROM cycle_settings WHERE id=1').get();
  if (!s) s = {goal_setting_open:1, mid_year_open:0, year_end_open:0, cycle:'2026-27',
    gs_start:'2026-04-01', gs_end:'2026-04-30',
    mid_start:'2026-10-01', mid_end:'2026-10-31',
    ye_start:'2027-03-15', ye_end:'2027-03-31'};

  // Auto-close only — never auto-open. HR must manually open each window.
  const today = new Date().toISOString().slice(0,10);
  let changed = false;
  if (s.gs_start && s.gs_end) {
    if (s.goal_setting_open && today > s.gs_end) { s.goal_setting_open = 0; changed = true; }
  }
  if (s.mid_start && s.mid_end) {
    if (s.mid_year_open && today > s.mid_end) { s.mid_year_open = 0; changed = true; }
  }
  if (s.ye_start && s.ye_end) {
    if (s.year_end_open && today > s.ye_end) { s.year_end_open = 0; changed = true; }
  }
  if (changed) {
    db.prepare('UPDATE cycle_settings SET goal_setting_open=?, mid_year_open=?, year_end_open=?, updated_at=? WHERE id=1')
      .run(s.goal_setting_open, s.mid_year_open, s.year_end_open, Math.floor(Date.now()/1000));
  }
  res.json(s);
});

// PUT /api/cycle — HR updates cycle windows + date ranges
router.put('/cycle', requireHR, (req, res) => {
  const {
    goal_setting_open, mid_year_open, year_end_open,
    gs_start, gs_end, mid_start, mid_end, ye_start, ye_end,
    gs_note, mid_note, ye_note
  } = req.body;
  const now = Math.floor(Date.now()/1000);
  db.prepare(`UPDATE cycle_settings SET
    goal_setting_open=?, mid_year_open=?, year_end_open=?,
    gs_start=COALESCE(?,gs_start), gs_end=COALESCE(?,gs_end),
    mid_start=COALESCE(?,mid_start), mid_end=COALESCE(?,mid_end),
    ye_start=COALESCE(?,ye_start), ye_end=COALESCE(?,ye_end),
    gs_note=COALESCE(?,gs_note), mid_note=COALESCE(?,mid_note), ye_note=COALESCE(?,ye_note),
    updated_at=?, updated_by=?
    WHERE id=1`).run(
    goal_setting_open?1:0, mid_year_open?1:0, year_end_open?1:0,
    gs_start||null, gs_end||null, mid_start||null, mid_end||null,
    ye_start||null, ye_end||null,
    gs_note||null, mid_note||null, ye_note||null,
    now, req.user.emp_no
  );
  db.logAudit(req.user.id, 'cycle_updated', 'cycle', 1,
    {goal_setting_open, mid_year_open, year_end_open, gs_start, gs_end}, req.ip);
  res.json({success:true});
});

// ════════════════════════════════════════════════════════════
// DEVELOPMENT GOALS
// ════════════════════════════════════════════════════════════
router.get('/goals/:empNo/dev-goals', (req, res) => {
  const sheet = db.prepare('SELECT id FROM goal_sheets WHERE emp_no=? AND cycle=?').get(parseInt(req.params.empNo), CYCLE);
  if (!sheet) return res.json([]);
  res.json(db.prepare('SELECT * FROM dev_goals WHERE sheet_id=? ORDER BY id').all(sheet.id));
});

router.post('/goals/:empNo/dev-goals', (req, res) => {
  const empNo = parseInt(req.params.empNo);
  if (req.user.emp_no !== empNo && req.user.role !== 'hr_admin') {
    return res.status(403).json({error:'Access denied'});
  }
  const sheet = db.prepare('SELECT * FROM goal_sheets WHERE emp_no=? AND cycle=?').get(empNo, CYCLE);
  if (!sheet) return res.status(404).json({error:'No goal sheet found'});
  if (sheet.status === 'approved' && req.user.role !== 'hr_admin' && req.user.emp_no !== sheet.approved_by) {
    return res.status(400).json({error:'Goals are locked. Contact your supervisor or HR to amend.'});
  }
  const { goals } = req.body; // array of {goal_text, target_date}
  db.prepare('DELETE FROM dev_goals WHERE sheet_id=?').run(sheet.id);
  const ins = db.prepare('INSERT INTO dev_goals(sheet_id,goal_text,target_date) VALUES(?,?,?)');
  (goals||[]).forEach(g => ins.run(sheet.id, g.goal_text, g.target_date||null));
  db.saveToDisk();
  res.json({success:true});
});

// ════════════════════════════════════════════════════════════
// COMPETENCY RATINGS
// ════════════════════════════════════════════════════════════
const COMPETENCIES = [
  {id:1, name:'Service Delivery & Customer Experience',          def:'Delivers consistent, high-quality service aligned with brand standards, ensuring seamless end-to-end customer experience.'},
  {id:2, name:'Operational Excellence & Attention to Detail',    def:'Executes tasks with precision, accuracy, and adherence to processes to ensure error-free service delivery.'},
  {id:3, name:'Communication & Stakeholder Handling',            def:'Communicates clearly and professionally while managing relationships with customers, agents, suppliers, and internal teams.'},
  {id:4, name:'Problem Solving & Service Recovery',              def:'Identifies issues quickly and takes effective action to resolve them while minimising customer and business impact.'},
  {id:5, name:'Ownership, Responsiveness & Execution Discipline',def:'Takes accountability for tasks, responds promptly, and ensures timely completion of responsibilities.'},
  {id:6, name:'Commercial & Business Awareness',                 def:'Understands the financial and operational impact of decisions and contributes to revenue growth and cost efficiency.'},
];

router.get('/competencies', (req, res) => res.json(COMPETENCIES));

router.get('/goals/:empNo/competency-ratings', (req, res) => {
  const sheet = db.prepare('SELECT id FROM goal_sheets WHERE emp_no=? AND cycle=?').get(parseInt(req.params.empNo), CYCLE);
  if (!sheet) return res.json([]);
  res.json(db.prepare('SELECT * FROM competency_ratings WHERE sheet_id=? ORDER BY competency_id').all(sheet.id));
});

router.post('/goals/:empNo/competency-ratings', (req, res) => {
  const empNo = parseInt(req.params.empNo);
  const sheet = db.prepare('SELECT id FROM goal_sheets WHERE emp_no=? AND cycle=?').get(empNo, CYCLE);
  if (!sheet) return res.status(404).json({error:'No goal sheet'});
  const { ratings, review_type } = req.body; // [{competency_id, self_rating, self_comment, mgr_rating, mgr_comment}]
  const upsert = db.prepare(`INSERT INTO competency_ratings(sheet_id,competency_id,review_type,self_rating,mgr_rating,self_comment,mgr_comment,updated_at)
    VALUES(?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`);
  const upd = db.prepare(`UPDATE competency_ratings SET self_rating=COALESCE(?,self_rating), mgr_rating=COALESCE(?,mgr_rating), self_comment=COALESCE(?,self_comment), mgr_comment=COALESCE(?,mgr_comment), updated_at=? WHERE sheet_id=? AND competency_id=? AND review_type=?`);
  const now = Math.floor(Date.now()/1000);
  (ratings||[]).forEach(r => {
    const existing = db.prepare('SELECT id FROM competency_ratings WHERE sheet_id=? AND competency_id=? AND review_type=?').get(sheet.id, r.competency_id, review_type||'year_end');
    if (existing) {
      upd.run(r.self_rating||null, r.mgr_rating||null, r.self_comment||null, r.mgr_comment||null, now, sheet.id, r.competency_id, review_type||'year_end');
    } else {
      try { upsert.run(sheet.id, r.competency_id, review_type||'year_end', r.self_rating||null, r.mgr_rating||null, r.self_comment||null, r.mgr_comment||null, now); } catch(e){}
    }
  });
  db.saveToDisk();
  res.json({success:true});
});

// ════════════════════════════════════════════════════════════
// CAREER ASPIRATIONS
// ════════════════════════════════════════════════════════════
router.get('/goals/:empNo/career-aspiration', (req, res) => {
  const sheet = db.prepare('SELECT id FROM goal_sheets WHERE emp_no=? AND cycle=?').get(parseInt(req.params.empNo), CYCLE);
  if (!sheet) return res.json(null);
  res.json(db.prepare('SELECT * FROM career_aspirations WHERE sheet_id=? ORDER BY id DESC LIMIT 1').get(sheet.id) || null);
});

router.post('/goals/:empNo/career-aspiration', (req, res) => {
  const empNo = parseInt(req.params.empNo);
  const sheet = db.prepare('SELECT id FROM goal_sheets WHERE emp_no=? AND cycle=?').get(empNo, CYCLE);
  if (!sheet) return res.status(404).json({error:'No goal sheet'});
  const { aspiration, timeline_years } = req.body;
  db.prepare('DELETE FROM career_aspirations WHERE sheet_id=?').run(sheet.id);
  db.prepare('INSERT INTO career_aspirations(sheet_id,aspiration,timeline_years) VALUES(?,?,?)').run(sheet.id, aspiration, timeline_years||null);
  db.saveToDisk();
  res.json({success:true});
});

// ════════════════════════════════════════════════════════════
// ENHANCED REVIEW SUBMIT — includes employee comments, promo recommendation
// ════════════════════════════════════════════════════════════
router.post('/reviews/:empNo/submit-self-full', (req, res) => {
  const empNo = parseInt(req.params.empNo);
  if (req.user.emp_no !== empNo) return res.status(403).json({error:'Can only submit your own review.'});
  const { review_type, went_well, improve, support, employee_comments } = req.body;
  const sheet = db.prepare('SELECT * FROM goal_sheets WHERE emp_no=? AND cycle=?').get(empNo, CYCLE);
  if (!sheet || sheet.status !== 'approved') return res.status(400).json({error:'No approved goal sheet.'});
  const now = Math.floor(Date.now()/1000);
  const scores = computeScores(sheet.id);
  try {
    const existing = db.prepare('SELECT * FROM reviews WHERE sheet_id=? AND review_type=?').get(sheet.id, review_type);
    if (existing) {
      try {
        db.prepare(`UPDATE reviews SET self_went_well=?,self_improve=?,self_support_needed=?,employee_comments=?,self_submitted_at=?,status='self_submitted',overall_score=?,system_rating=?,updated_at=? WHERE id=?`)
          .run(went_well,improve,support,employee_comments,now,scores.overall,scores.rating,now,existing.id);
      } catch(e) {
        // employee_comments column may not exist in older DB
        db.prepare(`UPDATE reviews SET self_went_well=?,self_improve=?,self_support_needed=?,self_submitted_at=?,status='self_submitted',overall_score=?,system_rating=?,updated_at=? WHERE id=?`)
          .run(went_well,improve,support,now,scores.overall,scores.rating,now,existing.id);
      }
    } else {
      try {
        db.prepare(`INSERT INTO reviews(sheet_id,review_type,status,self_went_well,self_improve,self_support_needed,employee_comments,self_submitted_at,overall_score,system_rating,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(sheet.id,review_type,'self_submitted',went_well,improve,support,employee_comments,now,scores.overall,scores.rating,now,now);
      } catch(e) {
        db.prepare(`INSERT INTO reviews(sheet_id,review_type,status,self_went_well,self_improve,self_support_needed,self_submitted_at,overall_score,system_rating,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
          .run(sheet.id,review_type,'self_submitted',went_well,improve,support,now,scores.overall,scores.rating,now,now);
      }
    }
  } catch(err) {
    console.error('Submit review error:', err);
    return res.status(500).json({error:'Failed to submit review: ' + err.message});
  }
  db.logAudit(req.user.id,'self_review_submitted','review',sheet.id,{review_type},req.ip);

  // Notify supervisor that employee has submitted their self-review
  try {
    const emp = db.prepare('SELECT name, reports_to FROM users WHERE emp_no=?').get(empNo);
    if (emp && emp.reports_to) {
      const supervisor = db.prepare('SELECT emp_no, email FROM users WHERE emp_no=?').get(emp.reports_to);
      if (supervisor) {
        const phaseName = review_type === 'mid_year' ? 'Mid-Year Review' : 'Year-End Review';
        // Count pending reviews for this supervisor
        const pendingCount = db.prepare(`
          SELECT COUNT(*) as n FROM reviews r
          JOIN goal_sheets gs ON gs.id=r.sheet_id
          JOIN users u ON u.emp_no=gs.emp_no
          WHERE u.reports_to=? AND r.review_type=? AND r.self_submitted_at IS NOT NULL AND r.mgr_submitted_at IS NULL
        `).get(emp.reports_to, review_type);
        notify(db, 'goals_pending_approval', [supervisor], {
          count: pendingCount ? pendingCount.n : 1,
          names: [emp.name + ' (' + phaseName + ')']
        }).catch(()=>{});
      }
    }
  } catch(e) { /* non-critical */ }

  res.json({success:true, scores});
});

router.post('/reviews/:empNo/manager-review-full', (req, res) => {
  const empNo = parseInt(req.params.empNo);
  const emp = db.prepare('SELECT reports_to FROM users WHERE emp_no=?').get(empNo);
  if (req.user.role !== 'hr_admin' && emp?.reports_to !== req.user.emp_no) {
    return res.status(403).json({error:'Only the direct supervisor or HR can submit this review.'});
  }
  const { review_type, comments, strengths, develop, supervisor_agrees, supervisor_comments_review, promo_recommended, promo_justification } = req.body;
  const sheet = db.prepare('SELECT * FROM goal_sheets WHERE emp_no=? AND cycle=?').get(empNo, CYCLE);
  if (!sheet) return res.status(404).json({error:'No goal sheet found.'});

  // GUARD 1: Goals must be approved before any review
  if (sheet.status !== 'approved') {
    return res.status(400).json({error:'Goals must be approved before the manager review can be submitted.'});
  }

  // GUARD 2: Employee must have submitted their self-assessment first (HR can bypass)
  if (req.user.role !== 'hr_admin') {
    const empReview = db.prepare('SELECT self_submitted_at FROM reviews WHERE sheet_id=? AND review_type=?').get(sheet.id, review_type);
    if (!empReview || !empReview.self_submitted_at) {
      return res.status(400).json({error:'The employee must submit their self-assessment before the supervisor review can be submitted.'});
    }
  }

  const now = Math.floor(Date.now()/1000);
  const scores = computeScores(sheet.id);
  try {
    const existing = db.prepare('SELECT * FROM reviews WHERE sheet_id=? AND review_type=?').get(sheet.id, review_type);
    if (existing) {
      try {
        db.prepare(`UPDATE reviews SET mgr_comments=?,mgr_strengths=?,mgr_develop=?,supervisor_agrees=?,supervisor_comments_review=?,promo_recommended=?,promo_justification=?,mgr_submitted_at=?,mgr_reviewed_by=?,status='mgr_submitted',overall_score=?,system_rating=?,final_rating=?,updated_at=? WHERE id=?`)
          .run(comments,strengths,develop,supervisor_agrees?1:0,supervisor_comments_review,promo_recommended?1:0,promo_justification,now,req.user.emp_no,scores.overall,scores.rating,scores.rating,now,existing.id);
      } catch(e) {
        db.prepare(`UPDATE reviews SET mgr_comments=?,mgr_strengths=?,mgr_develop=?,mgr_submitted_at=?,mgr_reviewed_by=?,status='mgr_submitted',overall_score=?,system_rating=?,final_rating=?,updated_at=? WHERE id=?`)
          .run(comments,strengths,develop,now,req.user.emp_no,scores.overall,scores.rating,scores.rating,now,existing.id);
      }
    } else {
      try {
        db.prepare(`INSERT INTO reviews(sheet_id,review_type,status,mgr_comments,mgr_strengths,mgr_develop,supervisor_agrees,supervisor_comments_review,promo_recommended,promo_justification,mgr_submitted_at,mgr_reviewed_by,overall_score,system_rating,final_rating,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(sheet.id,review_type,'mgr_submitted',comments,strengths,develop,supervisor_agrees?1:0,supervisor_comments_review,promo_recommended?1:0,promo_justification,now,req.user.emp_no,scores.overall,scores.rating,scores.rating,now,now);
      } catch(e) {
        db.prepare(`INSERT INTO reviews(sheet_id,review_type,status,mgr_comments,mgr_strengths,mgr_develop,mgr_submitted_at,mgr_reviewed_by,overall_score,system_rating,final_rating,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(sheet.id,review_type,'mgr_submitted',comments,strengths,develop,now,req.user.emp_no,scores.overall,scores.rating,scores.rating,now,now);
      }
    }
  } catch(err) {
    console.error('Manager review error:', err);
    return res.status(500).json({error:'Failed to submit review: ' + err.message});
  }
  db.logAudit(req.user.id,'mgr_review_submitted','review',sheet.id,{review_type},req.ip);
  res.json({success:true, scores});
});

// ════════════════════════════════════════════════════════════
// MONTHLY PROGRESS TRACKER
// ════════════════════════════════════════════════════════════

const FY_START_MONTH = 4; // April = month 1 of FY
const MONTHLY_TARGET = 8.5; // % per month

// Helper: get FY month number (1=Apr, 2=May, ... 12=Mar) from calendar month (1-12)
function fyMonth(calMonth) {
  return calMonth >= FY_START_MONTH
    ? calMonth - FY_START_MONTH + 1
    : calMonth + (12 - FY_START_MONTH) + 1;
}

// GET /api/monthly-progress/:empNo — get all monthly entries for employee
router.get('/monthly-progress/:empNo', (req, res) => {
  const empNo = parseInt(req.params.empNo);
  if (!canAccessEmployee(req.user, empNo)) return res.status(403).json({error:'Access denied.'});
  const sheet = db.prepare('SELECT * FROM goal_sheets WHERE emp_no=? AND cycle=?').get(empNo, CYCLE);
  if (!sheet) return res.json({entries:[], sheet:null});
  const entries = db.prepare('SELECT * FROM monthly_progress WHERE sheet_id=? AND fy_year=? ORDER BY month ASC, kpi_id ASC').all(sheet.id, CYCLE);
  res.json({entries, sheet_id: sheet.id});
});

// POST /api/monthly-progress/:empNo — save monthly entries for a given month
router.post('/monthly-progress/:empNo', (req, res) => {
  const empNo = parseInt(req.params.empNo);
  if (req.user.emp_no !== empNo) return res.status(403).json({error:'Can only enter your own progress.'});
  const sheet = db.prepare('SELECT * FROM goal_sheets WHERE emp_no=? AND cycle=?').get(empNo, CYCLE);
  if (!sheet || sheet.status !== 'approved') return res.status(400).json({error:'No approved goal sheet found.'});

  const { month, entries } = req.body; // month = FY month 1-12, entries = [{kpi_id, increment_ach, notes}]
  if (!month || month < 1 || month > 12) return res.status(400).json({error:'Invalid month.'});

  // Check if mid-year submitted — lock months 1-6
  const midRev = db.prepare("SELECT self_submitted_at FROM reviews WHERE sheet_id=? AND review_type='mid_year'").get(sheet.id);
  if (midRev?.self_submitted_at && month <= 6) {
    return res.status(400).json({error:'Months 1–6 are locked after mid-year review submission.'});
  }
  // Check if year-end submitted — lock months 7-12
  const yeRev = db.prepare("SELECT self_submitted_at FROM reviews WHERE sheet_id=? AND review_type='year_end'").get(sheet.id);
  if (yeRev?.self_submitted_at && month >= 7) {
    return res.status(400).json({error:'Months 7–12 are locked after year-end review submission.'});
  }

  const now = Math.floor(Date.now()/1000);
  let saved = 0;
  (entries||[]).forEach(e => {
    const existing = db.prepare('SELECT id FROM monthly_progress WHERE sheet_id=? AND kpi_id=? AND month=? AND fy_year=?').get(sheet.id, e.kpi_id, month, CYCLE);
    if (existing) {
      db.prepare('UPDATE monthly_progress SET increment_ach=?,notes=?,updated_at=? WHERE id=?')
        .run(e.increment_ach!=null?parseFloat(e.increment_ach):null, e.notes||null, now, existing.id);
    } else {
      db.prepare('INSERT INTO monthly_progress(sheet_id,kpi_id,month,fy_year,increment_ach,notes,entered_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
        .run(sheet.id, e.kpi_id, month, CYCLE, e.increment_ach!=null?parseFloat(e.increment_ach):null, e.notes||null, now, now);
    }
    saved++;
  });
  db.logAudit(req.user.id,'monthly_progress_saved','goal_sheet',sheet.id,{month,saved},req.ip);
  res.json({success:true, saved});
});

router.post('/reviews/:empNo/manager-save', (req, res) => {
  const empNo = parseInt(req.params.empNo);
  const emp = db.prepare('SELECT reports_to FROM users WHERE emp_no=?').get(empNo);
  if (req.user.role !== 'hr_admin' && emp?.reports_to !== req.user.emp_no) {
    return res.status(403).json({error:'Only the direct supervisor or HR can save this review.'});
  }
  const { review_type, comments, strengths, develop, supervisor_agrees, supervisor_comments_review, promo_recommended, promo_justification } = req.body;
  const sheet = db.prepare('SELECT * FROM goal_sheets WHERE emp_no=? AND cycle=?').get(empNo, CYCLE);
  if (!sheet) return res.status(404).json({error:'No goal sheet found.'});
  const now = Math.floor(Date.now()/1000);
  const scores = computeScores(sheet.id);
  const existing = db.prepare('SELECT * FROM reviews WHERE sheet_id=? AND review_type=?').get(sheet.id, review_type);
  if (existing) {
    // Only update comments fields, do NOT set mgr_submitted_at or change status to mgr_submitted
    db.prepare(`UPDATE reviews SET mgr_comments=?,mgr_strengths=?,mgr_develop=?,supervisor_agrees=?,supervisor_comments_review=?,promo_recommended=?,promo_justification=?,mgr_reviewed_by=?,updated_at=? WHERE id=?`)
      .run(comments,strengths,develop,supervisor_agrees?1:0,supervisor_comments_review,promo_recommended?1:0,promo_justification,req.user.emp_no,now,existing.id);
  } else {
    db.prepare(`INSERT INTO reviews(sheet_id,review_type,status,mgr_comments,mgr_strengths,mgr_develop,supervisor_agrees,supervisor_comments_review,promo_recommended,promo_justification,mgr_reviewed_by,overall_score,system_rating,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(sheet.id,review_type,'in_progress',comments,strengths,develop,supervisor_agrees?1:0,supervisor_comments_review,promo_recommended?1:0,promo_justification,req.user.emp_no,scores.overall,scores.rating,now,now);
  }
  db.logAudit(req.user.id,'mgr_review_saved','review',sheet.id,{review_type},req.ip);
  res.json({success:true});
});


// ════════════════════════════════════════════════════════════
// PHASE 2 — GOAL CHANGE REQUESTS
// ════════════════════════════════════════════════════════════

// GET /api/goals/:empNo/change-requests — list all change requests for an employee
router.get('/goals/:empNo/change-requests', (req, res) => {
  const empNo = parseInt(req.params.empNo);
  if (!canAccessEmployee(req.user, empNo)) return res.status(403).json({error:'Access denied.'});
  const reqs = db.prepare(`
    SELECT gcr.*, u.name as reviewed_by_name
    FROM goal_change_requests gcr
    LEFT JOIN users u ON u.emp_no = gcr.reviewed_by
    WHERE gcr.emp_no = ? AND gcr.cycle = ?
    ORDER BY gcr.requested_at DESC
  `).all(empNo, CYCLE);
  res.json(reqs);
});

// POST /api/goals/:empNo/change-requests — employee submits a change request
router.post('/goals/:empNo/change-requests', (req, res) => {
  const empNo = parseInt(req.params.empNo);
  if (req.user.emp_no !== empNo) return res.status(403).json({error:'Can only submit your own change request.'});
  const { reason } = req.body;
  if (!reason || !reason.trim()) return res.status(400).json({error:'Please provide a reason for the change request.'});
  const sheet = db.prepare('SELECT * FROM goal_sheets WHERE emp_no=? AND cycle=?').get(empNo, CYCLE);
  if (!sheet) return res.status(404).json({error:'No goal sheet found.'});
  if (!['approved','locked'].includes(sheet.status)) return res.status(400).json({error:'Goals must be approved before requesting changes.'});

  // Check no pending request already exists
  const pending = db.prepare("SELECT id FROM goal_change_requests WHERE emp_no=? AND cycle=? AND status='pending'").get(empNo, CYCLE);
  if (pending) return res.status(400).json({error:'You already have a pending change request. Please wait for it to be reviewed.'});

  // Snapshot current KRAs
  const kras = db.prepare('SELECT * FROM kras WHERE sheet_id=?').all(sheet.id);
  const krasWithKpis = kras.map(k => ({
    ...k,
    kpis: db.prepare('SELECT * FROM kpis WHERE kra_id=?').all(k.id)
  }));

  // Check if post mid-year
  const midRev = db.prepare("SELECT id FROM reviews WHERE sheet_id=? AND review_type='mid_year' AND self_submitted_at IS NOT NULL").get(sheet.id);
  const now = Math.floor(Date.now()/1000);

  db.prepare(`INSERT INTO goal_change_requests(sheet_id,emp_no,cycle,status,reason,kras_snapshot,is_post_midyear,requested_at,created_at,updated_at)
    VALUES(?,?,?,'pending',?,?,?,?,?,?)`)
    .run(sheet.id, empNo, CYCLE, reason.trim(), JSON.stringify(krasWithKpis), midRev?1:0, now, now, now);

  db.logAudit(req.user.id,'goal_change_requested','goal_sheet',sheet.id,{reason:reason.trim(), post_midyear:!!midRev},req.ip);

  // Notify supervisor + HR about the change request
  try {
    const emp = db.prepare('SELECT name, reports_to FROM users WHERE emp_no=?').get(empNo);
    const notifData = { emp_name: emp ? emp.name : 'Employee', reason: reason.trim(), post_midyear: !!midRev };
    if (emp && emp.reports_to) {
      const supervisor = db.prepare('SELECT emp_no, email FROM users WHERE emp_no=?').get(emp.reports_to);
      if (supervisor) notify(db, 'goal_change_requested', [supervisor], notifData).catch(()=>{});
    }
    // Always notify HR on post-mid-year changes
    if (midRev) {
      const hrUsers = db.prepare("SELECT emp_no, email FROM users WHERE role='hr_admin' AND is_active=1").all();
      notify(db, 'goal_change_requested', hrUsers, notifData).catch(()=>{});
    }
  } catch(e) { /* non-critical */ }

  res.json({success:true, post_midyear:!!midRev});
});

// POST /api/goals/:empNo/change-requests/:reqId/approve — supervisor/HR approves change request
// Option D: normal changes = supervisor approves, done.
//           post-mid-year = supervisor approves → status becomes 'pending_hr' → HR must confirm.
router.post('/goals/:empNo/change-requests/:reqId/approve', (req, res) => {
  const empNo = parseInt(req.params.empNo);
  const reqId = parseInt(req.params.reqId);
  const emp = db.prepare('SELECT reports_to FROM users WHERE emp_no=?').get(empNo);
  const isHRAdmin = req.user.role === 'hr_admin';
  const isSupervisor = emp?.reports_to === req.user.emp_no;
  if (!isHRAdmin && !isSupervisor) {
    return res.status(403).json({ error: 'Only the direct supervisor or HR can approve change requests.' });
  }
  const { comments } = req.body;
  const cr = db.prepare('SELECT * FROM goal_change_requests WHERE id=? AND emp_no=?').get(reqId, empNo);
  if (!cr) return res.status(404).json({ error: 'Change request not found.' });

  // HR can only act on pending_hr (post-mid-year awaiting HR sign-off)
  // Supervisor can only act on pending
  if (isHRAdmin && !isSupervisor) {
    if (cr.status !== 'pending_hr') {
      return res.status(400).json({ error: 'This request is not awaiting HR approval.' });
    }
  } else {
    if (cr.status !== 'pending') {
      return res.status(400).json({ error: 'This change request has already been reviewed.' });
    }
  }

  const now = Math.floor(Date.now()/1000);

  // Post-mid-year + supervisor acting = move to pending_hr for HR sign-off
  if (cr.is_post_midyear && isSupervisor && !isHRAdmin) {
    db.prepare(`UPDATE goal_change_requests
      SET status='pending_hr', sup_approved_at=?, sup_approved_by=?, sup_comments=?, updated_at=?
      WHERE id=?`).run(now, req.user.emp_no, comments||'', now, reqId);

    db.logAudit(req.user.id,'goal_change_sup_approved','goal_sheet',cr.sheet_id,{req_id:reqId},req.ip);

    // Notify HR to complete sign-off
    try {
      const hrUsers = db.prepare("SELECT emp_no, email FROM users WHERE role='hr_admin' AND is_active=1").all();
      const empUser = db.prepare('SELECT name FROM users WHERE emp_no=?').get(empNo);
      notify(db, 'goal_change_requested', hrUsers, {
        emp_name: empUser?.name,
        reason: cr.reason,
        post_midyear: true,
        supervisor_approved: true
      }).catch(()=>{});
    } catch(e) {}

    return res.json({ success: true, pending_hr: true,
      message: 'Supervisor approved. This is a post-mid-year change — HR sign-off required before employee can edit.' });
  }

  // All other cases (normal change by supervisor, or HR approving pending_hr) = fully approved
  db.prepare("UPDATE goal_sheets SET status='approved',last_changed_at=?,change_count=COALESCE(change_count,0)+1,updated_at=? WHERE id=?")
    .run(now, now, cr.sheet_id);
  db.prepare(`UPDATE goal_change_requests
    SET status='approved', reviewed_at=?, reviewed_by=?, reviewer_comments=?, updated_at=? WHERE id=?`)
    .run(now, req.user.emp_no, comments||'', now, reqId);

  db.logAudit(req.user.id,'goal_change_approved','goal_sheet',cr.sheet_id,{req_id:reqId},req.ip);

  // Notify employee
  try {
    const empUser = db.prepare('SELECT emp_no, email FROM users WHERE emp_no=?').get(empNo);
    if (empUser) notify(db, 'goal_change_approved', [empUser], {}).catch(()=>{});
  } catch(e) {}

  res.json({ success: true, pending_hr: false });
});

// POST /api/goals/:empNo/change-requests/:reqId/reject — supervisor/HR rejects change request
router.post('/goals/:empNo/change-requests/:reqId/reject', (req, res) => {
  const empNo = parseInt(req.params.empNo);
  const reqId = parseInt(req.params.reqId);
  const emp = db.prepare('SELECT reports_to FROM users WHERE emp_no=?').get(empNo);
  if (req.user.role !== 'hr_admin' && emp?.reports_to !== req.user.emp_no) {
    return res.status(403).json({error:'Only the direct supervisor or HR can reject change requests.'});
  }
  const { comments } = req.body;
  if (!comments || !comments.trim()) return res.status(400).json({error:'Please provide a reason for rejecting the change request.'});
  const cr = db.prepare('SELECT * FROM goal_change_requests WHERE id=? AND emp_no=?').get(reqId, empNo);
  if (!cr) return res.status(404).json({error:'Change request not found.'});
  if (cr.status !== 'pending') return res.status(400).json({error:'This change request has already been reviewed.'});

  const now = Math.floor(Date.now()/1000);
  db.prepare(`UPDATE goal_change_requests SET status='rejected',reviewed_at=?,reviewed_by=?,reviewer_comments=?,updated_at=? WHERE id=?`)
    .run(now, req.user.emp_no, comments.trim(), now, reqId);

  db.logAudit(req.user.id,'goal_change_rejected','goal_sheet',cr.sheet_id,{req_id:reqId,reason:comments},req.ip);

  // Notify employee their change request was rejected
  try {
    const emp = db.prepare('SELECT emp_no, email FROM users WHERE emp_no=?').get(empNo);
    if (emp) notify(db, 'goal_change_rejected', [emp], {reason: comments}).catch(()=>{});
  } catch(e) {}

  res.json({success:true});
});

// GET /api/goals/change-requests/pending — HR gets all pending change requests
router.get('/goals/change-requests/pending', requireHR, (req, res) => {
  const reqs = db.prepare(`
    SELECT gcr.*, u.name as emp_name, u.designation, u.company,
           sup.name as supervisor_name, sup.emp_no as supervisor_emp_no,
           sa.name as sup_approved_by_name
    FROM goal_change_requests gcr
    JOIN users u ON u.emp_no = gcr.emp_no
    LEFT JOIN users sup ON sup.emp_no = u.reports_to
    LEFT JOIN users sa ON sa.emp_no = gcr.sup_approved_by
    WHERE gcr.cycle = ? AND gcr.status IN ('pending','pending_hr')
    ORDER BY gcr.status DESC, gcr.is_post_midyear DESC, gcr.requested_at ASC
  `).all(CYCLE);
  res.json(reqs);
});

// GET /api/goals/change-requests/all — HR gets full history of all change requests
router.get('/goals/change-requests/all', requireHR, (req, res) => {
  const reqs = db.prepare(`
    SELECT gcr.*, u.name as emp_name, u.designation, u.company,
           sup.name as supervisor_name,
           rev.name as reviewed_by_name,
           sa.name as sup_approved_by_name
    FROM goal_change_requests gcr
    JOIN users u ON u.emp_no = gcr.emp_no
    LEFT JOIN users sup ON sup.emp_no = u.reports_to
    LEFT JOIN users rev ON rev.emp_no = gcr.reviewed_by
    LEFT JOIN users sa ON sa.emp_no = gcr.sup_approved_by
    WHERE gcr.cycle = ?
    ORDER BY gcr.is_post_midyear DESC, gcr.requested_at DESC
  `).all(CYCLE);
  res.json(reqs);
});

// ════════════════════════════════════════════════════════════
// PHASE 2 — PROMOTIONS VIEW
// ════════════════════════════════════════════════════════════

// GET /api/promotions — all employees recommended for promotion with full details
router.get('/promotions', requireRole('senior_manager'), (req, res) => {
  const { company } = req.query;
  const params = [CYCLE];
  let sql, rows;

  // Try full query with new columns first, fall back if they don't exist yet
  try {
    sql = `
      SELECT u.emp_no, u.name, u.designation, u.grade, u.dept, u.company, u.cluster,
             r.overall_score, r.system_rating, r.final_rating,
             r.promo_recommended, r.promo_justification,
             r.promo_status, r.promo_decision_reason, r.promo_decision_at,
             r.self_went_well, r.self_improve, r.employee_comments,
             r.mgr_comments, r.mgr_strengths, r.mgr_develop,
             r.self_submitted_at, r.mgr_submitted_at, r.mgr_reviewed_by,
             sup.name as supervisor_name, sup.emp_no as supervisor_emp_no,
             dec.name as decided_by_name,
             gs.status as goal_status
      FROM users u
      JOIN goal_sheets gs ON gs.emp_no = u.emp_no AND gs.cycle = ?
      JOIN reviews r ON r.sheet_id = gs.id AND r.review_type = 'year_end'
      LEFT JOIN users sup ON sup.emp_no = u.reports_to
      LEFT JOIN users dec ON dec.emp_no = r.promo_decision_by
      WHERE u.is_active = 1 AND r.promo_recommended = 1`;
    if (company) { sql += ' AND u.company=?'; params.push(company); }
    sql += ' ORDER BY u.company, r.overall_score DESC';
    rows = db.prepare(sql).all(...params);
  } catch(e) {
    // Fallback without new columns (pre-migration)
    try {
      sql = `
        SELECT u.emp_no, u.name, u.designation, u.grade, u.dept, u.company, u.cluster,
               r.overall_score, r.system_rating, r.final_rating,
               r.promo_recommended, r.promo_justification,
               r.mgr_comments, r.mgr_strengths, r.mgr_develop,
               r.self_went_well, r.self_improve,
               sup.name as supervisor_name, sup.emp_no as supervisor_emp_no,
               gs.status as goal_status
        FROM users u
        JOIN goal_sheets gs ON gs.emp_no = u.emp_no AND gs.cycle = ?
        JOIN reviews r ON r.sheet_id = gs.id AND r.review_type = 'year_end'
        LEFT JOIN users sup ON sup.emp_no = u.reports_to
        WHERE u.is_active = 1 AND r.promo_recommended = 1`;
      const params2 = [CYCLE];
      if (company) { sql += ' AND u.company=?'; params2.push(company); }
      sql += ' ORDER BY u.company, r.overall_score DESC';
      rows = db.prepare(sql).all(...params2);
    } catch(e2) {
      rows = [];
    }
  }
  res.json(rows);
});

// POST /api/promotions/:empNo/decide — HR approves or rejects promotion recommendation
router.post('/promotions/:empNo/decide', requireHR, (req, res) => {
  const empNo = parseInt(req.params.empNo);
  const { decision, reason } = req.body; // decision: 'approved' | 'rejected'
  if (!['approved','rejected'].includes(decision)) {
    return res.status(400).json({error:'Decision must be approved or rejected.'});
  }
  if (decision === 'rejected' && (!reason||!reason.trim())) {
    return res.status(400).json({error:'A reason is required when rejecting a promotion.'});
  }
  const sheet = db.prepare('SELECT id FROM goal_sheets WHERE emp_no=? AND cycle=?').get(empNo, CYCLE);
  if (!sheet) return res.status(404).json({error:'No goal sheet found.'});
  const now = Math.floor(Date.now()/1000);
  try {
    db.prepare(`UPDATE reviews SET promo_status=?, promo_decision_by=?, promo_decision_at=?, promo_decision_reason=?, updated_at=? WHERE sheet_id=? AND review_type='year_end'`)
      .run(decision, req.user.emp_no, now, reason||null, now, sheet.id);
  } catch(e) {
    // columns not yet migrated — try minimal update
    try {
      db.prepare(`UPDATE reviews SET updated_at=? WHERE sheet_id=? AND review_type='year_end'`).run(now, sheet.id);
    } catch(e2) { /* ignore */ }
    return res.status(500).json({error:'DB columns not yet migrated. Please restart the server to apply migrations.'});
  }
  db.logAudit(req.user.id, 'promotion_'+decision, 'review', sheet.id, {empNo, reason}, req.ip);
  res.json({success:true});
});

// ════════════════════════════════════════════════════════════
// PHASE 2 — HISTORICAL PERFORMANCE
// ════════════════════════════════════════════════════════════

// GET /api/performance/history/:empNo — get all cycles' data for an employee
router.get('/performance/history/:empNo', (req, res) => {
  const empNo = parseInt(req.params.empNo);
  if (!canAccessEmployee(req.user, empNo)) return res.status(403).json({error:'Access denied.'});

  const sheets = db.prepare(`
    SELECT gs.id, gs.cycle, gs.status, gs.approved_at,
           r_mid.overall_score as mid_score, r_mid.system_rating as mid_rating,
           r_mid.self_went_well as mid_went_well, r_mid.self_improve as mid_improve,
           r_mid.mgr_comments as mid_mgr_comments,
           r_ye.overall_score as ye_score, r_ye.system_rating as ye_rating,
           r_ye.final_rating, r_ye.self_went_well as ye_went_well,
           r_ye.mgr_comments as ye_mgr_comments,
           r_ye.promo_recommended, r_ye.mgr_reviewed_by
    FROM goal_sheets gs
    LEFT JOIN reviews r_mid ON r_mid.sheet_id = gs.id AND r_mid.review_type = 'mid_year'
    LEFT JOIN reviews r_ye ON r_ye.sheet_id = gs.id AND r_ye.review_type = 'year_end'
    WHERE gs.emp_no = ?
    ORDER BY gs.cycle DESC
  `).all(empNo);

  // For each sheet, get KRA/KPI structure
  const history = sheets.map(s => {
    const kras = db.prepare('SELECT * FROM kras WHERE sheet_id=?').all(s.id);
    return {
      ...s,
      kras: kras.map(k => ({
        ...k,
        kpis: db.prepare('SELECT * FROM kpis WHERE kra_id=?').all(k.id)
      }))
    };
  });

  res.json(history);
});

// GET /api/export/my-history — employee downloads their own performance history
router.get('/export/my-history', (req, res) => {
  const empNo = req.user.emp_no;
  const sheets = db.prepare(`
    SELECT gs.id, gs.cycle, gs.status,
           r_mid.overall_score as mid_score, r_mid.system_rating as mid_rating,
           r_mid.self_went_well as mid_went_well, r_mid.self_improve as mid_improve,
           r_mid.mgr_comments as mid_mgr_comments,
           r_ye.overall_score as ye_score, r_ye.system_rating as ye_rating,
           r_ye.final_rating, r_ye.self_went_well as ye_went_well,
           r_ye.mgr_comments as ye_mgr_comments
    FROM goal_sheets gs
    LEFT JOIN reviews r_mid ON r_mid.sheet_id=gs.id AND r_mid.review_type='mid_year'
    LEFT JOIN reviews r_ye ON r_ye.sheet_id=gs.id AND r_ye.review_type='year_end'
    WHERE gs.emp_no=? ORDER BY gs.cycle DESC
  `).all(empNo);

  const user = db.prepare('SELECT name, designation, company FROM users WHERE emp_no=?').get(empNo);
  let csv = `Performance History - ${user?.name||''} (${empNo})\r\n`;
  csv += `Company: ${user?.company||''} | Designation: ${user?.designation||''}\r\n\r\n`;
  csv += 'Cycle,Mid-Year Score,Mid Rating,YE Score,Final Rating,Mid - What Went Well,Mid - Improve,YE - What Went Well,Supervisor Comments\r\n';

  sheets.forEach(s => {
    csv += [s.cycle, s.mid_score||'', s.mid_rating||'', s.ye_score||'', s.final_rating||s.ye_rating||'',
      '"'+(s.mid_went_well||'').replace(/"/g,'""')+'"',
      '"'+(s.mid_improve||'').replace(/"/g,'""')+'"',
      '"'+(s.ye_went_well||'').replace(/"/g,'""')+'"',
      '"'+(s.ye_mgr_comments||'').replace(/"/g,'""')+'"'
    ].join(',')+'\r\n';
  });

  res.setHeader('Content-Type','text/csv');
  res.setHeader('Content-Disposition','attachment; filename="my-performance-history.csv"');
  res.send(csv);
});

// GET /api/performance/org-summary — organisation performance summary across cycles (HR/EXCO)
router.get('/performance/org-summary', (req, res) => {
  if (req.user.role !== 'hr_admin' && ROLE_LEVELS[req.user.role] < ROLE_LEVELS['exco']) {
    return res.status(403).json({error:'Access denied.'});
  }
  const cycles = db.prepare('SELECT DISTINCT cycle FROM goal_sheets ORDER BY cycle DESC').all();
  const summary = cycles.map(c => {
    const stats = db.prepare(`
      SELECT
        COUNT(DISTINCT u.emp_no) as total,
        SUM(CASE WHEN gs.status='approved' THEN 1 ELSE 0 END) as goals_approved,
        SUM(CASE WHEN r_ye.system_rating='A' THEN 1 ELSE 0 END) as rating_a,
        SUM(CASE WHEN r_ye.system_rating='B' THEN 1 ELSE 0 END) as rating_b,
        SUM(CASE WHEN r_ye.system_rating='C' THEN 1 ELSE 0 END) as rating_c,
        SUM(CASE WHEN r_ye.system_rating='D' THEN 1 ELSE 0 END) as rating_d,
        SUM(CASE WHEN r_ye.system_rating='E' THEN 1 ELSE 0 END) as rating_e,
        AVG(r_ye.overall_score) as avg_score,
        SUM(CASE WHEN r_ye.promo_recommended=1 THEN 1 ELSE 0 END) as promoted
      FROM users u
      LEFT JOIN goal_sheets gs ON gs.emp_no=u.emp_no AND gs.cycle=?
      LEFT JOIN reviews r_ye ON r_ye.sheet_id=gs.id AND r_ye.review_type='year_end'
      WHERE u.is_active=1 AND u.role!='hr_admin'
    `).get(c.cycle);
    return { cycle: c.cycle, ...stats };
  });
  res.json(summary);
});

// ════════════════════════════════════════════════════════════
// PHASE 2 — ADMIN STATS (used by HR Dashboard and Reports)
// ════════════════════════════════════════════════════════════

router.get('/stats', requireReportsAccess, (req, res) => {
  const sbuCos = getSbuCompanies(req.user);
  const { clause, params: sp } = companyScope(sbuCos, []);

  const totalQ = `SELECT COUNT(*) as n FROM users u WHERE u.is_active=1${clause}`;
  const total = sp.length ? db.prepare(totalQ).get(...sp).n : db.prepare(totalQ).get().n;

  // HR-only fields
  const activated  = req.user.role === 'hr_admin'
    ? db.prepare("SELECT COUNT(*) as n FROM users WHERE is_active=1 AND last_login IS NOT NULL").get().n : null;
  const totalNonHR = req.user.role === 'hr_admin'
    ? db.prepare("SELECT COUNT(*) as n FROM users WHERE is_active=1 AND role!='hr_admin'").get().n : null;
  const onlineNow  = req.user.role === 'hr_admin'
    ? db.prepare("SELECT COUNT(DISTINCT user_id) as n FROM sessions WHERE expires_at > ?").get(Math.floor(Date.now()/1000)).n : null;

  const goalStats = db.prepare(`
    SELECT gs.status, COUNT(*) as n FROM goal_sheets gs
    JOIN users u ON u.emp_no=gs.emp_no
    WHERE gs.cycle=? AND u.is_active=1${clause}
    GROUP BY gs.status
  `).all(CYCLE, ...sp);

  const midStats = db.prepare(`
    SELECT
      SUM(CASE WHEN r.self_submitted_at IS NOT NULL THEN 1 ELSE 0 END) as self_submitted,
      SUM(CASE WHEN r.mgr_submitted_at IS NOT NULL THEN 1 ELSE 0 END) as mgr_submitted
    FROM reviews r
    JOIN goal_sheets gs ON gs.id=r.sheet_id
    JOIN users u ON u.emp_no=gs.emp_no
    WHERE r.review_type='mid_year' AND gs.cycle=?${clause}
  `).get(CYCLE, ...sp);

  const yeStats = db.prepare(`
    SELECT
      SUM(CASE WHEN r.self_submitted_at IS NOT NULL THEN 1 ELSE 0 END) as self_submitted,
      SUM(CASE WHEN r.mgr_submitted_at IS NOT NULL THEN 1 ELSE 0 END) as mgr_submitted
    FROM reviews r
    JOIN goal_sheets gs ON gs.id=r.sheet_id
    JOIN users u ON u.emp_no=gs.emp_no
    WHERE r.review_type='year_end' AND gs.cycle=?${clause}
  `).get(CYCLE, ...sp);

  const midDist = db.prepare(`
    SELECT r.system_rating, COUNT(*) as n FROM reviews r
    JOIN goal_sheets gs ON gs.id=r.sheet_id
    JOIN users u ON u.emp_no=gs.emp_no
    WHERE r.review_type='mid_year' AND gs.cycle=? AND r.system_rating IS NOT NULL${clause}
    GROUP BY r.system_rating
  `).all(CYCLE, ...sp);

  const yeDist = db.prepare(`
    SELECT r.system_rating, COUNT(*) as n FROM reviews r
    JOIN goal_sheets gs ON gs.id=r.sheet_id
    JOIN users u ON u.emp_no=gs.emp_no
    WHERE r.review_type='year_end' AND gs.cycle=? AND r.system_rating IS NOT NULL${clause}
    GROUP BY r.system_rating
  `).all(CYCLE, ...sp);

  const byCompany = db.prepare(`
    SELECT u.company, u.cluster, COUNT(*) as n,
      SUM(CASE WHEN gs.status='approved' THEN 1 ELSE 0 END) as approved_n,
      SUM(CASE WHEN gs.status='submitted' THEN 1 ELSE 0 END) as submitted_n,
      SUM(CASE WHEN gs.status='draft' THEN 1 ELSE 0 END) as draft_n,
      SUM(CASE WHEN r_mid.self_submitted_at IS NOT NULL THEN 1 ELSE 0 END) as mid_submitted_n,
      SUM(CASE WHEN r_mid.mgr_submitted_at IS NOT NULL THEN 1 ELSE 0 END) as mid_mgr_n,
      SUM(CASE WHEN r_ye.self_submitted_at IS NOT NULL THEN 1 ELSE 0 END) as ye_submitted_n,
      SUM(CASE WHEN r_ye.mgr_submitted_at IS NOT NULL THEN 1 ELSE 0 END) as ye_mgr_n,
      SUM(CASE WHEN u.last_login IS NOT NULL THEN 1 ELSE 0 END) as activated_n
    FROM users u
    LEFT JOIN goal_sheets gs ON gs.emp_no=u.emp_no AND gs.cycle=?
    LEFT JOIN reviews r_mid ON r_mid.sheet_id=gs.id AND r_mid.review_type='mid_year'
    LEFT JOIN reviews r_ye ON r_ye.sheet_id=gs.id AND r_ye.review_type='year_end'
    WHERE u.is_active=1${clause}
    GROUP BY u.company ORDER BY u.cluster, u.company
  `).all(CYCLE, ...sp);

  const pendingChanges = req.user.role === 'hr_admin'
    ? db.prepare("SELECT COUNT(*) as n FROM goal_change_requests WHERE cycle=? AND status IN ('pending','pending_hr')").get(CYCLE).n : 0;

  res.json({
    total_users: total,
    total_non_hr: totalNonHR,
    activated,
    not_activated: activated !== null ? total - activated : null,
    online_now: onlineNow,
    goal_stats: goalStats,
    mid_year: midStats,
    year_end: yeStats,
    mid_dist: midDist,
    ye_dist: yeDist,
    by_company: byCompany,
    pending_changes: pendingChanges
  });
});

// GET /api/export/calibration-sheet — individual calibration data, optional ?company= filter
router.get('/export/calibration-sheet', requireReportsAccess, (req, res) => {
  const { company } = req.query;
  let sql = `SELECT u.emp_no, u.name, u.designation, u.grade, u.dept, u.company, u.cluster,
    r.overall_score, r.system_rating, r.override_rating, r.final_rating,
    r.precal_adjusted, sup.name as supervisor_name
    FROM users u
    LEFT JOIN goal_sheets gs ON gs.emp_no=u.emp_no AND gs.cycle=?
    LEFT JOIN reviews r ON r.sheet_id=gs.id AND r.review_type='year_end'
    LEFT JOIN users sup ON sup.emp_no=u.reports_to
    WHERE u.is_active=1 AND u.role!='hr_admin'`;
  const params=[CYCLE];
  if(company){sql+=' AND u.company=?';params.push(company);}
  sql+=' ORDER BY u.company, u.name';
  const rows=db.prepare(sql).all(...params);
  const ratingLabel={A:'Exceptional',B:'Strong',C:'Competent',D:'Inconsistent',E:'Below Expectations'};
  let csv='Emp No,Name,Designation,Grade,Department,Company,Cluster,Supervisor,Score,System Rating,Rating Label,Override Rating,Final Rating,Pre-Cal Adjusted\r\n';
  rows.forEach(r=>{
    const fr=r.final_rating||r.system_rating||'';
    csv+=[r.emp_no,r.name,r.designation||'',r.grade||'',r.dept||'',r.company,r.cluster||'',
      r.supervisor_name||'',r.overall_score||'',r.system_rating||'',ratingLabel[r.system_rating]||'',
      r.override_rating||'',fr,ratingLabel[fr]||'',r.precal_adjusted?'Yes':'No'].join(',')+'\r\n';
  });
  const slug=company?company.replace(/[^a-z0-9]+/gi,'-').toLowerCase():'all';
  res.setHeader('Content-Type','text/csv');
  res.setHeader('Content-Disposition',`attachment; filename="calibration-${slug}-${CYCLE}.csv"`);
  res.send(csv);
});

// GET /api/export/calibration-by-company — rating distribution by company
router.get('/export/calibration-by-company', requireReportsAccess, (req, res) => {  const rows = db.prepare(`
    SELECT u.company, u.cluster,
      COUNT(*) as total,
      SUM(CASE WHEN (r.final_rating='A' OR (r.final_rating IS NULL AND r.system_rating='A')) THEN 1 ELSE 0 END) as a_count,
      SUM(CASE WHEN (r.final_rating='B' OR (r.final_rating IS NULL AND r.system_rating='B')) THEN 1 ELSE 0 END) as b_count,
      SUM(CASE WHEN (r.final_rating='C' OR (r.final_rating IS NULL AND r.system_rating='C')) THEN 1 ELSE 0 END) as c_count,
      SUM(CASE WHEN (r.final_rating='D' OR (r.final_rating IS NULL AND r.system_rating='D')) THEN 1 ELSE 0 END) as d_count,
      SUM(CASE WHEN (r.final_rating='E' OR (r.final_rating IS NULL AND r.system_rating='E')) THEN 1 ELSE 0 END) as e_count,
      AVG(r.overall_score) as avg_score
    FROM users u
    LEFT JOIN goal_sheets gs ON gs.emp_no=u.emp_no AND gs.cycle=?
    LEFT JOIN reviews r ON r.sheet_id=gs.id AND r.review_type='year_end'
    WHERE u.is_active=1 AND u.role!='hr_admin'
    GROUP BY u.company ORDER BY u.cluster, u.company
  `).all(CYCLE);

  let csv = 'Company,Cluster,Total,A (Exceptional),B (Strong),C (Competent),D (Inconsistent),E (Below Exp),A+B,A+B%,Avg Score\r\n';
  let totals = {total:0,a:0,b:0,c:0,d:0,e:0};
  rows.forEach(r => {
    const ab = (r.a_count||0)+(r.b_count||0);
    const abPct = r.total>0 ? Math.round(ab/r.total*100) : 0;
    csv += [r.company, r.cluster||'', r.total, r.a_count||0, r.b_count||0, r.c_count||0,
      r.d_count||0, r.e_count||0, ab, abPct+'%',
      r.avg_score!=null ? Math.round(r.avg_score*10)/10 : ''].join(',')+'\r\n';
    totals.total+=r.total; totals.a+=(r.a_count||0); totals.b+=(r.b_count||0);
    totals.c+=(r.c_count||0); totals.d+=(r.d_count||0); totals.e+=(r.e_count||0);
  });
  const totAB=totals.a+totals.b;
  csv += ['All Companies','',totals.total,totals.a,totals.b,totals.c,totals.d,totals.e,
    totAB, totals.total>0?Math.round(totAB/totals.total*100)+'%':'0%',''].join(',')+'\r\n';

  res.setHeader('Content-Type','text/csv');
  res.setHeader('Content-Disposition',`attachment; filename="calibration-by-company-${CYCLE}.csv"`);
  res.send(csv);
});

// Export for year-end summary (already in export routes but adding here for completeness)
router.get('/export/promotions', requireReportsAccess, (req, res) => {
  const rows = db.prepare(`
    SELECT u.emp_no, u.name, u.designation, u.grade, u.dept, u.company, u.cluster,
           r.overall_score, r.system_rating, r.final_rating,
           r.promo_justification, r.mgr_strengths,
           r.promo_status, r.promo_decision_reason,
           sup.name as supervisor_name, dec.name as decided_by_name
    FROM users u
    JOIN goal_sheets gs ON gs.emp_no=u.emp_no AND gs.cycle=?
    JOIN reviews r ON r.sheet_id=gs.id AND r.review_type='year_end' AND r.promo_recommended=1
    LEFT JOIN users sup ON sup.emp_no=u.reports_to
    LEFT JOIN users dec ON dec.emp_no=r.promo_decision_by
    ORDER BY u.company, r.overall_score DESC
  `).all(CYCLE);
  let csv = 'Emp No,Name,Designation,Grade,Department,Company,Cluster,Score,Rating,Final Rating,Supervisor,Justification,Strengths,HR Decision,Decision Reason,Decided By\r\n';
  rows.forEach(r => {
    csv += [r.emp_no, r.name, r.designation||'', r.grade||'', r.dept||'',
      r.company, r.cluster||'', r.overall_score||'', r.system_rating||'', r.final_rating||'',
      r.supervisor_name||'',
      '"'+(r.promo_justification||'').replace(/"/g,'""')+'"',
      '"'+(r.mgr_strengths||'').replace(/"/g,'""')+'"',
      r.promo_status||'pending',
      '"'+(r.promo_decision_reason||'').replace(/"/g,'""')+'"',
      r.decided_by_name||''].join(',')+'\r\n';
  });
  res.setHeader('Content-Type','text/csv');
  res.setHeader('Content-Disposition',`attachment; filename="promotions-${CYCLE}.csv"`);
  res.send(csv);
});

// GET /api/company-drilldown/:company — employee detail for reports drill-down modal
router.get('/company-drilldown/:company', requireReportsAccess, (req, res) => {
  const company = decodeURIComponent(req.params.company);
  // SBU head: verify the requested company is within their subtree
  if (req.user.role === 'sbu_head') {
    const sbuCos = getSbuCompanies(req.user);
    if (!sbuCos || !sbuCos.includes(company)) {
      return res.status(403).json({ error: 'Access denied — company not in your SBU' });
    }
  }
  const rows = db.prepare(`
    SELECT u.emp_no, u.name, u.designation, u.grade, u.dept, u.company,
           u.role, m.name as manager_name,
           gs.status as goal_status,
           gs.submitted_at, gs.approved_at,
           r_mid.self_submitted_at as mid_submitted,
           r_mid.mgr_submitted_at as mid_mgr_submitted,
           r_mid.overall_score as mid_score, r_mid.system_rating as mid_rating,
           r_ye.self_submitted_at as ye_submitted,
           r_ye.mgr_submitted_at as ye_mgr_submitted,
           r_ye.overall_score as ye_score, r_ye.system_rating as ye_rating,
           r_ye.final_rating
    FROM users u
    LEFT JOIN users m ON m.emp_no = u.reports_to
    LEFT JOIN goal_sheets gs ON gs.emp_no = u.emp_no AND gs.cycle = ?
    LEFT JOIN reviews r_mid ON r_mid.sheet_id = gs.id AND r_mid.review_type = 'mid_year'
    LEFT JOIN reviews r_ye ON r_ye.sheet_id = gs.id AND r_ye.review_type = 'year_end'
    WHERE u.is_active = 1 AND u.company = ?
    ORDER BY u.name
  `).all(CYCLE, company);
  res.json(rows);
});


// ════════════════════════════════════════════════════════════

// GET /api/analytics/ratings-by-cycle — all cycles ratings (HR only)
router.get('/analytics/ratings-by-cycle', requireReportsAccess, (req, res) => {
  const cycles = db.prepare('SELECT DISTINCT cycle FROM goal_sheets ORDER BY cycle ASC').all();
  const result = cycles.map(c => {
    const emps = db.prepare(`
      SELECT u.emp_no, u.name, u.designation, u.company, u.cluster, u.grade,
             r.overall_score as ye_score, r.system_rating as ye_rating, r.final_rating,
             r_mid.overall_score as mid_score, r_mid.system_rating as mid_rating
      FROM users u
      LEFT JOIN goal_sheets gs ON gs.emp_no=u.emp_no AND gs.cycle=?
      LEFT JOIN reviews r ON r.sheet_id=gs.id AND r.review_type='year_end'
      LEFT JOIN reviews r_mid ON r_mid.sheet_id=gs.id AND r_mid.review_type='mid_year'
      WHERE u.is_active=1
      ORDER BY u.company, u.name
    `).all(c.cycle);
    const dist={A:0,B:0,C:0,D:0,E:0};
    emps.forEach(e=>{const r=e.final_rating||e.ye_rating;if(r&&dist[r]!==undefined)dist[r]++;});
    return {cycle:c.cycle, employees:emps, distribution:dist};
  });
  res.json(result);
});

// GET /api/export/analytics-ratings — year-wise ratings CSV
router.get('/export/analytics-ratings', requireReportsAccess, (req, res) => {
  const cycles = db.prepare('SELECT DISTINCT cycle FROM goal_sheets ORDER BY cycle ASC').all();
  let csv = 'Emp No,Name,Designation,Company,Cluster,Grade';
  cycles.forEach(c=>{csv+=','+c.cycle+' Mid Score,'+c.cycle+' Mid Rating,'+c.cycle+' YE Score,'+c.cycle+' Final Rating';});
  csv+='\r\n';
  const emps = db.prepare("SELECT emp_no,name,designation,company,cluster,grade FROM users WHERE is_active=1 ORDER BY company,name").all();
  emps.forEach(u=>{
    let row=[u.emp_no,u.name,u.designation||'',u.company,u.cluster||'',u.grade||''];
    cycles.forEach(c=>{
      const r=db.prepare(`SELECT r.overall_score as ye_score,r.system_rating as ye_rating,r.final_rating,r_mid.overall_score as mid_score,r_mid.system_rating as mid_rating FROM goal_sheets gs LEFT JOIN reviews r ON r.sheet_id=gs.id AND r.review_type='year_end' LEFT JOIN reviews r_mid ON r_mid.sheet_id=gs.id AND r_mid.review_type='mid_year' WHERE gs.emp_no=? AND gs.cycle=?`).get(u.emp_no,c.cycle);
      if(r){row.push(r.mid_score||'',r.mid_rating||'',r.ye_score||'',r.final_rating||r.ye_rating||'');}
      else{row.push('','','','');}
    });
    csv+=row.join(',')+'\r\n';
  });
  res.setHeader('Content-Type','text/csv');
  res.setHeader('Content-Disposition','attachment; filename="ratings-by-year.csv"');
  res.send(csv);
});

// GET /api/export/analytics-competency — competency ratings CSV
router.get('/export/analytics-competency', requireReportsAccess, (req, res) => {
  let csv='Emp No,Name,Company,Cycle,C1 Self,C1 Mgr,C2 Self,C2 Mgr,C3 Self,C3 Mgr,C4 Self,C4 Mgr,C5 Self,C5 Mgr,C6 Self,C6 Mgr\r\n';
  let rows;
  try {
    rows = db.prepare(`SELECT u.emp_no,u.name,u.company,gs.cycle,cr.c1_self,cr.c1_mgr,cr.c2_self,cr.c2_mgr,cr.c3_self,cr.c3_mgr,cr.c4_self,cr.c4_mgr,cr.c5_self,cr.c5_mgr,cr.c6_self,cr.c6_mgr FROM users u JOIN goal_sheets gs ON gs.emp_no=u.emp_no LEFT JOIN competency_ratings cr ON cr.sheet_id=gs.id WHERE u.is_active=1 ORDER BY u.company,u.name,gs.cycle`).all();
  } catch(e) { rows=[]; }
  rows.forEach(r=>{
    csv+=[r.emp_no,r.name,r.company,r.cycle,r.c1_self||'',r.c1_mgr||'',r.c2_self||'',r.c2_mgr||'',r.c3_self||'',r.c3_mgr||'',r.c4_self||'',r.c4_mgr||'',r.c5_self||'',r.c5_mgr||'',r.c6_self||'',r.c6_mgr||''].join(',')+'\r\n';
  });
  res.setHeader('Content-Type','text/csv');
  res.setHeader('Content-Disposition','attachment; filename="competency-ratings.csv"');
  res.send(csv);
});

// GET /api/reviews/:empNo/precal-history
router.get('/reviews/:empNo/precal-history', (req, res) => {
  const empNo = parseInt(req.params.empNo);
  if (!canAccessEmployee(req.user, empNo)) return res.status(403).json({error:'Access denied.'});
  const sheet = db.prepare('SELECT id FROM goal_sheets WHERE emp_no=? AND cycle=?').get(empNo, CYCLE);
  if (!sheet) return res.json([]);
  try {
    const history = db.prepare(`
      SELECT pca.*, u.name as adjusted_by_name
      FROM precal_adjustments pca
      LEFT JOIN users u ON u.emp_no = pca.adjusted_by
      WHERE pca.sheet_id = ?
      ORDER BY pca.adjusted_at DESC
    `).all(sheet.id);
    res.json(history);
  } catch(e) {
    res.json([]); // table may not exist yet
  }
});

// POST /api/reviews/:empNo/precal-adjust — supervisor saves pre-calibration adjustment
router.post('/reviews/:empNo/precal-adjust', (req, res) => {
  const empNo = parseInt(req.params.empNo);
  const emp = db.prepare('SELECT reports_to FROM users WHERE emp_no=?').get(empNo);
  if (req.user.role !== 'hr_admin' && emp?.reports_to !== req.user.emp_no) {
    return res.status(403).json({error:'Only the direct supervisor or HR can adjust ratings.'});
  }
  const { kpis, reason } = req.body;
  if (!reason || !reason.trim()) return res.status(400).json({error:'A reason is required for pre-calibration adjustments.'});
  const sheet = db.prepare('SELECT * FROM goal_sheets WHERE emp_no=? AND cycle=?').get(empNo, CYCLE);
  if (!sheet) return res.status(404).json({error:'No goal sheet found.'});

  // Check calibration not locked
  const cycleSettings = db.prepare('SELECT calib_locked FROM cycle_settings WHERE cycle=?').get(CYCLE);
  if (cycleSettings?.calib_locked) return res.status(400).json({error:'Calibration has been locked by HR. No further adjustments allowed.'});

  const now = Math.floor(Date.now()/1000);

  // Update KPI manager ratings
  try {
    (kpis||[]).forEach(k => {
      db.prepare('UPDATE kpis SET mgr_end_ach=?, updated_at=? WHERE id=?')
        .run(k.mgr_end_ach, now, k.id);
    });
  } catch(e) {
    console.error('Pre-cal KPI update error:', e);
    return res.status(500).json({error:'Failed to update KPI ratings: ' + e.message});
  }

  // Recompute scores
  const scores = computeScores(sheet.id, 'end');

  // Update review record
  const existing = db.prepare("SELECT id FROM reviews WHERE sheet_id=? AND review_type='year_end'").get(sheet.id);
  if (existing) {
    db.prepare("UPDATE reviews SET overall_score=?, system_rating=?, precal_adjusted=1, updated_at=? WHERE id=?")
      .run(scores.overall, scores.rating, now, existing.id);
  }

  // Log the adjustment in precal_adjustments table
  try {
    db.prepare(`INSERT INTO precal_adjustments(sheet_id,emp_no,adjusted_by,reason,kpis_snapshot,adjusted_at) VALUES(?,?,?,?,?,?)`)
      .run(sheet.id, empNo, req.user.emp_no, reason.trim(), JSON.stringify(kpis), now);
  } catch(e) {
    // Table may not exist — log to audit only
  }

  db.logAudit(req.user.id, 'precal_adjustment', 'review', sheet.id, {empNo, reason: reason.trim()}, req.ip);
  res.json({success:true, scores});
});

// PUT /api/users/:empNo/email — update employee email (HR only)
router.put('/users/:empNo/email', requireHR, (req, res) => {
  const empNo = parseInt(req.params.empNo);
  const { email } = req.body;
  try {
    db.prepare('UPDATE users SET email=?, updated_at=? WHERE emp_no=?')
      .run(email||null, Math.floor(Date.now()/1000), empNo);
    res.json({success:true});
  } catch(e) {
    res.status(500).json({error:'Could not update email: '+e.message});
  }
});

// GET /api/users/:empNo — get single user details including email
router.get('/users/:empNo', requireHR, (req, res) => {
  const empNo = parseInt(req.params.empNo);
  try {
    const u = db.prepare(`SELECT u.*, m.name as manager_name 
      FROM users u LEFT JOIN users m ON m.emp_no=u.reports_to 
      WHERE u.emp_no=?`).get(empNo);
    if (!u) return res.status(404).json({error:'User not found'});
    res.json(u);
  } catch(e) {
    res.status(500).json({error:e.message});
  }
});


// ════════════════════════════════════════════════════════════

// GET /api/notifications — get current user's unread notifications
router.get('/notifications', (req, res) => {
  try {
    const notifs = db.prepare(`
      SELECT * FROM notifications
      WHERE emp_no=? ORDER BY created_at DESC LIMIT 50
    `).all(req.user.emp_no);
    res.json(notifs);
  } catch(e) { res.json([]); }
});

// PUT /api/notifications/read — mark all as read
router.put('/notifications/read', (req, res) => {
  try {
    db.prepare('UPDATE notifications SET is_read=1 WHERE emp_no=?').run(req.user.emp_no);
  } catch(e) {}
  res.json({success:true});
});

// PUT /api/notifications/:id/read — mark one as read
router.put('/notifications/:id/read', (req, res) => {
  try {
    db.prepare('UPDATE notifications SET is_read=1 WHERE id=? AND emp_no=?')
      .run(parseInt(req.params.id), req.user.emp_no);
  } catch(e) {}
  res.json({success:true});
});

// ── Email enabled check — reads from DB, overrides email.config.js ──────────
function isEmailEnabled() {
  try {
    const s = db.prepare("SELECT value FROM system_settings WHERE key='email_enabled'").get();
    return s ? s.value === '1' : true;
  } catch(e) { return true; }
}

// GET /api/system/email-status — check current email toggle
router.get('/system/email-status', requireHR, (req, res) => {
  const enabled = isEmailEnabled();
  const pending = (() => { try { return db.prepare("SELECT COUNT(*) as n FROM email_queue WHERE status='pending'").get().n; } catch(e){ return 0; } })();
  const sent24h = (() => { try { return db.prepare("SELECT COUNT(*) as n FROM email_queue WHERE status='sent' AND sent_at > strftime('%s','now')-86400").get().n; } catch(e){ return 0; } })();
  res.json({ enabled, pending, sent24h });
});

// POST /api/system/email-toggle — enable or disable email sending
router.post('/system/email-toggle', requireHR, (req, res) => {
  const { enabled, cancel_pending } = req.body;
  const now = Math.floor(Date.now()/1000);
  db.prepare("UPDATE system_settings SET value=?, updated_at=?, updated_by=? WHERE key='email_enabled'")
    .run(enabled ? '1' : '0', now, req.user.emp_no);
  // Optionally cancel all pending queue entries
  let cancelled = 0;
  if (!enabled && cancel_pending) {
    const r = db.prepare("UPDATE email_queue SET status='cancelled' WHERE status='pending'").run();
    cancelled = r.changes;
  }
  db.logAudit(req.user.id, enabled ? 'email_enabled' : 'email_disabled', 'system', null,
    { cancelled_pending: cancelled }, req.ip);
  res.json({ success: true, enabled, cancelled });
});
// Queues emails immediately and returns — no timeout regardless of recipient count
router.post('/notifications/trigger', requireHR, async (req, res) => {
  const { type, target } = req.body;
  const emailOn = isEmailEnabled();
  let recipients = [];

  try {
    if (target === 'all') {
      recipients = db.prepare("SELECT emp_no, email, name FROM users WHERE is_active=1 AND role!='hr_admin'").all();
    } else if (target === 'pending_goals') {
      recipients = db.prepare(`SELECT u.emp_no, u.email, u.name FROM users u
        LEFT JOIN goal_sheets gs ON gs.emp_no=u.emp_no AND gs.cycle=?
        WHERE u.is_active=1 AND u.role!='hr_admin'
        AND (gs.status IS NULL OR gs.status='draft')`).all(CYCLE);
    } else if (target === 'pending_mid') {
      recipients = db.prepare(`SELECT u.emp_no, u.email, u.name FROM users u
        JOIN goal_sheets gs ON gs.emp_no=u.emp_no AND gs.cycle=? AND gs.status='approved'
        LEFT JOIN reviews r ON r.sheet_id=gs.id AND r.review_type='mid_year'
        WHERE u.is_active=1 AND u.role!='hr_admin' AND r.self_submitted_at IS NULL`).all(CYCLE);
    } else if (target === 'pending_ye') {
      recipients = db.prepare(`SELECT u.emp_no, u.email, u.name FROM users u
        JOIN goal_sheets gs ON gs.emp_no=u.emp_no AND gs.cycle=? AND gs.status='approved'
        LEFT JOIN reviews r ON r.sheet_id=gs.id AND r.review_type='year_end'
        WHERE u.is_active=1 AND u.role!='hr_admin' AND r.self_submitted_at IS NULL`).all(CYCLE);
    } else if (target) {
      // Individual employee by emp_no OR company name
      const empNoInt = parseInt(target);
      if (!isNaN(empNoInt) && String(empNoInt) === String(target)) {
        const u = db.prepare('SELECT emp_no, email, name FROM users WHERE emp_no=? AND is_active=1').get(empNoInt);
        if (u) recipients = [u];
        else return res.status(404).json({ error: `Employee ${empNoInt} not found` });
      } else {
        recipients = db.prepare("SELECT emp_no, email, name FROM users WHERE is_active=1 AND company=? AND role!='hr_admin'").all(target);
      }
    }

    if (!recipients.length) return res.json({ success: true, queued: 0, message: 'No matching recipients.' });

    const cycleSettings = db.prepare('SELECT * FROM cycle_settings WHERE cycle=?').get(CYCLE);
    const data = {
      deadline:   cycleSettings ? (type.includes('mid') ? cycleSettings.mid_end : type.includes('ye') || type.includes('yearend') ? cycleSettings.ye_end : cycleSettings.gs_end) : null,
      days_left:  0,
      phase_name: type.includes('mid') ? 'Mid-Year Review' : type.includes('ye') || type.includes('yearend') ? 'Year-End Review' : 'Goal Setting'
    };

    const { notify: notifyFn } = require('../notifications');
    await notifyFn(db, type, recipients, data);

    res.json({
      success: true,
      queued:  recipients.length,
      in_app:  recipients.length,
      email_enabled: emailOn,
      message: emailOn
        ? `Notifications queued for ${recipients.length} recipient(s). Emails will be delivered in the background.`
        : `In-app notifications sent to ${recipients.length} recipient(s). Email is currently DISABLED \u2014 no emails sent.`
    });
  } catch(e) {
    console.error('[notifications/trigger]', e);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/debug/goal-sheets/:company — diagnostic: check for data inconsistencies
router.get('/debug/goal-sheets/:company', requireHR, (req, res) => {
  const company = decodeURIComponent(req.params.company);
  const rows = db.prepare(`
    SELECT u.emp_no, u.name, u.company, u.role,
           COUNT(gs.id) as sheet_count,
           GROUP_CONCAT(gs.id) as sheet_ids,
           GROUP_CONCAT(gs.status) as statuses,
           GROUP_CONCAT(gs.cycle) as cycles
    FROM users u
    LEFT JOIN goal_sheets gs ON gs.emp_no = u.emp_no
    WHERE u.is_active=1 AND u.company=?
    GROUP BY u.emp_no
    ORDER BY u.name
  `).all(company);
  res.json(rows);
});
router.get('/notifications/queue-stats', requireHR, (req, res) => {
  try {
    const { getQueueStats } = require('../notifications');
    const stats = getQueueStats(db);
    // Also get recent batches
    const recent = db.prepare(`
      SELECT batch_id, status, COUNT(*) as count, MIN(queued_at) as queued_at
      FROM email_queue
      WHERE queued_at > strftime('%s','now') - 86400 * 7
      GROUP BY batch_id, status
      ORDER BY queued_at DESC LIMIT 30
    `).all();
    res.json({ stats, recent });
  } catch(e) {
    res.json({ stats: { pending:0, sending:0, sent:0, failed:0 }, recent: [] });
  }
});

// POST /api/notifications/retry-failed — HR retries failed emails
router.post('/notifications/retry-failed', requireHR, (req, res) => {
  try {
    const result = db.prepare(`
      UPDATE email_queue SET status='pending', attempts=0, last_error=NULL
      WHERE status='failed'
    `).run();
    res.json({ success: true, retrying: result.changes });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/notifications/retry-one — retry a single failed email
router.post('/notifications/retry-one/:id', requireHR, (req, res) => {
  try {
    db.prepare(`UPDATE email_queue SET status='pending', attempts=0, last_error=NULL WHERE id=?`)
      .run(parseInt(req.params.id));
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/notifications/queue/:id — delete a queue entry
router.delete('/notifications/queue/:id', requireHR, (req, res) => {
  try {
    db.prepare('DELETE FROM email_queue WHERE id=?').run(parseInt(req.params.id));
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/notifications/queue — full email queue with filters
router.get('/notifications/queue', requireHR, (req, res) => {
  const { status, batch_id, page } = req.query;
  const pageSize = 50;
  const offset   = (parseInt(page)||0) * pageSize;
  try {
    const conditions = ["queued_at > strftime('%s','now') - 86400 * 30"];
    const params = [];
    if (status && status !== 'all') { conditions.push('status=?'); params.push(status); }
    if (batch_id) { conditions.push('batch_id=?'); params.push(batch_id); }
    const where = 'WHERE ' + conditions.join(' AND ');

    const total  = db.prepare(`SELECT COUNT(*) as n FROM email_queue ${where}`).get(...params).n;
    const rows   = db.prepare(`
      SELECT id, emp_no, to_email, subject, status, attempts, last_error, queued_at, sent_at, batch_id
      FROM email_queue ${where}
      ORDER BY queued_at DESC LIMIT ${pageSize} OFFSET ${offset}
    `).all(...params);

    const counts = db.prepare(`
      SELECT status, COUNT(*) as n FROM email_queue
      WHERE queued_at > strftime('%s','now') - 86400 * 30
      GROUP BY status
    `).all();

    const batches = db.prepare(`
      SELECT batch_id,
             COUNT(*) as total,
             SUM(CASE WHEN status='sent'    THEN 1 ELSE 0 END) as sent,
             SUM(CASE WHEN status='failed'  THEN 1 ELSE 0 END) as failed,
             SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) as pending,
             MIN(queued_at) as queued_at
      FROM email_queue
      WHERE queued_at > strftime('%s','now') - 86400 * 30
      GROUP BY batch_id ORDER BY queued_at DESC LIMIT 50
    `).all();

    res.json({ rows, total, counts, batches, page: parseInt(page)||0, pageSize });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});


// ════════════════════════════════════════════════════════════
// REPORTS CSV EXPORTS — sbu_head (own companies), exco + hr_admin (all)
// ════════════════════════════════════════════════════════════

router.get('/export/full-pms-status', requireReportsAccess, (req, res) => {
  const sbuCos = getSbuCompanies(req.user);
  const { clause, params: sp } = companyScope(sbuCos, [CYCLE]);
  const rows = db.prepare(`
    SELECT u.emp_no, u.name, u.designation, u.grade, u.dept, u.company, u.cluster,
           m.name as manager,
           gs.status as goal_status, gs.submitted_at, gs.approved_at,
           r_mid.status as mid_status, r_mid.overall_score as mid_score,
           r_mid.system_rating as mid_rating, r_mid.final_rating as mid_final,
           r_ye.status as ye_status, r_ye.overall_score as ye_score,
           r_ye.system_rating as ye_rating, r_ye.final_rating as ye_final
    FROM users u
    LEFT JOIN users m ON u.reports_to = m.emp_no
    LEFT JOIN goal_sheets gs ON gs.emp_no = u.emp_no AND gs.cycle = ?
    LEFT JOIN reviews r_mid ON r_mid.sheet_id = gs.id AND r_mid.review_type = 'mid_year'
    LEFT JOIN reviews r_ye  ON r_ye.sheet_id  = gs.id AND r_ye.review_type  = 'year_end'
    WHERE u.is_active = 1${clause}
    ORDER BY u.cluster, u.company, u.name
  `).all(...sp);
  let csv = 'Emp No,Name,Designation,Grade,Dept,Company,Cluster,Manager,Goal Status,Goals Submitted,Goals Approved,Mid Status,Mid Score,Mid System Rating,Mid Final Rating,YE Status,YE Score,YE System Rating,YE Final Rating\r\n';
  rows.forEach(r => {
    csv += [r.emp_no,r.name,r.designation||'',r.grade||'',r.dept||'',r.company,r.cluster||'',r.manager||'',
      r.goal_status||'not_started',
      r.submitted_at?new Date(r.submitted_at*1000).toISOString().slice(0,10):'',
      r.approved_at ?new Date(r.approved_at*1000).toISOString().slice(0,10) :'',
      r.mid_status||'',r.mid_score||'',r.mid_rating||'',r.mid_final||'',
      r.ye_status||'',r.ye_score||'',r.ye_rating||'',r.ye_final||''].join(',')+'\r\n';
  });
  res.setHeader('Content-Type','text/csv');
  res.setHeader('Content-Disposition',`attachment; filename="full-pms-status-${CYCLE}.csv"`);
  res.send(csv);
});

router.get('/export/goal-completion', requireReportsAccess, (req, res) => {
  const sbuCos = getSbuCompanies(req.user);
  const { clause, params: sp } = companyScope(sbuCos, [CYCLE]);
  const rows = db.prepare(`
    SELECT u.company, COUNT(*) as total,
           SUM(CASE WHEN gs.status='approved'  THEN 1 ELSE 0 END) as approved,
           SUM(CASE WHEN gs.status='submitted' THEN 1 ELSE 0 END) as submitted,
           SUM(CASE WHEN gs.status='draft'     THEN 1 ELSE 0 END) as draft,
           SUM(CASE WHEN gs.id IS NULL          THEN 1 ELSE 0 END) as not_started
    FROM users u
    LEFT JOIN goal_sheets gs ON gs.emp_no = u.emp_no AND gs.cycle = ?
    WHERE u.is_active = 1${clause}
    GROUP BY u.company ORDER BY u.company
  `).all(...sp);
  let csv = 'Company,Total Staff,Approved,Submitted,Draft,Not Started,Approval %\r\n';
  rows.forEach(r => {
    const pct = r.total > 0 ? Math.round(r.approved/r.total*100) : 0;
    csv += [r.company,r.total,r.approved,r.submitted,r.draft,r.not_started,pct+'%'].join(',')+'\r\n';
  });
  res.setHeader('Content-Type','text/csv');
  res.setHeader('Content-Disposition',`attachment; filename="goal-completion-${CYCLE}.csv"`);
  res.send(csv);
});

router.get('/export/rating-distribution', requireReportsAccess, (req, res) => {
  const sbuCos = getSbuCompanies(req.user);
  const { clause, params: sp } = companyScope(sbuCos, []);
  const phases = ['mid_year','year_end'];
  let csv = 'Phase,Rating,Label,Count,Percentage\r\n';
  const labels = {A:'Exceptional',B:'Strong',C:'Competent',D:'Inconsistent',E:'Below Expectations'};
  phases.forEach(phase => {
    const rows = db.prepare(`
      SELECT r.system_rating as rating, COUNT(*) as cnt
      FROM reviews r
      JOIN goal_sheets gs ON r.sheet_id = gs.id AND gs.cycle = ?
      JOIN users u ON u.emp_no = gs.emp_no
      WHERE r.review_type = ? AND r.system_rating IS NOT NULL${clause}
      GROUP BY r.system_rating ORDER BY r.system_rating
    `).all(CYCLE, phase, ...sp);
    const total = rows.reduce((s,r)=>s+r.cnt,0);
    ['A','B','C','D','E'].forEach(rt => {
      const row = rows.find(r=>r.rating===rt);
      const cnt = row?row.cnt:0;
      const pct = total>0?Math.round(cnt/total*100):0;
      csv += [phase==='mid_year'?'Mid-Year':'Year-End',rt,labels[rt],cnt,pct+'%'].join(',')+'\r\n';
    });
  });
  res.setHeader('Content-Type','text/csv');
  res.setHeader('Content-Disposition',`attachment; filename="rating-distribution-${CYCLE}.csv"`);
  res.send(csv);
});

router.get('/export/mid-year-summary', requireReportsAccess, (req, res) => {
  const sbuCos = getSbuCompanies(req.user);
  const { clause, params: sp } = companyScope(sbuCos, [CYCLE]);
  const rows = db.prepare(`
    SELECT u.emp_no, u.name, u.designation, u.grade, u.company,
           m.name as manager,
           r.overall_score, r.system_rating, r.override_rating, r.final_rating,
           r.self_went_well, r.self_improve, r.self_support_needed,
           r.mgr_comments, r.mgr_strengths, r.mgr_develop,
           r.self_submitted_at, r.mgr_submitted_at, r.promo_recommended
    FROM users u
    JOIN goal_sheets gs ON gs.emp_no = u.emp_no AND gs.cycle = ?
    JOIN reviews r ON r.sheet_id = gs.id AND r.review_type = 'mid_year'
    LEFT JOIN users m ON u.reports_to = m.emp_no
    WHERE u.is_active = 1${clause}
    ORDER BY u.company, u.name
  `).all(...sp);
  let csv = 'Emp No,Name,Designation,Grade,Company,Manager,System Rating,Override Rating,Final Rating,Score,Self: Went Well,Self: Improve,Self: Support,Mgr Comments,Mgr Strengths,Mgr Develop,Self Submitted,Mgr Submitted,Promo Recommended\r\n';
  rows.forEach(r => {
    csv += [r.emp_no,r.name,r.designation||'',r.grade||'',r.company,r.manager||'',
      r.system_rating||'',r.override_rating||'',r.final_rating||'',r.overall_score||'',
      '"'+(r.self_went_well||'').replace(/"/g,'""')+'"',
      '"'+(r.self_improve||'').replace(/"/g,'""')+'"',
      '"'+(r.self_support_needed||'').replace(/"/g,'""')+'"',
      '"'+(r.mgr_comments||'').replace(/"/g,'""')+'"',
      '"'+(r.mgr_strengths||'').replace(/"/g,'""')+'"',
      '"'+(r.mgr_develop||'').replace(/"/g,'""')+'"',
      r.self_submitted_at?new Date(r.self_submitted_at*1000).toISOString().slice(0,10):'',
      r.mgr_submitted_at ?new Date(r.mgr_submitted_at*1000).toISOString().slice(0,10) :'',
      r.promo_recommended?'Yes':'No'].join(',')+'\r\n';
  });
  res.setHeader('Content-Type','text/csv');
  res.setHeader('Content-Disposition',`attachment; filename="mid-year-summary-${CYCLE}.csv"`);
  res.send(csv);
});

router.get('/export/year-end-summary', requireReportsAccess, (req, res) => {
  const sbuCos = getSbuCompanies(req.user);
  const { clause, params: sp } = companyScope(sbuCos, [CYCLE]);
  const rows = db.prepare(`
    SELECT u.emp_no, u.name, u.designation, u.grade, u.company,
           m.name as manager,
           r.overall_score, r.system_rating, r.override_rating, r.final_rating,
           r.self_went_well, r.self_improve, r.self_support_needed,
           r.mgr_comments, r.mgr_strengths, r.mgr_develop,
           r.self_submitted_at, r.mgr_submitted_at,
           r.promo_recommended, r.promo_justification
    FROM users u
    JOIN goal_sheets gs ON gs.emp_no = u.emp_no AND gs.cycle = ?
    JOIN reviews r ON r.sheet_id = gs.id AND r.review_type = 'year_end'
    LEFT JOIN users m ON u.reports_to = m.emp_no
    WHERE u.is_active = 1${clause}
    ORDER BY u.company, u.name
  `).all(...sp);
  let csv = 'Emp No,Name,Designation,Grade,Company,Manager,System Rating,Override Rating,Final Rating,Score,Self: Went Well,Self: Improve,Self: Support,Mgr Comments,Mgr Strengths,Mgr Develop,Self Submitted,Mgr Submitted,Promo Recommended,Promo Justification\r\n';
  rows.forEach(r => {
    csv += [r.emp_no,r.name,r.designation||'',r.grade||'',r.company,r.manager||'',
      r.system_rating||'',r.override_rating||'',r.final_rating||'',r.overall_score||'',
      '"'+(r.self_went_well||'').replace(/"/g,'""')+'"',
      '"'+(r.self_improve||'').replace(/"/g,'""')+'"',
      '"'+(r.self_support_needed||'').replace(/"/g,'""')+'"',
      '"'+(r.mgr_comments||'').replace(/"/g,'""')+'"',
      '"'+(r.mgr_strengths||'').replace(/"/g,'""')+'"',
      '"'+(r.mgr_develop||'').replace(/"/g,'""')+'"',
      r.self_submitted_at?new Date(r.self_submitted_at*1000).toISOString().slice(0,10):'',
      r.mgr_submitted_at ?new Date(r.mgr_submitted_at*1000).toISOString().slice(0,10) :'',
      r.promo_recommended?'Yes':'No',
      '"'+(r.promo_justification||'').replace(/"/g,'""')+'"'].join(',')+'\r\n';
  });
  res.setHeader('Content-Type','text/csv');
  res.setHeader('Content-Disposition',`attachment; filename="year-end-summary-${CYCLE}.csv"`);
  res.send(csv);
});

router.get('/export/employee-directory', requireReportsAccess, (req, res) => {
  const sbuCos = getSbuCompanies(req.user);
  const { clause, params: sp } = companyScope(sbuCos, []);
  const sql = `
    SELECT u.emp_no, u.name, u.designation, u.grade, u.dept, u.company, u.division, u.cluster,
           m.name as manager, u.role
    FROM users u
    LEFT JOIN users m ON u.reports_to = m.emp_no
    WHERE u.is_active = 1${clause}
    ORDER BY u.cluster, u.company, u.dept, u.name`;
  const rows = sp.length ? db.prepare(sql).all(...sp) : db.prepare(sql).all();
  let csv = 'Emp No,Name,Designation,Grade,Dept,Company,Division,Cluster,Manager,Role\r\n';
  rows.forEach(r => {
    csv += [r.emp_no,r.name,r.designation||'',r.grade||'',r.dept||'',r.company,
      r.division||'',r.cluster||'',r.manager||'',r.role].join(',')+'\r\n';
  });
  res.setHeader('Content-Type','text/csv');
  res.setHeader('Content-Disposition','attachment; filename="employee-directory.csv"');
  res.send(csv);
});


// ════════════════════════════════════════════════════════════
// REVIEW OVERRIDES — HR can unlock mid/year-end for individual employees
// ════════════════════════════════════════════════════════════

// GET /api/review-overrides/:empNo — get all overrides for an employee
router.get('/review-overrides/:empNo', requireHR, (req, res) => {
  const empNo = parseInt(req.params.empNo);
  const overrides = db.prepare(
    'SELECT * FROM review_overrides WHERE emp_no=? AND cycle=?'
  ).all(empNo, CYCLE);
  res.json(overrides);
});

// POST /api/review-overrides/:empNo — set or clear an override
// Body: { review_type: 'mid_year'|'year_end', state: 'open'|'locked'|null, reason: '...' }
router.post('/review-overrides/:empNo', requireHR, (req, res) => {
  const empNo = parseInt(req.params.empNo);
  const { review_type, state, reason } = req.body;
  if (!['mid_year','year_end'].includes(review_type)) {
    return res.status(400).json({ error: 'Invalid review_type' });
  }
  const now = Math.floor(Date.now()/1000);
  if (!state) {
    // Clear override — employee follows global window
    db.prepare('DELETE FROM review_overrides WHERE emp_no=? AND cycle=? AND review_type=?')
      .run(empNo, CYCLE, review_type);
    db.logAudit(req.user.id,'review_override_cleared','review_override',null,{empNo,review_type},req.ip);
    return res.json({ success:true, cleared:true });
  }
  if (!['open','locked'].includes(state)) {
    return res.status(400).json({ error: 'state must be open, locked, or null' });
  }
  db.prepare(`
    INSERT INTO review_overrides(emp_no,cycle,review_type,state,reason,set_by,set_at)
    VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(emp_no,cycle,review_type) DO UPDATE SET
      state=excluded.state, reason=excluded.reason, set_by=excluded.set_by, set_at=excluded.set_at
  `).run(empNo, CYCLE, review_type, state, reason||null, req.user.emp_no, now);
  db.logAudit(req.user.id,'review_override_set','review_override',null,{empNo,review_type,state,reason},req.ip);
  res.json({ success:true, empNo, review_type, state });
});

// GET /api/review-overrides — all active overrides for current cycle (HR dashboard)
router.get('/review-overrides', requireHR, (req, res) => {
  const overrides = db.prepare(`
    SELECT ro.*, u.name as emp_name, u.company, hr.name as set_by_name
    FROM review_overrides ro
    JOIN users u ON u.emp_no=ro.emp_no
    LEFT JOIN users hr ON hr.emp_no=ro.set_by
    WHERE ro.cycle=?
    ORDER BY ro.set_at DESC
  `).all(CYCLE);
  res.json(overrides);
});

// ════════════════════════════════════════════════════════════
// GOAL SHEET JOIN DATE / PRORATION — HR sets join context on goal sheet
// ════════════════════════════════════════════════════════════

// GET /api/goals/:empNo/join-context
router.get('/goals/:empNo/join-context', requireHR, (req, res) => {
  const empNo = parseInt(req.params.empNo);
  const sheet = db.prepare('SELECT join_date,fy_start_date,fy_end_date,skip_mid_year FROM goal_sheets WHERE emp_no=? AND cycle=?').get(empNo, CYCLE);
  res.json(sheet || {});  // always return 200 -- empty object if no sheet yet
});

// PUT /api/goals/:empNo/join-context — set proration context
router.put('/goals/:empNo/join-context', requireHR, (req, res) => {
  const empNo = parseInt(req.params.empNo);
  const { join_date, fy_start_date, fy_end_date, skip_mid_year } = req.body;
  const now = Math.floor(Date.now()/1000);
  let sheet = db.prepare('SELECT id FROM goal_sheets WHERE emp_no=? AND cycle=?').get(empNo, CYCLE);
  if (!sheet) {
    // Create a minimal goal sheet so we can attach join context to it
    const result = db.prepare(
      'INSERT INTO goal_sheets(emp_no,cycle,status,join_date,fy_start_date,fy_end_date,skip_mid_year,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)'
    ).run(empNo, CYCLE, 'draft', join_date||null, fy_start_date||null, fy_end_date||null, skip_mid_year?1:0, now, now);
    db.logAudit(req.user.id,'join_context_created','goal_sheet',result.lastInsertRowid,{empNo,join_date,fy_start_date,fy_end_date,skip_mid_year},req.ip);
    return res.json({ success: true, created: true });
  }
  db.prepare(`
    UPDATE goal_sheets SET join_date=?, fy_start_date=?, fy_end_date=?, skip_mid_year=?, updated_at=? WHERE id=?
  `).run(join_date||null, fy_start_date||null, fy_end_date||null, skip_mid_year?1:0, now, sheet.id);
  db.logAudit(req.user.id,'join_context_set','goal_sheet',sheet.id,{empNo,join_date,fy_start_date,fy_end_date,skip_mid_year},req.ip);
  res.json({ success: true });
});

// ════════════════════════════════════════════════════════════
// KPI TARGET VERSIONING — set/view target history for a KPI
// ════════════════════════════════════════════════════════════

// GET /api/kpi-target-history/:kpiId
router.get('/kpi-target-history/:kpiId', (req, res) => {
  const kpiId = parseInt(req.params.kpiId);
  // Check user can access this KPI via its goal sheet
  const kpi = db.prepare('SELECT kpis.*, kras.sheet_id FROM kpis JOIN kras ON kras.id=kpis.kra_id WHERE kpis.id=?').get(kpiId);
  if (!kpi) return res.status(404).json({ error: 'KPI not found' });
  const sheet = db.prepare('SELECT * FROM goal_sheets WHERE id=?').get(kpi.sheet_id);
  if (!canAccessEmployee(req.user, sheet.emp_no)) return res.status(403).json({ error: 'Access denied' });
  const history = db.prepare('SELECT * FROM kpi_target_history WHERE kpi_id=? ORDER BY effective_from ASC').all(kpiId);
  res.json(history);
});

// POST /api/kpi-target-history/:kpiId — add a new target version (HR or goal change approval)
router.post('/kpi-target-history/:kpiId', requireHR, (req, res) => {
  const kpiId = parseInt(req.params.kpiId);
  const { target, unit, effective_from, reason } = req.body;
  if (!target || !effective_from) return res.status(400).json({ error: 'target and effective_from required' });
  const now = Math.floor(Date.now()/1000);
  // Close the current open version
  db.prepare('UPDATE kpi_target_history SET effective_to=? WHERE kpi_id=? AND effective_to IS NULL')
    .run(new Date(new Date(effective_from).getTime() - 86400000).toISOString().slice(0,10), kpiId);
  // Insert new version
  db.prepare(`
    INSERT INTO kpi_target_history(kpi_id,target,unit,effective_from,effective_to,changed_by,reason,created_at)
    VALUES(?,?,?,?,NULL,?,?,?)
  `).run(kpiId, parseFloat(target), unit||null, effective_from, req.user.emp_no, reason||null, now);
  db.logAudit(req.user.id,'kpi_target_versioned','kpi',kpiId,{target,effective_from,reason},req.ip);
  res.json({ success: true });
});

module.exports = router;
