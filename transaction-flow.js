function runAsync(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (error) {
      if (error) reject(error);
      else resolve(this);
    });
  });
}

function resolvePaymentAmounts({ total, method, cashAmount, qrisAmount, cashPaid, tableSession, details }) {
  const isKaryawan = String(tableSession && tableSession.jenis_sesi || "").trim().toUpperCase() === "KARYAWAN";
  const isFreeKaryawan = isKaryawan && total === 0;
  if (!Number.isFinite(total) || total < 0 || (total === 0 && !isFreeKaryawan)) {
    throw new Error("Total transaksi harus lebih dari 0");
  }

  if (isFreeKaryawan) {
    if (details.some(item => !item.isService)) {
      throw new Error("Transaksi Karyawan gratis hanya boleh berisi layanan meja");
    }
    return {
      method: "GRATIS",
      cashAmount: 0,
      qrisAmount: 0,
      bayar: 0,
      kembalian: 0
    };
  }

  if (!["CASH", "QRIS", "CASH+QRIS"].includes(method)) {
    throw new Error("Metode pembayaran tidak valid");
  }

  let cash = cashAmount;
  let qris = qrisAmount;
  let bayar = cash + qris;

  if (method === "CASH") {
    cash = cashPaid;
    qris = 0;
    bayar = cash;
  } else if (method === "QRIS") {
    cash = 0;
    qris = total;
    bayar = total;
  } else if (bayar !== total) {
    throw new Error(`Cash + QRIS harus sama dengan total. Total ${total}, dibayar ${bayar}`);
  }

  if (cash < 0 || qris < 0 || bayar < 0) {
    throw new Error("Nominal pembayaran tidak valid");
  }
  if (method === "CASH" && bayar < total) {
    throw new Error(`Nominal Cash kurang. Total ${total}, dibayar ${bayar}`);
  }

  return {
    method,
    cashAmount: cash,
    qrisAmount: qris,
    bayar,
    kembalian: Math.max(0, bayar - total)
  };
}

async function recordTransaction(db, { transaction, details, tableSession }) {
  const txRes = await runAsync(
    db,
    `INSERT INTO transaksi
     (nomor_transaksi, tanggal, jam, kasir, total, metode_pembayaran, status_sync, shift_id,
      bayar, kembalian, cash_amount, qris_amount, nomor_meja, session_id, member_id)
     VALUES (?, ?, ?, ?, ?, ?, 'SYNCED', ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      transaction.nomorTransaksi,
      transaction.tanggal,
      transaction.jam,
      transaction.kasir,
      transaction.total,
      transaction.method,
      transaction.shiftId,
      transaction.bayar,
      transaction.kembalian,
      transaction.cashAmount,
      transaction.qrisAmount,
      transaction.nomorMeja,
      transaction.sessionId,
      transaction.memberId
    ]
  );

  for (const item of details) {
    await runAsync(
      db,
      `INSERT INTO detail_transaksi (transaksi_id, nama_barang, qty, harga_jual, hpp, subtotal)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [txRes.lastID, item.nama, item.qty, item.hargaJual, item.hpp, item.subtotal]
    );

    if (!item.isService && item.barangId) {
      await runAsync(
        db,
        `UPDATE master_barang SET stok_aktual = stok_aktual - ? WHERE id = ?`,
        [item.qty, item.barangId]
      );
    }
  }

  if (tableSession) {
    const updateSesiRes = await runAsync(
      db,
      `UPDATE sesi_meja SET status = 'DIBAYAR' WHERE session_id = ? AND status != 'DIBAYAR'`,
      [tableSession.session_id]
    );
    if (updateSesiRes.changes === 0) {
      throw new Error("SESSION_ALREADY_PAID");
    }
  }

  return txRes.lastID;
}

async function closeTableSession(db, mejaSession, waktuSelesai) {
  if (mejaSession.status === "SELESAI") {
    throw new Error("Sesi sudah selesai");
  }
  if (String(mejaSession.jenis_sesi || "").toUpperCase() === "LOSS") {
    throw new Error("Gunakan menu Stop Loss untuk mengakhiri sesi LOSS");
  }
  if (mejaSession.status !== "AKTIF" && mejaSession.status !== "DIBAYAR") {
    throw new Error("Sesi tidak dalam status yang valid untuk ditutup");
  }

  await runAsync(
    db,
    `UPDATE sesi_meja SET status = 'SELESAI', waktu_selesai = ? WHERE session_id = ?`,
    [waktuSelesai, mejaSession.session_id]
  );
}

module.exports = {
  closeTableSession,
  recordTransaction,
  resolvePaymentAmounts
};
