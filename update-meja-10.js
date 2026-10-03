const sqlite3 = require('sqlite3').verbose();

const db = new sqlite3.Database('C:\\POS\\pos.db');

db.serialize(() => {
    db.run('BEGIN IMMEDIATE');

    db.run(`
        UPDATE pesanan_meja
        SET harga_jual = 10000,
            subtotal = 30000
        WHERE id = 1972
          AND session_id = 'SES-20260922-131112-868'
    `, function(err) {
        if (err) {
            console.error('UPDATE GAGAL:', err.message);
            return db.run('ROLLBACK');
        }

        if (this.changes !== 1) {
            console.error('UPDATE DIBATALKAN: target tidak ditemukan.');
            return db.run('ROLLBACK');
        }

        db.get(`
            SELECT
                id,
                session_id,
                nama_barang,
                qty,
                harga_jual,
                subtotal
            FROM pesanan_meja
            WHERE id = 1972
              AND session_id = 'SES-20260922-131112-868'
        `, (err, row) => {
            if (err) {
                console.error('VERIFIKASI GAGAL:', err.message);
                return db.run('ROLLBACK');
            }

            if (
                !row ||
                row.id !== 1972 ||
                row.session_id !== 'SES-20260922-131112-868' ||
                row.qty !== 3 ||
                row.harga_jual !== 10000 ||
                row.subtotal !== 30000
            ) {
                console.error('VERIFIKASI GAGAL: data tidak sesuai. ROLLBACK.');
                return db.run('ROLLBACK');
            }

            db.run('COMMIT', err => {
                if (err) {
                    console.error('COMMIT GAGAL:', err.message);
                    return;
                }

                console.log('UPDATE BERHASIL DAN TERVERIFIKASI:');
                console.log(JSON.stringify(row, null, 2));
                db.close();
            });
        });
    });
});
