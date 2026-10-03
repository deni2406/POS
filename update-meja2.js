const sqlite3 = require("sqlite3").verbose();
const db = new sqlite3.Database("C:\\POS\\pos.db");

db.run(`
UPDATE pesanan_meja
SET harga_jual = 10000,
    subtotal = 30000
WHERE id = 1457
  AND session_id = 'SES-20260917-095335-283'
`, function(err) {
  if (err) throw err;
  console.log("UPDATE berhasil. Rows berubah:", this.changes);
  db.close();
});
