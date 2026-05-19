const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const dbPath = path.join(__dirname, 'db', 'pms.db');

initSqlJs().then(function(SQL) {
  const fileBuffer = fs.readFileSync(dbPath);
  const db = new SQL.Database(fileBuffer);

  const result = db.exec("SELECT COUNT(*) as n FROM email_queue WHERE status='pending'");
  const pending = result[0] ? result[0].values[0][0] : 0;
  console.log('Pending emails found:', pending);

  if (pending > 0) {
    db.run("UPDATE email_queue SET status='cancelled' WHERE status='pending'");
    console.log('Cancelled', pending, 'pending emails');
    const data = db.export();
    fs.writeFileSync(dbPath, Buffer.from(data));
    console.log('Database saved. Done.');
  } else {
    console.log('Nothing to cancel.');
  }

  db.close();
}).catch(function(e) {
  console.error('Error:', e.message);
});
