const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const sqlite3 = require("sqlite3").verbose();
const { summarizeTransactions } = require("../tarik-tunai");
const {
  closeTableSession,
  recordTransaction,
  resolvePaymentAmounts
} = require("../transaction-flow");

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

function openDatabase() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(":memory:", error => error ? reject(error) : resolve(db));
  });
}

async function fixture() {
  const db = await openDatabase();
  await run(db, `CREATE TABLE sesi_meja (
    session_id TEXT PRIMARY KEY, nomor_meja INTEGER NOT NULL, jenis_sesi TEXT NOT NULL,
    status TEXT NOT NULL, waktu_selesai TEXT
  )`);
  await run(db, `CREATE TABLE transaksi (
    id INTEGER PRIMARY KEY AUTOINCREMENT, nomor_transaksi TEXT NOT NULL, tanggal TEXT NOT NULL,
    jam TEXT NOT NULL, kasir TEXT NOT NULL, total INTEGER NOT NULL, metode_pembayaran TEXT NOT NULL,
    status_sync TEXT NOT NULL, shift_id INTEGER, bayar INTEGER NOT NULL, kembalian INTEGER NOT NULL,
    cash_amount INTEGER NOT NULL, qris_amount INTEGER NOT NULL, nomor_meja INTEGER,
    session_id TEXT, member_id TEXT
  )`);
  await run(db, `CREATE TABLE detail_transaksi (
    id INTEGER PRIMARY KEY AUTOINCREMENT, transaksi_id INTEGER NOT NULL, nama_barang TEXT NOT NULL,
    qty INTEGER NOT NULL, harga_jual INTEGER NOT NULL, hpp INTEGER NOT NULL, subtotal INTEGER NOT NULL
  )`);
  await run(db, "CREATE TABLE master_barang (id INTEGER PRIMARY KEY, stok_aktual INTEGER NOT NULL)");
  await run(db, "CREATE TABLE shift_kasir (id INTEGER PRIMARY KEY, uang_laci INTEGER NOT NULL)");
  await run(db, "INSERT INTO sesi_meja VALUES ('SESSION-KARYAWAN', 4, 'KARYAWAN', 'AKTIF', NULL)");
  await run(db, "INSERT INTO sesi_meja VALUES ('SESSION-NORMAL', 5, 'NORMAL', 'AKTIF', NULL)");
  await run(db, "INSERT INTO master_barang VALUES (1, 12)");
  await run(db, "INSERT INTO shift_kasir VALUES (9, 150000)");
  return db;
}

const staffTableItem = {
  barangId: null,
  nama: "Meja Billiard",
  qty: 2,
  hargaJual: 0,
  hpp: 0,
  subtotal: 0,
  isService: true
};

const transaction = {
  nomorTransaksi: "TRX-STAFF-001",
  tanggal: "2026-09-29",
  jam: "10:15:00",
  kasir: "kasir-test",
  total: 0,
  shiftId: 9,
  bayar: 0,
  kembalian: 0,
  cashAmount: 0,
  qrisAmount: 0,
  nomorMeja: 4,
  sessionId: "SESSION-KARYAWAN",
  memberId: null
};

test("validasi laporan tutup shift menerima GRATIS hanya untuk transaksi Rp0 tanpa CASH/QRIS", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  const match = html.match(/function isValidClosingTransactionMethod\(tx, method, cashAmount, qrisAmount\) \{[\s\S]*?\n\}/);
  assert.ok(match, "closing payment validator should exist in index.html");
  const validate = new Function(`${match[0]}; return isValidClosingTransactionMethod;`)();
  const gratisTransaction = { total: 0, tipe_transaksi: "PENJUALAN" };
  assert.equal(validate(gratisTransaction, "GRATIS", 0, 0), true);
  assert.equal(validate({ total: 0 }, "GRATIS", 0, 0), false);
  assert.equal(validate({ ...gratisTransaction, total: 1 }, "GRATIS", 0, 0), false);
  assert.equal(validate(gratisTransaction, "GRATIS", 1, 0), false);
  assert.equal(validate(gratisTransaction, "GRATIS", 0, 1), false);
  assert.equal(validate({ ...gratisTransaction, tipe_transaksi: "TARIK_TUNAI" }, "GRATIS", 0, 0), false);
  assert.equal(validate({ total: 1000 }, "CASH", 1000, 0), true);
  assert.equal(validate({ total: 1000 }, "QRIS", 0, 1000), true);
  assert.equal(validate({ total: 1000 }, "CASH+QRIS", 400, 600), true);
});

test("frontend menutup sesi Karyawan GRATIS dengan targetSessionId tanpa double-close", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  const match = html.match(/function getSessionIdToCloseAfterTransaction\(finishedSession, targetSessionId, isFreeKaryawan\) \{[\s\S]*?\n\}/);
  assert.ok(match, "finished table session close selector should exist in index.html");
  const selectSessionId = new Function(`${match[0]}; return getSessionIdToCloseAfterTransaction;`)();

  assert.equal(selectSessionId({ status: "DIBAYAR" }, "SESSION-KARYAWAN", true), "SESSION-KARYAWAN");
  assert.equal(selectSessionId({ status: "AKTIF" }, "SESSION-NORMAL", false), "SESSION-NORMAL");
  assert.equal(selectSessionId({ status: "DIBAYAR" }, "SESSION-NORMAL", false), null);
  assert.equal(selectSessionId({ status: "SELESAI" }, "SESSION-KARYAWAN", true), null);
  assert.equal(selectSessionId({ status: "DIBAYAR" }, null, true), null);
  assert.equal(selectSessionId(null, "SESSION-KARYAWAN", true), null);
});

