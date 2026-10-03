const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('C:/POS/pos.db');

db.all(`
  SELECT id, kode_member, nama, status, tanggal_aktif
  FROM member
  WHERE status = 'MENUNGGU_AKTIF'
  ORDER BY id
`, [], (err, rows) => {
  if (err) throw err;
  console.table(rows);
  console.log('TOTAL MENUNGGU_AKTIF:', rows.length);
  db.close();
});
