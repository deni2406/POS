const sqlite3 = require("sqlite3").verbose();
const db = new sqlite3.Database("C:\\POS\\pos.db");

db.all(`
SELECT id, session_id, nama_barang, qty, harga_jual, subtotal
FROM pesanan_meja
WHERE session_id = 'SES-20260917-095335-283'
  AND nama_barang = 'Meja Billiard'
`, [], (err, rows) => {
  if (err) throw err;
  console.log(JSON.stringify(rows, null, 2));
  db.close();
});
