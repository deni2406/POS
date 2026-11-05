"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const sqlite3 = require("sqlite3").verbose();
const { importToStaging, validateDataset } = require("../pbms-shadow/importer");
const { findBySourceId, listCatalog, publishImport } = require("../pbms-shadow/catalog-repository");

const candidateRows = [
  ["RK62-HITAM", "Dji Sam Soe 234 Hitam"],
  ["RK62-KUNING", "Dji Sam Soe 234 Kuning"],
  ["RK68-DOUBLEPOP", "Esse Double Pop 16"],
  ["RK68-JUICY", "Esse Juicy 16"],
  ["KS06-BINTANGZERO", "Bintang Zero"],
  ["KS06-SARUNGTANGAN", "Sarung Tangan Pollard"]
].map(([source_id, nama]) => ({
  source_id, nama, kategori: "ROKOK", hpp: 1000, harga_jual: 1500, stok_aktual: 10
}));

function fixture() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(":memory:", error => error ? reject(error) : resolve(db));
  });
}

test("six approved candidate IDs pass importer validation and publish independently", async t => {
  const db = await fixture();
  t.after(() => db.close());
  assert.deepEqual(validateDataset(candidateRows), []);
  const staged = await importToStaging(db, candidateRows);
  assert.equal(staged.status, "STAGED");
  await publishImport(db, staged.importRunId);
  assert.deepEqual((await listCatalog(db)).map(row => row.source_id).sort(),
    candidateRows.map(row => row.source_id).sort());
  for (const row of candidateRows) assert.equal((await findBySourceId(db, row.source_id)).nama, row.nama);
});

test("legacy IDs are no longer specially blocked when a source snapshot has resolved them", async t => {
  const db = await fixture();
  t.after(() => db.close());
  const rows = ["RK62", "RK68", "KS06"].map((source_id, index) => ({
    source_id, nama: `Remaining source item ${index + 1}`, kategori: "ROKOK",
    hpp: 1000, harga_jual: 1500, stok_aktual: 10
  }));
  const staged = await importToStaging(db, rows);
  assert.equal(staged.status, "STAGED");
  await publishImport(db, staged.importRunId);
  assert.deepEqual((await listCatalog(db)).map(row => row.source_id).sort(), ["KS06", "RK62", "RK68"]);
});

test("any duplicate source ID, including a still duplicated legacy ID, remains rejected", async () => {
  for (const sourceId of ["RK62-HITAM", "RK62", "RK68", "KS06", "OTHER-1"]) {
    const rows = [
      { ...candidateRows[0], source_id: sourceId },
      { ...candidateRows[1], source_id: sourceId }
    ];
    assert.ok(validateDataset(rows).some(issue => issue.field === "source_id" && issue.code === "duplicate"), sourceId);
  }
});
