const sqlite3 = require("sqlite3").verbose();

const db = new sqlite3.Database("C:/POS/pos.db");

const q = `
SELECT
  c.kode_member,
  c.nama,
  c.nomor_hp,
  c.nisn,
  CASE
    WHEN m.kode_member IS NOT NULL THEN "SUDAH ADA"
    ELSE "BELUM ADA"
  END AS status_member
FROM member_cache c
LEFT JOIN member m ON m.kode_member = c.kode_member
WHERE c.kode_member = "PLJ-0031"
`;

db.get(q, (e, r) => {
  if (e) {
    console.error(e);
    db.close();
    process.exit(1);
  }

  console.table(r);
  db.close();
});
