const sqlite3 = require("sqlite3");
const db = new sqlite3.Database("C:/POS/pos.db", sqlite3.OPEN_READONLY);
db.all(`
  SELECT
    COUNT(*) AS jumlah_transaksi,
    COALESCE(SUM(total), 0) AS total_nominal,
    metode_pembayaran
  FROM (
    SELECT id, total, metode_pembayaran
    FROM transaksi
    WHERE lower(trim(kasir)) = 'deni'
      AND upper(trim(status_sync)) = 'BATAL'
    GROUP BY id
  )
  GROUP BY metode_pembayaran
`, (err, rows) => {
  if (err) console.error(err.message);
  else console.table(rows);
  db.close();
});
