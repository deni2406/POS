const sqlite3 = require("sqlite3").verbose();
const db = new sqlite3.Database("C:\\POS\\pos.db");

const tables = ["sesi_meja", "member_cache", "harga_member_cache"];

let i = 0;

function next() {
  if (i >= tables.length) {
    db.close();
    return;
  }

  const table = tables[i++];

  db.all(`PRAGMA table_info(${table})`, [], (err, rows) => {
    if (err) {
      console.log(`\n=== ${table} ===`);
      console.log(err.message);
      return next();
    }

    console.log(`\n=== ${table} ===`);
    console.table(rows.map(r => ({
      cid: r.cid,
      name: r.name,
      type: r.type,
      pk: r.pk
    })));

    next();
  });
}

next();
