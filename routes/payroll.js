/**
 * routes/payroll.js — Modul "Penggajian & Kasbon Karyawan" (Panel Admin)
 *
 * Panel Admin berjalan di admin-server.js (Node http mentah, port 3200),
 * BUKAN server.js (POS, https). Modul ini dirancang untuk di-mount ke
 * admin-server.js lewat dua baris:
 *
 *   1. require + db di header admin-server.js (setelah `const db = ...`):
 *        const { routePayroll, initPayrollTables } = require('./routes/payroll');
 *
 *   2. Di dalam handler http.createServer, sebelum/paralel dengan
 *      `if (req.method === 'GET' && pathname === '/api/admin/...')`:
 *        if (pathname.startsWith('/api/admin/payroll')
 *            && routePayroll(req, res, parsed, db)) return;
 *
 *   3. Di dalam blok `db.serialize(() => { ... })` di startup
 *      (sebelum/paralel dengan CREATE TABLE admin_users), panggil sekali:
 *        initPayrollTables();
 *
 * Semua handler memakai `db` module-scope admin-server.js (sudah
 * `db.serialize` aktif global) dan `BEGIN IMMEDIATE` + `COMMIT`/`ROLLBACK`
 * untuk mutasi multi-tabel.
 *
 * CATATAN PATH: modul ini memakai prefix `/api/admin/payroll/*` agar
 * konsisten dengan semua route admin lain. Jika ingin prefix lain, ubah
 * `PREFIX` di bawah dan pemanggil di admin-server.js.
 */
"use strict";

const PREFIX = "/api/admin/payroll";

// ── DB helper ─────────────────────────────────────────────────────────────────
// Module-scope handle ke db admin-server.js. Di-set lewat `bindDb(db)` yang
// dipanggil oleh initPayrollTables() / mount — agar modul tetap bisa di-test
// standalone tanpa import admin-server.js.
let db = null;

function bindDb(conn) {
  db = conn;
  if (!db) throw new Error("routes/payroll: bindDb() dipanggil tanpa koneksi");
}

// ── Helpers umum ──────────────────────────────────────────────────────────────

function sendJson(res, status, obj) {
  if (res.headersSent) return;
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > 1e6) {
        reject(new Error("Body terlalu besar"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch (e) {
        reject(new Error("Body JSON tidak valid"));
      }
    });
    req.on("error", reject);
  });
}

function toInt(v, fallback) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function toFloat(v, fallback) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * `db.run` / `db.all` / `db.get` wrapper yang mengembalikan Promise,
 * kompatibel dengan sqlite3 callback API.
 */
const dbRun = (sql, params = []) =>
  new Promise((res, rej) => db.run(sql, params, (e) => (e ? rej(e) : res())));
const dbAll = (sql, params = []) =>
  new Promise((res, rej) => db.all(sql, params, (e, r) => (e ? rej(e) : res(r || []))));
const dbGet = (sql, params = []) =>
  new Promise((res, rej) => db.get(sql, params, (e, r) => (e ? rej(e) : res(r))));

/**
 * Transaksi SQLite untuk mutasi multi-tabel.
 * `fn(runFn)` — runFn(sql, params) → Promise<void>; semua statement berjalan
 * sekuensial di dalam transaksi. `BEGIN IMMEDIATE` mengambil write lock
 * segera sehingga `karyawan.sisa_kasbon` tak berubah saat kalkulasi.
 *
 * Catatan: `db.serialize` global di admin-server.js membuat semua statement
 * sekuensial; `BEGIN IMMEDIATE` + `COMMIT`/`ROLLBACK` adalah satu unit atomik
 * di atasnya. Kalau `fn` reject → `ROLLBACK` otomatis, lalu error dilempar.
 */
async function dbTransaction(fn) {
  await dbRun("BEGIN IMMEDIATE");
  try {
    await fn((sql, params) => dbRun(sql, params));
    await dbRun("COMMIT");
  } catch (err) {
    try {
      await dbRun("ROLLBACK");
    } catch (_) {
      /* rollback gagal (sudah di-commit / connection rusak) — biarkan error asli */
    }
    throw err;
  }
}

// ── Init tabel (idempotent) ───────────────────────────────────────────────────

