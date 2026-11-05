const sqlite3 = require("sqlite3").verbose();
const db = new sqlite3.Database("C:\\POS\\pos.db");

db.serialize(() => {
  db.get("SELECT COUNT(*) AS total FROM member", (e1, r1) => {
    if (e1) throw e1;
    console.log("MEMBER TOTAL:", r1.total);

    db.get("SELECT COUNT(*) AS total FROM member_cache", (e2, r2) => {
      if (e2) throw e2;
      console.log("CACHE TOTAL:", r2.total);

      db.get(
        "SELECT m.id, m.kode_member, m.nama, m.status, c.member_id, c.status AS cache_status FROM member m LEFT JOIN member_cache c ON c.kode_member = m.kode_member WHERE m.kode_member = 'PLJ-0031'",
        (e3, row) => {
          if (e3) throw e3;
          console.log("PLJ-0031:", row);
          db.close();
        }
      );
    });
  });
});
