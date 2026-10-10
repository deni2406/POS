const sqlite3 = require('C:/POS/node_modules/sqlite3');
const db = new sqlite3.Database('C:/POS/pos.db');

db.all("SELECT name FROM sqlite_master WHERE type = ?", ['table'], (err, rows) => {
  if (err) console.log('ERROR:', err.message);
  else console.log('TABEL DATABASE:\n' + rows.map(row => row.name).join('\n'));
  db.close();
});