async function initPayrollTables() {
  await dbRun(
    `CREATE TABLE IF NOT EXISTS karyawan (
       id                  INTEGER PRIMARY KEY AUTOINCREMENT,
       nama                TEXT NOT NULL,
       jabatan             TEXT,
       no_hp               TEXT,
       gaji_pokok_default  REAL DEFAULT 0,
       status              TEXT DEFAULT 'aktif',
       sisa_kasbon         REAL DEFAULT 0,
       created_at          DATETIME DEFAULT CURRENT_TIMESTAMP
     )`
  );
  await dbRun(
    `CREATE TABLE IF NOT EXISTS kasbon_karyawan (
       id            INTEGER PRIMARY KEY AUTOINCREMENT,
       karyawan_id   INTEGER NOT NULL,
       tanggal       DATETIME DEFAULT CURRENT_TIMESTAMP,
       tipe          TEXT NOT NULL,
       jumlah        REAL NOT NULL,
       sumber_dana   TEXT DEFAULT 'BANK',
       keterangan    TEXT,
       created_by    TEXT,
       FOREIGN KEY (karyawan_id) REFERENCES karyawan(id)
     )`
  );
  await dbRun(
    `CREATE TABLE IF NOT EXISTS gaji_karyawan (
       id             INTEGER PRIMARY KEY AUTOINCREMENT,
       karyawan_id    INTEGER NOT NULL,
       nama_karyawan  TEXT,
       periode        TEXT,
       gaji_pokok     REAL DEFAULT 0,
       bonus_komisi   REAL DEFAULT 0,
       potongan       REAL DEFAULT 0,
       total_gaji     REAL DEFAULT 0,
       sumber_dana    TEXT DEFAULT 'BANK',
       keterangan     TEXT,
       created_by     TEXT,
       created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
       FOREIGN KEY (karyawan_id) REFERENCES karyawan(id)
     )`
  );

  // Seed karyawan contoh bila tabel masih kosong (sekali, aman diulang)
  const { c } = await dbGet("SELECT COUNT(*) AS c FROM karyawan");
  if (c === 0) {
    await dbRun(
      `INSERT INTO karyawan (nama, jabatan, gaji_pokok_default, status)
       VALUES ('Faisal','Barman',3000000,'aktif'),
              ('Ozat','Cashier',2500000,'aktif'),
              ('Walid','Security',2000000,'aktif')`
    );
  }
}

// ── Endpoint: GET karyawan ────────────────────────────────────────────────────

async function handleGetKaryawan(req, res) {
  const rows = await dbAll(
    `SELECT id, nama, jabatan, gaji_pokok_default, sisa_kasbon
     FROM karyawan WHERE status = 'aktif' ORDER BY nama ASC`
  );
  sendJson(res, 200, { success: true, data: rows, total: rows.length });
}

// ── Endpoint: POST kasbon (PINJAM) ────────────────────────────────────────────

