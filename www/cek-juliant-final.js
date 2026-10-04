const sqlite3 = require("sqlite3").verbose();
const db = new sqlite3.Database("C:\\POS\\pos.db");

const ids = [7, 8, 9, 10];
const codes = ["PLT-0028", "PLT-0029", "PLT-0030", "PLT-0031"];

db.all(`
  SELECT
    id,
    kode_member,
    nama,
    status,
    tanggal_aktif
  FROM member
  WHERE id IN (?, ?, ?, ?)
     OR kode_member IN (?, ?, ?, ?)
  ORDER BY id
`, [...ids, ...codes], (err, rows) => {
  if (err) {
    console.error(err);
  } else {
    console.log("=== DATA MEMBER YANG AKAN DIPERIKSA ===");
    console.table(rows);
  }

  db.close();
});
