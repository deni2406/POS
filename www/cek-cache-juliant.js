const sqlite3 = require("sqlite3").verbose();
const db = new sqlite3.Database("C:\\POS\\pos.db");

db.all(`
  SELECT
    id,
    member_id,
    kode_member,
    nama,
    status,
    tanggal_aktif,
    updated_at
  FROM member_cache
  WHERE kode_member IN ('PLT-0028','PLT-0029','PLT-0030','PLT-0031')
  ORDER BY id
`, [], (err, rows) => {
  if (err) {
    console.error(err);
  } else {
    console.table(rows);
  }
  db.close();
});
