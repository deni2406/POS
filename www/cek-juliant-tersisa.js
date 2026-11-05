const sqlite3 = require("sqlite3").verbose();
const db = new sqlite3.Database("C:\\POS\\pos.db");

db.all(`
  SELECT *
  FROM sesi_meja
  WHERE member_id IN ('PLT-0028','PLT-0032','PLT-0033')
  ORDER BY id
`, [], (err, rows) => {
  if (err) console.error(err);
  else console.table(rows);
  db.close();
});
