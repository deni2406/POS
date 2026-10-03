const sqlite3 = require("sqlite3").verbose();

const db = new sqlite3.Database("C:/POS/pos.db");

const q = "SELECT member_id,kode_member,nama,alamat,nomor_hp,tanggal_lahir,kategori_id,kategori,nama_sekolah,nisn,tanggal_daftar,tanggal_aktif,last_used_at,status,updated_at FROM member_cache WHERE kode_member='PLJ-0031'";

db.get(q, (e, r) => {
  if (e) {
    console.error(e);
    db.close();
    process.exit(1);
  }

  console.table(r);
  db.close();
});
