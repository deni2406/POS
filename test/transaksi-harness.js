"use strict";

// Isolated harness for the production POST /api/transaksi handler.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const Module = require("node:module");
const { test } = require("node:test");

const projectDir = path.resolve(__dirname, "..");
const tmpRoot = path.resolve(os.tmpdir());
let previousHarnessClosed = Promise.resolve();

function assertHarnessDatabasePath(databasePath, harnessDir) {
  const resolvedDb = path.resolve(databasePath);
  const resolvedHarness = path.resolve(harnessDir);
  const relative = path.relative(tmpRoot, resolvedHarness);
  if (!path.basename(resolvedHarness).startsWith("pos-transaksi-harness-") ||
      relative.startsWith("..") || path.isAbsolute(relative) ||
      path.dirname(resolvedDb) !== resolvedHarness || path.basename(resolvedDb) !== "pos.db") {
    throw new Error(`Database bukan milik direktori temporary harness: ${resolvedDb}`);
  }
  return resolvedDb;
}

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => db.run(sql, params, function (err) {
    if (err) reject(err);
    else resolve({ lastID: this.lastID, changes: this.changes });
  }));
}

function get(db, sql, params = []) {
  return new Promise((resolve, reject) => db.get(sql, params, (err, row) => err ? reject(err) : resolve(row)));
}

function all(db, sql, params = []) {
  return new Promise((resolve, reject) => db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows)));
}

async function closeAndRemove(db, harnessDir) {
  if (db) await new Promise((resolve, reject) => db.close(err => err ? reject(err) : resolve()));
  for (const suffix of ["", "-journal", "-wal", "-shm"]) {
    const file = path.join(harnessDir, `pos.db${suffix}`);
    try { fs.rmSync(file, { force: true }); } catch (_) { /* best-effort cleanup */ }
  }
  try { fs.rmSync(harnessDir, { recursive: true, force: true }); } catch (_) { /* best-effort cleanup */ }
}

async function createHarness() {
  // Keep the full database lifetime serialized, even if the test runner is
  // configured to run top-level tests concurrently.
  const previousClosed = previousHarnessClosed;
  let releaseHarness;
  previousHarnessClosed = new Promise(resolve => { releaseHarness = resolve; });
  await previousClosed;
  const harnessDir = fs.mkdtempSync(path.join(tmpRoot, "pos-transaksi-harness-"));
  const databasePath = assertHarnessDatabasePath(path.join(harnessDir, "pos.db"), harnessDir);
  const originalRequire = Module.createRequire(path.join(projectDir, "server.js"));
  const sqlite3 = originalRequire("sqlite3").verbose();
  const timers = { setInterval: () => ({ unref() {} }), setTimeout: () => ({ unref() {} }), clearInterval() {}, clearTimeout() {} };
  let handler;
  const httpsMock = { createServer(_options, requestHandler) {
    handler = requestHandler;
    return { listen() { return this; }, close(callback) { if (callback) callback(); } };
  } };
  const lampMock = { lampSet: async () => ({ success: true }), lampOn: async () => ({ success: true }), lampOff: async () => ({ success: true }), lampBlink15Minute: async () => ({ success: true }) };
  const isolatedRequire = name => {
    if (name === "https") return httpsMock;
    if (name === "sqlite3") return new Proxy(sqlite3, {
      get(target, property, receiver) {
        if (property === "verbose") return () => {
          target.verbose();
          return receiver;
        };
        if (property !== "Database") return Reflect.get(target, property, receiver);
        return new Proxy(target.Database, {
          construct(Database, args) {
            const [requestedPath, ...options] = args;
            if (typeof requestedPath !== "string" || path.basename(requestedPath) !== "pos.db") {
              throw new Error(`Database produksi tak terduga: ${requestedPath}`);
            }
            // Validate the effective path immediately before opening; never pass the
            // server-requested path through to sqlite3.
            const safePath = assertHarnessDatabasePath(databasePath, harnessDir);
            return Reflect.construct(Database, [safePath, ...options]);
          }
        });
      }
    });
    if (name === "./lamp-controlle/lamp-controller") return lampMock;
    return originalRequire(name);
  };
  const source = fs.readFileSync(path.join(projectDir, "server.js"), "utf8") +
    "\nmodule.exports.__harness = { db, activeLoginSessions, databaseInitialization };\n";
  const wrapper = vm.runInNewContext(Module.wrap(source), {
    setInterval: timers.setInterval, setTimeout: timers.setTimeout,
    clearInterval: timers.clearInterval, clearTimeout: timers.clearTimeout,
    console, Buffer, process, URL, URLSearchParams
  }, { filename: path.join(projectDir, "server.js") });
  const fakeModule = { exports: {} };
  wrapper.call(fakeModule.exports, fakeModule.exports, isolatedRequire, fakeModule, path.join(projectDir, "server.js"), projectDir);
  const db = fakeModule.exports.__harness.db;
  const sessions = fakeModule.exports.__harness.activeLoginSessions;
  assert.equal(typeof handler, "function", "Mock HTTPS harus menangkap handler produksi");
  await fakeModule.exports.__harness.databaseInitialization;
  await get(db, "SELECT 1");
  try { await run(db, "ALTER TABLE transaksi ADD COLUMN member_id INTEGER"); } catch (error) {
    if (!/duplicate/i.test(error.message)) throw error;
  }
  await run(db, "PRAGMA foreign_keys = ON");
  const cashier = await get(db, "SELECT id, username FROM kasir LIMIT 1");
  const shift = await run(db, "INSERT INTO shift_kasir (kasir_id, buka_at, status, opening_confirmed) VALUES (?, ?, 'OPEN', 1)", [cashier.id, new Date().toISOString()]);
  sessions.set(cashier.id, { kasirId: cashier.id, username: cashier.username, sessionId: "harness-session", deviceId: "harness-device", expiresAt: Date.now() + 60000 });

  return { db, handler, cashier, shiftId: shift.lastID, harnessDir, async close() {
    try { await closeAndRemove(db, harnessDir); }
    finally { releaseHarness(); }
  } };
}

