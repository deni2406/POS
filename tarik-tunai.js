class TarikTunaiError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "TarikTunaiError";
    this.code = code;
  }
}

function runAsync(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (error) {
      if (error) reject(error);
      else resolve(this);
    });
  });
}

function getAsync(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (error, row) => {
      if (error) reject(error);
      else resolve(row || null);
    });
  });
}

function localDateTime(now) {
  const tanggal = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const jam = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}`;
  return { tanggal, jam };
}

async function getSetoranByCode(db, kodeSetoran) {
  return getAsync(
    db,
    `SELECT s.id, s.kode_setoran, s.shift_id, s.kasir_id, k.nama AS nama_kasir,
            s.nominal_awal, s.saldo_tersisa, s.dibuat_at, s.status
     FROM setoran s
     JOIN kasir k ON k.id = s.kasir_id
     WHERE s.kode_setoran = ? COLLATE NOCASE`,
    [kodeSetoran]
  );
}

async function generateNomorTransaksi(db, now = new Date()) {
  const { tanggal, jam } = localDateTime(now);
  const tanggalId = tanggal.replace(/-/g, "");
  const waktuId = jam.replace(/:/g, "");
  for (let attempt = 0; attempt < 10; attempt++) {
    const sequence = await runAsync(
      db,
      `INSERT INTO nomor_transaksi_sequence (dibuat_at) VALUES (?)`,
      [now.toISOString()]
    );
    const nomorTransaksi = `TRX-${tanggalId}-${waktuId}-${sequence.lastID}`;
    const existing = await getAsync(
      db,
      `SELECT 1 AS ada FROM transaksi WHERE nomor_transaksi = ? LIMIT 1`,
      [nomorTransaksi]
    );
    if (!existing) return nomorTransaksi;
  }
  throw new Error("Tidak dapat membuat nomor transaksi unik setelah beberapa percobaan.");
}

async function createTarikTunai(db, data) {
  if (!Number.isSafeInteger(data.nominal) || data.nominal <= 0) {
    throw new TarikTunaiError("NOMINAL_TIDAK_VALID", "Nominal Tarik Tunai harus berupa integer positif.");
  }

  const kodeSetoran = typeof data.kodeSetoran === "string" ? data.kodeSetoran.trim() : "";
  if (!kodeSetoran || kodeSetoran.length > 128 || /[\u0000-\u001f\u007f]/.test(kodeSetoran)) {
    throw new TarikTunaiError("KODE_SETORAN_WAJIB", "Kode Setoran wajib diisi.");
  }
  if (data.referensiQris != null && typeof data.referensiQris !== "string") {
    throw new TarikTunaiError("REFERENSI_QRIS_TIDAK_VALID", "Referensi QRIS harus berupa teks.");
  }
  const referensiQris = typeof data.referensiQris === "string" ? data.referensiQris.trim() : "";
  if (referensiQris.length > 200 || /[\u0000-\u001f\u007f]/.test(referensiQris)) {
    throw new TarikTunaiError("REFERENSI_QRIS_TIDAK_VALID", "Referensi QRIS maksimal 200 karakter tanpa karakter kontrol.");
  }

  let transactionStarted = false;
  try {
    await runAsync(db, "BEGIN IMMEDIATE TRANSACTION");
    transactionStarted = true;

    const setoran = await getSetoranByCode(db, kodeSetoran);
    if (!setoran) {
      throw new TarikTunaiError("SETORAN_TIDAK_DITEMUKAN", "Kode Setoran tidak ditemukan.");
    }
    if (setoran.status !== "AKTIF" || Number(setoran.saldo_tersisa) <= 0) {
      throw new TarikTunaiError("SETORAN_TIDAK_AKTIF", "Setoran tidak memiliki saldo yang tersedia.");
    }
    if (data.nominal > Number(setoran.saldo_tersisa)) {
      throw new TarikTunaiError("SALDO_SETORAN_TIDAK_CUKUP", "Nominal Tarik Tunai melebihi saldo Setoran tersedia.");
    }

    const saldoUpdate = await runAsync(
      db,
      `UPDATE setoran
       SET saldo_tersisa = saldo_tersisa - ?,
           status = CASE WHEN saldo_tersisa - ? = 0 THEN 'HABIS' ELSE 'AKTIF' END
       WHERE id = ? AND status = 'AKTIF' AND saldo_tersisa >= ?`,
      [data.nominal, data.nominal, setoran.id, data.nominal]
    );
    if (saldoUpdate.changes !== 1) {
      throw new TarikTunaiError("SALDO_SETORAN_TIDAK_CUKUP", "Saldo Setoran berubah atau tidak mencukupi.");
    }

    const saldoSetelah = Number(setoran.saldo_tersisa) - data.nominal;
    const now = data.now instanceof Date ? data.now : new Date();
    const { tanggal, jam } = localDateTime(now);
    const nomorTransaksi = await generateNomorTransaksi(db, now);
    const transaksi = await runAsync(
      db,
      `INSERT INTO transaksi
       (nomor_transaksi, tanggal, jam, kasir, total, metode_pembayaran, status_sync,
        shift_id, bayar, kembalian, cash_amount, qris_amount, tipe_transaksi)
       VALUES (?, ?, ?, ?, ?, 'QRIS', 'SYNCED', ?, ?, 0, 0, ?, 'TARIK_TUNAI')`,
      [nomorTransaksi, tanggal, jam, data.kasir, data.nominal, data.shiftId, data.nominal, data.nominal]
    );

    await runAsync(
      db,
      `INSERT INTO tarik_tunai
       (transaksi_id, nomor_transaksi, setoran_id, kode_setoran, kasir_id, shift_id,
        nominal, tanggal, jam, referensi_qris, dibuat_at, saldo_setelah)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        transaksi.lastID,
        nomorTransaksi,
        setoran.id,
        setoran.kode_setoran,
        data.kasirId,
        data.shiftId,
        data.nominal,
        tanggal,
        jam,
        referensiQris,
        now.toISOString(),
        saldoSetelah
      ]
    );

    await runAsync(db, "COMMIT");
    transactionStarted = false;
    return {
      transaksiId: transaksi.lastID,
      nomorTransaksi,
      tanggal,
      jam,
      nominal: data.nominal,
      kodeSetoran: setoran.kode_setoran,
      saldoSetelah,
      metodePembayaran: "QRIS"
    };
  } catch (error) {
    if (transactionStarted) {
      try {
        await runAsync(db, "ROLLBACK");
      } catch (rollbackError) {
        error.message = `${error.message}; rollback gagal: ${rollbackError.message}`;
      }
    }
    throw error;
  }
}

