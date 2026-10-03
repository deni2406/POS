const sqlite3 = require("sqlite3").verbose();

const db = new sqlite3.Database("C:/POS/pos.db");

const q = "SELECT substr(kode_member,1,3) AS prefix, MAX(CAST(substr(kode_member,5) AS INTEGER)) AS nomor, COUNT(*) AS jumlah FROM member WHERE kode_member LIKE 'PLJ-%' OR kode_member LIKE 'UMM-%' OR kode_member LIKE 'PLT-%' GROUP BY substr(kode_member,1,3) ORDER BY prefix";

db.all(q, (e, r) => {
  if (e) {
    console.error(e);
    db.close();
    process.exit(1);
  }

  console.table(r);
  db.close();
});
