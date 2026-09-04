const sqlite3 = require("sqlite3").verbose();
const db = new sqlite3.Database("./pos.db");

db.all(`
  SELECT
    id,
    session_id,
    nama_barang,
    qty,
    harga_jual,
    subtotal
  FROM pesanan_meja
  ORDER BY id DESC
  LIMIT 20
`, [], (err, rows) => {
  if (err) {
    console.error(err);
  } else {
    console.table(rows);
  }
  db.close();
});
