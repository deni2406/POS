const https = require("https");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const config = require("./config");
const sqlite3 = require("sqlite3").verbose();
const stockOpnameLocal = require("./stock-opname-local");
const { respondLocalCatalogSync } = require("./catalog-local");
const { selectLocalMemberPrice } = require("./harga-member-local");
const MEMBER_SCHEDULE = require("./member-schedule");
const stockOpnameSchema = require("./stock-opname-schema");
const { callLegacyStockOpnameGas, localConflictResponse } = require("./stock-opname-legacy");
const { getShadowDatabasePath } = require("./pbms-shadow/database-config");
const { isShadowCatalogEnabled } = require("./pbms-shadow/feature-config");
const { listBarang: listShadowBarang } = require("./pbms-shadow/catalog-repository");
const {
  createTarikTunai,
  generateNomorTransaksi: allocateNomorTransaksi,
  getSetoranByCode,
  summarizeTransactions
} = require("./tarik-tunai");
const {
  closeTableSession,
  recordTransaction,
  resolvePaymentAmounts
} = require("./transaction-flow");

// ==================================================
// NOMINAL PARSER
// ==================================================
function parseNominal(value) {
  if (value === null || value === undefined || value === "") return 0;

  if (typeof value === "number") {
    if (!Number.isFinite(value)) return 0;
    return Math.round(value);
  }

  const normalized = String(value)
    .trim()
    .replace(/\./g, "")
    .replace(/,/g, "");

  if (!normalized) return 0;

  const numberValue = Number(normalized);
  return Number.isFinite(numberValue) ? Math.round(numberValue) : 0;
}

function kwhScaledToDecimal(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("Nilai KWh skala-100 harus berupa integer aman non-negatif.");
  }

  return value / 100;
}

function kwhDecimalToScaled(value) {
  if (typeof value !== "string" && typeof value !== "number") {
    throw new TypeError("Nilai KWh harus berupa string atau angka desimal.");
  }
  if (typeof value === "number" && (!Number.isFinite(value) || value < 0)) {
    throw new RangeError("Nilai KWh harus finite dan non-negatif.");
  }

  const input = String(value).trim();
  const match = input.match(/^(\d+)(?:[.,](\d{1,2}))?$/);
  if (!match) {
    throw new RangeError("Nilai KWh harus non-negatif dengan maksimal 2 angka desimal.");
  }

  const scaled = BigInt(match[1]) * 100n + BigInt((match[2] || "").padEnd(2, "0") || "0");
  if (scaled > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError("Nilai KWh skala-100 melebihi batas integer aman.");
  }

  return Number(scaled);
}

const { verify } = require("otplib");
const { lampSet, lampOn, lampOff, lampBlink15Minute } = require('./lamp-controlle/lamp-controller');

const db = new sqlite3.Database(
  path.join(__dirname, "pos.db")
);
db.configure("busyTimeout", 5000);

let shadowCatalogDb;
function getShadowCatalogDatabase() {
  if (!shadowCatalogDb) {
    shadowCatalogDb = new sqlite3.Database(
      getShadowDatabasePath(process.env.PBMS_SHADOW_DB || undefined)
    );
    shadowCatalogDb.configure("busyTimeout", 5000);
  }
  return shadowCatalogDb;
}

db.run("PRAGMA foreign_keys = ON");

const activeShiftWrites = new Map();
const reservedClosePreviews = new Set();

function reserveShiftWrite(shiftId, res) {
  if (reservedClosePreviews.has(shiftId)) return false;
  activeShiftWrites.set(shiftId, (activeShiftWrites.get(shiftId) || 0) + 1);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    const count = (activeShiftWrites.get(shiftId) || 1) - 1;
    if (count > 0) activeShiftWrites.set(shiftId, count);
    else activeShiftWrites.delete(shiftId);
  };
  res.once("finish", release);
  return true;
}

function reserveShiftClosePreview(shiftId, res) {
  if (reservedClosePreviews.has(shiftId) || (activeShiftWrites.get(shiftId) || 0) > 0) return false;
  reservedClosePreviews.add(shiftId);
  const release = () => reservedClosePreviews.delete(shiftId);
  res.once("finish", release);
  return true;
}


// ==================================================
// LOGGER
// ==================================================

function writeLog(level, event, message, data = null) {
  const waktu = new Date().toISOString();

  const detail =
    data === null
      ? null
      : JSON.stringify(data);

  console.log(
    `[${waktu}] [${level}] [${event}] ${message}`,
    data || ""
  );

  db.run(
    `
    INSERT INTO log
    (
      waktu,
      level,
      event,
      message,
      data
    )
    VALUES (?, ?, ?, ?, ?)
    `,
    [
      waktu,
      level,
      event,
      message,
      detail
    ],
    error => {
      if (error) {
        console.log(
          "GAGAL MENYIMPAN LOG:",
          error.message
        );
      }
    }
  );
}


// ==================================================
// DATABASE SETUP & MIGRATIONS
// ==================================================

db.serialize(() => {

  db.run(`
    CREATE TABLE IF NOT EXISTS kasir (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      pin TEXT NOT NULL,
      nama TEXT NOT NULL,
      aktif INTEGER NOT NULL DEFAULT 1
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS shift_kasir (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kasir_id INTEGER NOT NULL,
      buka_at TEXT NOT NULL,
      tutup_at TEXT,
      saldo_awal INTEGER NOT NULL DEFAULT 0,
      uang_laci INTEGER NOT NULL DEFAULT 0,
      saldo_kwh_awal INTEGER NOT NULL DEFAULT 0,
      saldo_kwh_dalam_awal INTEGER NOT NULL DEFAULT 0,
      saldo_kwh_luar_awal INTEGER NOT NULL DEFAULT 0,
      saldo_kwh_dalam_akhir INTEGER NOT NULL DEFAULT 0,
      saldo_kwh_luar_akhir INTEGER NOT NULL DEFAULT 0,
      opening_confirmed INTEGER NOT NULL DEFAULT 0,
      nominal_aktual INTEGER,
      status TEXT NOT NULL DEFAULT 'OPEN',
      kode_tutup TEXT,
      FOREIGN KEY (kasir_id)
      REFERENCES kasir(id)
    )
  `);

  db.run(`CREATE TABLE IF NOT EXISTS kas_masuk (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    shift_id INTEGER NOT NULL,
    kasir_id INTEGER NOT NULL,
    waktu TEXT NOT NULL,
    nominal INTEGER NOT NULL CHECK (nominal >= 0),
    keterangan TEXT NOT NULL DEFAULT '',
    sumber TEXT NOT NULL DEFAULT '',
    FOREIGN KEY (shift_id) REFERENCES shift_kasir(id),
    FOREIGN KEY (kasir_id) REFERENCES kasir(id)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS kas_keluar (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    shift_id INTEGER NOT NULL,
    kasir_id INTEGER NOT NULL,
    waktu TEXT NOT NULL,
    nominal INTEGER NOT NULL CHECK (nominal >= 0),
    keterangan TEXT NOT NULL DEFAULT '',
    FOREIGN KEY (shift_id) REFERENCES shift_kasir(id),
    FOREIGN KEY (kasir_id) REFERENCES kasir(id)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS kas_laci_config (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    saldo_awal INTEGER NOT NULL CHECK (typeof(saldo_awal) = 'integer' AND saldo_awal = 110000),
    sumber_shift_id INTEGER NOT NULL CHECK (sumber_shift_id = 160),
    diinisialisasi_at TEXT NOT NULL,
    terkunci INTEGER NOT NULL CHECK (terkunci = 1)
  )`);

  db.run(`CREATE TRIGGER IF NOT EXISTS trg_kas_laci_config_no_update
    BEFORE UPDATE ON kas_laci_config
    BEGIN
      SELECT RAISE(ABORT, 'KAS_LACI_INITIAL_BALANCE_LOCKED');
    END`);

  db.run(`CREATE TRIGGER IF NOT EXISTS trg_kas_laci_config_no_delete
    BEFORE DELETE ON kas_laci_config
    BEGIN
      SELECT RAISE(ABORT, 'KAS_LACI_INITIAL_BALANCE_LOCKED');
    END`);

  db.run(`INSERT OR IGNORE INTO kas_laci_config
    (id, saldo_awal, sumber_shift_id, diinisialisasi_at, terkunci)
    SELECT 1, uang_laci, id, datetime('now'), 1
    FROM shift_kasir
    WHERE id = 160 AND status = 'CLOSED' AND uang_laci = 110000`);

  db.run(`CREATE TABLE IF NOT EXISTS kas_laci_transaksi (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    transaction_id TEXT NOT NULL UNIQUE,
    jenis TEXT NOT NULL CHECK (jenis IN ('UANG_MASUK', 'UANG_KELUAR')),
    nominal INTEGER NOT NULL CHECK (typeof(nominal) = 'integer' AND nominal > 0),
    keterangan TEXT NOT NULL DEFAULT '',
    kasir_id INTEGER NOT NULL,
    kasir TEXT NOT NULL,
    waktu TEXT NOT NULL,
    CHECK (
      (jenis = 'UANG_MASUK' AND transaction_id GLOB 'KLM[0-9][0-9][0-9][0-9]*' AND substr(transaction_id, 4) NOT GLOB '*[^0-9]*' AND CAST(substr(transaction_id, 4) AS INTEGER) > 0) OR
      (jenis = 'UANG_KELUAR' AND transaction_id GLOB 'KLK[0-9][0-9][0-9][0-9]*' AND substr(transaction_id, 4) NOT GLOB '*[^0-9]*' AND CAST(substr(transaction_id, 4) AS INTEGER) > 0)
    )
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS rekonsiliasi_kasir (
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
  )`);

  db.run(
    `
    ALTER TABLE shift_kasir
    ADD COLUMN uang_laci INTEGER NOT NULL DEFAULT 0
    `,
    error => {
      if (error && !/^(?:SQLITE_ERROR: )?duplicate column name: uang_laci$/.test(error.message)) {
        writeLog("ERROR", "DATABASE", "Gagal menambahkan uang_laci pada shift_kasir", { error: error.message });
      }
    }
  );

  db.run(
    `
    ALTER TABLE shift_kasir
    ADD COLUMN saldo_kwh_awal INTEGER NOT NULL DEFAULT 0
    `,
    error => {
      if (error && !error.message.includes("duplicate column name")) {
        writeLog("ERROR", "DATABASE", "Gagal menambahkan saldo_kwh_awal pada shift_kasir", { error: error.message });
      }
    }
  );

  db.run(
    `
    ALTER TABLE shift_kasir
    ADD COLUMN saldo_kwh_dalam_awal INTEGER NOT NULL DEFAULT 0
    `,
    error => {
      if (error && !error.message.includes("duplicate column name")) {
        writeLog("ERROR", "DATABASE", "Gagal menambahkan saldo_kwh_dalam_awal pada shift_kasir", { error: error.message });
      }
    }
  );

  db.run(
    `
    ALTER TABLE shift_kasir
    ADD COLUMN saldo_kwh_luar_awal INTEGER NOT NULL DEFAULT 0
    `,
    error => {
      if (error && !error.message.includes("duplicate column name")) {
        writeLog("ERROR", "DATABASE", "Gagal menambahkan saldo_kwh_luar_awal pada shift_kasir", { error: error.message });
      }
    }
  );

  db.run(
    `
    ALTER TABLE shift_kasir
    ADD COLUMN saldo_kwh_dalam_akhir INTEGER NOT NULL DEFAULT 0
    `,
    error => {
      if (error && !error.message.includes("duplicate column name")) {
        writeLog("ERROR", "DATABASE", "Gagal menambahkan saldo_kwh_dalam_akhir pada shift_kasir", { error: error.message });
      }
    }
  );

  db.run(
    `
    ALTER TABLE shift_kasir
    ADD COLUMN saldo_kwh_luar_akhir INTEGER NOT NULL DEFAULT 0
    `,
    error => {
      if (error && !error.message.includes("duplicate column name")) {
        writeLog("ERROR", "DATABASE", "Gagal menambahkan saldo_kwh_luar_akhir pada shift_kasir", { error: error.message });
      }
    }
  );

  db.run(
    `ALTER TABLE shift_kasir ADD COLUMN kode_tutup TEXT`,
    error => {
      if (error && !/^(?:SQLITE_ERROR: )?duplicate column name: kode_tutup$/i.test(error.message)) {
        writeLog("ERROR", "DATABASE", "Gagal menambahkan kode_tutup pada shift_kasir", { error: error.message });
      }
    }
  );

  db.run(
    `ALTER TABLE shift_kasir ADD COLUMN pending_close_at TEXT`,
    error => {
      if (error && !/^(?:SQLITE_ERROR: )?duplicate column name: pending_close_at$/i.test(error.message)) {
        writeLog("ERROR", "DATABASE", "Gagal menambahkan pending_close_at pada shift_kasir", { error: error.message });
      }
    }
  );

  db.run(
    `ALTER TABLE shift_kasir ADD COLUMN pending_close_snapshot TEXT`,
    error => {
      if (error && !/^(?:SQLITE_ERROR: )?duplicate column name: pending_close_snapshot$/i.test(error.message)) {
        writeLog("ERROR", "DATABASE", "Gagal menambahkan pending_close_snapshot pada shift_kasir", { error: error.message });
      }
    }
  );

  db.run(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_shift_kasir_kode_tutup_unique ON shift_kasir(kode_tutup) WHERE kode_tutup IS NOT NULL AND kode_tutup <> ''`,
    error => {
      if (error) {
        writeLog("ERROR", "DATABASE", "Gagal membuat unique index kode_tutup", { error: error.message });
      }
    }
  );

  db.run(`
    CREATE TABLE IF NOT EXISTS log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      waktu TEXT NOT NULL,
      level TEXT NOT NULL,
      event TEXT NOT NULL,
      message TEXT NOT NULL,
      data TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS master_barang (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      id_barang TEXT,
      nama TEXT NOT NULL,
      kategori TEXT NOT NULL DEFAULT 'Lainnya',
      hpp INTEGER NOT NULL DEFAULT 0,
      harga_jual INTEGER NOT NULL DEFAULT 0,
      stok_aktual INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    )
  `);

  db.run(
    `
    ALTER TABLE master_barang
    ADD COLUMN kategori TEXT NOT NULL DEFAULT 'Lainnya'
    `,
    error => {
      if (error && !error.message.includes("duplicate column name")) {
        writeLog("ERROR", "DATABASE", "Gagal menambahkan kategori pada master_barang", { error: error.message });
      }
    }
  );

  db.run(
    `
    ALTER TABLE master_barang
    ADD COLUMN stok_aktual INTEGER NOT NULL DEFAULT 0
    `,
    error => {
      if (error && !error.message.includes("duplicate column name")) {
        writeLog("ERROR", "DATABASE", "Gagal menambahkan stok_aktual pada master_barang", { error: error.message });
      }
    }
  );

  db.run(`
    CREATE TABLE IF NOT EXISTS transaksi (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nomor_transaksi TEXT NOT NULL,
      tanggal TEXT NOT NULL,
      jam TEXT NOT NULL,
      kasir TEXT NOT NULL,
      total INTEGER NOT NULL,
      metode_pembayaran TEXT NOT NULL,
      status_sync TEXT NOT NULL DEFAULT 'PENDING',
      sync_at TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS detail_transaksi (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      transaksi_id INTEGER NOT NULL,
      nama_barang TEXT NOT NULL,
      qty INTEGER NOT NULL,
      harga_jual INTEGER NOT NULL,
      hpp INTEGER NOT NULL,
      subtotal INTEGER NOT NULL,
      FOREIGN KEY (transaksi_id) REFERENCES transaksi(id) ON DELETE CASCADE
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS setoran (
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
    )
  `);

  // Migrasi otomatis: constraint lama nominal_awal > 0 menolak Tutup Kasir
  // dengan totalCash = 0 (SQLITE_CONSTRAINT). Rebuild tabel dengan >= 0 bila masih memakai skema lama.
  // FK dimatikan sementara karena tarik_tunai mereferensikan setoran(id) ON DELETE RESTRICT;
  // DROP TABLE setoran melakukan DELETE implisit yang akan gagal bila FK aktif.
  db.get(
    `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'setoran'`,
    [],
    (masterError, masterRow) => {
      if (masterError || !masterRow) return;
      if (!/nominal_awal\s*>\s*0/.test(String(masterRow.sql || ""))) return;
      writeLog("INFO", "DATABASE", "Migrasi setoran: constraint lama nominal_awal > 0 terdeteksi, rebuild dengan >= 0");
      db.serialize(() => {
        db.run(`PRAGMA foreign_keys = OFF`);
        db.run(
          `CREATE TABLE setoran_new (
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
          createNewError => {
            if (createNewError) {
              writeLog("ERROR", "DATABASE", "Gagal membuat setoran_new saat migrasi constraint", { error: createNewError.message });
              db.run(`PRAGMA foreign_keys = ON`);
              return;
            }
            db.run(`INSERT INTO setoran_new SELECT * FROM setoran`, copyError => {
              if (copyError) {
                writeLog("ERROR", "DATABASE", "Gagal menyalin data setoran ke setoran_new saat migrasi", { error: copyError.message });
                db.run(`DROP TABLE IF EXISTS setoran_new`);
                db.run(`PRAGMA foreign_keys = ON`);
                return;
              }
              db.run(`DROP TABLE setoran`, dropError => {
                if (dropError) {
                  writeLog("ERROR", "DATABASE", "Gagal drop tabel setoran lama saat migrasi", { error: dropError.message });
                  db.run(`DROP TABLE IF EXISTS setoran_new`);
                  db.run(`PRAGMA foreign_keys = ON`);
                  return;
                }
                db.run(`ALTER TABLE setoran_new RENAME TO setoran`, renameError => {
                  db.run(`PRAGMA foreign_keys = ON`);
                  if (renameError) {
                    writeLog("ERROR", "DATABASE", "Gagal rename setoran_new menjadi setoran saat migrasi", { error: renameError.message });
                    return;
                  }
                  writeLog("INFO", "DATABASE", "Migrasi constraint setoran nominal_awal selesai");
                });
              });
            });
          }
        );
      });
    }
  );

  db.run(`
    CREATE TABLE IF NOT EXISTS nomor_transaksi_sequence (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dibuat_at TEXT NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS tarik_tunai (
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
    )
  `);

  const txMigrations = [
    "ALTER TABLE transaksi ADD COLUMN shift_id INTEGER",
    "ALTER TABLE transaksi ADD COLUMN bayar INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE transaksi ADD COLUMN kembalian INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE transaksi ADD COLUMN cash_amount INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE transaksi ADD COLUMN qris_amount INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE transaksi ADD COLUMN nomor_meja INTEGER",
    "ALTER TABLE transaksi ADD COLUMN session_id TEXT",
    "ALTER TABLE transaksi ADD COLUMN tipe_transaksi TEXT NOT NULL DEFAULT 'PENJUALAN'"
  ];

  txMigrations.forEach(migration => {
    db.run(migration, error => {
      if (error && !error.message.includes("duplicate column name")) {
        writeLog("ERROR", "DATABASE", `Gagal menjalankan migration: ${migration}`, { error: error.message });
      }
    });

    db.run(`
      CREATE TRIGGER IF NOT EXISTS trg_transaksi_tarik_tunai_immutable
      BEFORE UPDATE OF status_sync ON transaksi
      WHEN EXISTS (SELECT 1 FROM tarik_tunai WHERE transaksi_id = OLD.id)
        AND NEW.status_sync IN ('BATAL', 'CANCELLED')
      BEGIN
        SELECT RAISE(ABORT, 'TARIK_TUNAI_CANNOT_BE_CANCELLED');
      END
    `, error => {
      if (error) writeLog("ERROR", "DATABASE", "Gagal membuat pengaman transaksi Tarik Tunai", { error: error.message });
    });

    db.run(`
      CREATE TRIGGER IF NOT EXISTS trg_transaksi_require_open_shift
      BEFORE INSERT ON transaksi
      WHEN NEW.shift_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM shift_kasir WHERE id = NEW.shift_id AND status = 'OPEN')
      BEGIN
        SELECT RAISE(ABORT, 'SHIFT_NOT_OPEN');
      END
    `, error => {
      if (error) writeLog("ERROR", "DATABASE", "Gagal membuat pengaman transaksi untuk shift pending", { error: error.message });
    });

    db.run(`
      CREATE TRIGGER IF NOT EXISTS trg_transaksi_cancel_require_open_shift
      BEFORE UPDATE OF status_sync ON transaksi
      WHEN NEW.status_sync IN ('BATAL', 'CANCELLED')
        AND EXISTS (SELECT 1 FROM shift_kasir WHERE id = OLD.shift_id AND status != 'OPEN')
      BEGIN
        SELECT RAISE(ABORT, 'SHIFT_NOT_OPEN');
      END
    `, error => {
      if (error) writeLog("ERROR", "DATABASE", "Gagal membuat pengaman pembatalan transaksi untuk shift pending", { error: error.message });
    });
  });

  db.run(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_transaksi_session_id ON transaksi(session_id) WHERE session_id IS NOT NULL`,
    error => {
      if (error) {
        writeLog("ERROR", "DATABASE", "Gagal membuat index idx_transaksi_session_id", { error: error.message });
      }
    }
  );

  const daftarKasir = ["Faisal", "Ryan", "Fitri", "Nada", "Septi", "Deni"];
  daftarKasir.forEach(nama => {
    const username = nama.toLowerCase();
    db.get(`SELECT id FROM kasir WHERE nama = ? OR username = ?`, [nama, username], (err, row) => {
      if (err) {
        writeLog("ERROR", "DATABASE", `Gagal memeriksa kasir ${nama}`, { error: err.message });
      } else if (!row) {
        db.run(
          `INSERT INTO kasir (username, pin, nama, aktif) VALUES (?, ?, ?, 1)`,
          [username, "123456", nama],
          insertErr => {
            if (insertErr) {
              writeLog("ERROR", "DATABASE", `Gagal menambahkan kasir ${nama}`, { error: insertErr.message });
            } else {
              writeLog("INFO", "DATABASE", `Kasir ${nama} berhasil ditambahkan`);
            }
          }
        );
      } else {
        db.run(
          `UPDATE kasir SET aktif = 1 WHERE id = ?`,
          [row.id],
          updateErr => {
            if (updateErr) {
              writeLog("ERROR", "DATABASE", `Gagal memperbarui status aktif kasir ${nama}`, { error: updateErr.message });
            }
          }
        );
      }
    });
  });

  db.run(`
    CREATE TABLE IF NOT EXISTS sesi_meja (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT UNIQUE NOT NULL,
      nomor_meja INTEGER NOT NULL,
      nama_pemesan TEXT NOT NULL,
      kasir TEXT NOT NULL,
      waktu_mulai TEXT NOT NULL,
      waktu_selesai TEXT,
      status TEXT NOT NULL DEFAULT 'AKTIF'
    )
  `);

  db.run(
    `
    ALTER TABLE sesi_meja
    ADD COLUMN durasi_jam INTEGER
    `,
    error => {
      if (error && !error.message.includes("duplicate column name")) {
        writeLog("ERROR", "DATABASE", "Gagal menambahkan durasi_jam pada sesi_meja", { error: error.message });
      }
    }
  );

  db.run(
    `
    ALTER TABLE sesi_meja
    ADD COLUMN waktu_selesai TEXT
    `,
    error => {
      if (error && !error.message.includes("duplicate column name")) {
        writeLog("ERROR", "DATABASE", "Gagal menambahkan waktu_selesai pada sesi_meja", { error: error.message });
      }
    }
  );

  db.run(
    `
    ALTER TABLE sesi_meja
    ADD COLUMN jenis_sesi TEXT NOT NULL DEFAULT 'NORMAL'
    `,
    error => {
      if (error && !error.message.includes("duplicate column name")) {
        writeLog("ERROR", "DATABASE", "Gagal menambahkan jenis_sesi pada sesi_meja", { error: error.message });
      }
    }
  );

  db.run(
    `
    ALTER TABLE sesi_meja
    ADD COLUMN member_id TEXT
    `,
    error => {
      if (error && !error.message.includes("duplicate column name")) {
        writeLog("ERROR", "DATABASE", "Gagal menambahkan member_id pada sesi_meja", { error: error.message });
      }
    }
  );

  db.run(
    `
    ALTER TABLE sesi_meja
    ADD COLUMN kategori_member TEXT
    `,
    error => {
      if (error && !error.message.includes("duplicate column name")) {
        writeLog("ERROR", "DATABASE", "Gagal menambahkan kategori_member pada sesi_meja", { error: error.message });
      }
    }
  );

  db.run(`
    CREATE TABLE IF NOT EXISTS pesanan_meja (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      nama_barang TEXT NOT NULL,
      qty INTEGER NOT NULL,
      harga_jual INTEGER NOT NULL,
      hpp INTEGER NOT NULL,
      subtotal INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sesi_meja(session_id) ON DELETE CASCADE
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS cart_draft (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kasir_id INTEGER NOT NULL,
      nama_barang TEXT NOT NULL,
      qty INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS waiting_list (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nama_customer TEXT NOT NULL,
      no_wa TEXT,
      tanggal_booking TEXT NOT NULL,
      jam_booking TEXT NOT NULL,
      jumlah_orang INTEGER NOT NULL DEFAULT 0,
      nomor_meja INTEGER,
      status TEXT NOT NULL DEFAULT 'WAITING',
      catatan TEXT,
      pesanan_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS member_kategori (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nama TEXT UNIQUE NOT NULL,
      aktif INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  db.run(`
    INSERT OR IGNORE INTO member_kategori (nama, aktif, created_at, updated_at)
    VALUES ('PELAJAR', 1, datetime('now'), datetime('now'))
  `);

  db.run(`
    INSERT OR IGNORE INTO member_kategori (nama, aktif, created_at, updated_at)
    VALUES ('UMUM', 1, datetime('now'), datetime('now'))
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS member (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kode_member TEXT UNIQUE NOT NULL,
      nama TEXT NOT NULL,
      alamat TEXT,
      nomor_hp TEXT,
      tanggal_lahir TEXT,
      kategori_id INTEGER,
      nama_sekolah TEXT,
      nisn TEXT,
      tanggal_daftar TEXT,
      tanggal_aktif TEXT,
      last_used_at TEXT,
      status TEXT NOT NULL DEFAULT 'MENUNGGU_AKTIF',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (kategori_id)
      REFERENCES member_kategori(id)
    )
  `, () => {
    db.all(`SELECT nomor_hp, COUNT(*) as cnt FROM member WHERE nomor_hp IS NOT NULL AND nomor_hp != '' GROUP BY nomor_hp HAVING cnt > 1`, [], (err, rows) => {
      if (err) {
        writeLog("ERROR", "DATABASE", "Gagal memeriksa duplikasi nomor_hp", { error: err.message });
      } else if (rows && rows.length > 0) {
        writeLog("WARN", "MEMBER", "[MEMBER] Ditemukan data duplikat nomor HP", { rows });
      } else {
        db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_member_nomor_hp_unique ON member(nomor_hp)`, (idxErr) => {
          if (idxErr) {
            writeLog("ERROR", "DATABASE", "Gagal membuat unique index nomor_hp", { error: idxErr.message });
          }
        });
      }
    });

    db.all(`SELECT nisn, COUNT(*) as cnt FROM member WHERE nisn IS NOT NULL AND nisn != '' GROUP BY nisn HAVING cnt > 1`, [], (err, rows) => {
      if (err) {
        writeLog("ERROR", "DATABASE", "Gagal memeriksa duplikasi nisn", { error: err.message });
      } else if (rows && rows.length > 0) {
        writeLog("WARN", "MEMBER", "[MEMBER] Ditemukan data duplikat NISN", { rows });
      } else {
        db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_member_nisn_unique ON member(nisn)`, (idxErr) => {
          if (idxErr) {
            writeLog("ERROR", "DATABASE", "Gagal membuat unique index nisn", { error: idxErr.message });
          }
        });
      }
    });
  });

  db.run(`
    CREATE TABLE IF NOT EXISTS member_cache (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      member_id INTEGER UNIQUE,
      kode_member TEXT,
      nama TEXT,
      alamat TEXT,
      nomor_hp TEXT,
      tanggal_lahir TEXT,
      kategori_id TEXT,
      kategori TEXT,
      nama_sekolah TEXT,
      nisn TEXT,
      tanggal_daftar TEXT,
      tanggal_aktif TEXT,
      last_used_at TEXT,
      status TEXT,
      total_kunjungan INTEGER DEFAULT 0,
      total_pengeluaran REAL DEFAULT 0,
      updated_at TEXT NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS harga_member_cache (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kategori TEXT NOT NULL,
      jam TEXT NOT NULL,
      jam_selesai TEXT,
      durasi_jam INTEGER NOT NULL,
      harga_per_jam REAL NOT NULL,
      total REAL NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(kategori, jam, durasi_jam)
    )
  `);

  db.run(
    `
    ALTER TABLE harga_member_cache
    ADD COLUMN jam_selesai TEXT
    `,
    error => {
      if (error && !error.message.includes("duplicate column name")) {
        writeLog("ERROR", "DATABASE", "Gagal menambahkan jam_selesai pada harga_member_cache", { error: error.message });
      }
    }
  );

  db.run(`
    CREATE TABLE IF NOT EXISTS totp_used_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token_hash TEXT NOT NULL UNIQUE,
      used_at TEXT NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS lamp_alarm_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      table_number INTEGER NOT NULL,
      command TEXT NOT NULL CHECK(command IN ('ON','OFF')),
      failure_count INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL CHECK(status IN ('ACTIVE','CLEARED')),
      error_message TEXT,
      error_category TEXT,
      error_meaning TEXT,
      troubleshooting TEXT,
      started_at TEXT NOT NULL,
      last_failed_at TEXT,
      cleared_at TEXT
    )
  `);

  db.run(`DELETE FROM cart_draft`, error => {
    if (error) {
      writeLog(
        "ERROR",
        "CART_DRAFT_STARTUP_CLEAR_ERROR",
        "Gagal menghapus cart draft saat server start",
        { error: error.message }
      );
    } else {
      writeLog(
        "INFO",
        "CART_DRAFT_STARTUP_CLEARED",
        "Cart draft lama dibersihkan saat server start"
      );
    }
  });

});

// Wait for SQLite's serialized startup queue, then apply and verify the Kas Laci
// migration before accepting requests. This runs after all startup DDL above.
const databaseInitialization = new Promise((resolve, reject) => {
  let stockOpnameReady = false;
  let kasLaciReady = false;
  const markReady = () => {
    if (stockOpnameReady && kasLaciReady) resolve();
  };
  db.serialize(() => {
    db.get("SELECT 1", error => {
      if (error) return reject(error);
      stockOpnameSchema.migrateStockOpnameSchema(db).then(() => {
        stockOpnameReady = true;
        markReady();
      }, reject);
      db.all("PRAGMA table_info(kas_laci_transaksi)", (schemaError, columns) => {
        if (schemaError) return reject(schemaError);
        const hasKodeSetoran = (columns || []).some(column => column.name === "kode_setoran");
        const verifySchema = () => {
          db.all("PRAGMA table_info(kas_laci_transaksi)", (verifyError, verifiedColumns) => {
            if (verifyError) return reject(verifyError);
            if (!(verifiedColumns || []).some(column => column.name === "kode_setoran")) {
              return reject(new Error("Schema kas_laci_transaksi.kode_setoran tidak tersedia setelah migrasi"));
            }
            kasLaciReady = true;
            markReady();
          });
        };
        if (hasKodeSetoran) return verifySchema();
        db.run("ALTER TABLE kas_laci_transaksi ADD COLUMN kode_setoran TEXT NOT NULL DEFAULT ''", migrationError => {
          if (migrationError) return reject(migrationError);
          verifySchema();
        });
      });
    });
  });
});


// ==================================================
// UTILITY & HELPER PROMISES
// ==================================================

function getJsonBody(req, maxSize = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let body = "";
    let bodySize = 0;
    req.on("data", chunk => {
      bodySize += chunk.length;
      if (bodySize > maxSize) {
        reject(new Error("Request body terlalu besar"));
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"));
      } catch (error) {
        reject(new Error("JSON tidak valid"));
      }
    });
    req.on("error", reject);
  });
}

function generateNomorTransaksi(now = new Date()) {
  return allocateNomorTransaksi(db, now);
}

function runAsync(query, params = []) {
  return new Promise((resolve, reject) => {
    db.run(query, params, function(err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

async function createTarikTunaiWithIsolatedConnection(data) {
  await new Promise((resolve, reject) => {
    db.get(
      `SELECT
         (SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name IN ('setoran', 'tarik_tunai', 'nomor_transaksi_sequence')) AS table_count,
         (SELECT COUNT(*) FROM pragma_table_info('transaksi') WHERE name = 'tipe_transaksi') AS type_column_count`,
      [],
      (error, row) => {
        if (error) return reject(error);
        if (!row || Number(row.table_count) !== 3 || Number(row.type_column_count) !== 1) {
          return reject(new Error("Skema Tarik Tunai belum siap."));
        }
        resolve();
      }
    );
  });

  const transactionDb = await new Promise((resolve, reject) => {
    const connection = new sqlite3.Database(path.join(__dirname, "pos.db"), error => {
      if (error) reject(error);
      else resolve(connection);
    });
  });
  transactionDb.configure("busyTimeout", 5000);

  let result;
  let operationError;
  try {
    await new Promise((resolve, reject) => {
      transactionDb.run("PRAGMA foreign_keys = ON", error => error ? reject(error) : resolve());
    });
    result = await createTarikTunai(transactionDb, data);
  } catch (error) {
    operationError = error;
  }

  await new Promise(resolve => {
    transactionDb.close(error => {
      if (error) writeLog("ERROR", "TARIK_TUNAI_DB_CLOSE", "Gagal menutup koneksi transaksi Tarik Tunai", { error: error.message });
      resolve();
    });
  });
  if (operationError) throw operationError;
  return result;
}

async function enforceLampAlarmHistoryRetention() {
  const row = await new Promise((resolve, reject) => {
    db.get(`SELECT COUNT(*) AS count FROM lamp_alarm_history`, [], (err, result) => {
      if (err) reject(err);
      else resolve(result);
    });
  });
  const count = Number(row && row.count) || 0;
  if (count >= 40) {
    await runAsync(
      `DELETE FROM lamp_alarm_history
       WHERE id IN (
         SELECT id FROM lamp_alarm_history
         ORDER BY started_at ASC, id ASC
         LIMIT ?
       )`,
      [count - 39]
    );
  }
}

async function insertLampAlarmHistoryEvent(event) {
  await enforceLampAlarmHistoryRetention();
  const result = await runAsync(
    `INSERT INTO lamp_alarm_history (
       table_number, command, failure_count, status, error_message,
       error_category, error_meaning, troubleshooting, started_at,
       last_failed_at, cleared_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      event.table_number,
      event.command,
      event.failure_count ?? 0,
      event.status,
      event.error_message ?? null,
      event.error_category ?? null,
      event.error_meaning ?? null,
      event.troubleshooting ?? null,
      event.started_at,
      event.last_failed_at ?? null,
      event.cleared_at ?? null
    ]
  );
  return result.lastID;
}

function classifyLampError(errorMessage) {
  if (
    errorMessage.includes("Opening COM3") ||
    errorMessage.includes("File not found")
  ) {
    return {
      error_category: "COM3_NOT_FOUND",
      error_meaning: "Port COM3 tidak tersedia atau tidak terdeteksi oleh sistem.",
      troubleshooting: "Periksa koneksi controller, Device Manager, dan nomor COM yang digunakan."
    };
  }

  if (
    errorMessage.includes("WriteFileEx") ||
    errorMessage.includes("Unknown error code 22")
  ) {
    return {
      error_category: "COM3_WRITE_ERROR",
      error_meaning: "Pengiriman command ke COM3 gagal.",
      troubleshooting: "Periksa koneksi controller, port COM3, dan kondisi perangkat."
    };
  }

  if (
    errorMessage.includes("GetOverlappedResult") ||
    errorMessage.includes("Operation aborted")
  ) {
    return {
      error_category: "COM3_OPERATION_ABORTED",
      error_meaning: "Operasi serial COM3 dibatalkan atau gagal.",
      troubleshooting: "Periksa koneksi controller dan port COM3."
    };
  }

  return {
    error_category: "UNKNOWN",
    error_meaning: "Terjadi kegagalan komunikasi atau kontrol lampu yang belum teridentifikasi.",
    troubleshooting: "Periksa error teknis asli, koneksi controller, port COM3, dan kondisi perangkat."
  };
}

function findActiveLampAlarmIncident(tableNumber, command, errorCategory) {
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT * FROM lamp_alarm_history
       WHERE table_number = ? AND command = ? AND error_category = ?
         AND status = 'ACTIVE'
       ORDER BY started_at DESC, id DESC LIMIT 1`,
      [tableNumber, command, errorCategory],
      (err, row) => err ? reject(err) : resolve(row || null)
    );
  });
}

function createActiveLampAlarmIncident(event) {
  const now = event.started_at || new Date().toISOString();
  return insertLampAlarmHistoryEvent({
    ...event,
    failure_count: event.failure_count ?? 1,
    status: "ACTIVE",
    started_at: now,
    last_failed_at: event.last_failed_at || now,
    cleared_at: null
  });
}

function updateActiveLampAlarmIncidentFailure(id, lastFailedAt = new Date().toISOString()) {
  return runAsync(
    `UPDATE lamp_alarm_history
     SET failure_count = failure_count + 1, last_failed_at = ?
     WHERE id = ? AND status = 'ACTIVE'`,
    [lastFailedAt, id]
  );
}

function createClearedLampAlarmIncident(id, recoveredAt = new Date().toISOString()) {
  return runAsync(
    `UPDATE lamp_alarm_history
     SET status = 'CLEARED', cleared_at = ?
     WHERE id = ? AND status = 'ACTIVE'`,
    [recoveredAt, id]
  );
}


// ==================================================
// HELPER TOTP MANAGER
// ==================================================

async function verifyManagerTotpOnce(token) {
  if (!config.MANAGER_TOTP_SECRET) {
    return {
      success: false,
      code: "TOTP_CONFIG_ERROR",
      message: "Secret Google Authenticator Manager belum dikonfigurasi"
    };
  }

  const rawToken = String(token || "").trim();
  if (!/^\d{6}$/.test(rawToken)) {
    return {
      success: false,
      code: "TOTP_INVALID",
      message: "Kode Google Authenticator tidak valid."
    };
  }

  const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");

  const existing = await new Promise((resolve, reject) => {
    db.get(
      `SELECT id FROM totp_used_tokens WHERE token_hash = ?`,
      [tokenHash],
      (err, row) => {
        if (err) reject(err);
        else resolve(row);
      }
    );
  });

  if (existing) {
    return {
      success: false,
      code: "TOTP_ALREADY_USED",
      message: "Kode Google Authenticator sudah pernah digunakan."
    };
  }

  let isVerified = false;
  try {
    const verifyResult = await verify({
      secret: config.MANAGER_TOTP_SECRET,
      token: rawToken
    });

    if (typeof verifyResult === "boolean") {
      isVerified = verifyResult;
    } else if (verifyResult && typeof verifyResult === "object") {
      isVerified = Boolean(verifyResult.valid);
    }
  } catch (err) {
    isVerified = false;
  }

  if (!isVerified) {
    return {
      success: false,
      code: "TOTP_INVALID",
      message: "Kode Google Authenticator tidak valid."
    };
  }

  const nowIso = new Date().toISOString();
  try {
    await new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO totp_used_tokens (token_hash, used_at) VALUES (?, ?)`,
        [tokenHash, nowIso],
        function (err) {
          if (err) reject(err);
          else resolve(this);
        }
      );
    });
  } catch (err) {
    if (err.message && (err.message.includes("UNIQUE constraint failed") || err.code === "SQLITE_CONSTRAINT")) {
      return {
        success: false,
        code: "TOTP_ALREADY_USED",
        message: "Kode Google Authenticator sudah pernah digunakan."
      };
    }
    throw err;
  }

  return {
    success: true
  };
}


// ==================================================
// HELPER SESI MEJA
// ==================================================

function generateSessionId() {
  const now = new Date();
  const tanggal =
    now.getFullYear().toString() +
    String(now.getMonth() + 1).padStart(2, "0") +
    String(now.getDate()).padStart(2, "0");

  const waktu =
    String(now.getHours()).padStart(2, "0") +
    String(now.getMinutes()).padStart(2, "0") +
    String(now.getSeconds()).padStart(2, "0");

  const padId = String(now.getMilliseconds()).padStart(3, "0");

  return `SES-${tanggal}-${waktu}-${padId}`;
}

function getActiveSessionByTable(nomorMeja) {
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT * FROM sesi_meja WHERE nomor_meja = ? AND status = 'AKTIF'`,
      [nomorMeja],
      (error, row) => {
        if (error) reject(error);
        else resolve(row);
      }
    );
  });
}

function getSessionById(sessionId) {
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT * FROM sesi_meja WHERE session_id = ?`,
      [sessionId],
      (error, row) => {
        if (error) reject(error);
        else resolve(row);
      }
    );
  });
}

async function getHargaMemberDariCache(kategoriInput, durasiJamInput, waktuMulaiInput = null) {
  const kategori = String(kategoriInput || "").trim().toUpperCase();
  const durasiJam = Number(durasiJamInput);

  if (!kategori || !Number.isInteger(durasiJam) || durasiJam < 1) {
    return null;
  }

  const rows = await new Promise((resolve, reject) => {
    db.all(
      `SELECT kategori, jam, jam_selesai, durasi_jam, harga_per_jam, total
       FROM harga_member_cache
       WHERE UPPER(TRIM(kategori)) = ?
       ORDER BY id DESC`,
      [kategori],
      (err, data) => err ? reject(err) : resolve(data || [])
    );
  });

  if (!rows.length) return null;
  const selected = selectLocalMemberPrice(rows, durasiJam, waktuMulaiInput);
  return selected ? { kategori, durasiJam, ...selected } : null;
}

async function sinkronHargaMejaBilliard(sessionRow, durasiJam) {
  if (!sessionRow || !Number.isInteger(Number(durasiJam)) || Number(durasiJam) < 1) return;

  const namaMeja = await getNamaBarangMejaSesi(sessionRow.session_id);

  const durasi = Number(durasiJam);
  const nowIso = new Date().toISOString();

  const kategori = String(sessionRow.kategori_member || "").trim().toUpperCase();

  if (!kategori) {
    await runAsync(
      `UPDATE pesanan_meja
       SET qty = ?,
           subtotal = harga_jual * ?,
           updated_at = ?
       WHERE session_id = ?
         AND LOWER(TRIM(nama_barang)) = LOWER(?)`,
      [durasi, durasi, nowIso, sessionRow.session_id, namaMeja]
    );
    return;
  }

  const hasil = await getHargaMemberDariCache(
    kategori,
    durasi,
    sessionRow.waktu_mulai
  );

  if (!hasil) {
    await runAsync(
      `UPDATE pesanan_meja
       SET qty = ?,
           subtotal = harga_jual * ?,
           updated_at = ?
       WHERE session_id = ?
       AND LOWER(TRIM(nama_barang)) = LOWER(?)`,
      [durasi, durasi, nowIso, sessionRow.session_id, namaMeja]
    );
    return;
  }

  await runAsync(
    `UPDATE pesanan_meja
     SET qty = ?,
         harga_jual = ?,
         subtotal = ?,
         updated_at = ?
     WHERE session_id = ?
     AND LOWER(TRIM(nama_barang)) = LOWER(?)`,
    [
      durasi,
      hasil.hargaPerJam,
      hasil.total,
      nowIso,
      sessionRow.session_id,
      namaMeja
    ]
  );
}

const NAMA_BARANG_MEJA = ["Meja Billiard", "Meja Pagi", "Meja Malam"];
function namaMejaDariWaktuMulai(waktuMulai) {
  const jam = jamMakassar(waktuMulai);
  return jam >= 7 && jam < 18 ? "Meja Pagi" : "Meja Malam";
}
async function getNamaBarangMejaSesi(sessionId) {
  const items = await getSessionItems(sessionId);
  const meja = items.find(item => NAMA_BARANG_MEJA.includes(String(item.nama_barang || "").trim()));
  // Rows lama tetap menggunakan nama barang Meja Billiard.
  return meja?.nama_barang || "Meja Billiard";
}

function jamMakassar(waktu) {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Makassar", hour: "2-digit", hourCycle: "h23" }).formatToParts(new Date(waktu));
  return Number(parts.find(part => part.type === "hour")?.value || 0);
}

async function sinkronBonusMalam(sessionRow, durasiJam, pilihan = null) {
  if (!sessionRow?.session_id) return { bonusQty: 0, bonusProduct: null };
  const kategori = String(sessionRow.kategori_member || "").trim().toUpperCase();
  const jam = jamMakassar(sessionRow.waktu_mulai);
  const qty = ["PLATINUM", "UMUM", "PELAJAR"].includes(kategori) && MEMBER_SCHEDULE.isNightHour(jam)
    ? Math.floor(Number(durasiJam) / 3) : 0;
  const existing = (await getSessionItems(sessionRow.session_id)).find(item => String(item.nama_barang || "").trim().toLowerCase() === "kopi bonus" || String(item.nama_barang || "").trim().toLowerCase() === "es teh bonus");
  const product = pilihan || existing?.nama_barang || null;
  if (qty < 1 || !product || !["Kopi Bonus", "Es Teh Bonus"].includes(product)) {
    await runAsync(`DELETE FROM pesanan_meja WHERE session_id = ? AND LOWER(TRIM(nama_barang)) IN ('kopi bonus', 'es teh bonus')`, [sessionRow.session_id]);
    return { bonusQty: 0, bonusProduct: null };
  }
  const now = new Date().toISOString();
  const found = (await getSessionItems(sessionRow.session_id)).find(item => String(item.nama_barang || "").trim().toLowerCase() === product.toLowerCase());
  await runAsync(`DELETE FROM pesanan_meja WHERE session_id = ? AND LOWER(TRIM(nama_barang)) IN ('kopi bonus', 'es teh bonus') AND LOWER(TRIM(nama_barang)) <> ?`, [sessionRow.session_id, product.toLowerCase()]);
  if (found) {
    await runAsync(`DELETE FROM pesanan_meja WHERE session_id = ? AND LOWER(TRIM(nama_barang)) = ? AND id <> ?`, [sessionRow.session_id, product.toLowerCase(), found.id]);
    await runAsync(`UPDATE pesanan_meja SET qty = ?, harga_jual = 0, hpp = 0, subtotal = 0, updated_at = ? WHERE id = ?`, [qty, now, found.id]);
  } else {
    await runAsync(`DELETE FROM pesanan_meja WHERE session_id = ? AND LOWER(TRIM(nama_barang)) IN ('kopi bonus', 'es teh bonus')`, [sessionRow.session_id]);
    await runAsync(`INSERT INTO pesanan_meja (session_id, nama_barang, qty, harga_jual, hpp, subtotal, created_at, updated_at) VALUES (?, ?, ?, 0, 0, 0, ?, ?)`, [sessionRow.session_id, product, qty, now, now]);
  }
  return { bonusQty: qty, bonusProduct: product };
}

function getSessionItems(sessionId) {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT * FROM pesanan_meja WHERE session_id = ? ORDER BY id ASC`,
      [sessionId],
      (error, rows) => {
        if (error) reject(error);
        else resolve(rows);
      }
    );
  });
}

const expiredLampSessions = new Set();
const warned15MinuteSessions = new Set();
const warningLampSessions = new Set();
const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;
let expiredSessionCheckerRunning = false;

async function trigger15MinuteLampWarning(session) {
  if (!session || !session.session_id) return;
  if (warned15MinuteSessions.has(session.session_id)) return;
  if (warningLampSessions.has(session.session_id)) return;
  if (!session.waktu_selesai) return;

  const end = new Date(session.waktu_selesai);
  const remainingMs = end.getTime() - Date.now();
  if (!Number.isFinite(remainingMs) || remainingMs <= 0 || remainingMs > FIFTEEN_MINUTES_MS) return;

  warned15MinuteSessions.add(session.session_id);
  warningLampSessions.add(session.session_id);

  const nomorMeja = session.nomor_meja;
  try {
    writeLog("INFO", "SESSION_15MIN_WARNING", `Sesi meja ${nomorMeja} tersisa <= 15 menit, lampu berkedip 2 kali`, {
      sessionId: session.session_id,
      remainingSeconds: Math.floor(remainingMs / 1000)
    });

    const lampRes = await lampBlink15Minute(nomorMeja, 500);
    if (!lampRes || lampRes.success !== true) {
      writeLog("WARN", "LAMP_15MIN_WARNING_FAILED", `Gagal menjalankan peringatan 15 menit meja ${nomorMeja}`, { lampRes });
    }
  } catch (lampErr) {
    writeLog("ERROR", "LAMP_15MIN_WARNING_ERROR", `Error peringatan 15 menit meja ${nomorMeja}`, { error: lampErr.message });
  } finally {
    warningLampSessions.delete(session.session_id);
  }
}

async function checkExpiredTableSessions() {
  if (expiredSessionCheckerRunning) {
    return;
  }

  expiredSessionCheckerRunning = true;

  try {
    const rows = await new Promise((resolve, reject) => {
      db.all(
        `SELECT * FROM sesi_meja WHERE status = 'AKTIF'`,
        [],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        }
      );
    });

    const now = new Date();

    for (const session of rows) {
      if (session.jenis_sesi === "LOSS" || !session.waktu_selesai) {
        continue;
      }

      const endMs = new Date(session.waktu_selesai).getTime();

      if (!Number.isFinite(endMs)) {
        continue;
      }

      const remainingMs = endMs - now.getTime();

      if (
        remainingMs > 0 &&
        remainingMs <= FIFTEEN_MINUTES_MS
      ) {
        trigger15MinuteLampWarning(session).catch(error => {
          writeLog(
            "ERROR",
            "CHECK_15MIN_WARNING",
            `Gagal memicu peringatan 15 menit meja ${session.nomor_meja}`,
            { error: error.message }
          );
        });
      }

      if (remainingMs <= 0) {
        if (expiredLampSessions.has(session.session_id)) {
          continue;
        }

        expiredLampSessions.add(session.session_id);
        warned15MinuteSessions.delete(session.session_id);

        writeLog(
          "INFO",
          "SESSION_EXPIRED",
          `Sesi meja ${session.nomor_meja} habis, lampu ditandai untuk dimatikan oleh watchdog`,
          {
            sessionId: session.session_id
          }
        );
      } else {
        expiredLampSessions.delete(session.session_id);
      }
    }
  } catch (error) {
    writeLog(
      "ERROR",
      "CHECK_EXPIRED_SESSIONS",
      "Error saat memeriksa sesi meja habis",
      {
        error: error.message
      }
    );
  } finally {
    expiredSessionCheckerRunning = false;
  }
}


// ==================================================
// MEMBER HELPERS
// ==================================================

function hitungUmur(tanggalLahir) {
  if (!tanggalLahir) return 0;
  const lahir = new Date(tanggalLahir);
  const sekarang = new Date();
  let umur = sekarang.getFullYear() - lahir.getFullYear();
  const m = sekarang.getMonth() - lahir.getMonth();
  if (m < 0 || (m === 0 && sekarang.getDate() < lahir.getDate())) {
    umur--;
  }
  return umur;
}

function tentukanStatusMember(member) {
  if (!member) return 'NONAKTIF';
  if (member.status === 'NONAKTIF') return 'NONAKTIF';

  const now = new Date();
  const witaParts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Makassar',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(now);

  const getPart = (type) => witaParts.find(p => p.type === type)?.value || '';
  const todayStr = `${getPart('year')}-${getPart('month')}-${getPart('day')}`;

  const tanggalAktif = member.tanggal_aktif;

  if (tanggalAktif && todayStr < tanggalAktif) {
    return 'MENUNGGU_AKTIF';
  }

  if (member.status === 'MENUNGGU_AKTIF') {
    if (!tanggalAktif) return 'MENUNGGU_AKTIF';
    const tglDate = new Date(`${tanggalAktif}T00:00:00Z`);
    const todayD = new Date(`${todayStr}T00:00:00Z`);
    const diff = Math.floor((todayD.getTime() - tglDate.getTime()) / 86400000);
    if (diff === 0 || diff > 7) return 'EXPIRED';
    return 'AKTIF';
  }

  let baseDateStr = member.last_used_at;
  if (!baseDateStr) {
    baseDateStr = member.tanggal_aktif;
  }

  if (baseDateStr) {
    const lastUsedWita = (function (dateStr) {
      const d = new Date(dateStr);
      if (Number.isNaN(d.getTime())) return null;
      const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Makassar',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
      }).formatToParts(d);
      const g = (t) => parts.find(p => p.type === t)?.value || '';
      return `${g('year')}-${g('month')}-${g('day')}`;
    })(baseDateStr);

    if (!lastUsedWita) {
      if (member.status === 'AKTIF' && tanggalAktif && todayStr >= tanggalAktif) {
        return 'AKTIF';
      }
      return member.status || 'MENUNGGU_AKTIF';
    }

    const baseDate = new Date(`${lastUsedWita}T00:00:00Z`);
    const todayDate = new Date(`${todayStr}T00:00:00Z`);
    const diffDays = Math.floor((todayDate.getTime() - baseDate.getTime()) / 86400000);

    if (diffDays === 0) {
      return 'EXPIRED';
    }
    if (!member.last_used_at) {
      if (diffDays >= 7) return 'EXPIRED';
    } else {
      if (diffDays > 7) return 'EXPIRED';
    }
    if (member.status === 'AKTIF' || member.status === 'EXPIRED') {
      return 'AKTIF';
    }
  }

  if (member.status === 'AKTIF' && tanggalAktif && todayStr >= tanggalAktif) {
    return 'AKTIF';
  }

  return member.status || 'MENUNGGU_AKTIF';
}

function validasiBatasSesiMemberPagi(kategoriMember, waktuMulaiInput, waktuSelesaiInput) {
  const kategori = String(kategoriMember || "").trim().toUpperCase();
  if (!["PLATINUM", "UMUM", "PELAJAR"].includes(kategori)) return;

  const waktuMulai = new Date(waktuMulaiInput);
  const waktuSelesai = new Date(waktuSelesaiInput);
  if (Number.isNaN(waktuMulai.getTime()) || Number.isNaN(waktuSelesai.getTime())) return;

  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Makassar",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).formatToParts(waktuMulai);
  const part = (type) => parts.find(item => item.type === type)?.value || "0";
  const year = Number(part("year"));
  const month = Number(part("month"));
  const day = Number(part("day"));
  const hour = Number(part("hour"));
  const minute = Number(part("minute"));

  // Paket pagi berlaku mulai 07:00 sampai sebelum 18:00 WITA.
  if (!MEMBER_SCHEDULE.isMorningHour(hour)) return;

  // Makassar memakai UTC+08:00; pukul 19:00 setempat adalah 11:00 UTC.
  const batasSelesai = Date.UTC(year, month - 1, day, 11, 0, 0, 0);
  if (waktuSelesai.getTime() > batasSelesai) {
    const sisaJamBulat = Math.max(0, Math.floor((batasSelesai - waktuMulai.getTime()) / 3600000));
    throw new Error(`Sesi member pagi kategori ${kategori} harus selesai paling lambat pukul 19:00 WITA. Durasi maksimum dari waktu mulai ini ${sisaJamBulat} jam.`);
  }
}
function cekStatusMemberHarian() {
  return new Promise((resolve, reject) => {
    db.all(`SELECT * FROM member`, [], async (err, rows) => {
      if (err) {
        return reject(err);
      }
      for (const m of rows) {
        const statusBaru = tentukanStatusMember(m);
        if (statusBaru && statusBaru !== m.status) {
          await runAsync(
            `UPDATE member SET status = ?, updated_at = ? WHERE id = ?`,
            [statusBaru, new Date().toISOString(), m.id]
          );
        }
      }
      console.log("[MEMBER] Pemeriksaan status harian selesai");
      writeLog("INFO", "MEMBER_CHECK", "[MEMBER] Pemeriksaan status harian selesai");
      resolve();
    });
  });
}


// ==================================================
// HARGA MEMBER CACHE SYNC
// ==================================================

// ==================================================
// MASTER BARANG - LOCAL
// ==================================================

function getLocalBarang() {
  return new Promise((resolve, reject) => {
    db.all(
      `
      SELECT
        id,
        nama,
        kategori,
        hpp,
        harga_jual AS hargaJual,
        stok_aktual AS stokAktual,
        updated_at
      FROM master_barang
      ORDER BY id ASC
      `,
      [],
      (error, rows) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(rows);
      }
    );
  });
}


// ==================================================
// Katalog operasional dikelola di SQLite. Tidak ada feed impor terverifikasi.
// ==================================================

// ==================================================
// TRANSAKSI LOCAL
// ==================================================

function getTransactionDetails(transaksiId) {
  return new Promise((resolve, reject) => {
    db.all(
      `
      SELECT
        nama_barang,
        qty,
        harga_jual,
        hpp,
        subtotal
      FROM detail_transaksi
      WHERE transaksi_id = ?
      ORDER BY id ASC
      `,
      [transaksiId],
      (error, rows) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(rows);
      }
    );
  });
}

// ==================================================
// LOGIN SESSIONS MANAGEMENT & SECURITY HELPERS
// ==================================================

const activeLoginSessions = new Map();
const loginRateLimitMap = new Map();
// Keep the in-memory lease long enough to survive mobile/browser timer throttling.
// Valid session checks extend it; explicit logout and shift-close behavior remain authoritative.
const LOGIN_SESSION_LEASE_MS = 24 * 60 * 60 * 1000;


// ==================================================
// MEMBER CACHE MANAGEMENT
// ==================================================

function getMemberCacheFromDb() {
  return new Promise((resolve, reject) => {
    db.all(
      `
      SELECT
        m.*,
        mk.nama AS kategori
      FROM member m
      LEFT JOIN member_kategori mk
        ON mk.id = m.kategori_id
      ORDER BY m.id ASC
      `,
      [],
      (err, rows) => {
        if (err) return reject(err);

        const data = rows.map(r => ({
          id: r.kode_member || String(r.id),
          kodeMember: r.kode_member || String(r.id),
          nama: r.nama || "",
          alamat: r.alamat || "",
          nomorHp: r.nomor_hp || "",
          tanggalLahir: r.tanggal_lahir || "",
          umur: hitungUmur(r.tanggal_lahir),
          kategoriId: r.kategori_id || "",
          kategori: r.kategori || "",
          namaSekolah: r.nama_sekolah || null,
          nisn: r.nisn || null,
          tanggalDaftar: r.tanggal_daftar || "",
          tanggalAktif: r.tanggal_aktif || "",
          lastUsedAt: r.last_used_at || "",
          status: r.status || "",
          totalKunjungan: 0,
          totalPengeluaran: 0
        }));

        resolve(data);
      }
    );
  });
}

async function getMemberListCached() {
  return await getMemberCacheFromDb();
}

setInterval(() => {
  const now = Date.now();
  for (const [kasirId, session] of activeLoginSessions.entries()) {
    if (now >= session.expiresAt) {
      activeLoginSessions.delete(kasirId);
    }
  }
  for (const [ip, record] of loginRateLimitMap.entries()) {
    if (now >= record.resetTime) {
      loginRateLimitMap.delete(ip);
    }
  }
}, 60 * 1000);

function validateLoginSession(req, res) {
  const rawSessionId = req.headers["x-session-id"];
  const rawDeviceId = req.headers["x-device-id"];

  if (!rawSessionId || !rawDeviceId) {
    res.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ success: false, code: "SESSION_NOT_FOUND", message: "Session ID dan DeviceId wajib diisi" }));
    return null;
  }

  const trimmedSessionId = String(rawSessionId).trim();
  const trimmedDeviceId = String(rawDeviceId).trim();

  if (!trimmedSessionId || !trimmedDeviceId) {
    res.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ success: false, code: "SESSION_NOT_FOUND", message: "Session ID dan DeviceId wajib diisi" }));
    return null;
  }

  let foundSession = null;
  for (const session of activeLoginSessions.values()) {
    if (session.sessionId === trimmedSessionId) {
      foundSession = session;
      break;
    }
  }

  if (!foundSession) {
    res.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ success: false, code: "SESSION_NOT_FOUND", message: "Session tidak ditemukan" }));
    return null;
  }

  const now = Date.now();
  if (now >= foundSession.expiresAt) {
    activeLoginSessions.delete(foundSession.kasirId);
    res.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ success: false, code: "SESSION_EXPIRED", message: "Session sudah expired" }));
    return null;
  }

  if (foundSession.deviceId !== trimmedDeviceId) {
    res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ success: false, code: "DEVICE_MISMATCH", message: "Device tidak sesuai dengan session" }));
    return null;
  }

  foundSession.expiresAt = Date.now() + LOGIN_SESSION_LEASE_MS;

  return foundSession;
}


// ==================================================
// SERVER ROUTER & HANDLERS
// ==================================================

const server = https.createServer({
  key: fs.readFileSync(path.join(__dirname, "192.168.1.140+1-key.pem")),
  cert: fs.readFileSync(path.join(__dirname, "192.168.1.140+1.pem"))
}, async (req, res) => {

  const origin = req.headers.origin;
  if (origin) {
    if (
      origin === "capacitor://localhost" ||
      origin === "https://localhost" ||
      origin.startsWith("http://localhost") ||
      origin.startsWith("http://192.168.1.140")
    ) {
      res.setHeader("Access-Control-Allow-Origin", origin);
    }
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Session-Id, X-Device-Id");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  // ── Stock Opname kategori — parsing pathname murni (abaikan query string) ─
  const parsedUrl = require("url").parse(req.url, true);
  const pathname = parsedUrl.pathname;

  if (req.method === "GET" && pathname === "/api/stock-opname/kategori") {
    if (!validateLoginSession(req, res)) return;
    try {
      const query = "SELECT DISTINCT kategori FROM master_barang WHERE kategori IS NOT NULL AND TRIM(kategori) != '' ORDER BY kategori ASC";
      db.all(query, [], (err, rows) => {
        if (res.headersSent) return;
        if (err) {
          console.error('[SO ERROR] Query kategori gagal:', err.message);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: true, data: [] }));
        }
        const categories = (rows || [])
          .map(r => r.kategori)
          .filter(k => k && String(k).trim() !== '');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, data: categories }));
      });
    } catch (err) {
      console.error('[SO ERROR] Exception pada /api/stock-opname/kategori:', err);
      if (!res.headersSent) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, data: [] }));
      }
    }
    return;
  }

  // STATIC FILE HANDLERS
  if (req.method === "GET" && req.url === "/") {
    try {
      const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(html);
    } catch (error) {
      writeLog("ERROR", "UI", "Gagal membuka index.html", { error: error.message });
      res.writeHead(500);
      return res.end("Gagal membuka POS");
    }
  }

  if (req.method === "GET" && req.url === "/CART.png") {
    const img = fs.readFileSync(path.join(__dirname, "CART.png"));
    res.writeHead(200, { "Content-Type": "image/png" });
    return res.end(img);
  }

  if (req.method === "GET" && req.url === "/style.css") {
    try {
      const css = fs.readFileSync(path.join(__dirname, "style.css"), "utf8");
      res.writeHead(200, { "Content-Type": "text/css; charset=utf-8" });
      return res.end(css);
    } catch (error) {
      res.writeHead(404);
      return res.end("CSS tidak ditemukan");
    }
  }

  if (req.method === "GET" && req.url === "/pos.css") {
    try {
      const css = fs.readFileSync(path.join(__dirname, "pos.css"), "utf8");
      res.writeHead(200, { "Content-Type": "text/css; charset=utf-8" });
      return res.end(css);
    } catch (error) {
      res.writeHead(404);
      return res.end("CSS tidak ditemukan");
    }
  }

  if (req.method === "GET" && req.url === "/meja.css") {
    try {
      const css = fs.readFileSync(path.join(__dirname, "meja.css"), "utf8");
      res.writeHead(200, { "Content-Type": "text/css; charset=utf-8" });
      return res.end(css);
    } catch (error) {
      res.writeHead(404);
      return res.end("CSS meja tidak ditemukan");
    }
  }

  if (req.method === "GET" && req.url.split("?")[0] === "/printer-bluetooth.js") {
    try {
      const js = fs.readFileSync(
        path.join(__dirname, "www", "printer-bluetooth.js"),
        "utf8"
      );
      res.writeHead(200, {
        "Content-Type": "application/javascript; charset=utf-8",
        "Cache-Control": "no-cache"
      });
      return res.end(js);
    } catch (error) {
      writeLog(
        "ERROR",
        "UI",
        "printer-bluetooth.js tidak ditemukan",
        { error: error.message }
      );
      res.writeHead(404);
      return res.end("printer-bluetooth.js tidak ditemukan");
    }
  }

  if (req.method === "GET" && req.url.split("?")[0] === "/printer-pesanan.js") {
  try {
    const js = fs.readFileSync(
      path.join(__dirname, "printer-pesanan.js"),
      "utf8"
    );

    res.writeHead(200, {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "no-cache"
    });

    return res.end(js);
  } catch (error) {
    writeLog(
      "ERROR",
      "UI",
      "printer-pesanan.js tidak ditemukan",
      { error: error.message }
    );

    res.writeHead(404);
    return res.end("printer-pesanan.js tidak ditemukan");
  }
}

  if (req.method === "GET" && req.url === "/waitinglist.js") {
    try {
      const js = fs.readFileSync(path.join(__dirname, "waitinglist.js"), "utf8");
      res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8" });
      return res.end(js);
    } catch (error) {
      res.writeHead(404);
      return res.end("waitinglist.js tidak ditemukan");
    }
  }

  if (req.method === "GET" && req.url === "/waitinglist-api.js") {
    try {
      const js = fs.readFileSync(path.join(__dirname, "waitinglist-api.js"), "utf8");
      res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8" });
      return res.end(js);
    } catch (error) {
      res.writeHead(404);
      return res.end("waitinglist-api.js tidak ditemukan");
    }
  }

  if (req.method === "GET" && req.url === "/waitinglist.css") {
    try {
      const css = fs.readFileSync(path.join(__dirname, "waitinglist.css"), "utf8");
      res.writeHead(200, { "Content-Type": "text/css; charset=utf-8" });
      return res.end(css);
    } catch (error) {
      res.writeHead(404);
      return res.end("waitinglist.css tidak ditemukan");
    }
  }

  if (req.method === "GET" && req.url.split("?")[0] === "/stock-opname.js") {
    try {
      const js = fs.readFileSync(path.join(__dirname, "stock-opname.js"), "utf8");
      res.writeHead(200, {
        "Content-Type": "application/javascript; charset=utf-8",
        "Cache-Control": "no-cache"
      });
      return res.end(js);
    } catch (error) {
      writeLog("ERROR", "UI", "Gagal membuka stock-opname.js", { error: error.message });
      res.writeHead(404);
      return res.end("stock-opname.js tidak ditemukan");
    }
  }

  if (req.method === "GET" && req.url.split("?")[0] === "/stock-opname.css") {
    try {
      const css = fs.readFileSync(path.join(__dirname, "stock-opname.css"), "utf8");
      res.writeHead(200, {
        "Content-Type": "text/css; charset=utf-8",
        "Cache-Control": "no-cache"
      });
      return res.end(css);
    } catch (error) {
      writeLog("ERROR", "UI", "Gagal membuka stock-opname.css", { error: error.message });
      res.writeHead(404);
      return res.end("stock-opname.css tidak ditemukan");
    }
  }

  if (req.method === "GET" && req.url === "/meja-timer.js") {
    try {
      const js = fs.readFileSync(path.join(__dirname, "meja-timer.js"), "utf8");
      res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8" });
      return res.end(js);
    } catch (error) {
      res.writeHead(404);
      return res.end("meja-timer.js tidak ditemukan");
    }
  }

  if (req.method === "GET" && req.url === "/meja-bubble.js") {
    try {
      const js = fs.readFileSync(path.join(__dirname, "meja-bubble.js"), "utf8");
      res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8" });
      return res.end(js);
    } catch (error) {
      res.writeHead(404);
      return res.end("meja-bubble.js tidak ditemukan");
    }
  }
  if (req.method === "GET" && req.url === "/meja-modal.js") {
    try {
      const js = fs.readFileSync(path.join(__dirname, "meja-modal.js"), "utf8");
      res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8" });
      return res.end(js);
    } catch (error) {
      res.writeHead(404);
      return res.end("meja-modal.js tidak ditemukan");
    }
  }

  if (req.method === "GET" && req.url === "/meja-produk-modal.js") {
    try {
      const js = fs.readFileSync(path.join(__dirname, "meja-produk-modal.js"), "utf8");
      res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8" });
      return res.end(js);
    } catch (error) {
      res.writeHead(404);
      return res.end("meja-produk-modal.js tidak ditemukan");
    }
  }

  if (req.method === "GET" && req.url === "/member-schedule.js") {
    try {
      const js = fs.readFileSync(path.join(__dirname, "member-schedule.js"), "utf8");
      res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8" });
      return res.end(js);
    } catch (error) {
      res.writeHead(404);
      return res.end("member-schedule.js tidak ditemukan");
    }
  }

  if (req.method === "GET" && req.url === "/member.js") {
    try {
      const js = fs.readFileSync(path.join(__dirname, "member.js"), "utf8");
      res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8" });
      return res.end(js);
    } catch (error) {
      res.writeHead(404);
      return res.end("member.js tidak ditemukan");
    }
  }

  if (req.method === "GET" && req.url === "/promo.js") {
    try {
      const js = fs.readFileSync(path.join(__dirname, "promo.js"), "utf8");
      res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8" });
      return res.end(js);
    } catch (error) {
      res.writeHead(404);
      return res.end("promo.js tidak ditemukan");
    }
  }

  if (req.method === "GET" && req.url === "/pricing-meja.js") {
    try {
      const js = fs.readFileSync(path.join(__dirname, "pricing-meja.js"), "utf8");
      res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8" });
      return res.end(js);
    } catch (error) {
      res.writeHead(404);
      return res.end("pricing-meja.js tidak ditemukan");
    }
  }

  if (req.method === "GET" && req.url === "/api/status") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify({
      success: true,
      server: "POS POLAR",
      status: "ONLINE",
      port: config.PORT
    }));
  }

  if (req.method === "GET" && req.url === "/api/kasir") {
    db.all(
      `SELECT id, nama FROM kasir WHERE aktif = 1 ORDER BY id ASC`,
      [],
      (error, rows) => {
        if (error) {
          writeLog("ERROR", "GET_KASIR", "Gagal mengambil daftar kasir", { error: error.message });
          res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
          return res.end(JSON.stringify({ success: false, message: error.message }));
        }
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({
          success: true,
          data: rows
        }));
      }
    );
    return;
  }

  if (req.method === "GET" && req.url === "/api/shift/history") {
    db.all(
      `SELECT s.id, s.kasir_id, k.nama AS nama_kasir, s.buka_at, s.tutup_at, s.kode_tutup, s.nominal_aktual
       FROM shift_kasir s
       JOIN kasir k ON k.id = s.kasir_id
       WHERE s.status = 'CLOSED'
       ORDER BY s.id DESC
       LIMIT 20`,
      [],
      (error, rows) => {
        if (error) {
          writeLog("ERROR", "GET_SHIFT_HISTORY", "Gagal mengambil riwayat shift tertutup", { error: error.message });
          res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
          return res.end(JSON.stringify({ success: false, message: error.message }));
        }
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({
          success: true,
          data: rows
        }));
      }
    );
    return;
  }

  if (req.method === "GET" && req.url.startsWith("/api/shift/snapshot/")) {
    const shiftId = req.url.slice("/api/shift/snapshot/".length);
    db.get(
      `SELECT pending_close_snapshot FROM shift_kasir WHERE id = ?`,
      [shiftId],
      (error, row) => {
        if (error) {
          writeLog("ERROR", "GET_SHIFT_SNAPSHOT", "Gagal mengambil snapshot penutupan shift", { error: error.message, shiftId });
          res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
          return res.end(JSON.stringify({ success: false, message: error.message }));
        }
        if (!row || row.pending_close_snapshot == null) {
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          return res.end(JSON.stringify({ success: false, message: "Snapshot tidak ditemukan untuk shift ini." }));
        }
        let snapshot;
        try {
          snapshot = JSON.parse(row.pending_close_snapshot);
        } catch (parseError) {
          writeLog("ERROR", "GET_SHIFT_SNAPSHOT", "Snapshot penutupan shift bukan JSON valid", { error: parseError.message, shiftId });
          res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
          return res.end(JSON.stringify({ success: false, message: "Snapshot tidak valid untuk shift ini." }));
        }
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ success: true, snapshot }));
      }
    );
    return;
  }

  if (req.method === "GET" && req.url === "/api/lamp-watchdog/alarms") {
    db.all(
      `SELECT id, table_number, command, failure_count, status, error_message,
              error_category, error_meaning, troubleshooting, started_at,
              last_failed_at, cleared_at
       FROM lamp_alarm_history
       ORDER BY started_at DESC, id DESC
       LIMIT 40`,
      [],
      (error, alarms) => {
        if (error) {
          const tableMissing = /no such table:\s*lamp_alarm_history/i.test(error.message || "");
          const message = tableMissing
            ? "Tabel lamp_alarm_history belum tersedia."
            : error.message;
          writeLog("ERROR", "GET_LAMP_WATCHDOG_ALARMS", "Gagal mengambil riwayat alarm lampu", { error: message });
          res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
          return res.end(JSON.stringify({ success: false, message }));
        }

        db.get(
          `SELECT COUNT(*) AS active_count
           FROM lamp_alarm_history
           WHERE status = 'ACTIVE' AND failure_count >= 6`,
          [],
          (countError, result) => {
            if (countError) {
              const tableMissing = /no such table:\s*lamp_alarm_history/i.test(countError.message || "");
              const message = tableMissing
                ? "Tabel lamp_alarm_history belum tersedia."
                : countError.message;
              writeLog("ERROR", "GET_LAMP_WATCHDOG_ALARMS", "Gagal menghitung alarm lampu aktif", { error: message });
              res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
              return res.end(JSON.stringify({ success: false, message }));
            }

            res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
            return res.end(JSON.stringify({
              success: true,
              alarms,
              active_count: Number(result && result.active_count) || 0
            }));
          }
        );
      }
    );
    return;
  }

  if (req.method === "POST" && req.url === "/api/session") {
    try {
      const data = await getJsonBody(req);
      const rawSessionId = data.sessionId;
      const rawDeviceId = data.deviceId;

      if (!rawSessionId || !rawDeviceId || typeof rawSessionId !== "string" || typeof rawDeviceId !== "string" || !rawSessionId.trim() || !rawDeviceId.trim()) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ success: false, valid: false, code: "INVALID_REQUEST", message: "sessionId dan deviceId wajib diisi" }));
      }

      const trimmedSessionId = rawSessionId.trim();
      const trimmedDeviceId = rawDeviceId.trim();
      let foundSession = null;
      for (const session of activeLoginSessions.values()) {
        if (session.sessionId === trimmedSessionId) {
          foundSession = session;
          break;
        }
      }

      if (!foundSession) {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ success: false, valid: false, code: "SESSION_NOT_FOUND" }));
      }

      const now = Date.now();
      if (now >= foundSession.expiresAt) {
        activeLoginSessions.delete(foundSession.kasirId);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ success: false, valid: false, code: "SESSION_EXPIRED", message: "Session login sudah expired." }));
      }

      if (foundSession.deviceId !== trimmedDeviceId) {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ success: false, valid: false, code: "DEVICE_MISMATCH", message: "Session bukan milik device ini." }));
      }

      db.get(`SELECT id, nama, aktif FROM kasir WHERE id = ?`, [foundSession.kasirId], (err, kasirRow) => {
        if (err || !kasirRow || !kasirRow.aktif) {
          activeLoginSessions.delete(foundSession.kasirId);
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          return res.end(JSON.stringify({ success: false, valid: false, code: "SESSION_NOT_FOUND", message: "Kasir tidak aktif atau tidak ditemukan" }));
        }
        foundSession.kasirNama = kasirRow.nama;

        db.get(`SELECT id, status, opening_confirmed, pending_close_snapshot FROM shift_kasir
                WHERE kasir_id = ?
                  AND (
                    (status = 'OPEN' AND date(buka_at, '+8 hours') = date('now', '+8 hours'))
                    OR
                    (status = 'PENDING_CLOSE' AND date(buka_at, '+8 hours') = date('now', '+8 hours'))
                  )
                ORDER BY CASE WHEN status = 'PENDING_CLOSE' THEN 0 ELSE 1 END, id DESC LIMIT 1`, [foundSession.kasirId], (shiftError, shift) => {
          if (shiftError) {
            res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
            return res.end(JSON.stringify({ success: false, valid: false, message: shiftError.message }));
          }
          foundSession.shiftId = shift ? shift.id : null;
          foundSession.expiresAt = Date.now() + LOGIN_SESSION_LEASE_MS;
          const currentNow = Date.now();

          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          return res.end(JSON.stringify({
            success: true,
            valid: true,
            sessionId: foundSession.sessionId,
            kasirId: foundSession.kasirId,
            nama: foundSession.kasirNama,
            username: foundSession.username,
            loginAt: foundSession.loginAt,
            expiresAt: foundSession.expiresAt,
            remainingMs: foundSession.expiresAt - currentNow,
            shiftId: foundSession.shiftId,
            ...(shift && shift.status === "PENDING_CLOSE" ? { pendingCloseSnapshot: shift.pending_close_snapshot } : {}),
            ...(shift ? { opening_confirmed: shift.opening_confirmed } : {}),
            shiftState: shift ? shift.status === "PENDING_CLOSE" ? "PENDING_CLOSE" : "CURRENT_OPEN_SHIFT" : "NO_CURRENT_OPEN_SHIFT"
          }));
        });
      });
      return;
    } catch (error) {
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ success: false, valid: false, message: error.message }));
    }
  }

  if (req.method === "POST" && req.url === "/api/logout") {
    try {
      const data = await getJsonBody(req);
      const rawSessionId = data.sessionId;
      const rawDeviceId = data.deviceId;
      const requestedKasirId = data.kasirId != null ? Number(data.kasirId) : null;

      if (!rawSessionId || !rawDeviceId || typeof rawSessionId !== "string" || typeof rawDeviceId !== "string" || !rawSessionId.trim() || !rawDeviceId.trim()) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ success: false, message: "sessionId dan deviceId wajib diisi" }));
      }

      const trimmedSessionId = rawSessionId.trim();
      const trimmedDeviceId = rawDeviceId.trim();

      let targetKasirId = null;
      for (const [kasirId, session] of activeLoginSessions.entries()) {
        if (session.sessionId === trimmedSessionId && session.deviceId === trimmedDeviceId) {
          targetKasirId = kasirId;
          break;
        }
      }

      if (targetKasirId) {
        activeLoginSessions.delete(targetKasirId);
      }
      if (requestedKasirId !== null && Number.isFinite(requestedKasirId)) {
        activeLoginSessions.delete(requestedKasirId);
      }

      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ success: true }));
    } catch (error) {
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ success: false, message: error.message }));
    }
  }

  if (req.method === "POST" && req.url === "/api/login") {
    const clientIp = req.socket.remoteAddress || "127.0.0.1";
    const nowRateLimit = Date.now();
    const windowMs = 15 * 60 * 1000;
    const maxFailures = 5;

    let record = loginRateLimitMap.get(clientIp);
    if (record && nowRateLimit > record.resetTime) {
      loginRateLimitMap.delete(clientIp);
      record = null;
    }

    if (record && record.failures >= maxFailures) {
      res.writeHead(429, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({
        success: false,
        code: "LOGIN_RATE_LIMIT",
        message: "Terlalu banyak percobaan login. Coba lagi nanti."
      }));
    }

    try {
      const data = await getJsonBody(req);
      const forceLogin = Boolean(data.forceLogin);
      const deviceId = data.deviceId;
      if (!deviceId || typeof deviceId !== "string" || !deviceId.trim()) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ success: false, message: "Device ID tidak valid" }));
      }
      const trimmedDeviceId = deviceId.trim();
      if (trimmedDeviceId.length < 16 || trimmedDeviceId.length > 128) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ success: false, message: "Device ID harus 16 hingga 128 karakter" }));
      }

      const kasirId = Number(data.kasirId);
      const pin = String(data.pin || "").trim();

      if (!kasirId || isNaN(kasirId)) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ success: false, message: "Kasir ID tidak valid" }));
      }

      if (!pin || !/^\d{6,}$/.test(pin)) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ success: false, message: "PIN harus minimal 6 digit angka" }));
      }

      db.get(
        `SELECT * FROM kasir WHERE id = ? AND pin = ? AND aktif = 1`,
        [kasirId, pin],
        (error, kasir) => {
          if (error) {
            res.writeHead(500);
            return res.end(JSON.stringify({ success: false, message: error.message }));
          }
          if (!kasir) {
            if (!record) {
              record = { failures: 0, resetTime: nowRateLimit + windowMs };
              loginRateLimitMap.set(clientIp, record);
            }
            record.failures++;

            res.writeHead(401);
            return res.end(JSON.stringify({ success: false, message: "PIN salah" }));
          }

          loginRateLimitMap.delete(clientIp);

          db.get(
            `
            SELECT id, tutup_at
            FROM shift_kasir
            WHERE kasir_id = ?
              AND status = 'CLOSED'
              AND tutup_at IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM shift_kasir pending WHERE pending.kasir_id = ? AND pending.status = 'PENDING_CLOSE')
            ORDER BY tutup_at DESC
            LIMIT 1
            `,
            [kasir.id, kasir.id],
            (closedShiftError, closedShift) => {
              if (closedShiftError) {
                res.writeHead(500);
                return res.end(JSON.stringify({ success: false, message: closedShiftError.message }));
              }

              if (closedShift) {
                const tutupAtMs = new Date(closedShift.tutup_at).getTime();
                const cooldownMs = 60 * 60 * 1000;
                const elapsedMs = Date.now() - tutupAtMs;

                if (kasir.id !== 1 && elapsedMs < cooldownMs) {
                  const remainingMinutes = Math.ceil((cooldownMs - elapsedMs) / 60000);
                  res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
                  return res.end(JSON.stringify({
                    success: false,
                    code: "SHIFT_COOLDOWN",
                    message: `Kasir baru dapat dibuka kembali setelah 1 jam. Sisa waktu sekitar ${remainingMinutes} menit.`
                  }));
                }
              }

              const now = Date.now();
              if (activeLoginSessions.has(kasir.id)) {
                const existingSession = activeLoginSessions.get(kasir.id);
                if (now < existingSession.expiresAt) {
                  if (existingSession.deviceId !== trimmedDeviceId) {
                    if (forceLogin) {
                      activeLoginSessions.delete(kasir.id);
                    } else {
                      res.writeHead(409, { "Content-Type": "application/json; charset=utf-8" });
                      return res.end(JSON.stringify({
                        success: false,
                        code: "SESSION_ACTIVE_OTHER_DEVICE",
                        message: "AKUN SEDANG DIGUNAKAN DI DEVICE LAIN."
                      }));
                    }
                  } else {
                    db.get(
                      `SELECT * FROM shift_kasir
                       WHERE kasir_id = ?
                         AND (
                           (status = 'OPEN' AND date(buka_at, '+8 hours') = date('now', '+8 hours'))
                           OR
                           (status = 'PENDING_CLOSE' AND date(buka_at, '+8 hours') = date('now', '+8 hours'))
                         )
                       ORDER BY CASE WHEN status = 'PENDING_CLOSE' THEN 0 ELSE 1 END, id DESC
                       LIMIT 1`,
                      [kasir.id],
                      (shiftError, shift) => {
                        if (shiftError) {
                          res.writeHead(500);
                          return res.end(JSON.stringify({ success: false, message: shiftError.message }));
                        }
                        if (shift) {
                          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
                          return res.end(JSON.stringify({
                            success: true,
                            kasirId: kasir.id,
                            nama: kasir.nama,
                            shiftId: shift.id,
                            opening_confirmed: shift.opening_confirmed,
                            shiftState: shift.status === "PENDING_CLOSE" ? "PENDING_CLOSE" : "CURRENT_OPEN_SHIFT",
                            ...(shift.status === "PENDING_CLOSE" ? { pendingCloseSnapshot: shift.pending_close_snapshot } : {}),
                            sessionId: existingSession.sessionId,
                            loginAt: existingSession.loginAt,
                            expiresAt: existingSession.expiresAt
                          }));
                        }
                        db.run(
                          `INSERT INTO shift_kasir (kasir_id, buka_at, saldo_awal, opening_confirmed, status)
                           SELECT ?, ?, 0, 0, 'OPEN'
                           WHERE NOT EXISTS (
                             SELECT 1 FROM shift_kasir
                             WHERE kasir_id = ?
                               AND (
                                 (status = 'OPEN' AND date(buka_at, '+8 hours') = date('now', '+8 hours'))
                                 OR
                                 (status = 'PENDING_CLOSE' AND date(buka_at, '+8 hours') = date('now', '+8 hours'))
                               )
                           )`,
                          [kasir.id, new Date().toISOString(), kasir.id],
                          function (openError) {
                            if (openError) {
                              res.writeHead(500);
                              return res.end(JSON.stringify({ success: false, message: openError.message }));
                            }
                            db.get(
                              `SELECT * FROM shift_kasir
                               WHERE kasir_id = ?
                                 AND (
                                   (status = 'OPEN' AND date(buka_at, '+8 hours') = date('now', '+8 hours'))
                                   OR
                                   (status = 'PENDING_CLOSE' AND date(buka_at, '+8 hours') = date('now', '+8 hours'))
                                 )
                               ORDER BY CASE WHEN status = 'PENDING_CLOSE' THEN 0 ELSE 1 END, id DESC LIMIT 1`,
                              [kasir.id],
                              (selectError, currentShift) => {
                                if (selectError || !currentShift) {
                                  res.writeHead(500);
                                  return res.end(JSON.stringify({ success: false, message: selectError ? selectError.message : "Shift tidak ditemukan" }));
                                }
                                res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
                                return res.end(JSON.stringify({
                                  success: true,
                                  kasirId: kasir.id,
                                  nama: kasir.nama,
                                  shiftId: currentShift.id,
                                  opening_confirmed: currentShift.opening_confirmed,
                                  shiftState: currentShift.status === "PENDING_CLOSE" ? "PENDING_CLOSE" : "CURRENT_OPEN_SHIFT",
                                  ...(currentShift.status === "PENDING_CLOSE" ? { pendingCloseSnapshot: currentShift.pending_close_snapshot } : {}),
                                  sessionId: existingSession.sessionId,
                                  loginAt: existingSession.loginAt,
                                  expiresAt: existingSession.expiresAt
                                }));
                              }
                            );
                          }
                        );
                      }
                    );
                    return;
                  }
                } else {
                  activeLoginSessions.delete(kasir.id);
                }
              }

              const loginAt = now;
              const expiresAt = loginAt + LOGIN_SESSION_LEASE_MS;
              const sessionId = crypto.randomUUID();

              activeLoginSessions.set(kasir.id, {
                sessionId,
                kasirId: kasir.id,
                username: kasir.username,
                nama: kasir.nama,
                deviceId: trimmedDeviceId,
                loginAt,
                expiresAt
              });

              db.get(
                `SELECT * FROM shift_kasir
                 WHERE kasir_id = ?
                   AND (
                     (status = 'OPEN' AND date(buka_at, '+8 hours') = date('now', '+8 hours'))
                     OR
                     (status = 'PENDING_CLOSE' AND date(buka_at, '+8 hours') = date('now', '+8 hours'))
                   )
                 ORDER BY CASE WHEN status = 'PENDING_CLOSE' THEN 0 ELSE 1 END, id DESC
                 LIMIT 1`,
                [kasir.id],
                (shiftError, shift) => {
                  if (shiftError) {
                    res.writeHead(500);
                    return res.end(JSON.stringify({ success: false, message: shiftError.message }));
                  }
                  if (shift) {
                    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
                    return res.end(JSON.stringify({
                      success: true,
                      kasirId: kasir.id,
                      nama: kasir.nama,
                      shiftId: shift.id,
                      opening_confirmed: shift.opening_confirmed,
                      shiftState: shift.status === "PENDING_CLOSE" ? "PENDING_CLOSE" : "CURRENT_OPEN_SHIFT",
                      ...(shift.status === "PENDING_CLOSE" ? { pendingCloseSnapshot: shift.pending_close_snapshot } : {}),
                      sessionId,
                      loginAt,
                      expiresAt
                    }));
                  }
                  db.run(
                    `INSERT INTO shift_kasir (kasir_id, buka_at, saldo_awal, opening_confirmed, status)
                     SELECT ?, ?, 0, 0, 'OPEN'
                     WHERE NOT EXISTS (
                       SELECT 1 FROM shift_kasir
                       WHERE kasir_id = ?
                         AND (
                           (status = 'OPEN' AND date(buka_at, '+8 hours') = date('now', '+8 hours'))
                           OR
                           (status = 'PENDING_CLOSE' AND date(buka_at, '+8 hours') = date('now', '+8 hours'))
                         )
                     )`,
                    [kasir.id, new Date().toISOString(), kasir.id],
                    function (openError) {
                      if (openError) {
                        res.writeHead(500);
                        return res.end(JSON.stringify({ success: false, message: openError.message }));
                      }
                      db.get(
                        `SELECT * FROM shift_kasir
                         WHERE kasir_id = ?
                           AND (
                             (status = 'OPEN' AND date(buka_at, '+8 hours') = date('now', '+8 hours'))
                             OR
                             (status = 'PENDING_CLOSE' AND date(buka_at, '+8 hours') = date('now', '+8 hours'))
                           )
                         ORDER BY CASE WHEN status = 'PENDING_CLOSE' THEN 0 ELSE 1 END, id DESC LIMIT 1`,
                        [kasir.id],
                        (selectError, currentShift) => {
                          if (selectError || !currentShift) {
                            res.writeHead(500);
                            return res.end(JSON.stringify({ success: false, message: selectError ? selectError.message : "Shift tidak ditemukan" }));
                          }
                          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
                          return res.end(JSON.stringify({
                            success: true,
                            kasirId: kasir.id,
                            nama: kasir.nama,
                            shiftId: currentShift.id,
                            opening_confirmed: currentShift.opening_confirmed,
                            shiftState: currentShift.status === "PENDING_CLOSE" ? "PENDING_CLOSE" : "CURRENT_OPEN_SHIFT",
                            ...(currentShift.status === "PENDING_CLOSE" ? { pendingCloseSnapshot: currentShift.pending_close_snapshot } : {}),
                            sessionId,
                            loginAt,
                            expiresAt
                          }));
                        }
                      );
                    }
                  );
                }
              );
            }
          );
        }
      );
    } catch (error) {
      res.writeHead(400);
      return res.end(JSON.stringify({ success: false, message: error.message }));
    }
    return;
  }

  if (req.method === "POST" && req.url === "/api/confirm-opening-balance") {
    const session = validateLoginSession(req, res);
    if (!session) return;

    try {
      const data = await getJsonBody(req);
      const amount = data.saldo_awal;
      const kwhDalamAmount = kwhDecimalToScaled(data.saldo_kwh_dalam_awal);
      const kwhLuarAmount = kwhDecimalToScaled(data.saldo_kwh_luar_awal);
      if (!Number.isSafeInteger(amount) || amount < 0) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ success: false, message: "Saldo awal harus berupa Rupiah bilangan bulat non-negatif" }));
      }

      db.get(
        `SELECT id FROM shift_kasir WHERE kasir_id = ? AND status = 'OPEN' AND date(buka_at, '+8 hours') = date('now', '+8 hours') ORDER BY id DESC LIMIT 1`,
        [session.kasirId],
        (shiftError, shift) => {
          if (shiftError) {
            res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
            return res.end(JSON.stringify({ success: false, message: shiftError.message }));
          }
          if (!shift) {
            res.writeHead(409, { "Content-Type": "application/json; charset=utf-8" });
            return res.end(JSON.stringify({ success: false, message: "Shift OPEN tidak ditemukan" }));
          }
          if (!reserveShiftWrite(Number(shift.id), res)) {
            res.writeHead(423, { "Content-Type": "application/json; charset=utf-8" });
            return res.end(JSON.stringify({ success: false, code: "SHIFT_CLOSE_IN_PROGRESS", message: "Proses tutup kasir sedang berlangsung untuk shift ini." }));
          }

          db.run(
            `UPDATE shift_kasir SET saldo_awal = ?, saldo_kwh_dalam_awal = ?, saldo_kwh_luar_awal = ?, opening_confirmed = 1
             WHERE id = ? AND kasir_id = ? AND status = 'OPEN' AND opening_confirmed = 0
              `,
            [amount, kwhDalamAmount, kwhLuarAmount, shift.id, session.kasirId],
            function (updateError) {
              if (updateError) {
                res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
                return res.end(JSON.stringify({ success: false, message: updateError.message }));
              }
              if (this.changes !== 1) {
                res.writeHead(409, { "Content-Type": "application/json; charset=utf-8" });
                return res.end(JSON.stringify({ success: false, message: "Saldo awal shift sudah dikonfirmasi atau shift tidak lagi OPEN" }));
              }
              res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
              return res.end(JSON.stringify({ success: true, shiftId: shift.id, saldo_awal: amount, saldo_kwh_dalam_awal: kwhScaledToDecimal(kwhDalamAmount), saldo_kwh_luar_awal: kwhScaledToDecimal(kwhLuarAmount), opening_confirmed: 1 }));
            }
          );
        }
      );
      return;
    } catch (error) {
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ success: false, message: error.message }));
    }
  }

  if (req.method === "POST" && req.url === "/api/pembelian-kwh") {
    const session = validateLoginSession(req, res);
    if (!session) return;

    const sendJson = (status, payload) => {
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(payload));
    };
    let requestCode = "";

    try {
      const data = await getJsonBody(req);
      if (!data || typeof data !== "object" || Array.isArray(data)) {
        return sendJson(400, { success: false, message: "Data pembelian harus berupa objek JSON." });
      }
      if (data.jenis_kwh !== "DALAM" && data.jenis_kwh !== "LUAR") {
        return sendJson(400, { success: false, message: "Jenis KWh harus DALAM atau LUAR." });
      }
      if (
        typeof data.nominal_pembelian !== "number" ||
        !Number.isSafeInteger(data.nominal_pembelian) ||
        data.nominal_pembelian < 0
      ) {
        return sendJson(400, { success: false, message: "Nominal pembelian harus Rupiah integer non-negatif." });
      }

      let kwhScaled;
      try {
        kwhScaled = kwhDecimalToScaled(data.kwh_didapat);
      } catch (error) {
        return sendJson(400, {
          success: false,
          message: "KWh didapat harus angka non-negatif dengan maksimal 2 angka desimal, menggunakan titik atau koma."
        });
      }
      if (kwhScaled <= 0) {
        return sendJson(400, { success: false, message: "KWh didapat harus lebih besar dari 0." });
      }

      if (data.keterangan !== undefined && typeof data.keterangan !== "string") {
        return sendJson(400, { success: false, message: "Keterangan harus berupa teks." });
      }
      const keterangan = (data.keterangan || "").trim();

      const hargaNumerator = BigInt(data.nominal_pembelian) * 10000n;
      const hargaDenominator = BigInt(kwhScaled);
      const hargaScaledBigInt =
        (hargaNumerator * 2n + hargaDenominator) / (hargaDenominator * 2n);
      if (hargaScaledBigInt > BigInt(Number.MAX_SAFE_INTEGER)) {
        return sendJson(400, { success: false, message: "Harga per KWh melebihi batas nilai yang dapat disimpan." });
      }
      const hargaScaled = Number(hargaScaledBigInt);

      const currentShift = await new Promise((resolve, reject) => {
        db.get(
          `SELECT id, status, opening_confirmed
           FROM shift_kasir
           WHERE kasir_id = ?
             AND (
               (status = 'OPEN' AND date(buka_at, '+8 hours') = date('now', '+8 hours'))
               OR
               (status = 'PENDING_CLOSE' AND date(buka_at, '+8 hours') = date('now', '+8 hours'))
             )
           ORDER BY CASE WHEN status = 'PENDING_CLOSE' THEN 0 ELSE 1 END, id DESC
           LIMIT 1`,
          [session.kasirId],
          (error, row) => {
            if (error) reject(error);
            else resolve(row || null);
          }
        );
      });
      if (!currentShift) {
        return sendJson(403, {
          success: false,
          code: "SHIFT_MISMATCH",
          message: "Shift tidak valid atau bukan shift hari ini milik kasir yang sedang login."
        });
      }
      if (currentShift.status === "PENDING_CLOSE") {
        return sendJson(423, {
          success: false,
          code: "SHIFT_PENDING_CLOSE",
          message: "Shift sedang menunggu konfirmasi tutup kasir; pembelian KWh baru ditolak."
        });
      }
      if (Number(currentShift.opening_confirmed) !== 1) {
        return sendJson(403, {
          success: false,
          code: "OPENING_BALANCE_NOT_CONFIRMED",
          message: "Saldo awal shift harus dikonfirmasi sebelum mencatat pembelian KWh."
        });
      }
      const shiftId = Number(currentShift.id);
      if (!reserveShiftWrite(shiftId, res)) {
        return sendJson(423, {
          success: false,
          code: "SHIFT_CLOSE_IN_PROGRESS",
          message: "Proses tutup kasir sedang berlangsung untuk shift ini."
        });
      }

      const waktu = new Date().toISOString();
      const insertResult = await new Promise((resolve, reject) => {
        db.run(
          `INSERT INTO pembelian_kwh
             (shift_id, kasir_id, waktu, jenis_kwh, nominal_pembelian,
              kwh_didapat, harga_per_kwh, sisa_kwh, keterangan)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
           WHERE EXISTS (
             SELECT 1 FROM shift_kasir
             WHERE id = ? AND kasir_id = ? AND status = 'OPEN'
               AND opening_confirmed = 1
              
           )`,
          [
            shiftId,
            session.kasirId,
            waktu,
            data.jenis_kwh,
            data.nominal_pembelian,
            kwhScaled,
            hargaScaled,
            kwhScaled,
            keterangan,
            shiftId,
            session.kasirId
          ],
          function (error) {
            if (error) reject(error);
            else resolve({ id: this.lastID, changes: this.changes });
          }
        );
      });
      if (insertResult.changes !== 1) {
        return sendJson(409, {
          success: false,
          code: "SHIFT_NO_LONGER_OPEN",
          message: "Shift sudah tidak aktif. Muat ulang sesi kasir sebelum mencatat pembelian."
        });
      }

      return sendJson(201, {
        success: true,
        id: insertResult.id,
        jenis_kwh: data.jenis_kwh,
        nominal_pembelian: data.nominal_pembelian,
        kwh_didapat: kwhScaledToDecimal(kwhScaled),
        harga_per_kwh: kwhScaledToDecimal(hargaScaled),
        sisa_kwh: kwhScaledToDecimal(kwhScaled),
        waktu
      });
    } catch (error) {
      if (error instanceof SyntaxError || error.message === "JSON tidak valid") {
        return sendJson(400, { success: false, message: "Format data tidak valid. Kirim JSON yang benar." });
      }
      writeLog("ERROR", "PEMBELIAN_KWH_FAILED", "Gagal mencatat pembelian KWh", {
        error: error.message
      });
      return sendJson(500, {
        success: false,
        message: "Pembelian KWh belum tersimpan karena terjadi kesalahan server."
      });
    }
  }

  // SENSITIVE & PROTECTED API ENDPOINTS
  if (req.method === "POST" && req.url === "/api/lamp/test-check") {
    const session = validateLoginSession(req, res);
    if (!session) return;

    if (lampTestRunning) {
      res.writeHead(409, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ success: false, code: "LAMP_TEST_RUNNING", message: "Lampu sedang dalam pemeriksaan, silakan tunggu hingga selesai." }));
    }

    lampTestRunning = true;

    try {
      // Wait for watchdog to complete current cycle before sending test commands
      const watchdogWaitStart = Date.now();
      let watchdogCleared = false;
      const watchdogPoll = async () => {
        while (Date.now() - watchdogWaitStart < 5000) {
          if (!lampWatchdogRunning) return true;
          await new Promise(r => setTimeout(r, 100));
        }
        return false;
      };
      watchdogCleared = await watchdogPoll();

      if (!watchdogCleared) {
        writeLog("ERROR", "LAMP_TEST_CHECK", "Watchdog belum selesai dalam 5 detik, test tidak dijalankan");
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({
          success: false,
          status: "GAGAL",
          testedAt: new Date().toISOString(),
          message: "Watchdog tidak selesai dalam batas waktu, command test tidak dikirim."
        }));
      }

      // Determining active tables and test tables
      const activeRows = await new Promise((resolve, reject) => {
        db.all(
          `SELECT nomor_meja FROM sesi_meja WHERE status = 'AKTIF'`,
          [],
          (error, rows) => {
            if (error) reject(error);
            else resolve(rows || []);
          }
        );
      });

      const allTables = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
      const activeTables = activeRows
        .map(r => Number(r.nomor_meja))
        .filter(n => Number.isInteger(n) && n >= 1 && n <= 10);
      const testTables = allTables.filter(n => !activeTables.includes(n)).sort((a, b) => a - b);

      if (testTables.length === 0) {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({
          success: true,
          status: "TIDAK_ADA_MEJA_TEST",
          testedAt: new Date().toISOString(),
          activeTables,
          testTables: [],
          results: [],
          summary: { onSuccess: 0, onFailure: 0, offSuccess: 0, offFailure: 0, skipped: 0 }
        }));
      }

      const results = [];
      const tablesTurnedOn = new Set();
      let onSuccess = 0;
      let onFailure = 0;
      let offSuccess = 0;
      let offFailure = 0;
      let skipped = 0;
      let fatalError = null;
      let cleanupFailure = 0;

      const isTableActive = async (table) => {
        const row = await new Promise((resolve, reject) => {
          db.get(
            `SELECT 1 FROM sesi_meja WHERE nomor_meja = ? AND status = 'AKTIF'`,
            [table],
            (error, r) => {
              if (error) reject(error);
              else resolve(r);
            }
          );
        });
        return !!row;
      };

      try {
        // SEQUENTIAL PER-TABLE: ON → wait 2s → re-check → OFF → wait 2s → next
        for (const table of testTables) {
          // 1. Re-check active status before ON
          let tableActiveNow = false;
          try {
            tableActiveNow = await isTableActive(table);
          } catch (checkErr) {
            results.push({ table, phase: "ON", success: false, skipped: true, reason: "ACTIVE_CHECK_FAILED", timestamp: new Date().toISOString() });
            skipped++;
            continue;
          }

          if (tableActiveNow) {
            results.push({ table, phase: "ON", success: false, skipped: true, reason: "TABLE_BECAME_ACTIVE", timestamp: new Date().toISOString() });
            skipped++;
            continue;
          }

          // 2. lampOn
          let onSucceeded = false;
          try {
            const onResult = await lampOn(table);
            if (onResult && onResult.success === true) {
              onSucceeded = true;
              onSuccess++;
              tablesTurnedOn.add(table);
              results.push({ table, phase: "ON", success: true, skipped: false, timestamp: new Date().toISOString() });
            } else {
              onFailure++;
              results.push({ table, phase: "ON", success: false, skipped: false, error: onResult ? onResult.message || onResult.error : "Lamp ON command failed", timestamp: new Date().toISOString() });
            }
          } catch (onErr) {
            onFailure++;
            results.push({ table, phase: "ON", success: false, skipped: false, error: onErr.message, timestamp: new Date().toISOString() });
          }

          // 3. Wait 2 seconds
          await new Promise(r => setTimeout(r, 2000));

          // 4. Re-check active status before OFF — only if ON succeeded
          if (onSucceeded) {
            let activeBeforeOff = false;
            try {
              activeBeforeOff = await isTableActive(table);
            } catch (checkErr) {
              results.push({ table, phase: "OFF", success: false, skipped: true, reason: "ACTIVE_CHECK_FAILED", timestamp: new Date().toISOString() });
              skipped++;
              continue;
            }

            if (activeBeforeOff) {
              results.push({ table, phase: "OFF", success: false, skipped: true, reason: "TABLE_BECAME_ACTIVE", timestamp: new Date().toISOString() });
              skipped++;
              continue;
            }

            // 5. lampOff
            try {
              const offResult = await lampOff(table);
              if (offResult && offResult.success === true) {
                offSuccess++;
                tablesTurnedOn.delete(table);
                results.push({ table, phase: "OFF", success: true, skipped: false, timestamp: new Date().toISOString() });
              } else {
                offFailure++;
                results.push({ table, phase: "OFF", success: false, skipped: false, error: offResult ? offResult.message || offResult.error : "Lamp OFF command failed", timestamp: new Date().toISOString() });
              }
            } catch (offErr) {
              offFailure++;
              results.push({ table, phase: "OFF", success: false, skipped: false, error: offErr.message, timestamp: new Date().toISOString() });
            }

            // 6. Wait 2 seconds before next table
            await new Promise(r => setTimeout(r, 2000));
          }
        }

        // DETERMINE STATUS
        const totalFailures = onFailure + offFailure + cleanupFailure;
        const status = totalFailures > 0 ? "GAGAL" : "NORMAL";

        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({
          success: totalFailures === 0,
          status,
          testedAt: new Date().toISOString(),
          activeTables,
          testTables,
          results,
          summary: { onSuccess, onFailure, offSuccess, offFailure, cleanupFailure, skipped }
        }));
      } catch (fatalErr) {
        fatalError = fatalErr;
      }

      // CLEANUP: if any tables were turned ON, turn them OFF (re-check active status first)
      if (tablesTurnedOn.size > 0) {
        for (const table of tablesTurnedOn) {
          let tableActiveNow = false;
          try {
            tableActiveNow = await isTableActive(table);
          } catch (checkErr) {
            writeLog("WARN", "LAMP_TEST_CLEANUP", `Gagal cek status meja ${table} saat cleanup`, { error: checkErr.message });
            continue;
          }

          if (tableActiveNow) continue;

          try {
            const cleanupResult = await lampOff(table);
            if (cleanupResult && cleanupResult.success === true) {
              writeLog("INFO", "LAMP_TEST_CLEANUP", `Meja ${table} dimatikan sebagai cleanup`);
            } else {
              cleanupFailure++;
              writeLog("WARN", "LAMP_TEST_CLEANUP", `Gagal mematikan meja ${table} saat cleanup`, { cleanupResult });
            }
          } catch (cleanupErr) {
            cleanupFailure++;
            writeLog("ERROR", "LAMP_TEST_CLEANUP", `Error saat cleanup meja ${table}`, { error: cleanupErr.message });
          }
        }
      }

      if (fatalError) {
        writeLog("ERROR", "LAMP_TEST_CHECK", "Fatal error during lamp test", { error: fatalError.message });
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({
          success: false,
          status: "GAGAL",
          testedAt: new Date().toISOString(),
          activeTables,
          testTables,
          results,
          summary: { onSuccess, onFailure, offSuccess, offFailure, cleanupFailure, skipped },
          message: fatalError.message
        }));
      }
    } catch (outerError) {
      writeLog("ERROR", "LAMP_TEST_CHECK", "Outer error during lamp test", { error: outerError.message });
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({
        success: false,
        status: "GAGAL",
        testedAt: new Date().toISOString(),
        message: outerError.message
      }));
    } finally {
      lampTestRunning = false;
    }
    return;
  }

  if (req.method === "POST" && (req.url === "/api/lamp" || req.url === "/api/lamp/on" || req.url === "/api/lamp/off")) {
    const session = validateLoginSession(req, res);
    if (!session) return;

    try {
      const data = await getJsonBody(req);
      const table = Number(data.table);

      if (!Number.isInteger(table) || table < 1 || table > 10) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ success: false, message: "Nomor meja harus antara 1?10." }));
      }

      let result;
      if (req.url === "/api/lamp") {
        const status = Number(data.status);
        if (status !== 0 && status !== 1) {
          res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
          return res.end(JSON.stringify({ success: false, message: "Status must be 0 or 1." }));
        }
        result = await lampSet(table, status);
      } else if (req.url === "/api/lamp/on") {
        result = await lampOn(table);
      } else if (req.url === "/api/lamp/off") {
        result = await lampOff(table);
      }

      if (result && result.success === true) {
        if (req.url === "/api/lamp/off" || (req.url === "/api/lamp" && Number(data.status) === 0)) {
          lastLampCommandState.set(Number(table), 0);
        }
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify(result));
      } else {
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify(result || { success: false, message: "Lamp control failed" }));
      }
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ success: false, message: error.message }));
    }
    return;
  }

  if (req.method === "GET" && req.url.startsWith("/api/barang")) {
    const session = validateLoginSession(req, res);
    if (!session) return;

    try {
      const url = new URL(req.url, `http://localhost:${config.PORT}`);
      const query = url.searchParams.get("q");

      let data;
      let updated;
      if (isShadowCatalogEnabled()) {
        data = await listShadowBarang(getShadowCatalogDatabase());
        data = data.map(item => ({ ...item, updated_at: item.published_at ?? null }));
      } else {
        data = await getLocalBarang();
      }

      data = data.filter(item => String(item.kategori || "").trim().toUpperCase() !== "BONUS");
      if (query && query.trim()) {
        const keyword = query.trim().toLowerCase();
        data = data.filter(item => String(item.nama || "").toLowerCase().includes(keyword));
      }

      // Keep a single catalog ordering in both repositories. Stable sort keeps
      // each repository's existing order for products with the same name.
      data = data
        .map((item, index) => ({ item, index }))
        .sort((a, b) => String(a.item.nama || "").localeCompare(String(b.item.nama || "")) || a.index - b.index)
        .map(entry => entry.item);
      updated = data.length ? data[0].updated_at : null;

      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({
        success: true,
        total: data.length,
        updatedAt: updated,
        data
      }));
    } catch (error) {
      writeLog("ERROR", "MASTER_BARANG_LOCAL", "Gagal membaca Master Barang lokal", { error: error.message });
      res.writeHead(500);
      return res.end(JSON.stringify({ success: false, message: "Gagal membaca Master Barang." }));
    }
  }

  if (req.method === "POST" && req.url === "/api/sync-produk") {
    const session = validateLoginSession(req, res);
    if (!session) return;

    try {
      await respondLocalCatalogSync(db, res);
      return;

    } catch (error) {
      writeLog("ERROR", "SYNC_PRODUK_FAILED", "Sync produk gagal", { error: error.message });
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({
        success: false,
        message: "Sync produk gagal",
        error: error.message
      }));
    }
  }

  if (
    (req.method === "GET" && req.url.startsWith("/api/tarik-tunai/setoran")) ||
    (req.method === "POST" && req.url === "/api/tarik-tunai")
  ) {
    const session = validateLoginSession(req, res);
    if (!session) return;
    const sendJson = (status, payload) => {
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(payload));
    };

    try {
      const url = new URL(req.url, `http://localhost:${config.PORT}`);
      const data = req.method === "POST" ? await getJsonBody(req) : {};
      if (req.method === "POST" && (!data || typeof data !== "object" || Array.isArray(data))) {
        return sendJson(400, { success: false, code: "REQUEST_TIDAK_VALID", message: "Body Tarik Tunai harus berupa object JSON." });
      }
      const rawKodeSetoran = req.method === "GET" ? url.searchParams.get("kode") : data.kodeSetoran;
      const kodeSetoran = typeof rawKodeSetoran === "string" ? rawKodeSetoran.trim() : "";
      requestCode = kodeSetoran;
      if (!kodeSetoran || kodeSetoran.length > 128) {
        return sendJson(400, { success: false, code: "KODE_SETORAN_TIDAK_VALID", message: "Kode Setoran wajib diisi dan maksimal 128 karakter." });
      }

      const currentShift = await new Promise((resolve, reject) => {
        db.get(
          `SELECT id, status, opening_confirmed FROM shift_kasir
           WHERE kasir_id = ? AND (
             (status = 'OPEN' AND date(buka_at, '+8 hours') = date('now', '+8 hours'))
             OR
             (status = 'PENDING_CLOSE' AND date(buka_at, '+8 hours') = date('now', '+8 hours'))
           )
           ORDER BY CASE WHEN status = 'PENDING_CLOSE' THEN 0 ELSE 1 END, id DESC LIMIT 1`,
          [session.kasirId],
          (error, row) => error ? reject(error) : resolve(row || null)
        );
      });

      if (!currentShift) {
        return sendJson(403, { success: false, code: "SHIFT_MISMATCH", message: "Shift OPEN hari ini tidak ditemukan untuk kasir session." });
      }
      if (currentShift.status === "PENDING_CLOSE") {
        return sendJson(423, { success: false, code: "SHIFT_PENDING_CLOSE", message: "Shift sedang menunggu konfirmasi tutup kasir; Tarik Tunai ditolak." });
      }
      if (Number(currentShift.opening_confirmed) !== 1) {
        return sendJson(403, { success: false, code: "OPENING_BALANCE_NOT_CONFIRMED", message: "Saldo awal shift harus dikonfirmasi sebelum Tarik Tunai." });
      }

      if (req.method === "GET") {
        const setoran = await getSetoranByCode(db, kodeSetoran);
        if (!setoran) {
          return sendJson(404, { success: false, code: "SETORAN_TIDAK_DITEMUKAN", message: "Kode Setoran tidak ditemukan." });
        }
        return sendJson(200, {
          success: true,
          setoran: {
            kodeSetoran: setoran.kode_setoran,
            namaKasirSumber: setoran.nama_kasir,
            shiftIdSumber: Number(setoran.shift_id),
            nominalAwal: Number(setoran.nominal_awal),
            saldoTersisa: Number(setoran.saldo_tersisa),
            status: setoran.status,
            tersedia: setoran.status === "AKTIF" && Number(setoran.saldo_tersisa) > 0
          }
        });
      }

      const nominal = data.nominal;
      if (typeof nominal !== "number" || !Number.isSafeInteger(nominal) || nominal <= 0) {
        return sendJson(400, { success: false, code: "NOMINAL_TIDAK_VALID", message: "Nominal Tarik Tunai harus berupa integer positif yang aman." });
      }
      if (!reserveShiftWrite(Number(currentShift.id), res)) {
        return sendJson(423, { success: false, code: "SHIFT_CLOSE_IN_PROGRESS", message: "Proses tutup kasir sedang berlangsung; Tarik Tunai ditolak." });
      }

      const result = await createTarikTunaiWithIsolatedConnection({
        kodeSetoran,
        nominal,
        kasir: session.username,
        kasirId: session.kasirId,
        shiftId: Number(currentShift.id),
        referensiQris: data.referensiQris
      });
      return sendJson(200, { success: true, message: "Tarik Tunai tersimpan.", ...result });
    } catch (error) {
      const clientErrors = {
        KODE_SETORAN_WAJIB: 400,
        NOMINAL_TIDAK_VALID: 400,
        REFERENSI_QRIS_TIDAK_VALID: 400,
        SETORAN_TIDAK_DITEMUKAN: 404,
        SETORAN_TIDAK_AKTIF: 409,
        SALDO_SETORAN_TIDAK_CUKUP: 409
      };
      if (error.code && clientErrors[error.code]) {
        return sendJson(clientErrors[error.code], { success: false, code: error.code, message: error.message });
      }
      if (error.message && error.message.includes("SHIFT_NOT_OPEN")) {
        return sendJson(423, { success: false, code: "SHIFT_PENDING_CLOSE", message: "Shift sedang menunggu atau telah selesai ditutup; Tarik Tunai ditolak." });
      }
      writeLog("ERROR", "TARIK_TUNAI_ERROR", error.message, { kodeSetoran: requestCode });
      return sendJson(500, { success: false, code: "TARIK_TUNAI_GAGAL", message: "Tarik Tunai gagal diproses." });
    }
  }

  // ==================================================
  // POST /api/transaksi (SERVER AUTHORITATIVE & ATOMIC)
  // ==================================================
  if (req.method === "POST" && req.url === "/api/transaksi") {
    const session = validateLoginSession(req, res);
    if (!session) return;

    try {
      const data = await getJsonBody(req);

      if (data.kasir && data.kasir !== session.username && data.kasir !== String(session.kasirId)) {
        res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ success: false, code: "KASIR_MISMATCH", message: "Kasir request tidak sesuai dengan session" }));
      }

      const currentShift = await new Promise((resolve, reject) => {
        db.get(`SELECT id, status, opening_confirmed FROM shift_kasir
                WHERE kasir_id = ?
                  AND (
                    (status = 'OPEN' AND date(buka_at, '+8 hours') = date('now', '+8 hours'))
                    OR
                    (status = 'PENDING_CLOSE' AND date(buka_at, '+8 hours') = date('now', '+8 hours'))
                  )
                ORDER BY CASE WHEN status = 'PENDING_CLOSE' THEN 0 ELSE 1 END, id DESC LIMIT 1`, [session.kasirId], (err, row) => {
          if (err) reject(err);
          else resolve(row || null);
        });
      });
      if (!currentShift) {
        res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ success: false, code: "SHIFT_MISMATCH", message: "Shift OPEN hari ini tidak ditemukan untuk kasir session" }));
      }
      if (Number(data.shiftId) !== Number(currentShift.id)) {
        res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ success: false, code: "SHIFT_MISMATCH", message: "Shift tidak valid atau bukan shift hari ini milik kasir session" }));
      }
      if (currentShift.status === "PENDING_CLOSE") {
        res.writeHead(423, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ success: false, code: "SHIFT_PENDING_CLOSE", message: "Shift sedang menunggu konfirmasi tutup kasir; transaksi baru ditolak." }));
      }
      if (Number(currentShift.opening_confirmed) !== 1) {
        res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ success: false, code: "OPENING_BALANCE_NOT_CONFIRMED", message: "Saldo awal shift harus dikonfirmasi sebelum transaksi" }));
      }
      if (!reserveShiftWrite(Number(currentShift.id), res)) {
        res.writeHead(423, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ success: false, code: "SHIFT_CLOSE_IN_PROGRESS", message: "Proses tutup kasir sedang berlangsung; transaksi baru ditolak." }));
      }

      if (!["CASH", "QRIS", "CASH+QRIS", "GRATIS"].includes(data.metodePembayaran)) {
        throw new Error("Metode pembayaran tidak valid");
      }
      if (!Array.isArray(data.items) || !data.items.length) {
        throw new Error("Items transaksi kosong");
      }

      let nomorMeja = null;
      if (data.nomorMeja !== undefined && data.nomorMeja !== null && data.nomorMeja !== "") {
        nomorMeja = Number(data.nomorMeja);
        if (!Number.isInteger(nomorMeja) || nomorMeja < 1 || nomorMeja > 10) {
          throw new Error("Nomor meja harus integer 1 sampai 10");
        }
      }

      const sessionIdInput = data.sessionId ? String(data.sessionId).trim() : null;

      let transactionCommitted = false;
      await runAsync("BEGIN TRANSACTION");

      try {
        let tableSession = null;
        if (sessionIdInput) {
          tableSession = await new Promise((resolve, reject) => {
            db.get(`SELECT * FROM sesi_meja WHERE session_id = ?`, [sessionIdInput], (err, row) => {
              if (err) reject(err);
              else resolve(row);
            });
          });

          if (!tableSession) {
            await runAsync("ROLLBACK");
            res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
            return res.end(JSON.stringify({ success: false, code: "INVALID_SESSION", message: "Session ID tidak ditemukan di database" }));
          }

          if (tableSession.status === "DIBAYAR") {
            await runAsync("ROLLBACK");
            res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
            return res.end(JSON.stringify({ success: false, code: "SESSION_ALREADY_PAID", message: "Sesi meja ini sudah dibayar" }));
          }

          const existingTx = await new Promise((resolve, reject) => {
            db.get(`SELECT id FROM transaksi WHERE session_id = ?`, [sessionIdInput], (err, row) => {
              if (err) reject(err);
              else resolve(row);
            });
          });

          if (existingTx) {
            await runAsync("ROLLBACK");
            res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
            return res.end(JSON.stringify({ success: false, code: "SESSION_ALREADY_PAID", message: "Sesi meja ini sudah dibayar" }));
          }

          if (nomorMeja !== null && tableSession.nomor_meja !== nomorMeja) {
            await runAsync("ROLLBACK");
            res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
            return res.end(JSON.stringify({ success: false, code: "MEJA_MISMATCH", message: `Session ${sessionIdInput} milik Meja ${tableSession.nomor_meja}, tidak sesuai dengan request Meja ${nomorMeja}` }));
          }

          if (nomorMeja === null) {
            nomorMeja = tableSession.nomor_meja;
          }
        }

        const sessionIdToSave = tableSession ? tableSession.session_id : null;
        const nomorMejaToSave = tableSession ? tableSession.nomor_meja : nomorMeja;
        const memberIdToSave = tableSession
          ? (tableSession.member_id || null)
          : (data.memberId ? String(data.memberId).trim() : null);

        const masterBarang = await getLocalBarang();
        const detail = [];
        let total = 0;

        for (const item of data.items) {
          const nama = String(item.nama || "").trim().toLowerCase();
          const clientQty = Number(item.qty);

          if (!nama) {
            throw new Error("Nama barang tidak boleh kosong");
          }

          const isLossItem = (nama === "billiard waktu loss");
          const isTableServiceItem = (nama === "meja billiard" || nama === "meja pagi" || nama === "meja malam" || nama === "1 jam");
          const isBonusItem = (nama === "kopi bonus" || nama === "es teh bonus");

          if (isLossItem) {
            if (!sessionIdInput || !tableSession) {
              res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
              await runAsync("ROLLBACK");
              return res.end(JSON.stringify({ success: false, code: "MISSING_LOSS_SESSION", message: "Transaksi Billiard Waktu Loss wajib menyertakan sessionId yang valid" }));
            }

            const activeSesi = tableSession;

            if (nomorMejaToSave !== null && activeSesi.nomor_meja !== nomorMejaToSave) {
              res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
              await runAsync("ROLLBACK");
              return res.end(JSON.stringify({ success: false, code: "MEJA_MISMATCH", message: `Session ID tidak sesuai dengan nomor meja (${activeSesi.nomor_meja} vs ${nomorMejaToSave})` }));
            }

            if (activeSesi.status === "AKTIF") {
              res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
              await runAsync("ROLLBACK");
              return res.end(JSON.stringify({ success: false, code: "LOSS_NOT_STOPPED", message: "Sesi Loss belum dihentikan (status masih AKTIF). Hentikan sesi dahulu!" }));
            }

            if (activeSesi.status === "DIBAYAR") {
              res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
              await runAsync("ROLLBACK");
              return res.end(JSON.stringify({ success: false, code: "SESSION_ALREADY_PAID", message: "Sesi meja ini sudah dibayar" }));
            }

            if (String(activeSesi.jenis_sesi || "").toUpperCase() !== "LOSS") {
              res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
              await runAsync("ROLLBACK");
              return res.end(JSON.stringify({ success: false, code: "INVALID_SESSION_TYPE", message: "Session ID tersebut bukan sesi WAKTU LOSS" }));
            }

            if (!activeSesi.waktu_selesai) {
              res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
              await runAsync("ROLLBACK");
              return res.end(JSON.stringify({ success: false, code: "INVALID_WAKTU_SELESAI", message: "Sesi Loss belum memiliki waktu selesai yang valid" }));
            }

            const pesananItems = await getSessionItems(activeSesi.session_id);
            const lossPesanan = pesananItems.find(p => String(p.nama_barang || "").trim().toLowerCase() === "billiard waktu loss");

            if (!lossPesanan) {
              res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
              await runAsync("ROLLBACK");
              return res.end(JSON.stringify({ success: false, code: "LOSS_ITEM_NOT_FOUND", message: "Item Billiard Waktu Loss tidak ditemukan di pesanan_meja server" }));
            }

            const serverQty = Number(lossPesanan.qty);
            const serverHarga = Number(lossPesanan.harga_jual);
            const serverSubtotal = Number(lossPesanan.subtotal);

            if (!Number.isInteger(serverQty) || serverQty < 0) {
              res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
              await runAsync("ROLLBACK");
              return res.end(JSON.stringify({ success: false, code: "INVALID_LOSS_QTY", message: "Qty waktu loss tidak valid" }));
            }

            if (serverHarga !== 500) {
              res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
              await runAsync("ROLLBACK");
              return res.end(JSON.stringify({ success: false, code: "INVALID_LOSS_PRICE", message: "Harga per menit waktu loss harus Rp500" }));
            }

            const expectedSubtotal = serverQty * 500;
            if (!Number.isFinite(serverSubtotal) || serverSubtotal !== expectedSubtotal) {
              res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
              await runAsync("ROLLBACK");
              return res.end(JSON.stringify({ success: false, code: "INVALID_LOSS_SUBTOTAL", message: "Subtotal waktu loss tidak cocok dengan perhitungan server" }));
            }

            detail.push({
              barangId: null,
              nama: "Billiard Waktu Loss",
              qty: serverQty,
              hargaJual: 500,
              hpp: 0,
              subtotal: expectedSubtotal,
              isService: true
            });

            total += expectedSubtotal;
            continue;
          }

          if (isTableServiceItem || isBonusItem) {
            if (isBonusItem && !tableSession) {
              throw new Error("Bonus sesi hanya dapat dibayar bersama sesi meja yang valid");
            }
            let serviceQty = clientQty;
            let serviceHarga = Number(item.hargaJual || item.harga_jual || 0);
            let serviceSubtotal = 0;
            let usesClientQty = true;

            if (tableSession) {
              const pesananItems = await getSessionItems(tableSession.session_id);
              const matchingPesanan = pesananItems.find(p => String(p.nama_barang || "").trim().toLowerCase() === nama);
              if (!matchingPesanan) {
                res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
                await runAsync("ROLLBACK");
                return res.end(JSON.stringify({ success: false, code: "TABLE_SERVICE_ITEM_NOT_FOUND", message: `Item layanan meja ${item.nama} tidak ditemukan di pesanan_meja untuk sesi ini` }));
              }

              serviceQty = Number(matchingPesanan.qty);
              serviceHarga = Number(matchingPesanan.harga_jual);
              serviceSubtotal = Number(matchingPesanan.subtotal);
              usesClientQty = false;
              if (isBonusItem && (serviceHarga !== 0 || serviceSubtotal !== 0)) {
                res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
                await runAsync("ROLLBACK");
                return res.end(JSON.stringify({ success: false, code: "INVALID_BONUS_PRICE", message: "Bonus sesi wajib berharga Rp0" }));
              }
              if (String(tableSession.jenis_sesi || "").trim().toUpperCase() === "KARYAWAN") {
                serviceHarga = 0;
                serviceSubtotal = 0;
              }
            } else {
              if (serviceHarga <= 0) {
                const masterServ = masterBarang.find(x => String(x.nama || "").trim().toLowerCase() === nama);
                serviceHarga = masterServ ? Number(masterServ.hargaJual) : 0;
              }
            }

            if (usesClientQty) {
              if (!Number.isFinite(clientQty) || clientQty <= 0) {
                throw new Error(`Qty barang tidak valid: ${item.nama}`);
              }
              if (!Number.isFinite(serviceHarga) || serviceHarga < 0) {
                throw new Error(`Harga barang tidak valid: ${item.nama}`);
              }
              serviceSubtotal = serviceHarga * serviceQty;
            }

            detail.push({
              barangId: null,
              nama: item.nama,
              qty: serviceQty,
              hargaJual: serviceHarga,
              hpp: Number(item.hpp || 0),
              subtotal: serviceSubtotal,
              isService: true
            });

            total += serviceSubtotal;
            continue;
          }

          if (!Number.isInteger(clientQty) || clientQty <= 0) {
            throw new Error(`Qty barang tidak valid: ${item.nama}`);
          }

          const namaLookup = nama === "paket 3 jam" ? "paket 3 jam non member" : nama;
          const barang = masterBarang.find(x => String(x.nama || "").trim().toLowerCase() === namaLookup);
          if (!barang) {
            throw new Error(`Barang tidak ditemukan: ${item.nama}`);
          }

          if (Number(barang.stokAktual) < clientQty) {
            throw new Error(`Stok tidak mencukupi untuk barang: ${barang.nama}`);
          }

          const hargaMaster = Number(barang.hargaJual || 0);
          const hargaClient = Number(item.hargaJual);
          const hargaJual =
            Number.isFinite(hargaClient) && hargaClient === hargaMaster
              ? hargaClient
              : hargaMaster;
          const hpp = Number(barang.hpp || 0);
          const subtotal = hargaJual * clientQty;

          detail.push({
            barangId: barang.id,
            nama: barang.nama,
            qty: clientQty,
            hargaJual: hargaJual,
            hpp: hpp,
            subtotal: subtotal,
            isService: false
          });

          total += subtotal;
        }

        const payment = resolvePaymentAmounts({
          total,
          method: data.metodePembayaran,
          cashAmount: parseNominal(data.cashAmount),
          qrisAmount: parseNominal(data.qrisAmount),
          cashPaid: parseNominal(data.bayar),
          tableSession,
          details: detail
        });
        const now = new Date();
        const tanggal = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
        const jam = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}`;
        const nomorTransaksi = await generateNomorTransaksi(now);

        const transaksiId = await recordTransaction(db, {
          transaction: {
            nomorTransaksi,
            tanggal,
            jam,
            kasir: session.username,
            total,
            method: payment.method,
            shiftId: data.shiftId,
            bayar: payment.bayar,
            kembalian: payment.kembalian,
            cashAmount: payment.cashAmount,
            qrisAmount: payment.qrisAmount,
            nomorMeja: nomorMejaToSave,
            sessionId: sessionIdToSave,
            memberId: memberIdToSave
          },
          details: detail,
          tableSession
        });

        await runAsync("COMMIT");
        transactionCommitted = true;

        if (tableSession) {
          try {
            const lampRes = await lampOff(tableSession.nomor_meja);
            if (lampRes && lampRes.success === true) {
              lastLampCommandState.set(Number(tableSession.nomor_meja), 0);
            }
            if (!lampRes || lampRes.success !== true) {
              writeLog(
                "WARN",
                "LAMP_OFF_FAILED_AFTER_PAYMENT",
                "Pembayaran berhasil tetapi lampu gagal dimatikan",
                {
                  nomorMeja: tableSession.nomor_meja,
                  sessionId: tableSession.session_id,
                  lampRes
                }
              );
            }
          } catch (lampErr) {
            writeLog(
              "ERROR",
              "LAMP_OFF_ERROR_AFTER_PAYMENT",
              "Pembayaran berhasil tetapi terjadi error saat mematikan lampu",
              {
                nomorMeja: tableSession.nomor_meja,
                sessionId: tableSession.session_id,
                error: lampErr.message
              }
            );
          }
        }

        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({
          success: true,
          message: "Transaksi tersimpan",
          nomorTransaksi,
          transaksiId,
          nomorMeja: nomorMejaToSave,
          sessionId: sessionIdToSave,
          total,
          bayar: payment.bayar,
          cashAmount: payment.cashAmount,
          qrisAmount: payment.qrisAmount,
          kembalian: payment.kembalian
        }));

        return;

      } catch (txErr) {
        if (!transactionCommitted) {
          await runAsync("ROLLBACK");
        }
        if (txErr.message && txErr.message.includes("SHIFT_NOT_OPEN")) {
          res.writeHead(423, { "Content-Type": "application/json; charset=utf-8" });
          return res.end(JSON.stringify({ success: false, code: "SHIFT_PENDING_CLOSE", message: "Shift sedang menunggu atau telah selesai ditutup; transaksi baru ditolak." }));
        }
        if (txErr.message && (txErr.message.includes("UNIQUE constraint failed") || txErr.message.includes("SQLITE_CONSTRAINT") || txErr.message.includes("SESSION_ALREADY_PAID"))) {
          res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
          return res.end(JSON.stringify({ success: false, code: "SESSION_ALREADY_PAID", message: "Sesi meja ini sudah dibayar" }));
        }
        throw txErr;
      }

    } catch (error) {
      writeLog("ERROR", "TRANSACTION_ERROR", error.message);
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ success: false, message: error.message }));
    }
  }

  if (req.method === "POST" && req.url === "/api/transaksi/batalkan") {
    const session = validateLoginSession(req, res);
    if (!session) return;

    try {
      const data = await getJsonBody(req);
      const nomorTransaksi = String(data.nomorTransaksi || "").trim();
      const code = String(data.code || "").trim();

      if (!nomorTransaksi) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ success: false, message: "Nomor transaksi wajib diisi" }));
      }

      const transaksi = await new Promise((resolve, reject) => {
        db.get(
          `SELECT * FROM transaksi WHERE nomor_transaksi = ?`,
          [nomorTransaksi],
          (err, row) => {
            if (err) reject(err);
            else resolve(row);
          }
        );
      });

      if (!transaksi) {
        res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ success: false, message: "Transaksi tidak ditemukan" }));
      }

      if (transaksi.status_sync === "BATAL" || transaksi.status_sync === "CANCELLED") {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ success: false, message: "Transaksi sudah dibatalkan" }));
      }
      if (String(transaksi.tipe_transaksi || "PENJUALAN") === "TARIK_TUNAI") {
        res.writeHead(409, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ success: false, code: "TARIK_TUNAI_TIDAK_DAPAT_DIBATALKAN", message: "Tarik Tunai tidak dapat dibatalkan melalui alur pembatalan penjualan." }));
      }

      if (transaksi.shift_id != null) {
        const txShift = await new Promise((resolve, reject) => {
          db.get(`SELECT status FROM shift_kasir WHERE id = ?`, [transaksi.shift_id], (err, row) => {
            if (err) reject(err);
            else resolve(row || null);
          });
        });
        if (!txShift || txShift.status !== "OPEN") {
          res.writeHead(423, { "Content-Type": "application/json; charset=utf-8" });
          return res.end(JSON.stringify({ success: false, code: "SHIFT_PENDING_CLOSE", message: "Transaksi tidak dapat dibatalkan setelah proses tutup kasir dimulai." }));
        }
        if (!reserveShiftWrite(Number(transaksi.shift_id), res)) {
          res.writeHead(423, { "Content-Type": "application/json; charset=utf-8" });
          return res.end(JSON.stringify({ success: false, code: "SHIFT_CLOSE_IN_PROGRESS", message: "Proses tutup kasir sedang berlangsung; pembatalan transaksi ditolak." }));
        }
      }

      const totpRes = await verifyManagerTotpOnce(code);
      if (!totpRes.success) {
        const statusCode = totpRes.code === "TOTP_CONFIG_ERROR" ? 500 : 401;
        res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ success: false, code: totpRes.code, message: totpRes.message }));
      }

      const detailBatal = await getTransactionDetails(transaksi.id);

      await runAsync("BEGIN TRANSACTION");
      try {
        for (const item of detailBatal) {
          const namaBarang = String(item.nama_barang || "").trim();
          if (!namaBarang) continue;

          const namaLower = namaBarang.toLowerCase();
          const isService =
            namaLower === "billiard waktu loss" ||
            namaLower === "meja billiard" ||
            namaLower === "meja pagi" ||
            namaLower === "meja malam" ||
            namaLower === "1 jam";

          if (isService) continue;

          const masterNamaLookup = namaBarang.trim() === "Paket 3 Jam" ? "Paket 3 Jam Non Member" : namaBarang;
          const master = await new Promise((resolve, reject) => {
            db.get(
              `SELECT id FROM master_barang WHERE LOWER(TRIM(nama)) = LOWER(TRIM(?)) LIMIT 1`,
              [masterNamaLookup],
              (err, row) => {
                if (err) reject(err);
                else resolve(row);
              }
            );
          });

          if (!master) {
            throw new Error(`Master barang tidak ditemukan saat rollback stok: ${namaBarang}`);
          }

          const qty = Number(item.qty || 0);
          if (!Number.isInteger(qty) || qty <= 0) {
            throw new Error(`Qty rollback tidak valid untuk barang: ${namaBarang}`);
          }

          await runAsync(
            `UPDATE master_barang SET stok_aktual = stok_aktual + ? WHERE id = ?`,
            [qty, master.id]
          );
        }

        await runAsync(
          `UPDATE transaksi SET status_sync = 'BATAL' WHERE id = ?`,
          [transaksi.id]
        );

        await runAsync("COMMIT");
      } catch (rollbackErr) {
        try {
          await runAsync("ROLLBACK");
        } catch (_) {}
        throw rollbackErr;
      }

      writeLog("INFO", "TRANSAKSI_BATAL", `Transaksi ${nomorTransaksi} dibatalkan oleh Manager`, {
        nomorTransaksi: transaksi.nomor_transaksi,
        kasir: transaksi.kasir,
        waktuPembatalan: new Date().toISOString()
      });

      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({
        success: true,
        message: "Transaksi berhasil dibatalkan",
        nomorTransaksi: nomorTransaksi
      }));

    } catch (error) {
      writeLog("ERROR", "TRANSAKSI_BATAL_ERROR", error.message);
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ success: false, message: error.message }));
    }
  }

  if (req.method === "POST" && req.url === "/api/kas-laci/uang-keluar") {
    const session = validateLoginSession(req, res);
    if (!session) return;
    const sendJson = (status, payload) => { res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" }); res.end(JSON.stringify(payload)); };
    try {
      const data = await getJsonBody(req);
      if (!data || typeof data !== "object" || Array.isArray(data) || Object.keys(data).some(key => !["nominal", "keterangan"].includes(key))) {
        return sendJson(400, { success: false, code: "BODY_TIDAK_VALID", message: "Body hanya boleh berisi nominal dan keterangan." });
      }
      const nominal = data.nominal;
      if (typeof nominal !== "number" || !Number.isSafeInteger(nominal) || nominal <= 0) return sendJson(400, { success: false, code: "NOMINAL_TIDAK_VALID", message: "Nominal harus berupa integer rupiah positif." });
      if (data.keterangan !== undefined && typeof data.keterangan !== "string") return sendJson(400, { success: false, code: "KETERANGAN_TIDAK_VALID", message: "Keterangan harus berupa teks." });
      const keterangan = String(data.keterangan || "").trim();
      if (!keterangan) return sendJson(400, { success: false, code: "KETERANGAN_TIDAK_VALID", message: "Keterangan wajib diisi." });
      if (keterangan.length > 200) return sendJson(400, { success: false, code: "KETERANGAN_TIDAK_VALID", message: "Keterangan maksimal 200 karakter." });
      const connection = await new Promise((resolve, reject) => {
        const conn = new sqlite3.Database(path.join(__dirname, "pos.db"), error => error ? reject(error) : resolve(conn));
      });
      let inTransaction = false;
      try {
        const run = (sql, params = []) => new Promise((resolve, reject) => connection.run(sql, params, function (error) { error ? reject(error) : resolve(this); }));
        const get = (sql, params = []) => new Promise((resolve, reject) => connection.get(sql, params, (error, row) => error ? reject(error) : resolve(row || null)));
        await run("BEGIN IMMEDIATE"); inTransaction = true;
        const cashier = await get(`SELECT id, nama FROM kasir WHERE id = ?`, [session.kasirId]);
        if (!cashier) { const error = new Error("Kasir pada session tidak ditemukan."); error.code = "KASIR_TIDAK_DITEMUKAN"; throw error; }
        const balanceRow = await get(`SELECT c.saldo_awal + COALESCE(SUM(CASE WHEN t.jenis = 'UANG_MASUK' THEN t.nominal WHEN t.jenis = 'UANG_KELUAR' THEN -t.nominal ELSE 0 END), 0) AS saldo FROM kas_laci_config c LEFT JOIN kas_laci_transaksi t ON 1 = 1 WHERE c.id = 1 GROUP BY c.saldo_awal`);
        if (!balanceRow || !Number.isSafeInteger(Number(balanceRow.saldo))) { const error = new Error("Konfigurasi atau saldo Kas Laci tidak valid."); error.code = "KAS_LACI_TIDAK_VALID"; throw error; }
        const saldoKasLaciSebelum = Number(balanceRow.saldo);
        if (nominal > saldoKasLaciSebelum) { const error = new Error(`Saldo Kas Laci tidak cukup. Saldo tersedia ${saldoKasLaciSebelum}, nominal Uang Keluar ${nominal}.`); error.code = "SALDO_KAS_LACI_TIDAK_CUKUP"; throw error; }
        const last = await get(`SELECT MAX(CAST(substr(transaction_id, 4) AS INTEGER)) AS nomor FROM kas_laci_transaksi WHERE jenis = 'UANG_KELUAR' AND transaction_id GLOB 'KLK[0-9]*' AND substr(transaction_id, 4) NOT GLOB '*[^0-9]*'`);
        const nomorBerikutnya = Number(last && last.nomor || 0) + 1;
        if (!Number.isSafeInteger(nomorBerikutnya)) throw new Error("Nomor transaksi Uang Keluar sudah mencapai batas.");
        const transactionId = `KLK${String(nomorBerikutnya).padStart(4, "0")}`;
        const now = new Date().toISOString();
        const saldoKasLaciSesudah = saldoKasLaciSebelum - nominal;
        await run(`INSERT INTO kas_laci_transaksi (transaction_id, jenis, nominal, keterangan, kasir_id, kasir, waktu, kode_setoran) VALUES (?, 'UANG_KELUAR', ?, ?, ?, ?, ?, '')`, [transactionId, nominal, keterangan, cashier.id, cashier.nama, now]);
        await run("COMMIT"); inTransaction = false;
        return sendJson(200, { success: true, transactionId, kasir: cashier.nama, nominal, keterangan, waktu: now, saldoKasLaciSebelum, saldoKasLaciSesudah });
      } catch (error) {
        if (inTransaction) { try { await new Promise((resolve, reject) => connection.run("ROLLBACK", rollbackError => rollbackError ? reject(rollbackError) : resolve())); } catch (_) {} }
        if (["SALDO_KAS_LACI_TIDAK_CUKUP", "KASIR_TIDAK_DITEMUKAN", "KAS_LACI_TIDAK_VALID"].includes(error.code)) return sendJson(error.code === "KASIR_TIDAK_DITEMUKAN" ? 401 : 409, { success: false, code: error.code, message: error.message });
        throw error;
      } finally { connection.close(); }
    } catch (error) { console.error("Kas Laci Uang Keluar gagal:", error); return sendJson(500, { success: false, message: "Uang Keluar gagal disimpan." }); }
  }

  if ((req.method === "GET" && req.url.startsWith("/api/kas-laci/setoran?")) || (req.method === "POST" && req.url === "/api/kas-laci/uang-masuk")) {
    const session = validateLoginSession(req, res);
    if (!session) return;
    const sendJson = (status, payload) => { res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" }); res.end(JSON.stringify(payload)); };
    try {
      const url = new URL(req.url, "https://localhost");
      const data = req.method === "POST" ? await getJsonBody(req) : {};
      const kodeSetoran = String(req.method === "GET" ? url.searchParams.get("kode") || "" : data.kodeSetoran || "").trim();
      if (!kodeSetoran || kodeSetoran.length > 128) return sendJson(400, { success: false, code: "KODE_SETORAN_TIDAK_VALID", message: "Kode Setoran wajib diisi." });
      if (req.method === "GET") {
        const setoran = await getSetoranByCode(db, kodeSetoran);
        if (!setoran) return sendJson(404, { success: false, code: "SETORAN_TIDAK_DITEMUKAN", message: "Kode Setoran tidak ditemukan." });
        if (setoran.status !== "AKTIF" || !Number.isSafeInteger(Number(setoran.saldo_tersisa)) || Number(setoran.saldo_tersisa) <= 0) return sendJson(409, { success: false, code: "SETORAN_TIDAK_AKTIF", message: "Setoran tidak aktif atau saldonya sudah habis." });
        return sendJson(200, { success: true, setoran: { kodeSetoran: setoran.kode_setoran, saldoTersisa: Number(setoran.saldo_tersisa) } });
      }
      const nominal = data.nominal;
      const keterangan = String(data.keterangan || "").trim();
      if (typeof nominal !== "number" || !Number.isSafeInteger(nominal) || nominal <= 0) return sendJson(400, { success: false, code: "NOMINAL_TIDAK_VALID", message: "Nominal harus berupa integer positif yang aman." });
      if (keterangan.length > 200) return sendJson(400, { success: false, code: "KETERANGAN_TIDAK_VALID", message: "Keterangan maksimal 200 karakter." });
      const connection = await new Promise((resolve, reject) => {
        const conn = new sqlite3.Database(path.join(__dirname, "pos.db"), error => error ? reject(error) : resolve(conn));
      });
      let inTransaction = false;
      try {
        const run = (sql, params = []) => new Promise((resolve, reject) => connection.run(sql, params, function (error) { error ? reject(error) : resolve(this); }));
        const get = (sql, params = []) => new Promise((resolve, reject) => connection.get(sql, params, (error, row) => error ? reject(error) : resolve(row || null)));
        await run("BEGIN IMMEDIATE"); inTransaction = true;
        const setoran = await get(`SELECT s.id, s.kode_setoran, s.nominal_awal, s.saldo_tersisa, s.status FROM setoran s WHERE s.kode_setoran = ? COLLATE NOCASE`, [kodeSetoran]);
        if (!setoran) { const error = new Error("Kode Setoran tidak ditemukan."); error.code = "SETORAN_TIDAK_DITEMUKAN"; throw error; }
        const before = Number(setoran.saldo_tersisa);
        if (setoran.status !== "AKTIF" || !Number.isSafeInteger(before) || before <= 0) { const error = new Error("Setoran tidak aktif atau saldonya sudah habis."); error.code = "SETORAN_TIDAK_AKTIF"; throw error; }
        if (nominal > before) { const error = new Error("Nominal melebihi saldo Setoran yang tersedia."); error.code = "SALDO_SETORAN_TIDAK_CUKUP"; throw error; }
        const cashier = await get(`SELECT id, nama FROM kasir WHERE id = ?`, [session.kasirId]);
        if (!cashier) { const error = new Error("Kasir pada session tidak ditemukan."); error.code = "KASIR_TIDAK_DITEMUKAN"; throw error; }
        const last = await get(`SELECT MAX(CAST(substr(transaction_id, 4) AS INTEGER)) AS nomor FROM kas_laci_transaksi WHERE jenis = 'UANG_MASUK'`);
        const transactionId = `KLM${String(Number(last && last.nomor || 0) + 1).padStart(4, "0")}`;
        const now = new Date().toISOString();
        const after = before - nominal;
        const updated = await run(`UPDATE setoran SET saldo_tersisa = ?, status = ? WHERE id = ? AND status = 'AKTIF' AND saldo_tersisa = ?`, [after, after === 0 ? "HABIS" : "AKTIF", setoran.id, before]);
        if (updated.changes !== 1) { const error = new Error("Saldo Setoran berubah; silakan validasi ulang."); error.code = "SETORAN_BERUBAH"; throw error; }
        await run(`INSERT INTO kas_laci_transaksi (transaction_id, jenis, nominal, keterangan, kasir_id, kasir, waktu, kode_setoran) VALUES (?, 'UANG_MASUK', ?, ?, ?, ?, ?, ?)`, [transactionId, nominal, keterangan, cashier.id, cashier.nama, now, setoran.kode_setoran]);
        const balance = await get(`SELECT c.saldo_awal + COALESCE(SUM(CASE WHEN t.jenis = 'UANG_MASUK' THEN t.nominal WHEN t.jenis = 'UANG_KELUAR' THEN -t.nominal ELSE 0 END), 0) AS saldo FROM kas_laci_config c LEFT JOIN kas_laci_transaksi t ON 1 = 1 WHERE c.id = 1 GROUP BY c.saldo_awal`);
        await run("COMMIT"); inTransaction = false;
        return sendJson(200, { success: true, transactionId, kasir: cashier.nama, kodeSetoran: setoran.kode_setoran, nominalAwal: Number(setoran.nominal_awal), saldoSetoranSebelum: before, nominalUangMasuk: nominal, saldoSetoranSesudah: after, saldoKasLaci: Number(balance && balance.saldo || 0), waktu: now, keterangan });
      } catch (error) {
        if (inTransaction) { try { await new Promise((resolve, reject) => connection.run("ROLLBACK", rollbackError => rollbackError ? reject(rollbackError) : resolve())); } catch (_) {} }
        if (["SETORAN_TIDAK_DITEMUKAN", "SETORAN_TIDAK_AKTIF", "SALDO_SETORAN_TIDAK_CUKUP", "SETORAN_BERUBAH", "KASIR_TIDAK_DITEMUKAN"].includes(error.code)) return sendJson(error.code === "SETORAN_TIDAK_DITEMUKAN" ? 404 : 409, { success: false, code: error.code, message: error.message });
        throw error;
      } finally { connection.close(); }
    } catch (error) { console.error("Kas Laci Uang Masuk gagal:", error); return sendJson(500, { success: false, message: "Uang Masuk gagal disimpan." }); }
  }

  if (req.method === "GET" && (req.url === "/api/kasir/kas-laci-saldo" || req.url.startsWith("/api/kasir/kas-laci-saldo?"))) {
    const session = validateLoginSession(req, res);
    if (!session) return;
    const sendJson = (status, payload) => { res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" }); res.end(JSON.stringify(payload)); };
    db.get(`SELECT c.saldo_awal + COALESCE(SUM(CASE WHEN t.jenis = 'UANG_MASUK' THEN t.nominal WHEN t.jenis = 'UANG_KELUAR' THEN -t.nominal ELSE 0 END), 0) AS saldo FROM kas_laci_config c LEFT JOIN kas_laci_transaksi t ON 1 = 1 WHERE c.id = 1 GROUP BY c.saldo_awal`, [], (balanceError, row) => {
      if (balanceError) return sendJson(500, { success: false, message: balanceError.message });
      sendJson(200, { success: true, saldoKasLaci: Number(row && row.saldo || 0) });
    });
    return;
  }

  if ((req.method === "GET" && req.url.startsWith("/api/kasir/kas?")) || (req.method === "POST" && ["/api/kasir/kas-masuk", "/api/kasir/kas-keluar"].includes(req.url))) {
    const session = validateLoginSession(req, res);
    if (!session) return;
    const sendJson = (status, payload) => { res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" }); res.end(JSON.stringify(payload)); };
    try {
      const url = new URL(req.url, "https://localhost");
      const data = req.method === "POST" ? await getJsonBody(req) : {};
      const shiftId = Number(req.method === "GET" ? url.searchParams.get("shiftId") : data.shiftId);
      if (!Number.isSafeInteger(shiftId) || shiftId <= 0) throw new Error("shiftId tidak valid");
      if (req.method === "POST" && !reserveShiftWrite(shiftId, res)) {
        return sendJson(423, { success: false, code: "SHIFT_CLOSE_IN_PROGRESS", message: "Proses tutup kasir sedang berlangsung untuk shift ini." });
      }
      db.get(`SELECT * FROM shift_kasir WHERE id = ? AND kasir_id = ? AND status = 'OPEN'`, [shiftId, session.kasirId], (shiftError, shift) => {
        if (shiftError) return sendJson(500, { success: false, message: shiftError.message });
        if (!shift) return sendJson(403, { success: false, code: "SHIFT_MISMATCH", message: "Shift bukan milik kasir session atau sudah ditutup" });
        const finish = (masuk, keluar) => {
          db.all(`SELECT total, metode_pembayaran, cash_amount, qris_amount, tipe_transaksi, status_sync FROM transaksi WHERE shift_id = ?`, [shiftId], (txError, transaksi) => {
          if (txError) return sendJson(500, { success: false, message: txError.message });
          const salesCash = summarizeTransactions(transaksi).totalCash;
          const saldoKas = Number(shift.saldo_awal || 0) + masuk.reduce((n, row) => n + Number(row.nominal || 0), 0) + salesCash - keluar.reduce((n, row) => n + Number(row.nominal || 0), 0);
          if (req.method === "GET") return sendJson(200, { success: true, kasMasuk: masuk, kasKeluar: keluar, saldoKas });
          const isIn = req.url === "/api/kasir/kas-masuk", table = isIn ? "kas_masuk" : "kas_keluar";
          const nominal = data.nominal, keterangan = String(data.keterangan || "").trim();
          if (typeof nominal !== "number" || !Number.isSafeInteger(nominal) || (isIn ? nominal < 0 : nominal <= 0)) return sendJson(400, { success: false, message: isIn ? "nominal wajib integer non-negatif yang aman" : "nominal wajib integer rupiah lebih dari 0" });
          const sumber = String(data.sumber || "").trim();
          const kategoriKasKeluar = String(data.kategori || "").trim();
          const kategoriKasKeluarValid = ["Operasional", "Pembelian Barang", "Transport", "Uang Makan Karyawan", "Lainnya"];
          if (isIn && !sumber) return sendJson(400, { success: false, message: "sumber kas masuk wajib diisi" });
          if (!isIn && !keterangan) return sendJson(400, { success: false, message: "keterangan wajib diisi" });
          if (!isIn && !kategoriKasKeluarValid.includes(kategoriKasKeluar)) return sendJson(400, { success: false, message: "Kategori Kas Keluar wajib dipilih dari kategori yang tersedia" });
          if (!isIn && nominal > saldoKas) return sendJson(400, { success: false, message: "Kas keluar melebihi saldo kas tersedia" });
          const insertSql = isIn
            ? `INSERT INTO kas_masuk (shift_id, kasir_id, waktu, nominal, keterangan, sumber) VALUES (?, ?, ?, ?, ?, ?)`
            : `INSERT INTO kas_keluar (shift_id, kasir_id, waktu, nominal, keterangan)
               SELECT ?, ?, ?, ?, ? WHERE ? <= (
                 SELECT s.saldo_awal
                   + COALESCE((SELECT SUM(nominal) FROM kas_masuk WHERE shift_id = s.id), 0)
                   - COALESCE((SELECT SUM(nominal) FROM kas_keluar WHERE shift_id = s.id), 0)
                   + COALESCE((SELECT SUM(CASE WHEN UPPER(COALESCE(t.metode_pembayaran, '')) = 'CASH' THEN t.total ELSE t.cash_amount END) FROM transaksi t WHERE t.shift_id = s.id AND UPPER(COALESCE(t.status_sync, '')) NOT IN ('BATAL', 'CANCELLED') AND COALESCE(t.tipe_transaksi, 'PENJUALAN') = 'PENJUALAN'), 0)
                 FROM shift_kasir s WHERE s.id = ? AND s.kasir_id = ? AND s.status = 'OPEN'
               )`;
          const insertParams = isIn
            ? [shiftId, session.kasirId, new Date().toISOString(), nominal, keterangan, sumber]
            : [shiftId, session.kasirId, new Date().toISOString(), nominal, `[${kategoriKasKeluar}] ${keterangan}`, nominal, shiftId, session.kasirId];
          db.run(insertSql, insertParams, function (insertError) {
            if (insertError) return sendJson(500, { success: false, message: insertError.message });
            if (this.changes !== 1) return sendJson(400, { success: false, message: "Kas keluar melebihi saldo kas tersedia" });
            sendJson(200, { success: true, id: this.lastID });
          });
          });
        };
        db.all(`SELECT * FROM kas_masuk WHERE shift_id = ? ORDER BY id`, [shiftId], (inError, masuk) => {
          if (inError) return sendJson(500, { success: false, message: inError.message });
          db.all(`SELECT * FROM kas_keluar WHERE shift_id = ? ORDER BY id`, [shiftId], (outError, keluar) => {
            if (outError) return sendJson(500, { success: false, message: outError.message });
            finish(masuk, keluar);
          });
        });
      });
    } catch (error) { sendJson(400, { success: false, message: error.message }); }
    return;
  }

// ==================================================
// HELPER SALDO KAS LACI (sumber saldo resmi untuk Rekap Kas Tutup Kasir)
//
// Saldo kas laci dihitung dari kas_laci_config.saldo_awal + seluruh
// kas_laci_transaksi (UANG_MASUK - UANG_KELUAR). Parameter `waktu`
// membatasi perhitungan ke transaksi laci dengan waktu <= nilai itu,
// sehingga dapat diambil saldo laci PERSIS pada saat shift dibuka
// (bukan saldo saat ini yang sudah mencakup transaksi selama shift).
// ==================================================
function getKasLaciSaldo(waktu = null) {
  return new Promise((resolve, reject) => {
    const params = waktu == null ? [] : [waktu];
    const batasWaktu = waktu == null ? "" : " AND t.waktu <= ?";
    db.get(
      `SELECT c.saldo_awal
            + COALESCE(SUM(CASE WHEN t.jenis = 'UANG_MASUK' THEN t.nominal
                                WHEN t.jenis = 'UANG_KELUAR' THEN -t.nominal ELSE 0 END), 0) AS saldo
       FROM kas_laci_config c
       LEFT JOIN kas_laci_transaksi t ON (1 = 1${batasWaktu})
       WHERE c.id = 1
       GROUP BY c.saldo_awal`,
      params,
      (error, row) => {
        if (error) return reject(error);
        resolve(Number(row && row.saldo || 0));
      }
    );
  });
}

  if (req.method === "POST" && req.url === "/api/kasir/tutup-preview") {
    const session = validateLoginSession(req, res);
    if (!session) return;

    try {
      const data = await getJsonBody(req);
      const safeNonNegative = (value, name) => {
        if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
          throw new Error(`${name} wajib berupa JSON number integer non-negatif yang aman`);
        }
        return value;
      };
      const shiftId = safeNonNegative(data.shiftId, "shiftId");
      if (!reserveShiftClosePreview(shiftId, res)) {
        res.writeHead(409, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ success: false, code: "SHIFT_WRITE_IN_PROGRESS", message: "Tunggu transaksi atau perubahan kas selesai sebelum melihat hasil tutup kasir." }));
      }

      const shiftRow = await new Promise((resolve, reject) => {
        db.get(
          `SELECT s.*, k.nama AS kasir FROM shift_kasir s JOIN kasir k ON k.id = s.kasir_id
           WHERE s.id = ? AND s.kasir_id = ? AND s.status IN ('OPEN', 'PENDING_CLOSE')`,
          [shiftId, session.kasirId],
          (shiftError, shift) => shiftError ? reject(shiftError) : resolve(shift)
        );
      });
      const shift = shiftRow;
      if (!shift) {
        res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ success: false, code: "SHIFT_MISMATCH", message: "Shift sudah ditutup atau bukan milik kasir session" }));
      }
      if (shift.status === "OPEN" && Number(shift.opening_confirmed) !== 1) {
        res.writeHead(409, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ success: false, code: "OPENING_BALANCE_NOT_CONFIRMED", message: "Saldo awal shift harus dikonfirmasi sebelum tutup kasir." }));
      }

      if (shift.status === "PENDING_CLOSE") {
        try {
          const snapshot = JSON.parse(shift.pending_close_snapshot || "");
          snapshot.shift = {
            ...snapshot.shift,
            shiftId: Number(shift.id),
            kasir: shift.kasir,
            buka_at: shift.buka_at,
            status: "PENDING_CLOSE",
            pending_close_at: shift.pending_close_at,
            tutup_at: shift.tutup_at,
          };
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          return res.end(JSON.stringify(snapshot));
        } catch (snapshotError) {
          writeLog("ERROR", "KASIR_PENDING_CLOSE", "Snapshot tutup kasir tidak valid", { shiftId, error: snapshotError.message });
          res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
          return res.end(JSON.stringify({ success: false, code: "PENDING_CLOSE_SNAPSHOT_INVALID", message: "Snapshot tutup kasir tidak dapat dibaca. Hubungi manager." }));
        }
      }

      let nominalAktual;
      try {
        nominalAktual = safeNonNegative(data.nominalAktual, "nominalAktual");
      } catch (validationError) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ success: false, message: validationError.message }));
      }
      const saldoKwhDalamAkhir = 0;
      const saldoKwhLuarAkhir = 0;

      // SALDO KAS LACI adalah sumber saldo resmi untuk Rekap Kas Tutup Kasir.
      // saldoKasLaciAwal  = saldo laci PERSIS saat shift dibuka (bukan saldo saat ini,
      //                     agar tidak mencakup transaksi laci selama shift).
      // saldoKasLaciSeharusnya = saldo laci resmi saat ini
      //                     = kas_laci_config.saldo_awal + seluruh kas_laci_transaksi
      //                       (UANG_MASUK - UANG_KELUAR), menjadi SALDO KAS AKHIR rekap.
      const saldoKasLaciAwal = await getKasLaciSaldo(shift.buka_at);
      const saldoKasLaciSeharusnya = await getKasLaciSaldo();

      db.all(
        `SELECT t.*, tt.kode_setoran, tt.nominal AS nominal_tarik_tunai
         FROM transaksi t
         LEFT JOIN tarik_tunai tt ON tt.transaksi_id = t.id
         WHERE t.shift_id = ? ORDER BY t.id`,
        [shiftId],
        (txError, allTransactions) => {
        if (txError) {
          res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
          return res.end(JSON.stringify({ success: false, message: txError.message }));
        }
        // /api/transaksi/batalkan menyimpan status_sync = 'BATAL'.
        // Abaikan transaksi batal dari seluruh angka dan rincian preview.
        const transactions = allTransactions.filter(tx => !["BATAL", "CANCELLED"].includes(String(tx.status_sync || "").trim().toUpperCase()));
        const txIds = transactions.map(tx => tx.id);
        const sessionsById = new Map();
        const respondWithDetails = details => {
          db.get(`SELECT
                    (SELECT COALESCE(SUM(nominal), 0) FROM kas_masuk WHERE shift_id = ?) AS masuk,
                    (SELECT COALESCE(SUM(nominal), 0) FROM kas_keluar WHERE shift_id = ?) AS keluar,
                    (SELECT COUNT(*) FROM kas_masuk WHERE shift_id = ?) AS jumlah_masuk,
                    (SELECT COUNT(*) FROM kas_keluar WHERE shift_id = ?) AS jumlah_keluar,
                    (SELECT COALESCE(SUM(kwh_didapat), 0) FROM pembelian_kwh WHERE shift_id = ? AND jenis_kwh = 'DALAM') AS total_kwh_dalam,
                    (SELECT COALESCE(SUM(kwh_didapat), 0) FROM pembelian_kwh WHERE shift_id = ? AND jenis_kwh = 'LUAR') AS total_kwh_luar,
                    (SELECT COUNT(*) FROM pembelian_kwh WHERE shift_id = ? AND jenis_kwh = 'DALAM') AS jumlah_topup_dalam,
                    (SELECT COUNT(*) FROM pembelian_kwh WHERE shift_id = ? AND jenis_kwh = 'LUAR') AS jumlah_topup_luar`,
            [shiftId, shiftId, shiftId, shiftId, shift.id, shift.id, shift.id, shift.id], (kasError, kas) => {
          if (kasError) {
            res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
            return res.end(JSON.stringify({ success: false, message: kasError.message }));
          }
          const detailsByTx = new Map();
          const products = new Map();
          details.forEach(row => {
            if (["meja billiard", "meja pagi", "meja malam"].includes(String(row.nama_barang || "").trim().toLowerCase())) return;
            if (!detailsByTx.has(row.transaksi_id)) detailsByTx.set(row.transaksi_id, []);
            detailsByTx.get(row.transaksi_id).push({ nama_barang: row.nama_barang, qty: Number(row.qty || 0), harga_jual: Number(row.harga_jual || 0), subtotal: Number(row.subtotal || 0) });
            const product = products.get(row.nama_barang) || { nama_barang: row.nama_barang, qty: 0, harga_jual: Number(row.harga_jual || 0), harga_jual_konsisten: true, subtotal: 0, _prices: new Set() };
            product.qty += Number(row.qty || 0);
            product.subtotal += Number(row.subtotal || 0);
            product._prices.add(Number(row.harga_jual || 0));
            products.set(row.nama_barang, product);
          });
          const tableRows = Array.from({ length: 10 }, (_, index) => ({ nomor_meja: index + 1, jumlah_sesi: 0, total_durasi_jam: 0, omzet: 0, _sessions: new Set() }));
          const transaksiDetail = transactions.map(tx => {
            const tableSession = sessionsById.get(tx.session_id);
            const tableNo = Number(tableSession && tableSession.nomor_meja || tx.nomor_meja || 0);
            const row = tableRows[tableNo - 1];
            if (row) row.omzet += Number(tx.total || 0);
            return { nomor_transaksi: tx.nomor_transaksi, tanggal: tx.tanggal, jam: tx.jam, waktu: [tx.tanggal, tx.jam].filter(Boolean).join(" "), nomor_meja: tableNo || null, session_id: tx.session_id || null, total: Number(tx.total || 0), metode_pembayaran: tx.metode_pembayaran, tipe_transaksi: tx.tipe_transaksi || "PENJUALAN", kode_setoran: tx.kode_setoran || null, nominal_tarik_tunai: Number(tx.nominal_tarik_tunai || 0), cash_amount: Number(tx.cash_amount || 0), qris_amount: Number(tx.qris_amount || 0), detail_produk: detailsByTx.get(tx.id) || [] };
          });
          transactions.forEach(tx => {
            const tableSession = sessionsById.get(tx.session_id);
            const tableNo = Number(tableSession && tableSession.nomor_meja || tx.nomor_meja || 0);
            const row = tableRows[tableNo - 1];
            if (row && tableSession && tx.session_id && !row._sessions.has(tx.session_id)) {
              row._sessions.add(tx.session_id);
              row.jumlah_sesi += 1;
              row.total_durasi_jam += Number(tableSession.durasi_jam || 0);
            }
          });
          const transactionSummary = summarizeTransactions(transactions);
          const cash = transactionSummary.totalCash;
          const qris = transactionSummary.totalQris;
          const total = transactionSummary.totalPenjualan;
          const selisihPenjualan = nominalAktual - cash;
          // SALDO KAS AKHIR rekap = saldo kas laci resmi saat ini.
          // Rumus lama shift.saldo_awal + kas_masuk + totalCash - kas_keluar TIDAK
          // lagi dipakai; Kas Masuk/Keluar (tabel kas_masuk/kas_keluar) hanya
          // informasi rekap, bukan sumber saldo.
          const uangSeharusnya = saldoKasLaciSeharusnya;
          const saldoKwhDalamAwalScaled = Number(shift.saldo_kwh_dalam_awal || 0);
          const saldoKwhLuarAwalScaled = Number(shift.saldo_kwh_luar_awal || 0);
          const totalKwhDalamTopupScaled = Number(kas.total_kwh_dalam || 0);
          const totalKwhLuarTopupScaled = Number(kas.total_kwh_luar || 0);
          const saldoKwhDalamTersediaScaled = saldoKwhDalamAwalScaled + totalKwhDalamTopupScaled;
          const saldoKwhLuarTersediaScaled = saldoKwhLuarAwalScaled + totalKwhLuarTopupScaled;
          const penggunaanKwhDalamScaled = saldoKwhDalamTersediaScaled - saldoKwhDalamAkhir;
          const penggunaanKwhLuarScaled = saldoKwhLuarTersediaScaled - saldoKwhLuarAkhir;
          const signedKwhScaledToDecimal = value =>
            Math.sign(value) * kwhScaledToDecimal(Math.abs(value));
          const produk = Array.from(products.values()).map(item => {
            item.harga_jual_konsisten = item._prices.size === 1;
            if (!item.harga_jual_konsisten) item.harga_jual = null;
            delete item._prices;
            return item;
          });
          tableRows.forEach(item => delete item._sessions);
          const preview = { success: true,
            shift: { shiftId: Number(shift.id), kasir: shift.kasir, buka_at: shift.buka_at, status: shift.status, pending_close_at: shift.pending_close_at, tutup_at: shift.tutup_at, saldo_awal: saldoKasLaciAwal, saldo_kwh_dalam_awal: kwhScaledToDecimal(saldoKwhDalamAwalScaled), saldo_kwh_luar_awal: kwhScaledToDecimal(saldoKwhLuarAwalScaled) },
            ringkasanPenjualan: { ...transactionSummary, nominalAktual },
            selisihPenjualan,
            rekapProduk: produk, transaksi: transaksiDetail,
            performaMeja: tableRows,
            kas: { masuk: Number(kas.masuk || 0), keluar: Number(kas.keluar || 0) },
            kasLaci: {
              saldoAwal: saldoKasLaciAwal,
              saldoAkhir: saldoKasLaciSeharusnya,
              sumber: "kas_laci_config.saldo_awal + kas_laci_transaksi (UANG_MASUK - UANG_KELUAR)"
            },
            rekonsiliasiKas: { uangSeharusnya, nominalAktual, selisih: nominalAktual - uangSeharusnya },
            kwh: {
              dalam: {
                awal: kwhScaledToDecimal(saldoKwhDalamAwalScaled),
                totalTokenTopup: kwhScaledToDecimal(totalKwhDalamTopupScaled),
                tokenTopupTersedia: Number(kas.jumlah_topup_dalam || 0) > 0,
                tersedia: kwhScaledToDecimal(saldoKwhDalamTersediaScaled),
                akhir: kwhScaledToDecimal(saldoKwhDalamAkhir),
                penggunaan: signedKwhScaledToDecimal(penggunaanKwhDalamScaled)
              },
              luar: {
                awal: kwhScaledToDecimal(saldoKwhLuarAwalScaled),
                totalTokenTopup: kwhScaledToDecimal(totalKwhLuarTopupScaled),
                tokenTopupTersedia: Number(kas.jumlah_topup_luar || 0) > 0,
                tersedia: kwhScaledToDecimal(saldoKwhLuarTersediaScaled),
                akhir: kwhScaledToDecimal(saldoKwhLuarAkhir),
                penggunaan: signedKwhScaledToDecimal(penggunaanKwhLuarScaled)
              }
            },
            generatedAt: new Date().toISOString()
          };
          const persistSnapshot = attempt => {
            if (attempt >= 10) {
              res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
              return res.end(JSON.stringify({ success: false, message: "Tidak dapat membuat kode unik tutup kasir setelah beberapa percobaan." }));
            }
            const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
            const code = Array.from(crypto.randomBytes(6), byte => alphabet[byte % alphabet.length]).join("");
            const pendingAt = new Date().toISOString();
            preview.kode_tutup = code;
            preview.pendingCloseAt = pendingAt;
            preview.shift.kode_tutup = code;
            preview.shift.status = "PENDING_CLOSE";
            const snapshot = JSON.stringify(preview);
            db.run(
              `UPDATE shift_kasir
               SET status = 'PENDING_CLOSE', pending_close_at = ?, pending_close_snapshot = ?, kode_tutup = ?,
                   nominal_aktual = ?, saldo_kwh_dalam_akhir = ?, saldo_kwh_luar_akhir = ?
               WHERE id = ? AND kasir_id = ? AND status = 'OPEN' AND kode_tutup IS NULL
                 AND pending_close_snapshot IS NULL
                 AND (SELECT COUNT(*) FROM transaksi WHERE shift_id = ?) = ?
                 AND (SELECT COUNT(*) FROM transaksi WHERE shift_id = ? AND UPPER(COALESCE(status_sync, '')) NOT IN ('BATAL', 'CANCELLED')) = ?
                 AND (SELECT COUNT(*) FROM kas_masuk WHERE shift_id = ?) = ?
                 AND (SELECT COUNT(*) FROM kas_keluar WHERE shift_id = ?) = ?`,
              [pendingAt, snapshot, code, nominalAktual, saldoKwhDalamAkhir, saldoKwhLuarAkhir,
                shiftId, session.kasirId, shiftId, allTransactions.length, shiftId, transactions.length,
                shiftId, Number(kas.jumlah_masuk || 0), shiftId, Number(kas.jumlah_keluar || 0)],
              function (persistError) {
                if (persistError && /UNIQUE|CONSTRAINT/i.test(persistError.message)) {
                  preview.kode_tutup = undefined;
                  preview.pendingCloseAt = undefined;
                  preview.shift.kode_tutup = undefined;
                  return persistSnapshot(attempt + 1);
                }
                if (persistError) {
                  res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
                  return res.end(JSON.stringify({ success: false, message: persistError.message }));
                }
                if (this.changes === 1) {
                  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
                  return res.end(snapshot);
                }
                db.get(`SELECT status, pending_close_snapshot FROM shift_kasir WHERE id = ? AND kasir_id = ?`, [shiftId, session.kasirId], (currentError, current) => {
                  if (currentError) {
                    res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
                    return res.end(JSON.stringify({ success: false, message: currentError.message }));
                  }
                  if (current && current.status === "PENDING_CLOSE") {
                    try {
                      const saved = JSON.parse(current.pending_close_snapshot || "");
                      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
                      return res.end(JSON.stringify(saved));
                    } catch (snapshotError) {
                      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
                      return res.end(JSON.stringify({ success: false, code: "PENDING_CLOSE_SNAPSHOT_INVALID", message: "Snapshot tutup kasir tidak dapat dibaca." }));
                    }
                  }
                  res.writeHead(409, { "Content-Type": "application/json; charset=utf-8" });
                  return res.end(JSON.stringify({ success: false, code: "PREVIEW_DATA_CHANGED", message: "Data shift berubah saat preview. Muat ulang dan lakukan LIHAT HASIL kembali." }));
                });
              }
            );
          };
          persistSnapshot(0);
          });
        };
        const loadDetails = () => {
          if (!txIds.length) return respondWithDetails([]);
          const placeholders = txIds.map(() => "?").join(",");
          db.all(`SELECT transaksi_id, nama_barang, qty, harga_jual, subtotal FROM detail_transaksi WHERE transaksi_id IN (${placeholders}) ORDER BY transaksi_id, id`, txIds, (detailError, details) => {
            if (detailError) {
              res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
              return res.end(JSON.stringify({ success: false, message: detailError.message }));
            }
            respondWithDetails(details);
          });
        };
        const sessionIds = Array.from(new Set(transactions.map(tx => tx.session_id).filter(Boolean)));
        if (!sessionIds.length) return loadDetails();
        const placeholders = sessionIds.map(() => "?").join(",");
        db.all(`SELECT session_id, nomor_meja, durasi_jam FROM sesi_meja WHERE session_id IN (${placeholders})`, sessionIds, (sessionError, rows) => {
          if (sessionError) {
            res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
            return res.end(JSON.stringify({ success: false, message: sessionError.message }));
          }
          rows.forEach(row => sessionsById.set(row.session_id, row));
          loadDetails();
        });
      });
    } catch (error) {
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ success: false, message: error.message }));
    }
    return;
  }

  if (req.method === "POST" && req.url === "/api/kasir/tutup") {
    const session = validateLoginSession(req, res);
    if (!session) return;

    try {
      const data = await getJsonBody(req);
      const shiftId = Number(data.shiftId);
      const kodeTutup = String(data.kode_tutup || "");
      if (!Number.isSafeInteger(shiftId) || shiftId <= 0) throw new Error("Shift kasir tidak ditemukan");
      if (!/^[A-Z0-9]{6}$/.test(kodeTutup)) throw new Error("Kode Unik Tutup tidak valid.");

      db.get(`SELECT * FROM shift_kasir WHERE id = ? AND kasir_id = ? AND status IN ('PENDING_CLOSE', 'CLOSED')`,
        [shiftId, session.kasirId], (shiftError, shift) => {
          if (shiftError) {
            res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
            return res.end(JSON.stringify({ success: false, message: shiftError.message }));
          }
          if (!shift || !shift.kode_tutup || shift.kode_tutup !== kodeTutup) {
            res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
            return res.end(JSON.stringify({ success: false, code: "CLOSE_CODE_MISMATCH", message: "Kode tutup tidak sesuai dengan shift." }));
          }
          let snapshot;
          try {
            snapshot = JSON.parse(shift.pending_close_snapshot || "");
          } catch (snapshotError) {
            res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
            return res.end(JSON.stringify({ success: false, code: "PENDING_CLOSE_SNAPSHOT_INVALID", message: "Snapshot tutup kasir tidak dapat dibaca." }));
          }
          if (!snapshot || !snapshot.rekonsiliasiKas || Number(shift.nominal_aktual) !== Number(snapshot.rekonsiliasiKas.nominalAktual)) {
            res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
            return res.end(JSON.stringify({ success: false, code: "PENDING_CLOSE_SNAPSHOT_MISMATCH", message: "Nilai snapshot penutupan tidak konsisten." }));
          }
          const nominalSetoran = Number(snapshot.ringkasanPenjualan.totalCash || 0);
          if (!Number.isSafeInteger(nominalSetoran) || nominalSetoran < 0) {
            res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
            return res.end(JSON.stringify({ success: false, code: "NOMINAL_SETORAN_TIDAK_VALID", message: "Nominal Aktual harus berupa integer non-negatif yang aman untuk Setoran." }));
          }
          const sendCloseSuccess = () => {
            snapshot.shift.status = "CLOSED";
            snapshot.shift.tutup_at = new Date().toISOString();
            res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
            return res.end(JSON.stringify({
              success: true,
              kode_tutup: shift.kode_tutup,
              penjualanCash: Number(snapshot.ringkasanPenjualan.totalCash || 0),
              penjualanQris: Number(snapshot.ringkasanPenjualan.totalQris || 0),
              totalPenjualan: Number(snapshot.ringkasanPenjualan.totalPenjualan || 0),
              jumlahTransaksi: Number(snapshot.ringkasanPenjualan.jumlahTransaksi || 0),
              uangSeharusnya: Number(snapshot.rekonsiliasiKas.uangSeharusnya),
              nominalAktual: Number(shift.nominal_aktual),
              selisih: Number(snapshot.rekonsiliasiKas.selisih),
              preview: snapshot
            }));
          };
          const getExpectedReconciliationTypes = () => [
            ...(Number(snapshot.selisihPenjualan) !== 0 ? ["PENJUALAN"] : []),
            ...(Number(snapshot.rekonsiliasiKas.selisih) !== 0 ? ["KAS"] : [])
          ];
          const getClosedReconciliationRows = () => new Promise((resolve, reject) => {
            db.all(
              `SELECT jenis FROM rekonsiliasi_kasir WHERE shift_id = ?`,
              [shiftId],
              (error, rows) => {
                if (error) reject(error);
                else resolve(rows);
              }
            );
          });
          const sendReconciliationMissing = () => {
            res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
            return res.end(JSON.stringify({
              success: false,
              code: "RECONCILIATION_MISSING",
              message: "Rekonsiliasi untuk shift CLOSED tidak ditemukan."
            }));
          };
          const hasExpectedClosedReconciliations = rows => {
            const existingTypes = new Set(rows.map(row => row.jenis));
            return getExpectedReconciliationTypes().every(jenis => existingTypes.has(jenis));
          };
          const isConsistentSetoran = setoran => !!setoran && setoran.kode_setoran === kodeTutup &&
            Number(setoran.shift_id) === shiftId && Number(setoran.kasir_id) === Number(session.kasirId) &&
            Number(setoran.nominal_awal) === nominalSetoran && Number.isSafeInteger(Number(setoran.saldo_tersisa)) &&
            Number(setoran.saldo_tersisa) >= 0 && Number(setoran.saldo_tersisa) <= nominalSetoran &&
            ["AKTIF", "HABIS"].includes(setoran.status);
          const sendSetoranMissing = () => {
            res.writeHead(409, { "Content-Type": "application/json; charset=utf-8" });
            return res.end(JSON.stringify({ success: false, code: "SETORAN_TIDAK_DITEMUKAN", message: "Shift CLOSED ini belum memiliki Setoran; data historis tidak dibuat otomatis." }));
          };
          const sendSetoranMismatch = () => {
            res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
            return res.end(JSON.stringify({ success: false, code: "SETORAN_TIDAK_KONSISTEN", message: "Setoran untuk kode tutup ini tidak konsisten dengan shift." }));
          };
          if (shift.status === "CLOSED") {
            void (async () => {
              try {
                const rows = await getClosedReconciliationRows();
                if (!hasExpectedClosedReconciliations(rows)) return sendReconciliationMissing();
                const setoran = await new Promise((resolve, reject) => db.get(
                  `SELECT kode_setoran, shift_id, kasir_id, nominal_awal, saldo_tersisa, status FROM setoran WHERE kode_setoran = ? COLLATE NOCASE`,
                  [kodeTutup], (error, row) => error ? reject(error) : resolve(row)
                ));
                if (!setoran) return sendSetoranMissing();
                if (!isConsistentSetoran(setoran)) return sendSetoranMismatch();
                return sendCloseSuccess();
              } catch (reconciliationError) {
                res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
                return res.end(JSON.stringify({ success: false, message: reconciliationError.message }));
              }
            })();
            return;
          }
          const runCloseSql = (sql, params = []) => new Promise((resolve, reject) => {
            db.run(sql, params, function (error) {
              if (error) reject(error);
              else resolve(this);
            });
          });
          const getCloseSql = (sql, params = []) => new Promise((resolve, reject) => {
            db.get(sql, params, (error, row) => {
              if (error) reject(error);
              else resolve(row);
            });
          });
          const getCloseSetoran = () => getCloseSql(
            `SELECT kode_setoran, shift_id, kasir_id, nominal_awal, saldo_tersisa, status
             FROM setoran WHERE kode_setoran = ? COLLATE NOCASE`, [kodeTutup]
          );
          const getCloseReconciliationRows = () => new Promise((resolve, reject) => {
            db.all(
              `SELECT jenis FROM rekonsiliasi_kasir WHERE shift_id = ?`,
              [shiftId],
              (error, rows) => {
                if (error) reject(error);
                else resolve(rows);
              }
            );
          });
          const sendCloseStateChanged = () => {
            res.writeHead(409, { "Content-Type": "application/json; charset=utf-8" });
            return res.end(JSON.stringify({ success: false, code: "SHIFT_CLOSE_STATE_CHANGED", message: "Status shift berubah sebelum konfirmasi tutup." }));
          };
          void (async () => {
            let transactionStarted = false;
            try {
              await runCloseSql("BEGIN IMMEDIATE TRANSACTION");
              transactionStarted = true;

              const currentShift = await getCloseSql(
                `SELECT status, kode_tutup FROM shift_kasir WHERE id = ? AND kasir_id = ?`,
                [shiftId, session.kasirId]
              );
              if (currentShift && currentShift.status === "CLOSED" && currentShift.kode_tutup === kodeTutup) {
                const rows = await getCloseReconciliationRows();
                if (!hasExpectedClosedReconciliations(rows)) {
                  await runCloseSql("ROLLBACK");
                  transactionStarted = false;
                  return sendReconciliationMissing();
                }
                const setoran = await getCloseSql(`SELECT kode_setoran, shift_id, kasir_id, nominal_awal, saldo_tersisa, status FROM setoran WHERE kode_setoran = ? COLLATE NOCASE`, [kodeTutup]);
                if (!setoran) {
                  await runCloseSql("ROLLBACK");
                  transactionStarted = false;
                  return sendSetoranMissing();
                }
                if (!isConsistentSetoran(setoran)) {
                  await runCloseSql("ROLLBACK");
                  transactionStarted = false;
                  return sendSetoranMismatch();
                }
                await runCloseSql("COMMIT");
                transactionStarted = false;
                return sendCloseSuccess();
              }
              if (!currentShift || currentShift.status !== "PENDING_CLOSE" || currentShift.kode_tutup !== kodeTutup) {
                await runCloseSql("ROLLBACK");
                transactionStarted = false;
                return sendCloseStateChanged();
              }

              const selisihPenjualan = Number(snapshot.selisihPenjualan);
              const selisihKas = Number(snapshot.rekonsiliasiKas.selisih);
              if (!Number.isSafeInteger(selisihPenjualan) || !Number.isSafeInteger(selisihKas)) {
                throw new Error("Nilai selisih snapshot penutupan tidak valid.");
              }

              const closeResult = await runCloseSql(
                `UPDATE shift_kasir SET status = 'CLOSED', tutup_at = ?
                 WHERE id = ? AND kasir_id = ? AND status = 'PENDING_CLOSE' AND kode_tutup = ?`,
                [new Date().toISOString(), shiftId, session.kasirId, currentShift.kode_tutup]
              );
              if (closeResult.changes !== 1) {
                const latestShift = await getCloseSql(
                  `SELECT status, kode_tutup FROM shift_kasir WHERE id = ? AND kasir_id = ?`,
                  [shiftId, session.kasirId]
                );
                await runCloseSql("ROLLBACK");
                transactionStarted = false;
                if (latestShift && latestShift.status === "CLOSED" && latestShift.kode_tutup === kodeTutup) {
                  const rows = await getCloseReconciliationRows();
                  if (!hasExpectedClosedReconciliations(rows)) return sendReconciliationMissing();
                  return sendCloseSuccess();
                }
                return sendCloseStateChanged();
              }

              const reconciliations = [
                { jenis: "PENJUALAN", selisih: selisihPenjualan, keterangan: "Selisih penjualan tutup kasir" },
                { jenis: "KAS", selisih: selisihKas, keterangan: "Selisih kas tutup kasir" }
              ];
              for (const reconciliation of reconciliations) {
                if (reconciliation.selisih === 0) continue;
                let kodeRekonsiliasi = null;
                for (let attempt = 0; attempt < 10; attempt++) {
                  const candidate = `RK${crypto.randomBytes(16).toString("hex").toUpperCase()}`;
                  const existing = await getCloseSql(
                    `SELECT 1 FROM rekonsiliasi_kasir WHERE kode_rekonsiliasi = ?`,
                    [candidate]
                  );
                  if (!existing) {
                    kodeRekonsiliasi = candidate;
                    break;
                  }
                }
                if (!kodeRekonsiliasi) throw new Error("Tidak dapat membuat kode rekonsiliasi unik.");

                await runCloseSql(
                  `INSERT INTO rekonsiliasi_kasir
                   (kode_rekonsiliasi, kasir_id, shift_id, kode_tutup, jenis, arah, nominal, status_pelunasan, dibuat_at, keterangan)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                  [
                    kodeRekonsiliasi,
                    session.kasirId,
                    shiftId,
                    currentShift.kode_tutup,
                    reconciliation.jenis,
                    reconciliation.selisih > 0 ? "PLUS" : "MINUS",
                    Math.abs(reconciliation.selisih),
                    reconciliation.selisih < 0 ? "BELUM_LUNAS" : null,
                    new Date().toISOString(),
                    reconciliation.keterangan
                  ]
                );
              }

              const closeTime = new Date().toISOString();
              const existingSetoran = await getCloseSql(
                `SELECT kode_setoran, shift_id, kasir_id, nominal_awal, saldo_tersisa, status FROM setoran WHERE kode_setoran = ? COLLATE NOCASE`,
                [currentShift.kode_tutup]
              );
              if (existingSetoran) {
                if (!isConsistentSetoran(existingSetoran)) throw new Error("Setoran dengan kode tutup ini sudah ada tetapi datanya tidak konsisten dengan shift.");
              } else {
                await runCloseSql(
                  `INSERT INTO setoran (kode_setoran, shift_id, kasir_id, nominal_awal, saldo_tersisa, dibuat_at, status)
                   VALUES (?, ?, ?, ?, ?, ?, 'AKTIF')`,
                  [currentShift.kode_tutup, shiftId, session.kasirId, nominalSetoran, nominalSetoran, closeTime]
                );
              }

              await runCloseSql("COMMIT");
              transactionStarted = false;
              return sendCloseSuccess();
            } catch (closeError) {
              if (transactionStarted) {
                try {
                  await runCloseSql("ROLLBACK");
                } catch (rollbackError) {
                  closeError.message = `${closeError.message}; rollback failed: ${rollbackError.message}`;
                }
              }
              res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
              return res.end(JSON.stringify({ success: false, message: closeError.message }));
            }
          })();
        });
    } catch (error) {
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ success: false, message: error.message }));
    }
    return;
  }

  if (req.method === "GET" && req.url.startsWith("/api/logs")) {
    const session = validateLoginSession(req, res);
    if (!session) return;

    db.all(
      `SELECT id, waktu, level, event, message, data FROM log ORDER BY id DESC LIMIT 200`,
      [],
      (error, rows) => {
        if (error) {
          res.writeHead(500);
          return res.end(JSON.stringify({ success: false, message: error.message }));
        }
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ success: true, total: rows.length, data: rows }));
      }
    );
    return;
  }

  if (req.method === "GET" && req.url.startsWith("/api/riwayat-transaksi")) {
    const session = validateLoginSession(req, res);
    if (!session) return;

    try {
      const url = new URL(req.url, `http://localhost:${config.PORT}`);
      const limit = Math.min(Number(url.searchParams.get("limit") || 100), 500);
      const query = String(url.searchParams.get("q") || "").trim();
      const metode = String(url.searchParams.get("metode") || "").trim();

      let sql = `
        SELECT
          t.id,
          t.nomor_transaksi AS nomorTransaksi,
          t.nomor_meja AS nomorMeja,
          t.session_id AS sessionId,
          t.tanggal,
          t.jam,
          t.kasir,
          t.total,
          t.metode_pembayaran AS metodePembayaran,
          t.bayar,
          t.kembalian,
          t.cash_amount AS cashAmount,
          t.qris_amount AS qrisAmount,
          t.tipe_transaksi AS tipeTransaksi,
          tt.kode_setoran AS kodeSetoran,
          tt.nominal AS nominalTarikTunai,
          t.status_sync AS statusSync,
          t.sync_at AS syncAt
        FROM transaksi t
        LEFT JOIN tarik_tunai tt ON tt.transaksi_id = t.id
        WHERE 1 = 1
      `;

      const params = [];

      const currentKasir = String(session.username || "").trim();
      if (!currentKasir) {
        res.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ success: false, message: "Identitas kasir tidak ditemukan." }));
      }
      sql += ` AND LOWER(TRIM(t.kasir)) = LOWER(TRIM(?))`;
      params.push(currentKasir);

      if (query) {
        sql += ` AND (t.nomor_transaksi LIKE ? OR t.kasir LIKE ? OR tt.kode_setoran LIKE ?)`;
        const search = `%${query}%`;
        params.push(search, search, search);
      }

      if (metode) {
        sql += ` AND t.metode_pembayaran = ?`;
        params.push(metode);
      }

      sql += ` ORDER BY t.id DESC LIMIT ?`;
      params.push(limit);

      db.all(sql, params, async (error, rows) => {
        if (error) {
          res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
          return res.end(JSON.stringify({ success: false, message: error.message }));
        }

        try {
          for (const transaksi of rows) {
            transaksi.items = await new Promise((resolve, reject) => {
              db.all(
                `
                SELECT
                  nama_barang AS nama,
                  qty,
                  harga_jual AS hargaJual,
                  hpp,
                  subtotal
                FROM detail_transaksi
                WHERE transaksi_id = ?
                ORDER BY id ASC
                `,
                [transaksi.id],
                (detailError, detailRows) => {
                  if (detailError) reject(detailError);
                  else resolve(detailRows);
                }
              );
            });
          }

          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          return res.end(JSON.stringify({ success: true, total: rows.length, data: rows }));

        } catch (detailError) {
          res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
          return res.end(JSON.stringify({ success: false, message: detailError.message }));
        }
      });
      return;

    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ success: false, message: error.message }));
    }
  }

  // ==================================================
  // WAITING LIST API
  // ==================================================
  if (req.method === "GET" && req.url === "/api/waiting-list") {
    const session = validateLoginSession(req, res);
    if (!session) return;

    try {
      db.all(
        `SELECT * FROM waiting_list ORDER BY id DESC`,
        [],
        (error, rows) => {
          if (error) {
            res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
            return res.end(JSON.stringify({ success: false, message: error.message }));
          }

          const formattedRows = rows.map(row => {
            let pesanan = [];
            try {
              pesanan = JSON.parse(row.pesanan_json || "[]");
            } catch (e) {
              pesanan = [];
            }

            return {
              id: row.id,
              namaCustomer: row.nama_customer,
              noWa: row.no_wa,
              tanggalBooking: row.tanggal_booking,
              jamBooking: row.jam_booking,
              jumlahOrang: row.jumlah_orang,
              nomorMeja: row.nomor_meja,
              status: row.status,
              catatan: row.catatan,
              pesanan: pesanan,
              createdAt: row.created_at,
              updatedAt: row.updated_at
            };
          });

          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          return res.end(JSON.stringify({
            success: true,
            total: formattedRows.length,
            data: formattedRows
          }));
        }
      );
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ success: false, message: error.message }));
    }
    return;
  }

  if (req.method === "POST" && req.url === "/api/waiting-list") {
    const session = validateLoginSession(req, res);
    if (!session) return;

    try {
      const data = await getJsonBody(req);

      const namaCustomer = String(data.namaCustomer || "").trim();
      const noWa = data.noWa ? String(data.noWa).trim() : null;
      const tanggalBooking = String(data.tanggalBooking || "").trim();
      const jamBooking = String(data.jamBooking || "").trim();
      const jumlahOrang = Number(data.jumlahOrang);
      const nomorMeja = data.nomorMeja !== undefined && data.nomorMeja !== null && data.nomorMeja !== "" ? Number(data.nomorMeja) : null;
      const status = String(data.status || "WAITING").trim();
      const catatan = data.catatan ? String(data.catatan).trim() : null;
      const pesanan = Array.isArray(data.pesanan) ? data.pesanan : [];

      if (!namaCustomer) throw new Error("namaCustomer wajib diisi");
      if (!tanggalBooking) throw new Error("tanggalBooking wajib diisi");
      if (!jamBooking) throw new Error("jamBooking wajib diisi");
      if (!Number.isInteger(jumlahOrang) || jumlahOrang < 0) throw new Error("jumlahOrang harus integer >= 0");
      if (nomorMeja !== null && (!Number.isInteger(nomorMeja) || nomorMeja < 1 || nomorMeja > 10)) {
        throw new Error("nomorMeja harus integer 1 sampai 10");
      }

      const validStatuses = ["WAITING", "CONFIRMED", "SEATED", "CANCELLED", "EXPIRED", "SERVED", "BATAL"];
      if (!validStatuses.includes(status)) {
        throw new Error("Status tidak valid");
      }

      const pesananJson = JSON.stringify(pesanan);
      const now = new Date().toISOString();

      db.run(
        `
        INSERT INTO waiting_list
        (nama_customer, no_wa, tanggal_booking, jam_booking, jumlah_orang, nomor_meja, status, catatan, pesanan_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [namaCustomer, noWa, tanggalBooking, jamBooking, jumlahOrang, nomorMeja, status, catatan, pesananJson, now, now],
        function(error) {
          if (error) {
            res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
            return res.end(JSON.stringify({ success: false, message: error.message }));
          }

          const newId = this.lastID;
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          return res.end(JSON.stringify({
            success: true,
            message: "Booking berhasil dibuat",
            id: newId
          }));
        }
      );
    } catch (error) {
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ success: false, message: error.message }));
    }
    return;
  }

  if (req.method === "PUT" && req.url.startsWith("/api/waiting-list/")) {
    const session = validateLoginSession(req, res);
    if (!session) return;

    try {
      const idStr = req.url.split("/").pop();
      const id = Number(idStr);

      if (!id || isNaN(id)) {
        throw new Error("ID waiting list tidak valid");
      }

      const data = await getJsonBody(req);

      db.get(`SELECT * FROM waiting_list WHERE id = ?`, [id], (err, row) => {
        if (err) {
          res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
          return res.end(JSON.stringify({ success: false, message: err.message }));
        }

        if (!row) {
          res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
          return res.end(JSON.stringify({ success: false, message: "Booking tidak ditemukan" }));
        }

        try {
          const namaCustomer = data.namaCustomer !== undefined ? String(data.namaCustomer).trim() : row.nama_customer;
          const noWa = data.noWa !== undefined ? (data.noWa ? String(data.noWa).trim() : null) : row.no_wa;
          const tanggalBooking = data.tanggalBooking !== undefined ? String(data.tanggalBooking).trim() : row.tanggal_booking;
          const jamBooking = data.jamBooking !== undefined ? String(data.jamBooking).trim() : row.jam_booking;
          const jumlahOrang = data.jumlahOrang !== undefined ? Number(data.jumlahOrang) : row.jumlah_orang;
          const nomorMeja = data.nomorMeja !== undefined ? (data.nomorMeja !== null && data.nomorMeja !== "" ? Number(data.nomorMeja) : null) : row.nomor_meja;
          const status = data.status !== undefined ? String(data.status).trim() : row.status;
          const catatan = data.catatan !== undefined ? (data.catatan ? String(data.catatan).trim() : null) : row.catatan;
          const pesanan = data.pesanan !== undefined && Array.isArray(data.pesanan) ? data.pesanan : JSON.parse(row.pesanan_json || "[]");

          if (data.namaCustomer !== undefined && !namaCustomer) throw new Error("namaCustomer wajib diisi");
          if (data.tanggalBooking !== undefined && !tanggalBooking) throw new Error("tanggalBooking wajib diisi");
          if (data.jamBooking !== undefined && !jamBooking) throw new Error("jamBooking wajib diisi");
          if (data.jumlahOrang !== undefined && (!Number.isInteger(jumlahOrang) || jumlahOrang < 0)) throw new Error("jumlahOrang harus integer >= 0");
          if (nomorMeja !== null && (!Number.isInteger(nomorMeja) || nomorMeja < 1 || nomorMeja > 10)) {
            throw new Error("nomorMeja harus integer 1 sampai 10");
          }

          const validStatuses = ["WAITING", "CONFIRMED", "SEATED", "CANCELLED", "EXPIRED", "SERVED", "BATAL"];
          if (data.status !== undefined && !validStatuses.includes(status)) {
            throw new Error("Status tidak valid");
          }

          const pesananJson = JSON.stringify(pesanan);
          const updatedAt = new Date().toISOString();

          db.run(
            `
            UPDATE waiting_list
            SET nama_customer = ?, no_wa = ?, tanggal_booking = ?, jam_booking = ?, jumlah_orang = ?, nomor_meja = ?, status = ?, catatan = ?, pesanan_json = ?, updated_at = ?
            WHERE id = ?
            `,
            [namaCustomer, noWa, tanggalBooking, jamBooking, jumlahOrang, nomorMeja, status, catatan, pesananJson, updatedAt, id],
            function(updateError) {
              if (updateError) {
                res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
                return res.end(JSON.stringify({ success: false, message: updateError.message }));
              }

              res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
              return res.end(JSON.stringify({
                success: true,
                message: "Booking berhasil diperbarui"
              }));
            }
          );
        } catch (validationError) {
          res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
          return res.end(JSON.stringify({ success: false, message: validationError.message }));
        }
      });
    } catch (error) {
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ success: false, message: error.message }));
    }
    return;
  }

  if (req.method === "DELETE" && req.url.startsWith("/api/waiting-list/")) {
    const session = validateLoginSession(req, res);
    if (!session) return;

    try {
      const idStr = req.url.split("/").pop();
      const id = Number(idStr);

      if (!id || isNaN(id)) {
        throw new Error("ID waiting list tidak valid");
      }

      db.get(`SELECT * FROM waiting_list WHERE id = ?`, [id], (err, row) => {
        if (err) {
          res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
          return res.end(JSON.stringify({ success: false, message: err.message }));
        }

        if (!row) {
          res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
          return res.end(JSON.stringify({ success: false, message: "Booking tidak ditemukan" }));
        }

        db.run(`DELETE FROM waiting_list WHERE id = ?`, [id], function(deleteError) {
          if (deleteError) {
            res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
            return res.end(JSON.stringify({ success: false, message: deleteError.message }));
          }

          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          return res.end(JSON.stringify({
            success: true,
            message: "Booking berhasil dihapus"
          }));
        });
      });
    } catch (error) {
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ success: false, message: error.message }));
    }
    return;
  }

  // CART DRAFT
  if (req.method === "GET" && req.url === "/api/cart-draft") {
    const session = validateLoginSession(req, res);
    if (!session) return;

    try {
      db.all(
        `SELECT nama_barang AS nama, qty FROM cart_draft WHERE kasir_id = ? ORDER BY id ASC`,
        [session.kasirId],
        (error, rows) => {
          if (error) {
            res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
            return res.end(JSON.stringify({ success: false, message: error.message }));
          }
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          return res.end(JSON.stringify(rows));
        }
      );
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ success: false, message: error.message }));
    }
    return;
  }

  if (req.method === "POST" && req.url === "/api/cart-draft") {
    const session = validateLoginSession(req, res);
    if (!session) return;

    try {
      const data = await getJsonBody(req);
      const namaBarang = String(data.namaBarang || "").trim();
      let qty = Number(data.qty);

      if (!namaBarang) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ success: false, message: "namaBarang wajib diisi" }));
      }

      if (isNaN(qty) || qty < 1) {
        qty = 1;
      }

      const kasirId = session.kasirId;
      const now = new Date().toISOString();

      db.get(
        `SELECT id, qty FROM cart_draft WHERE kasir_id = ? AND nama_barang = ?`,
        [kasirId, namaBarang],
        (err, row) => {
          if (err) {
            res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
            return res.end(JSON.stringify({ success: false, message: err.message }));
          }

          if (row) {
            db.run(
              `UPDATE cart_draft SET qty = ?, updated_at = ? WHERE id = ?`,
              [qty, now, row.id],
              (updateErr) => {
                if (updateErr) {
                  res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
                  return res.end(JSON.stringify({ success: false, message: updateErr.message }));
                }
                res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
                return res.end(JSON.stringify({ success: true, message: "Cart draft diperbarui" }));
              }
            );
          } else {
            db.run(
              `INSERT INTO cart_draft (kasir_id, nama_barang, qty, updated_at) VALUES (?, ?, ?, ?)`,
              [kasirId, namaBarang, qty, now],
              (insertErr) => {
                if (insertErr) {
                  res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
                  return res.end(JSON.stringify({ success: false, message: insertErr.message }));
                }
                res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
                return res.end(JSON.stringify({ success: true, message: "Cart draft ditambahkan" }));
              }
            );
          }
        }
      );
    } catch (error) {
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ success: false, message: error.message }));
    }
    return;
  }

  if (req.method === "DELETE" && req.url === "/api/cart-draft") {
    const session = validateLoginSession(req, res);
    if (!session) return;

    try {
      db.run(
        `DELETE FROM cart_draft WHERE kasir_id = ?`,
        [session.kasirId],
        (error) => {
          if (error) {
            res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
            return res.end(JSON.stringify({ success: false, message: error.message }));
          }
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          return res.end(JSON.stringify({ success: true, message: "Cart draft dihapus" }));
        }
      );
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ success: false, message: error.message }));
    }
    return;
  }

  if (req.method === "POST" && req.url === "/api/cart/kurang-qty") {
    const session = validateLoginSession(req, res);
    if (!session) return;

    try {
      const data = await getJsonBody(req);
      const namaBarang = String(data.namaBarang || "").trim();

      if (!namaBarang) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ success: false, message: "namaBarang wajib diisi" }));
      }

      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ success: true }));

    } catch (error) {
      writeLog("ERROR", "CART_KURANG_QTY_ERROR", error.message);
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ success: false, message: error.message }));
    }
  }

  // MEJA SESI ENDPOINTS
  if (req.method === "GET" && req.url === "/api/meja/sesi") {
    const session = validateLoginSession(req, res);
    if (!session) return;

    try {
      const sessions = await new Promise((resolve, reject) => {
        db.all("SELECT * FROM sesi_meja WHERE status = 'AKTIF'", [], (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        });
      });

      const result = [];
      for (let i = 1; i <= 10; i++) {
        const activeSession = sessions.find(s => s.nomor_meja === i);
        if (activeSession) {
          const namaBarangMeja = await getNamaBarangMejaSesi(activeSession.session_id);
          result.push({
            nomorMeja: i,
            status: "AKTIF",
            sessionId: activeSession.session_id,
            namaPemesan: activeSession.nama_pemesan,
            kasir: activeSession.kasir,
            waktuMulai: activeSession.waktu_mulai,
            namaBarangMeja,
            durasiJam: activeSession.durasi_jam || 0,
            waktuSelesai: activeSession.waktu_selesai || null,
            jenisSesi: activeSession.jenis_sesi || "NORMAL",
            memberId: activeSession.member_id || null,
            kategoriMember: activeSession.kategori_member || null
          });
        } else {
          result.push({
            nomorMeja: i,
            status: "KOSONG"
          });
        }
      }

      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify(result));
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ success: false, message: error.message }));
    }
  }

  if (req.method === "POST" && req.url === "/api/meja-karyawan/aktifkan") {
    const session = validateLoginSession(req, res);
    if (!session) return;

    try {
      const data = await getJsonBody(req);
      const nomorMeja = Number(data.nomorMeja);
      const totpCode = String(data.totpCode || "").trim();

      if (!Number.isInteger(nomorMeja) || nomorMeja < 1 || nomorMeja > 10) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ success: false, message: "Nomor meja harus integer 1 sampai 10." }));
      }

      const totpRes = await verifyManagerTotpOnce(totpCode);
      if (!totpRes.success) {
        const statusCode = totpRes.code === "TOTP_CONFIG_ERROR" ? 500 : 401;
        res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ success: false, code: totpRes.code, message: totpRes.message }));
      }

      const activeSession = await getActiveSessionByTable(nomorMeja);
      if (activeSession) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({
          success: false,
          message: "Meja sedang digunakan."
        }));
      }

      const namaPemesan = session.nama;
      if (!namaPemesan) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ success: false, message: "Nama kasir login tidak tersedia." }));
      }

      const sessionId = generateSessionId();
      const waktuMulaiDate = new Date();
      const waktuMulai = waktuMulaiDate.toISOString();
      const durasiJam = 1;
      const waktuSelesaiDate = new Date(waktuMulaiDate.getTime() + durasiJam * 3600 * 1000);
      const waktuSelesai = waktuSelesaiDate.toISOString();
      const jenisSesi = "KARYAWAN";

      await new Promise((resolve, reject) => {
        db.run(
          `
          INSERT INTO sesi_meja
          (session_id, nomor_meja, nama_pemesan, kasir, waktu_mulai, durasi_jam, waktu_selesai, jenis_sesi, member_id, kategori_member, status)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'AKTIF')
          `,
          [sessionId, nomorMeja, namaPemesan, session.username, waktuMulai, durasiJam, waktuSelesai, jenisSesi, null, null],
          (error) => {
            if (error) reject(error);
            else resolve();
          }
        );
      });

      const nowIso = new Date().toISOString();
      await new Promise((resolve, reject) => {
        db.run(
          `
          INSERT INTO pesanan_meja
          (session_id, nama_barang, qty, harga_jual, hpp, subtotal, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `,
          [sessionId, namaMejaDariWaktuMulai(waktuMulai), durasiJam, 0, 0, 0, nowIso, nowIso],
          (error) => {
            if (error) reject(error);
            else resolve();
          }
        );
      });

      let lampSuccess = false;
      try {
        const lampRes = await lampOn(nomorMeja);
        if (lampRes && lampRes.success === true) lastLampCommandState.set(Number(nomorMeja), 1);
        if (lampRes && lampRes.success === true) {
          lampSuccess = true;
        } else {
          writeLog("WARN", "LAMP_ON_FAILED", `Gagal menyalakan lampu untuk meja ${nomorMeja}`, { lampRes });
        }
      } catch (lampErr) {
        writeLog("ERROR", "LAMP_ON_ERROR", `Error saat menyalakan lampu untuk meja ${nomorMeja}`, { error: lampErr.message });
        lampSuccess = false;
      }

      if (!lampSuccess) {
        await runAsync(`DELETE FROM pesanan_meja WHERE session_id = ?`, [sessionId]);
        await runAsync(`DELETE FROM sesi_meja WHERE session_id = ?`, [sessionId]);

        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({
          success: false,
          message: "Meja gagal diaktifkan karena lampu tidak berhasil dinyalakan."
        }));
      }

      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({
        success: true,
        message: "Meja karyawan berhasil diaktifkan",
        nomorMeja: nomorMeja,
        durasiJam: durasiJam,
        jenisSesi: "KARYAWAN",
        biaya: 0,
        sessionId: sessionId
      }));

    } catch (error) {
      writeLog("ERROR", "MEJA_KARYAWAN_ERROR", error.message);
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ success: false, message: error.message }));
    }
  }

  if (req.method === "POST" && req.url === "/api/meja/hitung-harga") {
    const session = validateLoginSession(req, res);
    if (!session) return;

    try {
      const data = await getJsonBody(req);
      const rawSessionId = data.sessionId;
      const rawKategori = data.kategori;
      const rawDurasiJam = data.durasiJam;

      if (!rawKategori || String(rawKategori).trim() === "") {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ success: false, message: "Kategori wajib diisi" }));
      }

      if (rawDurasiJam === undefined || rawDurasiJam === null || rawDurasiJam === "") {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ success: false, message: "Durasi jam wajib diisi" }));
      }

      const durasiJam = Number(rawDurasiJam);
      if (!Number.isInteger(durasiJam) || durasiJam < 1) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ success: false, message: "durasiJam harus integer >= 1" }));
      }

      const mejaSessionHarga = rawSessionId ? await getSessionById(String(rawSessionId)) : null;
      const memberKodeHarga = String(mejaSessionHarga?.member_id || "").trim();
      const memberHarga = memberKodeHarga
        ? await new Promise((resolve, reject) => db.get(
          "SELECT status FROM member WHERE kode_member = ?",
          [memberKodeHarga],
          (error, row) => error ? reject(error) : resolve(row)
        ))
        : null;
      const isExpiredHarga = memberHarga?.status === "EXPIRED";
      const kategoriSesi = String(mejaSessionHarga?.kategori_member || "").trim().toUpperCase();
      // Kategori dihitung dari member terkait sesi, bukan dari input frontend.
      const kategoriMemberHarga = mejaSessionHarga?.member_id
        ? String(
          (await getMemberListCached()).find(m =>
            String(m.id ?? "").trim() === String(mejaSessionHarga.member_id).trim() ||
            String(m.kodeMember ?? m.kode_member ?? "").trim() === String(mejaSessionHarga.member_id).trim()
          )?.kategori || ""
        ).trim().toUpperCase()
        : "";
      // Non-member (memberKodeHarga kosong): pakai harga normal meja dari master_barang.
      // Member aktif: pakai kategori dari cache member; fallback kategoriSesi atau UMUM.
      const kategori = memberKodeHarga
        ? (kategoriMemberHarga ? kategoriMemberHarga : (kategoriSesi || "UMUM"))
        : "";
      if (!isExpiredHarga && kategori && !["PLATINUM", "UMUM", "PELAJAR"].includes(kategori)) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ success: false, message: "Kategori member tidak valid" }));
      }

      // Tarif sesi mengikuti waktu mulai yang tersimpan, bukan waktu tombol ditekan.
      const nowIso = mejaSessionHarga?.waktu_mulai || new Date().toISOString();
      let cacheHarga;

      if (isExpiredHarga || !memberKodeHarga) {
        // Non-member / member expired → harga normal meja
        const masterBarang = await getLocalBarang();
        const namaBarangMeja = mejaSessionHarga ? await getNamaBarangMejaSesi(mejaSessionHarga.session_id) : namaMejaDariWaktuMulai(nowIso);
        const barangBilliard = masterBarang.find(b => String(b.nama || "").trim() === namaBarangMeja);

        const hargaNormal = barangBilliard ? Number(barangBilliard.hargaJual || 0) : 0;

        if (!Number.isFinite(hargaNormal) || hargaNormal <= 0) {
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          return res.end(JSON.stringify({
            success: false,
            message: `Harga normal ${namaBarangMeja} tidak tersedia di database SQLite.`
          }));
        }

        cacheHarga = {
          hargaPerJam: hargaNormal,
          total: hargaNormal * durasiJam,
          jam: null
        };
      } else {
        cacheHarga = await getHargaMemberDariCache(kategori, durasiJam, nowIso);
      }

      if (!cacheHarga) {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({
          success: false,
          message: `Harga ${kategori} untuk durasi ${durasiJam} jam tidak tersedia di database SQLite.`
        }));
      }

      const hargaPerJam = cacheHarga.hargaPerJam;
      const total = cacheHarga.total;
      const nowJam = cacheHarga.jam || new Intl.DateTimeFormat("en-GB", {
        timeZone: "Asia/Makassar",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false
      }).format(new Date());

      if (rawSessionId) {
        const namaBarangMeja = mejaSessionHarga ? await getNamaBarangMejaSesi(String(rawSessionId)) : "Meja Billiard";
        await new Promise((resolve, reject) => {
          db.run(
            `UPDATE pesanan_meja
             SET qty = ?,
                 harga_jual = ?,
                 subtotal = ?,
                 updated_at = datetime('now')
             WHERE session_id = ?
               AND LOWER(TRIM(nama_barang)) = LOWER(?)`,
            [durasiJam, hargaPerJam, total, String(rawSessionId), namaBarangMeja],
            function(err) {
              if (err) return reject(err);
              resolve(this.changes);
            }
          );
        });
      }

      const bonus = rawSessionId && mejaSessionHarga
        ? await sinkronBonusMalam(mejaSessionHarga, durasiJam, data.bonusProduct || null)
        : { bonusQty: 0, bonusProduct: null };

      writeLog(
        "INFO",
        "HARGA_MEJA_FINAL",
        `Harga meja ${kategori} diambil langsung dari database SQLite`,
        {
          sessionId: rawSessionId || null,
          durasiJam,
          jamSekarang: nowJam,
          hargaPerJam,
          total
        }
      );

      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({
        success: true,
        kategori,
        durasiJam,
        jam: nowJam,
        hargaPerJam,
        total,
        bonusQty: bonus.bonusQty,
        bonusProduct: bonus.bonusProduct,
        source: "SQLITE_DB"
      }));

    } catch (error) {
      writeLog("ERROR", "HITUNG_HARGA_MEJA", error.message, {
        error: error.stack
      });

      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({
        success: false,
        message: "Gagal menghitung harga meja.",
        error: error.message
      }));
    }
  }

  if (req.method === "GET" && req.url.startsWith("/api/meja/sesi/")) {
    const session = validateLoginSession(req, res);
    if (!session) return;

    try {
      const sessionId = req.url.split("/").pop();
      if (!sessionId) {
        throw new Error("Session ID tidak valid");
      }

      const mejaSession = await getSessionById(sessionId);
      if (!mejaSession) {
        throw new Error("Sesi tidak ditemukan");
      }

      const rawItems = await getSessionItems(sessionId);
      const namaBarangMeja = await getNamaBarangMejaSesi(sessionId);
      const isKaryawan = String(mejaSession.jenis_sesi || "").trim().toUpperCase() === "KARYAWAN";

      const items = rawItems.map(item => {
        let hargaJual = item.harga_jual;
        let subtotal = item.subtotal;

        if (isKaryawan) {
          hargaJual = 0;
          subtotal = 0;
        }

        return {
          nama: item.nama_barang,
          qty: item.qty,
          hargaJual: hargaJual,
          hpp: item.hpp,
          subtotal: subtotal
        };
      });

      const total = items.reduce((sum, item) => sum + item.subtotal, 0);

      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({
        success: true,
        session: {
          sessionId: mejaSession.session_id,
          nomorMeja: mejaSession.nomor_meja,
          namaPemesan: mejaSession.nama_pemesan,
          kasir: mejaSession.kasir,
          waktuMulai: mejaSession.waktu_mulai,
          namaBarangMeja,
          durasiJam: mejaSession.durasi_jam || 0,
          waktuSelesai: mejaSession.waktu_selesai || null,
          jenisSesi: mejaSession.jenis_sesi || "NORMAL",
          memberId: mejaSession.member_id || null,
          kategoriMember: mejaSession.kategori_member || null,
          status: mejaSession.status
        },
        items,
        total
      }));
    } catch (error) {
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ success: false, message: error.message }));
    }
  }

  if (req.method === "POST" && req.url === "/api/meja/buka") {
    const session = validateLoginSession(req, res);
    if (!session) return;

    try {
      const data = await getJsonBody(req);
      const nomorMeja = Number(data.nomorMeja);
      const namaPemesan = String(data.namaPemesan || "").trim();
      const kasir = String(data.kasir || "").trim();
      const jenisSesi = String(data.jenisSesi || "NORMAL").trim().toUpperCase();
      const isLoss = jenisSesi === "LOSS";

      const durasiJamAwal = isLoss
        ? 0
        : (
            data.durasiJam !== undefined &&
            data.durasiJam !== null &&
            data.durasiJam !== ""
              ? Number(data.durasiJam)
              : 1
          );
      const memberIdInput = data.memberId ? String(data.memberId).trim() : null;

      // Paket 3 Jam: sesi paket non member, durasi 3 jam,
      // tanpa baris Meja Pagi/Meja Malam otomatis. Paket disimpan satu kali
      // dari master_barang sebagai bagian pembukaan sesi.
      const paket3JamDiminta = String(data.paket || data.namaPaket || "").trim() === "Paket 3 Jam";
      if (paket3JamDiminta && isLoss) {
        throw new Error("Paket 3 Jam tidak dapat digunakan pada sesi LOSS");
      }

      const durasiJam = paket3JamDiminta && !isLoss ? 3 : durasiJamAwal;
      const pilihanBonus = String(data.pilihanBonus || data.bonus || "").trim();

      if (!nomorMeja || nomorMeja < 1 || nomorMeja > 10) {
        throw new Error("Nomor meja harus 1-10");
      }
      if (!namaPemesan) {
        throw new Error("Nama pemesan wajib");
      }
      if (!kasir) {
        throw new Error("Kasir wajib");
      }
      if (!isLoss && (!Number.isInteger(durasiJam) || durasiJam < 1)) {
        throw new Error("durasiJam harus integer >= 1");
      }

      const activeSession = await getActiveSessionByTable(nomorMeja);
      if (activeSession) {
        throw new Error("Meja sudah memiliki sesi AKTIF");
      }

      const waktuMulaiDate = new Date();
      const waktuMulai = waktuMulaiDate.toISOString();

      let memberInfo = null;
      let kategoriMember = null;
      let hargaPerJam = null;

      // Non-member: both must be NULL — kategori_member NULL = harga normal meja
      if (!memberIdInput) {
        kategoriMember = null;
        hargaPerJam = null;
      }

      if (!isLoss && memberIdInput) {
        const members = await getMemberListCached();
        const foundMember = members.find(m => String(m.id) === String(memberIdInput) || String(m.kodeMember) === String(memberIdInput));

        if (!foundMember) {
          res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
          return res.end(JSON.stringify({ success: false, message: "Member tidak ditemukan." }));
        }

	console.log("[MEMBER DEBUG]", {
		memberIdInput,
  		foundMemberId: foundMember.id,
  		foundMemberKode: foundMember.kodeMember,
  		foundMemberNama: foundMember.nama,
  		foundMemberStatus: foundMember.status
	});

        if (foundMember.status !== "AKTIF" && foundMember.status !== "EXPIRED") {
          res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
          return res.end(JSON.stringify({ success: false, message: "Member belum aktif." }));
        }

        memberInfo = foundMember;
        kategoriMember = foundMember.status === "EXPIRED" ? null : String(foundMember.kategori || foundMember.kategoriId || "").trim().toUpperCase();

        const cacheHarga = foundMember.status === "EXPIRED" ? { hargaPerJam: null, jam: null } : await getHargaMemberDariCache(kategoriMember, durasiJam, waktuMulai);

        if (!cacheHarga) {
          res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
          return res.end(JSON.stringify({
            success: false,
            message: `Harga ${kategoriMember} untuk durasi ${durasiJam} jam tidak tersedia di database SQLite.`
          }));
        }

        hargaPerJam = cacheHarga.hargaPerJam;

        writeLog("INFO", "MEMBER_PRICE_CHECK", "Harga member diambil langsung dari database SQLite", {
          memberId: memberIdInput,
          kategori: kategoriMember,
          jam: cacheHarga.jam,
          durasiJam,
          hargaPerJam
        });
      }

      const sessionId = generateSessionId();
      const waktuSelesai = isLoss ? null : new Date(waktuMulaiDate.getTime() + durasiJam * 3600 * 1000).toISOString();
      if (!isLoss && kategoriMember) {
        validasiBatasSesiMemberPagi(kategoriMember, waktuMulai, waktuSelesai);
      }

      let barangBonus = null;
      let inPaketTransaction = false;

      if (!isLoss && paket3JamDiminta) {
        // Seluruh alur Paket 3 Jam (sesi_meja + pesanan_meja + update member)
        // dibungkus satu transaksi atomik. BEGIN dijalankan SEBELUM INSERT
        // sesi_meja, dan COMMIT hanya setelah semua query sukses, sehingga
        // jika salah satu gagal tidak ada record sesi_meja maupun
        // pesanan_meja yang tertinggal di database.
        inPaketTransaction = true;
        try {
          await runAsync("BEGIN IMMEDIATE TRANSACTION");

          const masterBarangPaket = await getLocalBarang();
          const barangPaket = masterBarangPaket.find(b => String(b.nama || "").trim() === "Paket 3 Jam Non Member");
          if (!barangPaket || Number(barangPaket.hargaJual) !== 70000) {
            throw new Error("Produk Paket 3 Jam Non Member tidak valid di master_barang");
          }
          if (kategoriMember && !pilihanBonus) {
            throw new Error("Pilihan bonus (Kopi Bonus / Es Teh Bonus) wajib dipilih untuk Member");
          }
          const hppPaket = Number(barangPaket.hpp || 0);
          const hargaPaket = Number(barangPaket.hargaJual);
          const nowIsoPaket = new Date().toISOString();

          if (kategoriMember && pilihanBonus) {
            const masterBonusList = await getLocalBarang();
            const lowerPilihan = String(pilihanBonus).trim().toLowerCase();
            const bonusPopcorn = ["popcorn bonus", "bonus popcorn", "popcorn"].includes(lowerPilihan);
            let ditemukan = null;
            if (bonusPopcorn) {
              // Cari "Popcorn Bonus" dahulu, fallback ke "Popcorn"
              const namaVariasi = ["Popcorn Bonus", "Popcorn"];
              for (const nama of namaVariasi) {
                ditemukan = masterBonusList.find(b => String(b.nama || "").trim().toLowerCase() === nama.toLowerCase());
                if (ditemukan) break;
              }
            } else {
              ditemukan = masterBonusList.find(b => String(b.nama || "").trim().toLowerCase() === lowerPilihan);
            }
            if (ditemukan && ["kopi bonus", "es teh bonus", "popcorn bonus", "bonus popcorn", "popcorn"].includes(String(ditemukan.nama || "").trim().toLowerCase())) {
              barangBonus = ditemukan;
            } else {
              throw new Error("Barang bonus tidak valid di master_barang");
            }
          }

          await runAsync(
            `
            INSERT INTO sesi_meja
            (session_id, nomor_meja, nama_pemesan, kasir, waktu_mulai, durasi_jam, waktu_selesai, jenis_sesi, member_id, kategori_member, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'AKTIF')
            `,
            [sessionId, nomorMeja, namaPemesan, session.username, waktuMulai, durasiJam, waktuSelesai, jenisSesi, memberIdInput, kategoriMember]
          );

          if (memberIdInput) {
            await runAsync(
              `UPDATE member
               SET last_used_at = ?,
                   total_kunjungan = COALESCE(total_kunjungan, 0) + 1,
                   updated_at = ?
               WHERE id = ? OR kode_member = ?`,
              [waktuMulai, waktuMulai, memberIdInput, String(memberIdInput)]
            );
          }

          await runAsync(
            `
            INSERT INTO pesanan_meja
            (session_id, nama_barang, qty, harga_jual, hpp, subtotal, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `,
            [sessionId, "Paket 3 Jam Non Member", 1, hargaPaket, hppPaket, hargaPaket, nowIsoPaket, nowIsoPaket]
          );

          if (barangBonus) {
            const hppBonus = Number(barangBonus.hpp || 0);
            const nowIsoBonus = new Date().toISOString();
            await runAsync(
              `
              INSERT INTO pesanan_meja
              (session_id, nama_barang, qty, harga_jual, hpp, subtotal, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)
              `,
              [sessionId, barangBonus.nama, 1, 0, hppBonus, 0, nowIsoBonus, nowIsoBonus]
            );
          }

          await runAsync("COMMIT");
          inPaketTransaction = false;
        } catch (txPaketErr) {
          if (inPaketTransaction) {
            try {
              await runAsync("ROLLBACK");
            } catch (rollbackErr) {
              writeLog("ERROR", "MEJA_BUKA_ROLLBACK_FAIL", `Gagal rollback transaksi Paket 3 Jam meja ${nomorMeja}`, {
                sessionId,
                error: rollbackErr.message
              });
            }
          }
          writeLog("ERROR", "MEJA_BUKA_PAKEK_TX_FAIL", `Transaksi Paket 3 Jam gagal untuk meja ${nomorMeja}`, {
            sessionId,
            error: txPaketErr.message
          });
          res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
          return res.end(JSON.stringify({ success: false, message: txPaketErr.message }));
        }

        writeLog("INFO", "OPEN_PAKET_3JAM", `Sesi Paket 3 Jam dibuka pada meja ${nomorMeja}`, { sessionId, nomorMeja, namaPemesan, kasir: session.username });
        if (memberIdInput) {
          writeLog("INFO", "MEMBER_ACTIVITY", "Aktivitas member diperbarui saat bermain", {
            memberId: memberIdInput,
            lastUsedAt: waktuMulai
          });
        }
      } else {
        await new Promise((resolve, reject) => {
          db.run(
            `
            INSERT INTO sesi_meja
            (session_id, nomor_meja, nama_pemesan, kasir, waktu_mulai, durasi_jam, waktu_selesai, jenis_sesi, member_id, kategori_member, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'AKTIF')
            `,
            [sessionId, nomorMeja, namaPemesan, session.username, waktuMulai, durasiJam, waktuSelesai, jenisSesi, memberIdInput, kategoriMember],
            (error) => {
              if (error) reject(error);
              else resolve();
            }
          );
        });

        if (!isLoss && memberIdInput) {
          await new Promise((resolve, reject) => {
            db.run(
              `UPDATE member
               SET last_used_at = ?,
                   total_kunjungan = COALESCE(total_kunjungan, 0) + 1,
                   updated_at = ?
               WHERE id = ? OR kode_member = ?`,
              [waktuMulai, waktuMulai, memberIdInput, String(memberIdInput)],
              (error) => error ? reject(error) : resolve()
            );
          });

          writeLog("INFO", "MEMBER_ACTIVITY", "Aktivitas member diperbarui saat bermain", {
            memberId: memberIdInput,
            lastUsedAt: waktuMulai
          });
        }
        if (isLoss) {
          writeLog("INFO", "OPEN_LOSS", `Sesi WAKTU LOSS dibuka pada meja ${nomorMeja}`, { sessionId, nomorMeja, namaPemesan, kasir: session.username });
        } else {
          const masterBarang = await getLocalBarang();
          const namaBarangItem = namaMejaDariWaktuMulai(waktuMulai);
          const barangBilliard = masterBarang.find(b => String(b.nama || "").trim() === namaBarangItem);
          if (!barangBilliard) throw new Error(`Produk ${namaBarangItem} tidak ditemukan di Master Barang`);
          const hppItem = Number(barangBilliard.hpp || 0);
          const normalHargaJual = Number(barangBilliard.hargaJual || 0);

          const hargaJualFinal = normalHargaJual;
          const subtotalFinal = hargaJualFinal * durasiJam;
          const nowIso = new Date().toISOString();

          await new Promise((resolve, reject) => {
            db.run(
              `
              INSERT INTO pesanan_meja
              (session_id, nama_barang, qty, harga_jual, hpp, subtotal, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)
              `,
              [sessionId, namaBarangItem, durasiJam, hargaJualFinal, hppItem, subtotalFinal, nowIso, nowIso],
              (error) => {
                if (error) reject(error);
                else resolve();
              }
            );
          });
        }
      }

      try {
        const lampRes = await lampOn(nomorMeja);
        if (lampRes && lampRes.success === true) lastLampCommandState.set(Number(nomorMeja), 1);
        if (!lampRes || lampRes.success !== true) {
          writeLog("WARN", "LAMP_ON_FAILED", `Gagal menyalakan lampu untuk meja ${nomorMeja}`, { lampRes });
        }
      } catch (lampErr) {
        writeLog("ERROR", "LAMP_ON_ERROR", `Error saat menyalakan lampu untuk meja ${nomorMeja}`, { error: lampErr.message });
      }

      const responseObj = {
        success: true,
        sessionId,
        nomorMeja,
        namaPemesan,
        kasir: session.username,
        waktuMulai,
        durasiJam,
        waktuSelesai,
        jenisSesi,
        status: "AKTIF"
      };

      if (!isLoss && memberIdInput && memberInfo) {
        responseObj.memberId = memberIdInput;
        responseObj.kategoriMember = kategoriMember;
        responseObj.hargaPerJam = hargaPerJam;
      }

      if (!isLoss && paket3JamDiminta) {
        responseObj.paket = "Paket 3 Jam";
        responseObj.bonus = barangBonus ? barangBonus.nama : null;
      }

      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify(responseObj));
    } catch (error) {
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ success: false, message: error.message }));
    }
  }

  // ==================================================
  // POST /api/meja/pindah (FITUR PINDAH MEJA)
  // ==================================================
  if (req.method === "POST" && req.url === "/api/meja/pindah") {
    const session = validateLoginSession(req, res);
    if (!session) return;

    try {
      const data = await getJsonBody(req);
      const sessionId = data.sessionId ? String(data.sessionId).trim() : "";
      const nomorMejaAsal = Number(data.nomorMejaAsal);
      const nomorMejaTujuan = Number(data.nomorMejaTujuan);

      if (!sessionId) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ success: false, message: "Session ID wajib diisi." }));
      }

      if (!Number.isInteger(nomorMejaAsal) || nomorMejaAsal < 1 || nomorMejaAsal > 10) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ success: false, message: "Nomor meja asal harus 1-10." }));
      }

      if (!Number.isInteger(nomorMejaTujuan) || nomorMejaTujuan < 1 || nomorMejaTujuan > 10) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ success: false, message: "Nomor meja tujuan harus 1-10." }));
      }

      if (nomorMejaAsal === nomorMejaTujuan) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ success: false, message: "Meja asal dan meja tujuan tidak boleh sama." }));
      }

      await runAsync("BEGIN IMMEDIATE TRANSACTION");

      try {
        const sesiAsal = await new Promise((resolve, reject) => {
          db.get(
            `SELECT * FROM sesi_meja WHERE session_id = ? AND status = 'AKTIF'`,
            [sessionId],
            (err, row) => {
              if (err) reject(err);
              else resolve(row);
            }
          );
        });

        if (!sesiAsal) {
          await runAsync("ROLLBACK");
          res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
          return res.end(JSON.stringify({ success: false, message: "Sesi tidak ditemukan atau tidak aktif." }));
        }

        if (sesiAsal.nomor_meja !== nomorMejaAsal) {
          await runAsync("ROLLBACK");
          res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
          return res.end(JSON.stringify({ success: false, message: `Sesi tidak berada di meja asal (${nomorMejaAsal}).` }));
        }

        const sesiTujuan = await getActiveSessionByTable(nomorMejaTujuan);
        if (sesiTujuan) {
          await runAsync("ROLLBACK");
          res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
          return res.end(JSON.stringify({ success: false, message: "Meja tujuan sedang digunakan." }));
        }

        const updateRes = await runAsync(
          `UPDATE sesi_meja SET nomor_meja = ? WHERE session_id = ? AND status = 'AKTIF' AND NOT EXISTS (SELECT 1 FROM sesi_meja WHERE nomor_meja = ? AND status = 'AKTIF')`,
          [nomorMejaTujuan, sessionId, nomorMejaTujuan]
        );

        if (updateRes.changes === 0) {
          await runAsync("ROLLBACK");
          res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
          return res.end(JSON.stringify({ success: false, message: "Gagal memperbarui meja sesi. Meja tujuan mungkin sudah terisi." }));
        }

        await runAsync("COMMIT");

        writeLog("INFO", "MOVE_TABLE", `Berhasil memindahkan meja dari Meja ${nomorMejaAsal} ke Meja ${nomorMejaTujuan}`, {
          sessionId,
          nomorMejaAsal,
          nomorMejaTujuan,
          kasir: session.username
        });

        try {
          const lampOffRes = await lampOff(nomorMejaAsal);
          if (lampOffRes && lampOffRes.success === true) {
            lastLampCommandState.set(Number(nomorMejaAsal), 0);
          }
          if (!lampOffRes || lampOffRes.success !== true) {
            writeLog("WARN", "LAMP_OFF_FAILED", `Gagal mematikan lampu meja asal ${nomorMejaAsal} saat pindah meja`, { lampOffRes });
          }
        } catch (lampErr) {
          writeLog("ERROR", "LAMP_OFF_ERROR", `Error saat mematikan lampu meja asal ${nomorMejaAsal} saat pindah meja`, { error: lampErr.message });
        }

        await new Promise(resolve => setTimeout(resolve, 300));

        try {
          const lampOnRes = await lampOn(nomorMejaTujuan);
          if (!lampOnRes || lampOnRes.success !== true) {
            writeLog("WARN", "LAMP_ON_FAILED", `Gagal menyalakan lampu meja tujuan ${nomorMejaTujuan} saat pindah meja`, { lampOnRes });
          }
        } catch (lampErr) {
          writeLog("ERROR", "LAMP_ON_ERROR", `Error saat menyalakan lampu meja tujuan ${nomorMejaTujuan} saat pindah meja`, { error: lampErr.message });
        }

        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({
          success: true,
          sessionId: sessionId,
          nomorMejaAsal: nomorMejaAsal,
          nomorMejaTujuan: nomorMejaTujuan
        }));

      } catch (txErr) {
        await runAsync("ROLLBACK");
        writeLog("ERROR", "MOVE_TABLE_ERROR", txErr.message);
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ success: false, message: txErr.message }));
      }

    } catch (error) {
      writeLog("ERROR", "MOVE_TABLE_ERROR", error.message);
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ success: false, message: error.message }));
    }
  }

  // ==================================================
  // POST /api/meja/loss/stop (STRICT ATOMIC TRANSACTION)
  // ==================================================
  if (req.method === "POST" && req.url === "/api/meja/loss/stop") {
    const session = validateLoginSession(req, res);
    if (!session) return;

    try {
      const data = await getJsonBody(req);
      const sessionId = String(data.sessionId || "").trim();

      if (!sessionId) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ success: false, code: "INVALID_SESSION_ID", message: "sessionId wajib diisi" }));
      }

      const mejaSession = await getSessionById(sessionId);
      if (!mejaSession) {
        writeLog("WARN", "STOP_LOSS_FAILED", "Sesi tidak ditemukan", { sessionId });
        res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ success: false, code: "LOSS_SESSION_NOT_FOUND", message: "Sesi tidak ditemukan" }));
      }

      if (mejaSession.status !== "AKTIF") {
        writeLog("WARN", "STOP_LOSS_FAILED", "Sesi tidak dalam status AKTIF", { sessionId, status: mejaSession.status });
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ success: false, code: "LOSS_SESSION_NOT_ACTIVE", message: "Sesi tidak dalam status AKTIF" }));
      }

      if (String(mejaSession.jenis_sesi || "").toUpperCase() !== "LOSS") {
        writeLog("WARN", "STOP_LOSS_FAILED", "Bukan sesi Waktu Loss", { sessionId, jenisSesi: mejaSession.jenis_sesi });
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ success: false, code: "LOSS_SESSION_INVALID_TYPE", message: "Bukan sesi Waktu Loss" }));
      }

      writeLog("INFO", "STOP_LOSS_START", `Memulai Stop Loss untuk session ${sessionId}`, { sessionId });

      const waktuMulaiDate = new Date(mejaSession.waktu_mulai);
      const waktuSelesaiDate = new Date();
      const waktuSelesaiStr = waktuSelesaiDate.toISOString();

      const diffMs = waktuSelesaiDate.getTime() - waktuMulaiDate.getTime();
      const durasiMenit = Math.floor(diffMs / 60000);
      const tarifPerMenit = 500;
      const totalWaktuLoss = durasiMenit * tarifPerMenit;

      await runAsync("BEGIN TRANSACTION");

      let transactionCommitted = false;

      try {
        const updateRes = await runAsync(
          `UPDATE sesi_meja SET status = 'SELESAI', waktu_selesai = ? WHERE session_id = ? AND status = 'AKTIF' AND jenis_sesi = 'LOSS'`,
          [waktuSelesaiStr, sessionId]
        );

        if (updateRes.changes !== 1) {
          await runAsync("ROLLBACK");
          writeLog("WARN", "STOP_LOSS_DOUBLE_STOP", "Double STOP terdeteksi / sesi sudah dihentikan", { sessionId });
          res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
          return res.end(JSON.stringify({
            success: false,
            code: "LOSS_ALREADY_STOPPED",
            message: "Sesi Waktu Loss sudah dihentikan sebelumnya"
          }));
        }

        const nowIso = new Date().toISOString();

        await runAsync(
          `INSERT INTO pesanan_meja (session_id, nama_barang, qty, harga_jual, hpp, subtotal, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [sessionId, "Billiard Waktu Loss", durasiMenit, tarifPerMenit, 0, totalWaktuLoss, nowIso, nowIso]
        );

        await runAsync("COMMIT");
        transactionCommitted = true;

      } catch (txErr) {

        if (!transactionCommitted) {
          try {
            await runAsync("ROLLBACK");
          } catch (rollbackErr) {
            writeLog(
              "ERROR",
              "STOP_LOSS_ROLLBACK_FAILED",
              "Rollback gagal",
              {
                sessionId,
                error: rollbackErr.message
              }
            );
          }
        }

        writeLog(
          "ERROR",
          "STOP_LOSS_TRANSACTION_FAILED",
          `Transaksi Stop Loss gagal: ${txErr.message}`,
          {
            sessionId,
            error: txErr.message
          }
        );

        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });

        return res.end(JSON.stringify({
          success: false,
          code: "STOP_LOSS_TRANSACTION_FAILED",
          message: txErr.message
        }));
      }

      try {
        const lampOffRes = await lampOff(mejaSession.nomor_meja);
        if (lampOffRes && lampOffRes.success === true) {
          lastLampCommandState.set(Number(mejaSession.nomor_meja), 0);
        }
      } catch (lampErr) {
        writeLog("ERROR", "LAMP_OFF_ERROR", `Gagal mematikan lampu meja ${mejaSession.nomor_meja}`, { error: lampErr.message });
      }

      writeLog("INFO", "STOP_LOSS_SUCCESS", `STOP LOSS berhasil untuk meja ${mejaSession.nomor_meja}`, {
        sessionId,
        nomorMeja: mejaSession.nomor_meja,
        durasiMenit,
        totalWaktuLoss
      });

      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({
        success: true,
        sessionId: mejaSession.session_id,
        nomorMeja: mejaSession.nomor_meja,
        waktuMulai: mejaSession.waktu_mulai,
        waktuSelesai: waktuSelesaiStr,
        durasiMenit,
        tarifPerMenit,
        totalWaktuLoss
      }));

    } catch (error) {
      writeLog("ERROR", "STOP_LOSS_FAILED", error.message, { error: error.message });
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ success: false, message: error.message }));
    }
  }

  if (req.method === "POST" && req.url === "/api/meja/tambah-durasi") {
    const session = validateLoginSession(req, res);
    if (!session) return;

    try {
      const data = await getJsonBody(req);
      const sessionId = data.sessionId;
      const durasiTambahJam = Number(data.durasiTambahJam);
      const paket3JamDiminta = String(data.paket || data.namaPaket || "").trim() === "Paket 3 Jam";

      // Cabang khusus: Paket 3 Jam
      if (paket3JamDiminta) {
        if (!sessionId) {
          res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
          return res.end(JSON.stringify({ success: false, message: "Sesi aktif tidak ditemukan" }));
        }

        const mejaSession = await getSessionById(sessionId);
        if (!mejaSession || mejaSession.status !== "AKTIF") {
          res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
          return res.end(JSON.stringify({ success: false, message: "Sesi aktif tidak ditemukan" }));
        }

        if (String(mejaSession.jenis_sesi || "").toUpperCase() === "LOSS") {
          res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
          return res.end(JSON.stringify({ success: false, message: "Tidak dapat menambah durasi pada sesi LOSS" }));
        }


        const masterPaket = await new Promise((resolve, reject) => {
          db.get(
            `SELECT nama, hpp, harga_jual FROM master_barang WHERE nama = ? LIMIT 1`,
            ["Paket 3 Jam Non Member"],
            (err, row) => {
              if (err) reject(err);
              else resolve(row);
            }
          );
        });

        if (!masterPaket || Number(masterPaket.harga_jual) !== 70000) {
          res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
          return res.end(JSON.stringify({ success: false, message: "Produk Paket 3 Jam tidak valid di master_barang" }));
        }

        const paketHpp = Number(masterPaket.hpp || 0);
        const paketDurasiJam = 3;
        const paketHarga = 70000;
        const durasiJamLamaPaket = Number(mejaSession.durasi_jam || 0);
        const durasiJamBaruPaket = durasiJamLamaPaket + paketDurasiJam;
        const waktuSelesaiLamaPaket = mejaSession.waktu_selesai || new Date().toISOString();

        await runAsync("BEGIN IMMEDIATE TRANSACTION");
        let waktuSelesaiBaruPaket;
        try {
          const sesiAktifUlang = await new Promise((resolve, reject) => {
            db.get(
              `SELECT * FROM sesi_meja WHERE session_id = ? AND status = 'AKTIF'`,
              [sessionId],
              (err, row) => {
                if (err) reject(err);
                else resolve(row);
              }
            );
          });

          if (!sesiAktifUlang) {
            await runAsync("ROLLBACK");
            res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
            return res.end(JSON.stringify({ success: false, message: "Sesi aktif tidak ditemukan" }));
          }

          const paketDuplikat = await new Promise((resolve, reject) => {
            db.get(
              `SELECT id FROM pesanan_meja WHERE session_id = ? AND nama_barang IN (?, ?) LIMIT 1`,
              [sessionId, "Paket 3 Jam", "Paket 3 Jam Non Member"],
              (err, row) => {
                if (err) reject(err);
                else resolve(row);
              }
            );
          });

          if (paketDuplikat) {
            await runAsync("ROLLBACK");
            res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
            return res.end(JSON.stringify({ success: false, message: "Paket 3 Jam sudah ditambahkan pada sesi ini" }));
          }

          const nowPaket = new Date();
          const currentEndPaket = new Date(sesiAktifUlang.waktu_selesai || nowPaket.toISOString());
          let waktuSelesaiBaruDatePaket;
          if (nowPaket >= currentEndPaket) {
            waktuSelesaiBaruDatePaket = new Date(nowPaket.getTime() + paketDurasiJam * 3600 * 1000);
          } else {
            waktuSelesaiBaruDatePaket = new Date(currentEndPaket.getTime() + paketDurasiJam * 3600 * 1000);
          }
          validasiBatasSesiMemberPagi(sesiAktifUlang.kategori_member, sesiAktifUlang.waktu_mulai, waktuSelesaiBaruDatePaket);
          waktuSelesaiBaruPaket = waktuSelesaiBaruDatePaket.toISOString();

          const updatePaketRes = await runAsync(
            `
            UPDATE sesi_meja
            SET durasi_jam = durasi_jam + ?, waktu_selesai = ?
            WHERE session_id = ? AND status = 'AKTIF'
            `,
            [paketDurasiJam, waktuSelesaiBaruPaket, sessionId]
          );

          if (!updatePaketRes || Number(updatePaketRes.changes) === 0) {
            await runAsync("ROLLBACK");
            res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
            return res.end(JSON.stringify({ success: false, message: "Sesi aktif tidak ditemukan" }));
          }

          const nowIsoPaket = new Date().toISOString();
          await runAsync(
            `INSERT INTO pesanan_meja (session_id, nama_barang, qty, harga_jual, hpp, subtotal, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [sessionId, "Paket 3 Jam Non Member", 1, paketHarga, paketHpp, paketHarga, nowIsoPaket, nowIsoPaket]
          );

          await runAsync("COMMIT");
        } catch (paketTxErr) {
          try { await runAsync("ROLLBACK"); } catch (rollbackErr) {}
          res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
          return res.end(JSON.stringify({ success: false, message: paketTxErr.message || "Gagal menambah durasi paket" }));
        }

        const wasExpiredPaket = new Date() >= new Date(waktuSelesaiLamaPaket);
        if (wasExpiredPaket) {
          const nomorMejaPaket = mejaSession.nomor_meja;
          try {
            const lampRes = await lampOn(nomorMejaPaket);
            if (lampRes && lampRes.success === true) lastLampCommandState.set(Number(nomorMejaPaket), 1);
            if (lampRes && lampRes.success === true) {
              expiredLampSessions.delete(sessionId);
              writeLog("INFO", "LAMP_ON_EXTENDED", `Lampu dinyalakan kembali untuk meja ${nomorMejaPaket} karena durasi ditambah`, { sessionId });
            } else {
              writeLog("WARN", "LAMP_ON_FAILED", `Gagal menyalakan kembali lampu untuk meja ${nomorMejaPaket} saat durasi ditambah`, { lampRes });
            }
          } catch (lampErr) {
            writeLog("ERROR", "LAMP_ON_ERROR", `Error saat menyalakan kembali lampu untuk meja ${nomorMejaPaket} saat durasi ditambah`, { error: lampErr.message });
          }
        }

        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({
          success: true,
          sessionId: mejaSession.session_id,
          nomorMeja: mejaSession.nomor_meja,
          namaPemesan: mejaSession.nama_pemesan,
          waktuMulai: mejaSession.waktu_mulai,
          durasiJamLama: durasiJamLamaPaket,
          durasiTambahJam: paketDurasiJam,
          durasiJam: durasiJamBaruPaket,
          waktuSelesaiLama: waktuSelesaiLamaPaket,
          waktuSelesai: waktuSelesaiBaruPaket,
          status: "AKTIF"
        }));
      }

      if (!sessionId || !Number.isInteger(durasiTambahJam) || durasiTambahJam < 1) {
        res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ success: false, message: "Sesi aktif tidak ditemukan" }));
      }

      const mejaSession = await getSessionById(sessionId);
      if (!mejaSession || mejaSession.status !== "AKTIF") {
        res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ success: false, message: "Sesi aktif tidak ditemukan" }));
      }

      if (String(mejaSession.jenis_sesi || "").toUpperCase() === "LOSS") {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ success: false, message: "Tidak dapat menambah durasi pada sesi LOSS" }));
      }

      const sesiPaketItems = await getSessionItems(sessionId);
      if (sesiPaketItems.some(item => { const n = String(item.nama_barang || "").trim().toLowerCase(); return n === "paket 3 jam" || n === "paket 3 jam non member"; })) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ success: false, message: "Paket 3 Jam hanya via /api/meja/buka atau /api/meja/tambah-durasi" }));
      }

      const durasiJamLama = Number(mejaSession.durasi_jam || 0);
      const durasiJamBaru = durasiJamLama + durasiTambahJam;

      const now = new Date();
      const waktuSelesaiLama = mejaSession.waktu_selesai || now.toISOString();
      const currentEnd = new Date(waktuSelesaiLama);
      const wasExpired = now >= currentEnd;

      let waktuSelesaiBaruDate;
      if (now >= currentEnd) {
        waktuSelesaiBaruDate = new Date(now.getTime() + durasiTambahJam * 3600 * 1000);
      } else {
        waktuSelesaiBaruDate = new Date(currentEnd.getTime() + durasiTambahJam * 3600 * 1000);
      }
      validasiBatasSesiMemberPagi(mejaSession.kategori_member, mejaSession.waktu_mulai, waktuSelesaiBaruDate);
      const waktuSelesaiBaru = waktuSelesaiBaruDate.toISOString();

      await new Promise((resolve, reject) => {
        db.run(
          `
          UPDATE sesi_meja
          SET durasi_jam = durasi_jam + ?, waktu_selesai = ?
          WHERE session_id = ? AND status = 'AKTIF'
          `,
          [durasiTambahJam, waktuSelesaiBaru, sessionId],
          (err) => {
            if (err) reject(err);
            else resolve();
          }
        );
      });

      const sessionAfterDuration = await getSessionById(sessionId);
      await sinkronHargaMejaBilliard(sessionAfterDuration, durasiJamBaru);
      await sinkronBonusMalam(sessionAfterDuration, durasiJamBaru);

      if (wasExpired) {
        const nomorMeja = mejaSession.nomor_meja;
        try {
          const lampRes = await lampOn(nomorMeja);
        if (lampRes && lampRes.success === true) lastLampCommandState.set(Number(nomorMeja), 1);
          if (lampRes && lampRes.success === true) {
            expiredLampSessions.delete(sessionId);
            writeLog("INFO", "LAMP_ON_EXTENDED", `Lampu dinyalakan kembali untuk meja ${nomorMeja} karena durasi ditambah`, { sessionId });
          } else {
            writeLog("WARN", "LAMP_ON_FAILED", `Gagal menyalakan kembali lampu untuk meja ${nomorMeja} saat durasi ditambah`, { lampRes });
          }
        } catch (lampErr) {
          writeLog("ERROR", "LAMP_ON_ERROR", `Error saat menyalakan kembali lampu untuk meja ${nomorMeja} saat durasi ditambah`, { error: lampErr.message });
        }
      }

      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({
        success: true,
        sessionId: mejaSession.session_id,
        nomorMeja: mejaSession.nomor_meja,
        namaPemesan: mejaSession.nama_pemesan,
        waktuMulai: mejaSession.waktu_mulai,
        durasiJamLama: durasiJamLama,
        durasiTambahJam: durasiTambahJam,
        durasiJam: durasiJamBaru,
        waktuSelesaiLama: waktuSelesaiLama,
        waktuSelesai: waktuSelesaiBaru,
        status: "AKTIF"
      }));
    } catch (error) {
      const batasPagiDitolak = String(error.message || "").startsWith("Sesi member pagi kategori ");
      res.writeHead(batasPagiDitolak ? 400 : 404, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({
        success: false,
        message: batasPagiDitolak ? error.message : "Sesi aktif tidak ditemukan"
      }));
    }
  }

  if (req.method === "POST" && req.url === "/api/meja/kurang-durasi") {
    const session = validateLoginSession(req, res);
    if (!session) return;

    try {
      const data = await getJsonBody(req);
      const code = String(data.code || "").trim();

      const totpRes = await verifyManagerTotpOnce(code);
      if (!totpRes.success) {
        const statusCode = totpRes.code === "TOTP_CONFIG_ERROR" ? 500 : 401;
        res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ success: false, code: totpRes.code, message: totpRes.message }));
      }

      const sessionId = data.sessionId;
      const durasiKurangJam = Number(data.durasiKurangJam);

      if (!sessionId || !Number.isInteger(durasiKurangJam) || durasiKurangJam < 1) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ success: false, message: "Data kurangi durasi tidak valid" }));
      }

      const mejaSession = await getSessionById(sessionId);
      if (!mejaSession || mejaSession.status !== "AKTIF") {
        res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ success: false, message: "Sesi aktif tidak ditemukan" }));
      }

      if (String(mejaSession.jenis_sesi || "").toUpperCase() === "LOSS") {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ success: false, message: "Tidak dapat mengurangi durasi pada sesi LOSS" }));
      }

      const sesiPaketKurang = await getSessionItems(sessionId);
      if (sesiPaketKurang.some(item => { const n = String(item.nama_barang || "").trim().toLowerCase(); return n === "paket 3 jam" || n === "paket 3 jam non member"; })) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ success: false, message: "Paket 3 Jam harus tetap 3 jam dengan billing Rp70.000" }));
      }

      const durasiJamLama = Number(mejaSession.durasi_jam || 0);

      if (durasiJamLama - durasiKurangJam < 1) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ success: false, message: "Durasi meja minimal 1 jam" }));
      }

      const durasiJamBaru = durasiJamLama - durasiKurangJam;
      const waktuSelesaiLama = mejaSession.waktu_selesai || new Date().toISOString();
      const currentEnd = new Date(waktuSelesaiLama);
      const waktuSelesaiBaruDate = new Date(currentEnd.getTime() - durasiKurangJam * 3600 * 1000);
      const waktuSelesaiBaru = waktuSelesaiBaruDate.toISOString();

      await new Promise((resolve, reject) => {
        db.run(
          `
          UPDATE sesi_meja
          SET durasi_jam = ?, waktu_selesai = ?
          WHERE session_id = ? AND status = 'AKTIF'
          `,
          [durasiJamBaru, waktuSelesaiBaru, sessionId],
          (err) => {
            if (err) reject(err);
            else resolve();
          }
        );
      });

      const sessionAfterDuration = await getSessionById(sessionId);
      await sinkronHargaMejaBilliard(sessionAfterDuration, durasiJamBaru);
      await sinkronBonusMalam(sessionAfterDuration, durasiJamBaru);

      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({
        success: true,
        message: "Durasi meja berhasil dikurangi",
        sessionId: mejaSession.session_id,
        nomorMeja: mejaSession.nomor_meja,
        durasiJamLama: durasiJamLama,
        durasiKurangJam: durasiKurangJam,
        durasiJam: durasiJamBaru,
        waktuSelesaiLama: waktuSelesaiLama,
        waktuSelesai: waktuSelesaiBaru
      }));
    } catch (error) {
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ success: false, message: error.message }));
    }
  }

  if (req.method === "POST" && req.url === "/api/meja/kurang-qty") {
    const session = validateLoginSession(req, res);
    if (!session) return;

    try {
      const data = await getJsonBody(req);
      const sessionId = String(data.sessionId || "").trim();
      const namaBarang = String(data.namaBarang || "").trim();

      if (['paket 3 jam', 'paket 3 jam non member'].includes(String(namaBarang).trim().toLowerCase())) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ success: false, message: 'Paket 3 Jam hanya via /api/meja/buka atau /api/meja/tambah-durasi' }));
      }

      if (!sessionId || !namaBarang) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ success: false, message: "sessionId dan namaBarang wajib diisi" }));
      }

      const mejaSession = await getSessionById(sessionId);
      if (!mejaSession || mejaSession.status !== 'AKTIF') {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ success: false, message: "Sesi meja tidak aktif atau tidak ditemukan" }));
      }

      const items = await getSessionItems(sessionId);
      const existingItem = items.find(i => String(i.nama_barang || "").trim().toLowerCase() === namaBarang.toLowerCase());

      if (!existingItem) {
        res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ success: false, message: "Item pesanan tidak ditemukan pada sesi ini" }));
      }

      const qtyLama = Number(existingItem.qty);
      const qtyBaru = qtyLama - 1;

      const masterBarang = await getLocalBarang();
      const barang = masterBarang.find(b => String(b.nama || "").trim().toLowerCase() === namaBarang.toLowerCase());
      const hargaJual = barang ? Number(barang.hargaJual || existingItem.harga_jual || 0) : Number(existingItem.harga_jual || 0);

      await runAsync("BEGIN TRANSACTION");

      try {
        if (qtyBaru <= 0) {
          await runAsync(`DELETE FROM pesanan_meja WHERE id = ?`, [existingItem.id]);
        } else {
          const newSubtotal = qtyBaru * hargaJual;
          const now = new Date().toISOString();
          await runAsync(
            `UPDATE pesanan_meja SET qty = ?, subtotal = ?, updated_at = ? WHERE id = ?`,
            [qtyBaru, newSubtotal, now, existingItem.id]
          );
        }

        await runAsync("COMMIT");

        writeLog("INFO", "MEJA_QTY_REDUCE", "Qty produk berhasil dikurangi", { sessionId, namaBarang, qtyLama, qtyBaru: qtyBaru <= 0 ? 0 : qtyBaru });

        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({
          success: true,
          message: "Qty produk berhasil dikurangi",
          sessionId: sessionId,
          namaBarang: namaBarang,
          qtyLama: qtyLama,
          qtyBaru: qtyBaru <= 0 ? 0 : qtyBaru
        }));

      } catch (txErr) {
        await runAsync("ROLLBACK");
        throw txErr;
      }

    } catch (error) {
      writeLog("ERROR", "MEJA_QTY_REDUCE_ERROR", error.message);
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ success: false, message: error.message }));
    }
  }

  if (req.method === "POST" && req.url === "/api/meja/pesanan") {
    const session = validateLoginSession(req, res);
    if (!session) return;

    try {
      const data = await getJsonBody(req);
      const sessionId = data.sessionId;
      const namaBarang = String(data.namaBarang || "").trim();
      const qty = Number(data.qty);

      if (['paket 3 jam', 'paket 3 jam non member'].includes(String(namaBarang).trim().toLowerCase())) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ success: false, message: 'Paket 3 Jam hanya via /api/meja/buka atau /api/meja/tambah-durasi' }));
      }

      if (!sessionId || !namaBarang || !qty || qty <= 0) {
        throw new Error("Data pesanan tidak valid");
      }

      const mejaSession = await getSessionById(sessionId);
      if (!mejaSession || mejaSession.status !== "AKTIF") {
        throw new Error("Sesi tidak AKTIF atau tidak ditemukan");
      }

      const masterBarang = await getLocalBarang();
      const barang = masterBarang.find(b => String(b.nama || "").trim().toLowerCase() === namaBarang.toLowerCase());
      if (!barang) {
        throw new Error(`Barang tidak ditemukan di sistem: ${namaBarang}`);
      }

      if (NAMA_BARANG_MEJA.some(nama => nama.toLowerCase() === namaBarang.toLowerCase())) {
        const namaMejaSesi = await getNamaBarangMejaSesi(sessionId);
        if (!namaMejaSesi) {
          throw new Error("Sesi tidak memiliki item meja");
        }

        const durasiJam = Number(mejaSession.durasi_jam || 0);
        if (durasiJam < 1) {
          throw new Error("Durasi sesi Meja Billiard tidak valid");
        }

        await sinkronHargaMejaBilliard(mejaSession, durasiJam);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ success: true, message: "Harga meja disinkronkan" }));
      }

      const items = await getSessionItems(sessionId);
      const existingItem = items.find(i => String(i.nama_barang || "").trim().toLowerCase() === namaBarang.toLowerCase());
      const now = new Date().toISOString();

      if (existingItem) {

        const newQty = existingItem.qty + qty;
        const newSubtotal = newQty * barang.hargaJual;

        await new Promise((resolve, reject) => {
          db.run(
            `UPDATE pesanan_meja SET qty = ?, subtotal = ?, updated_at = ? WHERE id = ?`,
            [newQty, newSubtotal, now, existingItem.id],
            (err) => {
              if (err) reject(err);
              else resolve();
            }
          );
        });
      } else {
        const subtotal = qty * barang.hargaJual;
        await new Promise((resolve, reject) => {
          db.run(
            `INSERT INTO pesanan_meja (session_id, nama_barang, qty, harga_jual, hpp, subtotal, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [sessionId, barang.nama, qty, barang.hargaJual, barang.hpp, subtotal, now, now],
            (err) => {
              if (err) reject(err);
              else resolve();
            }
          );
        });
      }

      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ success: true, message: "Pesanan ditambahkan" }));
    } catch (error) {
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ success: false, message: error.message }));
    }
  }

  if (req.method === "PUT" && req.url === "/api/meja/pesanan") {
    const session = validateLoginSession(req, res);
    if (!session) return;

    try {
      const data = await getJsonBody(req);
      const sessionId = data.sessionId;
      const namaBarang = String(data.namaBarang || "").trim();
      const qtyBaru = Number(data.qty);

      if (['paket 3 jam', 'paket 3 jam non member'].includes(String(namaBarang).trim().toLowerCase())) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ success: false, message: 'Paket 3 Jam hanya via /api/meja/buka atau /api/meja/tambah-durasi' }));
      }

      if (!sessionId || !namaBarang || isNaN(qtyBaru)) {
        throw new Error("Data pesanan tidak valid");
      }

      const mejaSession = await getSessionById(sessionId);
      if (!mejaSession || mejaSession.status !== "AKTIF") {
        throw new Error("Sesi tidak AKTIF atau tidak ditemukan");
      }

      if (NAMA_BARANG_MEJA.some(nama => nama.toLowerCase() === namaBarang.toLowerCase())) {
        const durasiJam = Number(mejaSession.durasi_jam || 0);

        if (durasiJam < 1) {
          throw new Error("Durasi sesi Meja Billiard tidak valid");
        }

        await sinkronHargaMejaBilliard(mejaSession, durasiJam);

        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({
          success: true,
          message: "Qty Meja Billiard mengikuti durasi sesi",
          durasiJam
        }));
      }

      const items = await getSessionItems(sessionId);
      const existingItem = items.find(i => String(i.nama_barang || "").trim().toLowerCase() === namaBarang.toLowerCase());
      if (!existingItem) {
        throw new Error("Pesanan tidak ada pada sesi ini");
      }

      const qtyLama = Number(existingItem.qty || 0);
      const masterBarang = await getLocalBarang();
      const barang = masterBarang.find(b => String(b.nama || "").trim().toLowerCase() === namaBarang.toLowerCase());
      const hargaJual = barang ? Number(barang.hargaJual || existingItem.harga_jual || 0) : Number(existingItem.harga_jual || 0);

      let tambahanJam = 0;
      if (namaBarang === "1 Jam" && qtyBaru > qtyLama) {
        tambahanJam = qtyBaru - qtyLama;
      }

      await runAsync("BEGIN TRANSACTION");

      try {
        if (qtyBaru <= 0) {
          await runAsync(`DELETE FROM pesanan_meja WHERE id = ?`, [existingItem.id]);
        } else {
          const newSubtotal = qtyBaru * hargaJual;
          const now = new Date().toISOString();
          await runAsync(
            `UPDATE pesanan_meja SET qty = ?, subtotal = ?, updated_at = ? WHERE id = ?`,
            [qtyBaru, newSubtotal, now, existingItem.id]
          );
        }

        let waktuSelesaiBaru = mejaSession.waktu_selesai;
        let durasiJamBaru = Number(mejaSession.durasi_jam || 0);

        if (tambahanJam > 0) {
          durasiJamBaru += tambahanJam;
          const now = new Date();
          const waktuSelesaiLama = mejaSession.waktu_selesai || now.toISOString();
          const currentEnd = new Date(waktuSelesaiLama);

          let waktuSelesaiBaruDate;
          if (now >= currentEnd) {
            waktuSelesaiBaruDate = new Date(now.getTime() + tambahanJam * 3600 * 1000);
          } else {
            waktuSelesaiBaruDate = new Date(currentEnd.getTime() + tambahanJam * 3600 * 1000);
          }
          validasiBatasSesiMemberPagi(mejaSession.kategori_member, mejaSession.waktu_mulai, waktuSelesaiBaruDate);
          waktuSelesaiBaru = waktuSelesaiBaruDate.toISOString();

          await runAsync(
            `
            UPDATE sesi_meja
            SET durasi_jam = ?, waktu_selesai = ?
            WHERE session_id = ? AND status = 'AKTIF'
            `,
            [durasiJamBaru, waktuSelesaiBaru, sessionId]
          );

          const sessionAfterDuration = await getSessionById(sessionId);
          await sinkronHargaMejaBilliard(sessionAfterDuration, durasiJamBaru);
          await sinkronBonusMalam(sessionAfterDuration, durasiJamBaru);
        }

        await runAsync("COMMIT");

        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        if (namaBarang === "1 Jam") {
          return res.end(JSON.stringify({
            success: true,
            message: "Pesanan diupdate",
            durasiDitambahkan: tambahanJam,
            durasiJam: durasiJamBaru,
            waktuSelesai: waktuSelesaiBaru
          }));
        } else {
          return res.end(JSON.stringify({ success: true, message: "Pesanan diupdate" }));
        }

      } catch (txErr) {
        await runAsync("ROLLBACK");
        throw txErr;
      }

    } catch (error) {
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ success: false, message: error.message }));
    }
  }

  if (req.method === "POST" && req.url === "/api/meja/tutup") {
    const session = validateLoginSession(req, res);
    if (!session) return;

    try {
      const data = await getJsonBody(req);
      const sessionId = data.sessionId;

      if (!sessionId) {
        throw new Error("Session ID wajib");
      }

      const mejaSession = await getSessionById(sessionId);
      if (!mejaSession) {
        throw new Error("Sesi tidak ditemukan");
      }

      const nomorMeja = mejaSession.nomor_meja;
      const waktuSelesai = new Date().toISOString();
      await closeTableSession(db, mejaSession, waktuSelesai);

      try {
        const lampRes = await lampOff(nomorMeja);
        if (lampRes && lampRes.success === true) {
          lastLampCommandState.set(Number(nomorMeja), 0);
        }
        if (!lampRes || lampRes.success !== true) {
          writeLog("WARN", "LAMP_OFF_FAILED", `Gagal mematikan lampu untuk meja ${nomorMeja} saat sesi ditutup`, { nomorMeja, lampRes });
        }
      } catch (lampErr) {
        writeLog("ERROR", "LAMP_OFF_ERROR", `Error saat mematikan lampu untuk meja ${nomorMeja} saat sesi ditutup`, { nomorMeja, error: lampErr.message });
      }

      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ success: true, message: "Sesi selesai" }));
    } catch (error) {
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ success: false, message: error.message }));
    }
  }

  // MEMBER API ENDPOINTS
    // GET /api/member/top-bulanan (Top Member Bulanan / Arsip)
    if (req.method === "GET" && req.url.startsWith("/api/member/top-bulanan")) {
      const session = validateLoginSession(req, res);
      if (!session) return;

      const parsedUrl = require("url").parse(req.url, true);
      const queryPeriode = parsedUrl.query.periode;
      const limit = parseInt(parsedUrl.query.limit) || 10;
      const currentPeriode = new Date().toISOString().slice(0, 7);

      if (queryPeriode && queryPeriode !== currentPeriode) {
        const sql = "SELECT a.kode_member, COALESCE(m.nama, 'Nama tidak ditemukan') AS nama, a.total_kunjungan, a.total_pengeluaran, a.periode FROM member_pengeluaran_bulanan a LEFT JOIN member m ON LOWER(a.kode_member) = LOWER(m.kode_member) WHERE a.periode = ? ORDER BY a.total_pengeluaran DESC LIMIT ?";
        db.all(sql, [queryPeriode, limit], (err, rows) => {
          if (err) {
            res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
            return res.end(JSON.stringify({ success: false, message: err.message }));
          }
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          return res.end(JSON.stringify({ success: true, periode: queryPeriode, data: rows }));
        });
      } else {
        const sql = "SELECT kode_member, nama, total_kunjungan, total_pengeluaran FROM member_cache ORDER BY total_pengeluaran DESC LIMIT ?";
        db.all(sql, [limit], (err, rows) => {
          if (err) {
            res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
            return res.end(JSON.stringify({ success: false, message: err.message }));
          }
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          return res.end(JSON.stringify({ success: true, periode: currentPeriode, data: rows }));
        });
      }
      return;
    }
  if (req.method === "GET" && req.url === "/api/member/kategori") {
    const session = validateLoginSession(req, res);
    if (!session) return;

    try {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({
        success: true,
        data: [
          { id: "PLATINUM", nama: "PLATINUM", aktif: 1 },
          { id: "UMUM", nama: "UMUM", aktif: 1 },
          { id: "PELAJAR", nama: "PELAJAR", aktif: 1 }
        ]
      }));
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ success: false, message: error.message }));
    }
  }

  if (req.method === "GET" && req.url === "/api/member") {
    const session = validateLoginSession(req, res);
    if (!session) return;

    try {
      const data = await getMemberListCached();

      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({
        success: true,
        total: data.length,
        data: data
      }));
    } catch (error) {
      writeLog("ERROR", "MEMBER_GET_CACHE", "Gagal mengambil data Member dari cache SQLite", { error: error.message });
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({
        success: false,
        message: "Gagal mengambil data Member dari cache"
      }));
    }
  }

  if (req.method === "POST" && req.url === "/api/member") {
    const session = validateLoginSession(req, res);
    if (!session) return;

    try {
      const data = await getJsonBody(req);
      const action = data.action;

      if (action === "list") {
        const combinedData = await getMemberListCached();

        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({
          success: true,
          total: combinedData.length,
          data: combinedData
        }));
      } else if (action === "kategori_list") {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({
          success: true,
          data: [
            { id: "PLATINUM", nama: "PLATINUM", aktif: 1 },
            { id: "UMUM", nama: "UMUM", aktif: 1 },
            { id: "PELAJAR", nama: "PELAJAR", aktif: 1 }
          ]
        }));
      } else if (action === "create") {
        const nama = String(data.nama || "").trim();
        const alamat = String(data.alamat || "").trim();
        const nomorHp = String(data.nomorHp || "").trim();
        const tanggalLahir = String(data.tanggalLahir || "").trim();
        const kategoriId = String(data.kategoriId || "").trim().toUpperCase();
        const namaSekolah = data.namaSekolah ? String(data.namaSekolah).trim() : "";
        const nisn = data.nisn ? String(data.nisn).trim() : "";

        if (!["PLATINUM", "UMUM", "PELAJAR"].includes(kategoriId)) {
          res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
          return res.end(JSON.stringify({ success: false, message: "Kategori member tidak valid." }));
        }

        if (!nama || !alamat || !nomorHp || !tanggalLahir) {
          res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
          return res.end(JSON.stringify({ success: false, message: "Semua field wajib diisi dengan benar." }));
        }

        const umur = hitungUmur(tanggalLahir);

        if (kategoriId === "PELAJAR") {
          if (!namaSekolah) {
            res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
            return res.end(JSON.stringify({ success: false, message: "Nama sekolah wajib diisi untuk kategori Pelajar." }));
          }
          if (!nisn || !/^\d{10}$/.test(nisn)) {
            res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
            return res.end(JSON.stringify({ success: false, message: "NISN harus 10 digit angka." }));
          }
          if (umur >= 19) {
            res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
            return res.end(JSON.stringify({ success: false, message: "Member Pelajar maksimal berusia 18 tahun." }));
          }
        }

        const prefixMap = {
          PLATINUM: { prefix: "PLT", baseId: 1000000, kategoriDbId: 3 },
          UMUM: { prefix: "UMM", baseId: 2000000, kategoriDbId: 2 },
          PELAJAR: { prefix: "PLJ", baseId: 3000000, kategoriDbId: 1 }
        };

        const cfg = prefixMap[kategoriId];
        const nowIso = new Date().toISOString();

        const result = await new Promise((resolve, reject) => {
          db.serialize(() => {
            const sqlMax = `
              SELECT MAX(nomor) AS nomor
              FROM (
                SELECT CAST(substr(kode_member, 5) AS INTEGER) AS nomor
                FROM member
                WHERE kode_member LIKE ?

                UNION ALL

                SELECT CAST(substr(kode_member, 5) AS INTEGER) AS nomor
                FROM member_cache
                WHERE kode_member LIKE ?
              )
            `;

            db.get(sqlMax, [cfg.prefix + "-%", cfg.prefix + "-%"], (err, row) => {
              if (err) return reject(err);

              const nomor = Number(row?.nomor || 0) + 1;
              const kodeMember = cfg.prefix + "-" + String(nomor).padStart(4, "0");
              const memberId = cfg.baseId + nomor;

              db.run(
                `
                INSERT INTO member
                (kode_member, nama, alamat, nomor_hp, tanggal_lahir, kategori_id,
                 nama_sekolah, nisn, tanggal_daftar, tanggal_aktif, last_used_at,
                 status, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `,
                [
                  kodeMember,
                  nama,
                  alamat,
                  nomorHp,
                  tanggalLahir,
                  cfg.kategoriDbId,
                  kategoriId === "PELAJAR" ? namaSekolah : null,
                  kategoriId === "PELAJAR" ? nisn : null,
                  nowIso,
                  nowIso,
                  null,
                  "MENUNGGU_AKTIF",
                  nowIso,
                  nowIso
                ],
                function(insertErr) {
                  if (insertErr) return reject(insertErr);

                  db.run(
                    `
                    INSERT OR REPLACE INTO member_cache
                    (member_id, kode_member, nama, alamat, nomor_hp, tanggal_lahir,
                     kategori_id, kategori, nama_sekolah, nisn, tanggal_daftar,
                     tanggal_aktif, last_used_at, status, total_kunjungan,
                     total_pengeluaran, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    `,
                    [
                      memberId,
                      kodeMember,
                      nama,
                      alamat,
                      nomorHp,
                      tanggalLahir,
                      kategoriId,
                      kategoriId,
                      kategoriId === "PELAJAR" ? namaSekolah : null,
                      kategoriId === "PELAJAR" ? nisn : null,
                      nowIso,
                      nowIso,
                      null,
                      "MENUNGGU_AKTIF",
                      0,
                      0,
                      nowIso
                    ],
                    cacheErr => {
                      if (cacheErr) return reject(cacheErr);

                      resolve({
                        success: true,
                        message: "Member berhasil didaftarkan.",
                        data: {
                          id: this.lastID,
                          member_id: memberId,
                          idMember: kodeMember,
                          kodeMember,
                          nama,
                          kategoriId
                        }
                      });
                    }
                  );
                }
              );
            });
          });
        });

        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify(result));
      } else {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ success: false, message: "Action Member tidak dikenal" }));
      }

    } catch (error) {
      writeLog("ERROR", "MEMBER_CREATE_ERROR", error.message);
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ success: false, message: error.message }));
    }
  }

  // ==================================================
  // STOCK OPNAME (SO) API ENDPOINTS
  // ==================================================

  function generateStockOpnameId() {
    const now = new Date();
    const stamp =
      now.getFullYear().toString() +
      String(now.getMonth() + 1).padStart(2, "0") +
      String(now.getDate()).padStart(2, "0") +
      "-" +
      String(now.getHours()).padStart(2, "0") +
      String(now.getMinutes()).padStart(2, "0") +
      String(now.getSeconds()).padStart(2, "0") +
      "-" +
      String(now.getMilliseconds()).padStart(3, "0");

    return `SO-${stamp}`;
  }

  function getLatestStockOpnameByCategory(category) {
    return new Promise((resolve, reject) => {
      db.get(
        `
        SELECT *
        FROM stock_opname
        WHERE kategori = ? AND source = 'LEGACY'
        ORDER BY id DESC
        LIMIT 1
        `,
        [category],
        (err, row) => {
          if (err) reject(err);
          else resolve(row || null);
        }
      );
    });
  }

  function getStockOpnameDetails(soId) {
    return new Promise((resolve, reject) => {
      db.all(
        `
        SELECT
          d.id_barang AS idBarang,
          d.nama_barang AS namaBarang,
          d.area,
          d.satuan,
          d.jumlah_barang_aktual AS jumlahBarangAktual,
          d.jumlah_hasil_so AS jumlahHasilSO,
          d.selisih_barang AS selisihBarang,
          d.kerugian_hpp AS kerugianHPP,
          d.kerugian_harga_jual AS kerugianHargaJual,
          d.nominal_plus AS nominalPlus
        FROM stock_opname_detail d
        JOIN stock_opname h ON h.so_id = d.so_id AND h.source = 'LEGACY'
        WHERE d.so_id = ?
        ORDER BY d.id ASC
        `,
        [soId],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows || []);
        }
      );
    });
  }

  function normalizeStockOpnameItems(items) {
    if (!Array.isArray(items)) return [];

    return items.map(item => ({
      idBarang:
        item?.idBarang ??
        item?.id_barang ??
        item?.id ??
        "",
      namaBarang:
        item?.namaBarang ??
        item?.nama_barang ??
        item?.nama ??
        "",
      area: item?.area ?? "",
      satuan: item?.satuan ?? "",
      jumlahBarangAktual: Number(
        item?.jumlahBarangAktual ??
        item?.jumlah_barang_aktual ??
        item?.jumlahAktual ??
        0
      ),
      jumlahHasilSO: Number(
        item?.jumlahHasilSO ??
        item?.jumlah_hasil_so ??
        item?.hasilSO ??
        0
      ),
      selisihBarang: Number(
        item?.selisihBarang ??
        item?.selisih_barang ??
        item?.selisih ??
        0
      ),
      kerugianHPP: Number(
        item?.kerugianHPP ??
        item?.kerugian_hpp ??
        0
      ),
      kerugianHargaJual: Number(
        item?.kerugianHargaJual ??
        item?.kerugian_harga_jual ??
        0
      ),
      nominalPlus: Number(
        item?.nominalPlus ??
        item?.nominal_plus ??
        0
      )
    }));
  }

  function normalizeStockOpnameSummary(summary) {
    const data = summary && typeof summary === "object" ? summary : {};

    const totalPlus = Number(
      data.totalPlus !== undefined
        ? data.totalPlus
        : data.total_plus !== undefined
          ? data.total_plus
          : 0
    );

    const totalMinus = Number(
      data.totalMinus !== undefined
        ? data.totalMinus
        : data.total_minus !== undefined
          ? data.total_minus
          : 0
    );

    const totalKerugian = Number(
      data.totalKerugian !== undefined
        ? data.totalKerugian
        : data.total_kerugian !== undefined
          ? data.total_kerugian
          : 0
    );

    // FIX-SO-SUBMIT-NAN-SANIZATION-V1: jangan throw — nilai tak-finit (NaN/undefined/Infinity)
    // dibersihkan ke 0 + clamp negatif, agar tidak memicu 500 "Summary hasil Stock Opname tidak valid."
    const safeTotalPlus = Number.isFinite(totalPlus) ? Math.max(0, totalPlus) : 0;
    const safeTotalMinus = Number.isFinite(totalMinus) ? Math.max(0, totalMinus) : 0;
    const safeTotalKerugian = Number.isFinite(totalKerugian) ? Math.max(0, totalKerugian) : 0;

    return {
      totalPlus: safeTotalPlus,
      totalMinus: safeTotalMinus,
      totalKerugian: safeTotalKerugian
    };
  }

  // ── Stock Opname Read-Only API ──────────────────────────────────────────────

  // GET /api/stock-opname/items?kategori=NAME — daftar barang per kategori
  if (req.method === "GET" && req.url.startsWith("/api/stock-opname/items")) {
    const session = validateLoginSession(req, res);
    if (!session) return;
    try {
      const url = new URL(req.url, `http://localhost:${config.PORT}`);
      const kategori = String(url.searchParams.get("kategori") || "").trim();
      if (!kategori) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ success: false, message: "Kategori wajib diisi" }));
      }
      // BLIND SO: kategori 'BONUS' di-exclude; stok ditampilkan 0 agar kasir tidak melihat stok riil sebelum menghitung.
      // Stok riil (stok_aktual) tetap dihitung backend saat submit berdasarkan id_barang.
      const rows = await new Promise((resolve, reject) => db.all(
        "SELECT id, id_barang, nama, kategori, 0 AS stok, hpp AS harga_modal, 'Pcs' AS satuan FROM master_barang WHERE kategori = ? AND UPPER(COALESCE(kategori, '')) != 'BONUS' ORDER BY nama ASC",
        [kategori], (error, result) => error ? reject(error) : resolve(result || [])
      ));
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ success: true, data: rows }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ success: false, message: "Gagal mengambil daftar barang", error: err.message }));
    }
  }

  // ── Stock Opname Local & Legacy ─────────────────────────────────────────────

  // Local SQLite Stock Opname draft endpoints. Legacy calculation/finalization is disabled.
  if (req.method === "GET" && req.url === "/api/stock-opname/local/barang") {
    const session = validateLoginSession(req, res);
    if (!session) return;
    try {
      const data = await stockOpnameLocal.listBarang(db);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ success: true, total: data.length, data }));
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ success: false, message: "Gagal membaca Master Barang SQLite." }));
    }
  }

  if (req.method === "GET" && req.url.startsWith("/api/stock-opname/local/status")) {
    const session = validateLoginSession(req, res);
    if (!session) return;
    try {
      const url = new URL(req.url, `http://localhost:${config.PORT}`);
      const category = String(url.searchParams.get("category") || "").trim().toUpperCase();
      if (!category) throw new TypeError("Parameter category wajib diisi");
      const row = await new Promise((resolve, reject) => db.get(
        "SELECT * FROM stock_opname WHERE source = 'LOCAL' AND kategori = ? ORDER BY id DESC LIMIT 1",
        [category], (error, result) => error ? reject(error) : resolve(result || null)
      ));
      const items = row ? await stockOpnameLocal.getDetails(db, row.so_id) : [];
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ success: true, soId: row?.so_id || null,
        revisiKe: Number(row?.revisi_ke || 0), isFinal: Boolean(row?.is_final),
        status: row?.status || null, data: row ? { soId: row.so_id, category,
          status: row.status, items, summary: { totalPlus: Number(row.total_plus || 0),
            totalMinus: Number(row.total_minus || 0), totalKerugian: Number(row.total_kerugian || 0) } } : null }));
    } catch (error) {
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ success: false, message: error.message }));
    }
  }

  if (req.method === "POST" && req.url === "/api/stock-opname/local/simpan") {
    const session = validateLoginSession(req, res);
    if (!session) return;
    try {
      const data = await getJsonBody(req);
      const category = String(data.category || data.kategori || "").trim().toUpperCase();
      const active = await new Promise((resolve, reject) => db.get(
        "SELECT so_id, status, is_final FROM stock_opname WHERE source = 'LOCAL' AND kategori = ? ORDER BY id DESC LIMIT 1",
        [category], (error, row) => error ? reject(error) : resolve(row || null)
      ));
      if (active && Number(active.is_final || 0) !== 1 && String(active.status).toUpperCase() !== "FINAL") {
        res.writeHead(409, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ success: false, code: "SO_STILL_ACTIVE",
          message: "Stock Opname aktif sudah ada; revisi lokal belum tersedia pada fase ini." }));
      }
      const result = await stockOpnameLocal.createStockOpname(db, data);
      writeLog("INFO", "SO_LOCAL_DRAFT_SUCCESS", `Stock Opname ${result.soId} tersimpan sebagai draft lokal`,
        { category, jumlahItem: result.data.items.length });
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ success: true, ...result }));
    } catch (error) {
      const conflict = localConflictResponse(error);
      const status = error.code === "SO_ITEM_NOT_FOUND" ? 404 : conflict?.status || 400;
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ success: false, code: conflict?.body.code || error.code || "SO_LOCAL_INVALID",
        message: error.message }));
    }
  }

  // 1. GET /api/stock-opname/status (legacy-compatible read-only status)
  if (req.method === "GET" && req.url.startsWith("/api/stock-opname/status")) {
    const session = validateLoginSession(req, res);
    if (!session) return;

    try {
      const url = new URL(req.url, `http://localhost:${config.PORT}`);
      const category = String(
        url.searchParams.get("category") || ""
      ).trim().toUpperCase();

      if (!category) {
        res.writeHead(400, {
          "Content-Type": "application/json; charset=utf-8"
        });
        return res.end(
          JSON.stringify({
            success: false,
            message: "Parameter category wajib diisi"
          })
        );
      }

      const row = await getLatestStockOpnameByCategory(category);

      if (!row || row.is_final === 1 || row.status === "FINAL") {
        res.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8"
        });
        return res.end(
          JSON.stringify({
            success: true,
            soId: null,
            revisiKe: 0,
            isFinal: false,
            status: null
          })
        );
      }

      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8"
      });
      return res.end(
        JSON.stringify({
          success: true,
          soId: row.so_id,
          revisiKe: Number(row.revisi_ke || 0),
          isFinal: Boolean(row.is_final),
          status: row.status
        })
      );
    } catch (error) {
      writeLog("ERROR", "SO_STATUS_ERROR", error.message);
      res.writeHead(500, {
        "Content-Type": "application/json; charset=utf-8"
      });
      return res.end(
        JSON.stringify({
          success: false,
          message: error.message
        })
      );
    }
  }

  // ── Stock Opname Submit ──────────────────────────────────
  // POST /api/stock-opname/submit — atomic save + stock update (aligned to real DB schema)
  if (req.method === "POST" && req.url === "/api/stock-opname/submit") {
    const session = validateLoginSession(req, res);
    if (!session) return;
    try {
      const data = await getJsonBody(req);
      const kategori = String(data.kategori || "SEMUA BARANG").trim();
      const items = Array.isArray(data.items) ? data.items : [];
      const petugas = String(data.petugas || (session && session.nama ? session.nama : "Kasir")).trim();

      if (items.length === 0) {
        if (!res.headersSent) {
          res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
          return res.end(JSON.stringify({ success: false, message: "Data item stock opname tidak boleh kosong." }));
        }
        return;
      }

      const soId = "SO-" + Date.now();
      const now = new Date().toISOString();

      // BLIND SO: frontend mengirim stok_sistem = 0 (stok riil tidak ditampilkan saat form input).
      // Item dari form memakai `produk_id` = PK INTEGER (id) dari /api/stock-opname/items,
      // bukan id_barang (TEXT). Backend re-resolve stok_aktual & hpp riil dari master_barang
      // (cocokkan via id ATAU id_barang) sehingga selisih & kerugian HPP tetap akurat.
      const keyOf = (it) => it.id != null ? String(it.id)
        : (it.produk_id != null ? String(it.produk_id)
        : (it.idBarang != null ? String(it.idBarang)
        : (it.id_barang != null ? String(it.id_barang)
        : (it.produkId != null ? String(it.produkId) : null))));
      const itemKeys = [];
      for (const item of items) {
        const k = keyOf(item);
        if (k != null && !itemKeys.includes(k)) itemKeys.push(k);
      }
      const dbInfoMap = new Map(); // key -> { id, idBarang, stokRiil, hpp }
      if (itemKeys.length > 0) {
        const placeholders = itemKeys.map(() => "?").join(", ");
        const dbRows = await new Promise((resolve, reject) => db.all(
          "SELECT id, id_barang, stok_aktual, hpp FROM master_barang WHERE id IN (" + placeholders + ") OR id_barang IN (" + placeholders + ")",
          itemKeys.concat(itemKeys), (error, result) => error ? reject(error) : resolve(result || [])
        ));
        for (const r of dbRows) {
          const info = { id: r.id, idBarang: r.id_barang != null ? String(r.id_barang) : null,
            stokRiil: Number.isFinite(Number(r.stok_aktual)) ? Number(r.stok_aktual) : 0,
            hpp: Number.isFinite(Number(r.hpp)) ? Number(r.hpp) : 0 };
          if (r.id != null) dbInfoMap.set(String(r.id), info);
          if (info.idBarang != null) dbInfoMap.set(info.idBarang, info);
        }
      }

      let totalPlus = 0;
      let totalMinus = 0;
      let totalKerugian = 0;

      const resolvedItems = items.map(item => {
        const key = keyOf(item);
        const info = key != null ? dbInfoMap.get(key) : null;
        const stokRiil = info ? info.stokRiil : 0;
        const hpp = info ? info.hpp : (Number.isFinite(Number(item.harga_modal)) ? Number(item.harga_modal)
          : (Number.isFinite(Number(item.hpp)) ? Number(item.hpp) : 0));
        const stokFisik = Number.isFinite(Number(item.stok_fisik)) ? Number(item.stok_fisik) : 0;
        const selisih = stokFisik - stokRiil;
        if (selisih > 0) totalPlus += selisih;
        else if (selisih < 0) { totalMinus += Math.abs(selisih); totalKerugian += Math.abs(selisih) * hpp; }
        return { item, key, idMaster: info ? info.id : null, idBarang: info ? info.idBarang : null, stokRiil, stokFisik, selisih, hpp };
      });

      // Sanitasi total summary: NaN/undefined tidak boleh lolos ke DB (SQLite bind error),
      // bersihkan ke 0 + clamp negatif (lembaga tidak boleh menghasilkan nilai minus di rekap).
      totalPlus = Number.isFinite(totalPlus) ? Math.max(0, totalPlus) : 0;
      totalMinus = Number.isFinite(totalMinus) ? Math.max(0, totalMinus) : 0;
      totalKerugian = Number.isFinite(totalKerugian) ? Math.max(0, totalKerugian) : 0;

      // Helper: proses satu item (INSERT detail + UPDATE master_barang) dalam satu Promise
      const processItem = (itemData, soId, now) => {
        return new Promise((resolve, reject) => {
          const { item, idMaster, idBarang, stokRiil, stokFisik, selisih, hpp } = itemData;
          const rugiModal = selisih < 0 ? Math.abs(selisih) * hpp : 0;

          // Anti-undefined SQLite bind: setiap parameter harus terisolasi sebelum masuk db.run.
          const safeIdMaster = idMaster != null ? idMaster : null;
          const safeIdBarang = idBarang != null ? String(idBarang) : null;
          const safeNamaBarang = (item.nama != null || item.nama_barang != null || item.namaBarang != null)
            ? String(item.nama != null ? item.nama : (item.nama_barang != null ? item.nama_barang : item.namaBarang))
            : "Barang Tanpa Nama";
          const safeSatuan = item.satuan != null ? String(item.satuan) : "Pcs";
          const safeStokRiil = Number.isFinite(Number(stokRiil)) ? Number(stokRiil) : 0;
          const safeStokFisik = Number.isFinite(Number(stokFisik)) ? Number(stokFisik) : 0;
          const safeSelisih = Number.isFinite(Number(selisih)) ? Number(selisih) : 0;
          const safeRugiModal = Number.isFinite(Number(rugiModal)) ? Number(rugiModal) : 0;

          db.run(
            "INSERT INTO stock_opname_detail (so_id, local_master_barang_id, id_barang, nama_barang, satuan, jumlah_barang_aktual, jumlah_hasil_so, selisih_barang, kerugian_hpp, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [soId, safeIdMaster, safeIdBarang, safeNamaBarang, safeSatuan, safeStokRiil, safeStokFisik, safeSelisih, safeRugiModal, now, now],
            err => {
              if (err) return reject(err);
              if (idMaster != null) {
                db.run(
                  "UPDATE master_barang SET stok_aktual = ?, updated_at = ? WHERE id = ?",
                  [safeStokFisik, now, safeIdMaster],
                  err2 => err2 ? reject(err2) : resolve()
                );
              } else if (idBarang != null) {
                db.run(
                  "UPDATE master_barang SET stok_aktual = ?, updated_at = ? WHERE id_barang = ?",
                  [safeStokFisik, now, safeIdBarang],
                  err2 => err2 ? reject(err2) : resolve()
                );
              } else {
                resolve();
              }
            }
          );
        });
      };

      await new Promise((resolve, reject) => db.run("BEGIN TRANSACTION", err => err ? reject(err) : resolve()));

      try {
        // 1. INSERT header into stock_opname
        await new Promise((resolve, reject) => {
          db.run(
            "INSERT INTO stock_opname (so_id, kategori, petugas, tanggal, status, is_final, total_plus, total_minus, total_kerugian, created_at, updated_at, source) VALUES (?, ?, ?, ?, 'COMPLETED', 1, ?, ?, ?, ?, ?, 'POS')",
            [soId, kategori, petugas, now, totalPlus, totalMinus, totalKerugian, now, now],
            function (err) {
              if (err) return reject(err);
              resolve();
            }
          );
        });

        // 2. Per-item: INSERT detail + UPDATE master_barang — gunakan Promise.all
        const itemPromises = resolvedItems.map(itemData => processItem(itemData, soId, now));

        await Promise.all(itemPromises);

        await new Promise((resolve, reject) => db.run("COMMIT", err => err ? reject(err) : resolve()));
      } catch (txnErr) {
        await new Promise((resolve) => db.run("ROLLBACK", () => resolve()));
        throw txnErr;
      }

      writeLog("INFO", "SO_SUBMIT_SUCCESS", "Stock Opname " + soId + " untuk " + kategori + " berhasil disimpan", { kategori, itemCount: items.length, soId });
      if (!res.headersSent) {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ success: true, message: "Stock Opname berhasil disimpan", data: { so_id: soId, total_kerugian: totalKerugian } }));
      }
    } catch (err) {
      writeLog("ERROR", "SO_SUBMIT_ERROR", err.message);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ success: false, message: "Gagal memproses stock opname", error: err.message }));
      }
    }
  }

  // ── Stock Opname History & Monthly Recap ────────────────────────────────────

  // GET /api/stock-opname/history — 30 transaksi terbaru
  if (req.method === "GET" && req.url === "/api/stock-opname/history") {
    const session = validateLoginSession(req, res);
    if (!session) return;
    try {
      const rows = await new Promise((resolve, reject) => db.all(
        `SELECT
            so.id,
            so.so_id,
            COALESCE(so.tanggal, so.created_at) as tanggal,
            so.kategori,
            COALESCE(so.petugas, 'Kasir/Admin') as nama_kasir,
            (SELECT COUNT(*) FROM stock_opname_detail sod WHERE sod.so_id = so.so_id) as total_item,
            (COALESCE(so.total_plus, 0) - COALESCE(so.total_minus, 0)) as total_selisih_qty,
            COALESCE(so.total_kerugian, 0) as total_kerugian_modal,
            '' as catatan
          FROM stock_opname so
          ORDER BY so.id DESC
          LIMIT 30`,
        [],
        (err, result) => err ? reject(err) : resolve(result || [])
      ));
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ success: true, data: rows }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ success: false, message: "Gagal mengambil riwayat stock opname", error: err.message }));
    }
  }

  // GET /api/stock-opname/detail/:id — rincian satu transaksi SO
  if (req.method === "GET" && /^\/api\/stock-opname\/detail\/\d+$/.test(req.url)) {
    const session = validateLoginSession(req, res);
    if (!session) return;
    const id = parseInt(req.url.split("/").pop(), 10);
    if (isNaN(id)) {
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ success: false, message: "ID tidak valid" }));
    }
    try {
      const rows = await new Promise((resolve, reject) => db.all(
        `SELECT
            d.id,
            d.so_id AS stock_opname_id,
            d.local_master_barang_id AS produk_id,
            COALESCE(d.nama_barang, p.nama) AS nama,
            d.jumlah_barang_aktual AS stok_sistem,
            d.jumlah_hasil_so AS stok_fisik,
            d.selisih_barang AS selisih,
            COALESCE(p.hpp, 0) AS harga_modal,
            d.kerugian_hpp AS total_rugi_modal,
            COALESCE(d.satuan, 'Pcs') AS satuan
          FROM stock_opname_detail d
          LEFT JOIN master_barang p ON d.local_master_barang_id = p.id
          WHERE d.so_id = ?
          ORDER BY d.id ASC`,
        [id],
        (err, result) => err ? reject(err) : resolve(result || [])
      ));
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ success: true, data: rows }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ success: false, message: "Gagal mengambil detail stock opname", error: err.message }));
    }
  }

  // GET /api/stock-opname/rekap-bulanan?bulan=YYYY-MM — rekap kerugian bulanan
  if (req.method === "GET" && req.url.startsWith("/api/stock-opname/rekap-bulanan")) {
    const session = validateLoginSession(req, res);
    if (!session) return;
    try {
      const url = new URL(req.url, `http://localhost:${config.PORT}`);
      const bulan = String(url.searchParams.get("bulan") || "").trim();
      const periode = bulan || new Date().toISOString().slice(0, 7); // YYYY-MM
      const row = await new Promise((resolve, reject) => db.get(
        `SELECT COUNT(id) as total_transaksi_so,
                COALESCE(SUM(COALESCE(total_plus,0) - COALESCE(total_minus,0)), 0) as total_selisih_qty,
                COALESCE(SUM(COALESCE(total_kerugian,0)), 0) as akumulasi_kerugian_modal
         FROM stock_opname
         WHERE strftime('%Y-%m', COALESCE(tanggal, created_at)) = ?`,
        [periode],
        (err, result) => err ? reject(err) : resolve(result || null)
      ));
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ success: true, periode, data: row }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ success: false, message: "Gagal mengambil rekap bulanan", error: err.message }));
    }
  }

  // 2. POST /api/stock-opname/simpan
  if (req.method === "POST" && req.url === "/api/stock-opname/simpan") {
    const session = validateLoginSession(req, res);
    if (!session) return;

    try {
      const data = await getJsonBody(req);

      const category = String(data.category || "").trim().toUpperCase();
      const petugas = String(data.petugas || "").trim();
      const items = data.items;
      const mode = String(data.mode || "").trim().toUpperCase();
      const requestedSoId = String(data.soId || "").trim();

      if (!category) {
        res.writeHead(400, {
          "Content-Type": "application/json; charset=utf-8"
        });
        return res.end(
          JSON.stringify({
            success: false,
            message: "Category wajib diisi"
          })
        );
      }

      if (!petugas) {
        res.writeHead(400, {
          "Content-Type": "application/json; charset=utf-8"
        });
        return res.end(
          JSON.stringify({
            success: false,
            message: "Petugas wajib diisi"
          })
        );
      }

      if (!Array.isArray(items) || items.length === 0) {
        res.writeHead(400, {
          "Content-Type": "application/json; charset=utf-8"
        });
        return res.end(
          JSON.stringify({
            success: false,
            message: "Items harus berupa array dan tidak boleh kosong"
          })
        );
      }

      const seenItemIds = new Set();

      for (const item of items) {
        const idBarang = String(
          item?.idBarang ??
          item?.id_barang ??
          ""
        ).trim();

        if (!idBarang) {
          res.writeHead(400, {
            "Content-Type": "application/json; charset=utf-8"
          });
          return res.end(
            JSON.stringify({
              success: false,
              message: "Setiap item wajib memiliki idBarang"
            })
          );
        }

        if (seenItemIds.has(idBarang)) {
          res.writeHead(400, {
            "Content-Type": "application/json; charset=utf-8"
          });
          return res.end(
            JSON.stringify({
              success: false,
              message: `Barang duplikat dalam Stock Opname: ${idBarang}`
            })
          );
        }

        seenItemIds.add(idBarang);

        const qty = Number(
          item?.jumlahHasilSO ??
          item?.jumlah_hasil_so
        );

        if (!Number.isFinite(qty) || qty < 0) {
          res.writeHead(400, {
            "Content-Type": "application/json; charset=utf-8"
          });
          return res.end(
            JSON.stringify({
              success: false,
              message: "jumlahHasilSO harus berupa angka non-negatif"
            })
          );
        }
      }

      const currentSO = await getLatestStockOpnameByCategory(category);
      const currentIsActive =
        Boolean(currentSO) &&
        Number(currentSO.is_final || 0) !== 1 &&
        String(currentSO.status || "").toUpperCase() !== "FINAL";

      let isNewSO = false;
      let targetSoId = "";
      let targetRevisiKe = 0;

      if (mode === "NEW") {
        if (currentIsActive) {
          res.writeHead(409, {
            "Content-Type": "application/json; charset=utf-8"
          });
          return res.end(
            JSON.stringify({
              success: false,
              code: "SO_STILL_ACTIVE",
              message:
                "Masih ada Stock Opname aktif untuk kategori ini. Gunakan mode revisi."
            })
          );
        }

        isNewSO = true;
        targetSoId = generateStockOpnameId();
        targetRevisiKe = 0;
      } else if (mode === "REVISION") {
        if (!currentIsActive) {
          res.writeHead(409, {
            "Content-Type": "application/json; charset=utf-8"
          });
          return res.end(
            JSON.stringify({
              success: false,
              code: "NO_ACTIVE_SO",
              message:
                "Tidak ada Stock Opname aktif untuk direvisi."
            })
          );
        }

        if (Number(currentSO.revisi_ke || 0) >= 1) {
          res.writeHead(409, {
            "Content-Type": "application/json; charset=utf-8"
          });
          return res.end(
            JSON.stringify({
              success: false,
              code: "REVISION_LIMIT",
              message:
                "Jatah revisi sudah habis. Revisi maksimal hanya 1 kali."
            })
          );
        }

        if (
          requestedSoId &&
          requestedSoId !== String(currentSO.so_id)
        ) {
          res.writeHead(409, {
            "Content-Type": "application/json; charset=utf-8"
          });
          return res.end(
            JSON.stringify({
              success: false,
              code: "SO_ID_MISMATCH",
              message:
                "soId revisi tidak sesuai dengan Stock Opname aktif."
            })
          );
        }

        isNewSO = false;
        targetSoId = currentSO.so_id;
        targetRevisiKe = 1;
      } else {
        res.writeHead(400, {
          "Content-Type": "application/json; charset=utf-8"
        });
        return res.end(
          JSON.stringify({
            success: false,
            code: "INVALID_SO_MODE",
            message:
              "Mode Stock Opname harus NEW atau REVISION."
          })
        );
      }

      const tanggalSO =
        data.tanggalSO || new Date().toISOString();

      await callLegacyStockOpnameGas(data);

      // Intentionally unreachable: legacy formulas, approval rules and revision
      // history have not been verified for a safe local replacement.
      const gasResult = null;

      const gasData = gasResult.data || gasResult;
      const resultItems = normalizeStockOpnameItems(
        gasData.items || gasResult.items
      );
      const resultSummary = normalizeStockOpnameSummary(
        gasData.summary || gasResult.summary
      );

      if (resultItems.length === 0) {
        throw new Error(
          "Hasil Stock Opname tidak tersedia."
        );
      }

      const nowIso = new Date().toISOString();

      await runAsync("BEGIN TRANSACTION");

      try {
        if (isNewSO) {
          await runAsync(
            `
            INSERT INTO stock_opname
            (
              so_id,
              source,
              kategori,
              petugas,
              tanggal,
              revisi_ke,
              is_final,
              status,
              total_plus,
              total_minus,
              total_kerugian,
              created_at,
              updated_at
            )
            VALUES (?, 'LEGACY', ?, ?, ?, 0, 0, 'HASIL', ?, ?, ?, ?, ?)
            `,
            [
              targetSoId,
              category,
              petugas,
              tanggalSO,
              resultSummary.totalPlus,
              resultSummary.totalMinus,
              resultSummary.totalKerugian,
              nowIso,
              nowIso
            ]
          );
        } else {
          await runAsync(
            `
            UPDATE stock_opname
            SET
              petugas = ?,
              tanggal = ?,
              revisi_ke = 1,
              is_final = 0,
              status = 'HASIL',
              total_plus = ?,
              total_minus = ?,
              total_kerugian = ?,
              updated_at = ?
            WHERE
              so_id = ?
              AND is_final = 0
              AND status != 'FINAL'
              AND source = 'LEGACY'
            `,
            [
              petugas,
              tanggalSO,
              resultSummary.totalPlus,
              resultSummary.totalMinus,
              resultSummary.totalKerugian,
              nowIso,
              targetSoId
            ]
          );
        }

        if (!isNewSO) {
          await runAsync(
            `DELETE FROM stock_opname_detail WHERE so_id = ? AND EXISTS
              (SELECT 1 FROM stock_opname WHERE so_id = ? AND source = 'LEGACY')`,
            [targetSoId, targetSoId]
          );
        }

        for (const item of resultItems) {
          await runAsync(
            `
            INSERT INTO stock_opname_detail
            (
              so_id,
              id_barang,
              nama_barang,
              area,
              satuan,
              jumlah_barang_aktual,
              jumlah_hasil_so,
              selisih_barang,
              kerugian_hpp,
              kerugian_harga_jual,
              nominal_plus,
              created_at,
              updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `,
            [
              targetSoId,
              String(item.idBarang || ""),
              String(item.namaBarang || ""),
              String(item.area || ""),
              String(item.satuan || ""),
              Number(item.jumlahBarangAktual || 0),
              Number(item.jumlahHasilSO || 0),
              Number(item.selisihBarang || 0),
              Number(item.kerugianHPP || 0),
              Number(item.kerugianHargaJual || 0),
              Number(item.nominalPlus || 0),
              nowIso,
              nowIso
            ]
          );
        }

        await runAsync("COMMIT");
      } catch (dbError) {
        try {
          await runAsync("ROLLBACK");
        } catch (_) {}
        throw dbError;
      }

      const folderPathSO = path.join(
        __dirname,
        "data",
        "stock-opname"
      );

      if (!fs.existsSync(folderPathSO)) {
        fs.mkdirSync(folderPathSO, { recursive: true });
      }

      const cacheContent = {
        soId: targetSoId,
        kategori: category,
        petugas,
        tanggal: tanggalSO,
        revisiKe: targetRevisiKe,
        isFinal: false,
        status: "HASIL",
        summary: resultSummary,
        items: resultItems
      };

      const internalCachePath = path.join(
        folderPathSO,
        `so-${targetSoId}.json`
      );

      fs.writeFileSync(
        internalCachePath,
        JSON.stringify(cacheContent, null, 2),
        "utf8"
      );

      writeLog(
        "INFO",
        "SO_SIMPAN_SUCCESS",
        `Stock Opname ${targetSoId} berhasil disimpan`,
        {
          category,
          revisiKe: targetRevisiKe,
          jumlahItem: resultItems.length
        }
      );

      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8"
      });

      return res.end(
        JSON.stringify({
          success: true,
          soId: targetSoId,
          revisiKe: targetRevisiKe,
          data: {
            soId: targetSoId,
            category,
            items: resultItems,
            summary: resultSummary
          }
        })
      );
    } catch (error) {
      writeLog("ERROR", "SO_SIMPAN_ERROR", error.message);
      const localConflict = localConflictResponse(error);
      const status = error.statusCode || localConflict?.status || 500;
      res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8"
      });
      return res.end(
        JSON.stringify({
          success: false,
          ...(localConflict ? localConflict.body : error.code ? { code: error.code } : {}),
          message: error.message
        })
      );
    }
  }

  // 3. POST /api/stock-opname/snapshot
  if (req.method === "POST" && req.url === "/api/stock-opname/snapshot") {
    const session = validateLoginSession(req, res);
    if (!session) return;

    try {
      const data = await getJsonBody(req);
      const soId = String(
        data.soId || data.so_id || ""
      ).trim();

      if (!soId) {
        res.writeHead(400, {
          "Content-Type": "application/json; charset=utf-8"
        });
        return res.end(
          JSON.stringify({
            success: false,
            message: "soId wajib diisi"
          })
        );
      }

      const currentSO = await new Promise((resolve, reject) => {
        db.get(
          `SELECT * FROM stock_opname WHERE so_id = ? AND source = 'LEGACY'`,
          [soId],
          (err, row) => {
            if (err) reject(err);
            else resolve(row || null);
          }
        );
      });

      if (!currentSO) {
        res.writeHead(404, {
          "Content-Type": "application/json; charset=utf-8"
        });
        return res.end(
          JSON.stringify({
            success: false,
            message:
              "Stock Opname tidak ditemukan di database server"
          })
        );
      }

      const items = await getStockOpnameDetails(
        currentSO.so_id
      );

      if (items.length === 0) {
        res.writeHead(409, {
          "Content-Type": "application/json; charset=utf-8"
        });
        return res.end(
          JSON.stringify({
            success: false,
            message:
              "Detail hasil Stock Opname belum tersimpan di server"
          })
        );
      }

      const folderPath = path.join(
        __dirname,
        "data",
        "stock-opname"
      );

      if (!fs.existsSync(folderPath)) {
        fs.mkdirSync(folderPath, { recursive: true });
      }

      const now = new Date();
      const dateStr =
        now.getFullYear().toString() +
        String(now.getMonth() + 1).padStart(2, "0") +
        String(now.getDate()).padStart(2, "0");

      const timeStr =
        String(now.getHours()).padStart(2, "0") +
        String(now.getMinutes()).padStart(2, "0") +
        String(now.getSeconds()).padStart(2, "0");

      const fileName =
        `${currentSO.so_id}-${dateStr}-${timeStr}.json`;

      const filePath = path.join(folderPath, fileName);

      const snapshotContent = {
        soId: currentSO.so_id,
        kategori: currentSO.kategori,
        petugas: currentSO.petugas,
        tanggal: currentSO.tanggal,
        revisiKe: Number(currentSO.revisi_ke || 0),
        isFinal: Boolean(currentSO.is_final),
        status: currentSO.status,
        createdAt: currentSO.created_at,
        updatedAt: currentSO.updated_at,
        summary: {
          totalPlus: Number(currentSO.total_plus || 0),
          totalMinus: Number(currentSO.total_minus || 0),
          totalKerugian: Number(currentSO.total_kerugian || 0)
        },
        items
      };

      fs.writeFileSync(
        filePath,
        JSON.stringify(snapshotContent, null, 2),
        "utf8"
      );

      writeLog(
        "INFO",
        "SO_SNAPSHOT",
        `Snapshot SO disimpan di ${fileName}`
      );

      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8"
      });

      return res.end(
        JSON.stringify({
          success: true,
          message: "Snapshot berhasil disimpan",
          soId: currentSO.so_id,
          fileName
        })
      );
    } catch (error) {
      writeLog(
        "ERROR",
        "SO_SNAPSHOT_ERROR",
        error.message
      );

      res.writeHead(500, {
        "Content-Type": "application/json; charset=utf-8"
      });

      return res.end(
        JSON.stringify({
          success: false,
          message: error.message
        })
      );
    }
  }

  // 4. POST /api/stock-opname/finalize
  if (req.method === "POST" && req.url === "/api/stock-opname/finalize") {
    const session = validateLoginSession(req, res);
    if (!session) return;

    res.writeHead(503, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify({ success: false, code: "SO_FINALIZE_DISABLED",
      message: "Finalisasi dinonaktifkan sampai aturan persetujuan, nominal, dan riwayat legacy tervalidasi." }));

    try {
      const data = await getJsonBody(req);
      const category = String(
        data.category || ""
      ).trim().toUpperCase();
      const soIdInput = String(
        data.soId || data.so_id || ""
      ).trim();

      let currentSO = null;

      if (soIdInput) {
        currentSO = await new Promise((resolve, reject) => {
          db.get(
            `SELECT * FROM stock_opname WHERE so_id = ? AND source = 'LEGACY'`,
            [soIdInput],
            (err, row) => {
              if (err) reject(err);
              else resolve(row || null);
            }
          );
        });
      } else if (category) {
        currentSO = await getLatestStockOpnameByCategory(
          category
        );
      } else {
        res.writeHead(400, {
          "Content-Type": "application/json; charset=utf-8"
        });
        return res.end(
          JSON.stringify({
            success: false,
            message: "soId atau category wajib diisi"
          })
        );
      }

      if (!currentSO) {
        res.writeHead(404, {
          "Content-Type": "application/json; charset=utf-8"
        });
        return res.end(
          JSON.stringify({
            success: false,
            message: "Data Stock Opname belum ditemukan"
          })
        );
      }

      if (!stockOpnameLocal.isLegacyStockOpname(currentSO)) {
        res.writeHead(409, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ success: false, code: "SO_LOCAL_NOT_FINALIZABLE",
          message: "Draft Stock Opname lokal tidak dapat difinalisasi melalui flow legacy." }));
      }

      if (
        Number(currentSO.is_final || 0) === 1 ||
        String(currentSO.status || "").toUpperCase() === "FINAL"
      ) {
        res.writeHead(409, {
          "Content-Type": "application/json; charset=utf-8"
        });
        return res.end(
          JSON.stringify({
            success: false,
            code: "SO_ALREADY_FINAL",
            message:
              "Stock Opname sudah difinalisasi sebelumnya."
          })
        );
      }

      const detailRows = await getStockOpnameDetails(
        currentSO.so_id
      );

      if (detailRows.length === 0) {
        res.writeHead(409, {
          "Content-Type": "application/json; charset=utf-8"
        });
        return res.end(
          JSON.stringify({
            success: false,
            code: "SO_RESULT_NOT_READY",
            message:
              "Hasil Stock Opname belum tersedia di server."
          })
        );
      }

      const nowIso = new Date().toISOString();

      const finalizeRes = await runAsync(
        `
        UPDATE stock_opname
        SET
          is_final = 1,
          status = 'FINAL',
          updated_at = ?
        WHERE
          so_id = ?
          AND source = 'LEGACY'
          AND is_final = 0
          AND status != 'FINAL'
        `,
        [nowIso, currentSO.so_id]
      );

      if (finalizeRes.changes !== 1) {
        throw new Error(
          "Gagal mengunci Stock Opname di database server."
        );
      }

      const folderPathSO = path.join(
        __dirname,
        "data",
        "stock-opname"
      );

      if (!fs.existsSync(folderPathSO)) {
        fs.mkdirSync(folderPathSO, { recursive: true });
      }

      const internalCachePath = path.join(
        folderPathSO,
        `so-${currentSO.so_id}.json`
      );

      if (fs.existsSync(internalCachePath)) {
        try {
          const cached = JSON.parse(
            fs.readFileSync(
              internalCachePath,
              "utf8"
            )
          );

          cached.isFinal = true;
          cached.status = "FINAL";
          cached.updatedAt = nowIso;

          fs.writeFileSync(
            internalCachePath,
            JSON.stringify(cached, null, 2),
            "utf8"
          );
        } catch (cacheError) {
          writeLog(
            "WARN",
            "SO_CACHE_UPDATE_FAILED",
            `Gagal memperbarui cache SO ${currentSO.so_id}`,
            { error: cacheError.message }
          );
        }
      }

      writeLog(
        "INFO",
        "SO_FINALIZE_SUCCESS",
        `SO ${currentSO.so_id} kategori ${currentSO.kategori} berhasil difinalisasi`
      );

      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8"
      });

      return res.end(
        JSON.stringify({
          success: true,
          message:
            "Stock Opname berhasil difinalisasi",
          soId: currentSO.so_id
        })
      );
    } catch (error) {
      writeLog(
        "ERROR",
        "SO_FINALIZE_ERROR",
        error.message
      );

      res.writeHead(500, {
        "Content-Type": "application/json; charset=utf-8"
      });

      return res.end(
        JSON.stringify({
          success: false,
          message: error.message
        })
      );
    }
  }

  // FAVICON & FALLBACK
  if (req.method === "GET" && req.url === "/favicon.ico") {
    res.writeHead(204);
    return res.end();
  }

  writeLog("WARN", "HTTP_404", `Endpoint tidak ditemukan: ${req.method} ${req.url}`);
  res.writeHead(404);
  res.end(JSON.stringify({ success: false, message: "Endpoint tidak ditemukan" }));

});


// ==================================================
// SERVER START
// ==================================================

let lampWatchdogRunning = false;
const lastLampCommandState = new Map();
let lampTestRunning = false;

async function reconcileLampState() {
  if (lampWatchdogRunning || lampTestRunning) return;

  lampWatchdogRunning = true;

  try {
    const rows = await new Promise((resolve, reject) => {
      db.all(
        `SELECT nomor_meja, waktu_selesai, jenis_sesi
         FROM sesi_meja
         WHERE status = 'AKTIF'`,
        [],
        (error, result) => {
          if (error) reject(error);
          else resolve(result || []);
        }
      );
    });

    const now = Date.now();
    const desiredLampState = new Map();

    for (const row of rows) {
      const table = Number(row.nomor_meja);

      if (
        !Number.isInteger(table) ||
        table < 1 ||
        table > 10
      ) {
        continue;
      }

      const jenisSesi = String(
        row.jenis_sesi || ""
      )
        .trim()
        .toUpperCase();

      // LOSS tetap ON sampai lifecycle LOSS mengakhirinya.
      if (
        jenisSesi === "LOSS" ||
        !row.waktu_selesai
      ) {
        desiredLampState.set(table, 1);
        continue;
      }

      const endMs = new Date(
        row.waktu_selesai
      ).getTime();

      const shouldBeOn =
        !Number.isFinite(endMs) ||
        endMs > now;

      desiredLampState.set(
        table,
        shouldBeOn ? 1 : 0
      );
    }

    writeLog(
      "INFO",
      "LAMP_WATCHDOG_START",
      "Watchdog lampu melakukan sinkronisasi",
      {
        desiredLampState: [
          ...desiredLampState.entries()
        ]
          .sort(([a], [b]) => a - b)
          .map(([table, state]) => ({
            table,
            state
          }))
      }
    );

    for (let table = 1; table <= 10; table++) {
      try {
        const desiredState =
          desiredLampState.get(table) === 1
            ? 1
            : 0;

        const lastState =
          lastLampCommandState.get(table);

        // A table with no active session starts in the known OFF state; avoid
        // issuing a redundant OFF command during the watchdog's first pass.
        if (!desiredLampState.has(table) && lastState === undefined) {
          lastLampCommandState.set(Number(table), 0);
          continue;
        }

        // Recovery: active sessions must reissue ON after any non-ON command state.
        if (
          (desiredState === 1 && lastState === 1) ||
          (desiredState === 0 && lastState === 0)
        ) {
          continue;
        }

        const command = desiredState === 1 ? "ON" : "OFF";
        let lampRes;
        let commandFailed = false;
        let commandError = null;
        try {
          lampRes = desiredState === 1
            ? await lampOn(table)
            : await lampOff(table);
          if (!lampRes || lampRes.success !== true) {
            commandFailed = true;
            commandError = lampRes && (lampRes.error?.message || lampRes.error || lampRes.message);
          }
        } catch (error) {
          commandFailed = true;
          commandError = error && (error.message || String(error));
        }

        if (!commandFailed) {
          lastLampCommandState.set(
            table,
            desiredState
          );

          const incidents = await new Promise((resolve, reject) => {
            db.all(
              `SELECT id FROM lamp_alarm_history
               WHERE table_number = ? AND command = ? AND status = 'ACTIVE'`,
              [table, command],
              (error, result) => error ? reject(error) : resolve(result || [])
            );
          });
          const recoveredAt = new Date().toISOString();
          for (const incident of incidents) {
            await createClearedLampAlarmIncident(incident.id, recoveredAt);
          }
        } else {
          const errorMessage = String(commandError || "Lamp command failed (no error message)");
          const classification = classifyLampError(errorMessage);
          const failedAt = new Date().toISOString();
          const incident = await findActiveLampAlarmIncident(
            table,
            command,
            classification.error_category
          );
          if (incident) {
            await updateActiveLampAlarmIncidentFailure(incident.id, failedAt);
          } else {
            await createActiveLampAlarmIncident({
              table_number: table,
              command,
              failure_count: 1,
              error_message: errorMessage,
              error_category: classification.error_category,
              error_meaning: classification.error_meaning,
              troubleshooting: classification.troubleshooting,
              started_at: failedAt,
              last_failed_at: failedAt
            });
          }

          writeLog(
            "ERROR",
            "LAMP_WATCHDOG_TABLE_ERROR",
            `Gagal mengontrol lampu meja ${table}`,
            { error: errorMessage, command, error_category: classification.error_category }
          );
        }
      } catch (tableErr) {
        writeLog(
          "ERROR",
          "LAMP_WATCHDOG_TABLE_ERROR",
          `Gagal mengontrol lampu meja ${table}`,
          {
            error: tableErr.message
          }
        );
      }
    }
  } catch (error) {
    writeLog(
      "ERROR",
      "LAMP_WATCHDOG_ERROR",
      error.message
    );
  } finally {
    lampWatchdogRunning = false;
  }
}

setInterval(reconcileLampState, 10 * 1000);
setInterval(checkExpiredTableSessions, 10 * 1000);

function scheduleMemberDailyCheck() {
  const now = new Date();

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Makassar",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).formatToParts(now);

  const getPart = type =>
    Number(parts.find(p => p.type === type)?.value || 0);

  const currentWita = new Date(Date.UTC(
    getPart("year"),
    getPart("month") - 1,
    getPart("day"),
    getPart("hour"),
    getPart("minute"),
    getPart("second")
  ));

  const nextMidnightWita = new Date(Date.UTC(
    getPart("year"),
    getPart("month") - 1,
    getPart("day") + 1,
    0,
    0,
    0
  ));

  const delayMs = Math.max(
    1000,
    nextMidnightWita.getTime() - currentWita.getTime()
  );

  setTimeout(async () => {
    try {
      await cekStatusMemberHarian();
    } catch (error) {
      writeLog(
        "ERROR",
        "MEMBER_CHECK",
        "[MEMBER] Pemeriksaan status harian gagal",
        { error: error.message }
      );
    } finally {
      scheduleMemberDailyCheck();
    }
  }, delayMs);
}

scheduleMemberDailyCheck();

// Status member mengikuti tabel lokal member/member_cache.
// Pemeriksaan harian legacy tetap dinonaktifkan sampai aturan bisnisnya terverifikasi.

databaseInitialization
  .then(() => {
    MEMBER_SCHEDULE.initScheduler();
  server.listen(config.PORT, () => {
      writeLog("INFO", "SERVER_START", `Server POS POLAR berjalan di port ${config.PORT}`);
    });
  })
  .catch(error => {
    writeLog("ERROR", "DATABASE", "Inisialisasi database gagal; server tidak dijalankan", { error: error.message });
    console.error("Inisialisasi database gagal; server tidak dijalankan:", error);
    process.exitCode = 1;
  });
