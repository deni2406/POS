const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('C:/POS/pos.db');

db.all(`
  SELECT status, COUNT(*) AS jumlah
  FROM member
  WHERE status IN ('MENUNGGU_AKTIF', 'EXPIRED')
  GROUP BY status
  ORDER BY status
`, [], (err, rows) => {
  if (err) throw err;
  console.table(rows);
  db.close();
});
