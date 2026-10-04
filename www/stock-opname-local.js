const crypto = require("crypto");
const createQueues = new WeakMap();

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(error) {
      if (error) return reject(error);
      resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function get(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (error, row) => error ? reject(error) : resolve(row || null));
  });
}

function all(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows || []));
  });
}

function finiteNonNegative(value, field) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new TypeError(`${field} harus berupa angka non-negatif.`);
  }
  return number;
}

function normalizeItem(item) {
  const id = Number(item?.local_master_barang_id ?? item?.idBarang ?? item?.id);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new TypeError("Setiap item wajib memakai master_barang.id yang valid.");
  }
  return { id, qty: finiteNonNegative(item?.jumlahHasilSO ?? item?.jumlah_hasil_so, "jumlahHasilSO") };
}

function makeSoId(now = new Date()) {
  return `SO-LOCAL-${now.getTime()}-${crypto.randomBytes(3).toString("hex")}`;
}

async function listBarang(db) {
  return all(db, `SELECT id, id_barang AS idBarang, nama, kategori, hpp, harga_jual,
    stok_aktual AS stokAktual, updated_at FROM master_barang ORDER BY nama COLLATE NOCASE, id`);
}

async function getBarangByLocalId(db, id) {
  const localId = Number(id);
  if (!Number.isSafeInteger(localId) || localId <= 0) return null;
  return get(db, `SELECT id, id_barang, nama, kategori, hpp, harga_jual, stok_aktual
    FROM master_barang WHERE id = ?`, [localId]);
}

async function getDetails(db, soId) {
  return all(db, `SELECT local_master_barang_id AS local_master_barang_id,
    id_barang AS id_barang, nama_barang AS namaBarang, area, satuan,
    jumlah_barang_aktual AS jumlahBarangAktual, jumlah_hasil_so AS jumlahHasilSO,
    selisih_barang AS selisihBarang, kerugian_hpp AS kerugianHPP,
    kerugian_harga_jual AS kerugianHargaJual, nominal_plus AS nominalPlus
    FROM stock_opname_detail WHERE so_id = ? ORDER BY id ASC`, [soId]);
}

async function getLatestBySource(db, category, source) {
  const requestedSource = String(source ?? "").trim();
  const normalizedSource = /^(LOCAL|LEGACY)$/i.test(requestedSource)
    ? requestedSource.toUpperCase()
    : requestedSource;
  return get(db, `SELECT * FROM stock_opname WHERE kategori = ? AND source = ?
    ORDER BY id DESC LIMIT 1`, [String(category || "").trim().toUpperCase(), normalizedSource]);
}

function isLegacyStockOpname(row) {
  return Boolean(row && row.source === "LEGACY" && !String(row.so_id || "").startsWith("SO-LOCAL-"));
}

async function createStockOpnameUnlocked(db, input, now = new Date()) {
  const category = String(input?.category || input?.kategori || "").trim().toUpperCase();
  const petugas = String(input?.petugas || "").trim();
  const items = input?.items;
  if (!category) throw new TypeError("category wajib diisi.");
  if (!Array.isArray(items) || items.length === 0) throw new TypeError("Items harus berupa array dan tidak boleh kosong.");

  const normalized = items.map(normalizeItem);
  if (new Set(normalized.map(item => item.id)).size !== normalized.length) {
    throw new TypeError("Barang duplikat dalam Stock Opname.");
  }

  const products = [];
  for (const item of normalized) {
    const product = await getBarangByLocalId(db, item.id);
    if (!product) {
      const error = new Error(`Barang dengan master_barang.id ${item.id} tidak ditemukan.`);
      error.code = "SO_ITEM_NOT_FOUND";
      throw error;
    }
    products.push({ ...product, qty: item.qty });
  }

  const soId = makeSoId(now);
  const timestamp = now.toISOString();
  const tanggal = String(input?.tanggalSO || timestamp);
  const resultItems = products.map(product => ({
    local_master_barang_id: Number(product.id),
    id_barang: product.id_barang == null ? null : String(product.id_barang),
    namaBarang: product.nama,
    area: product.kategori || category,
    satuan: "Pcs",
    jumlahBarangAktual: Number(product.stok_aktual || 0),
    jumlahHasilSO: product.qty,
    selisihBarang: product.qty - Number(product.stok_aktual || 0),
    // Historical monetary formulas are unavailable in the local source.
    kerugianHPP: 0,
    kerugianHargaJual: 0,
    nominalPlus: 0
  }));

  // BEGIN IMMEDIATE serializes competing writers before checking active state.
  await run(db, "BEGIN IMMEDIATE TRANSACTION");
  try {
    const active = await get(db, `SELECT so_id FROM stock_opname
      WHERE source = 'LOCAL' AND kategori = ? AND is_final = 0 AND UPPER(status) != 'FINAL'
      ORDER BY id DESC LIMIT 1`, [category]);
    if (active) {
      const error = new Error("Stock Opname lokal aktif sudah ada; revisi lokal belum tersedia.");
      error.code = "SO_STILL_ACTIVE";
      throw error;
    }
    await run(db, `INSERT INTO stock_opname
      (so_id, source, kategori, petugas, tanggal, revisi_ke, is_final, status,
       total_plus, total_minus, total_kerugian, created_at, updated_at)
      VALUES (?, 'LOCAL', ?, ?, ?, 0, 0, 'DRAFT', 0, 0, 0, ?, ?)`,
    [soId, category, petugas, tanggal, timestamp, timestamp]);

    for (const item of resultItems) {
      await run(db, `INSERT INTO stock_opname_detail
        (so_id, id_barang, local_master_barang_id, nama_barang, area, satuan, jumlah_barang_aktual,
         jumlah_hasil_so, selisih_barang, kerugian_hpp, kerugian_harga_jual,
         nominal_plus, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [soId, item.id_barang, item.local_master_barang_id, item.namaBarang, item.area, item.satuan,
        item.jumlahBarangAktual, item.jumlahHasilSO, item.selisihBarang,
        item.kerugianHPP, item.kerugianHargaJual, item.nominalPlus, timestamp, timestamp]);
    }

    await run(db, "COMMIT");
  } catch (error) {
    try { await run(db, "ROLLBACK"); } catch (_) {}
    throw error;
  }

  return {
    soId,
    revisiKe: 0,
    status: "DRAFT",
    data: {
      soId,
      category,
      status: "DRAFT",
      items: resultItems,
      // Monetary aggregation is blocked until the historical formula is evidenced.
      summary: { totalPlus: 0, totalMinus: 0, totalKerugian: 0 }
    }
  };
}

function createStockOpname(db, input, now = new Date()) {
  const previous = createQueues.get(db) || Promise.resolve();
  const current = previous.catch(() => {}).then(() => createStockOpnameUnlocked(db, input, now));
  createQueues.set(db, current);
  return current;
}

module.exports = { listBarang, getBarangByLocalId, getDetails, getLatestBySource,
  isLegacyStockOpname, createStockOpname };
