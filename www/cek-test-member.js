const sqlite3 = require("sqlite3").verbose();
const db = new sqlite3.Database("C:\\POS\\pos.db");

db.get(
  "SELECT id,kode_member,nama,status FROM member WHERE kode_member = ?",
  ["TEST-MBR-001"],
  (err, row) => {
    if (err) throw err;
    console.log(row || "KODE BELUM ADA");
    db.close();
  }
);
