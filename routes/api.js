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

// ── Reports access: sbu_head, exco, hr_admin only
// Hierarchy: employee < supervisor < manager < senior_manager < sbu_head < exco < hr_admin
// senior_manager manages teams within an SBU — they do NOT get cross-company reports
function requireReportsAccess(req, res, next) {
  const allowed = ['sbu_head','exco','hr_admin'];
  if (!req.user || !allowed.includes(req.user.role)) {
    return res.status(403).json({ error: 'Access denied — SBU Head or above required' });
  }
  next();
}

// Scope SQL to user's cluster for sbu_head; no filter for exco/hr_admin (group-wide).
// Pass base params (without the scope param) — scope param is appended if needed.
// Usage: const {clause, params} = scopeClause(req.user, [param1, param2, ...]);
function scopeClause(user, baseParams = []) {
  if (user.role === 'sbu_head' && user.cluster) {
    return {
      clause: ' AND u.cluster = ?',
      params: [...baseParams, user.cluster]
    };
  }
  return { clause: '', params: baseParams };
}

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
                  u.is_active, m.name as manager_name,
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
            r_ye.mgr_submitted_at as ye_mgr_submitted
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

// GET /api/calibration — all employees with scores
router.get('/calibration', requireRole('senior_manager'), (req, res) => {
  const { company } = req.query;
  let sql = `SELECT u.emp_no, u.name, u.designation, u.company,
                    gs.id as sheet_id, gs.status as goal_status,
                    r.overall_score, r.system_rating, r.override_rating,
                    r.final_rating, r.status as review_status,
                    m.name as manager_name
             FROM users u
             LEFT JOIN goal_sheets gs ON gs.emp_no = u.emp_no AND gs.cycle = ?
             LEFT JOIN reviews r ON r.sheet_id = gs.id AND r.review_type = 'mid_year'
             LEFT JOIN users m ON u.reports_to = m.emp_no
             WHERE u.is_active = 1`;
  const params = [CYCLE];
  if (company) { sql += ' AND u.company = ?'; params.push(company); }
  sql += ' ORDER BY u.company, u.name';

  res.json(db.prepare(sql).all(...params));
});

