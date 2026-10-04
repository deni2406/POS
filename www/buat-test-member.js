const sqlite3 = require("sqlite3").verbose();
const db = new sqlite3.Database("C:\\POS\\pos.db");

const now = new Date().toISOString();
const tomorrow = new Date(Date.now() + 86400000).toISOString();

db.run(
  `INSERT INTO member
   (kode_member,nama,alamat,nomor_hp,tanggal_lahir,kategori_id,nama_sekolah,nisn,tanggal_daftar,tanggal_aktif,last_used_at,status,created_at,updated_at)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  [
    "TEST-MBR-001",
    "TEST MEMBER BELUM AKTIF",
    "",
    "",
    null,
    2,
    null,
    null,
    now,
    tomorrow,
    null,
    "MENUNGGU_AKTIF",
    now,
    now
  ],
  function(err) {
    if (err) throw err;
    console.log("MEMBER TEST BERHASIL DIBUAT, ID:", this.lastID);
    db.close();
  }
);
