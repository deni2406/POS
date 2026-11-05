const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./pos.db');

db.run("ALTER TABLE riwayat_barang_keluar ADD COLUMN transaksi_id TEXT;", (err) => {
  if (err) {
    if (err.message.includes("duplicate column name")) {
      console.log("Kolom transaksi_id sudah ada di dalam tabel.");
    } else {
      console.error("Gagal menambahkan kolom:", err.message);
    }
  } else {
    console.log("Kolom transaksi_id berhasil ditambahkan ke tabel riwayat_barang_keluar.");
  }
  db.close();
});