// POST /api/calibration/set-rating — HR sets override rating
router.post('/calibration/set-rating', requireHR, (req, res) => {
  const { emp_no, review_type = 'mid_year', override_rating } = req.body;
  const validRatings = ['A', 'B', 'C', 'D', 'E', null];
  if (!validRatings.includes(override_rating)) {
    return res.status(400).json({ error: 'Invalid rating.' });
  }

  const sheet = db.prepare('SELECT * FROM goal_sheets WHERE emp_no = ? AND cycle = ?')
    .get(parseInt(emp_no), CYCLE);
  if (!sheet) return res.status(404).json({ error: 'No goal sheet.' });

  const now = Math.floor(Date.now()/1000);
  const final = override_rating || db.prepare(
    'SELECT system_rating FROM reviews WHERE sheet_id = ? AND review_type = ?'
  ).get(sheet.id, review_type)?.system_rating;

  db.prepare(
    `UPDATE reviews SET override_rating=?, final_rating=?, calibrated_by=?, calibrated_at=?,
     status='calibrated', updated_at=?
     WHERE sheet_id=? AND review_type=?`
  ).run(override_rating, final, req.user.emp_no, now, now, sheet.id, review_type);

  db.logAudit(req.user.id, 'rating_calibrated', 'review', sheet.id,
    { emp_no, override_rating, final }, req.ip);
  res.json({ success: true });
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
  const kras = db.prepare('SELECT * FROM kras WHERE sheet_id = ?').all(sheetId);
  let overallWeighted = 0, totalKraWt = 0;

  const kraScores = kras.map(kra => {
    const kpis = db.prepare('SELECT * FROM kpis WHERE kra_id = ?').all(kra.id);
    let empKraAch = 0, empHasAny = false;
    let mgrKraAch = 0, mgrHasAny = false;

    kpis.forEach(kpi => {
      // KRA achievement = sum(kpi_ach × kpi_weight/100)
      const empAch = useEnd ? (kpi.end_ach != null ? kpi.end_ach : kpi.mid_ach) : kpi.mid_ach;
      if (empAch != null) { empKraAch += empAch * (kpi.kpi_weight / 100); empHasAny = true; }

      const mgrAch = useEnd ? (kpi.mgr_end_ach != null ? kpi.mgr_end_ach : kpi.mgr_mid_ach) : kpi.mgr_mid_ach;
      if (mgrAch != null) { mgrKraAch += mgrAch * (kpi.kpi_weight / 100); mgrHasAny = true; }
    });

    const empNorm = empHasAny ? Math.round(empKraAch * 10) / 10 : null;
    const mgrNorm = mgrHasAny ? Math.round(mgrKraAch * 10) / 10 : null;

    // Overall = sum(kra_ach × kra_weight/100)
    if (empNorm !== null) { overallWeighted += empNorm * (kra.kra_weight / 100); totalKraWt += kra.kra_weight; }

    return {
      kra_id: kra.id,
      kra_name: kra.kra_name,
      kra_weight: kra.kra_weight,
      score: empNorm,
      mgr_score: mgrNorm,
      rating: empNorm !== null ? getSystemRating((empNorm / kra.kra_weight) * 100) : null,
      mgr_rating: mgrNorm !== null ? getSystemRating((mgrNorm / kra.kra_weight) * 100) : null,
    };
  });

  // Normalise if not all KRAs have data
  const overall = totalKraWt > 0
    ? Math.round((totalKraWt === 100 ? overallWeighted : overallWeighted / totalKraWt * 100) * 10) / 10
    : null;
  const rating  = overall !== null ? getSystemRating(overall) : null;
  const ratingInfo = rating ? RATING_SCALE.find(r => r.r === rating) : null;

  return { kra_scores: kraScores, overall, rating, rating_label: ratingInfo?.label, rating_desc: ratingInfo?.desc };
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
  if (ROLE_LEVELS[u.role] >= ROLE_LEVELS['supervisor'] && isInHierarchy(targetEmpNo, u.emp_no)) return true;
  return false;
}

// ════════════════════════════════════════════════════════════
// EXPORT / DOWNLOAD ROUTES  (HR only)
// GET /api/export/:slug?format=csv|pdf
// All routes stream a CSV file. PDF is the same CSV for now
// (front-end can convert; full PDF rendering requires puppeteer
//  which is not installed — CSV is the fully usable deliverable).
// ════════════════════════════════════════════════════════════

function csvEscape(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}
function csvRow(arr) { return arr.map(csvEscape).join(',') + '\r\n'; }
function sendCSV(res, filename, rows) {
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  rows.forEach(r => res.write(r));
  res.end();
}

// GET /api/export/full-pms-status
router.get('/export/full-pms-status', requireReportsAccess, (req, res) => {
  const {clause, params} = scopeClause(req.user, [CYCLE]);
  const rows = db.prepare(`
    SELECT u.emp_no, u.name, u.designation, u.grade, u.dept, u.company, u.cluster,
           m.name as manager,
           gs.status as goal_status,
           gs.submitted_at, gs.approved_at,
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
  `).all(...params);

  const out = [];
  out.push(csvRow(['Emp No','Name','Designation','Grade','Department','Company','Cluster','Manager',
    'Goal Status','Goals Submitted At','Goals Approved At',
    'Mid-Year Status','Mid-Year Score','Mid-Year System Rating','Mid-Year Final Rating',
    'Year-End Status','Year-End Score','Year-End System Rating','Year-End Final Rating']));
  rows.forEach(r => {
    out.push(csvRow([
      r.emp_no, r.name, r.designation, r.grade, r.dept, r.company, r.cluster, r.manager,
      r.goal_status || 'not_started',
      r.submitted_at ? new Date(r.submitted_at*1000).toISOString().slice(0,10) : '',
      r.approved_at  ? new Date(r.approved_at*1000).toISOString().slice(0,10)  : '',
      r.mid_status || '', r.mid_score || '', r.mid_rating || '', r.mid_final || '',
      r.ye_status  || '', r.ye_score  || '', r.ye_rating  || '', r.ye_final  || ''
    ]));
  });
  sendCSV(res, `acorn-full-pms-status-${CYCLE}.csv`, out);
});

// GET /api/export/goal-completion-report
router.get('/export/goal-completion-report', requireReportsAccess, (req, res) => {
  const {clause, params} = scopeClause(req.user, [CYCLE]);
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
  `).all(...params);

  const out = [];
  out.push(csvRow(['Company','Total Staff','Approved','Submitted/Pending','Draft','Not Started','Approval %']));
  rows.forEach(r => {
    const pct = r.total > 0 ? Math.round(r.approved / r.total * 100) : 0;
    out.push(csvRow([r.company, r.total, r.approved, r.submitted, r.draft, r.not_started, pct + '%']));
  });
  sendCSV(res, `acorn-goal-completion-${CYCLE}.csv`, out);
});

// GET /api/export/rating-distribution
router.get('/export/rating-distribution', requireReportsAccess, (req, res) => {
  const {clause, params: scopeParams} = scopeClause(req.user, []);
  const phases = ['mid_year', 'year_end'];
  const out = [];
  out.push(csvRow(['Phase','Rating','Label','Count','Percentage']));
  phases.forEach(phase => {
    const rows = db.prepare(`
      SELECT r.system_rating as rating, COUNT(*) as cnt
      FROM reviews r
      JOIN goal_sheets gs ON r.sheet_id = gs.id AND gs.cycle = ?
      JOIN users u ON u.emp_no = gs.emp_no
      WHERE r.review_type = ? AND r.system_rating IS NOT NULL${clause}
      GROUP BY r.system_rating ORDER BY r.system_rating
    `).all(CYCLE, phase, ...scopeParams);
    const total = rows.reduce((s, r) => s + r.cnt, 0);
    const labels = {A:'Exceptional',B:'Strong',C:'Competent',D:'Inconsistent',E:'Below Expectations'};
    ['A','B','C','D','E'].forEach(rt => {
      const row = rows.find(r => r.rating === rt);
      const cnt = row ? row.cnt : 0;
      const pct = total > 0 ? Math.round(cnt/total*100) : 0;
      out.push(csvRow([phase === 'mid_year' ? 'Mid-Year' : 'Year-End', rt, labels[rt] || rt, cnt, pct + '%']));
    });
  });
  sendCSV(res, `acorn-rating-distribution-${CYCLE}.csv`, out);
});

// GET /api/export/mid-year-appraisal-summary
router.get('/export/mid-year-appraisal-summary', requireReportsAccess, (req, res) => {
  const {clause, params} = scopeClause(req.user, [CYCLE]);
  const rows = db.prepare(`
    SELECT u.emp_no, u.name, u.designation, u.company, u.grade,
           m.name as manager,
           r.overall_score, r.system_rating, r.override_rating, r.final_rating,
           r.self_went_well, r.self_improve, r.self_support_needed,
           r.mgr_comments, r.mgr_strengths, r.mgr_develop,
           r.self_submitted_at, r.mgr_submitted_at,
           r.promo_recommended
    FROM users u
    JOIN goal_sheets gs ON gs.emp_no = u.emp_no AND gs.cycle = ?
    JOIN reviews r ON r.sheet_id = gs.id AND r.review_type = 'mid_year'
    LEFT JOIN users m ON u.reports_to = m.emp_no
    WHERE u.is_active = 1${clause}
    ORDER BY u.company, u.name
  `).all(...params);

  const out = [];
  out.push(csvRow(['Emp No','Name','Designation','Grade','Company','Manager',
    'System Rating','Override Rating','Final Rating',
    'Overall Score','Self: What Went Well','Self: Areas to Improve','Self: Support Needed',
    'Manager Comments','Manager Strengths','Manager Development',
    'Self Submitted','Manager Submitted','Promotion Recommended']));
  rows.forEach(r => {
    out.push(csvRow([
      r.emp_no, r.name, r.designation, r.grade, r.company, r.manager,
      r.system_rating || '', r.override_rating || '', r.final_rating || '',
      r.overall_score || '', r.self_went_well || '', r.self_improve || '', r.self_support_needed || '',
      r.mgr_comments || '', r.mgr_strengths || '', r.mgr_develop || '',
      r.self_submitted_at ? new Date(r.self_submitted_at*1000).toISOString().slice(0,10) : '',
      r.mgr_submitted_at  ? new Date(r.mgr_submitted_at*1000).toISOString().slice(0,10)  : '',
      r.promo_recommended ? 'Yes' : 'No'
    ]));
  });
  sendCSV(res, `acorn-mid-year-summary-${CYCLE}.csv`, out);
});

// GET /api/export/year-end-appraisal-summary
router.get('/export/year-end-appraisal-summary', requireReportsAccess, (req, res) => {
  const {clause, params} = scopeClause(req.user, [CYCLE]);
  const rows = db.prepare(`
    SELECT u.emp_no, u.name, u.designation, u.company, u.grade,
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
  `).all(...params);

  const out = [];
  out.push(csvRow(['Emp No','Name','Designation','Grade','Company','Manager',
    'System Rating','Override Rating','Final Rating',
    'Overall Score','Self: What Went Well','Self: Areas to Improve','Self: Support Needed',
    'Manager Comments','Manager Strengths','Manager Development',
    'Self Submitted','Manager Submitted','Promotion Recommended','Promotion Justification']));
  rows.forEach(r => {
    out.push(csvRow([
      r.emp_no, r.name, r.designation, r.grade, r.company, r.manager,
      r.system_rating || '', r.override_rating || '', r.final_rating || '',
      r.overall_score || '', r.self_went_well || '', r.self_improve || '', r.self_support_needed || '',
      r.mgr_comments || '', r.mgr_strengths || '', r.mgr_develop || '',
      r.self_submitted_at ? new Date(r.self_submitted_at*1000).toISOString().slice(0,10) : '',
      r.mgr_submitted_at  ? new Date(r.mgr_submitted_at*1000).toISOString().slice(0,10)  : '',
      r.promo_recommended ? 'Yes' : 'No',
      r.promo_justification || ''
    ]));
  });
  sendCSV(res, `acorn-year-end-summary-${CYCLE}.csv`, out);
});

// GET /api/export/calibration-sheet
router.get('/export/calibration-sheet', requireReportsAccess, (req, res) => {
  const {clause, params} = scopeClause(req.user, [CYCLE]);
  const rows = db.prepare(`
    SELECT u.emp_no, u.name, u.designation, u.grade, u.company, u.cluster,
           m.name as manager,
           r_mid.overall_score as mid_score, r_mid.system_rating as mid_sys,
           r_mid.override_rating as mid_override, r_mid.final_rating as mid_final,
           r_ye.overall_score as ye_score, r_ye.system_rating as ye_sys,
           r_ye.override_rating as ye_override, r_ye.final_rating as ye_final,
           cal.name as calibrated_by_name, r_mid.calibrated_at
    FROM users u
    LEFT JOIN users m ON u.reports_to = m.emp_no
    LEFT JOIN goal_sheets gs ON gs.emp_no = u.emp_no AND gs.cycle = ?
    LEFT JOIN reviews r_mid ON r_mid.sheet_id = gs.id AND r_mid.review_type = 'mid_year'
    LEFT JOIN reviews r_ye  ON r_ye.sheet_id  = gs.id AND r_ye.review_type  = 'year_end'
    LEFT JOIN users cal ON r_mid.calibrated_by = cal.emp_no
    WHERE u.is_active = 1${clause}
    ORDER BY u.cluster, u.company, u.name
  `).all(...params);

  const out = [];
  out.push(csvRow(['Emp No','Name','Designation','Grade','Company','Cluster','Manager',
    'Mid-Year Score','Mid-Year System','Mid-Year Override','Mid-Year Final',
    'Year-End Score','Year-End System','Year-End Override','Year-End Final',
    'Calibrated By','Calibrated At']));
  rows.forEach(r => {
    out.push(csvRow([
      r.emp_no, r.name, r.designation, r.grade, r.company, r.cluster, r.manager,
      r.mid_score || '', r.mid_sys || '', r.mid_override || '', r.mid_final || '',
      r.ye_score  || '', r.ye_sys  || '', r.ye_override  || '', r.ye_final  || '',
      r.calibrated_by_name || '',
      r.calibrated_at ? new Date(r.calibrated_at*1000).toISOString().slice(0,10) : ''
    ]));
  });
  sendCSV(res, `acorn-calibration-sheet-${CYCLE}.csv`, out);
});

// GET /api/export/company-grading  — per-company A–E breakdown both phases
router.get('/export/company-grading', requireReportsAccess, (req, res) => {
  const {clause, params: scopeParams} = scopeClause(req.user, []);
  const phases = ['mid_year', 'year_end'];
  const out = [];
  out.push(csvRow(['Company','Phase','Total Reviewed','A – Exceptional','B – Strong','C – Competent','D – Inconsistent','E – Below Expectations','% A+B (High Performers)']));
  phases.forEach(phase => {
    const rows = db.prepare(`
      SELECT u.company,
             SUM(CASE WHEN r.final_rating='A' THEN 1 ELSE 0 END) as rA,
             SUM(CASE WHEN r.final_rating='B' THEN 1 ELSE 0 END) as rB,
             SUM(CASE WHEN r.final_rating='C' THEN 1 ELSE 0 END) as rC,
             SUM(CASE WHEN r.final_rating='D' THEN 1 ELSE 0 END) as rD,
             SUM(CASE WHEN r.final_rating='E' THEN 1 ELSE 0 END) as rE,
             COUNT(r.id) as total
      FROM users u
      JOIN goal_sheets gs ON gs.emp_no = u.emp_no AND gs.cycle = ?
      JOIN reviews r ON r.sheet_id = gs.id AND r.review_type = ? AND r.final_rating IS NOT NULL
      WHERE u.is_active = 1${clause}
      GROUP BY u.company ORDER BY u.company
    `).all(CYCLE, phase, ...scopeParams);
    rows.forEach(r => {
      const hi = r.total > 0 ? Math.round((r.rA + r.rB) / r.total * 100) : 0;
      out.push(csvRow([r.company, phase === 'mid_year' ? 'Mid-Year' : 'Year-End',
        r.total, r.rA, r.rB, r.rC, r.rD, r.rE, hi + '%']));
    });
  });
  sendCSV(res, `acorn-company-grading-${CYCLE}.csv`, out);
});

// GET /api/export/employee-directory
router.get('/export/employee-directory', requireReportsAccess, (req, res) => {
  const {clause, params: scopeParams} = scopeClause(req.user, []);
  const rows = db.prepare(`
    SELECT u.emp_no, u.name, u.designation, u.grade, u.dept, u.company, u.division, u.cluster,
           u.role, m.name as manager, m.emp_no as manager_emp_no
    FROM users u
    LEFT JOIN users m ON u.reports_to = m.emp_no
    WHERE u.is_active = 1${clause}
    ORDER BY u.cluster, u.company, u.dept, u.name
  `).all(...scopeParams);
  const out = [];
  out.push(csvRow(['Emp No','Name','Designation','Grade','Department','Company','Division','Cluster','System Role','Manager Name','Manager Emp No']));
  rows.forEach(r => {
    out.push(csvRow([r.emp_no, r.name, r.designation, r.grade, r.dept, r.company,
      r.division, r.cluster, r.role, r.manager || '', r.manager_emp_no || '']));
  });
  sendCSV(res, `acorn-employee-directory.csv`, out);
});

// GET /api/reports/grading-data — JSON for the reports page grading table
// GET /api/reports/goal-drill?company=X
router.get('/reports/goal-drill', requireReportsAccess, (req, res) => {
  const { company } = req.query;
  if (!company) return res.status(400).json({ error: 'company required' });
  const {clause, params} = scopeClause(req.user, [CYCLE, company]);
  const rows = db.prepare(`
    SELECT u.emp_no, u.name, u.designation, u.grade,
           m.name as manager,
           gs.status as goal_status,
           gs.submitted_at, gs.approved_at
    FROM users u
    LEFT JOIN users m ON u.reports_to = m.emp_no
    LEFT JOIN goal_sheets gs ON gs.emp_no = u.emp_no AND gs.cycle = ?
    WHERE u.is_active = 1 AND u.company = ?${clause}
    ORDER BY u.name
  `).all(...params);
  res.json(rows);
});

// GET /api/reports/company-drill?company=X&phase=mid_year|year_end
router.get('/reports/company-drill', requireReportsAccess, (req, res) => {
  const { company, phase } = req.query;
  if (!company || !phase) return res.status(400).json({ error: 'company and phase required' });
  const {clause, params} = scopeClause(req.user, [CYCLE, phase, company]);
  const rows = db.prepare(`
    SELECT u.emp_no, u.name, u.designation, u.grade,
           m.name as manager,
           gs.status as goal_status,
           r.status as review_status,
           r.self_submitted_at, r.mgr_submitted_at,
           r.overall_score, r.system_rating, r.final_rating
    FROM users u
    LEFT JOIN users m ON u.reports_to = m.emp_no
    LEFT JOIN goal_sheets gs ON gs.emp_no = u.emp_no AND gs.cycle = ?
    LEFT JOIN reviews r ON r.sheet_id = gs.id AND r.review_type = ?
    WHERE u.is_active = 1 AND u.company = ?${clause}
    ORDER BY u.name
  `).all(...params);
  res.json(rows);
});

router.get('/reports/grading-data', requireReportsAccess, (req, res) => {
  const {clause, params: scopeParams} = scopeClause(req.user, []);
  const phases = ['mid_year', 'year_end'];
  const result = {};
  phases.forEach(phase => {
    const rows = db.prepare(`
      SELECT u.company,
             SUM(CASE WHEN COALESCE(r.final_rating, r.system_rating)='A' THEN 1 ELSE 0 END) as rA,
             SUM(CASE WHEN COALESCE(r.final_rating, r.system_rating)='B' THEN 1 ELSE 0 END) as rB,
             SUM(CASE WHEN COALESCE(r.final_rating, r.system_rating)='C' THEN 1 ELSE 0 END) as rC,
             SUM(CASE WHEN COALESCE(r.final_rating, r.system_rating)='D' THEN 1 ELSE 0 END) as rD,
             SUM(CASE WHEN COALESCE(r.final_rating, r.system_rating)='E' THEN 1 ELSE 0 END) as rE,
             COUNT(r.id) as total
      FROM users u
      JOIN goal_sheets gs ON gs.emp_no = u.emp_no AND gs.cycle = ?
      JOIN reviews r ON r.sheet_id = gs.id AND r.review_type = ?
        AND COALESCE(r.final_rating, r.system_rating) IS NOT NULL
      WHERE u.is_active = 1${clause}
      GROUP BY u.company ORDER BY u.company
    `).all(CYCLE, phase, ...scopeParams);
    result[phase] = rows;
  });

  // Org-wide distributions for bar charts
  const dist = {};
  phases.forEach(phase => {
    const rows = db.prepare(`
      SELECT COALESCE(r.final_rating, r.system_rating) as rating, COUNT(*) as cnt
      FROM reviews r
      JOIN goal_sheets gs ON r.sheet_id = gs.id AND gs.cycle = ?
      JOIN users u ON u.emp_no = gs.emp_no
      WHERE r.review_type = ? AND COALESCE(r.final_rating, r.system_rating) IS NOT NULL${clause}
      GROUP BY 1 ORDER BY 1
    `).all(CYCLE, phase, ...scopeParams);
    const total = rows.reduce((s,r) => s+r.cnt, 0);
    dist[phase] = {total, byRating: {}};
    rows.forEach(r => { dist[phase].byRating[r.rating] = r.cnt; });
  });

  // Appraisal submission status per company per phase
  const reviewStatus = {};
  phases.forEach(phase => {
    const rows = db.prepare(`
      SELECT u.company,
             COUNT(u.emp_no) as headcount,
             SUM(CASE WHEN r.id IS NOT NULL THEN 1 ELSE 0 END) as has_review,
             SUM(CASE WHEN r.mgr_submitted_at IS NOT NULL THEN 1 ELSE 0 END) as mgr_submitted,
             SUM(CASE WHEN r.self_submitted_at IS NOT NULL AND r.mgr_submitted_at IS NULL THEN 1 ELSE 0 END) as self_only,
             SUM(CASE WHEN r.id IS NOT NULL AND r.self_submitted_at IS NULL THEN 1 ELSE 0 END) as in_progress,
             SUM(CASE WHEN r.id IS NULL AND gs.id IS NOT NULL THEN 1 ELSE 0 END) as not_started_goals,
             SUM(CASE WHEN gs.id IS NULL THEN 1 ELSE 0 END) as no_goals
      FROM users u
      LEFT JOIN goal_sheets gs ON gs.emp_no = u.emp_no AND gs.cycle = ?
      LEFT JOIN reviews r ON r.sheet_id = gs.id AND r.review_type = ?
      WHERE u.is_active = 1${clause}
      GROUP BY u.company ORDER BY u.company
    `).all(CYCLE, phase, ...scopeParams);
    reviewStatus[phase] = rows;
  });

  res.json({ byCompany: result, distribution: dist, reviewStatus });
});

// GET /api/reports/stats — summary stats for the reports page
// Accessible to sbu_head (own cluster), exco + hr_admin (all)
router.get('/reports/stats', requireReportsAccess, (req, res) => {
  const {clause, params: scopeParams} = scopeClause(req.user, []);
  const clusterFilter = clause; // " AND u.cluster = ?" or ""

  const total_users = scopeParams.length
    ? db.prepare(`SELECT COUNT(*) as n FROM users u WHERE u.is_active=1${clusterFilter}`).get(...scopeParams).n
    : db.prepare('SELECT COUNT(*) as n FROM users WHERE is_active=1').get().n;

  const by_company = db.prepare(`
    SELECT u.company,
           COUNT(*) as n,
           SUM(CASE WHEN u.last_login IS NOT NULL AND u.must_change_pw=0 THEN 1 ELSE 0 END) as activated_n,
           SUM(CASE WHEN u.last_login IS NULL OR u.must_change_pw=1 THEN 1 ELSE 0 END) as not_activated_n,
           SUM(CASE WHEN gs.status='approved'  THEN 1 ELSE 0 END) as approved_n,
           SUM(CASE WHEN gs.status='submitted' THEN 1 ELSE 0 END) as submitted_n,
           SUM(CASE WHEN gs.status='draft'     THEN 1 ELSE 0 END) as draft_n
    FROM users u
    LEFT JOIN goal_sheets gs ON gs.emp_no=u.emp_no AND gs.cycle=?
    WHERE u.is_active=1${clusterFilter}
    GROUP BY u.company ORDER BY u.company
  `).all(CYCLE, ...scopeParams);

  const goal_stats = db.prepare(`
    SELECT gs.status, COUNT(*) as n
    FROM goal_sheets gs
    JOIN users u ON u.emp_no = gs.emp_no
    WHERE gs.cycle=? AND u.is_active=1${clusterFilter}
    GROUP BY gs.status
  `).all(CYCLE, ...scopeParams);

  res.json({ total_users, by_company, goal_stats });
});

module.exports = router;

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

  // Auto-close only based on dates — HR must manually open, dates only force-close
  const today = new Date().toISOString().slice(0,10);
  let changed = false;
  if (s.gs_start && s.gs_end) {
    // Force close if outside window; never force open
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

