const express      = require('express');
const path         = require('path');
const cookieParser = require('cookie-parser');
const helmet       = require('helmet');
const rateLimit    = require('express-rate-limit');
const db           = require('./db/database');
const PORT = process.env.PORT || 3000;

async function startServer() {
  await db.init();   // sql.js must load before routes
  await db.migrate(); // apply schema updates

  // Start notification scheduler
  try {
    const { startScheduler } = require('./notifications');
    startScheduler(db);
  } catch(e) {
    console.warn('  [Notifications] Scheduler not started:', e.message);
  }

  const app = express();

  app.use(helmet({ contentSecurityPolicy: { directives: {
    defaultSrc:["'self'"], scriptSrc:["'self'","'unsafe-inline'"],
    styleSrc:["'self'","'unsafe-inline'"], imgSrc:["'self'","data:"]
  }}}));

  const loginLimiter = rateLimit({ windowMs:15*60*1000, max:10,
    message:{error:'Too many login attempts. Please wait 15 minutes.'} });

  app.use(express.json());
  app.use(express.urlencoded({ extended:true }));
  app.use(cookieParser());

  // Prevent HTML files from being cached so changes take effect immediately
  app.use((req, res, next) => {
    if (req.path.endsWith('.html') || req.path === '/') {
      res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.set('Pragma', 'no-cache');
    }
    next();
  });

  app.use(express.static(path.join(__dirname, 'public')));

  const authRouter = require('./routes/auth');
  // Rate limit only the login endpoint, not password change/reset
  app.use('/auth/login', loginLimiter);
  app.use('/auth', authRouter);
  app.use('/api',   require('./routes/api'));
  app.use('/admin', require('./routes/admin'));

  app.get('*', (req, res) => {
    if (!req.path.startsWith('/api') && !req.path.startsWith('/auth') && !req.path.startsWith('/admin')) {
      res.sendFile(path.join(__dirname, 'public', 'index.html'));
    } else {
      res.status(404).json({ error: 'Not found' });
    }
  });

  // Express error middleware — returns JSON error instead of crashing
  app.use((err, req, res, next) => {
    console.error('  Route error:', err.message);
    res.status(500).json({ error: 'Server error: ' + err.message });
  });

  app.listen(PORT, '0.0.0.0', () => {
    console.log('');
    console.log('  ╔══════════════════════════════════════════════╗');
    console.log('  ║   Acorn Group Performance Management System  ║');
    console.log('  ╚══════════════════════════════════════════════╝');
    console.log('');
    console.log('  Open in browser:  http://localhost:' + PORT);
    console.log('');
    console.log('  First HR login:');
    console.log('    Employee No:  20123  |  Password: Acorn@2025');
    console.log('');
    console.log('  Keep this window open. Ctrl+C to stop.');
    console.log('');
  });
}

startServer().catch(err => { console.error('Startup error:', err); process.exit(1); });

// Global error handler — catches any unhandled route errors
// and returns JSON instead of crashing silently
process.on('uncaughtException', (err) => {
  console.error('\n  UNCAUGHT ERROR:', err.message);
  console.error(err.stack);
});
