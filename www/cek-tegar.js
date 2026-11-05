const sqlite3 = require("sqlite3").verbose();

const db = new sqlite3.Database("C:\\POS\\pos.db");

db.get(
  "SELECT id, kode_member, nama, status, tanggal_aktif, last_used_at, updated_at FROM member WHERE kode_member = ?",
  ["PLJ-0031"],
  (err, row) => {
    if (err) console.error(err);
    else console.log(row);
    db.close();
  }
);
