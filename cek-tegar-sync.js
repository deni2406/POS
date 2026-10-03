const sqlite3 = require("sqlite3").verbose();

const db = new sqlite3.Database("C:/POS/pos.db");

db.get(
  "SELECT m.id,m.kode_member,m.nama,m.kategori_id,m.status,c.member_id,c.kode_member AS cache_kode,c.status AS cache_status FROM member m LEFT JOIN member_cache c ON c.kode_member=m.kode_member WHERE m.kode_member='PLJ-0031'",
  (err, row) => {
    if (err) {
      console.error(err);
      db.close();
      process.exit(1);
    }

    console.table(row);
    db.close();
  }
);
