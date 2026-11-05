const fs = require("fs");

const file = "C:/POS/server.js";
const src = fs.readFileSync(file, "utf8");

const start = src.indexOf('        let gasPayload = {};');
const endMarker = '        return res.end(JSON.stringify({';
const endStart = src.indexOf(endMarker, src.indexOf('        syncMemberCacheFromGas().catch(err => {'));
const endEnd = src.indexOf('        }));', endStart) + '        }));'.length;

if (start === -1 || endStart === -1 || endEnd === -1) {
  console.error("TARGET CREATE MEMBER TIDAK DITEMUKAN. TIDAK ADA PERUBAHAN.");
  process.exit(1);
}

const newBlock = `        const prefixMap = {
          PLATINUM: { prefix: "PLT", baseId: 1000000, kategoriDbId: 3 },
          UMUM: { prefix: "UMM", baseId: 2000000, kategoriDbId: 2 },
          PELAJAR: { prefix: "PLJ", baseId: 3000000, kategoriDbId: 1 }
        };

        const cfg = prefixMap[kategoriId];
        const nowIso = new Date().toISOString();

        const result = await new Promise((resolve, reject) => {
          db.serialize(() => {
            const sqlMax = \`
              SELECT MAX(nomor) AS nomor
              FROM (
                SELECT CAST(substr(kode_member, 5) AS INTEGER) AS nomor
                FROM member
                WHERE kode_member LIKE ?

                UNION ALL

                SELECT CAST(substr(kode_member, 5) AS INTEGER) AS nomor
                FROM member_cache
                WHERE kode_member LIKE ?
              )
            \`;

            db.get(sqlMax, [cfg.prefix + "-%", cfg.prefix + "-%"], (err, row) => {
              if (err) return reject(err);

              const nomor = Number(row?.nomor || 0) + 1;
              const kodeMember = cfg.prefix + "-" + String(nomor).padStart(4, "0");
              const memberId = cfg.baseId + nomor;

              db.run(
                \`
                INSERT INTO member
                (kode_member, nama, alamat, nomor_hp, tanggal_lahir, kategori_id,
                 nama_sekolah, nisn, tanggal_daftar, tanggal_aktif, last_used_at,
                 status, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                \`,
                [
                  kodeMember,
                  nama,
                  alamat,
                  nomorHp,
                  tanggalLahir,
                  cfg.kategoriDbId,
                  kategoriId === "PELAJAR" ? namaSekolah : null,
                  kategoriId === "PELAJAR" ? nisn : null,
                  nowIso,
                  nowIso,
                  null,
                  "MENUNGGU_AKTIF",
                  nowIso,
                  nowIso
                ],
                function(insertErr) {
                  if (insertErr) return reject(insertErr);

                  db.run(
                    \`
                    INSERT OR REPLACE INTO member_cache
                    (member_id, kode_member, nama, alamat, nomor_hp, tanggal_lahir,
                     kategori_id, kategori, nama_sekolah, nisn, tanggal_daftar,
                     tanggal_aktif, last_used_at, status, total_kunjungan,
                     total_pengeluaran, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    \`,
                    [
                      memberId,
                      kodeMember,
                      nama,
                      alamat,
                      nomorHp,
                      tanggalLahir,
                      kategoriId,
                      kategoriId,
                      kategoriId === "PELAJAR" ? namaSekolah : null,
                      kategoriId === "PELAJAR" ? nisn : null,
                      nowIso,
                      nowIso,
                      null,
                      "MENUNGGU_AKTIF",
                      0,
                      0,
                      nowIso
                    ],
                    cacheErr => {
                      if (cacheErr) return reject(cacheErr);

                      resolve({
                        success: true,
                        message: "Member berhasil didaftarkan.",
                        data: {
                          id: this.lastID,
                          member_id: memberId,
                          idMember: kodeMember,
                          kodeMember,
                          nama,
                          kategoriId
                        }
                      });
                    }
                  );
                }
              );
            });
          });
        });

        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify(result));`;

const out = src.slice(0, start) + newBlock + src.slice(endEnd);
fs.writeFileSync(file, out, "utf8");

console.log("PATCH CREATE MEMBER LOKAL BERHASIL.");
