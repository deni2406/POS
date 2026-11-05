const sqlite3 = require('sqlite3');
const srcDb = new sqlite3.Database('C:/pos/pos_server.db');
const destDb = new sqlite3.Database('C:/pos/pos.db');

srcDb.all("SELECT * FROM transaksi", [], (err, rows) => {
  if (err || !rows || rows.length === 0) {
    console.error("Gagal membaca transaksi:", err);
    return;
  }

  console.log(`Membaca ${rows.length} transaksi dari pos_server.db...`);

  destDb.all("PRAGMA table_info(transaksi)", [], (err, destCols) => {
    if (err || !destCols) return;

    const destColNames = destCols.map(c => c.name);
    const srcColNames = Object.keys(rows[0]);

    // Kecualikan 'id' agar auto-increment
    const commonCols = srcColNames.filter(col => destColNames.includes(col) && col !== 'id');

    console.log(`Menyilangkan ${commonCols.length} kolom (tanpa id)...`);

    // Gunakan REPLACE agar menimpa data transaksi lama dengan data real dari server
    const placeholders = commonCols.map(() => '?').join(',');
    const query = `INSERT OR REPLACE INTO transaksi (${commonCols.join(',')}) VALUES (${placeholders})`;

    destDb.serialize(() => {
      const stmt = destDb.prepare(query);
      let inserted = 0;

      rows.forEach(row => {
        const values = commonCols.map(k => row[k]);
        stmt.run(values, function(err) {
          if (!err) inserted++;
        });
      });

      stmt.finalize(() => {
        console.log(`Berhasil! ${inserted} transaksi real November telah dimasukkan/diperbarui di pos.db ThinkPad.`);
        srcDb.close();
        destDb.close();
      });
    });
  });
});
