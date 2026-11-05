"use strict";

// Isolated harness for production opening-balance behavior.
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
  if (!path.basename(resolvedHarness).startsWith("pos-opening-balance-harness-") ||
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

async function closeAndRemove(db, harnessDir) {
  if (db) await new Promise((resolve, reject) => db.close(err => err ? reject(err) : resolve()));
  for (const suffix of ["", "-journal", "-wal", "-shm"]) {
    try { fs.rmSync(path.join(harnessDir, `pos.db${suffix}`), { force: true }); } catch (_) { /* best-effort cleanup */ }
  }
  try { fs.rmSync(harnessDir, { recursive: true, force: true }); } catch (_) { /* best-effort cleanup */ }
}

async function createHarness() {
  const previousClosed = previousHarnessClosed;
  let releaseHarness;
  previousHarnessClosed = new Promise(resolve => { releaseHarness = resolve; });
  await previousClosed;
  const harnessDir = fs.mkdtempSync(path.join(tmpRoot, "pos-opening-balance-harness-"));
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
        if (property === "verbose") return () => { target.verbose(); return receiver; };
        if (property !== "Database") return Reflect.get(target, property, receiver);
        return new Proxy(target.Database, {
          construct(Database, args) {
            const [requestedPath, ...options] = args;
            if (typeof requestedPath !== "string" || path.basename(requestedPath) !== "pos.db") throw new Error(`Database produksi tak terduga: ${requestedPath}`);
            return Reflect.construct(Database, [assertHarnessDatabasePath(databasePath, harnessDir), ...options]);
          }
        });
      }
    });
    if (name === "./lamp-controlle/lamp-controller") return lampMock;
    return originalRequire(name);
  };
  const source = fs.readFileSync(path.join(projectDir, "server.js"), "utf8") + "\nmodule.exports.__harness = { db, activeLoginSessions, databaseInitialization };\n";
  const wrapper = vm.runInNewContext(Module.wrap(source), {
    setInterval: timers.setInterval, setTimeout: timers.setTimeout,
    clearInterval: timers.clearInterval, clearTimeout: timers.clearTimeout,
    console, Buffer, process, URL, URLSearchParams
  }, { filename: path.join(projectDir, "server.js") });
  const fakeModule = { exports: {} };
  wrapper.call(fakeModule.exports, fakeModule.exports, isolatedRequire, fakeModule, path.join(projectDir, "server.js"), projectDir);
  const db = fakeModule.exports.__harness.db;
  const sessions = fakeModule.exports.__harness.activeLoginSessions;
  assert.equal(typeof handler, "function");
  try {
  await fakeModule.exports.__harness.databaseInitialization;
  await get(db, "SELECT 1");
  try { await run(db, "ALTER TABLE transaksi ADD COLUMN member_id INTEGER"); } catch (error) {
    if (!/duplicate/i.test(error.message)) throw error;
  }
  await run(db, "PRAGMA foreign_keys = ON");
  // Seed only this temporary database. Never read the production database for fixtures.
  await run(db, "INSERT INTO kasir (username, pin, nama, aktif) VALUES ('harness-cashier', '123456', 'Harness Cashier', 1)");
  await run(db, "INSERT INTO kasir (username, pin, nama, aktif) VALUES ('harness-other', '123456', 'Harness Other', 1)");
  const cashiers = await new Promise((resolve, reject) => db.all("SELECT id, username FROM kasir ORDER BY id LIMIT 2", (err, rows) => err ? reject(err) : resolve(rows)));
  const cashier = cashiers[0];
  const otherCashier = cashiers[1];
  const shift = await run(db, "INSERT INTO shift_kasir (kasir_id, buka_at, status, opening_confirmed) VALUES (?, ?, 'OPEN', 0)", [cashier.id, new Date().toISOString()]);
  const otherShift = await run(db, "INSERT INTO shift_kasir (kasir_id, buka_at, status, opening_confirmed) VALUES (?, ?, 'OPEN', 0)", [otherCashier.id, new Date().toISOString()]);
  sessions.set(cashier.id, { kasirId: cashier.id, username: cashier.username, sessionId: "opening-session-1", deviceId: "opening-device-1", expiresAt: Date.now() + 60000 });
  sessions.set(otherCashier.id, { kasirId: otherCashier.id, username: otherCashier.username, sessionId: "opening-session-2", deviceId: "opening-device-2", expiresAt: Date.now() + 60000 });
  return { db, handler, sessions, cashier, otherCashier, shiftId: shift.lastID, otherShiftId: otherShift.lastID, harnessDir, async close() {
    try { await closeAndRemove(db, harnessDir); } finally { releaseHarness(); }
  } };
  } catch (error) {
    try { await closeAndRemove(fakeModule.exports.__harness.db, harnessDir); } catch (_) {}
    releaseHarness();
    throw error;
  }
}

