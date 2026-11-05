const sqlite3 = require('sqlite3').verbose();

const db = new sqlite3.Database('C:\\POS\\pos.db');

db.all(`
SELECT
    id,
    session_id,
    nomor_meja,
    nama_pemesan,
    durasi_jam,
    status
FROM sesi_meja
WHERE nomor_meja = 10
  AND status = 'AKTIF'
ORDER BY id DESC
`, (err, rows) => {
    if (err) {
        console.error(err.message);
        process.exitCode = 1;
        return;
    }

    console.log(JSON.stringify(rows, null, 2));
    db.close();
});
