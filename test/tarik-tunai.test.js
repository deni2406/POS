const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const sqlite3 = require("sqlite3").verbose();
const {
  createTarikTunai,
  generateNomorTransaksi,
  getSetoranByCode,
  summarizeTransactions
} = require("../tarik-tunai");

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (error) {
      if (error) reject(error);
      else resolve(this);
    });
  });
}

function get(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (error, row) => {
      if (error) reject(error);
      else resolve(row);
    });
  });
}

function openDatabase(filename = ":memory:") {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(filename, error => error ? reject(error) : resolve(db));
  });
}

async function initialize(db) {
  await run(db, "PRAGMA foreign_keys = ON");
  await run(db, `CREATE TABLE kasir (id INTEGER PRIMARY KEY, username TEXT, nama TEXT NOT NULL)`);
  await run(db, `CREATE TABLE shift_kasir (id INTEGER PRIMARY KEY, kasir_id INTEGER NOT NULL, status TEXT NOT NULL, saldo_awal INTEGER NOT NULL DEFAULT 0, uang_laci INTEGER NOT NULL DEFAULT 0, nominal_aktual INTEGER NOT NULL DEFAULT 0, FOREIGN KEY(kasir_id) REFERENCES kasir(id))`);
  await run(db, `CREATE TABLE setoran (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kode_setoran TEXT NOT NULL UNIQUE COLLATE NOCASE,
    shift_id INTEGER NOT NULL,
    kasir_id INTEGER NOT NULL,
    nominal_awal INTEGER NOT NULL CHECK (nominal_awal > 0),
    saldo_tersisa INTEGER NOT NULL CHECK (saldo_tersisa >= 0 AND saldo_tersisa <= nominal_awal),
    dibuat_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'AKTIF',
    FOREIGN KEY (shift_id) REFERENCES shift_kasir(id),
    FOREIGN KEY (kasir_id) REFERENCES kasir(id)
  )`);
  await run(db, `CREATE TABLE transaksi (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nomor_transaksi TEXT NOT NULL,
    tanggal TEXT NOT NULL,
    jam TEXT NOT NULL,
    kasir TEXT NOT NULL,
    total INTEGER NOT NULL,
    metode_pembayaran TEXT NOT NULL,
    status_sync TEXT NOT NULL DEFAULT 'SYNCED',
    shift_id INTEGER,
    bayar INTEGER NOT NULL,
    kembalian INTEGER NOT NULL,
    cash_amount INTEGER NOT NULL,
    qris_amount INTEGER NOT NULL,
    tipe_transaksi TEXT NOT NULL DEFAULT 'PENJUALAN',
    FOREIGN KEY (shift_id) REFERENCES shift_kasir(id)
  )`);
  await run(db, `CREATE TABLE detail_transaksi (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    transaksi_id INTEGER NOT NULL REFERENCES transaksi(id),
    nama_barang TEXT NOT NULL
  )`);
  await run(db, `CREATE TABLE master_barang (id INTEGER PRIMARY KEY, stok_aktual INTEGER NOT NULL)`);
  await run(db, `CREATE TABLE nomor_transaksi_sequence (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dibuat_at TEXT NOT NULL
  )`);
  await run(db, `CREATE TABLE tarik_tunai (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    transaksi_id INTEGER NOT NULL UNIQUE REFERENCES transaksi(id),
    nomor_transaksi TEXT NOT NULL UNIQUE,
    setoran_id INTEGER NOT NULL REFERENCES setoran(id),
    kode_setoran TEXT NOT NULL,
    kasir_id INTEGER NOT NULL REFERENCES kasir(id),
    shift_id INTEGER NOT NULL REFERENCES shift_kasir(id),
    nominal INTEGER NOT NULL CHECK (nominal > 0),
    tanggal TEXT NOT NULL,
    jam TEXT NOT NULL,
    referensi_qris TEXT NOT NULL DEFAULT '',
    dibuat_at TEXT NOT NULL,
    saldo_setelah INTEGER NOT NULL CHECK (saldo_setelah >= 0)
  )`);
  await run(db, `CREATE TABLE kas_keluar (id INTEGER PRIMARY KEY, nominal INTEGER NOT NULL)`);
  await run(db, `INSERT INTO kasir (id, username, nama) VALUES (1, 'source', 'Kasir Sumber'), (2, 'current', 'Kasir Saat Ini')`);
  await run(db, `INSERT INTO shift_kasir (id, kasir_id, status, saldo_awal, uang_laci, nominal_aktual) VALUES (1, 1, 'CLOSED', 500000, 500000, 450000), (2, 2, 'OPEN', 75000, 90000, 125000)`);
  await run(db, `INSERT INTO master_barang (id, stok_aktual) VALUES (1, 10)`);
  await run(db, `INSERT INTO setoran (kode_setoran, shift_id, kasir_id, nominal_awal, saldo_tersisa, dibuat_at) VALUES ('SET-001', 1, 1, 500000, 500000, '2026-09-29T00:00:00.000Z')`);
}

