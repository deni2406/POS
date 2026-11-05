"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const Module = require("node:module");
const { test } = require("node:test");

const projectDir = path.resolve(__dirname, "..");
const productionDatabasePath = path.resolve(projectDir, "pos.db");
const tempRoot = path.resolve(os.tmpdir());
let previousHarnessClosed = Promise.resolve();

function assertHarnessDatabasePath(databasePath, harnessDir) {
  const resolvedDatabase = path.resolve(databasePath);
  const resolvedHarness = path.resolve(harnessDir);
  const relative = path.relative(tempRoot, resolvedHarness);
  if (
    !path.basename(resolvedHarness).startsWith("pos-closing-kwh-harness-") ||
    relative.startsWith("..") ||
    path.isAbsolute(relative) ||
    path.dirname(resolvedDatabase) !== resolvedHarness ||
    path.basename(resolvedDatabase) !== "pos.db" ||
    resolvedDatabase === productionDatabasePath
  ) {
    throw new Error(`Database bukan milik direktori temporary harness: ${resolvedDatabase}`);
  }
  return resolvedDatabase;
}

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => db.run(sql, params, function (error) {
    if (error) reject(error);
    else resolve({ lastID: this.lastID, changes: this.changes });
  }));
}

function get(db, sql, params = []) {
  return new Promise((resolve, reject) => db.get(sql, params, (error, row) => {
    if (error) reject(error);
    else resolve(row);
  }));
}

async function closeAndRemove(db, harnessDir) {
  let closeError;
  if (db) {
    try {
      await new Promise((resolve, reject) => db.close(error => error ? reject(error) : resolve()));
    } catch (error) {
      closeError = error;
    }
  }
  for (const suffix of ["", "-journal", "-wal", "-shm"]) {
    fs.rmSync(path.join(harnessDir, `pos.db${suffix}`), { force: true });
  }
  fs.rmSync(harnessDir, { recursive: true, force: true });
  if (closeError) throw closeError;
}

async function createHarness() {
  const previousClosed = previousHarnessClosed;
  let releaseHarness;
  previousHarnessClosed = new Promise(resolve => { releaseHarness = resolve; });
  await previousClosed;

  const harnessDir = fs.mkdtempSync(path.join(tempRoot, "pos-closing-kwh-harness-"));
  const databasePath = assertHarnessDatabasePath(path.join(harnessDir, "pos.db"), harnessDir);
  const originalRequire = Module.createRequire(path.join(projectDir, "server.js"));
  const sqlite3 = originalRequire("sqlite3").verbose();
  let handler;
  const timers = {
    setInterval: () => ({ unref() {} }),
    setTimeout: () => ({ unref() {} }),
    clearInterval() {},
    clearTimeout() {}
  };
  const httpsMock = {
    createServer(_options, requestHandler) {
      handler = requestHandler;
      return { listen() { return this; }, close(callback) { if (callback) callback(); } };
    }
  };
  const lampMock = {
    lampSet: async () => ({ success: true }),
    lampOn: async () => ({ success: true }),
    lampOff: async () => ({ success: true }),
    lampBlink15Minute: async () => ({ success: true })
  };
  const isolatedRequire = name => {
    if (name === "https") return httpsMock;
    if (name === "sqlite3") {
      return new Proxy(sqlite3, {
        get(target, property, receiver) {
          if (property === "verbose") return () => {
            target.verbose();
            return receiver;
          };
          if (property !== "Database") return Reflect.get(target, property, receiver);
          return new Proxy(target.Database, {
            construct(Database, args) {
              const [requestedPath, ...options] = args;
              if (path.resolve(String(requestedPath)) !== productionDatabasePath) {
                throw new Error(`Path database produksi server tidak terduga: ${requestedPath}`);
              }
              const safePath = assertHarnessDatabasePath(databasePath, harnessDir);
              return Reflect.construct(Database, [safePath, ...options]);
            }
          });
        }
      });
    }
    if (name === "./lamp-controlle/lamp-controller") return lampMock;
    return originalRequire(name);
  };

  const source = fs.readFileSync(path.join(projectDir, "server.js"), "utf8") +
    "\nmodule.exports.__harness = { db, activeLoginSessions, databaseInitialization };\n";
  const wrapper = vm.runInNewContext(Module.wrap(source), {
    setInterval: timers.setInterval,
    setTimeout: timers.setTimeout,
    clearInterval: timers.clearInterval,
    clearTimeout: timers.clearTimeout,
    console,
    Buffer,
    process,
    URL,
    URLSearchParams
  }, { filename: path.join(projectDir, "server.js") });
  const fakeModule = { exports: {} };
  wrapper.call(
    fakeModule.exports,
    fakeModule.exports,
    isolatedRequire,
    fakeModule,
    path.join(projectDir, "server.js"),
    projectDir
  );

  const { db, activeLoginSessions } = fakeModule.exports.__harness;
  try {
    assert.equal(typeof handler, "function", "Mock HTTPS harus menangkap handler produksi");
    await fakeModule.exports.__harness.databaseInitialization;
    await get(db, "SELECT 1");
    await run(db, "PRAGMA foreign_keys = ON");
    await run(db, `
      CREATE TABLE pembelian_kwh (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        shift_id INTEGER NOT NULL,
        kasir_id INTEGER NOT NULL,
        waktu TEXT NOT NULL,
        jenis_kwh TEXT NOT NULL CHECK (jenis_kwh IN ('DALAM', 'LUAR')),
        nominal_pembelian INTEGER NOT NULL,
        kwh_didapat INTEGER NOT NULL,
        harga_per_kwh INTEGER NOT NULL,
        sisa_kwh INTEGER NOT NULL DEFAULT 0,
        keterangan TEXT NOT NULL DEFAULT '',
        FOREIGN KEY (shift_id) REFERENCES shift_kasir(id),
        FOREIGN KEY (kasir_id) REFERENCES kasir(id)
      )
    `);

    const cashier = await run(
      db,
      "INSERT INTO kasir (username, pin, nama, aktif) VALUES ('closing-kwh-harness', '123456', 'Harness', 1)"
    );
    activeLoginSessions.set(cashier.lastID, {
      kasirId: cashier.lastID,
      username: "closing-kwh-harness",
      sessionId: "closing-kwh-harness-session",
      deviceId: "closing-kwh-harness-device",
      expiresAt: Date.now() + 60000
    });

    return {
      db,
      handler,
      cashierId: cashier.lastID,
      harnessDir,
      async createShift() {
        const shift = await run(
          db,
          `INSERT INTO shift_kasir
             (kasir_id, buka_at, status, opening_confirmed, saldo_kwh_dalam_awal, saldo_kwh_luar_awal)
           VALUES (?, ?, 'OPEN', 1, 5025, 3025)`,
          [cashier.lastID, new Date().toISOString()]
        );
        await run(
          db,
          `INSERT INTO pembelian_kwh
             (shift_id, kasir_id, waktu, jenis_kwh, nominal_pembelian, kwh_didapat, harga_per_kwh, sisa_kwh)
           VALUES (?, ?, ?, 'DALAM', 105000, 1050, 10000, 1050),
                  (?, ?, ?, 'LUAR', 55000, 550, 10000, 550)`,
          [shift.lastID, cashier.lastID, new Date().toISOString(), shift.lastID, cashier.lastID, new Date().toISOString()]
        );
        return shift.lastID;
      },
      async close() {
        try {
          await closeAndRemove(db, harnessDir);
        } finally {
          releaseHarness();
        }
      }
    };
  } catch (error) {
    try {
      await closeAndRemove(db, harnessDir);
    } finally {
      releaseHarness();
    }
    throw error;
  }
}

