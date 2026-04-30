// ═══════════════════════════════════════════════════════════════
//  Acorn PMS — Email Notification Configuration
// ═══════════════════════════════════════════════════════════════

module.exports = {

  SMTP_ENABLED: false,   // Set to true when ready to send live emails

  SMTP_HOST: 'smtp.office365.com',
  SMTP_PORT: 587,
  SMTP_SECURE: false,

  SMTP_USER: 'pms@acorn.lk',
  SMTP_PASS: 'APm$2026#$%4',

  FROM_NAME:  'Acorn Group PMS',
  FROM_EMAIL: 'pms@acorn.lk',
  REPLY_TO:   'pms@acorn.lk',

  COMPANY_NAME: 'Acorn Group',
  PORTAL_URL:   'http://localhost:3000',

  REMINDER_DAYS: [7, 3],
  REMINDER_ON_DEADLINE: true,
  OVERDUE_ALERT_DAYS: 1,

  NOTIFY: {
    goal_setting_opened:        true,
    goals_pending_approval:     true,   // supervisor gets email when team submits
    goal_submitted_to_manager:  true,
    goal_approved:              true,
    goal_rejected:              true,
    goal_change_requested:      true,
    goal_change_approved:       true,
    goal_change_rejected:       true,
    midyear_opened:             true,
    midyear_reminder:           true,
    midyear_feedback_released:  true,
    yearend_opened:             true,
    yearend_reminder:           true,
    final_rating_published:     true,
    review_pushed_back:         true,
    promotion_decided:          false,
    deadline_reminder:          true,
    overdue_alert:              true,
  }
};
