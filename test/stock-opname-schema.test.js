const test = require("node:test");
const assert = require("node:assert/strict");
const sqlite3 = require("sqlite3").verbose();
const { migrateStockOpnameSchema, verifyStockOpnameSchema, ACTIVE_INDEX } = require("../stock-opname-schema");
const { callLegacyStockOpnameGas, localConflictResponse } = require("../stock-opname-legacy");

function memoryDb() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(":memory:", error => error ? reject(error) : resolve(db));
  });
}
function run(db, sql, params = []) {
  return new Promise((resolve, reject) => db.run(sql, params, error => error ? reject(error) : resolve()));
}
function get(db, sql, params = []) {
  return new Promise((resolve, reject) => db.get(sql, params, (error, row) => error ? reject(error) : resolve(row)));
}
function all(db, sql, params = []) {
  return new Promise((resolve, reject) => db.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows)));
}

test("migrasi schema uji mempertahankan header lama sebagai LEGACY dan kolom identity", async t => {
  const db = await memoryDb(); t.after(() => db.close());
  await run(db, `CREATE TABLE stock_opname (id INTEGER PRIMARY KEY, so_id TEXT UNIQUE NOT NULL,
    kategori TEXT UNIQUE NOT NULL, petugas TEXT, tanggal TEXT, revisi_ke INTEGER NOT NULL DEFAULT 0,
    is_final INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'DRAFT', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  await run(db, `INSERT INTO stock_opname VALUES (1,'SO-OLD-1','MINUMAN','Kasir','2025-01-01',0,0,'HASIL','t','t')`);
  await run(db, `CREATE TABLE stock_opname_detail (id INTEGER PRIMARY KEY, so_id TEXT, local_master_barang_id INTEGER)`);
  await run(db, "INSERT INTO stock_opname_detail VALUES (1,'SO-OLD-1',77)");
  await migrateStockOpnameSchema(db);
  const header = await get(db, "SELECT so_id, source FROM stock_opname WHERE id=1");
  const detail = await get(db, "SELECT local_master_barang_id FROM stock_opname_detail WHERE id=1");
  assert.deepEqual(header, { so_id: "SO-OLD-1", source: "LEGACY" });
  assert.equal(detail.local_master_barang_id, 77);
  await verifyStockOpnameSchema(db);
});

test("jalur rebuild mempertahankan seluruh header dan detail yang sudah tersimpan", async t => {
  const db = await memoryDb(); t.after(() => db.close());
  await run(db, `CREATE TABLE stock_opname (id INTEGER PRIMARY KEY, so_id TEXT UNIQUE NOT NULL,
    kategori TEXT UNIQUE NOT NULL, petugas TEXT, tanggal TEXT, revisi_ke INTEGER NOT NULL DEFAULT 0,
    is_final INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'DRAFT', total_plus REAL NOT NULL DEFAULT 0,
    total_minus REAL NOT NULL DEFAULT 0, total_kerugian REAL NOT NULL DEFAULT 0, source TEXT NOT NULL DEFAULT 'LEGACY',
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  await run(db, `INSERT INTO stock_opname VALUES
    (1,'SO-LOCAL-1','MINUMAN','Ayu','2026-02-03',2,0,'HASIL',12.5,3.25,45.75,'LOCAL','created-1','updated-1')`);
  await run(db, `CREATE TABLE stock_opname_detail (id INTEGER PRIMARY KEY, so_id TEXT, id_barang TEXT, nama_barang TEXT,
    area TEXT, satuan TEXT, jumlah_barang_aktual REAL, jumlah_hasil_so REAL, selisih_barang REAL,
    kerugian_hpp REAL, kerugian_harga_jual REAL, nominal_plus REAL, created_at TEXT, updated_at TEXT,
    local_master_barang_id INTEGER)`);
  await run(db, `INSERT INTO stock_opname_detail VALUES
    (1,'SO-LOCAL-1','RK62','Barang lokal A','Rak 1','pcs',4,7,3,10,15,0,'dc1','du1',62),
    (2,'SO-LOCAL-1','RK68','Barang lokal B','Rak 2','box',9,8,-1,20,25,0,'dc2','du2',68)`);
  const headersBefore = await all(db, `SELECT id, so_id, kategori, petugas, tanggal, revisi_ke, is_final, status,
    total_plus, total_minus, total_kerugian, source, created_at, updated_at FROM stock_opname ORDER BY id`);
  const detailsBefore = await all(db, `SELECT id, so_id, id_barang, nama_barang, area, satuan, jumlah_barang_aktual,
    jumlah_hasil_so, selisih_barang, kerugian_hpp, kerugian_harga_jual, nominal_plus, created_at, updated_at,
    local_master_barang_id FROM stock_opname_detail ORDER BY id`);
  await migrateStockOpnameSchema(db);
  assert.deepEqual(await all(db, `SELECT id, so_id, kategori, petugas, tanggal, revisi_ke, is_final, status,
    total_plus, total_minus, total_kerugian, source, created_at, updated_at FROM stock_opname ORDER BY id`), headersBefore);
  assert.deepEqual(await all(db, `SELECT id, so_id, id_barang, nama_barang, area, satuan, jumlah_barang_aktual,
    jumlah_hasil_so, selisih_barang, kerugian_hpp, kerugian_harga_jual, nominal_plus, created_at, updated_at,
    local_master_barang_id FROM stock_opname_detail ORDER BY id`), detailsBefore);
});

test("migrasi menormalkan source whitespace dan marker dikenal, unknown aman ke LEGACY", async t => {
  const db = await memoryDb(); t.after(() => db.close());
  await run(db, `CREATE TABLE stock_opname (id INTEGER PRIMARY KEY, so_id TEXT UNIQUE, kategori TEXT,
    is_final INTEGER DEFAULT 0, status TEXT DEFAULT 'DRAFT', source TEXT, created_at TEXT, updated_at TEXT)`);
  await run(db, `INSERT INTO stock_opname (id,so_id,kategori,source,created_at,updated_at) VALUES
    (1,'OLD-NULL','MINUMAN',NULL,'t','t'), (2,'OLD-EMPTY','SNACK','','t','t'),
    (3,'SPACE','SPACE','   ','t','t'), (4,'TAB','TAB',char(9),'t','t'),
    (5,'LF','LF',char(10),'t','t'), (6,'CR','CR',char(13),'t','t'),
    (7,'VT','VT',char(11),'t','t'), (8,'FF','FF',char(12),'t','t'),
    (9,'MIXED','MIXED',char(9)||' '||char(10)||char(13)||char(11)||char(12),'t','t'),
    (10,'LOCAL-LOWER','LOCAL-LOWER','local','t','t'), (11,'LOCAL-UPPER','LOCAL-UPPER','LOCAL','t','t'),
    (12,'LOCAL-MIXED','LOCAL-MIXED','LoCaL','t','t'), (13,'LOCAL-EDGE','LOCAL-EDGE',' LOCAL ','t','t'),
    (14,'LEGACY-LOWER','LEGACY-LOWER','legacy','t','t'), (15,'LEGACY-UPPER','LEGACY-UPPER','LEGACY','t','t'),
    (16,'LEGACY-MIXED','LEGACY-MIXED','LeGaCy','t','t'), (17,'LEGACY-EDGE','LEGACY-EDGE',' LEGACY ','t','t'),
    (18,'UNKNOWN-LOKAL','UNKNOWN-LOKAL','LOKAL','t','t'), (19,'UNKNOWN-LOCALX','UNKNOWN-LOCALX','LOCALX','t','t'),
    (20,'UNKNOWN-XLOCAL','UNKNOWN-XLOCAL','XLOCAL','t','t'), (21,'UNKNOWN-FUTURE','UNKNOWN-FUTURE','FUTURE_SOURCE','t','t')`);
  await run(db, "CREATE TABLE stock_opname_detail (id INTEGER PRIMARY KEY, so_id TEXT)");
  await run(db, "INSERT INTO stock_opname_detail VALUES (1,'OLD-NULL')");
  await migrateStockOpnameSchema(db);
  assert.deepEqual(await new Promise((resolve, reject) => db.all("SELECT source FROM stock_opname ORDER BY id", (e, rows) => e ? reject(e) : resolve(rows))),
    ["LEGACY", "LEGACY", "LEGACY", "LEGACY", "LEGACY", "LEGACY", "LEGACY", "LEGACY", "LEGACY",
      "LOCAL", "LOCAL", "LOCAL", "LOCAL", "LEGACY", "LEGACY", "LEGACY", "LEGACY",
      "LEGACY", "LEGACY", "LEGACY", "LEGACY"]
      .map(source => ({ source })));
  assert.equal((await get(db, "SELECT COUNT(*) AS n FROM stock_opname_detail")).n, 1);
});

test("jalur rebuild gagal secara atomik dan memulihkan header serta detail", async t => {
  const db = await memoryDb(); t.after(() => db.close());
  // created_at is nullable in the old schema, so copying this row fails against
  // the rebuilt schema's NOT NULL constraint after the table has been renamed.
  await run(db, `CREATE TABLE stock_opname (id INTEGER PRIMARY KEY, so_id TEXT UNIQUE,
    kategori TEXT UNIQUE, source TEXT, created_at TEXT, updated_at TEXT)`);
  await run(db, "INSERT INTO stock_opname VALUES (1,'OLD-FAIL','MINUMAN','LOCAL',NULL,'t')");
  await run(db, "CREATE TABLE stock_opname_detail (id INTEGER PRIMARY KEY, so_id TEXT, note TEXT)");
  await run(db, "INSERT INTO stock_opname_detail VALUES (1,'OLD-FAIL','tetap ada')");
  await assert.rejects(migrateStockOpnameSchema(db), /NOT NULL constraint failed/);
  assert.deepEqual(await get(db, "SELECT so_id, source, created_at FROM stock_opname WHERE id=1"),
    { so_id: "OLD-FAIL", source: "LOCAL", created_at: null });
  assert.deepEqual(await get(db, "SELECT so_id, note FROM stock_opname_detail WHERE id=1"),
    { so_id: "OLD-FAIL", note: "tetap ada" });
  assert.equal((await get(db, "SELECT COUNT(*) AS n FROM sqlite_master WHERE name='stock_opname_rebuild_backup'")).n, 0);
});

test("migrasi rollback utuh saat langkah normalisasi gagal", async t => {
  const db = await memoryDb(); t.after(() => db.close());
  await run(db, `CREATE TABLE stock_opname (id INTEGER PRIMARY KEY, so_id TEXT, kategori TEXT,
    is_final INTEGER DEFAULT 0, status TEXT DEFAULT 'DRAFT', source TEXT, created_at TEXT, updated_at TEXT)`);
  await run(db, "INSERT INTO stock_opname (id,so_id,kategori,source,created_at,updated_at) VALUES (1,'OLD-1','MINUMAN',NULL,'t','t')");
  await run(db, "CREATE TABLE stock_opname_detail (id INTEGER PRIMARY KEY, so_id TEXT)");
  await run(db, "INSERT INTO stock_opname_detail VALUES (1,'OLD-1')");
  await run(db, "CREATE TRIGGER fail_source_update BEFORE UPDATE OF source ON stock_opname BEGIN SELECT RAISE(ABORT, 'injected migration failure'); END");
  await assert.rejects(migrateStockOpnameSchema(db), /injected migration failure/);
  assert.deepEqual(await get(db, "SELECT source FROM stock_opname WHERE id=1"), { source: null });
  assert.equal((await get(db, "SELECT COUNT(*) AS n FROM stock_opname_detail")).n, 1);
  assert.equal((await get(db, "SELECT COUNT(*) AS n FROM sqlite_master WHERE name=?", [ACTIVE_INDEX])).n, 0);
  assert.equal((await get(db, "SELECT COUNT(*) AS n FROM sqlite_master WHERE name='stock_opname_rebuild_backup'")).n, 0);
});

for (const uniqueStyle of ["inline", "index"]) {
  test(`migrasi menghapus UNIQUE kategori ${uniqueStyle} lama dan mempertahankan data`, async t => {
    const db = await memoryDb(); t.after(() => db.close());
    await run(db, `CREATE TABLE stock_opname (id INTEGER PRIMARY KEY, so_id TEXT UNIQUE, kategori TEXT NOT NULL${uniqueStyle === "inline" ? " UNIQUE" : ""},
      source TEXT, created_at TEXT, updated_at TEXT)`);
    if (uniqueStyle === "index") await run(db, "CREATE UNIQUE INDEX old_unique_category ON stock_opname(kategori)");
    await run(db, "INSERT INTO stock_opname VALUES (1,'OLD-1','MINUMAN','LEGACY','t','t')");
    await run(db, "CREATE TABLE stock_opname_detail (id INTEGER PRIMARY KEY, so_id TEXT)");
    await migrateStockOpnameSchema(db);
    await run(db, "INSERT INTO stock_opname (so_id,kategori,source,created_at,updated_at) VALUES ('OLD-2','MINUMAN','LEGACY','t','t')");
    assert.equal((await get(db, "SELECT COUNT(*) AS n FROM stock_opname WHERE kategori='MINUMAN'")).n, 2);
  });
}

test("migrasi idempotent saat dijalankan dua kali", async t => {
  const db = await memoryDb(); t.after(() => db.close());
  await migrateStockOpnameSchema(db);
  await run(db, `INSERT INTO stock_opname (so_id,kategori,petugas,tanggal,revisi_ke,is_final,status,total_plus,
    total_minus,total_kerugian,source,created_at,updated_at)
    VALUES ('LOCAL-1','MINUMAN','Kasir','2026-03-04',3,0,'HASIL',8,2,10,'LOCAL','created','updated')`);
  await run(db, `INSERT INTO stock_opname_detail (so_id,id_barang,nama_barang,area,satuan,jumlah_barang_aktual,
    jumlah_hasil_so,selisih_barang,kerugian_hpp,kerugian_harga_jual,nominal_plus,created_at,updated_at,local_master_barang_id)
    VALUES ('LOCAL-1','RK62','Barang A','Rak A','pcs',5,7,2,0,0,0,'detail-created','detail-updated',62),
           ('LOCAL-1','RK68','Barang B','Rak B','box',9,8,-1,4,5,0,'detail-created-2','detail-updated-2',68)`);
  const headersBefore = await all(db, "SELECT * FROM stock_opname ORDER BY id");
  const detailsBefore = await all(db, "SELECT * FROM stock_opname_detail ORDER BY id");
  await migrateStockOpnameSchema(db);
  assert.deepEqual(await all(db, "SELECT * FROM stock_opname ORDER BY id"), headersBefore);
  assert.deepEqual(await all(db, "SELECT * FROM stock_opname_detail ORDER BY id"), detailsBefore);
  assert.equal((await get(db, "SELECT COUNT(*) AS n FROM stock_opname")).n, headersBefore.length);
  assert.equal((await get(db, "SELECT COUNT(*) AS n FROM stock_opname_detail")).n, detailsBefore.length);
  assert.equal((await get(db, "SELECT COUNT(*) AS n FROM sqlite_master WHERE name=?", [ACTIVE_INDEX])).n, 1);
});

test("schema wajib gagal dengan pesan jelas jika source, local identity, atau index tidak tersedia", async t => {
  const db = await memoryDb(); t.after(() => db.close());
  await run(db, "CREATE TABLE stock_opname (id INTEGER)");
  await run(db, "CREATE TABLE stock_opname_detail (id INTEGER)");
  await assert.rejects(verifyStockOpnameSchema(db), /source, local_master_barang_id/);
});

test("unique partial index conflict dipetakan ke 409 SO_STILL_ACTIVE", async t => {
  const db = await memoryDb(); t.after(() => db.close());
  await migrateStockOpnameSchema(db);
  await run(db, "INSERT INTO stock_opname (so_id,kategori,source,created_at,updated_at) VALUES ('LOCAL-1','MINUMAN','LOCAL','t','t')");
  let conflict;
  try { await run(db, "INSERT INTO stock_opname (so_id,kategori,source,created_at,updated_at) VALUES ('LOCAL-2','MINUMAN','LOCAL','t','t')"); }
  catch (error) { conflict = error; }
  assert.ok(conflict);
  assert.match((await get(db, "SELECT sql FROM sqlite_master WHERE name=?", [ACTIVE_INDEX])).sql, /UNIQUE INDEX/i);
  assert.deepEqual(localConflictResponse(conflict), {
    status: 409,
    body: { success: false, code: "SO_STILL_ACTIVE", message: conflict.message }
  });
});

test("endpoint legacy dinonaktifkan untuk semua payload tanpa panggilan eksternal", async () => {
  let callCount = 0;
  const callGas = async () => { callCount += 1; return { success: true }; };
  for (const source of ["LOCAL", "local", "Local", " LOCAL ", "\tlocal\n"]) {
    await assert.rejects(callLegacyStockOpnameGas({ source }, { action: "proses_stock_opname" }, callGas), error =>
      error.statusCode === 503 && error.code === "LOCAL_SO_NOT_ALLOWED");
  }
  await assert.rejects(callLegacyStockOpnameGas({ soId: "SO-LOCAL-123" }, { action: "proses_stock_opname" }, callGas), error =>
    error.statusCode === 503 && error.code === "LOCAL_SO_NOT_ALLOWED");
  await assert.rejects(callLegacyStockOpnameGas({ source: " local ", items: [] }, {}, callGas), /lokal/);
  await assert.rejects(callLegacyStockOpnameGas({ items: [{ source: " Local " }] }, {}, callGas), /lokal/);
  await assert.rejects(callLegacyStockOpnameGas({ items: [{ local_master_barang_id: 42 }] }, {}, callGas), error =>
    error.statusCode === 503 && error.code === "LOCAL_SO_NOT_ALLOWED");
  assert.equal(callCount, 0);
  await assert.rejects(callLegacyStockOpnameGas({ soId: "SO-OLD-1", category: "MINUMAN" }), error =>
    error.statusCode === 503 && error.code === "SO_LEGACY_DISABLED");
  assert.equal(callCount, 0);
});

test("konflik selain unique kategori tidak dipetakan sebagai SO aktif", () => {
  assert.equal(localConflictResponse({ code: "SQLITE_CONSTRAINT_UNIQUE", message: "UNIQUE constraint failed: stock_opname.so_id" }), null);
  assert.equal(localConflictResponse({ code: "SQLITE_CONSTRAINT_TRIGGER", message: "injected error" }), null);
  assert.equal(localConflictResponse({ code: "SO_ITEM_NOT_FOUND", message: "missing" }), null);
});
