/**
 * middleware/auth.js
 * JWT verification + role-based access control middleware.
 */

const jwt = require('jsonwebtoken');
const db  = require('../db/database');

const JWT_SECRET  = process.env.JWT_SECRET  || 'acorn-pms-dev-secret-change-in-production';
const JWT_EXPIRES = process.env.JWT_EXPIRES || '8h';

// Role hierarchy (higher index = more access)
const ROLE_LEVELS = {
  employee:       1,
  supervisor:     2,
  manager:        3,
  senior_manager: 4,
  sbu_head:       5,
  exco:           6,
  hr_admin:       7,   // HR admins: full access + user management
};

/**
 * verifyToken — reads JWT from cookie or Authorization header.
 * Attaches req.user on success.
 */
function verifyToken(req, res, next) {
  // Try cookie first, then Authorization header
  let token = req.cookies?.pms_token;
  if (!token && req.headers.authorization?.startsWith('Bearer ')) {
    token = req.headers.authorization.slice(7);
  }

  if (!token) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET);
  } catch (err) {
    res.clearCookie('pms_token');
    return res.status(401).json({ error: 'Session expired. Please log in again.' });
  }

  // Validate session still exists in DB (allows server-side logout / revocation)
  const session = db.prepare(
    `SELECT s.id, s.expires_at, u.id as user_id, u.emp_no, u.name, u.role,
            u.company, u.division, u.dept, u.designation, u.grade,
            u.reports_to, u.is_active, u.must_change_pw
     FROM sessions s JOIN users u ON s.user_id = u.id
     WHERE s.id = ? AND s.expires_at > ?`
  ).get(payload.sid, Math.floor(Date.now() / 1000));

  if (!session) {
    res.clearCookie('pms_token');
    return res.status(401).json({ error: 'Session expired or revoked. Please log in again.' });
  }

  if (!session.is_active) {
    return res.status(403).json({ error: 'Account is disabled. Contact HR.' });
  }

  req.user    = session;
  req.user.id = session.user_id;
  next();
}

/**
 * requireRole — ensures user's role level meets minimum.
 * Usage: router.get('/path', verifyToken, requireRole('manager'), handler)
 */
function requireRole(minRole) {
  return (req, res, next) => {
    const userLevel = ROLE_LEVELS[req.user?.role] || 0;
    const minLevel  = ROLE_LEVELS[minRole] || 0;
    if (userLevel < minLevel) {
      return res.status(403).json({ error: 'Access denied: insufficient permissions.' });
    }
    next();
  };
}

/**
 * requireHR — shortcut for HR admin only routes.
 */
function requireHR(req, res, next) {
  if (req.user?.role !== 'hr_admin') {
    return res.status(403).json({ error: 'HR Admin access required.' });
  }
  next();
}

/**
 * requireSelf — ensures user can only access their own data,
 * unless they are a manager+ (can access their reports' data)
 * or hr_admin (full access).
 */
function requireSelfOrManager(req, res, next) {
  const targetEmpNo = parseInt(req.params.empNo || req.body.empNo);
  const user        = req.user;

  // HR admin: always allowed
  if (user.role === 'hr_admin') return next();

  // Self: always allowed
  if (user.emp_no === targetEmpNo) return next();

  // Manager+: check if targetEmp is in their reporting hierarchy
  const isReport = isInHierarchy(targetEmpNo, user.emp_no);
  if (isReport && ROLE_LEVELS[user.role] >= ROLE_LEVELS['supervisor']) {
    return next();
  }

  return res.status(403).json({ error: 'You do not have access to this employee\'s data.' });
}

/**
 * isInHierarchy — checks if targetEmpNo reports (directly or indirectly) to managerEmpNo.
 */
function isInHierarchy(targetEmpNo, managerEmpNo, depth = 0) {
  if (depth > 10) return false;  // Safety: max hierarchy depth
  const emp = db.prepare('SELECT reports_to FROM users WHERE emp_no = ?').get(targetEmpNo);
  if (!emp || !emp.reports_to) return false;
  if (emp.reports_to === managerEmpNo) return true;
  return isInHierarchy(emp.reports_to, managerEmpNo, depth + 1);
}

module.exports = {
  verifyToken,
  requireRole,
  requireHR,
  requireSelfOrManager,
  isInHierarchy,
  JWT_SECRET,
  JWT_EXPIRES,
  ROLE_LEVELS,
};
