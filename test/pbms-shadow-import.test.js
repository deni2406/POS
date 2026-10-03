"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const sqlite3 = require("sqlite3").verbose();
const { ensureSchema, importToStaging } = require("../pbms-shadow/importer");
const { findBySourceId, getCatalogResponse, listBarang, listCatalog, listCategories, publishImport } = require("../pbms-shadow/catalog-repository");

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => db.run(sql, params, function (error) { error ? reject(error) : resolve(this); }));
}
function get(db, sql, params = []) {
  return new Promise((resolve, reject) => db.get(sql, params, (error, row) => error ? reject(error) : resolve(row)));
}
function all(db, sql, params = []) {
  return new Promise((resolve, reject) => db.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows)));
}
function fixture() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(":memory:", error => error ? reject(error) : resolve(db));
  });
}

const valid = [
  { source_id: "ITEM-1", nama: "Bola", kategori: "Aksesoris", hpp: 1000, harga_jual: 2000, stok_aktual: 4 },
  { source_id: "ITEM-2", nama: "Kap", kategori: "Aksesoris", hpp: 500, harga_jual: 1000, stok_aktual: 8 }
];

test("schema/migration idempoten, valid dataset staged, active tables and stock unchanged", async t => {
  const db = await fixture();
  t.after(() => db.close());
  await run(db, "CREATE TABLE master_barang (id INTEGER PRIMARY KEY, nama TEXT, stok_aktual INTEGER)");
  await run(db, "CREATE TABLE stok_aktual (id INTEGER PRIMARY KEY, jumlah INTEGER)");
  await run(db, "INSERT INTO master_barang VALUES (1, 'Aktif', 17)");
  await run(db, "INSERT INTO stok_aktual VALUES (1, 29)");
  await ensureSchema(db);
  await ensureSchema(db);
  const result = await importToStaging(db, valid, { sourceName: "fixture", metadata: { fixture: true } });
  assert.equal(result.status, "STAGED");
  assert.equal(result.stagedCount, 2);
  assert.match(result.checksum, /^[a-f0-9]{64}$/);
  assert.equal((await all(db, "SELECT * FROM master_barang_staging WHERE import_run_id=?", [result.importRunId])).length, 2);
  assert.deepEqual(await get(db, "SELECT nama, stok_aktual FROM master_barang WHERE id=1"), { nama: "Aktif", stok_aktual: 17 });
  assert.deepEqual(await get(db, "SELECT jumlah FROM stok_aktual WHERE id=1"), { jumlah: 29 });
});

test("empty, duplicate source_id, invalid field and invalid numeric datasets are rejected", async t => {
  const db = await fixture();
  t.after(() => db.close());
  const duplicate = [valid[0], { ...valid[1], source_id: "ITEM-1" }];
  const missing = [{ ...valid[0], nama: " " }];
  const badNumber = [{ ...valid[0], harga_jual: "2.000" }];
  for (const rows of [[], duplicate, missing, badNumber]) {
    const result = await importToStaging(db, rows);
    assert.equal(result.status, "REJECTED");
    assert.ok(result.issues.length > 0);
    assert.equal((await all(db, "SELECT * FROM master_barang_staging WHERE import_run_id=?", [result.importRunId])).length, 0);
    assert.equal((await get(db, "SELECT status FROM master_barang_import_runs WHERE import_run_id=?", [result.importRunId])).status, "REJECTED");
  }
});

test("invalid staging schema is rejected before import", async t => {
  const db = await fixture();
  t.after(() => db.close());
  await run(db, "CREATE TABLE master_barang_staging (wrong TEXT)");
  await assert.rejects(importToStaging(db, valid), /Skema tidak valid/);
  assert.equal(await get(db, "SELECT name FROM sqlite_master WHERE type='table' AND name='master_barang_import_runs'"), undefined);
});

test("publish creates isolated catalog and reconciles mapping; source stock is informational only", async t => {
  const db = await fixture();
  t.after(() => db.close());
  await run(db, "CREATE TABLE master_barang (id INTEGER PRIMARY KEY, nama TEXT, stok_aktual INTEGER)");
  await run(db, "CREATE TABLE stok_aktual (id INTEGER PRIMARY KEY, jumlah INTEGER)");
  await run(db, "INSERT INTO master_barang VALUES (1, 'Aktif', 17)");
  await run(db, "INSERT INTO stok_aktual VALUES (1, 29)");
  const staged = await importToStaging(db, valid);
  const published = await publishImport(db, staged.importRunId);
  assert.equal(published.before.mappingMatches, 0);
  assert.equal(published.after.mappingMatches, 2);
  assert.deepEqual(published.after.rows[0].mapping.nama, { source: "Bola", sql: "Bola" });
  assert.equal(published.after.rows[0].stock.source, 4);
  assert.equal(published.after.rows[0].stock.sql, 0);
  assert.deepEqual(await get(db, "SELECT nama, stok_aktual FROM master_barang WHERE id=1"), { nama: "Aktif", stok_aktual: 17 });
  assert.deepEqual(await get(db, "SELECT jumlah FROM stok_aktual WHERE id=1"), { jumlah: 29 });
  assert.equal((await listCatalog(db)).length, 2);
});

