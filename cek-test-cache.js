const sqlite3 = require("sqlite3").verbose();
const db = new sqlite3.Database("C:\\POS\\pos.db");

db.get(
  "SELECT id,member_id,kode_member,nama,status,tanggal_aktif FROM member_cache WHERE kode_member = ?",
  ["TEST-MBR-001"],
  (err, row) => {
    if (err) throw err;
    console.log(row || "TIDAK ADA DI MEMBER_CACHE");
    db.close();
  }
);
