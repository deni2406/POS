const sqlite3 = require("sqlite3").verbose();
const db = new sqlite3.Database("./pos.db");

db.all(`
  SELECT
    s.nomor_meja,
    s.session_id,
    s.durasi_jam,
    s.status,
    p.nama_barang,
    p.qty,
    p.harga_jual,
    p.subtotal
  FROM sesi_meja s
  LEFT JOIN pesanan_meja p
    ON p.session_id = s.session_id
  WHERE s.status = 'AKTIF'
  ORDER BY s.nomor_meja, p.id
`, [], (err, rows) => {
  if (err) {
    console.error(err);
  } else {
    console.table(rows);
  }
  db.close();
});