async function handlePostKasbon(req, res) {
  let body;
  try {
    body = await parseBody(req);
  } catch (e) {
    return sendJson(res, 400, { success: false, message: e.message });
  }

  const karyawanId = toInt(body.karyawan_id, 0);
  const jumlah = toFloat(body.jumlah, 0);
  const sumberDana = (body.sumber_dana || "BANK").toUpperCase();
  const keterangan = body.keterangan || "";
  const createdBy = body.created_by || "";

  if (!karyawanId)
    return sendJson(res, 400, { success: false, message: "karyawan_id wajib" });
  if (jumlah <= 0)
    return sendJson(res, 400, { success: false, message: "jumlah harus > 0" });

const kr = await dbGet(
  "SELECT id, nama, status, COALESCE(gaji_pokok_default, 0) AS gaji_pokok, COALESCE(sisa_kasbon, 0) AS sisa_kasbon FROM karyawan WHERE id = ?",
  [karyawanId]
);
if (!kr)
  return sendJson(res, 404, { success: false, message: "Karyawan tidak ditemukan" });
if (kr.status !== "aktif")
  return sendJson(res, 400, {
    success: false,
    message: "Karyawan nonaktif — tidak bisa dikasbon",
  });

const gajiPokok = Number(kr.gaji_pokok) || 0;
const sisaKasbonExisting = Number(kr.sisa_kasbon) || 0;
const sisaLimit = Math.max(0, gajiPokok - sisaKasbonExisting);

if (sisaLimit <= 0) {
  return sendJson(res, 400, {
    success: false,
    message: `Kasbon ditolak! Total sisa kasbon aktif (Rp ${sisaKasbonExisting.toLocaleString('id-ID')}) sudah mencapai atau melebihi batas gaji pokok (Rp ${gajiPokok.toLocaleString('id-ID')}).`,
  });
}

if (jumlah > sisaLimit) {
  return sendJson(res, 400, {
    success: false,
    message: `Kasbon ditolak! Nominal pengajuan (Rp ${jumlah.toLocaleString('id-ID')}) melebihi sisa limit kasbon yang diizinkan (Rp ${sisaLimit.toLocaleString('id-ID')}).`,
  });
}

  try {
    await dbTransaction(async (run) => {
      // a. Insert kasbon PINJAM
      await run(
        `INSERT INTO kasbon_karyawan
           (karyawan_id, tipe, jumlah, sumber_dana, keterangan, created_by)
         VALUES (?, 'PINJAM', ?, ?, ?, ?)`,
        [karyawanId, jumlah, sumberDana, keterangan, createdBy]
      );
      // b. Update sisa_kasbon + jumlah
      await run(
        `UPDATE karyawan SET sisa_kasbon = COALESCE(sisa_kasbon, 0) + ? WHERE id = ?`,
        [jumlah, karyawanId]
      );
      // c. (Opsional) catat ke pengeluaran_bank bila ada & sumber_dana = BANK
      if (sumberDana === "BANK") {
        try {
          await run(
            `INSERT INTO pengeluaran_bank
               (tanggal, kategori, nama_barang, nominal, keterangan, created_by)
             VALUES (datetime('now'), 'KASBON_KARYAWAN', ?, ?, ?, ?)`,
            [`${kr.nama} — Kasbon`, jumlah, keterangan || "Kasbon karyawan", createdBy]
          );
        } catch (_) {
          /* pengeluaran_bank belum ada / skema beda — tetap commit kasbon */
        }
      }
    });
  } catch (e) {
    return sendJson(res, 500, {
      success: false,
      message: "Transaksi kasbon gagal: " + e.message,
    });
  }

  sendJson(res, 200, {
    success: true,
    message: `Kasbon Rp ${jumlah.toLocaleString("id-ID")} untuk ${kr.nama} tercatat`,
    data: { karyawan_id: karyawanId, nama: kr.nama, jumlah, sumber_dana: sumberDana },
  });
}

// ── Endpoint: POST gaji ───────────────────────────────────────────────────────

