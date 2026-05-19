# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Acorn Group Performance Management System (PMS) — a Node.js/Express web app for managing the FY 2026-27 performance cycle across 225+ employees in 11 companies. No build step — pure Node.js with a pure-JS SQLite library (sql.js).

## Commands

```bash
# Start the server
node server.js          # runs on http://localhost:3000

# First-time DB setup (seeds all 225 employees)
node scripts/setup-db.js

# Reset a user's password
node scripts/reset-password.js

# Default first HR login
# Emp No: 20123  |  Password: Acorn@2025
```

No lint, test, or build scripts are configured.

## Architecture

### Startup sequence (`server.js`)
1. `db.init()` — loads sql.js WASM and reads `db/pms.db` from disk
2. `db.migrate()` — applies `ALTER TABLE` additions (safe: wrapped in try/catch)
3. `startScheduler(db)` — starts email queue processor (every 10s) + hourly phase-deadline checker
4. Express app mounts: `/auth`, `/api`, `/admin`, then static `public/`

### Database (`db/database.js`)
Uses **sql.js** — SQLite compiled to WebAssembly. The entire DB lives in memory; **every write must call `saveToDisk()`** which exports the in-memory DB to `db/pms.db`. The `prepare()` wrapper returns an object with `.run()`, `.get()`, `.all()`, and `.runBatch()` methods that mirror the better-sqlite3 API.

Named parameters use `@param_name` syntax and are auto-converted to positional before execution.

Schema additions belong in the `migrate()` function at the bottom of `database.js`, each wrapped in a try/catch to ignore "column already exists" errors on subsequent starts. New tables can also be created inline in route files using `initNewTables()` IIFE pattern (see `routes/api.js`).

### Auth (`middleware/auth.js`)
JWT stored in an HTTP-only cookie (`pms_token`). On every request `verifyToken` validates the JWT signature **and** queries the `sessions` table — enabling server-side revocation. Role hierarchy (ascending):

```
employee(1) → supervisor(2) → manager(3) → senior_manager(4) → sbu_head(5) → exco(6) → hr_admin(7)
```

`requireRole('manager')` = level ≥ 3. `requireHR` = exactly `hr_admin`. `requireSelfOrManager` = self, or target is in the requester's reporting subtree.

Hierarchy traversal (`isInHierarchy`) walks the `reports_to` chain (max depth 10).

### Routes
| File | Mount | Access |
|------|-------|--------|
| `routes/auth.js` | `/auth` | Public (login) + authenticated |
| `routes/api.js` | `/api` | All authenticated; data scoped by role |
| `routes/admin.js` | `/admin` | `hr_admin` only |

**Data visibility in `/api`:** HR admin and ExCo see everything. SBU heads see their company subtree. Managers see their reporting subtree (resolved in JS via `getSubtree()`). Employees see only themselves.

### Notifications (`notifications.js`)
Two-layer system:
1. **In-app**: synchronous DB inserts into `notifications` table
2. **Email**: async queue via `email_queue` table; processed in batches of 10 every 10 seconds using nodemailer

Email is disabled by default (`SMTP_ENABLED: false` in `email.config.js`). It can also be toggled at runtime via `system_settings` table key `email_enabled`. The scheduler fires deadline reminders at 7 and 3 days before each phase end, recorded in `sent_reminders` to prevent duplicates.

### Performance Cycle
Controlled by the `cycle_settings` table (single row, `id=1`, cycle `2026-27`). Three phases with open/close flags and date ranges:
- **Goal Setting** (`goal_setting_open`, `gs_start`/`gs_end`)
- **Mid-Year Review** (`mid_year_open`, `mid_start`/`mid_end`)
- **Year-End Review** (`year_end_open`, `ye_start`/`ye_end`)

### Rating Scale
| Rating | Min Score | Label |
|--------|-----------|-------|
| A | 125.01% | Exceptional |
| B | 101% | Strong |
| C | 85% | Competent |
| D | 60% | Inconsistent |
| E | 0% | Below Expectations |

### Key Schema Tables
`users`, `sessions`, `goal_sheets`, `kras`, `kpis`, `reviews`, `monthly_progress`, `dev_goals`, `competency_ratings`, `career_aspirations`, `goal_change_requests`, `notifications`, `email_queue`, `sent_reminders`, `audit_log`, `cycle_settings`, `system_settings`, `review_overrides`, `kpi_target_history`, `precal_adjustments`

### Frontend
Single-page app served from `public/`. Two HTML entry points: `index.html` (login) and `app.html` (main app). All API calls go to `/api`, `/auth`, or `/admin`.

## Environment Variables

```
PORT          Server port (default: 3000)
JWT_SECRET    JWT signing secret (default: dev secret — must change for production)
JWT_EXPIRES   JWT expiry (default: 8h)
NODE_ENV      Set to 'production' to enable secure cookies
```

SMTP credentials are currently hardcoded in `email.config.js` — move to `.env` before production deployment.
