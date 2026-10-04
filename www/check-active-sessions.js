const sqlite3 = require("sqlite3").verbose();

const db = new sqlite3.Database("./pos.db");

db.all(
  `
  SELECT
    nomor_meja,
    session_id,
    waktu_selesai,
    status
  FROM sesi_meja
  WHERE status = 'AKTIF'
  ORDER BY waktu_selesai
  `,
  (err, rows) => {
    if (err) {
      console.error(err);
      process.exitCode = 1;
      db.close();
      return;
    }

    console.table(rows);
    db.close();
  }
);
