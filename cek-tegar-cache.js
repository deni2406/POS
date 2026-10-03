const sqlite3 = require("sqlite3").verbose();

const db = new sqlite3.Database("C:\\POS\\pos.db");

db.get(
  "SELECT member_id, kode_member, nama, status, tanggal_aktif, updated_at FROM member_cache WHERE kode_member = ?",
  ["PLJ-0031"],
  (err, row) => {
    if (err) console.error(err);
    else console.log(row);
    db.close();
  }
);
