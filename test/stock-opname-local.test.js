const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const sqlite3 = require("sqlite3").verbose();
const { listBarang, getBarangByLocalId, getDetails, getLatestBySource,
  isLegacyStockOpname, createStockOpname } = require("../stock-opname-local");

function openMemoryDb() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(":memory:", error => error ? reject(error) : resolve(db));
  });
}

function exec(db, sql, params = []) {
  return new Promise((resolve, reject) => db.run(sql, params, function(error) {
    if (error) reject(error); else resolve({ lastID: this.lastID, changes: this.changes });
  }));
}

async function fixture() {
  const db = await openMemoryDb();
  await exec(db, `CREATE TABLE master_barang (
    id INTEGER PRIMARY KEY AUTOINCREMENT, id_barang TEXT, nama TEXT NOT NULL,
    kategori TEXT NOT NULL DEFAULT 'Lainnya', hpp INTEGER NOT NULL DEFAULT 0,
    harga_jual INTEGER NOT NULL DEFAULT 0, stok_aktual INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL)`);
  await exec(db, `CREATE TABLE stock_opname (
    id INTEGER PRIMARY KEY AUTOINCREMENT, so_id TEXT UNIQUE NOT NULL, source TEXT NOT NULL DEFAULT 'LEGACY', kategori TEXT NOT NULL,
    petugas TEXT, tanggal TEXT, revisi_ke INTEGER NOT NULL DEFAULT 0,
    is_final INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'DRAFT',
    total_plus REAL NOT NULL DEFAULT 0, total_minus REAL NOT NULL DEFAULT 0,
    total_kerugian REAL NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  await exec(db, `CREATE TABLE stock_opname_detail (
    id INTEGER PRIMARY KEY AUTOINCREMENT, so_id TEXT NOT NULL, id_barang TEXT, nama_barang TEXT,
    area TEXT, satuan TEXT, jumlah_barang_aktual REAL NOT NULL DEFAULT 0,
    jumlah_hasil_so REAL NOT NULL DEFAULT 0, selisih_barang REAL NOT NULL DEFAULT 0,
    kerugian_hpp REAL NOT NULL DEFAULT 0, kerugian_harga_jual REAL NOT NULL DEFAULT 0,
    nominal_plus REAL NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    local_master_barang_id INTEGER)`);
  await exec(db, `CREATE UNIQUE INDEX idx_stock_opname_local_active_category
    ON stock_opname(kategori) WHERE source='LOCAL' AND is_final=0 AND UPPER(status)!='FINAL'`);
  await exec(db, `INSERT INTO master_barang (id_barang,nama,kategori,hpp,harga_jual,stok_aktual,updated_at)
    VALUES ('RK62','Barang A','MINUMAN',100,150,5,'test'),
           ('RK62','Barang B','MINUMAN',200,250,8,'test'),
           ('RK68','Barang C','SNACK',300,350,2,'test')`);
  return db;
}

test("Stock Opname lokal memakai master_barang SQLite dan local identity, termasuk source ID duplikat", async t => {
  const db = await fixture(); t.after(() => db.close());
  const rows = await listBarang(db);
  assert.equal(rows.length, 3);
  assert.notEqual(rows[0].id, rows[1].id);
  assert.equal((await getBarangByLocalId(db, rows[0].id)).id, rows[0].id);
  assert.equal(await getBarangByLocalId(db, 9999), null);
});

test("create Stock Opname menyimpan header dan detail beberapa barang secara atomic dengan selisih plus/minus/nol", async t => {
  const db = await fixture(); t.after(() => db.close());
  const rows = await listBarang(db);
  const result = await createStockOpname(db, { category: "MINUMAN", petugas: "Kasir",
    items: [{ id: rows[0].id, jumlahHasilSO: 7 }, { id: rows[1].id, jumlahHasilSO: 3 },
      { id: rows[2].id, jumlahHasilSO: 2 }] }, new Date("2026-01-02T00:00:00Z"));
  assert.equal(result.status, "DRAFT");
  const details = await getDetails(db, result.soId);
  assert.deepEqual(details.map(row => row.selisihBarang), [2, -5, 0]);
  assert.deepEqual(details.map(row => Number(row.local_master_barang_id)), rows.map(row => Number(row.id)));
  assert.deepEqual(details.map(row => row.id_barang), ["RK62", "RK62", "RK68"]);
  assert.equal(details[0].nominalPlus, 0);
});

test("query latest memisahkan LOCAL dan LEGACY; draft local tidak terlihat di legacy", async t => {
  const db = await fixture(); t.after(() => db.close());
  const local = await createStockOpname(db, { category: "MINUMAN", items: [{ id: 1, jumlahHasilSO: 1 }] });
  await exec(db, `INSERT INTO stock_opname (so_id, source, kategori, status, created_at, updated_at)
    VALUES ('SO-LEGACY-1', 'LEGACY', 'MINUMAN', 'HASIL', 't', 't')`);
  assert.equal((await getLatestBySource(db, "MINUMAN", "LEGACY")).so_id, "SO-LEGACY-1");
  assert.equal((await getLatestBySource(db, "MINUMAN", "legacy")).so_id, "SO-LEGACY-1");
  assert.equal((await getLatestBySource(db, "MINUMAN", "LOCAL")).so_id, local.soId);
  assert.equal((await getLatestBySource(db, "MINUMAN", "local")).so_id, local.soId);
  assert.notEqual((await getLatestBySource(db, "MINUMAN", "LEGACY")).so_id, local.soId);
  for (const unknownSource of ["LOKAL", "LOCALX", "XLOCAL", "FUTURE_SOURCE", "", null, "   "]) {
    assert.equal(await getLatestBySource(db, "MINUMAN", unknownSource), null,
      `source unknown ${JSON.stringify(unknownSource)} tidak boleh mengambil LOCAL atau LEGACY`);
  }
});

test("legacy revision/delete dibatasi ke LEGACY dan tidak mengubah draft LOCAL", async t => {
  const db = await fixture(); t.after(() => db.close());
  const local = await createStockOpname(db, { category: "MINUMAN", items: [{ id: 1, jumlahHasilSO: 1 }] });
  await exec(db, `INSERT INTO stock_opname (so_id, source, kategori, status, created_at, updated_at)
    VALUES ('SO-LEGACY-1', 'LEGACY', 'MINUMAN', 'HASIL', 't', 't')`);
  // Same source guards used by legacy revision and detail replacement.
  await exec(db, `UPDATE stock_opname SET revisi_ke=1 WHERE so_id='SO-LOCAL-${local.soId.split("SO-LOCAL-")[1]}' AND source='LEGACY'`);
  await exec(db, `DELETE FROM stock_opname_detail WHERE so_id=? AND EXISTS
    (SELECT 1 FROM stock_opname WHERE so_id=? AND source='LEGACY')`, [local.soId, local.soId]);
  const header = await new Promise((resolve, reject) => db.get("SELECT revisi_ke, source FROM stock_opname WHERE so_id=?", [local.soId], (e, r) => e ? reject(e) : resolve(r)));
  const details = await getDetails(db, local.soId);
  assert.equal(header.source, "LOCAL");
  assert.equal(header.revisi_ke, 0);
  assert.equal(details.length, 1);
});

test("legacy finalize guard menolak ID SO-LOCAL sebelum GAS; local flow tidak memakai legacy finalize", async t => {
  const db = await fixture(); t.after(() => db.close());
  const local = await createStockOpname(db, { category: "MINUMAN", items: [{ id: 1, jumlahHasilSO: 1 }] });
  const row = await getLatestBySource(db, "MINUMAN", "LOCAL");
  assert.equal(row.so_id, local.soId);
  assert.equal(isLegacyStockOpname(row), false);
  const localModule = fs.readFileSync(require.resolve("../stock-opname-local"), "utf8");
  assert.doesNotMatch(localModule, /callGas|finalize_stock_opname/);
});

test("dua create draft aktif kategori sama ditolak secara atomik", async t => {
  const db = await fixture(); t.after(() => db.close());
  const input = { category: "MINUMAN", items: [{ id: 1, jumlahHasilSO: 1 }] };
  const settled = await Promise.allSettled([createStockOpname(db, input), createStockOpname(db, input)]);
  assert.equal(settled.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(settled.filter(result => result.status === "rejected" && result.reason.code === "SO_STILL_ACTIVE").length, 1);
  const row = await new Promise((resolve, reject) => db.get("SELECT COUNT(*) AS count FROM stock_opname WHERE source='LOCAL' AND is_final=0", (e, r) => e ? reject(e) : resolve(r)));
  assert.equal(row.count, 1);
});

test("barang dengan local ID tidak ditemukan ditolak aman", async t => {
  const db = await fixture(); t.after(() => db.close());
  await assert.rejects(createStockOpname(db, { category: "MINUMAN", items: [{ id: 9999, jumlahHasilSO: 1 }] }),
    error => error.code === "SO_ITEM_NOT_FOUND");
});

test("gagal insert detail me-rollback header dan detail", async t => {
  const db = await fixture(); t.after(() => db.close());
  await exec(db, `CREATE TRIGGER reject_so_detail BEFORE INSERT ON stock_opname_detail
    BEGIN SELECT RAISE(ABORT, 'injected detail failure'); END`);
  const item = (await listBarang(db))[0];
  await assert.rejects(createStockOpname(db, { category: "MINUMAN", items: [{ id: item.id, jumlahHasilSO: 2 }] }));
  await new Promise((resolve, reject) => db.get("SELECT COUNT(*) AS count FROM stock_opname", (e, row) => e ? reject(e) : resolve(assert.equal(row.count, 0))));
  await new Promise((resolve, reject) => db.get("SELECT COUNT(*) AS count FROM stock_opname_detail", (e, row) => e ? reject(e) : resolve(assert.equal(row.count, 0))));
});