async function fixture() {
  const db = await openDatabase();
  await initialize(db);
  return db;
}

const transactionInput = overrides => ({
  kodeSetoran: "SET-001",
  nominal: 100000,
  kasir: "current",
  kasirId: 2,
  shiftId: 2,
  now: new Date("2026-09-29T01:14:00.000Z"),
  ...overrides
});

test("Rp500.000 ditarik Rp100.000 menyisakan Rp400.000 dan bisa dipakai lagi", async () => {
  const db = await fixture();
  try {
    const first = await createTarikTunai(db, transactionInput());
    assert.equal(first.saldoSetelah, 400000);
    assert.equal((await getSetoranByCode(db, "set-001")).saldo_tersisa, 400000);
    const second = await createTarikTunai(db, transactionInput({ nominal: 50000 }));
    assert.equal(second.saldoSetelah, 350000);
    assert.notEqual(first.nomorTransaksi, second.nomorTransaksi);
    assert.equal((await get(db, "SELECT COUNT(*) AS count FROM tarik_tunai")).count, 2);
  } finally {
    await new Promise(resolve => db.close(resolve));
  }
});

test("nominal melebihi saldo ditolak dan saldo tidak pernah negatif", async () => {
  const db = await fixture();
  try {
    await assert.rejects(createTarikTunai(db, transactionInput({ nominal: 500001 })), { code: "SALDO_SETORAN_TIDAK_CUKUP" });
    await createTarikTunai(db, transactionInput({ nominal: 500000 }));
    await assert.rejects(createTarikTunai(db, transactionInput({ nominal: 1 })), { code: "SETORAN_TIDAK_AKTIF" });
    const setoran = await getSetoranByCode(db, "SET-001");
    assert.equal(setoran.saldo_tersisa, 0);
    assert.equal(setoran.status, "HABIS");
  } finally {
    await new Promise(resolve => db.close(resolve));
  }
});

test("Tarik Tunai tercatat sebagai QRIS dengan cash_amount nol tanpa kas_keluar", async () => {
  const db = await fixture();
  try {
    const result = await createTarikTunai(db, transactionInput());
    const transaction = await get(db, `SELECT * FROM transaksi WHERE id = ?`, [result.transaksiId]);
    assert.equal(transaction.metode_pembayaran, "QRIS");
    assert.equal(transaction.tipe_transaksi, "TARIK_TUNAI");
    assert.equal(transaction.cash_amount, 0);
    assert.equal(transaction.qris_amount, 100000);
    assert.equal(transaction.bayar, 100000);
    assert.equal(transaction.kembalian, 0);
    assert.equal((await get(db, "SELECT COUNT(*) AS count FROM detail_transaksi")).count, 0);
    assert.equal((await get(db, "SELECT stok_aktual FROM master_barang WHERE id = 1")).stok_aktual, 10);
    assert.equal((await get(db, "SELECT COUNT(*) AS count FROM kas_keluar")).count, 0);
    const shift = await get(db, "SELECT saldo_awal, uang_laci, nominal_aktual FROM shift_kasir WHERE id = 2");
    assert.deepEqual(shift, { saldo_awal: 75000, uang_laci: 90000, nominal_aktual: 125000 });
  } finally {
    await new Promise(resolve => db.close(resolve));
  }
});

test("kode Setoran unik dan nomor transaksi aman saat dibuat pada detik yang sama", async () => {
  const db = await fixture();
  try {
    await assert.rejects(
      run(db, `INSERT INTO setoran (kode_setoran, shift_id, kasir_id, nominal_awal, saldo_tersisa, dibuat_at)
        VALUES ('set-001', 1, 1, 500000, 500000, '2026-09-29T00:00:00.000Z')`),
      /UNIQUE constraint failed/
    );
    const time = new Date("2026-09-29T01:14:00.000Z");
    const first = await generateNomorTransaksi(db, time);
    const second = await generateNomorTransaksi(db, time);
    assert.notEqual(first, second);
  } finally {
    await new Promise(resolve => db.close(resolve));
  }
});

