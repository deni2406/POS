const sqlite3 = require("sqlite3").verbose();
const db = new sqlite3.Database("./pos.db");

db.all(`
  SELECT *
  FROM pesanan_meja
  WHERE session_id = (
    SELECT session_id
    FROM sesi_meja
    WHERE nomor_meja = 3 AND status = "AKTIF"
  )
  ORDER BY id
`, (err, rows) => {
  console.table(rows);
  db.close();
});
