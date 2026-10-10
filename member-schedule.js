const sqlite3 = require("sqlite3");

function isMorningHour(hour) {
  const h = Number(hour);
  return Number.isFinite(h) && h >= 7 && h < 18;
}

function isNightHour(hour) {
  const h = Number(hour);
  return Number.isFinite(h) && (h >= 18 || h < 7);
}

function runMonthlyArchiveCheck(dbPath = "./pos.db") {
  const db = new sqlite3.Database(dbPath);
  const now = new Date();
  
  const currentPeriode = now.toISOString().slice(0, 7);
  const prevDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const prevPeriode = prevDate.toISOString().slice(0, 7);

  db.get(
    "SELECT COUNT(*) as count FROM member_pengeluaran_bulanan WHERE periode = ?",
    [prevPeriode],
    (err, row) => {
      if (err) {
        console.error("[Scheduler] Error checking archive:", err.message);
        db.close();
        return;
      }

      if (row && row.count > 0) {
        db.close();
        return;
      }

      console.log("[Scheduler] Otomatis mengarsip periode " + prevPeriode + "...");
      const nowIso = new Date().toISOString();

      db.serialize(() => {
        const sqlArsip = "INSERT OR REPLACE INTO member_pengeluaran_bulanan (kode_member, periode, total_kunjungan, total_pengeluaran, created_at) SELECT t.member_id AS kode_member, ? AS periode, COUNT(t.id) AS total_kunjungan, SUM(t.total) AS total_pengeluaran, ? AS created_at FROM transaksi t WHERE strftime('%Y-%m', t.tanggal) = ? AND t.member_id IS NOT NULL AND TRIM(t.member_id) != '' GROUP BY t.member_id;";

        db.run(sqlArsip, [prevPeriode, nowIso, prevPeriode], function (err) {
          if (err) {
            console.error("[Scheduler] Gagal mengarsip:", err.message);
            db.close();
            return;
          }
          console.log("[Scheduler] Berhasil mengarsip " + this.changes + " member untuk periode " + prevPeriode + ".");

          db.run("UPDATE member_cache SET total_kunjungan = 0, total_pengeluaran = 0, updated_at = ?", [nowIso], (err) => {
            if (err) {
              console.error("[Scheduler] Gagal reset cache:", err.message);
              db.close();
              return;
            }

            const sqlUpdateCache = "UPDATE member_cache SET total_kunjungan = (SELECT COUNT(t.id) FROM transaksi t WHERE LOWER(t.member_id) = LOWER(member_cache.kode_member) AND strftime('%Y-%m', t.tanggal) = ?), total_pengeluaran = COALESCE((SELECT SUM(t.total) FROM transaksi t WHERE LOWER(t.member_id) = LOWER(member_cache.kode_member) AND strftime('%Y-%m', t.tanggal) = ?), 0), updated_at = ?";

            db.run(sqlUpdateCache, [currentPeriode, currentPeriode, nowIso], function (err) {
              if (err) {
                console.error("[Scheduler] Gagal update member_cache:", err.message);
              } else {
                console.log("[Scheduler] member_cache diperbarui untuk periode " + currentPeriode + ".");
              }
              db.close();
            });
          });
        });
      });
    }
  );
}

function initScheduler() {
  runMonthlyArchiveCheck();
  setInterval(runMonthlyArchiveCheck, 3600000);
}

module.exports = { initScheduler, runMonthlyArchiveCheck, isMorningHour, isNightHour };