async function request(app, payload) {
  let body = "";
  const req = {
    method: "POST", url: "/api/transaksi",
    headers: { "x-session-id": "harness-session", "x-device-id": "harness-device" },
    on(event, callback) { if (event === "data") queueMicrotask(() => callback(Buffer.from(body))); if (event === "end") queueMicrotask(callback); return this; }
  };
  body = JSON.stringify({ kasir: app.cashier.username, shiftId: app.shiftId, metodePembayaran: "CASH", bayar: 999999, ...payload });
  const response = { statusCode: null, headers: {}, setHeader(key, value) { this.headers[key] = value; },
    once(event, callback) { if (event === "finish") this.finishCallback = callback; return this; },
    writeHead(code) { this.statusCode = code; }, end(value) { this.body = value || ""; this.finishCallback?.(); } };
  await app.handler(req, response);
  return { status: response.statusCode, body: JSON.parse(response.body || "{}") };
}

test("atomicity: kegagalan detail item kedua membatalkan header, detail, dan perubahan stok", async () => {
  const app = await createHarness();
  try {
    await run(app.db, "INSERT INTO master_barang (nama, hpp, harga_jual, stok_aktual, updated_at) VALUES ('Item A', 5, 100, 9, 'test'), ('Item B', 7, 200, 8, 'test')");
    await run(app.db, "CREATE TRIGGER fail_second_detail BEFORE INSERT ON detail_transaksi WHEN NEW.nama_barang = 'Item B' BEGIN SELECT RAISE(ABORT, 'forced second detail failure'); END");
    const result = await request(app, { items: [{ nama: "Item A", qty: 2, hargaJual: 100 }, { nama: "Item B", qty: 1, hargaJual: 200 }] });
    assert.equal(result.status, 400);
    assert.equal((await get(app.db, "SELECT COUNT(*) AS n FROM transaksi")).n, 0);
    assert.equal((await get(app.db, "SELECT COUNT(*) AS n FROM detail_transaksi")).n, 0);
    const stock = await all(app.db, "SELECT nama, stok_aktual FROM master_barang ORDER BY nama");
    assert.deepEqual(stock.map(row => row.stok_aktual), [9, 8]);
  } finally { await app.close(); }
});

test("validasi qty tidak mengubah database; harga client diotoritaskan ke harga master", async () => {
  const app = await createHarness();
  try {
    await run(app.db, "INSERT INTO master_barang (nama, hpp, harga_jual, stok_aktual, updated_at) VALUES ('Item Uji', 5, 100, 9, 'test')");
    const before = { transaksi: await get(app.db, "SELECT COUNT(*) AS n FROM transaksi"), detail: await get(app.db, "SELECT COUNT(*) AS n FROM detail_transaksi"), stok: await get(app.db, "SELECT stok_aktual AS n FROM master_barang WHERE nama = 'Item Uji'") };
    const invalidQty = await request(app, { items: [{ nama: "Item Uji", qty: 0, hargaJual: 100 }] });
    assert.equal(invalidQty.status, 400);
    assert.deepEqual({ transaksi: await get(app.db, "SELECT COUNT(*) AS n FROM transaksi"), detail: await get(app.db, "SELECT COUNT(*) AS n FROM detail_transaksi"), stok: await get(app.db, "SELECT stok_aktual AS n FROM master_barang WHERE nama = 'Item Uji'") }, before);
    // Server authoritative: harga client yang tidak sama dengan master diganti harga master (server.js).
    const override = await request(app, { items: [{ nama: "Item Uji", qty: 1, hargaJual: -1 }] });
    assert.equal(override.status, 200);
    assert.equal(override.body.total, 100);
    assert.deepEqual(await get(app.db, "SELECT harga_jual AS n FROM detail_transaksi"), { n: 100 });
    assert.deepEqual(await get(app.db, "SELECT stok_aktual AS n FROM master_barang WHERE nama = 'Item Uji'"), { n: 8 });
  } finally { await app.close(); }
});

test("TABLE_SERVICE_ITEM_NOT_FOUND mengembalikan kode dan rollback transaksi", async () => {
  const app = await createHarness();
  try {
    await run(app.db, "INSERT INTO sesi_meja (session_id, nomor_meja, nama_pemesan, kasir, waktu_mulai, status) VALUES ('harness-table', 1, 'Uji', ?, 'test', 'AKTIF')", [app.cashier.username]);
    const result = await request(app, { sessionId: "harness-table", nomorMeja: 1, items: [{ nama: "Meja Billiard", qty: 1, hargaJual: 100 }] });
    assert.equal(result.status, 400);
    assert.equal(result.body.code, "TABLE_SERVICE_ITEM_NOT_FOUND");
    assert.equal((await get(app.db, "SELECT COUNT(*) AS n FROM transaksi")).n, 0);
    assert.equal((await get(app.db, "SELECT status FROM sesi_meja WHERE session_id = 'harness-table'")).status, "AKTIF");
  } finally { await app.close(); }
});