async function request(app, url, session, payload = {}) {
  const body = JSON.stringify(payload);
  let resolveResponseEnd;
  const responseEnded = new Promise(resolve => { resolveResponseEnd = resolve; });
  const req = {
    method: "POST", url,
    socket: { remoteAddress: "127.0.0.1" },
    headers: { "x-session-id": session.sessionId, "x-device-id": session.deviceId },
    on(event, callback) { if (event === "data") queueMicrotask(() => callback(Buffer.from(body))); if (event === "end") queueMicrotask(callback); return this; }
  };
  const response = { statusCode: null, headers: {}, finishHandlers: [], setHeader(key, value) { this.headers[key] = value; }, writeHead(code) { this.statusCode = code; }, once(event, callback) { if (event === "finish") this.finishHandlers.push(callback); return this; }, end(value, callback) { this.body = value || ""; if (callback) callback(); for (const handler of this.finishHandlers.splice(0)) { try { handler(); } catch (_) {} } resolveResponseEnd(); } };
  await app.handler(req, response);
  await responseEnded;
  return { status: response.statusCode, body: JSON.parse(response.body || "{}") };
}

async function login(app, payload = {}) {
  return request(app, "/api/login", { sessionId: "", deviceId: "" }, {
    kasirId: app.cashier.id, pin: "123456", deviceId: "opening-device-1", ...payload
  });
}

const cashierSession = app => ({ sessionId: "opening-session-1", deviceId: "opening-device-1" });
const otherSession = app => ({ sessionId: "opening-session-2", deviceId: "opening-device-2" });

test("login menggunakan current-day OPEN shift dan mempertahankan opening_confirmed", async () => {
  const app = await createHarness();
  try {
    await run(app.db, "UPDATE shift_kasir SET opening_confirmed = 1 WHERE id = ?", [app.shiftId]);
    const result = await login(app);
    assert.equal(result.status, 200);
    assert.equal(result.body.shiftId, app.shiftId);
    assert.equal(result.body.opening_confirmed, 1);
    assert.equal((await get(app.db, "SELECT opening_confirmed FROM shift_kasir WHERE id = ?", [app.shiftId])).opening_confirmed, 1);
    assert.equal((await get(app.db, "SELECT COUNT(*) AS n FROM shift_kasir WHERE kasir_id = ? AND status = 'OPEN'", [app.cashier.id])).n, 1);
    app.sessions.delete(app.cashier.id);
    const confirmed = await login(app);
    assert.equal(confirmed.body.shiftId, app.shiftId);
    assert.equal(confirmed.body.opening_confirmed, 1);
    assert.equal((await get(app.db, "SELECT COUNT(*) AS n FROM shift_kasir WHERE kasir_id = ? AND status = 'OPEN'", [app.cashier.id])).n, 1);
  } finally { await app.close(); }
});

test("login simultan tanpa shift membuat satu OPEN dan kedua response berbagi ID", async () => {
  const app = await createHarness();
  try {
    await run(app.db, "DELETE FROM shift_kasir WHERE kasir_id = ?", [app.cashier.id]);
    app.sessions.delete(app.cashier.id);
    const results = await Promise.all([login(app), login(app)]);
    assert.ok(results.every(r => r.status === 200 && r.body.success));
    assert.equal(new Set(results.map(r => r.body.shiftId)).size, 1);
    assert.equal((await get(app.db, "SELECT COUNT(*) AS n FROM shift_kasir WHERE kasir_id = ? AND status = 'OPEN' AND date(buka_at, '+8 hours') = date('now', '+8 hours')", [app.cashier.id])).n, 1);
  } finally { await app.close(); }
});

