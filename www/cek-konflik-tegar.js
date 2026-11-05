const sqlite3 = require("sqlite3").verbose();

const db = new sqlite3.Database("C:/POS/pos.db");

const q = "SELECT id,kode_member,nama,nomor_hp,nisn FROM member WHERE nomor_hp='82230831168' OR nisn='101811613'";

db.all(q, (e, r) => {
  if (e) {
    console.error(e);
    db.close();
    process.exit(1);
  }

  console.log("KONFLIK NOMOR HP / NISN:", r.length);
  console.table(r);
  db.close();
});
