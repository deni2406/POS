const sqlite3 = require("sqlite3").verbose();

const db = new sqlite3.Database("C:/POS/pos.db");

db.all(`
  SELECT
    (SELECT COUNT(*) FROM member) AS member_total,
    (SELECT COUNT(*) FROM member_cache) AS cache_total
`, (e, r) => {
  if (e) {
    console.error(e);
    return db.close();
  }

  console.table(r);

  db.get(
    "SELECT member_id,kode_member,nama,status FROM member_cache WHERE kode_member='PLJ-0031'",
    (e2, row) => {
      if (e2) console.error(e2);
      else {
        console.log("PLJ-0031:");
        console.table(row);
      }
      db.close();
    }
  );
});
