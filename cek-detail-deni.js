const sqlite3 = require("sqlite3");
const db = new sqlite3.Database("C:/POS/pos.db", sqlite3.OPEN_READONLY, (err) => {
  if (err) {
    console.error(err.message);
    process.exitCode = 1;
    return;
  }

  const sql = `
    SELECT
      t.id,
      t.nomor_transaksi,
      t.tanggal,
      t.jam,
      t.kasir,
      t.total,
      t.metode_pembayaran,
      t.status_sync,
      d.nama_barang,
      d.qty,
      d.harga_jual,
      d.subtotal
    FROM transaksi t
    LEFT JOIN detail_transaksi d ON d.transaksi_id = t.id
    WHERE lower(trim(t.kasir)) = 'deni'
      AND upper(trim(t.status_sync)) = 'BATAL'
    ORDER BY t.tanggal DESC, t.jam DESC, t.id, d.id
  `;

  db.all(sql, (err, rows) => {
    if (err) {
      console.error("Query gagal:", err.message);
    } else {
      console.log("Jumlah baris detail transaksi batal:", rows.length);
      console.table(rows);
    }
    db.close();
  });
});
