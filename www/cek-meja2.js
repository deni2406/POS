const sqlite3 = require("sqlite3").verbose();
const db = new sqlite3.Database("C:\\POS\\pos.db");

db.all(`
SELECT id, session_id, nomor_meja, nama_pemesan, durasi_jam, status
FROM sesi_meja
WHERE nomor_meja = 2 AND status = 'AKTIF'
`, [], (err, rows) => {
  if (err) throw err;
  console.log(JSON.stringify(rows, null, 2));
  db.close();
});
