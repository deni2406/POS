const sqlite3 = require("sqlite3").verbose();
const db = new sqlite3.Database("./pos.db");

db.all(`
SELECT
  pm.session_id,
  sm.nomor_meja,
  sm.status,
  pm.nama_barang,
  pm.qty,
  pm.harga_jual,
  pm.subtotal
FROM pesanan_meja pm
LEFT JOIN sesi_meja sm
  ON sm.session_id = pm.session_id
WHERE sm.status = 'AKTIF'
ORDER BY sm.nomor_meja
`, (err, rows) => {
  if (err) console.error(err);
  else console.table(rows);
  db.close();
});
