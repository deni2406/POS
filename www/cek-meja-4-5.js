const sqlite3 = require("sqlite3").verbose();

const db = new sqlite3.Database("C:\\POS\\pos.db");

const sql = `
SELECT
  sm.id AS sesi_id_db,
  sm.session_id,
  sm.nomor_meja,
  sm.nama_pemesan,
  sm.durasi_jam,
  sm.status,
  pm.id AS pesanan_id,
  pm.qty,
  pm.harga_jual,
  pm.subtotal
FROM sesi_meja sm
LEFT JOIN pesanan_meja pm
  ON pm.session_id = sm.session_id
 AND pm.nama_barang = 'Meja Billiard'
WHERE sm.nomor_meja IN (4, 5)
  AND sm.status = 'AKTIF'
ORDER BY sm.nomor_meja, pm.id;
`;

db.all(sql, [], (err, rows) => {
  if (err) {
    console.error("ERROR:", err.message);
    process.exit(1);
  }

  console.log(JSON.stringify(rows, null, 2));
  db.close();
});
