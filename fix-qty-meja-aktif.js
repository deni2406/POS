const fs = require("fs");
const sqlite3 = require("sqlite3").verbose();

const dbPath = "./pos.db";
const backupPath = "./pos.db.backup-sebelum-koreksi-qty";

fs.copyFileSync(dbPath, backupPath);
console.log("Backup dibuat:", backupPath);

const db = new sqlite3.Database(dbPath);

db.serialize(() => {
  db.run("BEGIN TRANSACTION");

  db.all(`
    SELECT
      s.session_id,
      s.nomor_meja,
      s.durasi_jam
    FROM sesi_meja s
    WHERE s.status = 'AKTIF'
      AND s.nomor_meja IN (1, 2, 4, 5)
    ORDER BY s.nomor_meja
  `, [], (err, sessions) => {
    if (err) {
      console.error(err);
      db.run("ROLLBACK", () => db.close());
      return;
    }

    console.table(sessions);

    let selesai = 0;

    if (!sessions.length) {
      console.log("Tidak ada sesi aktif meja 1, 2, 4, atau 5.");
      db.run("ROLLBACK", () => db.close());
      return;
    }

    for (const s of sessions) {
      const qty = Number(s.durasi_jam);

      db.run(`
        UPDATE pesanan_meja
        SET
          qty = ?,
          subtotal = harga_jual * ?
        WHERE session_id = ?
          AND nama_barang = 'Meja Billiard'
      `, [qty, qty, s.session_id], function(updateErr) {

        if (updateErr) {
          console.error(updateErr);
          db.run("ROLLBACK", () => db.close());
          return;
        }

        console.log(
          `Meja ${s.nomor_meja}: durasi ${qty} jam ? qty ${qty} ? subtotal Rp${(30000 * qty).toLocaleString("id-ID")}`
        );

        selesai++;

        if (selesai === sessions.length) {
          db.run("COMMIT", commitErr => {
            if (commitErr) {
              console.error(commitErr);
              db.run("ROLLBACK", () => db.close());
              return;
            }

            console.log("KOREKSI DATABASE BERHASIL.");
            db.close();
          });
        }
      });
    }
  });
});
