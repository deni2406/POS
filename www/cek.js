const sqlite3 = require("sqlite3").verbose();

const db = new sqlite3.Database("C:\\POS\\pos.db");

db.all(`
  SELECT
    id,
    session_id,
    nama_barang,
    qty,
    harga_jual,
    subtotal
  FROM pesanan_meja
  WHERE session_id = 'SES-20260922-161723-956'
    AND LOWER(TRIM(nama_barang)) = 'meja billiard'
`, (err, rows) => {
  if (err) {
    console.error("ERROR:", err.message);
    process.exitCode = 1;
    return;
  }

  console.log(JSON.stringify(rows, null, 2));
  db.close();
});
