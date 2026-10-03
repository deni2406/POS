const sqlite3 = require("sqlite3").verbose();

const db = new sqlite3.Database("C:\\POS\\pos.db");

db.run(`
  UPDATE pesanan_meja
  SET
    harga_jual = 10000,
    subtotal = 20000
  WHERE id = 1994
    AND session_id = 'SES-20260922-161723-956'
`, function(err) {
  if (err) {
    console.error("UPDATE ERROR:", err.message);
    process.exitCode = 1;
    db.close();
    return;
  }

  console.log("UPDATE OK. Rows changed:", this.changes);

  db.get(`
    SELECT id, session_id, nama_barang, qty, harga_jual, subtotal
    FROM pesanan_meja
    WHERE id = 1994
      AND session_id = 'SES-20260922-161723-956'
  `, (err, row) => {
    if (err) {
      console.error("VERIFY ERROR:", err.message);
      process.exitCode = 1;
    } else {
      console.log(JSON.stringify(row, null, 2));
    }
    db.close();
  });
});
