const sqlite3 = require("sqlite3");
const db = new sqlite3.Database("C:/POS/pos.db", sqlite3.OPEN_READONLY, (err) => {
  if (err) {
    console.error(err.message);
    process.exitCode = 1;
    return;
  }

  db.all(
    "SELECT id, nomor_transaksi, tanggal, jam, kasir, total, metode_pembayaran, status_sync, tipe_transaksi, nomor_meja FROM transaksi WHERE lower(trim(kasir)) LIKE ? ORDER BY tanggal DESC, jam DESC",
    ["%deni%"],
    (err, rows) => {
      if (err) {
        console.error(err.message);
      } else {
        console.log("Jumlah transaksi Deni:", rows.length);
        console.table(rows);
      }
      db.close();
    }
  );
});