test("KARYAWAN Rp0 tercatat, menutup sesi, dan tidak mengubah stok atau kas", async () => {
  const db = await fixture();
  try {
    const tableSession = await get(db, "SELECT * FROM sesi_meja WHERE session_id = ?", [transaction.sessionId]);
    const payment = resolvePaymentAmounts({
      total: 0,
      method: undefined,
      cashAmount: 0,
      qrisAmount: 0,
      cashPaid: 0,
      tableSession,
      details: [staffTableItem]
    });
    assert.deepEqual(payment, {
      method: "GRATIS",
      cashAmount: 0,
      qrisAmount: 0,
      bayar: 0,
      kembalian: 0
    });

    const transactionId = await recordTransaction(db, {
      transaction: { ...transaction, ...payment },
      details: [staffTableItem],
      tableSession
    });

    const saved = await get(db, "SELECT * FROM transaksi WHERE id = ?", [transactionId]);
    assert.equal(saved.total, 0);
    assert.equal(saved.metode_pembayaran, "GRATIS");
    assert.equal(saved.cash_amount, 0);
    assert.equal(saved.qris_amount, 0);
    assert.equal(saved.session_id, transaction.sessionId);
    assert.equal(saved.nomor_meja, 4);
    assert.equal(saved.kasir, "kasir-test");
    assert.equal(saved.shift_id, 9);
    assert.equal(saved.tanggal, transaction.tanggal);
    assert.equal(saved.jam, transaction.jam);
    assert.equal((await get(db, "SELECT status FROM sesi_meja WHERE session_id = ?", [transaction.sessionId])).status, "DIBAYAR");
    assert.equal(summarizeTransactions([saved]).totalPenjualan, 0);

    const paidSession = await get(db, "SELECT * FROM sesi_meja WHERE session_id = ?", [transaction.sessionId]);
    await closeTableSession(db, paidSession, "2026-09-29T02:15:00.000Z");
    const closedSession = await get(db, "SELECT status, waktu_selesai FROM sesi_meja WHERE session_id = ?", [transaction.sessionId]);
    assert.deepEqual(closedSession, { status: "SELESAI", waktu_selesai: "2026-09-29T02:15:00.000Z" });

    assert.equal((await get(db, "SELECT stok_aktual FROM master_barang WHERE id = 1")).stok_aktual, 12);
    assert.equal((await get(db, "SELECT uang_laci FROM shift_kasir WHERE id = 9")).uang_laci, 150000);
  } finally {
    await new Promise(resolve => db.close(resolve));
  }
});

test("validasi CASH, QRIS, dan CASH+QRIS tetap memeriksa nominal pembayaran", () => {
  const input = {
    total: 1000,
    tableSession: { jenis_sesi: "NORMAL" },
    details: [staffTableItem]
  };
  assert.deepEqual(resolvePaymentAmounts({ ...input, method: "CASH", cashPaid: 1200, cashAmount: 0, qrisAmount: 0 }), {
    method: "CASH", cashAmount: 1200, qrisAmount: 0, bayar: 1200, kembalian: 200
  });
  assert.deepEqual(resolvePaymentAmounts({ ...input, method: "QRIS", cashPaid: 0, cashAmount: 0, qrisAmount: 0 }), {
    method: "QRIS", cashAmount: 0, qrisAmount: 1000, bayar: 1000, kembalian: 0
  });
  assert.deepEqual(resolvePaymentAmounts({ ...input, method: "CASH+QRIS", cashPaid: 0, cashAmount: 400, qrisAmount: 600 }), {
    method: "CASH+QRIS", cashAmount: 400, qrisAmount: 600, bayar: 1000, kembalian: 0
  });
  assert.throws(() => resolvePaymentAmounts({ ...input, method: "CASH", cashPaid: 999, cashAmount: 0, qrisAmount: 0 }), /Nominal Cash kurang/);
  assert.throws(() => resolvePaymentAmounts({ ...input, method: "CASH+QRIS", cashPaid: 0, cashAmount: 400, qrisAmount: 599 }), /Cash \+ QRIS harus sama/);
});

test("transaksi Rp0 non-KARYAWAN tetap ditolak meskipun client mengirim jenis KARYAWAN", async () => {
  const db = await fixture();
  try {
    const tableSession = await get(db, "SELECT * FROM sesi_meja WHERE session_id = 'SESSION-NORMAL'");
    const clientPayload = { jenisSesi: "KARYAWAN", total: 0 };
    assert.throws(() => resolvePaymentAmounts({
      total: clientPayload.total,
      method: "GRATIS",
      cashAmount: 0,
      qrisAmount: 0,
      cashPaid: 0,
      tableSession,
      details: [staffTableItem]
    }), /Total transaksi harus lebih dari 0/);
    assert.equal(tableSession.jenis_sesi, "NORMAL");
    assert.equal((await get(db, "SELECT COUNT(*) AS count FROM transaksi")).count, 0);
  } finally {
    await new Promise(resolve => db.close(resolve));
  }
});

test("KARYAWAN tidak dapat mencatat barang stok gratis dengan total Rp0", async () => {
  const db = await fixture();
  try {
    const tableSession = await get(db, "SELECT * FROM sesi_meja WHERE session_id = ?", [transaction.sessionId]);
    assert.throws(() => resolvePaymentAmounts({
      total: 0,
      method: "CASH",
      cashAmount: 0,
      qrisAmount: 0,
      cashPaid: 0,
      tableSession,
      details: [{ ...staffTableItem, barangId: 1, isService: false }]
    }), /hanya boleh berisi layanan meja/);
    assert.equal((await get(db, "SELECT stok_aktual FROM master_barang WHERE id = 1")).stok_aktual, 12);
  } finally {
    await new Promise(resolve => db.close(resolve));
  }
});
