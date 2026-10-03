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
    status
  FROM member
  WHERE nama = 'Juliant'
  ORDER BY id
`, [], (err, rows) => {
  if (err) throw err;
  console.table(rows);
  db.close();
});