test("login simultan pada active-session branch berbagi một shift", async () => {
  const app = await createHarness();
  try {
    await run(app.db, "DELETE FROM shift_kasir WHERE kasir_id = ?", [app.cashier.id]);
    app.sessions.set(app.cashier.id, { kasirId: app.cashier.id, username: app.cashier.username, sessionId: "already-active", deviceId: "opening-device-1", expiresAt: Date.now() + 60000 });
    const results = await Promise.all([login(app), login(app)]);
    assert.ok(results.every(r => r.status === 200 && r.body.success));
    assert.equal(new Set(results.map(r => r.body.shiftId)).size, 1);
    assert.equal((await get(app.db, "SELECT COUNT(*) AS n FROM shift_kasir WHERE kasir_id = ? AND status = 'OPEN' AND date(buka_at, '+8 hours') = date('now', '+8 hours')", [app.cashier.id])).n, 1);
  } finally { await app.close(); }
});

test("login memilih shift tanggal kini dan ID terbaru untuk duplikat harian", async () => {
  const app = await createHarness();
  try {
    await run(app.db, "DELETE FROM shift_kasir WHERE kasir_id = ?", [app.cashier.id]);
    await run(app.db, "INSERT INTO shift_kasir (kasir_id, buka_at, status) VALUES (?, datetime('now', '-2 days'), 'OPEN')", [app.cashier.id]);
    const current = await run(app.db, "INSERT INTO shift_kasir (kasir_id, buka_at, status) VALUES (?, datetime('now'), 'OPEN')", [app.cashier.id]);
    assert.equal((await login(app)).body.shiftId, current.lastID);
    const latest = await run(app.db, "INSERT INTO shift_kasir (kasir_id, buka_at, status) VALUES (?, datetime('now', '+1 second'), 'OPEN')", [app.cashier.id]);
    assert.equal((await login(app)).body.shiftId, latest.lastID);
  } finally { await app.close(); }
});

test("transaksi ditolak sebelum saldo awal dikonfirmasi", async () => {
  const app = await createHarness();
  try {
    const result = await request(app, "/api/transaksi", cashierSession(app), { kasir: app.cashier.username, shiftId: app.shiftId, metodePembayaran: "CASH", bayar: 100, items: [{ nama: "Item Uji", qty: 1, hargaJual: 100 }] });
    assert.equal(result.status, 403);
    assert.equal(result.body.code, "OPENING_BALANCE_NOT_CONFIRMED");
  } finally { await app.close(); }
});

test("konfirmasi menyimpan Uang Laci Awal dan KWh Awal", async () => {
  const app = await createHarness();
  try {
    const result = await request(app, "/api/confirm-opening-balance", cashierSession(app), { saldo_awal: 500000, saldo_kwh_dalam_awal: 123, saldo_kwh_luar_awal: 45.5 });
    assert.equal(result.status, 200);
    assert.equal(result.body.saldo_awal, 500000);
    assert.equal(result.body.saldo_kwh_dalam_awal, 123);
    assert.equal(result.body.saldo_kwh_luar_awal, 45.5);
    assert.deepEqual(await get(app.db, "SELECT saldo_awal, saldo_kwh_dalam_awal, saldo_kwh_luar_awal, opening_confirmed FROM shift_kasir WHERE id = ?", [app.shiftId]), { saldo_awal: 500000, saldo_kwh_dalam_awal: 12300, saldo_kwh_luar_awal: 4550, opening_confirmed: 1 });
  } finally { await app.close(); }
});

test("shift non-current-day tidak dapat dikonfirmasi", async () => {
  const app = await createHarness();
  try {
    await run(app.db, "UPDATE shift_kasir SET buka_at = datetime('now', '-2 days') WHERE id = ?", [app.shiftId]);
    const result = await request(app, "/api/confirm-opening-balance", cashierSession(app), { saldo_awal: 77, saldo_kwh_dalam_awal: 4, saldo_kwh_luar_awal: 5 });
    assert.equal(result.status, 409);
    assert.deepEqual(await get(app.db, "SELECT saldo_awal, saldo_kwh_dalam_awal, saldo_kwh_luar_awal, opening_confirmed FROM shift_kasir WHERE id = ?", [app.shiftId]), { saldo_awal: 0, saldo_kwh_dalam_awal: 0, saldo_kwh_luar_awal: 0, opening_confirmed: 0 });
  } finally { await app.close(); }
});

