const sqlite3 = require('sqlite3').verbose();

const db = new sqlite3.Database('C:\\POS\\pos.db');

db.all(`
SELECT
    id,
    session_id,
    nama_barang,
    qty,
    harga_jual,
    hpp,
    subtotal,
    created_at,
    updated_at
FROM pesanan_meja
WHERE session_id = 'SES-20260922-131112-868'
  AND nama_barang = 'Meja Billiard'
`, (err, rows) => {
    if (err) {
        console.error(err.message);
        process.exitCode = 1;
        return;
    }

    console.log(JSON.stringify(rows, null, 2));
    db.close();
});
