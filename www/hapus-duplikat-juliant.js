const sqlite3 = require("sqlite3").verbose();
const db = new sqlite3.Database("C:\\POS\\pos.db");

db.serialize(() => {
  db.run("BEGIN TRANSACTION");

  db.run(`
    DELETE FROM member
    WHERE id IN (8, 9, 10)
      AND kode_member IN ('PLT-0029', 'PLT-0030', 'PLT-0031')
  `, function(err) {
    if (err) {
      console.error("DELETE GAGAL:", err.message);
      db.run("ROLLBACK");
      return;
    }

    console.log("Record dihapus:", this.changes);

    db.run("COMMIT", err2 => {
      if (err2) {
        console.error("COMMIT GAGAL:", err2.message);
        return;
      }

      db.all(`
        SELECT id, kode_member, nama, status
        FROM member
        WHERE nama = 'Juliant'
        ORDER BY id
      `, [], (err3, rows) => {
        if (err3) {
          console.error(err3);
        } else {
          console.log("=== HASIL AKHIR JULIANT ===");
          console.table(rows);
        }

        db.close();
      });
    });
  });
});
