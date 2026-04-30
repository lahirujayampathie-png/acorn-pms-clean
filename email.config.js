// ═══════════════════════════════════════════════════════════════
//  Acorn PMS — Email Notification Configuration
// ═══════════════════════════════════════════════════════════════

module.exports = {

  SMTP_ENABLED: true,

  SMTP_HOST:   'smtp.office365.com',
  SMTP_PORT:   587,
  SMTP_SECURE: false,

  SMTP_USER:  'pms@acorn.lk',
  SMTP_PASS:  'APm$2026#$%4',

  FROM_NAME:  'Acorn Group PMS',
  FROM_EMAIL: 'pms@acorn.lk',
  REPLY_TO:   'pms@acorn.lk',

  COMPANY_NAME: 'Acorn Group',
  PORTAL_URL:   'https://pms.acorn.lk/',   // fixed: removed duplicate https://

  REMINDER_DAYS:          [7, 3],
  REMINDER_ON_DEADLINE:   true,
  OVERDUE_ALERT_DAYS:     1,

  NOTIFY: {
    // ── Goal Setting ──────────────────────────────────────────
    goal_setting_opened:        true,   // employee notified when goal setting opens
    goals_pending_approval:     true,   // supervisor notified when team submits goals / reviews
    goal_approved:              true,   // employee notified when goals approved
    goal_rejected:              true,   // employee notified when goals returned
    goal_change_requested:      true,   // supervisor + HR notified of change request
    goal_change_approved:       true,   // employee notified when change request approved
    goal_change_rejected:       true,   // employee notified when change request rejected

    // ── Mid-Year ──────────────────────────────────────────────
    midyear_opened:             true,   // all employees notified when mid-year opens
    midyear_feedback_released:  true,   // employee notified when manager submits mid-year

    // ── Year-End ──────────────────────────────────────────────
    yearend_opened:             true,   // all employees notified when year-end opens
    final_rating_published:     true,   // employee notified when calibrated rating published

    // ── Review Actions ────────────────────────────────────────
    review_pushed_back:         true,   // employee notified when review pushed back

    // ── Scheduled Reminders (via startScheduler) ──────────────
    deadline_reminder:          true,   // reminder X days before deadline
    overdue_alert:              true,   // alert when phase is overdue
  }
};
