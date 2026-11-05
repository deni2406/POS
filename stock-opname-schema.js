const REQUIRED_HEADER_COLUMNS = ["source"];
const REQUIRED_DETAIL_COLUMNS = ["local_master_barang_id"];
const ACTIVE_INDEX = "idx_stock_opname_local_active_category";

function run(db, sql) {
  return new Promise((resolve, reject) => db.run(sql, error => error ? reject(error) : resolve()));
}
function get(db, sql, params = []) {
  return new Promise((resolve, reject) => db.get(sql, params, (error, row) => error ? reject(error) : resolve(row || null)));
}
function all(db, sql, params = []) {
  return new Promise((resolve, reject) => db.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows || [])));
}

async function hasGlobalUniqueCategory(db) {
  const indexes = await all(db, "PRAGMA index_list(stock_opname)");
  for (const index of indexes.filter(entry => Number(entry.unique) === 1 && Number(entry.partial || 0) === 0)) {
    const columns = await all(db, `PRAGMA index_info("${String(index.name).replace(/"/g, '""')}")`);
    if (columns.length === 1 && String(columns[0].name).toLowerCase() === "kategori") return true;
  }
  return false;
}

async function rebuildWithoutGlobalCategoryUnique(db) {
  const header = await all(db, "PRAGMA table_info(stock_opname)");
  const columns = ["id", "so_id", "kategori", "petugas", "tanggal", "revisi_ke", "is_final", "status", "total_plus", "total_minus", "total_kerugian", "source", "created_at", "updated_at"];
  const available = new Set(header.map(column => column.name));
  const defaults = { total_plus: "0", total_minus: "0", total_kerugian: "0", revisi_ke: "0", is_final: "0", status: "'DRAFT'" };
  const select = columns.map(name => !available.has(name) ? (name === "source" ? "'LEGACY'" : defaults[name] || "NULL") : `"${name}"`).join(", ");
  await run(db, "ALTER TABLE stock_opname RENAME TO stock_opname_rebuild_backup");
  await run(db, `CREATE TABLE stock_opname (id INTEGER PRIMARY KEY AUTOINCREMENT, so_id TEXT UNIQUE NOT NULL,
    kategori TEXT NOT NULL, petugas TEXT, tanggal TEXT, revisi_ke INTEGER NOT NULL DEFAULT 0, is_final INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'DRAFT', total_plus REAL NOT NULL DEFAULT 0, total_minus REAL NOT NULL DEFAULT 0,
    total_kerugian REAL NOT NULL DEFAULT 0, source TEXT NOT NULL DEFAULT 'LEGACY', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  await run(db, `INSERT INTO stock_opname (${columns.join(",")}) SELECT ${select} FROM stock_opname_rebuild_backup`);
  await run(db, "DROP TABLE stock_opname_rebuild_backup");
}

async function migrateStockOpnameSchema(db) {
  await run(db, "BEGIN IMMEDIATE");
  try {
    await run(db, `CREATE TABLE IF NOT EXISTS stock_opname (
      id INTEGER PRIMARY KEY AUTOINCREMENT, so_id TEXT UNIQUE NOT NULL, kategori TEXT NOT NULL,
      petugas TEXT, tanggal TEXT, revisi_ke INTEGER NOT NULL DEFAULT 0, is_final INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'DRAFT', total_plus REAL NOT NULL DEFAULT 0, total_minus REAL NOT NULL DEFAULT 0,
      total_kerugian REAL NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
    let header = await all(db, "PRAGMA table_info(stock_opname)");
    for (const [name, ddl] of [["total_plus", "REAL NOT NULL DEFAULT 0"], ["total_minus", "REAL NOT NULL DEFAULT 0"],
      ["total_kerugian", "REAL NOT NULL DEFAULT 0"], ["source", "TEXT NOT NULL DEFAULT 'LEGACY'"]]) {
      if (!header.some(column => column.name === name)) await run(db, `ALTER TABLE stock_opname ADD COLUMN ${name} ${ddl}`);
    }
    if (await hasGlobalUniqueCategory(db)) await rebuildWithoutGlobalCategoryUnique(db);
    // Treat unknown markers as LEGACY so existing legacy queries still see the row;
    // only the two supported markers may select the LOCAL path.
    const trimmedSource = "TRIM(source, char(9) || char(10) || char(11) || char(12) || char(13) || ' ')";
    await run(db, `UPDATE stock_opname SET source = CASE
      WHEN source IS NULL OR ${trimmedSource} = '' THEN 'LEGACY'
      WHEN UPPER(${trimmedSource}) = 'LOCAL' THEN 'LOCAL'
      WHEN UPPER(${trimmedSource}) = 'LEGACY' THEN 'LEGACY'
      ELSE 'LEGACY' END
      WHERE source IS NULL OR source != CASE
        WHEN source IS NULL OR ${trimmedSource} = '' THEN 'LEGACY'
        WHEN UPPER(${trimmedSource}) = 'LOCAL' THEN 'LOCAL'
        WHEN UPPER(${trimmedSource}) = 'LEGACY' THEN 'LEGACY'
        ELSE 'LEGACY' END`);

    await run(db, `CREATE TABLE IF NOT EXISTS stock_opname_detail (
      id INTEGER PRIMARY KEY AUTOINCREMENT, so_id TEXT NOT NULL, id_barang TEXT, nama_barang TEXT, area TEXT, satuan TEXT,
      jumlah_barang_aktual REAL NOT NULL DEFAULT 0, jumlah_hasil_so REAL NOT NULL DEFAULT 0, selisih_barang REAL NOT NULL DEFAULT 0,
      kerugian_hpp REAL NOT NULL DEFAULT 0, kerugian_harga_jual REAL NOT NULL DEFAULT 0, nominal_plus REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
    const detail = await all(db, "PRAGMA table_info(stock_opname_detail)");
    if (!detail.some(column => column.name === "local_master_barang_id")) await run(db, "ALTER TABLE stock_opname_detail ADD COLUMN local_master_barang_id INTEGER");
    await run(db, `CREATE UNIQUE INDEX IF NOT EXISTS ${ACTIVE_INDEX} ON stock_opname(kategori)
      WHERE source = 'LOCAL' AND is_final = 0 AND UPPER(status) != 'FINAL'`);
    await run(db, "CREATE INDEX IF NOT EXISTS idx_stock_opname_detail_so_id ON stock_opname_detail(so_id)");
    await verifyStockOpnameSchema(db);
    await run(db, "COMMIT");
  } catch (error) {
    try { await run(db, "ROLLBACK"); } catch (_) {}
    throw error;
  }
}

async function verifyStockOpnameSchema(db) {
  const header = await all(db, "PRAGMA table_info(stock_opname)");
  const detail = await all(db, "PRAGMA table_info(stock_opname_detail)");
  const missing = [...REQUIRED_HEADER_COLUMNS.filter(name => !header.some(c => c.name === name)),
    ...REQUIRED_DETAIL_COLUMNS.filter(name => !detail.some(c => c.name === name))];
  if (missing.length) throw new Error(`Schema Stock Opname wajib tidak tersedia: ${missing.join(", ")}`);
  const index = await get(db, "SELECT sql FROM sqlite_master WHERE type='index' AND name=?", [ACTIVE_INDEX]);
  if (!index?.sql || !/unique\s+index/i.test(index.sql) || !/where\s+source\s*=\s*'LOCAL'/i.test(index.sql)) {
    throw new Error(`Index Stock Opname wajib ${ACTIVE_INDEX} tidak tersedia atau definisinya tidak sesuai`);
  }
}

module.exports = { migrateStockOpnameSchema, verifyStockOpnameSchema, ACTIVE_INDEX };
