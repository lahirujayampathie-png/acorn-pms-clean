// ═══════════════════════════════════════════════════════════════
//  Acorn PMS — Notification Service with Email Queue
//  Handles in-app notifications and batched email delivery
//  Supports 300+ recipients without HTTP timeout
// ═══════════════════════════════════════════════════════════════

const cfg = require('./email.config');

let transporter = null;
let _db = null;  // set by initQueue(db)

// ── SMTP TRANSPORT ───────────────────────────────────────────────
function getMailer() {
  if (transporter) return transporter;
  if (!cfg.SMTP_ENABLED) return null;
  try {
    const nodemailer = require('nodemailer');
    transporter = nodemailer.createTransport({
      host:   cfg.SMTP_HOST,
      port:   cfg.SMTP_PORT,
      secure: cfg.SMTP_SECURE,
      auth:   { user: cfg.SMTP_USER, pass: cfg.SMTP_PASS },
      tls:    { rejectUnauthorized: false },
      pool:   true,        // reuse SMTP connection
      maxConnections: 5,   // max concurrent SMTP connections
      rateDelta: 1000,     // max 1 send per second per connection
      rateLimit: 5         // max 5 messages per rateDelta
    });
    console.log('  [Queue] SMTP transport ready');
    return transporter;
  } catch(e) {
    console.warn('  [Queue] nodemailer not available:', e.message);
    return null;
  }
}

