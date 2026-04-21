/**
 * scripts/reset-password.js
 * HR Admin CLI tool: reset an employee's password from the terminal.
 *
 * Usage:
 *   node scripts/reset-password.js <emp_no>
 *
 * This generates a 6-digit one-time token that HR gives to the employee.
 * The employee then uses "Forgot Password" on the login page.
 */

const bcrypt = require('bcryptjs');
const db     = require('../db/database');

// Main runs after db is ready
async function main() {
  await db.init();

const empNo = parseInt(process.argv[2]);

if (!empNo || isNaN(empNo)) {
  console.log('\n  Usage: node scripts/reset-password.js <emp_no>');
  console.log('  Example: node scripts/reset-password.js 20406\n');
  process.exit(1);
}

const user = db.prepare('SELECT * FROM users WHERE emp_no = ?').get(empNo);
if (!user) {
  console.log(`\n  ✗  Employee ${empNo} not found in database.\n`);
  process.exit(1);
}

// Generate 6-digit token
const token  = Math.floor(100000 + Math.random() * 900000).toString();
const expiry = Math.floor(Date.now()/1000) + (24 * 60 * 60);
const hash   = bcrypt.hashSync(token, 12);

db.prepare('UPDATE users SET temp_token = ?, temp_token_expiry = ?, updated_at = ? WHERE emp_no = ?')
  .run(hash, expiry, Math.floor(Date.now()/1000), empNo);

console.log('\n  ─────────────────────────────────────────────────');
console.log(`  Password Reset Token for ${user.name}`);
console.log('  ─────────────────────────────────────────────────');
console.log(`  Employee:   ${user.name}`);
console.log(`  Emp No:     ${empNo}`);
console.log(`  Company:    ${user.company}`);
console.log(`  Token:      ${token}`);
console.log(`  Expires:    ${new Date(expiry*1000).toLocaleString('en-GB')}`);
console.log('');
console.log('  Instructions for employee:');
console.log(`  1. Go to the PMS login page`);
console.log(`  2. Click "Forgot Password?"`);
console.log(`  3. Enter Emp No: ${empNo}`);
console.log(`  4. Enter this 6-digit token: ${token}`);
console.log(`  5. Set a new password`);
console.log('  ─────────────────────────────────────────────────\n');
}

main().catch(err => { console.error(err); process.exit(1); });
