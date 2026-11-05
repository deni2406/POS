const sqlite3 = require("sqlite3").verbose();
const db = new sqlite3.Database("C:\\POS\\pos.db");

const kode = ["PLT-0028","PLT-0029","PLT-0030","PLT-0031"];

db.all(`
  SELECT name
  FROM sqlite_master
  WHERE type = 'table'
  ORDER BY name
`, [], (err, tables) => {
  if (err) throw err;

  console.log("TABLE MEMBER TERKAIT:");
  console.table(tables.filter(t =>
    /member|transaksi|pesanan|kunjungan/i.test(t.name)
  ));

  db.close();
});
