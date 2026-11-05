const sqlite3 = require("sqlite3").verbose();
const db = new sqlite3.Database("C:\\POS\\pos.db");

const codes = ["PLT-0028", "PLT-0029", "PLT-0030", "PLT-0031"];

db.all(`
  SELECT
    id,
    session_id,
    nomor_meja,
    nama_pemesan,
    member_id,
    kategori_member,
    waktu_mulai,
    waktu_selesai,
    status
  FROM sesi_meja
  WHERE member_id IN (?, ?, ?, ?)
     OR member_id IN (
       SELECT CAST(id AS TEXT)
       FROM member
       WHERE kode_member IN (?, ?, ?, ?)
     )
  ORDER BY id
`, [...codes, ...codes], (err, rows) => {
  if (err) {
    console.error(err);
    db.close();
    return;
  }

  console.table(rows);
  db.close();
});
