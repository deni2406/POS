const sqlite3 = require("sqlite3").verbose();
const db = new sqlite3.Database("C:\\POS\\pos.db");

db.all(
  "SELECT id,kode_member,nama,status,tanggal_aktif FROM member WHERE status = ?",
  ["NONAKTIF"],
  (err, rows) => {
    if (err) throw err;
    console.table(rows);
    db.close();
  }
);
