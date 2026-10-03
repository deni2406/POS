const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('C:/POS/pos.db');

db.run(`
  UPDATE member
  SET status = 'AKTIF',
      updated_at = ?
  WHERE status IN ('EXPIRED', 'MENUNGGU_AKTIF')
`, [new Date().toISOString()], function(err) {
  if (err) throw err;

  console.log('BERHASIL DIUPDATE:', this.changes, 'member');

  db.all(`
    SELECT status, COUNT(*) AS jumlah
    FROM member
    GROUP BY status
    ORDER BY status
  `, [], (err, rows) => {
    if (err) throw err;
    console.table(rows);
    db.close();
  });
});
