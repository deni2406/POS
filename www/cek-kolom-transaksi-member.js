const sqlite3 = require("sqlite3").verbose();
const db = new sqlite3.Database("C:\\POS\\pos.db");

const tables = ["transaksi", "detail_transaksi", "pesanan_meja"];

let i = 0;

function next() {
  if (i >= tables.length) {
    db.close();
    return;
  }

  const table = tables[i++];

  db.all(`PRAGMA table_info(${table})`, [], (err, rows) => {
    if (err) throw err;

    console.log(`\n=== ${table} ===`);
    console.table(rows.map(r => ({
      cid: r.cid,
      name: r.name,
      type: r.type,
      notnull: r.notnull,
      pk: r.pk
    })));

    next();
  });
}

next();
