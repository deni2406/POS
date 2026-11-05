const sqlite3 = require("sqlite3").verbose();

const db = new sqlite3.Database("C:\\POS\\pos.db");

const sql = `
SELECT
  pm.id,
  pm.session_id,
  sm.nomor_meja,
  pm.qty,
  pm.harga_jual,
  pm.subtotal
FROM pesanan_meja pm
JOIN sesi_meja sm
  ON sm.session_id = pm.session_id
WHERE pm.id IN (2004, 2006)
  AND pm.nama_barang = 'Meja Billiard'
ORDER BY sm.nomor_meja;
`;

db.all(sql, [], (err, rows) => {
  if (err) {
    console.error("ERROR:", err.message);
    process.exit(1);
  }

  console.log(JSON.stringify(rows, null, 2));
  db.close();
});
