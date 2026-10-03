const test = require("node:test");
const assert = require("node:assert/strict");
const sqlite3 = require("sqlite3").verbose();
const { respondLocalCatalogSync } = require("../catalog-local");
const { selectLocalMemberPrice } = require("../harga-member-local");
const { callLegacyStockOpnameGas } = require("../stock-opname-legacy");

function openDb() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(":memory:", error => error ? reject(error) : resolve(db));
  });
}
function run(db, sql, params = []) {
  return new Promise((resolve, reject) => db.run(sql, params, error => error ? reject(error) : resolve()));
}
function all(db, sql) {
  return new Promise((resolve, reject) => db.all(sql, (error, rows) => error ? reject(error) : resolve(rows)));
}

test("respons endpoint kompatibilitas katalog hanya membaca dan tidak mengubah ID, relasi, atau harga lokal", async t => {
  const db = await openDb(); t.after(() => db.close());
  await run(db, "CREATE TABLE master_barang(id INTEGER PRIMARY KEY, id_barang TEXT, nama TEXT, updated_at TEXT)");
  await run(db, "CREATE TABLE harga_member_cache(id INTEGER PRIMARY KEY, kategori TEXT, harga_per_jam REAL)");
  await run(db, "INSERT INTO master_barang VALUES (41,'DUP','A','ts'),(57,'DUP','B','ts')");
  await run(db, "INSERT INTO harga_member_cache VALUES (3,'PLATINUM',12345)");
  const beforeProducts = await all(db, "SELECT * FROM master_barang ORDER BY id");
  const beforePrices = await all(db, "SELECT * FROM harga_member_cache ORDER BY id");
  const response = { status: null, headers: {}, writeHead(status, headers) { this.status = status; this.headers = headers; }, end(body) { this.body = body; } };
  await respondLocalCatalogSync(db, response);
  const result = JSON.parse(response.body);
  assert.equal(response.status, 410);
  assert.match(response.headers["Content-Type"], /application\/json/);
  assert.equal(result.success, false);
  assert.equal(result.localOnly, true);
  assert.equal(result.jumlah, 2);
  assert.equal(result.hargaTersimpan, 1);
  assert.deepEqual(await all(db, "SELECT * FROM master_barang ORDER BY id"), beforeProducts);
  assert.deepEqual(await all(db, "SELECT * FROM harga_member_cache ORDER BY id"), beforePrices);
});

test("harga member diambil dari aturan cache lokal sesuai jam dan durasi", () => {
  const rules = [
    { jam: "08:00", jam_selesai: "22:00", durasi_jam: 1, harga_per_jam: 24000 },
    { jam: "08:00", jam_selesai: "22:00", durasi_jam: 3, harga_per_jam: 18000 }
  ];
  assert.deepEqual(selectLocalMemberPrice(rules, 3, "2026-01-01T04:00:00.000Z"),
    { hargaPerJam: 18000, total: 54000, jam: "12:00" });
  assert.equal(selectLocalMemberPrice(rules, 2, "2026-01-01T04:00:00.000Z").hargaPerJam, 24000);
  assert.equal(selectLocalMemberPrice(rules, 3, null), null);
});

test("proses legacy dan finalize tidak memanggil connector eksternal", async () => {
  let calls = 0;
  const connector = async () => { calls += 1; };
  await assert.rejects(callLegacyStockOpnameGas({ soId: "SO-OLD-1" }, {}, connector), error =>
    error.statusCode === 503 && error.code === "SO_LEGACY_DISABLED");
  assert.equal(calls, 0);
});
