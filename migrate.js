/**
 * migrate.js — Auto-migration untuk pos.db
 *
 * Menambah kolom & tabel yang dibutuhkan server.js / admin-server.js
 * tanpa menghapus atau merusak data yang sudah ada.
 *
 * Cara pakai:
 *   node migrate.js
 *   node migrate.js --dry-run   (hanya tampil, tidak mengubah DB)
 */

const sqlite3 = require("sqlite3").verbose();
const path = require("path");
const fs = require("fs");

const DB_PATH = path.resolve(__dirname, "pos.db");
const DRY_RUN = process.argv.includes("--dry-run");

const db = new sqlite3.Database(DB_PATH);
db.configure("busyTimeout", 10000);

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function tableExists(tableName) {
  return new Promise((resolve) => {
    db.get(
      `SELECT 1 AS exists FROM sqlite_master WHERE type='table' AND name=?`,
      [tableName],
      (err, row) => resolve(!err && !!row)
    );
  });
}

function columnExists(tableName, columnName) {
  return new Promise((resolve) => {
    db.all(
      `PRAGMA table_info(?)`,
      [tableName],
      (err, rows) => {
        if (err) { resolve(false); return; }
        resolve(rows.some((r) => r.name === columnName));
      }
    );
  });
}

function runSQL(sql, params = []) {
  return new Promise((resolve, reject) => {
    if (DRY_RUN) {
      console.log(`  [DRY-RUN] ${sql.slice(0, 120)}`);
      resolve();
      return;
    }
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

async function log(msg, level = "INFO") {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [${level}] ${msg}`);
}

// ─────────────────────────────────────────────────────────────
// Migration tasks
// ─────────────────────────────────────────────────────────────

const migrations = [
  // ── shift_kasir: kolom tambahan ────────────────────────────
  {
    name: "shift_kasir → saldo_kwh_awal",
    run: () => runSQL(`ALTER TABLE shift_kasir ADD COLUMN saldo_kwh_awal INTEGER NOT NULL DEFAULT 0`),
    onDuplicate: true,
  },
  {
    name: "shift_kasir → saldo_kwh_dalam_awal",
    run: () => runSQL(`ALTER TABLE shift_kasir ADD COLUMN saldo_kwh_dalam_awal INTEGER NOT NULL DEFAULT 0`),
    onDuplicate: true,
  },
  {
    name: "shift_kasir → saldo_kwh_luar_awal",
    run: () => runSQL(`ALTER TABLE shift_kasir ADD COLUMN saldo_kwh_luar_awal INTEGER NOT NULL DEFAULT 0`),
    onDuplicate: true,
  },
  {
    name: "shift_kasir → saldo_kwh_dalam_akhir",
    run: () => runSQL(`ALTER TABLE shift_kasir ADD COLUMN saldo_kwh_dalam_akhir INTEGER NOT NULL DEFAULT 0`),
    onDuplicate: true,
  },
  {
    name: "shift_kasir → saldo_kwh_luar_akhir",
    run: () => runSQL(`ALTER TABLE shift_kasir ADD COLUMN saldo_kwh_luar_akhir INTEGER NOT NULL DEFAULT 0`),
    onDuplicate: true,
  },
  {
    name: "shift_kasir → opening_confirmed",
    run: () => runSQL(`ALTER TABLE shift_kasir ADD COLUMN opening_confirmed INTEGER NOT NULL DEFAULT 0`),
    onDuplicate: true,
  },
  {
    name: "shift_kasir → kode_tutup",
    run: () => runSQL(`ALTER TABLE shift_kasir ADD COLUMN kode_tutup TEXT`),
    onDuplicate: true,
  },
  {
    name: "shift_kasir → pending_close_at",
    run: () => runSQL(`ALTER TABLE shift_kasir ADD COLUMN pending_close_at TEXT`),
    onDuplicate: true,
  },
  {
    name: "shift_kasir → pending_close_snapshot",
    run: () => runSQL(`ALTER TABLE shift_kasir ADD COLUMN pending_close_snapshot TEXT`),
    onDuplicate: true,
  },
  {
    name: "shift_kasir → uang_laci",
    run: () => runSQL(`ALTER TABLE shift_kasir ADD COLUMN uang_laci INTEGER NOT NULL DEFAULT 0`),
    onDuplicate: true,
  },
  // ── transaksi: kolom tambahan ─────────────────────────────
  {
    name: "transaksi → tipe_transaksi",
    run: () => runSQL(`ALTER TABLE transaksi ADD COLUMN tipe_transaksi TEXT NOT NULL DEFAULT 'PENJUALAN'`),
    onDuplicate: true,
  },
  // ── harga_member_cache: kolom tambahan ─────────────────────
  {
    name: "harga_member_cache → jam_selesai",
    run: () => runSQL(`ALTER TABLE harga_member_cache ADD COLUMN jam_selesai TEXT`),
    onDuplicate: true,
  },
  // ── kas_laci_transaksi: tabel + kolom tambahan ─────────────
  {
    name: "kas_laci_transaksi → kode_setoran",
    run: () => runSQL(`ALTER TABLE kas_laci_transaksi ADD COLUMN kode_setoran TEXT NOT NULL DEFAULT ''`),
    onDuplicate: true,
    requiresTable: "kas_laci_transaksi",
  },
  // ── Index: unique kode_tutup ───────────────────────────────
  {
    name: "idx_shift_kasir_kode_tutup_unique",
    run: () =>
      runSQL(
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_shift_kasir_kode_tutup_unique ON shift_kasir(kode_tutup) WHERE kode_tutup IS NOT NULL AND kode_tutup <> ''`
      ),
    onDuplicate: true,
  },
];

// Tabel-tabel yang perlu dibuat jika belum ada (dari server.js)
const createTables = [
  `CREATE TABLE IF NOT EXISTS kas_laci_transaksi (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    transaction_id TEXT NOT NULL UNIQUE,
    jenis TEXT NOT NULL CHECK (jenis IN ('UANG_MASUK', 'UANG_KELUAR')),
    nominal INTEGER NOT NULL CHECK (typeof(nominal) = 'integer' AND nominal > 0),
    keterangan TEXT NOT NULL DEFAULT '',
    kasir_id INTEGER NOT NULL,
    kasir TEXT NOT NULL,
    waktu TEXT NOT NULL,
    kode_setoran TEXT NOT NULL DEFAULT '',
    CHECK (
      (jenis = 'UANG_MASUK' AND transaction_id GLOB 'KLM[0-9][0-9][0-9][0-9]*' AND substr(transaction_id, 4) NOT GLOB '*[^0-9]*' AND CAST(substr(transaction_id, 4) AS INTEGER) > 0) OR
      (jenis = 'UANG_KELUAR' AND transaction_id GLOB 'KLK[0-9][0-9][0-9][0-9]*' AND substr(transaction_id, 4) NOT GLOB '*[^0-9]*' AND CAST(substr(transaction_id, 4) AS INTEGER) > 0)
    )
  )`,

  `CREATE TABLE IF NOT EXISTS rekonsiliasi_kasir (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kode_rekonsiliasi TEXT NOT NULL UNIQUE,
    kasir_id INTEGER NOT NULL,
    shift_id INTEGER NOT NULL,
    kode_tutup TEXT NOT NULL,
    jenis TEXT NOT NULL CHECK (jenis IN ('PENJUALAN','KAS')),
    arah TEXT NOT NULL CHECK (arah IN ('PLUS','MINUS')),
    nominal INTEGER NOT NULL CHECK (nominal >= 0),
    status_pelunasan TEXT,
    dibuat_at TEXT NOT NULL,
    dilunasi_at TEXT,
    dibuat_oleh INTEGER,
    dilunasi_oleh INTEGER,
    keterangan TEXT NOT NULL DEFAULT '',
    UNIQUE(shift_id, jenis),
    FOREIGN KEY (kasir_id) REFERENCES kasir(id),
    FOREIGN KEY (shift_id) REFERENCES shift_kasir(id)
  )`,

  `CREATE TABLE IF NOT EXISTS setoran (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kode_setoran TEXT NOT NULL UNIQUE COLLATE NOCASE,
    shift_id INTEGER NOT NULL,
    kasir_id INTEGER NOT NULL,
    nominal_awal INTEGER NOT NULL CHECK (nominal_awal >= 0),
    saldo_tersisa INTEGER NOT NULL CHECK (saldo_tersisa >= 0 AND saldo_tersisa <= nominal_awal),
    dibuat_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'AKTIF',
    FOREIGN KEY (shift_id) REFERENCES shift_kasir(id),
    FOREIGN KEY (kasir_id) REFERENCES kasir(id)
  )`,

  `CREATE TABLE IF NOT EXISTS nomor_transaksi_sequence (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dibuat_at TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS tarik_tunai (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    transaksi_id INTEGER NOT NULL UNIQUE,
    nomor_transaksi TEXT NOT NULL UNIQUE,
    setoran_id INTEGER NOT NULL,
    kode_setoran TEXT NOT NULL,
    kasir_id INTEGER NOT NULL,
    shift_id INTEGER NOT NULL,
    nominal INTEGER NOT NULL CHECK (nominal > 0),
    tanggal TEXT NOT NULL,
    jam TEXT NOT NULL,
    referensi_qris TEXT NOT NULL DEFAULT '',
    dibuat_at TEXT NOT NULL,
    saldo_setelah INTEGER NOT NULL CHECK (saldo_setelah >= 0),
    FOREIGN KEY (transaksi_id) REFERENCES transaksi(id) ON DELETE RESTRICT,
    FOREIGN KEY (setoran_id) REFERENCES setoran(id) ON DELETE RESTRICT,
    FOREIGN KEY (kasir_id) REFERENCES kasir(id),
    FOREIGN KEY (shift_id) REFERENCES shift_kasir(id)
  )`,
];

// Tabel tambahan dari admin-server.js
const adminCreateTables = [
  `CREATE TABLE IF NOT EXISTS pembelian (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nomor_pembelian TEXT NOT NULL UNIQUE,
    supplier TEXT NOT NULL,
    total INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    kategori_target TEXT,
    status TEXT NOT NULL DEFAULT 'PENDING',
    no_po TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS detail_pembelian (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pembelian_id INTEGER NOT NULL,
    id_barang TEXT NOT NULL,
    nama_barang TEXT NOT NULL,
    qty INTEGER NOT NULL,
    harga_beli INTEGER NOT NULL,
    subtotal INTEGER NOT NULL,
    FOREIGN KEY (pembelian_id) REFERENCES pembelian(id) ON DELETE CASCADE
  )`,
];

// Tambahan kolom dari admin-server.js
const adminMigrations = [
  {
    name: "shift_kasir → status_bank",
    run: () => runSQL(`ALTER TABLE shift_kasir ADD COLUMN status_bank TEXT DEFAULT 'PENDING'`),
    onDuplicate: true,
  },
  {
    name: "shift_kasir → deposited_at",
    run: () => runSQL(`ALTER TABLE shift_kasir ADD COLUMN deposited_at TEXT DEFAULT NULL`),
    onDuplicate: true,
  },
  {
    name: "shift_kasir → deposited_by",
    run: () => runSQL(`ALTER TABLE shift_kasir ADD COLUMN deposited_by TEXT DEFAULT NULL`),
    onDuplicate: true,
  },
];

// ─────────────────────────────────────────────────────────────
// Main migration runner
// ─────────────────────────────────────────────────────────────

async function runMigrations() {
  console.log(`\n=== Migration untuk ${DB_PATH} ===`);
  console.log(`Mode: ${DRY_RUN ? "DRY-RUN (tidak mengubah DB)" : "PRODUCTION"}\n`);

  // 1. Buat tabel yang belum ada
  console.log("──[1] Memastikan tabel utama ada──");
  for (const sql of [...createTables, ...adminCreateTables]) {
    const tableNameMatch = sql.match(/CREATE TABLE IF NOT EXISTS (\w+)/);
    const tableName = tableNameMatch ? tableNameMatch[1] : "unknown";
    try {
      await runSQL(sql);
      console.log(`  ✓ Tabel "${tableName}" siap`);
    } catch (err) {
      console.error(`  ✗ Gagal membuat tabel "${tableName}": ${err.message}`);
    }
  }

  // 2. Jalankan ALTER TABLE untuk semua kolom tambahan
  console.log("\n──[2] Menambahkan kolom yang belum ada──");
  const allMigrations = [...migrations, ...adminMigrations];
  let added = 0, skipped = 0, failed = 0;

  for (const m of allMigrations) {
    try {
      const exists = await columnExists(
        m.tableName || m.name.split("→")[0].trim().split(" ")[0],
        m.name.split("→")[1]?.trim().split(" ")[0] || m.name
      );
      // Cek lebih sederhana: coba jalankan, tangkap duplicate
      await m.run();
      console.log(`  ✓ ${m.name}`);
      added++;
    } catch (err) {
      if (m.onDuplicate && err.message.includes("duplicate column name")) {
        console.log(`  - ${m.name} (sudah ada)`);
        skipped++;
      } else {
        console.error(`  ✗ ${m.name}: ${err.message}`);
        failed++;
      }
    }
  }

  // 3. Verifikasi akhir
  console.log("\n──[3] Verifikasi──");
  const tables = await getTableList();
  tables.forEach((t) => console.log(`  • ${t}`));

  // Cek shift_kasir secara khusus
  const shiftCols = await getColumnList("shift_kasir");
  const expectedCols = [
    "id", "kasir_id", "buka_at", "tutup_at", "saldo_awal", "uang_laci",
    "saldo_kwh_awal", "saldo_kwh_dalam_awal", "saldo_kwh_luar_awal",
    "saldo_kwh_dalam_akhir", "saldo_kwh_luar_akhir", "opening_confirmed",
    "nominal_aktual", "status", "kode_tutup", "pending_close_at",
    "pending_close_snapshot", "status_bank", "deposited_at", "deposited_by",
  ];
  const missing = expectedCols.filter((c) => !shiftCols.includes(c));
  if (missing.length > 0) {
    console.error(`  ✗ shift_kasir masih kurang: ${missing.join(", ")}`);
  } else {
    console.log(`  ✓ shift_kasir lengkap (${shiftCols.length} kolom)`);
  }

  console.log(`\n── Ringkasan ──`);
  console.log(`  Ditambahkan : ${added}`);
  console.log(`  Dilewati    : ${skipped}`);
  console.log(`  Gagal       : ${failed}`);
  console.log(`  Total tabel : ${tables.length}\n`);

  db.close();
}

async function getTableList() {
  return new Promise((resolve) => {
    db.all("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name", [], (err, rows) => {
      if (err) resolve([]);
      else resolve(rows.map((r) => r.name));
    });
  });
}

async function getColumnList(tableName) {
  return new Promise((resolve) => {
    db.all(`PRAGMA table_info(${tableName})`, [], (err, rows) => {
      if (err) resolve([]);
      else resolve(rows.map((r) => r.name));
    });
  });
}

// ─────────────────────────────────────────────────────────────
// Run
// ─────────────────────────────────────────────────────────────
runMigrations().catch((err) => {
  console.error("Fatal:", err);
  db.close();
  process.exit(1);
});
