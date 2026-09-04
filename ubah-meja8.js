const sqlite3 = require("sqlite3").verbose();
const db = new sqlite3.Database("./pos.db");

db.run(`
  UPDATE pesanan_meja
  SET qty = 2,
      harga_jual = 10000,
      subtotal = 20000,
      updated_at = datetime('now')
  WHERE session_id = (
    SELECT session_id
    FROM sesi_meja
    WHERE nomor_meja = 8 AND status = "AKTIF"
  )
  AND nama_barang = "Meja Billiard"
`, function(err) {
  if (err) console.error(err);
  else console.log("Meja 8 berhasil diubah:", this.changes);
  db.close();
});
