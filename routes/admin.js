/**
 * routes/admin.js
 * HR Admin: user management, bulk activation, audit logs.
 * All routes require hr_admin role.
 */

const express = require('express');
const bcrypt  = require('bcryptjs');
const db      = require('../db/database');
const { verifyToken, requireHR } = require('../middleware/auth');

const router     = express.Router();
const SALT_ROUNDS = 12;

// All admin routes require auth + HR role
router.use(verifyToken, requireHR);

// ─────────────────────────────────────────────────────────────
// GET /admin/users — list all users with status
// ─────────────────────────────────────────────────────────────
router.get('/users', (req, res) => {
  const { company, role, status, q } = req.query;
  let sql = `SELECT u.emp_no, u.name, u.designation, u.grade, u.dept,
                    u.company, u.division, u.role, u.is_active,
                    u.must_change_pw, u.last_login, u.failed_attempts,
                    u.locked_until,
                    CASE WHEN u.password_hash IS NULL THEN 0 ELSE 1 END as activated,
                    m.name as manager_name
             FROM users u
             LEFT JOIN users m ON u.reports_to = m.emp_no
             WHERE 1=1`;
  const params = [];

  if (company) { sql += ' AND u.company = ?'; params.push(company); }
  if (role)    { sql += ' AND u.role = ?';    params.push(role); }
  if (status === 'active')    { sql += ' AND u.is_active = 1'; }
  if (status === 'inactive')  { sql += ' AND u.is_active = 0'; }
  if (status === 'locked')    { sql += ' AND u.locked_until > ?'; params.push(Math.floor(Date.now()/1000)); }
  if (status === 'not_activated') { sql += ' AND u.password_hash IS NULL'; }
  if (q) { sql += ' AND (u.name LIKE ? OR u.designation LIKE ?)'; params.push(`%${q}%`, `%${q}%`); }

  sql += ' ORDER BY u.company, u.name';
  const users = db.prepare(sql).all(...params);
  res.json(users);
});

// ─────────────────────────────────────────────────────────────
// GET /admin/users/:empNo — single user detail
// ─────────────────────────────────────────────────────────────
router.get('/users/:empNo', (req, res) => {
  const user = db.prepare(
    `SELECT u.*, m.name as manager_name FROM users u
     LEFT JOIN users m ON u.reports_to = m.emp_no
     WHERE u.emp_no = ?`
  ).get(parseInt(req.params.empNo));
  if (!user) return res.status(404).json({ error: 'User not found.' });
  // Never expose hash or token
  delete user.password_hash;
  delete user.temp_token;
  res.json(user);
});

// ─────────────────────────────────────────────────────────────
// PUT /admin/users/:empNo/role — update role
// Body: { role }
// ─────────────────────────────────────────────────────────────
router.put('/users/:empNo/role', (req, res) => {
  const { role } = req.body;
  const validRoles = ['employee','supervisor','manager','senior_manager','sbu_head','exco','hr_admin'];
  if (!validRoles.includes(role)) {
    return res.status(400).json({ error: 'Invalid role.' });
  }
  const result = db.prepare(
    'UPDATE users SET role = ?, updated_at = ? WHERE emp_no = ?'
  ).run(role, Math.floor(Date.now()/1000), parseInt(req.params.empNo));

  if (!result.changes) return res.status(404).json({ error: 'User not found.' });
  db.logAudit(req.user.id, 'role_updated', 'user', parseInt(req.params.empNo),
    { new_role: role }, req.ip);
  res.json({ success: true });
});

// ─────────────────────────────────────────────────────────────
// PUT /admin/users/:empNo/activate — set initial password for user
// Body: { temp_password }  (HR sets this, tells employee)
// ─────────────────────────────────────────────────────────────
router.put('/users/:empNo/activate', async (req, res) => {
  const { temp_password } = req.body;
  if (!temp_password || temp_password.length < 6) {
    return res.status(400).json({ error: 'Temporary password must be at least 6 characters.' });
  }

  const empNo = parseInt(req.params.empNo);
  const user  = db.prepare('SELECT * FROM users WHERE emp_no = ?').get(empNo);
  if (!user) return res.status(404).json({ error: 'User not found.' });

  const hash = await bcrypt.hash(temp_password, SALT_ROUNDS);
  db.prepare(
    `UPDATE users SET password_hash = ?, must_change_pw = 1,
     failed_attempts = 0, locked_until = NULL, updated_at = ?
     WHERE emp_no = ?`
  ).run(hash, Math.floor(Date.now()/1000), empNo);

  db.logAudit(req.user.id, 'account_activated', 'user', user.id,
    { by: req.user.emp_no }, req.ip);

  res.json({
    success: true,
    message: `Account activated for ${user.name}. They must change their password on first login.`,
    credentials: {
      emp_no:        empNo,
      temp_password: temp_password,
      note:          'Employee must change this password on first login.'
    }
  });
});

