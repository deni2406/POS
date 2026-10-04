const sqlite3 = require("sqlite3").verbose();

const db = new sqlite3.Database("C:\\POS\\pos.db");

const updates = [
  {
    id: 2004,
    session_id: "SES-20260922-173501-487",
    harga_jual: 15000,
    subtotal: 30000
  },
  {
    id: 2006,
    session_id: "SES-20260922-175036-184",
    harga_jual: 15000,
    subtotal: 30000
  }
];

db.serialize(() => {
  const stmt = db.prepare(`
    UPDATE pesanan_meja
    SET harga_jual = ?, subtotal = ?, updated_at = datetime('now')
    WHERE id = ?
      AND session_id = ?
  `);

  for (const u of updates) {
    stmt.run(
      u.harga_jual,
      u.subtotal,
      u.id,
      u.session_id,
      function(err) {
        if (err) {
          console.error("ERROR:", err.message);
        } else {
          console.log(
            `UPDATE id=${u.id}, session_id=${u.session_id}, changes=${this.changes}`
          );
        }
      }
    );
  }

  stmt.finalize(() => {
    db.close();
  });
});
