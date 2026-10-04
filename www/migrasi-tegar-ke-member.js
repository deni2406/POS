const sqlite3 = require("sqlite3").verbose();

const db = new sqlite3.Database("C:/POS/pos.db");

const q = `
INSERT INTO member
(kode_member,nama,alamat,nomor_hp,tanggal_lahir,kategori_id,nama_sekolah,nisn,
 tanggal_daftar,tanggal_aktif,last_used_at,status,created_at,updated_at)
SELECT
 kode_member,
 nama,
 alamat,
 nomor_hp,
 tanggal_lahir,
 1,
 nama_sekolah,
 nisn,
 tanggal_daftar,
 tanggal_aktif,
 NULL,
 status,
 updated_at,
 updated_at
FROM member_cache
WHERE kode_member = 'PLJ-0031'
  AND NOT EXISTS (
    SELECT 1 FROM member WHERE kode_member = 'PLJ-0031'
  )
`;

db.run(q, function(e) {
  if (e) {
    console.error("GAGAL:", e.message);
    db.close();
    process.exit(1);
  }

  console.log("BARIS DITAMBAHKAN KE MEMBER:", this.changes);
  db.close();
});