async function request(app, shiftId, saldoKwhDalamAkhir) {
  const body = JSON.stringify({
    shiftId,
    nominalAktual: 0,
    uangLaci: 0,
    saldo_kwh_dalam_akhir: saldoKwhDalamAkhir,
    saldo_kwh_luar_akhir: 35.5
  });
  let resolveResponse;
  const responseEnded = new Promise(resolve => { resolveResponse = resolve; });
  const req = {
    method: "POST",
    url: "/api/kasir/tutup-preview",
    headers: {
      "x-session-id": "closing-kwh-harness-session",
      "x-device-id": "closing-kwh-harness-device"
    },
    on(event, callback) {
      if (event === "data") queueMicrotask(() => callback(Buffer.from(body)));
      if (event === "end") queueMicrotask(callback);
      return this;
    }
  };
  const response = {
    statusCode: null,
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    once(event, callback) {
      if (event === "finish") this.finish = callback;
      return this;
    },
    writeHead(status) { this.statusCode = status; },
    end(value) {
      this.body = value || "";
      if (this.finish) this.finish();
      resolveResponse();
    }
  };
  await app.handler(req, response);
  await responseEnded;
  return { status: response.statusCode, body: JSON.parse(response.body || "{}") };
}

async function assertRejectedScenario(akhir, expectedMessage) {
  const app = await createHarness();
  try {
    const shiftId = await app.createShift();
    const result = await request(app, shiftId, akhir);
    assert.equal(result.status, 400);
    assert.equal(result.body.success, false);
    assert.match(result.body.message, expectedMessage);
    assert.deepEqual(
      await get(app.db, "SELECT status, pending_close_snapshot FROM shift_kasir WHERE id = ?", [shiftId]),
      { status: "OPEN", pending_close_snapshot: null }
    );
  } finally {
    await app.close();
  }
}

test("POST /api/kasir/tutup-preview memvalidasi KWh dengan database terisolasi", async t => {
  await t.test("KWh Akhir lebih kecil dari KWh Tersedia menyimpan snapshot PENDING_CLOSE", async () => {
    const app = await createHarness();
    try {
      const shiftId = await app.createShift();
      const result = await request(app, shiftId, 60.5);
      assert.equal(result.status, 200);
      assert.equal(result.body.success, true);
      assert.equal(result.body.shift.status, "PENDING_CLOSE");
      assert.deepEqual(result.body.kwh.dalam, {
        awal: 50.25,
        totalTokenTopup: 10.5,
        tokenTopupTersedia: true,
        tersedia: 60.75,
        akhir: 60.5,
        penggunaan: 0.25
      });
      assert.deepEqual(result.body.kwh.luar, {
        awal: 30.25,
        totalTokenTopup: 5.5,
        tokenTopupTersedia: true,
        tersedia: 35.75,
        akhir: 35.5,
        penggunaan: 0.25
      });

      const saved = await get(
        app.db,
        "SELECT status, pending_close_snapshot FROM shift_kasir WHERE id = ?",
        [shiftId]
      );
      assert.equal(saved.status, "PENDING_CLOSE");
      assert.ok(saved.pending_close_snapshot);
      assert.deepEqual(JSON.parse(saved.pending_close_snapshot), result.body);
    } finally {
      await app.close();
    }
  });

  await t.test("KWh Akhir sama dengan KWh Tersedia ditolak tanpa mengubah shift", async () => {
    await assertRejectedScenario(60.75, /pemakaian KWh tidak terdeteksi/i);
  });

  await t.test("KWh Akhir lebih besar dari KWh Tersedia ditolak tanpa mengubah shift", async () => {
    await assertRejectedScenario(61, /KWh Akhir melebihi KWh Tersedia/i);
  });
});