function summarizeTransactions(transactions) {
  const active = transactions.filter(tx =>
    !["BATAL", "CANCELLED"].includes(String(tx.status_sync || "").trim().toUpperCase())
  );
  const cash = active.reduce((sum, tx) => {
    if (String(tx.tipe_transaksi || "PENJUALAN") === "TARIK_TUNAI") return sum;
    const method = String(tx.metode_pembayaran || "").trim().toUpperCase();
    return sum + (method === "CASH" ? Number(tx.total || 0) : Number(tx.cash_amount || 0));
  }, 0);
  const qris = active.reduce((sum, tx) => {
    if (String(tx.tipe_transaksi || "PENJUALAN") === "TARIK_TUNAI") return sum + Number(tx.qris_amount || 0);
    const method = String(tx.metode_pembayaran || "").trim().toUpperCase();
    return sum + (method === "QRIS" ? Number(tx.total || 0) : Number(tx.qris_amount || 0));
  }, 0);
  const isCashSale = tx => String(tx.metode_pembayaran || "").trim().toUpperCase() === "CASH"
    ? Number(tx.total || 0) > 0
    : Number(tx.cash_amount || 0) > 0;
  const isQrisSale = tx => String(tx.metode_pembayaran || "").trim().toUpperCase() === "QRIS"
    ? Number(tx.total || 0) > 0
    : Number(tx.qris_amount || 0) > 0;
  const tarikTunai = active.filter(tx => String(tx.tipe_transaksi || "") === "TARIK_TUNAI");
  return {
    jumlahTransaksi: active.length,
    totalCash: cash,
    totalQris: qris,
    totalPenjualan: cash + qris,
    jumlahTransaksiCash: active.filter(isCashSale).length,
    jumlahTransaksiQris: active.filter(isQrisSale).length,
    jumlahTarikTunai: tarikTunai.length,
    totalTarikTunai: tarikTunai.reduce((sum, tx) => sum + Number(tx.nominal_tarik_tunai || tx.qris_amount || 0), 0)
  };
}

module.exports = {
  TarikTunaiError,
  createTarikTunai,
  generateNomorTransaksi,
  getSetoranByCode,
  summarizeTransactions
};
