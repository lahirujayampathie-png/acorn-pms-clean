// ═══════════════════════════════════════════════════════════════
//  Acorn PMS — Email Notification Configuration
//  IT SETUP INSTRUCTIONS:
//  1. Fill in the SMTP settings below
//  2. Set SMTP_ENABLED = true
//  3. Restart the server
// ═══════════════════════════════════════════════════════════════

module.exports = {

  // ── ENABLE / DISABLE ──────────────────────────────────────────
  SMTP_ENABLED: false,   // Set to true once SMTP credentials are ready

  // ── SMTP SETTINGS (Microsoft 365) ─────────────────────────────
  SMTP_HOST: 'smtp.office365.com',
  SMTP_PORT: 587,
  SMTP_SECURE: false,    // false for port 587 (STARTTLS), true for port 465

  // The M365 mailbox that sends PMS emails (must have SMTP AUTH enabled)
  SMTP_USER: 'pms@acorngroup.com',       // ← IT fills this in
  SMTP_PASS: '',                          // ← IT fills this in

  // Sender display name and reply-to
  FROM_NAME:  'Acorn Group PMS',
  FROM_EMAIL: 'pms@acorngroup.com',       // ← IT fills this in
  REPLY_TO:   'hr@acorngroup.com',        // ← IT fills this in

  // ── COMPANY INFO ──────────────────────────────────────────────
  COMPANY_NAME: 'Acorn Group',
  PORTAL_URL:   'http://localhost:3000',  // ← IT changes to live server URL

  // ── REMINDER SCHEDULE ─────────────────────────────────────────
  // How many days before deadline to send reminders
  REMINDER_DAYS: [7, 3],        // 7 days before, then 3 days before
  REMINDER_ON_DEADLINE: true,   // Send on the deadline day itself
  OVERDUE_ALERT_DAYS: 1,        // HR alert X days after deadline

  // ── NOTIFICATION RULES ────────────────────────────────────────
  NOTIFY: {
    goal_setting_opened:        true,
    goal_submitted_to_manager:  true,
    goal_approved:              true,
    goal_rejected:              true,
    goal_change_requested:      true,   // to supervisor + HR
    goal_change_approved:       true,
    goal_change_rejected:       true,
    midyear_opened:             true,
    midyear_reminder:           true,
    midyear_feedback_released:  true,
    yearend_opened:             true,
    yearend_reminder:           true,
    final_rating_published:     true,   // only after HR publishes
    review_pushed_back:         true,
    promotion_decided:          false,  // HR decides when to notify
  }
};
