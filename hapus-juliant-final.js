const sqlite3 = require("sqlite3").verbose();
const db = new sqlite3.Database("C:\\POS\\pos.db");

db.serialize(() => {
  db.run("BEGIN TRANSACTION");

  db.run(`
    DELETE FROM member
    WHERE id IN (11, 38)
      AND kode_member IN ('PLT-0033', 'PLT-0032')
  `, function(err) {
    if (err) {
      console.error("DELETE member GAGAL:", err.message);
      db.run("ROLLBACK");
      return;
    }

    console.log("member dihapus:", this.changes);

    db.run(`
      DELETE FROM member_cache
      WHERE kode_member IN ('PLT-0032', 'PLT-0033')
    `, function(err2) {
      if (err2) {
        console.error("DELETE member_cache GAGAL:", err2.message);
        db.run("ROLLBACK");
        return;
      }

      console.log("member_cache dihapus:", this.changes);

      db.run("COMMIT", err3 => {
        if (err3) {
          console.error("COMMIT GAGAL:", err3.message);
          return;
        }

        db.all(`
          SELECT id, kode_member, nama, nomor_hp, tanggal_lahir, status
          FROM member
          WHERE nomor_hp = '87887510709'
          ORDER BY id
        `, [], (err4, rows) => {
          if (err4) {
            console.error(err4);
          } else {
            console.log("=== MEMBER TERAKHIR ===");
            console.table(rows);
          }

          db.close();
        });
      });
    });
  });
});
