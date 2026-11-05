const sqlite3 = require('sqlite3').verbose();

const db = new sqlite3.Database('C:\\POS\\pos.db');

db.serialize(() => {
    db.all(`
        SELECT
            'member' AS tabel,
            COUNT(*) AS jumlah
        FROM member

        UNION ALL

        SELECT
            'member_cache' AS tabel,
            COUNT(*) AS jumlah
        FROM member_cache

        UNION ALL

        SELECT
            'member_kategori' AS tabel,
            COUNT(*) AS jumlah
        FROM member_kategori
    `, (err, rows) => {
        if (err) {
            console.error(err.message);
            process.exitCode = 1;
            return;
        }

        console.log(JSON.stringify(rows, null, 2));
        db.close();
    });
});
