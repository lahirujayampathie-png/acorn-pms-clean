// ═══════════════════════════════════════════════════════════════
//  Acorn PMS — Notification Service
//  Handles both in-app notifications and email delivery
// ═══════════════════════════════════════════════════════════════

const cfg = require('./email.config');

let transporter = null;
let nodemailer = null;

// Try to load nodemailer (may not be installed yet)
function getMailer() {
  if (transporter) return transporter;
  if (!cfg.SMTP_ENABLED) return null;
  try {
    nodemailer = nodemailer || require('nodemailer');
    transporter = nodemailer.createTransport({
      host: cfg.SMTP_HOST,
      port: cfg.SMTP_PORT,
      secure: cfg.SMTP_SECURE,
      auth: { user: cfg.SMTP_USER, pass: cfg.SMTP_PASS },
      tls: { ciphers: 'SSLv3' }
    });
    return transporter;
  } catch(e) {
    console.warn('  [Notifications] nodemailer not available:', e.message);
    return null;
  }
}

// ── EMAIL TEMPLATES ─────────────────────────────────────────────
function emailTemplate(title, body, ctaText, ctaUrl) {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><style>
body{font-family:Arial,sans-serif;background:#F3F4F6;margin:0;padding:20px}
.wrap{max-width:600px;margin:0 auto;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.1)}
.hdr{background:#1E3A5F;padding:24px 32px;color:#fff}
.hdr h1{margin:0;font-size:20px;font-weight:700}
.hdr p{margin:4px 0 0;font-size:12px;opacity:.7}
.body{padding:28px 32px;color:#374151;font-size:14px;line-height:1.6}
.cta{display:inline-block;margin:20px 0;padding:12px 28px;background:#1E3A5F;color:#fff;text-decoration:none;border-radius:6px;font-weight:600;font-size:14px}
.footer{background:#F9FAFB;padding:16px 32px;font-size:11px;color:#9CA3AF;border-top:1px solid #E5E7EB}
hr{border:none;border-top:1px solid #E5E7EB;margin:20px 0}
</style></head>
<body>
<div class="wrap">
  <div class="hdr">
    <h1>${cfg.COMPANY_NAME} PMS</h1>
    <p>Performance Management System — FY 2026-27</p>
  </div>
  <div class="body">
    <h2 style="margin-top:0;color:#111827">${title}</h2>
    ${body}
    ${ctaText && ctaUrl ? `<a href="${ctaUrl}" class="cta">${ctaText}</a>` : ''}
    <hr>
    <p style="font-size:12px;color:#6B7280">This is an automated message from the Acorn Group PMS. Please do not reply to this email. For support, contact HR.</p>
  </div>
  <div class="footer">${cfg.COMPANY_NAME} &nbsp;·&nbsp; Performance Management System &nbsp;·&nbsp; FY 2026-27</div>
</div>
</body></html>`;
}

// ── SEND EMAIL ──────────────────────────────────────────────────
async function sendEmail(to, subject, htmlBody) {
  const mailer = getMailer();
  if (!mailer) {
    console.log(`  [Notifications] Email not sent (SMTP disabled): ${subject} → ${to}`);
    return false;
  }
  try {
    await mailer.sendMail({
      from: `"${cfg.FROM_NAME}" <${cfg.FROM_EMAIL}>`,
      replyTo: cfg.REPLY_TO,
      to,
      subject,
      html: htmlBody
    });
    console.log(`  [Notifications] Email sent: ${subject} → ${to}`);
    return true;
  } catch(e) {
    console.error(`  [Notifications] Email failed: ${e.message}`);
    return false;
  }
}

// ── SAVE IN-APP NOTIFICATION ────────────────────────────────────
function saveNotification(db, empNo, type, title, message, link) {
  try {
    db.prepare(`INSERT INTO notifications(emp_no, type, title, message, link, created_at, is_read)
      VALUES(?,?,?,?,?,strftime('%s','now'),0)`)
      .run(empNo, type, title, message, link||null);
  } catch(e) {
    console.warn('  [Notifications] Could not save notification:', e.message);
  }
}

// ── CORE NOTIFICATION DISPATCHER ────────────────────────────────
async function notify(db, type, recipients, data) {
  if (!cfg.NOTIFY[type] && cfg.NOTIFY[type] !== undefined) return;

  const portal = cfg.PORTAL_URL;
  let subject = '', title = '', body = '', cta = '', ctaUrl = '';
  let inAppMsg = '';

  switch(type) {
    case 'goal_setting_opened':
      subject = 'Goal Setting is Now Open — FY 2026-27';
      title = 'Goal Setting Phase is Open';
      body = `<p>The goal setting phase for <strong>FY 2026-27</strong> is now open.</p>
              <p>Please log in to the PMS and submit your KRAs/KPIs for approval by your supervisor.</p>
              <p><strong>Deadline:</strong> ${data.deadline || 'See HR communication'}</p>`;
      cta = 'Set My Goals'; ctaUrl = portal;
      inAppMsg = 'Goal setting is now open. Please submit your KRAs/KPIs.';
      break;

    case 'goal_approved':
      subject = `Your Goals Have Been Approved — FY 2026-27`;
      title = 'Your Goals Are Approved ✓';
      body = `<p>Your KRAs/KPIs for <strong>FY 2026-27</strong> have been reviewed and approved by your supervisor.</p>
              <p>Your approved goals are now locked and will be used for your mid-year and year-end performance review.</p>`;
      cta = 'View My Goals'; ctaUrl = portal;
      inAppMsg = 'Your goals have been approved by your supervisor.';
      break;

    case 'goal_rejected':
      subject = `Your Goals Need Revision — FY 2026-27`;
      title = 'Your Goals Have Been Returned';
      body = `<p>Your KRAs/KPIs have been reviewed by your supervisor and returned for revision.</p>
              ${data.comments ? `<p><strong>Supervisor comments:</strong><br>${data.comments}</p>` : ''}
              <p>Please log in, review the feedback, and resubmit.</p>`;
      cta = 'Revise My Goals'; ctaUrl = portal;
      inAppMsg = `Your goals were returned for revision. ${data.comments ? 'Reason: ' + data.comments.slice(0,80) : ''}`;
      break;

    case 'goal_change_requested':
      subject = `Goal Change Request — ${data.emp_name}`;
      title = 'Goal Change Request Pending';
      body = `<p><strong>${data.emp_name}</strong> has requested changes to their approved goals.</p>
              <p><strong>Reason:</strong> ${data.reason}</p>
              ${data.post_midyear ? '<p style="color:#D97706"><strong>⚠ Note:</strong> This request was made after the mid-year review.</p>' : ''}
              <p>Please log in to review and approve or reject this request.</p>`;
      cta = 'Review Request'; ctaUrl = portal;
      inAppMsg = `${data.emp_name} has requested a goal change. ${data.post_midyear ? '(Post mid-year)' : ''}`;
      break;

    case 'goal_change_approved':
      subject = 'Your Goal Change Request Has Been Approved';
      title = 'Goal Change Approved ✓';
      body = `<p>Your request to modify your goals has been approved.</p>
              <p>Please log in to update your goals. The changes must be resubmitted for final approval.</p>`;
      cta = 'Update My Goals'; ctaUrl = portal;
      inAppMsg = 'Your goal change request has been approved. Please update your goals.';
      break;

    case 'goal_change_rejected':
      subject = 'Your Goal Change Request — Update';
      title = 'Goal Change Request Not Approved';
      body = `<p>Your request to modify your goals has been reviewed.</p>
              ${data.reason ? `<p><strong>Reason:</strong> ${data.reason}</p>` : ''}
              <p>Your current approved goals remain in effect.</p>`;
      cta = 'View My Goals'; ctaUrl = portal;
      inAppMsg = `Your goal change request was not approved. ${data.reason ? 'Reason: ' + data.reason.slice(0,80) : ''}`;
      break;

    case 'goals_pending_approval':
      subject = `You Have ${data.count} Goal Sheet${data.count > 1 ? 's' : ''} Awaiting Approval`;
      title = 'Team Goals Pending Your Approval';
      body = `<p>The following team members are waiting for you to approve their goals:</p>
              <ul>${(data.names || []).map(n => `<li>${n}</li>`).join('')}</ul>
              <p>Please log in and review their submissions.</p>`;
      cta = 'Review Team Goals'; ctaUrl = portal;
      inAppMsg = `${data.count} team member${data.count > 1 ? 's have' : ' has'} submitted goals for your approval.`;
      break;

    case 'midyear_opened':
      subject = 'Mid-Year Review is Now Open — FY 2026-27';
      title = 'Mid-Year Review Phase is Open';
      body = `<p>The mid-year review for <strong>FY 2026-27</strong> is now open.</p>
              <p>Please log in and complete your self-assessment by entering your KPI achievements.</p>
              <p><strong>Deadline:</strong> ${data.deadline || 'See HR communication'}</p>`;
      cta = 'Start My Review'; ctaUrl = portal;
      inAppMsg = 'Mid-year review is now open. Please complete your self-assessment.';
      break;

    case 'midyear_feedback_released':
      subject = 'Your Mid-Year Feedback is Available — FY 2026-27';
      title = 'Supervisor Feedback Available';
      body = `<p>Your supervisor has released their feedback for your mid-year review.</p>
              <p>Log in to view your indicative rating and supervisor comments.</p>`;
      cta = 'View My Feedback'; ctaUrl = portal;
      inAppMsg = 'Your supervisor has released mid-year feedback. Log in to view.';
      break;

    case 'yearend_opened':
      subject = 'Year-End Review is Now Open — FY 2026-27';
      title = 'Year-End Review Phase is Open';
      body = `<p>The year-end performance review for <strong>FY 2026-27</strong> is now open.</p>
              <p>Please log in and complete your self-assessment, including KPI achievements and competency ratings.</p>
              <p><strong>Deadline:</strong> ${data.deadline || 'See HR communication'}</p>`;
      cta = 'Start Year-End Review'; ctaUrl = portal;
      inAppMsg = 'Year-end review is now open. Please complete your self-assessment.';
      break;

    case 'final_rating_published':
      subject = 'Your Final Performance Rating — FY 2026-27';
      title = 'Your Final Rating Has Been Published';
      body = `<p>Your final performance rating for <strong>FY 2026-27</strong> has been published by HR.</p>
              <p>Please log in to view your rating and feedback.</p>`;
      cta = 'View My Rating'; ctaUrl = portal;
      inAppMsg = 'Your final performance rating for FY 2026-27 has been published.';
      break;

    case 'review_pushed_back':
      subject = 'Your Review Has Been Returned for Revision';
      title = 'Review Returned by Supervisor';
      body = `<p>Your supervisor has reviewed your submission and returned it for revision.</p>
              ${data.reason ? `<p><strong>Reason:</strong> ${data.reason}</p>` : ''}
              <p>Please log in, revise your self-assessment, and resubmit.</p>`;
      cta = 'Revise My Review'; ctaUrl = portal;
      inAppMsg = `Your review was returned for revision. ${data.reason ? 'Reason: ' + data.reason.slice(0,80) : ''}`;
      break;

    case 'deadline_reminder':
      subject = `Reminder: ${data.phase_name} ${data.days_left === 0 ? 'is Due Today' : `Closes in ${data.days_left} Day${data.days_left > 1 ? 's' : ''}`} — FY 2026-27`;
      title = data.days_left === 0 ? `⚠ ${data.phase_name} is Due Today` : `Reminder: ${data.days_left} Day${data.days_left > 1 ? 's' : ''} Left`;
      body = `<p>This is a reminder that the <strong>${data.phase_name}</strong> deadline ${data.days_left === 0 ? 'is <strong>today</strong>' : `is in <strong>${data.days_left} day${data.days_left > 1 ? 's' : ''}</strong>`}.</p>
              <p>Please log in and complete your submission as soon as possible.</p>`;
      cta = 'Complete Now'; ctaUrl = portal;
      inAppMsg = `Reminder: ${data.phase_name} ${data.days_left === 0 ? 'is due today!' : `closes in ${data.days_left} day${data.days_left > 1 ? 's' : ''}.`}`;
      break;

    case 'overdue_alert':
      subject = `OVERDUE: ${data.count} Employee${data.count > 1 ? 's' : ''} Have Not Completed ${data.phase_name}`;
      title = `⚠ Overdue — ${data.phase_name}`;
      body = `<p><strong>${data.count} employee${data.count > 1 ? 's have' : ' has'}</strong> not completed their ${data.phase_name} submission.</p>
              ${data.names ? `<p>Outstanding:<br>${data.names.slice(0,10).join('<br>')}${data.names.length > 10 ? `<br>... and ${data.names.length - 10} more` : ''}</p>` : ''}
              <p>Please follow up with the relevant managers.</p>`;
      cta = 'View HR Dashboard'; ctaUrl = portal;
      inAppMsg = `${data.count} employees overdue for ${data.phase_name}.`;
      break;

    default:
      return;
  }

  const html = emailTemplate(title, body, cta, ctaUrl);

  for (const r of recipients) {
    // Save in-app notification
    saveNotification(db, r.emp_no, type, title, inAppMsg || message, ctaUrl);
    // Send email if configured and user has email
    if (r.email && cfg.SMTP_ENABLED) {
      await sendEmail(r.email, subject, html);
    }
  }
}

// ── SCHEDULED REMINDERS ─────────────────────────────────────────
function startScheduler(db) {
  console.log('  [Notifications] Scheduler started');

  async function runChecks() {
    const now = Math.floor(Date.now() / 1000);
    const today = new Date(); today.setHours(0,0,0,0);

    let cycle;
    try { cycle = db.prepare('SELECT * FROM cycle_settings WHERE cycle=?').get('2026-27'); }
    catch(e) { return; }
    if (!cycle) return;

    const phases = [
      { key: 'gs',  name: 'Goal Setting',    open: cycle.goal_setting_open, end: cycle.gs_end },
      { key: 'mid', name: 'Mid-Year Review',  open: cycle.mid_year_open,    end: cycle.mid_end },
      { key: 'ye',  name: 'Year-End Review',  open: cycle.year_end_open,    end: cycle.ye_end },
    ];

    for (const phase of phases) {
      if (!phase.open || !phase.end) continue;

      const deadline = new Date(phase.end); deadline.setHours(23,59,59,0);
      const msLeft = deadline - today;
      const daysLeft = Math.ceil(msLeft / (1000 * 60 * 60 * 24));

      // Check if we should send a reminder today
      const shouldRemind = cfg.REMINDER_DAYS.includes(daysLeft) ||
                           (cfg.REMINDER_ON_DEADLINE && daysLeft === 0);

      if (shouldRemind && daysLeft >= 0) {
        // Get users who haven't completed this phase
        let pending = [];
        try {
          if (phase.key === 'gs') {
            pending = db.prepare(`SELECT u.emp_no, u.email, u.name FROM users u
              LEFT JOIN goal_sheets gs ON gs.emp_no=u.emp_no AND gs.cycle='2026-27'
              WHERE u.is_active=1 AND u.role!='hr_admin'
              AND (gs.status IS NULL OR gs.status NOT IN ('submitted','approved'))`).all();
          } else if (phase.key === 'mid') {
            pending = db.prepare(`SELECT u.emp_no, u.email, u.name FROM users u
              JOIN goal_sheets gs ON gs.emp_no=u.emp_no AND gs.cycle='2026-27' AND gs.status='approved'
              LEFT JOIN reviews r ON r.sheet_id=gs.id AND r.review_type='mid_year'
              WHERE u.is_active=1 AND u.role!='hr_admin'
              AND (r.self_submitted_at IS NULL)`).all();
          } else if (phase.key === 'ye') {
            pending = db.prepare(`SELECT u.emp_no, u.email, u.name FROM users u
              JOIN goal_sheets gs ON gs.emp_no=u.emp_no AND gs.cycle='2026-27' AND gs.status='approved'
              LEFT JOIN reviews r ON r.sheet_id=gs.id AND r.review_type='year_end'
              WHERE u.is_active=1 AND u.role!='hr_admin'
              AND (r.self_submitted_at IS NULL)`).all();
          }
        } catch(e) { continue; }

        if (pending.length > 0) {
          // Check if we already sent this reminder today (avoid duplicates)
          const todayStr = today.toISOString().slice(0,10);
          const alreadySent = db.prepare(`SELECT id FROM notifications
            WHERE type=? AND message LIKE ? AND created_at > ?`)
            .get(`deadline_reminder_${phase.key}`, `%${todayStr}%`, Math.floor(today.getTime()/1000));

          if (!alreadySent) {
            console.log(`  [Notifications] Sending ${phase.name} reminder to ${pending.length} users`);
            await notify(db, 'deadline_reminder', pending, {
              phase_name: phase.name,
              days_left: daysLeft,
              deadline: phase.end
            });

            // Also alert HR if overdue
            if (daysLeft < 0 || daysLeft === 0) {
              const hrUsers = db.prepare("SELECT emp_no, email FROM users WHERE role='hr_admin' AND is_active=1").all();
              await notify(db, 'overdue_alert', hrUsers, {
                phase_name: phase.name,
                count: pending.length,
                names: pending.map(p => p.name)
              });
            }
          }
        }
      }
    }
  }

  // Run checks once on startup, then every 6 hours
  setTimeout(runChecks, 5000);
  setInterval(runChecks, 6 * 60 * 60 * 1000);
}

module.exports = { notify, saveNotification, sendEmail, startScheduler };