// ── EMAIL TEMPLATE ───────────────────────────────────────────────
function emailTemplate(title, body, ctaText, ctaUrl) {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
body{font-family:Arial,sans-serif;background:#F3F4F6;margin:0;padding:20px}
.wrap{max-width:600px;margin:0 auto;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.1)}
.hdr{background:#1B2A4A;padding:24px 32px;color:#fff}
.hdr h1{margin:0;font-size:20px;font-weight:700}
.hdr p{margin:4px 0 0;font-size:12px;opacity:.7}
.body{padding:28px 32px;color:#374151;font-size:14px;line-height:1.6}
.cta{display:inline-block;margin:20px 0;padding:12px 28px;background:#1B2A4A;color:#fff;text-decoration:none;border-radius:6px;font-weight:600;font-size:14px}
.footer{background:#F9FAFB;padding:16px 32px;font-size:11px;color:#9CA3AF;border-top:1px solid #E5E7EB}
hr{border:none;border-top:1px solid #E5E7EB;margin:20px 0}
</style></head>
<body><div class="wrap">
  <div class="hdr">
    <h1>${cfg.COMPANY_NAME} PMS</h1>
    <p>Performance Management System — FY 2026-27</p>
  </div>
  <div class="body">
    <h2 style="margin-top:0;color:#111827">${title}</h2>
    ${body}
    ${ctaText && ctaUrl ? `<a href="${ctaUrl}" class="cta">${ctaText}</a>` : ''}
    <hr>
    <p style="font-size:12px;color:#6B7280">This is an automated message from the Acorn Group PMS. Do not reply. For support contact HR at ${cfg.REPLY_TO}</p>
  </div>
  <div class="footer">${cfg.COMPANY_NAME} &nbsp;·&nbsp; Performance Management System &nbsp;·&nbsp; FY 2026-27</div>
</div></body></html>`;
}

// ── IN-APP NOTIFICATION SAVE ─────────────────────────────────────
function saveNotification(db, empNo, type, title, message, link) {
  try {
    db.prepare(`INSERT INTO notifications(emp_no,type,title,message,link,created_at,is_read)
      VALUES(?,?,?,?,?,strftime('%s','now'),0)`)
      .run(empNo, type, title, message, link || null);
  } catch(e) {
    console.warn('  [Notifications] Could not save in-app notification:', e.message);
  }
}

// ── EMAIL QUEUE ──────────────────────────────────────────────────
// Initialise the queue table — called once on server start
function initQueue(db) {
  _db = db;
  db.prepare(`CREATE TABLE IF NOT EXISTS email_queue (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    emp_no      INTEGER,
    to_email    TEXT NOT NULL,
    subject     TEXT NOT NULL,
    html_body   TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'pending',
    attempts    INTEGER NOT NULL DEFAULT 0,
    last_error  TEXT,
    queued_at   INTEGER NOT NULL,
    sent_at     INTEGER,
    batch_id    TEXT
  )`).run();

  // Tracks which scheduled reminders have already fired — prevents re-sending every hour
  db.prepare(`CREATE TABLE IF NOT EXISTS sent_reminders (
    phase_key     TEXT NOT NULL,
    reminder_type TEXT NOT NULL,
    days_left     INTEGER,
    cycle         TEXT NOT NULL,
    sent_at       INTEGER NOT NULL,
    PRIMARY KEY (phase_key, reminder_type, days_left, cycle)
  )`).run();

  console.log('  [Queue] Email queue tables ready');
}

// Add emails to the queue — returns immediately
function queueEmails(db, recipients, subject, htmlBody, batchId) {
  const now = Math.floor(Date.now() / 1000);
  const insert = db.prepare(`
    INSERT INTO email_queue(emp_no, to_email, subject, html_body, status, attempts, queued_at, batch_id)
    VALUES(?, ?, ?, ?, 'pending', 0, ?, ?)
  `);
  const insertMany = db.transaction((recips) => {
    for (const r of recips) {
      if (r.email) insert.run(r.emp_no || null, r.email, subject, htmlBody, now, batchId || null);
    }
  });
  insertMany(recipients);
  const queued = recipients.filter(r => r.email).length;
  console.log(`  [Queue] Queued ${queued} emails (batch: ${batchId})`);
  return queued;
}

// Process the queue — called on interval
async function processQueue() {
  if (!_db) return;
  if (!cfg.SMTP_ENABLED) return;

  const BATCH = 10;   // process 10 at a time
  const MAX_ATTEMPTS = 3;

  // Pick pending or failed (retry) jobs
  const jobs = _db.prepare(`
    SELECT * FROM email_queue
    WHERE status = 'pending' OR (status = 'failed' AND attempts < ?)
    ORDER BY queued_at ASC LIMIT ?
  `).all(MAX_ATTEMPTS, BATCH);

  if (!jobs.length) return;

  console.log(`  [Queue] Processing ${jobs.length} emails...`);

  // Mark as sending
  const ids = jobs.map(j => j.id);
  _db.prepare(`UPDATE email_queue SET status='sending' WHERE id IN (${ids.map(() => '?').join(',')})`)
    .run(...ids);

  // Send in parallel
  await Promise.allSettled(jobs.map(async (job) => {
    try {
      await sendEmail(job.to_email, job.subject, job.html_body);
      _db.prepare(`UPDATE email_queue SET status='sent', sent_at=?, attempts=attempts+1, last_error=NULL WHERE id=?`)
        .run(Math.floor(Date.now() / 1000), job.id);
    } catch(e) {
      const newAttempts = job.attempts + 1;
      const newStatus = newAttempts >= MAX_ATTEMPTS ? 'failed' : 'pending';
      _db.prepare(`UPDATE email_queue SET status=?, attempts=?, last_error=? WHERE id=?`)
        .run(newStatus, newAttempts, e.message, job.id);
      console.error(`  [Queue] Failed → ${job.to_email} (attempt ${newAttempts}): ${e.message}`);
    }
  }));
}

// Queue stats — for HR dashboard
function getQueueStats(db) {
  try {
    return db.prepare(`
      SELECT
        SUM(CASE WHEN status='pending'  THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN status='sending'  THEN 1 ELSE 0 END) as sending,
        SUM(CASE WHEN status='sent'     THEN 1 ELSE 0 END) as sent,
        SUM(CASE WHEN status='failed'   THEN 1 ELSE 0 END) as failed
      FROM email_queue
      WHERE queued_at > strftime('%s','now') - 86400
    `).get();
  } catch(e) { return { pending:0, sending:0, sent:0, failed:0 }; }
}

// ── CORE NOTIFY DISPATCHER ───────────────────────────────────────
async function notify(db, type, recipients, data) {
  if (!cfg.NOTIFY[type] && cfg.NOTIFY[type] !== undefined) return;
  if (!recipients || !recipients.length) return;

  const portalUrl = cfg.PORTAL_URL;
  let subject = '', title = '', body = '', cta = '', ctaUrl = portalUrl, inAppMsg = '';

  // ── Message templates ────────────────────────────────────────
  switch(type) {
    case 'goal_setting_opened':
      subject  = `[Acorn PMS] Goal Setting is Now Open — FY 2026-27`;
      title    = 'Goal Setting is Now Open';
      body     = `<p>The goal-setting window for the <strong>FY 2026-27</strong> performance cycle is now open.</p>
                  <p>Please log in to Acorn 3.0 PMS to set your KRAs, KPIs and Initiatives. Your goals must be approved by your manager before the window closes.</p>`;
      cta      = 'Set My Goals Now →';
      inAppMsg = 'Goal setting is open. Please set and submit your goals for FY 2026-27.';
      break;
    case 'goals_pending_approval':
      subject  = `[Acorn PMS] Goal Approval Pending — Action Required`;
      title    = 'Goals Awaiting Your Approval';
      body     = `<p>One or more of your team members have submitted their goals for your approval.</p>
                  <p>Please log in and review their goal sheets at your earliest convenience.</p>`;
      cta      = 'Review Pending Approvals →';
      inAppMsg = 'A team member has submitted their goals for your approval.';
      break;
    case 'goal_approved':
      subject  = `[Acorn PMS] Your Goals Have Been Approved`;
      title    = 'Your Goals Are Approved';
      body     = `<p>Great news — your goals for <strong>FY 2026-27</strong> have been approved by your manager.</p>
                  <p>You can now start recording your monthly progress in the Monthly Tracker.</p>`;
      cta      = 'View My Goals →';
      inAppMsg = 'Your goals have been approved. You can now record monthly progress.';
      break;
    case 'goal_rejected':
      subject  = `[Acorn PMS] Your Goals Have Been Returned — Action Required`;
      title    = 'Your Goals Need Revision';
      body     = `<p>Your manager has returned your goals with comments. Please log in to review the feedback and resubmit.</p>`;
      cta      = 'Review & Resubmit →';
      inAppMsg = 'Your goals were returned by your manager. Please revise and resubmit.';
      break;
    case 'goal_change_requested':
      subject  = `[Acorn PMS] Goal Change Request Submitted`;
      title    = 'Goal Change Request';
      body     = `<p>A goal change request has been submitted${data?.emp_name ? ` by <strong>${data.emp_name}</strong>` : ''} and requires your review.</p>
                  ${data?.reason ? `<p><strong>Reason:</strong> ${data.reason}</p>` : ''}
                  ${data?.post_midyear ? `<p><strong>Note:</strong> This is a post-mid-year change request and requires HR sign-off after supervisor approval.</p>` : ''}`;
      cta      = 'Review Change Request →';
      inAppMsg = `Goal change request submitted${data?.emp_name ? ` by ${data.emp_name}` : ''}.`;
      break;
    case 'goal_change_approved':
      subject  = `[Acorn PMS] Your Goal Change Request Has Been Approved`;
      title    = 'Goal Change Approved';
      body     = `<p>Your goal change request has been approved. You can now log in and update your goals.</p>`;
      cta      = 'Update My Goals →';
      inAppMsg = 'Your goal change request has been approved. You can now edit your goals.';
      break;
    case 'goal_change_rejected':
      subject  = `[Acorn PMS] Your Goal Change Request Has Been Rejected`;
      title    = 'Goal Change Request Rejected';
      body     = `<p>Your goal change request has been reviewed and rejected.</p>
                  ${data?.reason ? `<p><strong>Reason:</strong> ${data.reason}</p>` : ''}`;
      cta      = 'View My Goals →';
      inAppMsg = 'Your goal change request was rejected.';
      break;
    case 'midyear_opened':
      subject  = `[Acorn PMS] Mid-Year Review is Now Open`;
      title    = 'Mid-Year Review is Open';
      body     = `<p>The mid-year review window for <strong>FY 2026-27</strong> is now open.</p>
                  <p>Please log in to complete your self-assessment. This includes recording your KPI progress and answering the three reflection questions.</p>
                  ${data?.deadline ? `<p><strong>Deadline:</strong> ${data.deadline}</p>` : ''}`;
      cta      = 'Start My Mid-Year Review →';
      inAppMsg = 'Mid-year review is open. Please complete your self-assessment.';
      break;
    case 'midyear_feedback_released':
      subject  = `[Acorn PMS] Your Mid-Year Feedback is Available`;
      title    = 'Mid-Year Feedback Available';
      body     = `<p>Your manager has completed their mid-year review and your feedback is now available to view.</p>`;
      cta      = 'View My Feedback →';
      inAppMsg = 'Your mid-year review feedback is now available.';
      break;
    case 'yearend_opened':
      subject  = `[Acorn PMS] Year-End Review is Now Open`;
      title    = 'Year-End Review is Open';
      body     = `<p>The year-end review window for <strong>FY 2026-27</strong> is now open.</p>
                  <p>Please complete your full self-assessment including KPI achievements, competency ratings, career aspirations and development goals.</p>
                  ${data?.deadline ? `<p><strong>Deadline:</strong> ${data.deadline}</p>` : ''}`;
      cta      = 'Start My Year-End Review →';
      inAppMsg = 'Year-end review is open. Please complete your full self-assessment.';
      break;
    case 'final_rating_published':
      subject  = `[Acorn PMS] Your Final Performance Rating is Available`;
      title    = 'Your Final Rating is Published';
      body     = `<p>Your final performance rating for <strong>FY 2026-27</strong> has been calibrated and published by HR.</p>
                  <p>Please log in to view your rating, manager feedback, and competency scores.</p>`;
      cta      = 'View My Rating →';
      inAppMsg = 'Your final performance rating for FY 2026-27 has been published.';
      break;
    case 'review_pushed_back':
      subject  = `[Acorn PMS] Your Review Has Been Returned — Action Required`;
      title    = 'Review Returned for Revision';
      body     = `<p>Your performance review has been returned by your manager for revision.</p>
                  ${data?.reason ? `<p><strong>Reason:</strong> ${data.reason}</p>` : ''}
                  <p>Please log in, make the necessary updates and resubmit.</p>`;
      cta      = 'Revise My Review →';
      inAppMsg = 'Your review was returned by your manager for revision.';
      break;
    case 'deadline_reminder':
      subject  = `[Acorn PMS] Reminder — ${data?.phase_name || 'Performance Review'} Deadline Approaching`;
      title    = `Reminder: ${data?.phase_name || 'Review'} Deadline`;
      body     = `<p>This is a reminder that the <strong>${data?.phase_name || 'performance review'}</strong> deadline is approaching.</p>
                  ${data?.deadline ? `<p><strong>Deadline: ${data.deadline}</strong></p>` : ''}
                  ${data?.days_left ? `<p>You have <strong>${data.days_left} day(s)</strong> remaining.</p>` : ''}
                  <p>Please log in and complete your submission as soon as possible.</p>`;
      cta      = 'Complete Now →';
      inAppMsg = `Reminder: ${data?.phase_name || 'Review'} deadline is approaching${data?.deadline ? ` (${data.deadline})` : ''}.`;
      break;
    case 'overdue_alert':
      subject  = `[Acorn PMS] Overdue Alert — ${data?.phase_name || 'Review'} Deadline Passed`;
      title    = `Overdue: ${data?.phase_name || 'Review'}`;
      body     = `<p>The deadline for <strong>${data?.phase_name || 'the performance review'}</strong> has passed.</p>
                  <p>Please contact HR immediately if you require an extension.</p>`;
      cta      = 'Log In Now →';
      inAppMsg = `The ${data?.phase_name || 'review'} deadline has passed. Please contact HR.`;
      break;
    default:
      subject  = `[Acorn PMS] Notification`;
      title    = 'Performance Management Update';
      body     = `<p>You have a new notification from the Acorn Group Performance Management System.</p>`;
      cta      = 'Log In →';
      inAppMsg = 'You have a new PMS notification.';
  }

  const html = emailTemplate(title, body, cta, ctaUrl);
  const batchId = `${type}_${Date.now()}`;

  // 1. Save all in-app notifications immediately (fast synchronous DB writes)
  for (const r of recipients) {
    saveNotification(db, r.emp_no, type, title, inAppMsg, ctaUrl);
  }

  // 2. Queue emails — returns immediately regardless of recipient count
  if (cfg.SMTP_ENABLED) {
    queueEmails(db, recipients, subject, html, batchId);
  }
}

// ── SCHEDULED REMINDERS ──────────────────────────────────────────
function startScheduler(db) {
  initQueue(db);
  console.log('  [Notifications] Scheduler started');

  // Process email queue every 10 seconds
  setInterval(processQueue, 10000);

  // Run phase deadline checks every hour
  setInterval(async () => {
    try { await runPhaseChecks(db); } catch(e) { console.error('[Scheduler]', e.message); }
  }, 60 * 60 * 1000);

  // Run once on startup after 30s delay
  setTimeout(() => runPhaseChecks(db).catch(() => {}), 30000);
}

async function runPhaseChecks(db) {
  const now   = Math.floor(Date.now() / 1000);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const REMINDER_DAYS = cfg.REMINDER_DAYS || [7, 3];
  const CYCLE = '2026-27';

  let cycle;
  try { cycle = db.prepare('SELECT * FROM cycle_settings WHERE cycle=?').get(CYCLE); }
  catch(e) { return; }
  if (!cycle) return;

  const phases = [
    { key:'gs',  name:'Goal Setting',    open:cycle.goal_setting_open, end:cycle.gs_end  },
    { key:'mid', name:'Mid-Year Review', open:cycle.mid_year_open,     end:cycle.mid_end },
    { key:'ye',  name:'Year-End Review', open:cycle.year_end_open,     end:cycle.ye_end  },
  ];

  for (const phase of phases) {
    if (!phase.end) continue;
    const endDate  = new Date(phase.end); endDate.setHours(0, 0, 0, 0);
    const daysLeft = Math.round((endDate - today) / 86400000);

    // ── Deadline reminder ──────────────────────────────────────
    if (phase.open && REMINDER_DAYS.includes(daysLeft)) {
      // Check sent_reminders table — fires exactly ONCE per phase per days_left per cycle
      const alreadySent = db.prepare(
        `SELECT phase_key FROM sent_reminders
         WHERE phase_key=? AND reminder_type='deadline' AND days_left=? AND cycle=?`
      ).get(phase.key, daysLeft, CYCLE);

      if (!alreadySent) {
        let pending = [];
        if (phase.key === 'gs') {
          pending = db.prepare(`
            SELECT u.emp_no, u.email, u.name FROM users u
            LEFT JOIN goal_sheets gs ON gs.emp_no=u.emp_no AND gs.cycle=?
            WHERE u.is_active=1 AND u.role!='hr_admin'
            AND (gs.id IS NULL OR gs.status IN ('draft','not_started'))
          `).all(CYCLE);
        } else {
          const rt = phase.key === 'mid' ? 'mid_year' : 'year_end';
          pending = db.prepare(`
            SELECT u.emp_no, u.email, u.name FROM users u
            JOIN goal_sheets gs ON gs.emp_no=u.emp_no AND gs.cycle=? AND gs.status='approved'
            LEFT JOIN reviews r ON r.sheet_id=gs.id AND r.review_type=?
            WHERE u.is_active=1 AND u.role!='hr_admin' AND r.self_submitted_at IS NULL
          `).all(CYCLE, rt);
        }

        if (pending.length) {
          await notify(db, 'deadline_reminder', pending, {
            phase_name: phase.name,
            deadline:   phase.end,
            days_left:  daysLeft
          });
          // Record that this reminder has been sent — prevents re-sending
          db.prepare(
            `INSERT OR IGNORE INTO sent_reminders(phase_key, reminder_type, days_left, cycle, sent_at)
             VALUES(?, 'deadline', ?, ?, ?)`
          ).run(phase.key, daysLeft, CYCLE, now);
          console.log(`  [Scheduler] ${phase.name} ${daysLeft}-day reminder sent to ${pending.length} users`);
        }
      }
    }

    // ── Overdue alert to HR (once per phase per cycle) ─────────
    if (daysLeft < 0 && cfg.NOTIFY.overdue_alert) {
      const alreadyAlerted = db.prepare(
        `SELECT phase_key FROM sent_reminders
         WHERE phase_key=? AND reminder_type='overdue' AND cycle=?`
      ).get(phase.key, CYCLE);

      if (!alreadyAlerted) {
        const hrUsers = db.prepare(
          `SELECT emp_no, email FROM users WHERE role='hr_admin' AND is_active=1`
        ).all();
        if (hrUsers.length) {
          await notify(db, 'overdue_alert', hrUsers, { phase_name: phase.name });
          db.prepare(
            `INSERT OR IGNORE INTO sent_reminders(phase_key, reminder_type, days_left, cycle, sent_at)
             VALUES(?, 'overdue', NULL, ?, ?)`
          ).run(phase.key, CYCLE, now);
          console.log(`  [Scheduler] Overdue alert sent for ${phase.name}`);
        }
      }
    }
  }
}

// ── SEND EMAIL (internal helper) ────────────────────────────────
async function sendEmail(to, subject, htmlBody) {
  const mailer = getMailer();
  if (!mailer) {
    console.log(`  [Queue] Email not sent (SMTP disabled): ${subject} → ${to}`);
    return false;
  }
  try {
    await mailer.sendMail({
      from:    `"${cfg.FROM_NAME}" <${cfg.FROM_EMAIL}>`,
      replyTo: cfg.REPLY_TO,
      to,
      subject,
      html: htmlBody
    });
    console.log(`  [Queue] Email sent: ${subject} → ${to}`);
    return true;
  } catch(e) {
    console.error(`  [Queue] Email FAILED to ${to}: ${e.message}`);
    throw e;  // let processQueue handle retry logic
  }
}

module.exports = { notify, saveNotification, sendEmail, initQueue, getQueueStats, startScheduler };
