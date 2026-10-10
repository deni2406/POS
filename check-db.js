const sqlite3 = require("sqlite3");
const db = new sqlite3.Database("C:\\POS\\pos.db");

db.serialize(() => {
  db.all("SELECT * FROM master_barang", [], (e, r) => {
    if (e) console.error("master_barang error:", e);
    else {
      console.log("master_barang rows:", r.length);
      r.forEach(x => console.log(x));
    }
  });

  db.all("PRAGMA table_info(sesi_meja)", [], (e, r) => {
    if (e) console.error("PRAGMA error:", e);
    else {
      console.log("sesi_meja columns:");
      r.forEach(x => console.log(x.name, x.type));
    }
  });

  db.all("SELECT * FROM sesi_meja LIMIT 5", [], (e, r) => {
    if (e) console.error("sesi_meja error:", e);
    else {
      console.log("sesi_meja rows (first 5):");
      r.forEach(x => console.log(x));
    }
  });
});