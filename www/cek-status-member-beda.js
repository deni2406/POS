const sqlite3 = require('sqlite3').verbose();

const db = new sqlite3.Database('C:\\POS\\pos.db');

db.all(`
SELECT
    m.id,
    m.kode_member,
    m.nama,
    m.status AS status_member,
    mc.status AS status_cache,
    m.updated_at AS updated_member,
    mc.updated_at AS updated_cache
FROM member m
JOIN member_cache mc
    ON mc.kode_member = m.kode_member
WHERE m.status != mc.status
ORDER BY m.id
`, (err, rows) => {
    if (err) {
        console.error(err.message);
        process.exitCode = 1;
        return;
    }

    console.log('Jumlah berbeda:', rows.length);
    console.log(JSON.stringify(rows, null, 2));
    db.close();
});
