const sqlite3 = require("sqlite3").verbose();

const db = new sqlite3.Database("./pos.db");

db.all(
  `SELECT id, kode_member, nama, nomor_hp, kategori_id, status
   FROM member
   WHERE nomor_hp = ?`,
  ["081779906241"],
  (err, rows) => {
    if (err) {
      console.error(err);
    } else {
      console.log(rows);
    }

    db.close();
  }
);