const https = require("https");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const config = require("./config");
const { callGas } = require("./gas");
const { callMemberGas, callMemberGasGet } = require("./gas-member");
const { callHargaGasGet } = require("./gas-harga");
const sqlite3 = require("sqlite3").verbose();
const { verify } = require("otplib");
const { lampSet, lampOn, lampOff, lampBlink15Minute } = require('./lamp-controlle/lamp-controller');

const db = new sqlite3.Database(
  path.join(__dirname, "pos.db")
);

db.run("PRAGMA foreign_keys = ON");


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
      nominal_aktual INTEGER,
      status TEXT NOT NULL DEFAULT 'OPEN',
      FOREIGN KEY (kasir_id)
      REFERENCES kasir(id)
    )
  `);

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

  const txMigrations = [
    "ALTER TABLE transaksi ADD COLUMN shift_id INTEGER",
    "ALTER TABLE transaksi ADD COLUMN bayar INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE transaksi ADD COLUMN kembalian INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE transaksi ADD COLUMN cash_amount INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE transaksi ADD COLUMN qris_amount INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE transaksi ADD COLUMN nomor_meja INTEGER",
    "ALTER TABLE transaksi ADD COLUMN session_id TEXT"
  ];

  txMigrations.forEach(migration => {
    db.run(migration, error => {
      if (error && !error.message.includes("duplicate column name")) {
        writeLog("ERROR", "DATABASE", `Gagal menjalankan migration: ${migration}`, { error: error.message });
      }
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

function generateNomorTransaksi() {
  const now = new Date();
  const tanggal =
    now.getFullYear().toString() +
    String(now.getMonth() + 1).padStart(2, "0") +
    String(now.getDate()).padStart(2, "0");
  const waktu =
    String(now.getHours()).padStart(2, "0") +
    String(now.getMinutes()).padStart(2, "0") +
    String(now.getSeconds()).padStart(2, "0");

  return `TRX-${tanggal}-${waktu}`;
}

function runAsync(query, params = []) {
  return new Promise((resolve, reject) => {
    db.run(query, params, function(err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
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
  try {
    const rows = await new Promise((resolve, reject) => {
      db.all(`SELECT * FROM sesi_meja WHERE status = 'AKTIF'`, [], (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });

    const now = new Date();
    for (const session of rows) {
      if (session.jenis_sesi === "LOSS" || !session.waktu_selesai) {
        continue;
      }

      if (session.waktu_selesai) {
        const end = new Date(session.waktu_selesai);
        const remainingMs = end.getTime() - now.getTime();
        if (Number.isFinite(remainingMs) && remainingMs > 0 && remainingMs <= FIFTEEN_MINUTES_MS) {
          trigger15MinuteLampWarning(session).catch(error => {
            writeLog("ERROR", "CHECK_15MIN_WARNING", `Gagal memicu peringatan 15 menit meja ${session.nomor_meja}`, { error: error.message });
          });
        }
      }

      if (session.waktu_selesai && new Date(session.waktu_selesai) <= now) {
        if (expiredLampSessions.has(session.session_id)) continue;

        const nomorMeja = session.nomor_meja;
        try {
          const lampRes = await lampOff(nomorMeja);
          if (lampRes && lampRes.success === true) {
            expiredLampSessions.add(session.session_id);
            warned15MinuteSessions.delete(session.session_id);
            writeLog("INFO", "SESSION_EXPIRED", `Sesi meja ${nomorMeja} habis, lampu dimatikan otomatis`, { sessionId: session.session_id });
          } else {
            writeLog("WARN", "LAMP_OFF_FAILED", `Gagal mematikan lampu untuk meja ${nomorMeja} saat sesi habis`, { lampRes });
          }
        } catch (lampErr) {
          writeLog("ERROR", "LAMP_OFF_ERROR", `Error saat mematikan lampu untuk meja ${nomorMeja} saat sesi habis`, { error: lampErr.message });
        }
      }
    }
  } catch (error) {
    writeLog("ERROR", "CHECK_EXPIRED_SESSIONS", "Error saat memeriksa sesi meja habis", { error: error.message });
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
  if (member.status === 'EXPIRED') return 'EXPIRED';

  const todayStr = new Date().toISOString().split('T')[0];
  const todayDate = new Date(todayStr);
  const tanggalAktif = member.tanggal_aktif;

  if (tanggalAktif && todayStr < tanggalAktif) {
    return 'MENUNGGU_AKTIF';
  }

  if (member.status === 'MENUNGGU_AKTIF') {
    if (!tanggalAktif || todayStr >= tanggalAktif) {
      return 'AKTIF';
    }
  }

  if (member.status === 'AKTIF') {
    let baseDateStr = member.last_used_at;
    if (!baseDateStr) {
      baseDateStr = member.tanggal_aktif;
    }

    if (baseDateStr) {
      const baseDate = new Date(baseDateStr.split('T')[0]);
      const diffTime = todayDate.getTime() - baseDate.getTime();
      const diffDays = Math.floor(diffTime / (1000 * 3600 * 24));
      if (diffDays >= 7) {
        return 'EXPIRED';
      }
    }

    if (tanggalAktif && todayStr >= tanggalAktif) {
      return 'AKTIF';
    }
  }

  return member.status || 'MENUNGGU_AKTIF';
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

async function syncHargaMemberCache() {
  writeLog("INFO", "SYNC_HARGA_MEMBER_START", "Memulai sync harga member cache");

  try {
    const [resPlatinum, resUmum, resPelajar] = await Promise.all([
      callHargaGasGet({ action: "harga_platinum_all" }),
      callHargaGasGet({ action: "harga_umum_all" }),
      callHargaGasGet({ action: "harga_pelajar_all" })
    ]);

    if (!resPlatinum || resPlatinum.success !== true || !Array.isArray(resPlatinum.data)) {
      throw new Error("Response harga_platinum_all dari GAS tidak valid");
    }
    if (!resUmum || resUmum.success !== true || !Array.isArray(resUmum.data)) {
      throw new Error("Response harga_umum_all dari GAS tidak valid");
    }
    if (!resPelajar || resPelajar.success !== true || !Array.isArray(resPelajar.data)) {
      throw new Error("Response harga_pelajar_all dari GAS tidak valid");
    }

    const allRules = [
      ...resPlatinum.data.map(r => ({ ...r, kategori: "PLATINUM" })),
      ...resUmum.data.map(r => ({ ...r, kategori: "UMUM" })),
      ...resPelajar.data.map(r => ({ ...r, kategori: "PELAJAR" }))
    ];

    const activeRules = allRules.filter(r => r.aktif === true);
    const nowIso = new Date().toISOString();

    await runAsync("BEGIN TRANSACTION");

    try {
      await runAsync("DELETE FROM harga_member_cache");

      await new Promise((resolve, reject) => {
        db.serialize(() => {
          const stmt = db.prepare(`
            INSERT INTO harga_member_cache
            (kategori, jam, jam_selesai, durasi_jam, harga_per_jam, total, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `);

          for (const rule of activeRules) {
            const kategori = String(rule.kategori || "").trim().toUpperCase();
            const jam = String(rule.jamMulai || "").trim();
            const jamSelesai = rule.jamSelesai ? String(rule.jamSelesai).trim() : null;
            const minimalJam = Number(rule.minimalJam || 0);
            const durasiJam = minimalJam === 0 ? 1 : minimalJam;
            const hargaPerJam = Number(rule.hargaPerJam || 0);
            const total = hargaPerJam * durasiJam;

            stmt.run(kategori, jam, jamSelesai, durasiJam, hargaPerJam, total, nowIso);
          }

          stmt.finalize(err => {
            if (err) reject(err);
            else resolve();
          });
        });
      });

      await runAsync("COMMIT");
    } catch (txErr) {
      await runAsync("ROLLBACK");
      throw txErr;
    }

    writeLog("INFO", "SYNC_HARGA_MEMBER_SUCCESS", `Harga member cache tersimpan: ${activeRules.length} record`, { count: activeRules.length });
    return { success: true, count: activeRules.length };

  } catch (error) {
    writeLog("ERROR", "SYNC_HARGA_MEMBER_FAILED", "Gagal sinkronisasi harga member cache dari GAS", { error: error.message });
    throw error;
  }
}


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
// SYNC PRODUK DARI GOOGLE
// ==================================================

async function syncProduk() {
  writeLog("INFO", "SYNC_PRODUK_START", "Memulai sync Master Barang");

  const result = await callGas({ action: "get_barang" });

  if (!result || result.success !== true || !Array.isArray(result.data)) {
    throw new Error("Data Master Barang dari GAS tidak valid");
  }

  const products = result.data;
  const updatedAt = new Date().toISOString();

  await new Promise((resolve, reject) => {
    db.serialize(() => {
      db.run("DELETE FROM master_barang", deleteError => {
        if (deleteError) {
          reject(deleteError);
          return;
        }

        const stmt = db.prepare(`
          INSERT INTO master_barang
          (nama, kategori, hpp, harga_jual, stok_aktual, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `);

        for (const item of products) {
          stmt.run(
            String(item.nama || ""),
            String(item.kategori || "Lainnya"),
            Number(item.hpp || 0),
            Number(item.hargaJual || 0),
            Number(item.stokAktual || 0),
            updatedAt
          );
        }

        stmt.finalize(finalizeError => {
          if (finalizeError) {
            reject(finalizeError);
            return;
          }
          resolve();
        });
      });
    });
  });

  writeLog("INFO", "SYNC_PRODUK_SUCCESS", `Master Barang tersimpan lokal: ${products.length} item`, { jumlah: products.length });

  return {
    success: true,
    jumlah: products.length,
    updatedAt
  };
}


// ==================================================
// TRANSAKSI LOCAL
// ==================================================

function getPendingTransactions() {
  return new Promise((resolve, reject) => {
    db.all(
      `
      SELECT *
      FROM transaksi
      WHERE status_sync = 'PENDING'
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

function updateSyncStatus(transaksiId, status) {
  return new Promise((resolve, reject) => {
    const syncAt = status === "SYNCED" ? new Date().toISOString() : null;

    db.run(
      `
      UPDATE transaksi
      SET status_sync = ?, sync_at = ?
      WHERE id = ?
      `,
      [status, syncAt, transaksiId],
      error => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      }
    );
  });
}


// ==================================================
// SYNC TRANSAKSI KE GOOGLE
// ==================================================

const syncingTransactionIds = new Set();

async function syncTransaction(transaksi) {
  if (syncingTransactionIds.has(transaksi.id)) {
    return false;
  }
  syncingTransactionIds.add(transaksi.id);

  try {
    const dbTx = await new Promise((resolve) => {
      db.get(`SELECT status_sync FROM transaksi WHERE id = ?`, [transaksi.id], (err, row) => resolve(row));
    });
    if (!dbTx || dbTx.status_sync !== 'PENDING') {
      return false;
    }

    const detail = await getTransactionDetails(transaksi.id);

    const result = await callGas({
      action: "simpan_penjualan",
      nomorTransaksi: transaksi.nomor_transaksi,
      nomorMeja: transaksi.nomor_meja,
      tanggal: transaksi.tanggal,
      jam: transaksi.jam,
      kasir: transaksi.kasir,
      metodePembayaran: transaksi.metode_pembayaran,
      cashAmount: Number(transaksi.cash_amount || 0),
      qrisAmount: Number(transaksi.qris_amount || 0),
      items: detail.map(item => {
        const namaLower = String(item.nama_barang || "").trim().toLowerCase();
        const isLoss = namaLower === "billiard waktu loss";
        const isTableService = namaLower === "meja billiard" || namaLower === "1 jam";
        const isService = isLoss || isTableService;

        return {
          nama: item.nama_barang,
          qty: item.qty,
          hargaJual: item.harga_jual,
          hpp: item.hpp,
          subtotal: item.subtotal,
          isService: isService
        };
      })
    });

    if (!result || result.success !== true) {
      throw new Error(result?.error || "GAS gagal menyimpan transaksi");
    }

    await updateSyncStatus(transaksi.id, "SYNCED");
    writeLog("INFO", "SYNC_TRANSAKSI_SUCCESS", `SYNCED ${transaksi.nomor_transaksi}`);

    return true;

  } catch (error) {
    writeLog("ERROR", "SYNC_TRANSAKSI_FAILED", `Sync gagal ${transaksi.nomor_transaksi}`, { error: error.message });
    return false;
  } finally {
    syncingTransactionIds.delete(transaksi.id);
  }
}

async function syncPendingTransactions() {
  try {
    const rows = await getPendingTransactions();
    for (const transaksi of rows) {
      await syncTransaction(transaksi);
    }
  } catch (error) {
    writeLog("ERROR", "SYNC_QUEUE", "Queue sync error", { error: error.message });
  }
}


// ==================================================
// LOGIN SESSIONS MANAGEMENT & SECURITY HELPERS
// ==================================================

const activeLoginSessions = new Map();
const loginRateLimitMap = new Map();


// ==================================================
// MEMBER CACHE MANAGEMENT
// ==================================================

function getMemberCacheFromDb() {
  return new Promise((resolve, reject) => {
    db.all(`SELECT * FROM member_cache ORDER BY id ASC`, [], (err, rows) => {
      if (err) return reject(err);
      const data = rows.map(r => ({
        id: r.kode_member || (r.member_id ? String(r.member_id) : String(r.id)),
        kodeMember: r.kode_member || (r.member_id ? String(r.member_id) : String(r.id)),
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
        totalKunjungan: Number(r.total_kunjungan || 0),
        totalPengeluaran: Number(r.total_pengeluaran || 0)
      }));
      resolve(data);
    });
  });
}

let memberSyncInProgress = null;

async function syncMemberCacheFromGas() {
  if (memberSyncInProgress) {
    return memberSyncInProgress;
  }

  memberSyncInProgress = (async () => {
    try {
      const [resPlatinum, resUmum, resPelajar] = await Promise.all([
        callMemberGasGet({ action: "member_platinum_list" }),
        callMemberGasGet({ action: "member_umum_list" }),
        callMemberGasGet({ action: "member_pelajar_list" })
      ]);

      if (!resPlatinum || resPlatinum.success !== true || !Array.isArray(resPlatinum.data)) {
        throw new Error("Response Platinum tidak valid");
      }
      if (!resUmum || resUmum.success !== true || !Array.isArray(resUmum.data)) {
        throw new Error("Response Umum tidak valid");
      }
      if (!resPelajar || resPelajar.success !== true || !Array.isArray(resPelajar.data)) {
        throw new Error("Response Pelajar tidak valid");
      }

      const nowIso = new Date().toISOString();

      const processList = (items, kategori) => items.map((m, idx) => {
        let memberId = parseInt(m.idMember, 10);
        if (isNaN(memberId)) {
          const digits = String(m.idMember || "").replace(/\D/g, "");
          const parsedDigits = parseInt(digits, 10);
          if (!isNaN(parsedDigits)) {
            if (kategori === "PLATINUM") memberId = 1000000 + parsedDigits;
            else if (kategori === "UMUM") memberId = 2000000 + parsedDigits;
            else if (kategori === "PELAJAR") memberId = 3000000 + parsedDigits;
            else memberId = parsedDigits;
          } else {
            memberId = (kategori === "PLATINUM" ? 1000000 : kategori === "UMUM" ? 2000000 : 3000000) + idx + 1;
          }
        }

        return {
          member_id: memberId,
          kode_member: String(m.idMember || ""),
          nama: String(m.nama || ""),
          alamat: String(m.alamat || ""),
          nomor_hp: String(m.nomorHp || ""),
          tanggal_lahir: String(m.tanggalLahir || ""),
          kategori_id: kategori,
          kategori: kategori,
          nama_sekolah: m.namaSekolah ? String(m.namaSekolah) : null,
          nisn: m.nisn ? String(m.nisn) : null,
          tanggal_daftar: String(m.tanggalDaftar || ""),
          tanggal_aktif: String(m.tanggalAktif || ""),
          last_used_at: String(m.lastActive || ""),
          status: String(m.status || ""),
          total_kunjungan: Number(m.totalKunjungan || 0),
          total_pengeluaran: Number(m.totalPengeluaran || 0),
          updated_at: nowIso
        };
      });

      const allMembers = [
        ...processList(resPlatinum.data, "PLATINUM"),
        ...processList(resUmum.data, "UMUM"),
        ...processList(resPelajar.data, "PELAJAR")
      ];

      await new Promise((resolve, reject) => {
        db.serialize(() => {
          const stmt = db.prepare(`
            INSERT OR REPLACE INTO member_cache
            (member_id, kode_member, nama, alamat, nomor_hp, tanggal_lahir, kategori_id, kategori, nama_sekolah, nisn, tanggal_daftar, tanggal_aktif, last_used_at, status, total_kunjungan, total_pengeluaran, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `);

          for (const m of allMembers) {
            stmt.run(
              m.member_id,
              m.kode_member,
              m.nama,
              m.alamat,
              m.nomor_hp,
              m.tanggal_lahir,
              m.kategori_id,
              m.kategori,
              m.nama_sekolah,
              m.nisn,
              m.tanggal_daftar,
              m.tanggal_aktif,
              m.last_used_at,
              m.status,
              m.total_kunjungan,
              m.total_pengeluaran,
              m.updated_at
            );
          }

          stmt.finalize(err => {
            if (err) reject(err);
            else resolve();
          });
        });
      });

      writeLog("INFO", "MEMBER_CACHE_SYNC", `Berhasil sync member cache: ${allMembers.length} member`, { jumlah: allMembers.length });
      return await getMemberCacheFromDb();
    } catch (error) {
      writeLog("WARN", "MEMBER_CACHE_SYNC_FAILED", "Gagal sinkronisasi member cache dari GAS", { error: error.message });
      throw error;
    } finally {
      memberSyncInProgress = null;
    }
  })();

  return memberSyncInProgress;
}

async function getMemberListCached() {
  const dbData = await getMemberCacheFromDb();
  if (dbData && dbData.length > 0) {
    syncMemberCacheFromGas().catch(err => {
      writeLog("WARN", "BACKGROUND_MEMBER_SYNC", "Background sync member cache gagal", { error: err.message });
    });
    return dbData;
  }

  try {
    return await syncMemberCacheFromGas();
  } catch (error) {
    return await getMemberCacheFromDb();
  }
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
  const sessionId = req.headers["x-session-id"];
  const deviceId = req.headers["x-device-id"];

  if (!sessionId || !deviceId) {
    res.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ success: false, code: "SESSION_NOT_FOUND", message: "Session ID dan DeviceId wajib diisi" }));
    return null;
  }

  let foundSession = null;
  for (const session of activeLoginSessions.values()) {
    if (session.sessionId === sessionId) {
      foundSession = session;
      break;
    }
  }

  if (!foundSession) {
    res.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ success: false, code: "SESSION_NOT_FOUND", message: "Session tidak ditemukan" }));
    return null;
  }

  if (foundSession.deviceId !== deviceId.trim()) {
    res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ success: false, code: "DEVICE_MISMATCH", message: "Device tidak sesuai dengan session" }));
    return null;
  }

  const now = Date.now();
  if (now >= foundSession.expiresAt) {
    activeLoginSessions.delete(foundSession.kasirId);
    res.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ success: false, code: "SESSION_EXPIRED", message: "Session sudah expired" }));
    return null;
  }

  foundSession.expiresAt = Date.now() + 5 * 60 * 1000;

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

  if (req.method === "POST" && req.url === "/api/session") {
    try {
      const data = await getJsonBody(req);
      const sessionId = data.sessionId;
      const deviceId = data.deviceId;

      if (!sessionId || !deviceId || typeof deviceId !== "string" || !deviceId.trim()) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ success: false, valid: false, code: "INVALID_REQUEST", message: "sessionId dan deviceId wajib diisi" }));
      }

      let foundSession = null;
      for (const session of activeLoginSessions.values()) {
        if (session.sessionId === sessionId) {
          foundSession = session;
          break;
        }
      }

      if (!foundSession) {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ success: false, valid: false, code: "SESSION_NOT_FOUND" }));
      }

      if (foundSession.deviceId !== deviceId.trim()) {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ success: false, valid: false, code: "DEVICE_MISMATCH", message: "Session bukan milik device ini." }));
      }

      const now = Date.now();
      if (now >= foundSession.expiresAt) {
        activeLoginSessions.delete(foundSession.kasirId);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ success: false, valid: false, code: "SESSION_EXPIRED", message: "Session login sudah expired." }));
      }

      db.get(`SELECT aktif FROM kasir WHERE id = ?`, [foundSession.kasirId], (err, kasirRow) => {
        if (err || !kasirRow || !kasirRow.aktif) {
          activeLoginSessions.delete(foundSession.kasirId);
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          return res.end(JSON.stringify({ success: false, valid: false, code: "SESSION_NOT_FOUND", message: "Kasir tidak aktif atau tidak ditemukan" }));
        }

        foundSession.expiresAt = Date.now() + 5 * 60 * 1000;
        const currentNow = Date.now();

        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({
          success: true,
          valid: true,
          sessionId: foundSession.sessionId,
          kasirId: foundSession.kasirId,
          username: foundSession.username,
          loginAt: foundSession.loginAt,
          expiresAt: foundSession.expiresAt,
          remainingMs: foundSession.expiresAt - currentNow
        }));
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
      const sessionId = data.sessionId;
      const deviceId = data.deviceId;

      if (!sessionId || !deviceId) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ success: false, message: "sessionId dan deviceId wajib diisi" }));
      }

      let targetKasirId = null;
      for (const [kasirId, session] of activeLoginSessions.entries()) {
        if (session.sessionId === sessionId && session.deviceId === deviceId) {
          targetKasirId = kasirId;
          break;
        }
      }

      if (targetKasirId) {
        activeLoginSessions.delete(targetKasirId);
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
            return res.end(JSON.stringify({ success: false, message: "Kasir ID atau PIN salah" }));
          }

          loginRateLimitMap.delete(clientIp);

          const now = Date.now();
          if (activeLoginSessions.has(kasir.id)) {
            const existingSession = activeLoginSessions.get(kasir.id);
            if (now < existingSession.expiresAt) {
              if (existingSession.deviceId !== trimmedDeviceId) {
                res.writeHead(409, { "Content-Type": "application/json; charset=utf-8" });
                return res.end(JSON.stringify({
                  success: false,
                  code: "SESSION_ACTIVE_OTHER_DEVICE",
                  message: "AKUN SEDANG DIGUNAKAN DI DEVICE LAIN."
                }));
              } else {
                db.get(
                  `SELECT * FROM shift_kasir WHERE kasir_id = ? AND status = 'OPEN' ORDER BY id DESC LIMIT 1`,
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
                        sessionId: existingSession.sessionId,
                        loginAt: existingSession.loginAt,
                        expiresAt: existingSession.expiresAt
                      }));
                    }
                    db.run(
                      `INSERT INTO shift_kasir (kasir_id, buka_at, saldo_awal, status) VALUES (?, ?, 0, 'OPEN')`,
                      [kasir.id, new Date().toISOString()],
                      function (openError) {
                        if (openError) {
                          res.writeHead(500);
                          return res.end(JSON.stringify({ success: false, message: openError.message }));
                        }
                        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
                        return res.end(JSON.stringify({
                          success: true,
                          kasirId: kasir.id,
                          nama: kasir.nama,
                          shiftId: this.lastID,
                          sessionId: existingSession.sessionId,
                          loginAt: existingSession.loginAt,
                          expiresAt: existingSession.expiresAt
                        }));
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
          const expiresAt = loginAt + 5 * 60 * 1000;
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
            `SELECT * FROM shift_kasir WHERE kasir_id = ? AND status = 'OPEN' ORDER BY id DESC LIMIT 1`,
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
                  sessionId,
                  loginAt,
                  expiresAt
                }));
              }
              db.run(
                `INSERT INTO shift_kasir (kasir_id, buka_at, saldo_awal, status) VALUES (?, ?, 0, 'OPEN')`,
                [kasir.id, new Date().toISOString()],
                function (openError) {
                  if (openError) {
                    res.writeHead(500);
                    return res.end(JSON.stringify({ success: false, message: openError.message }));
                  }
                  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
                  return res.end(JSON.stringify({
                    success: true,
                    kasirId: kasir.id,
                    nama: kasir.nama,
                    shiftId: this.lastID,
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
    } catch (error) {
      res.writeHead(400);
      return res.end(JSON.stringify({ success: false, message: error.message }));
    }
    return;
  }

  // SENSITIVE & PROTECTED API ENDPOINTS
  if (req.method === "POST" && (req.url === "/api/lamp" || req.url === "/api/lamp/on" || req.url === "/api/lamp/off")) {
    const session = validateLoginSession(req, res);
    if (!session) return;

    try {
      const data = await getJsonBody(req);
      const table = Number(data.table);

      if (!Number.isInteger(table) || table < 1 || table > 10) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ success: false, message: "Table must be 1â€“10." }));
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

      let data = await getLocalBarang();

      if (query && query.trim()) {
        const keyword = query.trim().toLowerCase();
        data = data.filter(item => String(item.nama || "").toLowerCase().includes(keyword));
      }

      const updated = data.length ? data[0].updated_at : null;

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
      return res.end(JSON.stringify({ success: false, message: error.message }));
    }
  }

  if (req.method === "POST" && req.url === "/api/sync-produk") {
    const session = validateLoginSession(req, res);
    if (!session) return;

    try {
      const pending = await getPendingTransactions();

      if (pending.length > 0) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({
          success: false,
          code: "PENDING_TRANSACTION",
          message: "Masih ada transaksi PENDING. Sinkronkan transaksi terlebih dahulu."
        }));
      }

      const result = await syncProduk();

      try {
        await syncHargaMemberCache();
      } catch (hargaErr) {
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({
          success: false,
          message: "Sync produk berhasil, tetapi sync harga member gagal.",
          error: hargaErr.message
        }));
      }

      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify(result));

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

      if (!data.shiftId) throw new Error("Kasir belum login");

      const validShift = await new Promise((resolve) => {
        db.get(`SELECT id FROM shift_kasir WHERE id = ? AND kasir_id = ? AND status = 'OPEN'`, [data.shiftId, session.kasirId], (err, row) => {
          resolve(row ? true : false);
        });
      });
      if (!validShift) {
        res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ success: false, code: "SHIFT_MISMATCH", message: "Shift tidak valid atau bukan milik kasir session" }));
      }

      if (!["CASH", "QRIS", "CASH+QRIS"].includes(data.metodePembayaran)) {
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
          const isTableServiceItem = (nama === "meja billiard" || nama === "1 jam");

          // 1. BILLIARD WAKTU LOSS VALIDATION (STRICT DATABASE AUTHORITATIVE)
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

          // 2. MEJA BILLIARD & 1 JAM SERVICE ITEMS
          if (isTableServiceItem) {
            let serviceQty = clientQty;
            let serviceHarga = Number(item.hargaJual || item.harga_jual || 0);
            let serviceSubtotal = 0;

            if (tableSession) {
              const pesananItems = await getSessionItems(tableSession.session_id);
              const matchingPesanan = pesananItems.find(p => String(p.nama_barang || "").trim().toLowerCase() === nama);
              if (matchingPesanan) {
                serviceQty = Number(matchingPesanan.qty);
                serviceHarga = Number(matchingPesanan.harga_jual);
                serviceSubtotal = Number(matchingPesanan.subtotal);
              } else {
                serviceSubtotal = serviceHarga * serviceQty;
              }
            } else {
              if (serviceHarga <= 0) {
                const masterServ = masterBarang.find(x => String(x.nama || "").trim().toLowerCase() === nama);
                serviceHarga = masterServ ? Number(masterServ.hargaJual) : 0;
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

          // 3. PHYSICAL PRODUCTS (STRICT MASTER BARANG VALIDATION)
          if (!Number.isInteger(clientQty) || clientQty <= 0) {
            throw new Error(`Qty barang tidak valid: ${item.nama}`);
          }

          const barang = masterBarang.find(x => String(x.nama || "").trim().toLowerCase() === nama);
          if (!barang) {
            throw new Error(`Barang tidak ditemukan: ${item.nama}`);
          }

          if (Number(barang.stokAktual) < clientQty) {
            throw new Error(`Stok tidak mencukupi untuk barang: ${barang.nama}`);
          }

          const hargaJual = Number(barang.hargaJual || 0);
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

        let cashAmount = Number(data.cashAmount || 0);
        let qrisAmount = Number(data.qrisAmount || 0);
        let bayar = cashAmount + qrisAmount;

        if (data.metodePembayaran === "CASH") {
          cashAmount = Number(data.bayar || 0);
          qrisAmount = 0;
          bayar = cashAmount;
        }

        if (data.metodePembayaran === "QRIS") {
          cashAmount = 0;
          qrisAmount = total;
          bayar = total;
        }

        if (data.metodePembayaran === "CASH+QRIS") {
          bayar = cashAmount + qrisAmount;
          if (bayar !== total) {
            throw new Error(`Cash + QRIS harus sama dengan total. Total ${total}, dibayar ${bayar}`);
          }
        }

        if (data.metodePembayaran === "CASH" && bayar < total) {
          throw new Error("Nominal Cash kurang");
        }

        const kembalian = Math.max(0, bayar - total);
        const now = new Date();
        const tanggal = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
        const jam = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}`;
        const nomorTransaksi = generateNomorTransaksi();

        const txRes = await runAsync(
          `INSERT INTO transaksi
          (nomor_transaksi, tanggal, jam, kasir, total, metode_pembayaran, status_sync, shift_id, bayar, kembalian, cash_amount, qris_amount, nomor_meja, session_id)
          VALUES (?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, ?, ?, ?, ?, ?)`,
          [nomorTransaksi, tanggal, jam, session.username, total, data.metodePembayaran, data.shiftId, bayar, kembalian, cashAmount, qrisAmount, nomorMejaToSave, sessionIdToSave]
        );

        const transaksiId = txRes.lastID;

        for (const item of detail) {
          await runAsync(
            `INSERT INTO detail_transaksi (transaksi_id, nama_barang, qty, harga_jual, hpp, subtotal) VALUES (?, ?, ?, ?, ?, ?)`,
            [transaksiId, item.nama, item.qty, item.hargaJual, item.hpp, item.subtotal]
          );

          if (!item.isService && item.barangId) {
            await runAsync(
              `UPDATE master_barang SET stok_aktual = stok_aktual - ? WHERE id = ?`,
              [item.qty, item.barangId]
            );
          }
        }

        if (tableSession) {
          const updateSesiRes = await runAsync(
            `UPDATE sesi_meja SET status = 'DIBAYAR' WHERE session_id = ? AND status != 'DIBAYAR'`,
            [tableSession.session_id]
          );

          if (updateSesiRes.changes === 0) {
            throw new Error("SESSION_ALREADY_PAID");
          }
        }

        await runAsync("COMMIT");

        if (tableSession) {
          try {
            const lampRes = await lampOff(tableSession.nomor_meja);

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
          bayar,
          cashAmount,
          qrisAmount,
          kembalian,
          statusSync: "PENDING"
        }));

        syncTransaction({
          id: transaksiId,
          nomor_transaksi: nomorTransaksi,
          nomor_meja: nomorMejaToSave,
          tanggal,
          jam,
          kasir: session.username,
          total,
          metode_pembayaran: data.metodePembayaran,
          cash_amount: cashAmount,
          qris_amount: qrisAmount
        }).then(() => {}).catch(() => {});

        return;

      } catch (txErr) {
        await runAsync("ROLLBACK");
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

      const totpRes = await verifyManagerTotpOnce(code);
      if (!totpRes.success) {
        const statusCode = totpRes.code === "TOTP_CONFIG_ERROR" ? 500 : 401;
        res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ success: false, code: totpRes.code, message: totpRes.message }));
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

      await new Promise((resolve, reject) => {
        db.run(
          `UPDATE transaksi SET status_sync = 'BATAL', sync_at = ? WHERE id = ?`,
          [new Date().toISOString(), transaksi.id],
          (err) => {
            if (err) reject(err);
            else resolve();
          }
        );
      });

      writeLog("INFO", "TRANSAKSI_BATAL", `Transaksi ${nomorTransaksi} dibatalkan oleh Manager`, {
        nomorTransaksi: transaksi.nomor_transaksi,
        kasir: transaksi.kasir,
        waktuPembatalan: new Date().toISOString()
      });

      try {
        const gasResult = await callGas({
          action: "batalkan_penjualan",
          nomorTransaksi: nomorTransaksi
        });

        if (!gasResult || gasResult.success !== true) {
          throw new Error(gasResult?.message || "GAS gagal memperbarui status transaksi menjadi BATAL");
        }

        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({
          success: true,
          message: "Transaksi berhasil dibatalkan",
          nomorTransaksi: nomorTransaksi
        }));

      } catch (gasError) {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({
          success: false,
          message: "Transaksi lokal berhasil dibatalkan tetapi gagal memperbarui Google Sheet",
          nomorTransaksi: nomorTransaksi
        }));
      }

    } catch (error) {
      writeLog("ERROR", "TRANSAKSI_BATAL_ERROR", error.message);
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ success: false, message: error.message }));
    }
  }

  if (req.method === "POST" && req.url === "/api/kasir/tutup") {
    const session = validateLoginSession(req, res);
    if (!session) return;

    try {
      const data = await getJsonBody(req);
      const shiftId = Number(data.shiftId);
      const nominalAktual = Number(data.nominalAktual);

      if (!shiftId) throw new Error("Shift kasir tidak ditemukan");

      db.get(
        `SELECT * FROM shift_kasir WHERE id = ? AND kasir_id = ? AND status = 'OPEN'`,
        [shiftId, session.kasirId],
        (shiftError, shift) => {
          if (shiftError) {
            res.writeHead(500);
            return res.end(JSON.stringify({ success: false, message: shiftError.message }));
          }
          if (!shift) {
            res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
            return res.end(JSON.stringify({ success: false, code: "SHIFT_MISMATCH", message: "Shift sudah ditutup atau bukan milik kasir session" }));
          }

          db.get(
            `
            SELECT
              COUNT(*) AS jumlah,
              COALESCE(SUM(total), 0) AS total,
              COALESCE(SUM(cash_amount), 0) AS cash,
              COALESCE(SUM(qris_amount), 0) AS qris
            FROM transaksi
            WHERE shift_id = ?
            `,
            [shiftId],
            (reportError, report) => {
              if (reportError) {
                res.writeHead(500);
                return res.end(JSON.stringify({ success: false, message: reportError.message }));
              }

              const uangSeharusnya = Number(shift.saldo_awal || 0) + Number(report.cash || 0);
              const selisih = nominalAktual - uangSeharusnya;

              db.run(
                `
                UPDATE shift_kasir
                SET tutup_at = ?, nominal_aktual = ?, status = 'CLOSED'
                WHERE id = ?
                `,
                [new Date().toISOString(), nominalAktual, shiftId],
                updateError => {
                  if (updateError) {
                    res.writeHead(500);
                    return res.end(JSON.stringify({ success: false, message: updateError.message }));
                  }

                  res.writeHead(200);
                  return res.end(JSON.stringify({
                    success: true,
                    penjualanCash: Number(report.cash || 0),
                    penjualanQris: Number(report.qris || 0),
                    totalPenjualan: Number(report.total || 0),
                    jumlahTransaksi: Number(report.jumlah || 0),
                    uangSeharusnya,
                    nominalAktual,
                    selisih
                  }));
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
          t.status_sync AS statusSync,
          t.sync_at AS syncAt
        FROM transaksi t
        WHERE 1 = 1
      `;

      const params = [];

      if (query) {
        sql += ` AND (t.nomor_transaksi LIKE ? OR t.kasir LIKE ?)`;
        const search = `%${query}%`;
        params.push(search, search);
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

  // WAITING LIST API
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

      const validStatuses = ["WAITING", "CONFIRMED", "SEATED", "CANCELLED", "EXPIRED"];
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

          const validStatuses = ["WAITING", "CONFIRMED", "SEATED", "CANCELLED", "EXPIRED"];
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
      const code = String(data.code || "").trim();

      if (!namaBarang || !code) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ success: false, message: "namaBarang dan code wajib diisi" }));
      }

      const totpRes = await verifyManagerTotpOnce(code);
      if (!totpRes.success) {
        const statusCode = totpRes.code === "TOTP_CONFIG_ERROR" ? 500 : 401;
        res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ success: false, code: totpRes.code, message: totpRes.message }));
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
          result.push({
            nomorMeja: i,
            status: "AKTIF",
            sessionId: activeSession.session_id,
            namaPemesan: activeSession.nama_pemesan,
            kasir: activeSession.kasir,
            waktuMulai: activeSession.waktu_mulai,
            durasiJam: activeSession.durasi_jam || 0,
            waktuSelesai: activeSession.waktu_selesai || null,
            jenisSesi: activeSession.jenis_sesi || "NORMAL"
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
          (session_id, nomor_meja, nama_pemesan, kasir, waktu_mulai, durasi_jam, waktu_selesai, jenis_sesi, status)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'AKTIF')
          `,
          [sessionId, nomorMeja, namaPemesan, session.username, waktuMulai, durasiJam, waktuSelesai, jenisSesi],
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
          [sessionId, "Meja Billiard", durasiJam, 0, 0, 0, nowIso, nowIso],
          (error) => {
            if (error) reject(error);
            else resolve();
          }
        );
      });

      let lampSuccess = false;
      try {
        const lampRes = await lampOn(nomorMeja);
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
      const rawKategori = data.kategori;
      const rawDurasiJam = data.durasiJam;
      const rawJam = data.jam;

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

      const jam = String(rawJam || "").trim();
      if (!jam || !/^([01]\d|2[0-3]):[0-5]\d$/.test(jam)) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ success: false, message: "Jam harus format HH:mm" }));
      }

      const kategori = String(rawKategori).trim().toUpperCase();
      if (!["PLATINUM", "UMUM", "PELAJAR"].includes(kategori)) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ success: false, message: "Kategori member tidak valid" }));
      }

      const rows = await new Promise((resolve, reject) => {
        db.all(`SELECT * FROM harga_member_cache WHERE kategori = ?`, [kategori], (err, rows) => {
          if (err) reject(err);
          else resolve(rows || []);
        });
      });

      if (!rows || rows.length === 0) {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({
          success: false,
          message: "Harga member belum tersedia di cache. Silakan lakukan Sync Produk."
        }));
      }

      let matchedRules = [];
      if (kategori === "PELAJAR") {
        matchedRules = rows.filter(r => {
          const jamMulai = r.jam;
          const jamSelesai = r.jam_selesai;
          if (!jamMulai || !jamSelesai) return false;

          if (jamMulai < jamSelesai) {
            return jam >= jamMulai && jam < jamSelesai;
          } else {
            return jam >= jamMulai || jam < jamSelesai;
          }
        });
      } else {
        matchedRules = rows;
      }

      const validDurationRules = matchedRules.filter(r => Number(r.durasi_jam) <= durasiJam);

      let bestRule = null;
      if (validDurationRules.length > 0) {
        bestRule = validDurationRules.reduce((prev, current) => (Number(current.durasi_jam) > Number(prev.durasi_jam) ? current : prev));
      }

      if (!bestRule) {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({
          success: false,
          message: "Harga untuk durasi tersebut tidak tersedia."
        }));
      }

      const hargaPerJam = Number(bestRule.harga_per_jam);
      const total = hargaPerJam * durasiJam;

      writeLog(
        "INFO",
        "MEJA_HITUNG_HARGA_CACHE",
        "Harga meja berhasil diambil dari SQLite cache",
        {
          kategori,
          jam,
          durasiJam,
          hargaPerJam,
          total,
          source: "SQLITE_CACHE"
        }
      );

      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({
        success: true,
        kategori,
        hargaPerJam,
        durasiJam,
        total
      }));

    } catch (error) {
      writeLog("ERROR", "MEJA_HITUNG_HARGA_ERROR", error.message);
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ success: false, message: error.message }));
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
          durasiJam: mejaSession.durasi_jam || 0,
          waktuSelesai: mejaSession.waktu_selesai || null,
          jenisSesi: mejaSession.jenis_sesi || "NORMAL",
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

      const durasiJam = isLoss
        ? 0
        : (
            data.durasiJam !== undefined &&
            data.durasiJam !== null &&
            data.durasiJam !== ""
              ? Number(data.durasiJam)
              : 1
          );
      const memberIdInput = data.memberId ? String(data.memberId).trim() : null;

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

      let memberInfo = null;
      let kategoriMember = null;
      let hargaPerJam = null;

      if (!isLoss && memberIdInput) {
        const members = await getMemberListCached();
        const foundMember = members.find(m => m.id === memberIdInput || m.kodeMember === memberIdInput);

        if (!foundMember) {
          res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
          return res.end(JSON.stringify({ success: false, message: "Member tidak ditemukan." }));
        }

        if (foundMember.status !== "AKTIF") {
          res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
          return res.end(JSON.stringify({ success: false, message: "Member tidak aktif." }));
        }

        memberInfo = foundMember;
        kategoriMember = String(foundMember.kategori || foundMember.kategoriId || "").trim().toUpperCase();

        const nowObj = new Date();
        const jam = String(nowObj.getHours()).padStart(2, "0") + ":" + String(nowObj.getMinutes()).padStart(2, "0");

        let gasResult = null;
        try {
          if (kategoriMember === "PLATINUM") {
            gasResult = await callHargaGasGet({
              action: "harga_platinum",
              jam,
              durasiJam
            });
          } else if (kategoriMember === "UMUM") {
            gasResult = await callHargaGasGet({
              action: "harga_umum",
              jam,
              durasiJam
            });
          } else if (kategoriMember === "PELAJAR") {
            gasResult = await callHargaGasGet({
              action: "harga_pelajar",
              jam,
              durasiJam
            });
          } else {
            throw new Error("Kategori member tidak valid.");
          }

          writeLog("INFO", "MEMBER_PRICE_CHECK", "Pemeriksaan harga member berhasil", {
            memberId: memberIdInput,
            kategori: kategoriMember,
            jam,
            durasiJam,
            hargaPerJam: gasResult?.hargaPerJam
          });
        } catch (gasErr) {
          writeLog("ERROR", "MEMBER_PRICE_ERROR", "Error saat memanggil GAS harga member", { error: gasErr.message });
          res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
          return res.end(JSON.stringify({ success: false, message: gasErr.message || "Aturan harga member tidak ditemukan." }));
        }

        if (!gasResult || gasResult.success !== true) {
          res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
          return res.end(JSON.stringify({
            success: false,
            message: gasResult?.message || "Aturan harga member tidak ditemukan."
          }));
        }

        const parsedHarga = Number(gasResult.hargaPerJam);
        if (isNaN(parsedHarga) || parsedHarga <= 0) {
          res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
          return res.end(JSON.stringify({ success: false, message: "Aturan harga member tidak valid." }));
        }

        hargaPerJam = parsedHarga;
      }

      const sessionId = generateSessionId();
      const waktuMulaiDate = new Date();
      const waktuMulai = waktuMulaiDate.toISOString();
      const waktuSelesai = isLoss ? null : new Date(waktuMulaiDate.getTime() + durasiJam * 3600 * 1000).toISOString();

      await new Promise((resolve, reject) => {
        db.run(
          `
          INSERT INTO sesi_meja
          (session_id, nomor_meja, nama_pemesan, kasir, waktu_mulai, durasi_jam, waktu_selesai, jenis_sesi, status)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'AKTIF')
          `,
          [sessionId, nomorMeja, namaPemesan, session.username, waktuMulai, durasiJam, waktuSelesai, jenisSesi],
          (error) => {
            if (error) reject(error);
            else resolve();
          }
        );
      });

      if (isLoss) {
        writeLog("INFO", "OPEN_LOSS", `Sesi WAKTU LOSS dibuka pada meja ${nomorMeja}`, { sessionId, nomorMeja, namaPemesan, kasir: session.username });
      }

      if (!isLoss) {
        const masterBarang = await getLocalBarang();
        const barangBilliard = masterBarang.find(b =>
          String(b.nama || "").trim().toLowerCase() === "meja billiard" ||
          String(b.nama || "").trim().toLowerCase() === "1 jam" ||
          String(b.kategori || "").toLowerCase().includes("meja")
        );

        const namaBarangItem = "Meja Billiard";
        const hppItem = barangBilliard ? Number(barangBilliard.hpp || 0) : 0;
        const normalHargaJual = barangBilliard ? Number(barangBilliard.hargaJual || 0) : 0;

        const hargaJualFinal = (hargaPerJam !== null && hargaPerJam !== undefined && !isNaN(hargaPerJam))
          ? hargaPerJam
          : normalHargaJual;

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

      try {
        const lampRes = await lampOn(nomorMeja);
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

      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify(responseObj));
    } catch (error) {
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

        if (tableSession) {
          try {
            const lampRes = await lampOff(tableSession.nomor_meja);

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

      } catch (txErr) {
        await runAsync("ROLLBACK");
        writeLog("ERROR", "STOP_LOSS_ROLLBACK", `Rollback executed: ${txErr.message}`, { sessionId, error: txErr.message });
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ success: false, code: "STOP_LOSS_TRANSACTION_FAILED", message: txErr.message }));
      }

      try {
        await lampOff(mejaSession.nomor_meja);
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

      if (wasExpired) {
        const nomorMeja = mejaSession.nomor_meja;
        try {
          const lampRes = await lampOn(nomorMeja);
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
      res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ success: false, message: "Sesi aktif tidak ditemukan" }));
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
      const code = String(data.code || "").trim();

      if (!sessionId || !namaBarang || !code) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ success: false, message: "sessionId, namaBarang, dan code wajib diisi" }));
      }

      const totpRes = await verifyManagerTotpOnce(code);
      if (!totpRes.success) {
        const statusCode = totpRes.code === "TOTP_CONFIG_ERROR" ? 500 : 401;
        res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ success: false, code: totpRes.code, message: totpRes.message }));
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

        if (tableSession) {
          try {
            const lampRes = await lampOff(tableSession.nomor_meja);

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

      if (!sessionId || !namaBarang || isNaN(qtyBaru)) {
        throw new Error("Data pesanan tidak valid");
      }

      const mejaSession = await getSessionById(sessionId);
      if (!mejaSession || mejaSession.status !== "AKTIF") {
        throw new Error("Sesi tidak AKTIF atau tidak ditemukan");
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
          waktuSelesaiBaru = waktuSelesaiBaruDate.toISOString();

          await runAsync(
            `
            UPDATE sesi_meja
            SET durasi_jam = ?, waktu_selesai = ?
            WHERE session_id = ? AND status = 'AKTIF'
            `,
            [durasiJamBaru, waktuSelesaiBaru, sessionId]
          );
        }

        await runAsync("COMMIT");

        if (tableSession) {
          try {
            const lampRes = await lampOff(tableSession.nomor_meja);

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
      if (!mejaSession || mejaSession.status !== "AKTIF") {
        throw new Error("Sesi tidak AKTIF atau tidak ditemukan");
      }

      if (String(mejaSession.jenis_sesi || "").toUpperCase() === "LOSS") {
        throw new Error("Gunakan menu Stop Loss untuk mengakhiri sesi LOSS");
      }

      const nomorMeja = mejaSession.nomor_meja;
      const waktuSelesai = new Date().toISOString();

      await new Promise((resolve, reject) => {
        db.run(
          `UPDATE sesi_meja SET status = 'SELESAI', waktu_selesai = ? WHERE session_id = ?`,
          [waktuSelesai, sessionId],
          (err) => {
            if (err) reject(err);
            else resolve();
          }
        );
      });

      try {
        const lampRes = await lampOff(nomorMeja);
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

        let gasPayload = {};
        if (kategoriId === "PLATINUM") {
          gasPayload = { action: "member_platinum_create", nama, alamat, nomorHp, tanggalLahir };
        } else if (kategoriId === "UMUM") {
          gasPayload = { action: "member_umum_create", nama, alamat, nomorHp, tanggalLahir };
        } else if (kategoriId === "PELAJAR") {
          gasPayload = { action: "member_pelajar_create", nama, alamat, nomorHp, tanggalLahir, namaSekolah, nisn };
        }

        const result = await callMemberGas(gasPayload);

        if (!result || result.success !== true) {
          res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
          return res.end(JSON.stringify({
            success: false,
            message: result?.message || "Gagal mendaftarkan member ke Google Sheet"
          }));
        }

        syncMemberCacheFromGas().catch(err => {
          writeLog("WARN", "MEMBER_CREATE_SYNC_FAILED", "Gagal sync member cache setelah create", { error: err.message });
        });

        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({
          success: true,
          message: result.message,
          data: result.data
        }));
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

 
// ==================================================
// STARTUP LAMP RECOVERY
// ==================================================

let lampWatchdogRunning = false;

async function reconcileLampState() {
  if (lampWatchdogRunning) return;

  lampWatchdogRunning = true;

  try {
    const rows = await new Promise((resolve, reject) => {
      db.all(
        "SELECT nomor_meja FROM sesi_meja WHERE status = 'AKTIF'",
        [],
        (error, result) => {
          if (error) reject(error);
          else resolve(result || []);
        }
      );
    });

    const activeTables = new Set(
      rows
        .map(row => Number(row.nomor_meja))
        .filter(
          table =>
            Number.isInteger(table) &&
            table >= 1 &&
            table <= 10
        )
    );

    writeLog(
      "INFO",
      "LAMP_WATCHDOG_START",
      "Watchdog lampu melakukan sinkronisasi",
      {
        activeTables: [...activeTables].sort((a, b) => a - b)
      }
    );

    for (let table = 1; table <= 10; table++) {
      try {
        const shouldBeOn = activeTables.has(table);

        const lampRes = shouldBeOn
          ? await lampOn(table)
          : await lampOff(table);

        if (!lampRes || lampRes.success !== true) {
          writeLog(
            "WARN",
            "LAMP_WATCHDOG_FAILED",
            "Watchdog gagal menyinkronkan lampu",
            {
              nomorMeja: table,
              databaseAktif: shouldBeOn,
              lampRes
            }
          );
        }
      } catch (lampError) {
        writeLog(
          "ERROR",
          "LAMP_WATCHDOG_ERROR",
          "Watchdog error saat sinkronisasi lampu",
          {
            nomorMeja: table,
            databaseAktif: activeTables.has(table),
            error: lampError.message
          }
        );
      }
    }

    writeLog(
      "INFO",
      "LAMP_WATCHDOG_COMPLETE",
      "Watchdog lampu selesai"
    );

  } catch (error) {
    writeLog(
      "ERROR",
      "LAMP_WATCHDOG_FATAL",
      "Watchdog gagal membaca status sesi",
      {
        error: error.message
      }
    );
  } finally {
    lampWatchdogRunning = false;
  }
}
async function recoverLampStateAtStartup() {
  writeLog(
    "INFO",
    "LAMP_RECOVERY_START",
    "Memulai sinkronisasi status lampu dengan database"
  );

  try {
    const rows = await new Promise((resolve, reject) => {
      db.all(
        `SELECT nomor_meja FROM sesi_meja WHERE status = 'AKTIF'`,
        [],
        (error, result) => {
          if (error) {
            reject(error);
            return;
          }

          resolve(result || []);
        }
      );
    });

    const activeTables = new Set(
      rows
        .map(row => Number(row.nomor_meja))
        .filter(
          table =>
            Number.isInteger(table) &&
            table >= 1 &&
            table <= 10
        )
    );

    for (let table = 1; table <= 10; table++) {
      try {
        const shouldBeOn = activeTables.has(table);

        let lampRes;

        if (shouldBeOn) {
          lampRes = await lampOn(table);
        } else {
          lampRes = await lampOff(table);
        }

        if (lampRes && lampRes.success === true) {
          writeLog(
            "INFO",
            "LAMP_RECOVERY_SUCCESS",
            `Startup: lampu meja ${table} disinkronkan menjadi ${shouldBeOn ? "ON" : "OFF"}`,
            {
              nomorMeja: table,
              databaseAktif: shouldBeOn
            }
          );
        } else {
          writeLog(
            "WARN",
            "LAMP_RECOVERY_FAILED",
            `Startup: gagal menyinkronkan lampu meja ${table}`,
            {
              nomorMeja: table,
              databaseAktif: shouldBeOn,
              lampRes
            }
          );
        }
      } catch (lampError) {
        writeLog(
          "ERROR",
          "LAMP_RECOVERY_ERROR",
          `Startup: error saat menyinkronkan lampu meja ${table}`,
          {
            nomorMeja: table,
            databaseAktif: activeTables.has(table),
            error: lampError.message
          }
        );
      }
    }

    writeLog(
      "INFO",
      "LAMP_RECOVERY_COMPLETE",
      "Sinkronisasi status lampu dengan database selesai",
      {
        activeTables: [...activeTables].sort((a, b) => a - b)
      }
    );
  } catch (error) {
    writeLog(
      "ERROR",
      "LAMP_RECOVERY_FATAL",
      "Gagal mengambil status sesi untuk recovery lampu saat startup",
      {
        error: error.message
      }
    );
  }
}
server.on("error", error => {
  writeLog("ERROR", "SERVER", "Server error", { code: error.code, message: error.message });
});

server.listen(config.PORT, async () => {
  console.log(`POS POLAR SERVER berjalan di https://192.168.1.140:${config.PORT}`);
  writeLog("INFO", "SERVER_START", `POS POLAR SERVER berjalan di port ${config.PORT}`);

  try {
    await recoverLampStateAtStartup();

    setInterval(() => {
      reconcileLampState();
    }, 30000);
  } catch (error) {
    writeLog(
      "WARN",
      "STARTUP_LAMP_RECOVERY",
      "Recovery lampu saat startup gagal",
      {
        error: error.message
      }
    );
  }

  try {
    console.log("[MEMBER] Database member siap");
    writeLog("INFO", "MEMBER_INIT", "[MEMBER] Database member siap");
    await cekStatusMemberHarian();

    syncMemberCacheFromGas().catch(err => {
      writeLog("WARN", "STARTUP_MEMBER_SYNC", "Sync member cache saat startup gagal", { error: err.message });
    });
  } catch (error) {
    writeLog("WARN", "MEMBER_INIT_ERROR", "Terjadi kesalahan saat inisialisasi member", { error: error.message });
  }

  try {
    await syncHargaMemberCache();
  } catch (error) {
    writeLog("WARN", "STARTUP_HARGA_MEMBER_SYNC", "Sync harga member cache saat startup gagal", { error: error.message });
  }

  try {
    const pending = await getPendingTransactions();

    if (pending.length > 0) {
      writeLog("INFO", "STARTUP", "Ditemukan transaksi pending, melakukan sync otomatis...");
      await syncPendingTransactions();
    }
  } catch (error) {
    writeLog("WARN", "STARTUP_SYNC_PENDING", "Sync transaksi pending saat startup gagal", { error: error.message });
  }

  setInterval(checkExpiredTableSessions, 10 * 1000);
});



