/**
 * routes/auth.js
 * Login, logout, change-password, reset-password.
 */

const express = require('express');
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const db      = require('../db/database');
const { JWT_SECRET, JWT_EXPIRES, verifyToken } = require('../middleware/auth');

const router = express.Router();

const SALT_ROUNDS     = 12;
const SESSION_SECONDS = 8 * 60 * 60;   // 8 hours
const MAX_ATTEMPTS    = 5;             // lock after 5 failed attempts
const LOCK_SECONDS    = 15 * 60;       // 15-minute lockout

// ─────────────────────────────────────────────────────────────
// POST /auth/login
// Body: { emp_no, password }
// ─────────────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  try {
  const { emp_no, password } = req.body;

  if (!emp_no || !password) {
    return res.status(400).json({ error: 'Employee number and password are required.' });
  }

  const empNo = parseInt(emp_no);
  if (isNaN(empNo)) {
    return res.status(400).json({ error: 'Invalid employee number.' });
  }

  const user = db.prepare('SELECT * FROM users WHERE emp_no = ?').get(empNo);

  if (!user) {
    return res.status(401).json({ error: 'Invalid employee number or password.' });
  }

  if (!user.is_active) {
    return res.status(403).json({ error: 'Account is disabled. Please contact HR.' });
  }

  // Check account lockout
  const now = Math.floor(Date.now() / 1000);
  if (user.locked_until && user.locked_until > now) {
    const remaining = Math.ceil((user.locked_until - now) / 60);
    return res.status(429).json({
      error: `Account locked due to too many failed attempts. Try again in ${remaining} minute(s).`
    });
  }

  // Account not activated yet (no password set)
  if (!user.password_hash) {
    return res.status(401).json({
      error: 'Account not yet activated. Please use the temporary password sent by HR.',
      code: 'NOT_ACTIVATED'
    });
  }

  // Verify password
  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) {
    const newAttempts = user.failed_attempts + 1;
    let lockUntil = null;
    if (newAttempts >= MAX_ATTEMPTS) {
      lockUntil = now + LOCK_SECONDS;
    }
    db.prepare(
      'UPDATE users SET failed_attempts = ?, locked_until = ?, updated_at = ? WHERE emp_no = ?'
    ).run(newAttempts, lockUntil, now, empNo);

    db.logAudit(user.id, 'login_failed', 'auth', null,
      { emp_no: empNo, attempts: newAttempts }, req.ip);

    const remaining = MAX_ATTEMPTS - newAttempts;
    if (remaining <= 0) {
      return res.status(429).json({
        error: `Too many failed attempts. Account locked for 15 minutes.`
      });
    }
    return res.status(401).json({
      error: `Invalid password. ${remaining} attempt(s) remaining before lockout.`
    });
  }

  // ── Successful login ─────────────────────────────────────
  // Reset failed attempts, update last login
  db.prepare(
    'UPDATE users SET failed_attempts = 0, locked_until = NULL, last_login = ?, updated_at = ? WHERE emp_no = ?'
  ).run(now, now, empNo);

  // Create session
  const sessionId  = uuidv4();
  const expiresAt  = now + SESSION_SECONDS;
  db.prepare(
    'INSERT INTO sessions(id, user_id, created_at, expires_at, ip, user_agent) VALUES(?,?,?,?,?,?)'
  ).run(sessionId, user.id, now, expiresAt, req.ip, req.headers['user-agent']?.slice(0, 200));

  // Sign JWT (contains session ID, not sensitive data)
  const token = jwt.sign({ sid: sessionId, emp: empNo }, JWT_SECRET, { expiresIn: JWT_EXPIRES });

  // Set HTTP-only cookie
  res.cookie('pms_token', token, {
    httpOnly: true,
    secure:   process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge:   SESSION_SECONDS * 1000,
  });

  db.logAudit(user.id, 'login_success', 'auth', null, { emp_no: empNo }, req.ip);

  res.json({
    success: true,
    must_change_pw: !!user.must_change_pw,
    user: {
      emp_no:      user.emp_no,
      name:        user.name,
      designation: user.designation,
      grade:       user.grade,
      dept:        user.dept,
      company:     user.company,
      division:    user.division,
      reports_to:  user.reports_to,
      role:        user.role,
    }
  });
  } catch(err) {
    console.error('Login route error:', err);
    res.status(500).json({ error: 'Login error: ' + err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /auth/logout
// ─────────────────────────────────────────────────────────────
router.post('/logout', verifyToken, (req, res) => {
  // Revoke session from DB
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND id = ?')
    .run(req.user.id, req.cookies?.pms_token ? jwt.decode(req.cookies.pms_token)?.sid : '');
  res.clearCookie('pms_token');
  db.logAudit(req.user.id, 'logout', 'auth', null, null, req.ip);
  res.json({ success: true });
});

// ─────────────────────────────────────────────────────────────
// POST /auth/change-password
// Body: { current_password, new_password, confirm_password }
// ─────────────────────────────────────────────────────────────
router.post('/change-password', verifyToken, async (req, res) => {
  try {
  const { current_password, new_password, confirm_password } = req.body;

  if (!current_password || !new_password || !confirm_password) {
    return res.status(400).json({ error: 'All fields are required.' });
  }

  if (new_password !== confirm_password) {
    return res.status(400).json({ error: 'New passwords do not match.' });
  }

  const pwErr = validatePassword(new_password);
  if (pwErr) return res.status(400).json({ error: pwErr });

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  const valid = await bcrypt.compare(current_password, user.password_hash);
  if (!valid) {
    return res.status(401).json({ error: 'Current password is incorrect.' });
  }

  const hash = await bcrypt.hash(new_password, SALT_ROUNDS);
  db.prepare(
    'UPDATE users SET password_hash = ?, must_change_pw = 0, updated_at = ? WHERE id = ?'
  ).run(hash, Math.floor(Date.now() / 1000), req.user.id);

  db.logAudit(req.user.id, 'password_changed', 'user', req.user.id, null, req.ip);
  res.json({ success: true, message: 'Password changed successfully.' });
  } catch(err) {
    console.error('Change-password error:', err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /auth/reset-password-request
// Body: { emp_no }
// HR uses this to generate a temp token for an employee
// (In production this would email the token; here it returns it for HR to share)
// ─────────────────────────────────────────────────────────────
router.post('/reset-password-request', verifyToken, async (req, res) => {
  // Only HR admins or self can request a reset
  const { emp_no } = req.body;
  const targetEmpNo = parseInt(emp_no);

  if (req.user.role !== 'hr_admin' && req.user.emp_no !== targetEmpNo) {
    return res.status(403).json({ error: 'Only HR can reset other users\' passwords.' });
  }

  const user = db.prepare('SELECT * FROM users WHERE emp_no = ?').get(targetEmpNo);
  if (!user) return res.status(404).json({ error: 'Employee not found.' });

  // Generate a 6-digit token (simple for internal use)
  const token   = Math.floor(100000 + Math.random() * 900000).toString();
  const expiry  = Math.floor(Date.now() / 1000) + (24 * 60 * 60); // 24 hours
  const hash    = await bcrypt.hash(token, SALT_ROUNDS);

  db.prepare(
    'UPDATE users SET temp_token = ?, temp_token_expiry = ?, updated_at = ? WHERE emp_no = ?'
  ).run(hash, expiry, Math.floor(Date.now() / 1000), targetEmpNo);

  db.logAudit(req.user.id, 'reset_token_generated', 'user', user.id,
    { target_emp: targetEmpNo, by: req.user.emp_no }, req.ip);

  // In production: send token via email.
  // For now: return it to HR admin to share with employee manually.
  res.json({
    success: true,
    message: `Reset token generated for ${user.name}.`,
    temp_token: token,                          // HR shares this with employee
    instructions: `Tell ${user.name} to log in with Emp No ${targetEmpNo} and this 6-digit token. Token expires in 24 hours.`,
    expires: new Date(expiry * 1000).toLocaleString(),
  });
});

// ─────────────────────────────────────────────────────────────
// POST /auth/reset-password-confirm
// Body: { emp_no, token, new_password, confirm_password }
// ─────────────────────────────────────────────────────────────
router.post('/reset-password-confirm', async (req, res) => {
  const { emp_no, token, new_password, confirm_password } = req.body;

  if (!emp_no || !token || !new_password || !confirm_password) {
    return res.status(400).json({ error: 'All fields are required.' });
  }

  if (new_password !== confirm_password) {
    return res.status(400).json({ error: 'Passwords do not match.' });
  }

  const pwErr = validatePassword(new_password);
  if (pwErr) return res.status(400).json({ error: pwErr });

  const user = db.prepare('SELECT * FROM users WHERE emp_no = ?').get(parseInt(emp_no));
  if (!user || !user.temp_token) {
    return res.status(400).json({ error: 'Invalid or expired reset token.' });
  }

  const now = Math.floor(Date.now() / 1000);
  if (user.temp_token_expiry < now) {
    return res.status(400).json({ error: 'Reset token has expired. Ask HR to generate a new one.' });
  }

  const tokenValid = await bcrypt.compare(token, user.temp_token);
  if (!tokenValid) {
    return res.status(400).json({ error: 'Invalid reset token.' });
  }

  const hash = await bcrypt.hash(new_password, SALT_ROUNDS);
  db.prepare(
    `UPDATE users SET password_hash = ?, must_change_pw = 0,
     temp_token = NULL, temp_token_expiry = NULL,
     failed_attempts = 0, locked_until = NULL, updated_at = ?
     WHERE emp_no = ?`
  ).run(hash, now, parseInt(emp_no));

  db.logAudit(user.id, 'password_reset', 'user', user.id, null, req.ip);
  res.json({ success: true, message: 'Password reset successfully. You can now log in.' });
});

// ─────────────────────────────────────────────────────────────
// GET /auth/me — return current user info
// ─────────────────────────────────────────────────────────────
router.get('/me', verifyToken, (req, res) => {
  const user = db.prepare(
    `SELECT emp_no, name, designation, grade, dept, company, division,
            reports_to, role, must_change_pw, last_login
     FROM users WHERE id = ?`
  ).get(req.user.id);
  res.json(user);
});

// ─────────────────────────────────────────────────────────────
// Password policy validator
// ─────────────────────────────────────────────────────────────
function validatePassword(pw) {
  if (pw.length < 8)                     return 'Password must be at least 8 characters.';
  if (!/[A-Z]/.test(pw))                 return 'Password must contain at least one uppercase letter.';
  if (!/[a-z]/.test(pw))                 return 'Password must contain at least one lowercase letter.';
  if (!/[0-9]/.test(pw))                 return 'Password must contain at least one number.';
  if (!/[^A-Za-z0-9]/.test(pw))          return 'Password must contain at least one special character (!@#$%^&* etc).';
  return null;
}


// ─────────────────────────────────────────────────────────────
// POST /auth/set-password
// For first-login forced password change — no current password needed
// (user is already authenticated via cookie/JWT from login)
// Body: { new_password, confirm_password }
// ─────────────────────────────────────────────────────────────
router.post('/set-password', verifyToken, async (req, res) => {
  try {
    const { new_password, confirm_password } = req.body;

    if (!new_password || !confirm_password) {
      return res.status(400).json({ error: 'Both password fields are required.' });
    }
    if (new_password !== confirm_password) {
      return res.status(400).json({ error: 'Passwords do not match.' });
    }
    if (new_password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    }

    const hash = await bcrypt.hash(new_password, SALT_ROUNDS);
    db.prepare(
      'UPDATE users SET password_hash = ?, must_change_pw = 0, updated_at = ? WHERE id = ?'
    ).run(hash, Math.floor(Date.now() / 1000), req.user.id);

    db.logAudit(req.user.id, 'password_set', 'user', req.user.id, null, req.ip);
    res.json({ success: true });
  } catch(err) {
    console.error('Set-password error:', err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
});

module.exports = router;
