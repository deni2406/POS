"use strict";

// Isolated harness for purchase-KWh calculations in the production POST handler.
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
  if (
    !path.basename(resolvedHarness).startsWith("pos-pembelian-kwh-harness-") ||
    relative.startsWith("..") ||
    path.isAbsolute(relative) ||
    path.dirname(resolvedDb) !== resolvedHarness ||
    path.basename(resolvedDb) !== "pos.db"
  ) {
    throw new Error(`Database bukan milik direktori temporary harness: ${resolvedDb}`);
  }
  return resolvedDb;
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
  if (db) {
    await new Promise((resolve, reject) => db.close(error => {
      if (error) reject(error);
      else resolve();
    }));
  }
  for (const suffix of ["", "-journal", "-wal", "-shm"]) {
    fs.rmSync(path.join(harnessDir, `pos.db${suffix}`), { force: true });
  }
  fs.rmSync(harnessDir, { recursive: true, force: true });
}

async function createHarness() {
  const previousClosed = previousHarnessClosed;
  let releaseHarness;
  previousHarnessClosed = new Promise(resolve => { releaseHarness = resolve; });
  await previousClosed;

  const harnessDir = fs.mkdtempSync(path.join(tmpRoot, "pos-pembelian-kwh-harness-"));
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
              if (typeof requestedPath !== "string" || path.basename(requestedPath) !== "pos.db") {
                throw new Error(`Database produksi tak terduga: ${requestedPath}`);
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
    "\nmodule.exports.__harness = { db, activeLoginSessions };\n";
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
    await get(db, "SELECT 1");
    await run(db, "PRAGMA foreign_keys = ON");
    await run(db, `
      CREATE TABLE pembelian_kwh (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        shift_id INTEGER NOT NULL,
        kasir_id INTEGER NOT NULL,
        waktu TEXT NOT NULL,
        jenis_kwh TEXT NOT NULL CHECK (jenis_kwh IN ('DALAM', 'LUAR')),
        nominal_pembelian INTEGER NOT NULL
          CHECK (typeof(nominal_pembelian) = 'integer' AND nominal_pembelian >= 0),
        kwh_didapat INTEGER NOT NULL
          CHECK (typeof(kwh_didapat) = 'integer' AND kwh_didapat > 0),
        harga_per_kwh INTEGER NOT NULL
          CHECK (typeof(harga_per_kwh) = 'integer' AND harga_per_kwh >= 0),
        sisa_kwh INTEGER NOT NULL DEFAULT 0,
        keterangan TEXT NOT NULL DEFAULT '',
        FOREIGN KEY (shift_id) REFERENCES shift_kasir(id),
        FOREIGN KEY (kasir_id) REFERENCES kasir(id)
      )
    `);
    const cashier = await run(
      db,
      "INSERT INTO kasir (username, pin, nama, aktif) VALUES ('harness-kasir', '123456', 'Harness', 1)"
    );
    const shift = await run(
      db,
      "INSERT INTO shift_kasir (kasir_id, buka_at, status, opening_confirmed) VALUES (?, ?, 'OPEN', 1)",
      [cashier.lastID, new Date().toISOString()]
    );
    activeLoginSessions.set(cashier.lastID, {
      kasirId: cashier.lastID,
      username: "harness-kasir",
      sessionId: "pembelian-kwh-harness-session",
      deviceId: "pembelian-kwh-harness-device",
      expiresAt: Date.now() + 60000
    });

    return {
      db,
      handler,
      cashierId: cashier.lastID,
      shiftId: shift.lastID,
      harnessDir,
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

async function request(app, payload) {
  const body = JSON.stringify({
    jenis_kwh: "DALAM",
    nominal_pembelian: 1000000,
    kwh_didapat: "350",
    ...payload
  });
  let resolveResponse;
  const responseEnded = new Promise(resolve => { resolveResponse = resolve; });
  const req = {
    method: "POST",
    url: "/api/pembelian-kwh",
    headers: {
      "x-session-id": "pembelian-kwh-harness-session",
      "x-device-id": "pembelian-kwh-harness-device"
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

function expectedHargaScaled(nominal, kwhScaled) {
  const numerator = BigInt(nominal) * 10000n;
  const denominator = BigInt(kwhScaled);
  return Number((numerator * 2n + denominator) / (denominator * 2n));
}

test("POST /api/pembelian-kwh menghitung harga deterministik dalam database harness terisolasi", async t => {
  const app = await createHarness();
  try {
    const cases = [
      {
        name: "Rp1.000.000 / 350,00 KWh menghasilkan harga skala x100 285714",
        nominal: 1000000,
        inputKwh: "350",
        expectedScaledKwh: 35000,
        expectedHarga: 285714
      },
      {
        name: "Rp1.000.000 / 350,50 KWh menghasilkan harga skala x100 285307",
        nominal: 1000000,
        inputKwh: "350,50",
        expectedScaledKwh: 35050,
        expectedHarga: 285307
      },
      {
        name: "Rp1.003.500 / 350,50 KWh menghasilkan harga skala x100 286305",
        nominal: 1003500,
        inputKwh: "350.50",
        expectedScaledKwh: 35050,
        expectedHarga: 286305
      }
    ];

    for (const item of cases) {
      await t.test(item.name, async () => {
        assert.equal(expectedHargaScaled(item.nominal, item.expectedScaledKwh), item.expectedHarga);
        const result = await request(app, {
          nominal_pembelian: item.nominal,
          kwh_didapat: item.inputKwh
        });
        assert.equal(result.status, 201);
        assert.equal(result.body.kwh_didapat, item.expectedScaledKwh / 100);
        assert.equal(result.body.harga_per_kwh, item.expectedHarga / 100);
        assert.equal(result.body.sisa_kwh, item.expectedScaledKwh / 100);

        const row = await get(
          app.db,
          "SELECT nominal_pembelian, kwh_didapat, harga_per_kwh, sisa_kwh FROM pembelian_kwh WHERE id = ?",
          [result.body.id]
        );
        assert.deepEqual(row, {
          nominal_pembelian: item.nominal,
          kwh_didapat: item.expectedScaledKwh,
          harga_per_kwh: item.expectedHarga,
          sisa_kwh: item.expectedScaledKwh
        });
      });
    }

    await t.test("kwhScaled 350 KWh sama dengan 35000", async () => {
      const result = await request(app, { nominal_pembelian: 0, kwh_didapat: "350" });
      assert.equal(result.status, 201);
      const row = await get(app.db, "SELECT kwh_didapat, sisa_kwh FROM pembelian_kwh WHERE id = ?", [result.body.id]);
      assert.deepEqual(row, { kwh_didapat: 35000, sisa_kwh: 35000 });
    });

    await t.test("kwhScaled 350,50 KWh sama dengan 35050", async () => {
      const result = await request(app, { nominal_pembelian: 0, kwh_didapat: "350,50" });
      assert.equal(result.status, 201);
      const row = await get(app.db, "SELECT kwh_didapat, sisa_kwh FROM pembelian_kwh WHERE id = ?", [result.body.id]);
      assert.deepEqual(row, { kwh_didapat: 35050, sisa_kwh: 35050 });
    });
  } finally {
    await app.close();
  }
});