test("riwayat Tarik Tunai memiliki relasi transaksi dan Setoran", async () => {
  const db = await fixture();
  try {
    const result = await createTarikTunai(db, transactionInput({ referensiQris: "QR-REF-001" }));
    const history = await get(db, `SELECT h.nomor_transaksi, h.kode_setoran, h.nominal,
      h.kasir_id, h.shift_id, h.saldo_setelah, h.referensi_qris, t.metode_pembayaran, t.tipe_transaksi
      FROM tarik_tunai h JOIN transaksi t ON t.id = h.transaksi_id WHERE h.transaksi_id = ?`,
      [result.transaksiId]);
    assert.equal(history.nomor_transaksi, result.nomorTransaksi);
    assert.equal(history.kode_setoran, "SET-001");
    assert.equal(history.nominal, 100000);
    assert.equal(history.saldo_setelah, 400000);
    assert.equal(history.referensi_qris, "QR-REF-001");
    assert.equal(history.metode_pembayaran, "QRIS");
    assert.equal(history.tipe_transaksi, "TARIK_TUNAI");
    await run(db, `CREATE TRIGGER trg_transaksi_tarik_tunai_immutable
      BEFORE UPDATE OF status_sync ON transaksi
      WHEN EXISTS (SELECT 1 FROM tarik_tunai WHERE transaksi_id = OLD.id)
        AND NEW.status_sync IN ('BATAL', 'CANCELLED')
      BEGIN SELECT RAISE(ABORT, 'TARIK_TUNAI_CANNOT_BE_CANCELLED'); END`);
    await assert.rejects(
      run(db, "UPDATE transaksi SET status_sync = 'BATAL' WHERE id = ?", [result.transaksiId]),
      /TARIK_TUNAI_CANNOT_BE_CANCELLED/
    );
  } finally {
    await new Promise(resolve => db.close(resolve));
  }
});

test("ringkasan closing memakai amount dan menyertakan Tarik Tunai serta CASH+QRIS", () => {
  const summary = summarizeTransactions([
    { metode_pembayaran: "CASH", total: 1000, cash_amount: 1000, qris_amount: 0, tipe_transaksi: "PENJUALAN" },
    { metode_pembayaran: "CASH+QRIS", total: 3000, cash_amount: 1000, qris_amount: 2000, tipe_transaksi: "PENJUALAN" },
    { metode_pembayaran: "QRIS", total: 500, cash_amount: 0, qris_amount: 500, tipe_transaksi: "TARIK_TUNAI", nominal_tarik_tunai: 500 },
    { metode_pembayaran: "QRIS", total: 9000, cash_amount: 0, qris_amount: 9000, tipe_transaksi: "PENJUALAN", status_sync: "BATAL" }
  ]);
  assert.deepEqual(summary, {
    jumlahTransaksi: 3,
    totalCash: 2000,
    totalQris: 2500,
    totalPenjualan: 4500,
    jumlahTransaksiCash: 2,
    jumlahTransaksiQris: 2,
    jumlahTarikTunai: 1,
    totalTarikTunai: 500
  });
});

test("kegagalan pencatatan histori me-rollback saldo dan transaksi", async () => {
  const db = await fixture();
  try {
    await run(db, `CREATE TRIGGER fail_tarik_tunai_history BEFORE INSERT ON tarik_tunai
      BEGIN SELECT RAISE(ABORT, 'SIMULATED_HISTORY_FAILURE'); END`);
    await assert.rejects(createTarikTunai(db, transactionInput()), /SIMULATED_HISTORY_FAILURE/);
    assert.equal((await getSetoranByCode(db, "SET-001")).saldo_tersisa, 500000);
    assert.equal((await get(db, "SELECT COUNT(*) AS count FROM transaksi")).count, 0);
  } finally {
    await new Promise(resolve => db.close(resolve));
  }
});

test("dua koneksi bersamaan tidak dapat membelanjakan saldo yang sama", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pbms-tarik-tunai-"));
  const filename = path.join(directory, "test.db");
  const firstDb = await openDatabase(filename);
  let secondDb;
  try {
    firstDb.configure("busyTimeout", 5000);
    await initialize(firstDb);
    secondDb = await openDatabase(filename);
    secondDb.configure("busyTimeout", 5000);
    await run(secondDb, "PRAGMA foreign_keys = ON");
    const results = await Promise.allSettled([
      createTarikTunai(firstDb, transactionInput({ nominal: 400000 })),
      createTarikTunai(secondDb, transactionInput({ nominal: 400000 }))
    ]);
    assert.equal(results.filter(item => item.status === "fulfilled").length, 1);
    assert.equal((await getSetoranByCode(firstDb, "SET-001")).saldo_tersisa, 100000);
    assert.equal((await get(firstDb, "SELECT COUNT(*) AS count FROM transaksi")).count, 1);
  } finally {
    await new Promise(resolve => firstDb.close(resolve));
    if (secondDb) await new Promise(resolve => secondDb.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("printer gagal setelah commit tidak menghapus Tarik Tunai", async () => {
  const db = await fixture();
  try {
    const result = await createTarikTunai(db, transactionInput());
    await assert.rejects(Promise.reject(new Error("printer offline")), /printer offline/);
    assert.equal((await get(db, "SELECT COUNT(*) AS count FROM transaksi WHERE id = ?", [result.transaksiId])).count, 1);
    assert.equal((await getSetoranByCode(db, "SET-001")).saldo_tersisa, 400000);
  } finally {
    await new Promise(resolve => db.close(resolve));
  }
});
