const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./pos.db', (err) => {
  if (err) { console.error(err); process.exit(1); }
  db.all("SELECT sql FROM sqlite_master WHERE name IN ('stock_opname','stock_opname_detail','master_barang')", (e, rows) => {
    if (e) { console.error(e); process.exit(1); }
    rows.forEach(r => console.log(r[0] + '\n'));
    db.close();
  });
});
