const sqlite3 = require("sqlite3").verbose();
const db = new sqlite3.Database("./pos.db");

db.all(`SELECT name FROM sqlite_master WHERE type = "table" AND name LIKE "%paket%"`,
  (err, rows) => {
    console.log(err || rows);
    db.close();
  }
);