// ─────────────────────────────────────────────────────────────
// POST /admin/users/:empNo/generate-reset-token
// Generates a 6-digit one-time token HR shares with employee
// ─────────────────────────────────────────────────────────────
router.post('/users/:empNo/generate-reset-token', async (req, res) => {
  const empNo = parseInt(req.params.empNo);
  const user  = db.prepare('SELECT * FROM users WHERE emp_no = ?').get(empNo);
  if (!user) return res.status(404).json({ error: 'User not found.' });

  const token  = Math.floor(100000 + Math.random() * 900000).toString();
  const expiry = Math.floor(Date.now()/1000) + (24 * 60 * 60);
  const hash   = await bcrypt.hash(token, SALT_ROUNDS);

  db.prepare(
    'UPDATE users SET temp_token = ?, temp_token_expiry = ?, updated_at = ? WHERE emp_no = ?'
  ).run(hash, expiry, Math.floor(Date.now()/1000), empNo);

  db.logAudit(req.user.id, 'reset_token_generated', 'user', user.id,
    { target: empNo, by: req.user.emp_no }, req.ip);

  res.json({
    success: true,
    emp_no:        empNo,
    name:          user.name,
    reset_token:   token,
    expires:       new Date(expiry * 1000).toLocaleString('en-GB'),
    instructions:  `Give ${user.name} their Emp No (${empNo}) and this 6-digit token. They use "Forgot Password" on the login page. Token expires in 24 hours.`
  });
});

// ─────────────────────────────────────────────────────────────
// POST /admin/users/:empNo/unlock — unlock locked account
// ─────────────────────────────────────────────────────────────
router.post('/users/:empNo/unlock', (req, res) => {
  const empNo = parseInt(req.params.empNo);
  db.prepare(
    'UPDATE users SET failed_attempts = 0, locked_until = NULL, updated_at = ? WHERE emp_no = ?'
  ).run(Math.floor(Date.now()/1000), empNo);
  db.logAudit(req.user.id, 'account_unlocked', 'user', empNo, { by: req.user.emp_no }, req.ip);
  res.json({ success: true });
});

// ─────────────────────────────────────────────────────────────
// POST /admin/users/:empNo/deactivate | reactivate
// ─────────────────────────────────────────────────────────────
router.post('/users/:empNo/deactivate', (req, res) => {
  const empNo = parseInt(req.params.empNo);
  db.prepare('UPDATE users SET is_active = 0, updated_at = ? WHERE emp_no = ?')
    .run(Math.floor(Date.now()/1000), empNo);
  // Revoke all sessions
  db.prepare('DELETE FROM sessions WHERE user_id = (SELECT id FROM users WHERE emp_no = ?)')
    .run(empNo);
  db.logAudit(req.user.id, 'account_deactivated', 'user', empNo, null, req.ip);
  res.json({ success: true });
});

router.post('/users/:empNo/reactivate', (req, res) => {
  const empNo = parseInt(req.params.empNo);
  db.prepare('UPDATE users SET is_active = 1, updated_at = ? WHERE emp_no = ?')
    .run(Math.floor(Date.now()/1000), empNo);
  db.logAudit(req.user.id, 'account_reactivated', 'user', empNo, null, req.ip);
  res.json({ success: true });
});

