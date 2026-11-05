const sqlite3 = require("sqlite3").verbose();
const db = new sqlite3.Database("C:\\POS\\pos.db");

db.all(`
  SELECT m.id, m.kode_member, m.nama, m.status
  FROM member m
  LEFT JOIN member_cache c ON c.kode_member = m.kode_member
  WHERE c.kode_member IS NULL
  ORDER BY m.id
`, [], (err, rows) => {
  if (err) throw err;
  console.log("MEMBER TANPA CACHE:");
  console.table(rows);
  db.close();
});
