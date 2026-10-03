const sqlite3 = require("sqlite3").verbose();
const db = new sqlite3.Database("C:\\POS\\pos.db");

const ids = ["7", "8", "9", "10"];
const codes = ["PLT-0028", "PLT-0029", "PLT-0030", "PLT-0031"];

db.all(`
  SELECT name
  FROM sqlite_master
  WHERE type = 'table'
  ORDER BY name
`, [], (err, tables) => {
  if (err) {
    console.error(err);
    db.close();
    return;
  }

  let pending = tables.map(t => t.name);

  function next() {
    if (!pending.length) {
      db.close();
      return;
    }

    const table = pending.shift();

    db.all(`PRAGMA table_info("${table}")`, [], (err, cols) => {
      if (err) return next();

      const memberCols = cols
        .map(c => c.name)
        .filter(c =>
          c === "member_id" ||
          c === "kode_member" ||
          c.includes("member_id") ||
          c.includes("kode_member")
        );

      if (!memberCols.length) return next();

      for (const col of memberCols) {
        const placeholders = codes.map(() => "?").join(",");
        const values = col === "kode_member" ? codes : ids;

        db.all(
          `SELECT * FROM "${table}" WHERE "${col}" IN (${placeholders})`,
          values,
          (e, rows) => {
            if (!e && rows.length) {
              console.log(`\n=== ${table}.${col} ===`);
              console.table(rows);
            }
            next();
          }
        );
        return;
      }

      next();
    });
  }

  next();
});