test("KWh Awal nol diterima", async () => {
  const app = await createHarness();
  try {
    const result = await request(app, "/api/confirm-opening-balance", cashierSession(app), { saldo_awal: 25000, saldo_kwh_dalam_awal: 0, saldo_kwh_luar_awal: 0 });
    assert.equal(result.status, 200);
    assert.deepEqual(await get(app.db, "SELECT saldo_awal, saldo_kwh_dalam_awal, saldo_kwh_luar_awal, opening_confirmed FROM shift_kasir WHERE id = ?", [app.shiftId]), { saldo_awal: 25000, saldo_kwh_dalam_awal: 0, saldo_kwh_luar_awal: 0, opening_confirmed: 1 });
  } finally { await app.close(); }
});

test("KWh Awal negatif/invalid ditolak tanpa mengonfirmasi shift", async () => {
  const app = await createHarness();
  try {
    for (const invalidKwh of [-1, 1.234, "abc"]) {
      const result = await request(app, "/api/confirm-opening-balance", cashierSession(app), { saldo_awal: 500000, saldo_kwh_dalam_awal: invalidKwh, saldo_kwh_luar_awal: 0 });
      assert.equal(result.status, 400, `KWh ${JSON.stringify(invalidKwh)} harus ditolak`);
      assert.deepEqual(await get(app.db, "SELECT saldo_awal, saldo_kwh_dalam_awal, saldo_kwh_luar_awal, opening_confirmed FROM shift_kasir WHERE id = ?", [app.shiftId]), { saldo_awal: 0, saldo_kwh_dalam_awal: 0, saldo_kwh_luar_awal: 0, opening_confirmed: 0 });
    }
  } finally { await app.close(); }
});

test("konfirmasi berulang menghasilkan HTTP 409", async () => {
  const app = await createHarness();
  try {
    assert.equal((await request(app, "/api/confirm-opening-balance", cashierSession(app), { saldo_awal: 0, saldo_kwh_dalam_awal: 0, saldo_kwh_luar_awal: 0 })).status, 200);
    assert.equal((await request(app, "/api/confirm-opening-balance", cashierSession(app), { saldo_awal: 0, saldo_kwh_dalam_awal: 0, saldo_kwh_luar_awal: 0 })).status, 409);
  } finally { await app.close(); }
});

test("kasir lain tidak dapat mengonfirmasi shift kasir pertama", async () => {
  const app = await createHarness();
  try {
    const result = await request(app, "/api/confirm-opening-balance", otherSession(app), { saldo_awal: 0, saldo_kwh_dalam_awal: 0, saldo_kwh_luar_awal: 0 });
    assert.equal(result.status, 200);
    assert.equal(result.body.shiftId, app.otherShiftId);
    assert.notEqual(result.body.shiftId, app.shiftId);
    assert.deepEqual(await get(app.db, "SELECT saldo_awal, opening_confirmed FROM shift_kasir WHERE id = ?", [app.shiftId]), { saldo_awal: 0, opening_confirmed: 0 });
  } finally { await app.close(); }
});

test("transaksi minimal melewati gate saldo awal setelah konfirmasi", async () => {
  const app = await createHarness();
  try {
    await run(app.db, "INSERT INTO master_barang (nama, hpp, harga_jual, stok_aktual, updated_at) VALUES ('Item Uji', 5, 100, 9, 'test')");
    await request(app, "/api/confirm-opening-balance", cashierSession(app), { saldo_awal: 0, saldo_kwh_dalam_awal: 0, saldo_kwh_luar_awal: 0 });
    const result = await request(app, "/api/transaksi", cashierSession(app), { kasir: app.cashier.username, shiftId: app.shiftId, metodePembayaran: "CASH", bayar: 100, items: [{ nama: "Item Uji", qty: 1, hargaJual: 100 }] });
    assert.equal(result.status, 200);
    assert.equal(result.body.success, true);
  } finally { await app.close(); }
});