async function handlePostGaji(req, res) {
  let body;
  try {
    body = await parseBody(req);
  } catch (e) {
    return sendJson(res, 400, { success: false, message: e.message });
  }

  const karyawanId = toInt(body.karyawan_id, 0);
  const periode = String(body.periode || "").trim();
  const gajiPokok = toFloat(body.gaji_pokok, 0);
  const bonusKomisi = toFloat(body.bonus_komisi, 0);
  const potongKasbon = toFloat(body.potong_kasbon, 0);
  const sumberDana = "BANK";
  const keterangan = body.keterangan || "";
  const createdBy = body.created_by || "";

  if (!karyawanId)
    return sendJson(res, 400, { success: false, message: "karyawan_id wajib" });
  if (!periode)
    return sendJson(res, 400, { success: false, message: "periode wajib (mis. '2026-10')" });
  if (gajiPokok < 0)
    return sendJson(res, 400, { success: false, message: "gaji_pokok tidak boleh negatif" });

  const totalGaji = Math.max(0, gajiPokok + bonusKomisi - potongKasbon);

  const kr = await dbGet(
    "SELECT id, nama, status FROM karyawan WHERE id = ?",
    [karyawanId]
  );
  if (!kr)
    return sendJson(res, 404, { success: false, message: "Karyawan tidak ditemukan" });

  const existing = await dbGet(
    `SELECT id FROM gaji_karyawan WHERE karyawan_id = ? AND periode = ?`,
    [karyawanId, periode]
  );
  if (existing)
    return sendJson(res, 409, {
      success: false,
      message: `Gaji periode ${periode} untuk ${kr.nama} sudah tercatat (id=${existing.id})`,
    });

  try {
    await dbTransaction(async (run) => {
      // a. Insert gaji_karyawan
      await run(
        `INSERT INTO gaji_karyawan
           (karyawan_id, nama_karyawan, periode, gaji_pokok, bonus_komisi,
            potongan, total_gaji, sumber_dana, keterangan, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          karyawanId,
          kr.nama,
          periode,
          gajiPokok,
          bonusKomisi,
          potongKasbon,
          totalGaji,
          sumberDana,
          keterangan,
          createdBy,
        ]
      );

      // c. Jika potong_kasbon > 0
      if (potongKasbon > 0) {
        await run(
          `INSERT INTO kasbon_karyawan
             (karyawan_id, tipe, jumlah, sumber_dana, keterangan, created_by)
           VALUES (?, 'POTONG_GAJI', ?, ?, ?, ?)`,
          [
            karyawanId,
            potongKasbon,
            sumberDana,
            `Potongan kasbon gaji periode ${periode}`,
            createdBy,
          ]
        );
        // sisa_kasbon tak boleh negatif
        await run(
          `UPDATE karyawan SET sisa_kasbon = MAX(0, COALESCE(sisa_kasbon, 0) - ?) WHERE id = ?`,
          [potongKasbon, karyawanId]
        );
      }

      // d. (Opsional) integrasi kas_keluar / pengeluaran_bank
      if (totalGaji > 0) {
        if (String(sumberDana || '').toUpperCase() === "BANK") {
          try {
            await run(
              `INSERT INTO pengeluaran_bank
                 (tanggal, kategori, nama_barang, nominal, keterangan, created_by)
               VALUES (datetime('now'), 'GAJI_KARYAWAN', ?, ?, ?, ?)`,
              [
                `${kr.nama} — Gaji ${periode}`,
                totalGaji,
                keterangan || `Gaji ${periode}`,
                createdBy,
              ]
            );
          } catch (_) {
            /* abaikan — gaji tetap tercatat */
          }
        } else if (String(sumberDana || '').toUpperCase() === "KAS") {
          try {
            await run(
              `INSERT INTO kas_keluar
                 (shift_id, kasir_id, waktu, nominal, keterangan)
               VALUES (0, 0, datetime('now'), ?, ?)`,
              [totalGaji, `Gaji ${kr.nama} — ${periode}`]
            );
          } catch (_) {
            /* kas_keluar skema beda — abaikan */
          }
        }
      }
    });
  } catch (e) {
    return sendJson(res, 500, {
      success: false,
      message: "Transaksi gaji gagal: " + e.message,
    });
  }

  sendJson(res, 200, {
    success: true,
    message: `Gaji ${periode} untuk ${kr.nama} tercatat`,
    data: {
      karyawan_id: karyawanId,
      nama: kr.nama,
      periode,
      gaji_pokok: gajiPokok,
      bonus_komisi: bonusKomisi,
      potong_kasbon: potongKasbon,
      total_gaji: totalGaji,
      sumber_dana: sumberDana,
    },
  });
}

// ── Endpoint: GET riwayat gaji ───────────────────────────────────────────────

async function handleGetRiwayatGaji(req, res, parsed) {
  const periode = parsed.query.periode || null;
  const limit = toInt(parsed.query.limit, 50);

  const rows = periode
    ? await dbAll(
        `SELECT g.*, k.jabatan
         FROM gaji_karyawan g
         LEFT JOIN karyawan k ON k.id = g.karyawan_id
         WHERE g.periode = ?
         ORDER BY g.created_at DESC, g.id DESC
         LIMIT ?`,
        [periode, limit]
      )
    : await dbAll(
        `SELECT g.*, k.jabatan
         FROM gaji_karyawan g
         LEFT JOIN karyawan k ON k.id = g.karyawan_id
         ORDER BY g.created_at DESC, g.id DESC
         LIMIT ?`,
        [limit]
      );

  sendJson(res, 200, {
    success: true,
    data: rows,
    total: rows.length,
    filter: { periode: periode || null, limit },
  });
}

// ── Endpoint: GET riwayat kasbon per karyawan ────────────────────────────────

async function handleGetRiwayatKasbon(req, res, karyawanIdRaw) {
  const id = toInt(karyawanIdRaw, 0);
  if (!id)
    return sendJson(res, 400, { success: false, message: "karyawan_id tidak valid" });

  const kr = await dbGet(
    "SELECT id, nama, jabatan, status, sisa_kasbon FROM karyawan WHERE id = ?",
    [id]
  );
  if (!kr)
    return sendJson(res, 404, { success: false, message: "Karyawan tidak ditemukan" });

  const rows = await dbAll(
    `SELECT id, tanggal, tipe, jumlah, sumber_dana, keterangan, created_by
     FROM kasbon_karyawan
     WHERE karyawan_id = ?
     ORDER BY tanggal DESC, id DESC
     LIMIT 100`,
    [id]
  );

  const totalPinjam = rows
    .filter((r) => r.tipe === "PINJAM")
    .reduce((s, r) => s + (r.jumlah || 0), 0);
  const totalPotong = rows
    .filter((r) => r.tipe === "POTONG_GAJI")
    .reduce((s, r) => s + (r.jumlah || 0), 0);

  sendJson(res, 200, {
    success: true,
    karyawan: {
      id: kr.id,
      nama: kr.nama,
      jabatan: kr.jabatan,
      status: kr.status,
      sisa_kasbon: kr.sisa_kasbon,
    },
    riwayat: rows,
    summary: {
      total_pinjam: totalPinjam,
      total_potong_gaji: totalPotong,
      sisa_kasbon: kr.sisa_kasbon,
    },
  });
}

// ── Dispatcher utama ──────────────────────────────────────────────────────────

/**
 * Dipanggil dari admin-server.js:
 *   if (pathname.startsWith('/api/admin/payroll') &&
 *       routePayroll(req, res, parsed, db)) return;
 *
 * @returns {boolean} true bila request ditangani modul ini (server boleh
 *                    `return`), false bila bukan — server lanjutkan.
 *
 * `bindDb(conn)` dipanggil otomatis saat first hit sehingga modul bisa
 * di-mount tanpa setup eksplisit; panggil `bindDb(db)` sekali di startup
 * bila mau inisialisasi lebih awal.
 */
function routePayroll(req, res, parsed, conn) {
  if (conn && db !== conn) bindDb(conn);

  const pathname = parsed.pathname || "";
  const q = parsed.query || {};

  const handle = async () => {
    if (req.method === "GET" && pathname === `${PREFIX}/karyawan`) {
      return handleGetKaryawan(req, res);
    }
    if (req.method === "POST" && pathname === `${PREFIX}/kasbon`) {
      return handlePostKasbon(req, res);
    }
    if (req.method === "POST" && pathname === `${PREFIX}/gaji`) {
      return handlePostGaji(req, res);
    }
    if (req.method === "GET" && pathname === `${PREFIX}/gaji/riwayat`) {
      return handleGetRiwayatGaji(req, res, { query: q });
    }
    const kasbonRiwayatMatch = pathname.match(
      new RegExp("^" + PREFIX + "/kasbon/riwayat/(\\d+)$")
    );
    if (req.method === "GET" && kasbonRiwayatMatch) {
      return handleGetRiwayatKasbon(req, res, kasbonRiwayatMatch[1]);
    }
    sendJson(res, 404, {
      success: false,
      message: "Endpoint payroll tidak ditemukan: " + req.method + " " + pathname,
    });
  };

  handle().catch((e) =>
    sendJson(res, 500, { success: false, message: "Internal error: " + e.message })
  );
  return true;
}

module.exports = {
  routePayroll,
  bindDb,
  initPayrollTables,
  // Exposed untuk test unit:
  _handleGetKaryawan: handleGetKaryawan,
  _handlePostKasbon: handlePostKasbon,
  _handlePostGaji: handlePostGaji,
  _handleGetRiwayatGaji: handleGetRiwayatGaji,
  _handleGetRiwayatKasbon: handleGetRiwayatKasbon,
};
