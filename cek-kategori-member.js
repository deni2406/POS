const sqlite3 = require('sqlite3').verbose();

const db = new sqlite3.Database('C:\\POS\\pos.db');

db.all(`
SELECT
    mk.id AS kategori_id,
    mk.nama AS kategori,
    COUNT(m.id) AS jumlah_member
FROM member_kategori mk
LEFT JOIN member m ON m.kategori_id = mk.id
GROUP BY mk.id, mk.nama
ORDER BY mk.id
`, (err, rows) => {
    if (err) {
        console.error(err.message);
        process.exitCode = 1;
        return;
    }

    console.log(JSON.stringify(rows, null, 2));
    db.close();
});