// ─────────────────────────────────────────────────────────────
// POST /admin/bulk-activate — activate all users with same temp password
// Body: { temp_password, company? }  (optional company filter)
// ─────────────────────────────────────────────────────────────
router.post('/bulk-activate', async (req, res) => {
  const { temp_password, company } = req.body;
  if (!temp_password || temp_password.length < 6) {
    return res.status(400).json({ error: 'Temporary password must be at least 6 characters.' });
  }

  let sql = 'SELECT emp_no, name FROM users WHERE password_hash IS NULL AND is_active = 1';
  const params = [];
  if (company) { sql += ' AND company = ?'; params.push(company); }

  const toActivate = db.prepare(sql).all(...params);
  const hash = await bcrypt.hash(temp_password, SALT_ROUNDS);
  const now  = Math.floor(Date.now()/1000);

  const activate = db.prepare(
    'UPDATE users SET password_hash = ?, must_change_pw = 1, updated_at = ? WHERE emp_no = ?'
  );
  const activateMany = db.transaction(users => {
    users.forEach(u => activate.run(hash, now, u.emp_no));
  });
  activateMany(toActivate);

  db.logAudit(req.user.id, 'bulk_activation', 'user', null,
    { count: toActivate.length, company: company || 'all' }, req.ip);

  res.json({
    success: true,
    activated: toActivate.length,
    message: `${toActivate.length} accounts activated with temporary password. All must change password on first login.`,
    temp_password,
    employees: toActivate.map(u => u.name),
  });
});

// ─────────────────────────────────────────────────────────────
// GET /admin/audit-log
// ─────────────────────────────────────────────────────────────
router.get('/audit-log', (req, res) => {
  const { limit = 100, offset = 0, user_id, action } = req.query;
  let sql = `SELECT a.*, u.name as user_name, u.emp_no
             FROM audit_log a LEFT JOIN users u ON a.user_id = u.id
             WHERE 1=1`;
  const params = [];
  if (user_id) { sql += ' AND a.user_id = ?'; params.push(parseInt(user_id)); }
  if (action)  { sql += ' AND a.action LIKE ?'; params.push(`%${action}%`); }
  sql += ' ORDER BY a.created_at DESC LIMIT ? OFFSET ?';
  params.push(parseInt(limit), parseInt(offset));

  const logs = db.prepare(sql).all(...params);
  res.json(logs);
});

// ─────────────────────────────────────────────────────────────
// GET /admin/stats — dashboard stats
// ─────────────────────────────────────────────────────────────
router.get('/stats', (req, res) => {
  const stats = {
    total_users:     db.prepare('SELECT COUNT(*) as n FROM users').get().n,
    active_users:    db.prepare('SELECT COUNT(*) as n FROM users WHERE is_active = 1').get().n,
    activated:       db.prepare('SELECT COUNT(*) as n FROM users WHERE password_hash IS NOT NULL').get().n,
    not_activated:   db.prepare('SELECT COUNT(*) as n FROM users WHERE password_hash IS NULL').get().n,
    locked:          db.prepare('SELECT COUNT(*) as n FROM users WHERE locked_until > ?').get(Math.floor(Date.now()/1000)).n,
    by_role:         db.prepare('SELECT role, COUNT(*) as n FROM users GROUP BY role').all(),
    by_company:      db.prepare('SELECT company, COUNT(*) as n FROM users GROUP BY company ORDER BY company').all(),
    goal_stats:      db.prepare("SELECT status, COUNT(*) as n FROM goal_sheets WHERE cycle='2025-26' GROUP BY status").all(),
    sessions_active: db.prepare('SELECT COUNT(*) as n FROM sessions WHERE expires_at > ?').get(Math.floor(Date.now()/1000)).n,
  };
  res.json(stats);
});

// ─────────────────────────────────────────────────────────────
// POST /admin/users — add a brand new employee/user
// Body: { emp_no, name, designation, grade, dept, company, division,
//         reports_to, role, temp_password? }
// ─────────────────────────────────────────────────────────────
router.post('/users', async (req, res) => {
  const { emp_no, name, designation, grade, dept, company, division,
          reports_to, role, temp_password } = req.body;

  if (!emp_no || !name || !company) {
    return res.status(400).json({ error: 'Employee number, name, and company are required.' });
  }

  const empNo = parseInt(emp_no);
  if (isNaN(empNo) || empNo <= 0) {
    return res.status(400).json({ error: 'Employee number must be a positive integer.' });
  }

  const validRoles = ['employee','supervisor','manager','senior_manager','sbu_head','exco','hr_admin'];
  const userRole = validRoles.includes(role) ? role : 'employee';

  // Check emp_no not already used
  const existing = db.prepare('SELECT emp_no FROM users WHERE emp_no = ?').get(empNo);
  if (existing) {
    return res.status(400).json({ error: `Employee number ${empNo} already exists.` });
  }

  // Get manager name if reports_to provided
  let reportsToName = null;
  if (reports_to) {
    const mgr = db.prepare('SELECT name FROM users WHERE emp_no = ?').get(parseInt(reports_to));
    reportsToName = mgr?.name || null;
  }

  const now = Math.floor(Date.now() / 1000);
  let passwordHash = null;
  let mustChange = 1;

  if (temp_password && temp_password.length >= 6) {
    passwordHash = require('bcryptjs').hashSync(temp_password, 12);
  }

  db.prepare(`INSERT INTO users
    (id, emp_no, name, designation, grade, dept, company, division,
     reports_to, reports_to_name, role, password_hash, must_change_pw,
     is_active, failed_attempts, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,1,0,?,?)`)
  .run(empNo, empNo, name, designation||null, grade||null, dept||null,
       company, division||null, reports_to ? parseInt(reports_to) : null,
       reportsToName, userRole, passwordHash, now, now);

  db.logAudit(req.user.id, 'user_created', 'user', empNo,
    { name, company, role: userRole, by: req.user.emp_no }, req.ip);

  res.json({
    success: true,
    message: `${name} (Emp ${empNo}) added successfully.`,
    activated: !!passwordHash,
    note: passwordHash
      ? `Account is active. Tell ${name} their Emp No is ${empNo} and temp password: ${temp_password}. They must change it on first login.`
      : `Account created but NOT yet activated. Go to User Management and click Activate to set a password.`
  });
});

