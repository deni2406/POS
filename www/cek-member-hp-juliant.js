const sqlite3 = require("sqlite3").verbose();
const db = new sqlite3.Database("C:\\POS\\pos.db");

db.all(`
  SELECT
    id,
    kode_member,
    nama,
    alamat,
    nomor_hp,
    tanggal_lahir,
    kategori_id,
    nama_sekolah,
    nisn,
    tanggal_daftar,
    tanggal_aktif,
    last_used_at,
    status
  FROM member
  WHERE nomor_hp = '87887510709'
  ORDER BY id
`, [], (err, rows) => {
  if (err) console.error(err);
  else console.table(rows);
  db.close();
});
