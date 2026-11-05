const sqlite3 = require('sqlite3').verbose();

const db = new sqlite3.Database('C:\\POS\\pos.db');

db.all(`
SELECT
    m.id,
    m.kode_member,
    m.nama,
    m.status,
    m.tanggal_aktif,
    m.last_used_at,
    mc.status AS cache_status,
    mc.tanggal_aktif AS cache_tanggal_aktif,
    mc.last_used_at AS cache_last_used_at
FROM member m
JOIN member_cache mc
    ON mc.kode_member = m.kode_member
WHERE m.status IN ('EXPIRED', 'AKTIF')
  AND m.status != mc.status
ORDER BY m.id
`, (err, rows) => {
    if (err) {
        console.error(err.message);
        process.exitCode = 1;
        return;
    }

    console.log(JSON.stringify(rows, null, 2));
    db.close();
});