// ─────────────────────────────────────────────────────────────
// DELETE /admin/users/:empNo — permanently delete a user
// Also removes their goal sheets, KRAs, KPIs, reviews
// ─────────────────────────────────────────────────────────────
router.delete('/users/:empNo', (req, res) => {
  const empNo = parseInt(req.params.empNo);
  const user  = db.prepare('SELECT * FROM users WHERE emp_no = ?').get(empNo);
  if (!user) return res.status(404).json({ error: 'User not found.' });

  // Safety: prevent deleting yourself
  if (empNo === req.user.emp_no) {
    return res.status(400).json({ error: 'You cannot delete your own account.' });
  }

  const now = Math.floor(Date.now() / 1000);

  // Delete cascade manually (sql.js doesn't enforce FK cascades)
  const sheets = db.prepare('SELECT id FROM goal_sheets WHERE emp_no = ?').all(empNo);
  sheets.forEach(s => {
    const kras = db.prepare('SELECT id FROM kras WHERE sheet_id = ?').all(s.id);
    kras.forEach(k => db.prepare('DELETE FROM kpis WHERE kra_id = ?').run(k.id));
    db.prepare('DELETE FROM kras WHERE sheet_id = ?').run(s.id);
    db.prepare('DELETE FROM reviews WHERE sheet_id = ?').run(s.id);
  });
  db.prepare('DELETE FROM goal_sheets WHERE emp_no = ?').run(empNo);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
  db.prepare('DELETE FROM users WHERE emp_no = ?').run(empNo);

  db.logAudit(req.user.id, 'user_deleted', 'user', empNo,
    { name: user.name, company: user.company, by: req.user.emp_no }, req.ip);

  res.json({ success: true, message: `${user.name} (Emp ${empNo}) permanently deleted.` });
});

// ─────────────────────────────────────────────────────────────
// PUT /admin/users/:empNo — update user profile fields
// ─────────────────────────────────────────────────────────────
router.put('/users/:empNo', (req, res) => {
  const empNo = parseInt(req.params.empNo);
  const user  = db.prepare('SELECT * FROM users WHERE emp_no = ?').get(empNo);
  if (!user) return res.status(404).json({ error: 'User not found.' });

  const { name, designation, grade, dept, company, division, reports_to } = req.body;
  const now = Math.floor(Date.now() / 1000);

  let reportsToName = user.reports_to_name;
  if (reports_to !== undefined) {
    const mgr = db.prepare('SELECT name FROM users WHERE emp_no = ?').get(parseInt(reports_to));
    reportsToName = mgr?.name || null;
  }

  db.prepare(`UPDATE users SET
    name = ?, designation = ?, grade = ?, dept = ?, company = ?,
    division = ?, reports_to = ?, reports_to_name = ?, updated_at = ?
    WHERE emp_no = ?`)
  .run(
    name ?? user.name,
    designation ?? user.designation,
    grade ?? user.grade,
    dept ?? user.dept,
    company ?? user.company,
    division ?? user.division,
    reports_to !== undefined ? (parseInt(reports_to) || null) : user.reports_to,
    reportsToName,
    now, empNo
  );

  db.logAudit(req.user.id, 'user_updated', 'user', empNo,
    { by: req.user.emp_no }, req.ip);

  res.json({ success: true });
});

module.exports = router;