test("upsert adds products and updates descriptive fields while preserving shadow stock", async t => {
  const db = await fixture();
  t.after(() => db.close());
  let staged = await importToStaging(db, valid);
  await publishImport(db, staged.importRunId);
  await run(db, "UPDATE master_barang_shadow SET stok_aktual=91 WHERE source_id='ITEM-1'");
  const changed = [
    { ...valid[0], nama: "Bola Baru", kategori: "Permainan", hpp: 1200, harga_jual: 2500, stok_aktual: 999 },
    ...valid.slice(1),
    { source_id: "ITEM-3", nama: "Sarung tangan", kategori: "Aksesoris", hpp: 200, harga_jual: 400, stok_aktual: 77 }
  ];
  staged = await importToStaging(db, changed);
  await publishImport(db, staged.importRunId);
  assert.deepEqual(await findBySourceId(db, "ITEM-1").then(({ nama, kategori, hpp, harga_jual, stok_aktual }) => ({ nama, kategori, hpp, harga_jual, stok_aktual })),
    { nama: "Bola Baru", kategori: "Permainan", hpp: 1200, harga_jual: 2500, stok_aktual: 91 });
  assert.deepEqual(await findBySourceId(db, "ITEM-3").then(({ nama, stok_aktual }) => ({ nama, stok_aktual })), { nama: "Sarung tangan", stok_aktual: 0 });
});

test("failed mid-publish rolls back all catalog changes and run status", async t => {
  const db = await fixture();
  t.after(() => db.close());
  const staged = await importToStaging(db, valid);
  await run(db, `CREATE TRIGGER fail_catalog_publish BEFORE INSERT ON master_barang_shadow
    WHEN NEW.source_id='ITEM-2' BEGIN SELECT RAISE(ABORT, 'injected publish failure'); END`);
  await assert.rejects(publishImport(db, staged.importRunId), /injected publish failure/);
  assert.equal((await listCatalog(db)).length, 0);
  assert.equal((await get(db, "SELECT status FROM master_barang_import_runs WHERE import_run_id=?", [staged.importRunId])).status, "STAGED");
  assert.equal((await all(db, "SELECT * FROM master_barang_staging WHERE import_run_id=?", [staged.importRunId])).length, 2);
});

test("repeated publish input is idempotent and keeps stock independent", async t => {
  const db = await fixture();
  t.after(() => db.close());
  const first = await importToStaging(db, valid);
  await publishImport(db, first.importRunId);
  await run(db, "UPDATE master_barang_shadow SET stok_aktual=33 WHERE source_id='ITEM-1'");
  const repeated = await importToStaging(db, valid);
  await publishImport(db, repeated.importRunId);
  assert.equal((await listCatalog(db)).length, 2);
  assert.equal((await findBySourceId(db, "ITEM-1")).stok_aktual, 33);
  assert.equal((await findBySourceId(db, "ITEM-1")).last_import_run_id, repeated.importRunId);
});

test("products missing from a complete source snapshot are removed from shadow catalog", async t => {
  const db = await fixture();
  t.after(() => db.close());
  const first = await importToStaging(db, valid);
  await publishImport(db, first.importRunId);
  const next = await importToStaging(db, [valid[0]]);
  await publishImport(db, next.importRunId);
  assert.deepEqual((await listCatalog(db)).map(row => row.source_id), ["ITEM-1"]);
});

test("repository returns /api/barang-compatible fields and supports search, source lookup and categories", async t => {
  const db = await fixture();
  t.after(() => db.close());
  const staged = await importToStaging(db, valid);
  await publishImport(db, staged.importRunId);
  const response = await getCatalogResponse(db);
  assert.equal(response.success, true);
  assert.equal(response.total, 2);
  assert.ok(response.updatedAt);
  assert.deepEqual(Object.fromEntries(Object.entries(response.data[0]).filter(([key]) => ["nama", "kategori", "hpp", "hargaJual", "stokAktual", "source_id", "sourceId"].includes(key))), {
    nama: "Bola", kategori: "Aksesoris", hpp: 1000, hargaJual: 2000,
    stokAktual: 0, source_id: "ITEM-1", sourceId: "ITEM-1"
  });
  assert.deepEqual((await listBarang(db, { q: "kap" })).map(row => row.sourceId), ["ITEM-2"]);
  assert.deepEqual(await listCategories(db), ["Aksesoris"]);
  assert.equal((await findBySourceId(db, "ITEM-2")).nama, "Kap");
  assert.equal(await findBySourceId(db, "missing"), null);
});

test("optional local id and active status are exposed when the shadow schema provides them", async t => {
  const db = await fixture();
  t.after(() => db.close());
  const staged = await importToStaging(db, valid);
  await publishImport(db, staged.importRunId);
  await run(db, "ALTER TABLE master_barang_shadow ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1");
  await run(db, "ALTER TABLE master_barang_shadow ADD COLUMN id INTEGER");
  await run(db, "UPDATE master_barang_shadow SET id=501, is_active=0 WHERE source_id='ITEM-2'");
  const allRows = await listBarang(db);
  assert.equal(allRows.find(row => row.sourceId === "ITEM-2").id, 501);
  assert.equal(allRows.find(row => row.sourceId === "ITEM-2").status, 0);
  assert.deepEqual((await listBarang(db, { activeOnly: true })).map(row => row.sourceId), ["ITEM-1"]);
});
