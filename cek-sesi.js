const sqlite3 = require("sqlite3").verbose();
const db = new sqlite3.Database("./pos.db");

db.all(`PRAGMA table_info(sesi_meja)`, (err, rows) => {
  console.log(rows);
  db.close();
});
