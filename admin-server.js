/**
 * PBMS Admin Server
 * Port: 3200
 * Database: pos.db
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const sqlite3 = require('sqlite3').verbose();

const PORT = 3200;
const DB_PATH = path.join(__dirname, 'pos.db');
const ADMIN_DIR = path.join(__dirname, 'admin');

// ── Database ─────────────────────────────────────────────────────
const db = new sqlite3.Database(DB_PATH);
db.serialize(() => {
  db.run('PRAGMA journal_mode = WAL');

  // 1. Ensure admin_users table exists
  db.run(
    `CREATE TABLE IF NOT EXISTS admin_users (
       id         INTEGER PRIMARY KEY AUTOINCREMENT,
       username   TEXT UNIQUE NOT NULL,
       pin        TEXT NOT NULL,
       nama       TEXT NOT NULL,
       status     INTEGER DEFAULT 1,
       created_at DATETIME DEFAULT (datetime('now')),
       updated_at DATETIME DEFAULT (datetime('now'))
     )`,
    (err) => {
      if (err) console.error('[ADMIN] Gagal membuat tabel admin_users:', err.message);
    }
  );

  // 2. Auto-seed default admin account if table is empty
  db.get(
    'SELECT COUNT(*) AS cnt FROM admin_users',
    [],
    (err, row) => {
      if (err) return;
      if (row && row.cnt === 0) {
        db.run(
          `INSERT INTO admin_users (username, pin, nama, status, created_at, updated_at)
           VALUES ('admin', '123456', 'Administrator Utama', 1, datetime('now'), datetime('now'))`,
          (seedErr) => {
            if (seedErr) console.error('[ADMIN] Gagal seed default admin:', seedErr.message);
            else console.log('[ADMIN] Akun default "admin" berhasil di-seed.');
          }
        );
      }
    }
  );

  // 3. Migrasi kolom status_bank di shift_kasir (Fix #34 / Fix #39):
  //    status_bank  : 'PENDING' (default) | 'DISETOR'
  //    deposited_at : timestamp saat admin mengonfirmasi setor ke bank
  //    deposited_by : nama admin yang mengonfirmasi
  //    Kolom sudah ada (misal di-run 2x) → ALTER gagal → di-silent, aman.
  db.all('PRAGMA table_info(shift_kasir)', [], (pragmaErr, pragmaRows) => {
    if (pragmaErr) {
      console.error('[ADMIN][migrasi] Gagal membaca pragma shift_kasir:', pragmaErr.message);
      return;
    }

    // Pastikan existing SELALU bernilai Array — proteksi terhadap versi
    // node-sqlite3 yang mengembalikan object tunggal, undefined, atau nilai
    // non-array lain (PRAGMA bisa mengembalikan string/number pada versi lama).
    const rows = Array.isArray(pragmaRows)
      ? pragmaRows
      : (typeof pragmaRows === 'object' && pragmaRows !== null ? [pragmaRows] : []);
    const existing = rows.map(c => (c && c.name) || '').filter(Boolean);

    const colsToEnsure = [
      { name: 'status_bank',  sql: "ALTER TABLE shift_kasir ADD COLUMN status_bank TEXT DEFAULT 'PENDING'" },
      { name: 'deposited_at', sql: "ALTER TABLE shift_kasir ADD COLUMN deposited_at TEXT DEFAULT NULL" },
      { name: 'deposited_by', sql: "ALTER TABLE shift_kasir ADD COLUMN deposited_by TEXT DEFAULT NULL" },
    ];

    colsToEnsure.forEach(item => {
      if (!existing.includes(item.name)) {
        db.run(item.sql, (runErr) => {
          if (runErr) console.error(`[ADMIN][migrasi] shift_kasir (${item.name}):`, runErr.message);
          else console.log(`[ADMIN][migrasi] OK: Tambah kolom ${item.name}`);
        });
      }
    });
    if (colsToEnsure.every(item => existing.includes(item.name))) {
      console.log('[ADMIN][migrasi] shift_kasir sudah up-to-date.');
    }
  });

  // 4. Tabel histori pembelian (Fix #45 — Purchase Cart)
  db.run(`CREATE TABLE IF NOT EXISTS pembelian (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    nota_no           TEXT NOT NULL UNIQUE,
    kasir_id          INTEGER NOT NULL,
    total_modal       INTEGER NOT NULL DEFAULT 0,
    total_qty         INTEGER NOT NULL DEFAULT 0,
    catat_kas_keluar  INTEGER NOT NULL DEFAULT 0,
    created_at        TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  )`, (err) => {
    if (err) console.error('[ADMIN][migrasi] CREATE pembelian:', err.message);
  });

  db.run(`CREATE TABLE IF NOT EXISTS detail_pembelian (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    pembelian_id      INTEGER NOT NULL,
    barang_id         INTEGER NOT NULL,
    hpp_lama          INTEGER NOT NULL DEFAULT 0,
    hpp_baru          INTEGER NOT NULL DEFAULT 0,
    harga_jual_lama   INTEGER NOT NULL DEFAULT 0,
    harga_jual_baru   INTEGER NOT NULL DEFAULT 0,
    qty               INTEGER NOT NULL DEFAULT 0,
    subtotal_modal    INTEGER NOT NULL DEFAULT 0,
    created_at        TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  )`, (err) => {
    if (err) console.error('[ADMIN][migrasi] CREATE detail_pembelian:', err.message);
  });

  // (Fix #46) kolom kategori_target di pembelian — histori per kategori
  // Pakai PRAGMA table_info untuk cek keberadaan kolom (lebih portable)
  db.all('PRAGMA table_info(pembelian)', [], (pgErr, pgRows) => {
    if (pgErr) {
      db.run(`ALTER TABLE pembelian ADD COLUMN kategori_target TEXT`, (ae) => {
        if (ae) console.error('[ADMIN][migrasi] ALTER ADD kategori_target:', ae.message);
        else console.log('[ADMIN][migrasi] kolom kategori_target ditambahkan ke pembelian.');
      });
      return;
    }
    const colNames = (Array.isArray(pgRows) ? pgRows : []).map(r => r && r.name).filter(Boolean);

    // (Fix #54) kolom status & no_po di pembelian — alur PO PENDING
    // status  : 'PENDING' (default) | 'DITERIMA' | 'BATAL'
    // no_po   : salinan nota_no — agar front-end bisa display secara eksplisit
    //           tanpa harus mengira-ngira mana PO mana nota lama.
    if (!colNames.includes('status')) {
      db.run(`ALTER TABLE pembelian ADD COLUMN status TEXT NOT NULL DEFAULT 'PENDING'`, (ae) => {
        if (ae) console.error('[ADMIN][migrasi] ALTER ADD status:', ae.message);
        else console.log('[ADMIN][migrasi] kolom status ditambahkan ke pembelian (default PENDING).');
      });
    }
    if (!colNames.includes('no_po')) {
      db.run(`ALTER TABLE pembelian ADD COLUMN no_po TEXT`, (ae) => {
        if (ae) console.error('[ADMIN][migrasi] ALTER ADD no_po:', ae.message);
        else console.log('[ADMIN][migrasi] kolom no_po ditambahkan ke pembelian.');
      });
    }
    // Backfill: lama data (sebelum migrasi) dianggap PENDING, no_po = nota_no
    if (colNames.includes('status') && colNames.includes('no_po')) {
      db.run(`UPDATE pembelian SET no_po = COALESCE(no_po, nota_no) WHERE no_po IS NULL`, (e2) => {
        if (e2) console.error('[ADMIN][migrasi] backfill no_po:', e2.message);
      });
    }
  });

  console.log('[ADMIN][migrasi] pembelian & detail_pembelian siap.');
});

// ── Static file serving ────────────────────────────────────��─────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css;  charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png':  'image/png',
  '.svg':  'image/svg+xml',
};

function serveStatic(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const mime = MIME[ext] || 'application/octet-stream';
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: false, message: 'File tidak ditemukan' }));
    }
    res.writeHead(200, {
      'Content-Type': mime,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
    });
    res.end(data);
  });
}

// ── API: POST /api/admin/login ───────────────────────────────────
function handleAdminLogin(req, res) {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    let data;
    try {
      data = JSON.parse(body);
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: false, message: 'Body JSON tidak valid' }));
    }

    const username = String(data.username || '').trim();
    const pin      = String(data.pin      || '').trim();

    if (!username || !pin) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: false, message: 'Username dan PIN wajib diisi' }));
    }

    if (pin.length !== 6) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: false, message: 'PIN harus 6 digit' }));
    }

    // Look up in admin_users table
    db.get(
      `SELECT id, username, nama, pin FROM admin_users WHERE username = ? AND pin = ? AND status = 1 LIMIT 1`,
      [username, pin],
      (err, row) => {
        if (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, message: 'Gagal memeriksa database', error: err.message }));
        }

        if (!row) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({
            success: false,
            message: 'Username atau PIN Admin tidak ditemukan / salah',
          }));
        }

        // Success — generate a simple token
        const token = Buffer.from(
          JSON.stringify({ id: row.id, username: row.username, iat: Date.now() })
        ).toString('base64');

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          token,
          admin: { id: row.id, username: row.username, nama: row.nama },
        }));
      }
    );
  });
}

// ── HTTP Server ─────────────���────────────────────────────────────
// ── API: GET /api/admin/overview-stats ─────────────────────────
function handleAdminOverviewStats(req, res) {
  const json = (code, payload) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  };

  const queries = [];

  // 1. Total Transaksi Hari Ini
  queries.push(new Promise((resolve, reject) => {
    db.get(
      `SELECT COUNT(*) AS c FROM transaksi
       WHERE date(tanggal) = date('now', 'localtime') AND tipe_transaksi = 'PENJUALAN'`,
      [],
      (err, row) => (err ? reject(err) : resolve(row ? row.c : 0))
    );
  }));

  // 2. Total Penjualan Hari Ini
  queries.push(new Promise((resolve, reject) => {
    db.get(
      `SELECT COALESCE(SUM(total), 0) AS s FROM transaksi
       WHERE date(tanggal) = date('now', 'localtime') AND tipe_transaksi = 'PENJUALAN'`,
      [],
      (err, row) => (err ? reject(err) : resolve(row ? row.s : 0))
    );
  }));

  // 3. Total Modal (HPP) Hari Ini
  //    detail_transaksi tidak punya kolom barang_id — HPP sudah tersimpan
  //    per-baris di kolom `hpp` saat transaksi dibuat (lihat server.js).
  queries.push(new Promise((resolve, reject) => {
    db.get(
      `SELECT COALESCE(SUM(d.qty * COALESCE(d.hpp, 0)), 0) AS s
       FROM detail_transaksi d
       JOIN transaksi t ON d.transaksi_id = t.id
       WHERE date(t.tanggal) = date('now', 'localtime')
         AND t.tipe_transaksi = 'PENJUALAN'`,
      [],
      (err, row) => (err ? reject(err) : resolve(row ? row.s : 0))
    );
  }));

  // 4. Kerugian SO Bulan Ini
  queries.push(new Promise((resolve, reject) => {
    db.get(
      `SELECT COALESCE(SUM(total_kerugian), 0) AS s FROM stock_opname
       WHERE strftime('%Y-%m', date(tanggal)) = strftime('%Y-%m', date('now', 'localtime'))`,
      [],
      (err, row) => (err ? reject(err) : resolve(row ? row.s : 0))
    );
  }));

  // 4b. Kelebihan SO Bulan Ini — nilai modal barang plus (selisih > 0)
  //     pada bulan berjalan. HPP diambil dari master_barang saat ini
  //     (detail tidak menyimpan harga — Fix #8/#14). Skema riil:
  //     JOIN detail↔header via so_id (bukan kolom imajiner di spec).
  queries.push(new Promise((resolve, reject) => {
    db.get(
      `SELECT COALESCE(SUM(d.selisih_barang * COALESCE(m.hpp, 0)), 0) AS s
       FROM stock_opname_detail d
       JOIN stock_opname h ON h.so_id = d.so_id
       LEFT JOIN master_barang m ON m.id_barang = d.id_barang
       WHERE d.selisih_barang > 0
         AND strftime('%Y-%m', date(h.tanggal)) = strftime('%Y-%m', date('now', 'localtime'))`,
      [],
      (err, row) => (err ? reject(err) : resolve(row ? row.s : 0))
    );
  }));

  // 5. Total Master Barang
  queries.push(new Promise((resolve, reject) => {
    db.get('SELECT COUNT(id) AS c FROM master_barang', [],
      (err, row) => (err ? reject(err) : resolve(row ? row.c : 0))
    );
  }));

  // 6. Meja Aktif — jumlah sesi_meja berstatus AKTIF (sama dengan query
  //    yang dipakai server.js: "SELECT * FROM sesi_meja WHERE status='AKTIF'")
  queries.push(new Promise((resolve, reject) => {
    db.get(
      `SELECT COUNT(*) AS c FROM sesi_meja WHERE status = 'AKTIF'`,
      [],
      (err, row) => (err ? reject(err) : resolve(row ? row.c : 0))
    );
  }));

  // 7. Saldo Kas Laci terkini — saldo_awal (kas_laci_config) + akumulasi
  //    seluruh kas_laci_transaksi sejak inisialisasi. Tabel riil (Fix #20
  //    audit DDL): kas_masuk/kas_keluar kosong — semua aliran tercatat di
  //    kas_laci_transaksi (jenis UANG_MASUK/UANG_KELUAR).
  queries.push(new Promise((resolve, reject) => {
    db.get(
      `SELECT COALESCE((SELECT saldo_awal FROM kas_laci_config LIMIT 1), 0)
             + COALESCE((
               SELECT SUM(CASE WHEN jenis = 'UANG_MASUK' THEN nominal
                               ELSE -nominal END)
               FROM kas_laci_transaksi), 0) AS saldo`,
      [],
      (err, row) => (err ? reject(err) : resolve(row ? row.saldo : 0))
    );
  }));

  // 8. Total Setoran Tunai Wajib Bulan Ini s/d Hari Ini (Fix #21 revisi):
  //    SUM(cash_amount) dari transaksi PENJUALAN terakumulasi sejak
  //    tanggal 1 bulan berjalan sampai hari ini — kasir menyerahkan
  //    seluruh uang tunai yang masuk (setoran wajib). Aliran kas laci
  //    (kas_masuk/kas_keluar) sengaja tak dipakai: kedua tabel itu
  //    KOSONG (Fix #20) dan setoran laci justru MEMINJAM saldo,
  //    bukan menambah setoran tunai ke pemilik.
  queries.push(new Promise((resolve, reject) => {
    db.get(
      `SELECT COALESCE(SUM(cash_amount), 0) AS s FROM transaksi
       WHERE tipe_transaksi = 'PENJUALAN'
         AND date(tanggal) >= date('now', 'start of month', 'localtime')
         AND date(tanggal) <= date('now', 'localtime')`,
      [],
      (err, row) => (err ? reject(err) : resolve(row ? row.s : 0))
    );
  }));

  Promise.all([
    queries[0], queries[1], queries[2], queries[3], queries[4], queries[5], queries[6], queries[7], queries[8],
    // DB liveness check
    new Promise((resolve, reject) => {
      db.get('SELECT 1 AS ok', [], (err) =>
        err ? reject(err) : resolve(true)
      );
    }),
  ]).then(([totalTx, totalPenjualan, totalModal, kerugianSO, kelebihanSO, totalBarang, mejaAktif, saldoKasLaci, totalSetoranHariIni, dbOk]) => {
    // urutan queries: 0=totalTx, 1=totalPenjualan, 2=totalModal,
    //                 3=kerugianSO, 4=kelebihanSO, 5=totalBarang,
    //                 6=mejaAktif, 7=saldoKasLaci, 8=totalSetoranHariIni
    const labaKotor = totalPenjualan - totalModal;

    json(200, {
      success: true,
      stats: {
        totalTransaksiHariIni: totalTx,
        totalPenjualanHariIni: totalPenjualan,
        totalModalHariIni: totalModal,
        labaKotorHariIni: labaKotor,
        kerugianSOBulanIni: kerugianSO,
        kelebihanSOBulanIni: kelebihanSO,
        totalMasterBarang: totalBarang,
        totalMejaAktif: mejaAktif,
        saldoKasLaci: saldoKasLaci,
        totalSetoranHariIni: totalSetoranHariIni,
      },
      system: {
        database: dbOk,
        serverPos: true,
        autoBackup: true,
      },
    });
  }).catch((err) => {
    console.error('[ADMIN] Gagal ambil overview stats:', err.message);
    // 4 metrik utama: coba ambil secara terpisah agar tetap terjawab
    // walau kueri lain gagal
    const safeQuery = (sql, fallback) => new Promise((resolve) => {
      db.get(sql, [], (e, row) => resolve(e || !row ? fallback : row));
    });
    Promise.all([
      safeQuery(`SELECT COUNT(*) AS c FROM transaksi
                 WHERE date(tanggal) = date('now','localtime')
                   AND tipe_transaksi = 'PENJUALAN'`, { c: 0 }),
      safeQuery(`SELECT COALESCE(SUM(total),0) AS s FROM transaksi
                 WHERE date(tanggal) = date('now','localtime')
                   AND tipe_transaksi = 'PENJUALAN'`, { s: 0 }),
      safeQuery(`SELECT COALESCE(SUM(d.qty * COALESCE(d.hpp,0)),0) AS s
                 FROM detail_transaksi d
                 JOIN transaksi t ON d.transaksi_id = t.id
                 WHERE date(t.tanggal)=date('now','localtime')
                   AND t.tipe_transaksi='PENJUALAN'`, { s: 0 }),
      safeQuery(`SELECT COALESCE(SUM(total_kerugian),0) AS s FROM stock_opname
                 WHERE strftime('%Y-%m', date(tanggal))
                   = strftime('%Y-%m', date('now','localtime'))`, { s: 0 }),
      safeQuery(`SELECT COALESCE(SUM(d.selisih_barang * COALESCE(m.hpp,0)),0) AS s
                 FROM stock_opname_detail d
                 JOIN stock_opname h ON h.so_id = d.so_id
                 LEFT JOIN master_barang m ON m.id_barang = d.id_barang
                 WHERE d.selisih_barang > 0
                   AND strftime('%Y-%m', date(h.tanggal))
                   = strftime('%Y-%m', date('now','localtime'))`, { s: 0 }),
      safeQuery('SELECT COUNT(id) AS c FROM master_barang', { c: 0 }),
      safeQuery(`SELECT COUNT(*) AS c FROM sesi_meja WHERE status='AKTIF'`, { c: 0 }),
      safeQuery(`SELECT COALESCE((SELECT saldo_awal FROM kas_laci_config LIMIT 1),0)
                 + COALESCE((SELECT SUM(CASE WHEN jenis='UANG_MASUK' THEN nominal
                                             ELSE -nominal END)
                             FROM kas_laci_transaksi),0) AS saldo`, { saldo: 0 }),
      safeQuery(`SELECT COALESCE(SUM(cash_amount),0) AS s FROM transaksi
                 WHERE tipe_transaksi='PENJUALAN'
                   AND date(tanggal) >= date('now','start of month','localtime')
                   AND date(tanggal) <= date('now','localtime')`, { s: 0 }),
    ]).then(([tx, penjualan, modal, kerugian, kelebihan, barang, mejaAktif, saldoKas, setoranHariIni]) => {
      json(200, {
        success: true,
        stats: {
          totalTransaksiHariIni: tx.c,
          totalPenjualanHariIni: penjualan.s,
          totalModalHariIni: modal.s,
          labaKotorHariIni: penjualan.s - modal.s,
          kerugianSOBulanIni: kerugian.s,
          kelebihanSOBulanIni: kelebihan.s,
          totalMasterBarang: barang.c,
          totalMejaAktif: mejaAktif.c,
          saldoKasLaci: saldoKas.saldo,
          totalSetoranHariIni: setoranHariIni.s,
        },
        system: { database: true, serverPos: true, autoBackup: true },
      });
    }).catch(() => {
      json(500, {
        success: false,
        message: 'Gagal membaca database: ' + err.message,
      });
    });
  });
}

// ── API: GET /api/admin/inventory/master ────────────────────────
// Daftar lengkap master_barang + ringkasan agregat, dipakai modal
// "Daftar Master Barang & Stok Terkini" di dashboard admin.
// Skema riil (diekstrak dari pos.db): master_barang(id, nama, hpp,
// harga_jual, updated_at, kategori, stok_aktual, id_barang).
function handleAdminInventoryMaster(req, res) {
  res.writeHead(200, { 'Content-Type': 'application/json' });

  const done = (payload) => { res.end(JSON.stringify(payload)); };

  // 1. Baris master — kolom response dipetakan ke nama spesifikasi
  db.all(
    `SELECT id,
            id_barang   AS kode_barang,
            nama        AS nama_barang,
            kategori,
            hpp         AS harga_modal,
            harga_jual,
            stok_aktual AS stok
     FROM master_barang
     ORDER BY nama ASC`,
    [],
    (err, rows) => {
      if (err) {
        res.statusCode = 500;
        return done({ success: false, message: 'Gagal membaca master_barang: ' + err.message });
      }

      // 2. Ringkasan agregat dari baris yang sama
      const data = (rows || []).map(r => ({
        id: r.id,
        kode_barang: r.kode_barang,
        nama_barang: r.nama_barang,
        kategori: r.kategori,
        harga_modal: Number(r.harga_modal) || 0,
        harga_jual: Number(r.harga_jual) || 0,
        stok: Number(r.stok) || 0,
      }));

      const totalStokFisik = data.reduce((s, r) => s + r.stok, 0);
      const totalNilaiAset = data.reduce((s, r) => s + r.stok * r.harga_modal, 0);
      const categories = [...new Set(data.map(r => r.kategori).filter(Boolean))].sort();

      done({
        success: true,
        summary: {
          totalItems: data.length,
          totalStokFisik: totalStokFisik,
          totalNilaiAset: totalNilaiAset,
        },
        categories,
        data,
      });
    }
  );
}

// ── API: GET /api/admin/tables/revenue?date=YYYY-MM-DD ─────────
// Daftar meja AKTIF (sedang berjalan) + total belanja berjalan
// (*running total*) F&B per sesi.
//
// Sumber data (Fix #22 revisi, audit DDL):
//   - `sesi_meja` : sesi meja (nomor_meja, nama_pemesan, waktu_mulai,
//     status, durasi_jam, session_id)
//   - `pesanan_meja` : item F&B yang di-order SELAMA sesi berjalan
//     (subtotal riil per-baris, terisi sebelum checkout)
//   - `transaksi` / `detail_transaksi` : hanya terisi setelah checkout,
//     jadi untuk running total AKTIF kita pakai `pesanan_meja`.
// Total belanja berjalan per sesi = SUM(pesanan_meja.subtotal).
function handleAdminTablesRevenue(req, res, parsedUrl) {
  const queryDate = (parsedUrl && parsedUrl.query && parsedUrl.query.date) || '';
  // Fallback tanggal memakai zona waktu LOKAL (Fix #22) — `toISOString()`
  // menghasilkan UTC sehingga sesi pagi hari lokal (sesi_mulai 16:00Z
  // = 23:00 WIB) ter-kejar ke "kemarin" bila dibaca dari server UTC.
  const localYMD = () => {
    const n = new Date();
    const y = n.getFullYear();
    const m = String(n.getMonth() + 1).padStart(2, '0');
    const d = String(n.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  };
  const dateParam = /^\d{4}-\d{2}-\d{2}$/.test(queryDate)
    ? queryDate
    : localYMD();

  res.writeHead(200, { 'Content-Type': 'application/json' });

  const formatDurasi = (totalMenit) => {
    const menit = Number(totalMenit) || 0;
    const h = Math.floor(menit / 60);
    const m = menit % 60;
    if (h === 0 && m === 0) return '0 menit';
    if (h === 0) return m + ' menit';
    if (m === 0) return h + ' jam';
    return h + ' jam ' + m + ' menit';
  };

  // HANYA sesi AKTIF (meja sedang berjalan). Total belanja berjalan
  // = SUM subtotal dari `pesanan_meja` per session_id (item F&B yang
  // sudah di-order sebelum checkout).
  db.all(
    `SELECT sm.id,
            sm.session_id,
            sm.nomor_meja,
            sm.nama_pemesan,
            sm.waktu_mulai,
            sm.status,
            sm.durasi_jam,
            COALESCE((
              SELECT SUM(pm.subtotal)
              FROM pesanan_meja pm
              WHERE pm.session_id = sm.session_id
            ), 0) AS total_pesanan
     FROM sesi_meja sm
     WHERE sm.status = 'AKTIF'
       AND date(sm.waktu_mulai, 'localtime') = date(?, 'localtime')
     ORDER BY sm.waktu_mulai DESC`,
    [dateParam],
    (err, rows) => {
      if (err) {
        res.write(JSON.stringify({ success: false, message: 'Gagal membaca sesi meja: ' + err.message }));
        return res.end();
      }

      const data = (rows || []).map(r => ({
        id: r.id,
        session_id: r.session_id,
        nomor_meja: r.nomor_meja,
        nama_pemesan: r.nama_pemesan || '—',
        waktu_mulai: r.waktu_mulai,
        status: r.status,
        durasi_jam: Number(r.durasi_jam) || 0,
        total_durasi: formatDurasi((Number(r.durasi_jam) || 0) * 60),
        total_pesanan: Number(r.total_pesanan) || 0,
      }));

      // Ringkasan khusus meja aktif
      const totalMejaAktifSekarang = data.length;
      const totalBelanjaBerjalan = data.reduce((s, r) => s + r.total_pesanan, 0);

      res.end(JSON.stringify({
        success: true,
        date: dateParam,
        totalMejaAktifSekarang,
        totalBelanjaBerjalan,
        summary: {
          totalMejaAktifSekarang,
          totalBelanjaBerjalan,
        },
        data: data,
      }));
    }
  );
}

// ── API: GET /api/admin/stock-opname/losses?month=YYYY-MM ──────
// Detail kerugian (barang minus) stock opname per produk, dipakai
// modal "Detail Kerugian Stock Opname" di dashboard admin.
// Skema riil (Fix #14): stock_opname(so_id, kategori, tanggal,
// total_minus, total_kerugian, ...) & stock_opname_detail(so_id,
// id_barang, nama_barang, jumlah_barang_aktual, jumlah_hasil_so,
// selisih_barang, kerugian_hpp, local_master_barang_id).
function handleAdminStockOpnameLosses(req, res, parsedUrl) {
  const json = (code, payload) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  };

  const queryMonth = (parsedUrl && parsedUrl.query && parsedUrl.query.month) || '';
  // Validasi YYYY-MM; fallback ke bulan berjalan lokal bila kosong/invalid
  const monthParam = /^\d{4}-\d{2}$/.test(queryMonth)
    ? queryMonth
    : `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;

  // Detail minus (selisih_barang < 0) pada bulan terpilih, per produk.
  // Stok sistem per SO = jumlah_hasil_so (hasil hitung SO), stok fisik
  // = jumlah_barang_aktual (hasil fisik). HPP diambil dari master_barang
  // saat ini — detail tidak menyimpan harga modal (lihat Fix #8/#14).
  db.all(
    `SELECT d.id_barang,
            COALESCE(NULLIF(d.nama_barang, 'Barang Tanpa Nama'), m.nama, d.nama_barang) AS nama_barang,
            m.id AS id_master,
            m.kategori,
            COALESCE(m.hpp, 0) AS hpp,
            d.jumlah_hasil_so AS stok_sistem,
            d.jumlah_barang_aktual AS stok_fisik,
            -d.selisih_barang AS qty_minus,
            d.kerugian_hpp
     FROM stock_opname_detail d
     JOIN stock_opname h ON h.so_id = d.so_id
     LEFT JOIN master_barang m ON m.id_barang = d.id_barang
     WHERE d.selisih_barang < 0
       AND strftime('%Y-%m', date(h.tanggal)) = ?`,
    [monthParam],
    (err, rows) => {
      if (err) {
        return json(500, { success: false, message: 'Gagal membaca stock opname: ' + err.message });
      }

      // Agregasi per produk: satu produk bisa minus di beberapa SO /
      // revisi bulan yang sama — jumlahkan selisih & kerugiannya
      const byProduct = new Map();
      for (const r of (rows || [])) {
        const key = String(r.id_master ?? '') + '::' + String(r.id_barang ?? '');
        const qty = Number(r.qty_minus) || 0;
        const rugi = Number(r.kerugian_hpp) || 0;
        const hpp = Number(r.hpp) || 0;
        const prev = byProduct.get(key);
        if (!prev) {
          byProduct.set(key, {
            id_barang: r.id_master || null,
            kode_barang: r.id_barang || null,
            nama_barang: r.nama_barang,
            kategori: r.kategori || null,
            stok_sistem: Number(r.stok_sistem) || 0,
            stok_fisik: Number(r.stok_fisik) || 0,
            hpp,
            qty_minus: 0,
            total_kerugian: 0,
          });
        }
        const item = byProduct.get(key);
        item.stok_sistem += Number(r.stok_sistem) || 0;
        item.stok_fisik += Number(r.stok_fisik) || 0;
        item.qty_minus += qty;
        // HPP per unit bisa kosong — fallback hitung kerugian dari HPP
        item.total_kerugian += rugi || qty * hpp;
      }

      const data = [...byProduct.values()];
      const totalUnitMinus = data.reduce((s, r) => s + r.qty_minus, 0);
      const totalNominalKerugian = data.reduce((s, r) => s + r.total_kerugian, 0);

      json(200, {
        success: true,
        month: monthParam,
        summary: {
          totalJenisBarangMinus: data.length,
          totalUnitMinus: totalUnitMinus,
          totalNominalKerugian: totalNominalKerugian,
        },
        data,
      });
    }
  );
}

// ── API: GET /api/admin/stock-opname/surplus?month=YYYY-MM ─────
// Detail kelebihan (barang plus) stock opname per produk — kembaran
// `handleAdminStockOpnameLosses` dengan filter `selisih_barang > 0`.
// Nilai plus = jumlah_plus × HPP saat ini (detail tidak menyimpan
// harga modal — Fix #8/#14). HPP diambil per-baris lalu diakumulasi
// agar revisi SO di bulan yang sama tetap memakai HPP saat SO itu.
function handleAdminStockOpnameSurplus(req, res, parsedUrl) {
  const json = (code, payload) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  };

  const queryMonth = (parsedUrl && parsedUrl.query && parsedUrl.query.month) || '';
  // Validasi YYYY-MM; fallback ke bulan berjalan lokal bila kosong/invalid
  const monthParam = /^\d{4}-\d{2}$/.test(queryMonth)
    ? queryMonth
    : `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;

  db.all(
    `SELECT d.id_barang,
            COALESCE(NULLIF(d.nama_barang, 'Barang Tanpa Nama'), m.nama, d.nama_barang) AS nama_barang,
            m.id AS id_master,
            m.kategori,
            COALESCE(m.hpp, 0) AS hpp,
            d.jumlah_hasil_so AS stok_sistem,
            d.jumlah_barang_aktual AS stok_fisik,
            d.selisih_barang AS qty_plus
     FROM stock_opname_detail d
     JOIN stock_opname h ON h.so_id = d.so_id
     LEFT JOIN master_barang m ON m.id_barang = d.id_barang
     WHERE d.selisih_barang > 0
       AND strftime('%Y-%m', date(h.tanggal)) = ?`,
    [monthParam],
    (err, rows) => {
      if (err) {
        return json(500, { success: false, message: 'Gagal membaca stock opname: ' + err.message });
      }

      // Agregasi per produk: satu produk bisa plus di beberapa SO /
      // revisi bulan yang sama — jumlahkan selisih & nilainya
      const byProduct = new Map();
      for (const r of (rows || [])) {
        const key = String(r.id_master ?? '') + '::' + String(r.id_barang ?? '');
        const qty = Number(r.qty_plus) || 0;
        const hpp = Number(r.hpp) || 0;
        if (!byProduct.has(key)) {
          byProduct.set(key, {
            id_barang: r.id_master || null,
            kode_barang: r.id_barang || null,
            nama_barang: r.nama_barang,
            kategori: r.kategori || null,
            stok_sistem: 0,
            stok_fisik: 0,
            hpp,
            qty_plus: 0,
            total_nilai_plus: 0,
          });
        }
        const item = byProduct.get(key);
        item.stok_sistem += Number(r.stok_sistem) || 0;
        item.stok_fisik += Number(r.stok_fisik) || 0;
        item.qty_plus += qty;
        item.total_nilai_plus += qty * hpp;
      }

      const data = [...byProduct.values()];
      const totalUnitPlus = data.reduce((s, r) => s + r.qty_plus, 0);
      const totalNominalPlus = data.reduce((s, r) => s + r.total_nilai_plus, 0);

      json(200, {
        success: true,
        month: monthParam,
        summary: {
          totalJenisBarangPlus: data.length,
          totalUnitPlus: totalUnitPlus,
          totalNominalPlus: totalNominalPlus,
        },
        data,
      });
    }
  );
}

// ── API: GET /api/admin/cash-flow?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD&type=ALL|MASUK|KELUAR
// Riwayat kas laci (uang masuk & keluar) per RENTANG tanggal, dipakai
// modal "Riwayat Kas Laci" di dashboard admin.
// Parameter:
//   startDate / endDate : rentang (default: tanggal 1 bulan berjalan s/d hari ini,
//                         semua zona waktu lokal)
//   date                : fallback legacy — bila dikirim, startDate & endDate
//                         sama-sama di-set ke tanggal ini
//   type                : filter tampilan MASUK / KELUAR (agregat selalu semua tipe)
// Skema riil (Fix #20 audit DDL): seluruh aliran kas tercatat di
// `kas_laci_transaksi(id, transaction_id, jenis, nominal, keterangan,
// kasir, waktu, kode_setoran)` — jenis: UANG_MASUK / UANG_KELUAR.
// Tabel `kas_masuk` & `kas_keluar` SKEMA ada tapi KOSONG (0 baris),
// jadi sumber data tunggal = kas_laci_transaksi.
// `netKasPeriod` = totalKasMasuk - totalKasKeluar untuk rentang terpilih.
// `saldoAkhirPeriode` dipertahankan dari versi lama (aproksimasi saldo
// kas laci terkini dikurangi seluruh aliran SETELAH rentang terpilih).
function handleAdminCashFlow(req, res, parsedUrl) {
  const json = (code, payload) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  };

  const q = (parsedUrl && parsedUrl.query) || {};
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;

  const localTodayYMD = () => {
    const n = new Date();
    return n.getFullYear() + '-' +
      String(n.getMonth() + 1).padStart(2, '0') + '-' +
      String(n.getDate()).padStart(2, '0');
  };
  const localMonthStartYMD = () => {
    const n = new Date();
    return n.getFullYear() + '-' +
      String(n.getMonth() + 1).padStart(2, '0') + '-01';
  };

  // Fallback legacy ?date= : bila ada, jadi awal & akhir rentang sama
  const legacyDate = dateRe.test(q.date || '') ? q.date : '';
  const startDate = dateRe.test(q.startDate || '')
    ? q.startDate
    : (legacyDate || localMonthStartYMD());
  const endDate = dateRe.test(q.endDate || '')
    ? q.endDate
    : (legacyDate || localTodayYMD());

  const queryType = String(q.type || 'ALL').toUpperCase();
  const typeParam = ['MASUK', 'KELUAR'].includes(queryType) ? queryType : 'ALL';

  db.all(
    `SELECT id,
            transaction_id AS kode_transaksi,
            CASE jenis WHEN 'UANG_MASUK' THEN 'MASUK' ELSE 'KELUAR' END AS tipe,
            COALESCE(NULLIF(keterangan, ''), jenis, '—') AS kategori,
            nominal,
            COALESCE(NULLIF(keterangan, ''), '-') AS keterangan,
            kasir,
            waktu
     FROM kas_laci_transaksi
     WHERE date(waktu, 'localtime') >= date(?, 'localtime')
       AND date(waktu, 'localtime') <= date(?, 'localtime')
     ORDER BY waktu DESC, id DESC`,
    [startDate, endDate],
    (err, rows) => {
      if (err) {
        return json(500, { success: false, message: 'Gagal membaca kas laci: ' + err.message });
      }

      const allRows = (rows || []).map(r => ({
        id: r.id,
        kode_transaksi: r.kode_transaksi,
        tipe: r.tipe,
        kategori: r.kategori,
        nominal: Number(r.nominal) || 0,
        keterangan: r.keterangan,
        kasir: r.kasir || '—',
        waktu: r.waktu,
      }));

      const data = typeParam === 'ALL'
        ? allRows
        : allRows.filter(r => r.tipe === typeParam);

      // Agregat untuk RENTANG TERPILIH (semua tipe, tak peduli filter UI)
      const totalKasMasuk = allRows.filter(r => r.tipe === 'MASUK')
        .reduce((s, r) => s + r.nominal, 0);
      const totalKasKeluar = allRows.filter(r => r.tipe === 'KELUAR')
        .reduce((s, r) => s + r.nominal, 0);
      const netKasPeriod = totalKasMasuk - totalKasKeluar;

      // Saldo laci terkini = saldo_awal_config + Σ seluruh aliran
      db.get(
        `SELECT COALESCE((SELECT saldo_awal FROM kas_laci_config LIMIT 1), 0)
               + COALESCE((SELECT SUM(CASE WHEN jenis = 'UANG_MASUK' THEN nominal
                                           ELSE -nominal END)
                           FROM kas_laci_transaksi), 0) AS saldo`,
        [],
        (err2, saldoRow) => {
          if (err2) {
            return json(500, { success: false, message: 'Gagal hitung saldo kas: ' + err2.message });
          }
          const saldoKasTerkini = Number(saldoRow ? saldoRow.saldo : 0) || 0;
          // Aliran SETELAH endDate (lintas-tanggal) dari riwayat laci
          db.get(
            `SELECT COALESCE(SUM(CASE WHEN jenis = 'UANG_MASUK' THEN nominal
                                     ELSE -nominal END), 0) AS s
             FROM kas_laci_transaksi
             WHERE date(waktu, 'localtime') > date(?, 'localtime')`,
            [endDate],
            (err3, afterRow) => {
              if (err3) {
                return json(500, { success: false, message: 'Gagal hitung aliran: ' + err3.message });
              }
              const afterSel = Number(afterRow ? afterRow.s : 0) || 0;
              const saldoAkhirPeriode = saldoKasTerkini - afterSel;

              json(200, {
                success: true,
                startDate,
                endDate,
                summary: {
                  totalKasMasuk,
                  totalKasKeluar,
                  netKasPeriod,
                  saldoAkhirPeriode,
                },
                data,
              });
            }
          );
        }
      );
    }
  );
}

// ── API: GET /api/admin/cashier-deposits?date=YYYY-MM-DD ────────
// Rekapitulasi setoran & omzet per kasir untuk tanggal terpilih
// (default hari ini, localtime). Sumber data: tabel transaksi riil
// (Fix #21 audit DDL) — kolom per-baris cash_amount & qris_amount
// sudah terisi saat transaksi dibuat. Metode pembayaran aktual:
// CASH / QRIS / CASH+QRIS / GRATIS — tidak ada metode TRANSFER di
// skema riil, jadi omzet_transfer = 0 dan pembayaran digital
// direpresentasikan penuh oleh kolom qris_amount. Setoran tunai wajib
// kasir = total cash_amount (uang tunai yang diterima kasir,
// diserahkan ke pemilik saat closing).
function handleAdminCashierDeposits(req, res, parsedUrl) {
  const json = (code, payload) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  };

  const queryDate = (parsedUrl && parsedUrl.query && parsedUrl.query.date) || '';
  const dateParam = /^\d{4}-\d{2}-\d{2}$/.test(queryDate)
    ? queryDate
    : new Date().toISOString().slice(0, 10);

  db.all(
    `SELECT kasir,
            COUNT(*)                                    AS total_transaksi,
            COALESCE(SUM(cash_amount), 0)               AS omzet_tunai,
            COALESCE(SUM(qris_amount), 0)               AS omzet_qris,
            COALESCE(SUM(CASE WHEN metode_pembayaran LIKE '%TRANSFER%'
                              THEN total ELSE 0 END), 0) AS omzet_transfer,
            COALESCE(SUM(total), 0)                     AS total_omzet
     FROM transaksi
     WHERE date(tanggal) = date(?)
       AND tipe_transaksi = 'PENJUALAN'
     GROUP BY kasir
     ORDER BY total_omzet DESC, kasir ASC`,
    [dateParam],
    (err, rows) => {
      if (err) {
        return json(500, { success: false, message: 'Gagal membaca rekap setoran kasir: ' + err.message });
      }

      const data = (rows || []).map(r => ({
        kasir: r.kasir || '—',
        total_transaksi: Number(r.total_transaksi) || 0,
        omzet_tunai: Number(r.omzet_tunai) || 0,
        omzet_qris: Number(r.omzet_qris) || 0,
        omzet_transfer: Number(r.omzet_transfer) || 0,
        total_omzet: Number(r.total_omzet) || 0,
      }));

      const totalSetoranTunai = data.reduce((s, r) => s + r.omzet_tunai, 0);
      const totalNonTunai = data.reduce((s, r) => s + r.omzet_qris + r.omzet_transfer, 0);
      const totalOmzetKeseluruhan = data.reduce((s, r) => s + r.total_omzet, 0);

      json(200, {
        success: true,
        date: dateParam,
        summary: {
          totalSetoranTunai,
          totalNonTunai,
          totalOmzetKeseluruhan,
        },
        data,
      });
    }
  );
}

// ── API: GET /api/admin/members?search=...&kategori=ALL|PELAJAR|UMUM|PLATINUM
// Daftar member + statistik kunjungan & total belanja, dipakai modal
// "Daftar Member & Riwayat Setia" di dashboard admin.
// Skema riil (Fix #23 audit DDL):
//  - `member(id, kode_member, nama, nomor_hp, kategori_id, tanggal_daftar, ...)`
//    — kategori member TIDAK berupa kolom di `member`, melainkan relasi
//    `kategori_id` → `member_kategori(id, nama)` berisi
//    PELAJAR / UMUM / PLATINUM. Bila kategori_id NULL/terhapus →
//    COALESCE ke 'UMUM' (kategori member terlemah; sentinel "bukan
//    member" di sistem ini = NULL, bukan string 'UMUM' — Fix #11).
//  - `transaksi.member_id` menyimpan KODE member (string, mis.
//    'PLT-0018'), BUKAN id numerik — JOIN via t.member_id = m.kode_member.
//  - `transaksi.tipe_transaksi`: seluruh 2296 baris = 'PENJUALAN',
//    tapi filter tetap disertakan agar aman bila tipe baru muncul.
// `total_kunjungan` = COUNT DISTINCT transaksi PENJUALAN milik member
// (live dari `transaksi` — kolom `member.total_kunjungan` riil
// 92 member terisi vs 92 dari JOIN, selisih 2 baris karena cache
// tidak selalu sinkron dengan transaksi live).
// `summary` dihitung dari data yang sudah di-fetch, bukan query
// terpisah: totalMember = jumlah baris, totalBelanjaSemuaMember =
// Σ total_belanja, per-kategori di-count dari kolom `kategori`.
// Filter kategori di-client (139 baris — ringan) agar 1 fetch =
// semua varian filter UI.
// Normalisasi nomor_hp (Fix #24): data riil masih menyimpan nomor
// tanpa awalan '0' (mis. '83129044688') — kolom di-map dengan
// helper formatNoHP agar API konsisten menampilkan '083129044688'
// dan pencarian '?search=0811' tetap cocok dengan data lama '811...'.
// Data DB TIDAK diubah — normalisasi hanya di layer presentasi.
function formatNoHP(no) {
  if (!no) return '-';
  const str = String(no).trim();
  if (str.startsWith('8')) return '0' + str;
  return str;
}
function handleAdminMembers(req, res, parsedUrl) {
  const json = (code, payload) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  };

  db.all(
    `SELECT m.id,
            m.kode_member,
            m.nama,
            m.nomor_hp,
            COALESCE(k.nama, 'UMUM')   AS kategori,
            m.tanggal_daftar,
            m.status,
            COUNT(DISTINCT t.id)      AS total_kunjungan,
            COALESCE(SUM(t.total), 0) AS total_belanja
     FROM member m
     LEFT JOIN member_kategori k ON k.id = m.kategori_id
     LEFT JOIN transaksi t ON t.member_id = m.kode_member
                          AND t.tipe_transaksi = 'PENJUALAN'
     GROUP BY m.id
     ORDER BY total_belanja DESC, total_kunjungan DESC`,
    [],
    (err, rows) => {
      if (err) {
        return json(500, { success: false, message: 'Gagal membaca daftar member: ' + err.message });
      }

      const q = (parsedUrl && parsedUrl.query) || {};
      const search = String(q.search || '').trim().toLowerCase();
      const kategoriParam = String(q.kategori || 'ALL').toUpperCase();
      const kategoriValid = ['ALL', 'PELAJAR', 'UMUM', 'PLATINUM'].includes(kategoriParam)
        ? kategoriParam
        : 'ALL';

      const data = (rows || []).map(r => {
        const nomorHp = formatNoHP(r.nomor_hp); // normalisasi tampilan (Fix #24)
        return {
          id: Number(r.id),
          kode_member: r.kode_member || '—',
          nama: r.nama || '—',
          nomor_hp: nomorHp,
          kategori: r.kategori,
          tanggal_daftar: r.tanggal_daftar ? String(r.tanggal_daftar).slice(0, 10) : '—',
          status: r.status || '—',
          total_kunjungan: Number(r.total_kunjungan) || 0,
          total_belanja: Number(r.total_belanja) || 0,
        };
      }).filter(r => {
        // Cari di nomor_hp NORMAL (dengan '0' di depan) agar ?search=0811
        // tetap menemukan data lama yang tersimpan '811...' (Fix #24)
        const hpNormal = formatNoHP(r.nomor_hp).toLowerCase();
        const matchSearch = !search
          || r.nama.toLowerCase().includes(search)
          || r.kode_member.toLowerCase().includes(search)
          || hpNormal.includes(search);
        const matchKategori = kategoriValid === 'ALL'
          || String(r.kategori).toUpperCase() === kategoriValid;
        return matchSearch && matchKategori;
      });

      // Aggregat dari data ter-filter (sesuai spesifikasi: ringkasan
      // mengikuti filter UI, bukan seluruh tabel member)
      const totalBelanjaSemuaMember = data.reduce((s, r) => s + r.total_belanja, 0);
      const countKategori = (k) => data.filter(r => r.kategori === k).length;

      json(200, {
        success: true,
        search: search || null,
        kategori: kategoriValid,
        summary: {
          totalMember: data.length,
          totalPelajar: countKategori('PELAJAR'),
          totalUmum: countKategori('UMUM'),
          totalPlatinum: countKategori('PLATINUM'),
          totalBelanjaSemuaMember,
        },
        data,
      });
    }
  );
}

// ── API: DELETE /api/admin/member/:id ────────────────────────────
// Hapus member dari panel admin — dipakai tombol aksi Hapus di
// modal "Daftar Member & Riwayat Setia" (Fix #23/#27).
// Batasannya SEMPIT: hanya `DELETE FROM member WHERE id = ?`.
// Riwayat omzet/transaksi AMAN: `transaksi.member_id` &
// `sesi_meja.member_id` menyimpan KODE member string (mis.
// 'PLT-0018'), BUKAN FK numerik ke `member.id` (Fix #23 audit DDL)
// — menghapus baris `member` tidak merusak/menghapus data historis
// penjualan mana pun. `member_cache` (cache kasir, Fix #11 pola)
// sengaja TIDAK disentuh — sinkronisasi cache adalah domain
// server kasir, bukan panel admin.
function handleAdminDeleteMember(req, res, memberId) {
  const json = (code, payload) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  };

  const id = Number(memberId);
  if (!Number.isInteger(id) || id <= 0) {
    return json(400, { success: false, message: 'ID member tidak valid' });
  }

  // 1. Cek keberadaan dulu — 404 bila tak ada (sesuai spesifikasi)
  db.get(
    `SELECT id, kode_member, nama FROM member WHERE id = ? LIMIT 1`,
    [id],
    (err, row) => {
      if (err) return json(500, { success: false, message: 'Gagal membaca member: ' + err.message });
      if (!row) return json(404, { success: false, message: 'Member tidak ditemukan' });

      // 2. Eksekusi hapus
      db.run(
        `DELETE FROM member WHERE id = ?`,
        [id],
        (err2) => {
          if (err2) return json(500, { success: false, message: 'Gagal menghapus member: ' + err2.message });

          // 3. Log penghapusan (audit trail)
          console.log(`[ADMIN] MEMBER_DELETED id=${row.id} kode=${row.kode_member} nama=${row.nama} oleh Admin (DELETE /api/admin/member/${id})`);

          json(200, {
            success: true,
            message: `Member ${row.kode_member} - ${row.nama} berhasil dihapus`,
          });
        }
      );
    }
  );
}

// ── API: GET /api/admin/qris/summary ─────────────────────────────
// Statistik transaksi QRIS: omzet hari ini, jumlah transaksi hari
// ini, omzet kumulatif bulan ini (tgl 1 s/d hari ini), dan jumlah
// transaksi ber-status PENDING dalam rentang bulan berjalan.
// Skema riil (Fix #25 audit DDL):
//  - `metode_pembayaran` berisi CASH / QRIS / CASH+QRIS / GRATIS —
//    filter QRIS memakai UPPER(metode) LIKE '%QRIS%' agar menangkap
//    QRIS murni MAUPUN CASH+QRIS (campur) — konsisten Fix #21.
//  - Kolom `status_qris` ('TERVERIFIKASI'|'PENDING'|'BATAL', default
//    TERVERIFIKASI) & `no_ref_qris` ditambahkan via migrasi Fix #25.
//  - Zona waktu lokal (WITA, UTC+8): helper localYMD()/localMonthStartYMD
//    + date(..., 'localtime') pada SQL — BUKAN toISOString() UTC
//    (pitfall zona waktu, Fix #20).
function handleAdminQrisSummary(req, res) {
  const json = (code, payload) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  };

  const localYMD = () => {
    const n = new Date();
    return n.getFullYear() + '-' +
      String(n.getMonth() + 1).padStart(2, '0') + '-' +
      String(n.getDate()).padStart(2, '0');
  };
  const localMonthStartYMD = () => {
    const n = new Date();
    return n.getFullYear() + '-' +
      String(n.getMonth() + 1).padStart(2, '0') + '-01';
  };

  const today = localYMD();
  const monthStart = localMonthStartYMD();

  // Fix #31:
  // (1) date(tanggal) langsung tanpa modifier 'localtime' — kolom tanggal
  //     sudah disimpan sebagai string lokal YYYY-MM-DD HH:MM:SS; membandingkan
  //     date(tanggal,'localtime') = date(?,'localtime') menghasilkan
  //     perbandingan string-locale yang bisa salah kalau sistem di non-UTC.
  // (2) Filter status_qris TERVERIFIKASI eksplisit (bukan hanya LIKE '%QRIS%'):
  //     PENDING & BATAL harus dikecualikan dari omzet (sebelumnya semua baris
  //     QRIS termasuk pending dihitung omzet).
  // (3) COALESCE(SUM(CASE ...)) untuk menghitung omzet QRIS:
  //     - qris_amount > 0 → pakai qris_amount (urutan riil dari metode campur)
  //     - metode murni QRIS → pakai total
  //     - CASH+QRIS tak terisi qris_amount → 0 (tidak salah hitung)
  //     SUM(total) sebelumnya over-count: baris CASH+QRIS total = cash+qris,
  //     padahal omzet QRIS hanya bagian qris_amount.

  // Query 1: hari ini (count + omzet QRIS terverifikasi)
  db.get(
    `SELECT
       COUNT(*) AS cnt,
       COALESCE(SUM(
         CASE
           WHEN qris_amount > 0 THEN qris_amount
           WHEN UPPER(metode_pembayaran) = 'QRIS' THEN total
           ELSE 0
         END
       ), 0) AS omzet
     FROM transaksi
     WHERE (UPPER(metode_pembayaran) LIKE '%QRIS%' OR qris_amount > 0)
       AND UPPER(COALESCE(status_qris, 'TERVERIFIKASI')) = 'TERVERIFIKASI'
       AND date(tanggal) = date(?)`,
    [today],
    (err, row) => {
      if (err) return json(500, { success: false, message: 'Gagal membaca QRIS: ' + err.message });
      const countHariIni = Number(row.cnt) || 0;
      const omzetHariIni = Number(row.omzet) || 0;

      // Query 2: bulan berjalan (omzet terverifikasi + pending)
      db.get(
        `SELECT
           COALESCE(SUM(
             CASE
               WHEN UPPER(COALESCE(status_qris, 'TERVERIFIKASI')) = 'TERVERIFIKASI'
                THEN (CASE
                       WHEN qris_amount > 0 THEN qris_amount
                       WHEN UPPER(metode_pembayaran) = 'QRIS' THEN total
                       ELSE 0
                     END)
               ELSE 0
             END
           ), 0) AS omzetBulan,
           COALESCE(SUM(
             CASE
               WHEN UPPER(COALESCE(status_qris, 'TERVERIFIKASI')) = 'PENDING'
                THEN 1 ELSE 0
             END
           ), 0) AS cntPending
         FROM transaksi
         WHERE (UPPER(metode_pembayaran) LIKE '%QRIS%' OR qris_amount > 0)
           AND date(tanggal) >= ?
           AND date(tanggal) <= ?`,
        [monthStart, today],
        (err2, row2) => {
          if (err2) return json(500, { success: false, message: 'Gagal membaca QRIS: ' + err2.message });
          const r2 = row2 || {};
          json(200, {
            success: true,
            total_hari_ini: omzetHariIni,
            count_hari_ini: countHariIni,
            total_bulan_ini: Number(r2.omzetBulan) || 0,
            total_pending: Number(r2.cntPending) || 0,
          });
        }
      );
    }
  );
}

// ── API: SALDO BANK & VERIFIKASI SETORAN (Fix #34) ───────────────
// Basis data: `shift_kasir` — tiap penutupan shift kasir menghasilkan
// satu baris ber-`kode_tutup` unik. Kolom `status_bank` (PENDING|DISETOR),
// `deposited_at`, `deposited_by` ditambahkan via migrasi di atas.
//
// Filter valid untuk rekap bank:
//   - kode_tutup tidak null/empty (shift yang benar-benar ditutup)
//   - status IN ('CLOSED','PENDING_CLOSE') — ARCHIVED & OPEN dikecualikan
//   - PENDING_CLOSE = shift masih menunggu konfirm closing final;
//     tetap dihitung sebagai setoran bank (kasir sudah menyerahkan uang)

// GET /api/admin/bank/summary
// Saldo bank saat ini (DISETOR) + total & jumlah pending.
function handleAdminBankSummary(req, res) {
  const json = (code, payload) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  };

  db.all(
    `SELECT
       COALESCE(SUM(CASE WHEN status_bank = 'DISETOR'  THEN nominal_aktual ELSE 0 END), 0) AS saldoBank,
       COALESCE(SUM(CASE WHEN status_bank = 'PENDING' THEN nominal_aktual ELSE 0 END), 0) AS totalPending,
       COALESCE(SUM(CASE WHEN status_bank = 'PENDING' THEN 1 ELSE 0 END), 0)              AS countPending
     FROM shift_kasir
     WHERE kode_tutup IS NOT NULL AND kode_tutup != ''
       AND status IN ('CLOSED', 'PENDING_CLOSE')`,
    [],
    (err, rows) => {
      if (err) return json(500, { success: false, message: 'Gagal membaca saldo bank: ' + err.message });
      const r = (rows && rows[0]) || {};
      json(200, {
        success: true,
        saldo_bank_saat_ini: Number(r.saldoBank) || 0,
        total_pending_setoran: Number(r.totalPending) || 0,
        count_pending: Number(r.countPending) || 0,
      });
    }
  );
}

// GET /api/admin/bank/pending-deposits
// Daftar setoran tutup kasir berstatus PENDING (menunggu konfirmasi bank).
function handleAdminBankPendingDeposits(req, res, parsedUrl) {
  const json = (code, payload) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  };

  db.all(
    `SELECT s.id,
            s.kode_tutup AS kode_unik,
            date(s.tutup_at) AS tanggal,
            COALESCE(k.nama, CAST(s.kasir_id AS TEXT)) AS kasir,
            s.nominal_aktual AS nominal_setoran
     FROM shift_kasir s
     LEFT JOIN kasir k ON k.id = s.kasir_id
     WHERE s.kode_tutup IS NOT NULL AND s.kode_tutup != ''
       AND s.status IN ('CLOSED', 'PENDING_CLOSE')
       AND COALESCE(s.status_bank, 'PENDING') = 'PENDING'
     ORDER BY date(s.tutup_at) DESC`,
    [],
    (err, rows) => {
      if (err) return json(500, { success: false, message: 'Gagal membaca setoran pending: ' + err.message });
      const data = (rows || []).map(r => ({
        id: Number(r.id),
        kode_unik: r.kode_unik,
        tanggal: r.tanggal || '—',
        kasir: r.kasir,
        nominal_setoran: Number(r.nominal_setoran) || 0,
      }));
      const totalPending = data.reduce((s, r) => s + r.nominal_setoran, 0);
      json(200, {
        success: true,
        count: data.length,
        total_pending: totalPending,
        data,
      });
    }
  );
}

// POST /api/admin/bank/process-deposit
// Body: { kode_unik_list: ["VH5EG4","2K3DJ8",...], admin_name: "Administrator Utama" }
// Ubah status_bank PENDING → DISETOR + catat deposited_at & deposited_by.
// Fix #36: proteksi re-input validasi server — sebelum UPDATE, cek
// status_bank per kode; jika sudah DISETOR → masukkan ke daftar
// `already_deposited` dan JANGAN di-update ulang (idempotent eksplisit).
function handleAdminBankProcessDeposit(req, res) {
  const json = (code, payload) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  };

  let body = '';
  req.on('data', chunk => { body += chunk; if (body.length > 102400) req.destroy(); });
  req.on('end', () => {
    let payload;
    try { payload = JSON.parse(body || '{}'); }
    catch (e) { return json(400, { success: false, message: 'JSON body tidak valid' }); }

    const kodeList = Array.isArray(payload.kode_unik_list) ? payload.kode_unik_list : [];
    const adminName = String(payload.admin_name || 'admin').trim() || 'admin';

    if (!kodeList.length) {
      return json(400, { success: false, message: 'kode_unik_list kosong' });
    }

    // Batas aman: maksimal 50 kode per request
    const list = kodeList.slice(0, 50).map(k => String(k).trim().toUpperCase()).filter(Boolean);
    const now = new Date().toISOString();

    // Fase 1: audit status per kode (Fix #36) — kode yang sudah DISETOR
    // dilaporkan eksplisit, tidak di-update ulang.
    let processedCount = 0;
    let notFound = [];
    const alreadyDeposited = {}; // kode → { deposited_at, deposited_by }
    let remainingChecks = 0;

    const proceedUpdate = () => {
      // Fase 2: update hanya kode yang belum DISETOR
      const toUpdate = list.filter(k => !(k in alreadyDeposited) && !notFound.includes(k));
      if (!toUpdate.length) {
        // Semua kode sudah DISETOR atau tak ditemukan
        const msg = Object.keys(alreadyDeposited).length
          ? 'Kode ' + Object.keys(alreadyDeposited).join(', ') + ' sudah pernah disetor sebelumnya'
          : 'Tidak ada kode yang dapat diproses';
        if (Object.keys(alreadyDeposited).length) {
          return json(409, {
            success: false,
            already_deposited: alreadyDeposited,
            not_found: notFound,
            message: msg,
          });
        }
        return json(400, { success: false, not_found: notFound, message: msg });
      }

      let remaining = 0;
      let errors = [];
      toUpdate.forEach((k) => {
        const stmt = db.prepare(
          `UPDATE shift_kasir
           SET status_bank = 'DISETOR',
               deposited_at = ?,
               deposited_by = ?
           WHERE kode_tutup = ?
             AND status IN ('CLOSED','PENDING_CLOSE')
             AND COALESCE(status_bank, 'PENDING') = 'PENDING'`
        );
        remaining++;
        stmt.run([now, adminName, k], (err2, info) => {
          if (err2) errors.push(k + ': ' + err2.message);
          else if (info && info.changes > 0) processedCount++;
          stmt.finalize();
          if (--remaining === 0) {
            if (errors.length) {
              return json(409, {
                success: false,
                message: 'Sebagian kode gagal: ' + errors.join('; '),
                processed: processedCount,
                failed: errors,
                already_deposited: alreadyDeposited,
                not_found: notFound,
              });
            }
            json(200, {
              success: true,
              processed: processedCount,
              already_deposited: alreadyDeposited,
              not_found: notFound,
              message: processedCount + ' kode unik berhasil dikonfirmasi setor bank'
                + (Object.keys(alreadyDeposited).length
                   ? ' (' + Object.keys(alreadyDeposited).length + ' sudah terlanjur disetor, dilewati)'
                   : ''),
            });
          }
        });
      });
    };

    if (!list.length) return proceedUpdate();
    list.forEach((k) => {
      remainingChecks++;
      db.get(
        `SELECT COALESCE(status_bank,'PENDING') AS st, deposited_at, deposited_by
         FROM shift_kasir
         WHERE kode_tutup = ?
           AND status IN ('CLOSED','PENDING_CLOSE')`,
        [k],
        (err2, row) => {
          if (!row) notFound.push(k);
          else if (row.st === 'DISETOR') {
            alreadyDeposited[k] = {
              deposited_at: row.deposited_at || '—',
              deposited_by: row.deposited_by || '—',
            };
          }
          if (--remainingChecks === 0) proceedUpdate();
        }
      );
    });
  });
}

// GET /api/admin/bank/check-code/:code  (Fix #36)
// Cek status satu kode unik sebelum konfirmasi setor.
// Sanitasi: code.trim().toUpperCase(). Respon 3 kasus:
//   1. tak ditemukan     → { success:false, is_found:false }
//   2. sudah DISETOR     → { success:false, is_found:true, is_deposited:true }
//   3. valid & pending    → { success:true,  is_found:true, is_deposited:false, data:{...} }
// `data` berisi rincian lengkap shift untuk card preview (Fix #36 C).
function handleAdminBankCheckCode(req, res, codeMatch) {
  const json = (code, payload) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  };

  const raw = String((codeMatch && codeMatch[1]) || '');
  const code = raw.trim().toUpperCase();
  if (!/^[A-Z0-9]{1,6}$/.test(code)) {
    return json(400, { success: false, is_found: false, message: 'Format kode unik tidak valid.' });
  }

  db.get(
    `SELECT s.id, s.kode_tutup, s.buka_at, s.tutup_at, s.status,
            s.nominal_aktual, s.saldo_awal, s.uang_laci,
            s.pending_close_snapshot,
            COALESCE(s.status_bank, 'PENDING') AS status_bank,
            s.deposited_at, s.deposited_by,
            COALESCE(k.nama, CAST(s.kasir_id AS TEXT)) AS kasir
     FROM shift_kasir s
     LEFT JOIN kasir k ON k.id = s.kasir_id
     WHERE s.kode_tutup = ?
       AND s.status IN ('CLOSED','PENDING_CLOSE')`,
    [code],
    (err, row) => {
      if (err) return json(500, { success: false, message: 'Gagal cek kode: ' + err.message });

      // Kasus 1: tak ditemukan
      if (!row) {
        return json(404, {
          success: false,
          is_found: false,
          is_deposited: false,
          message: 'Kode Unik tidak ditemukan di sistem closure kasir.',
        });
      }

      // Kasus 2: sudah pernah disetor
      if (row.status_bank === 'DISETOR') {
        return json(409, {
          success: false,
          is_found: true,
          is_deposited: true,
          message: 'Kode ini SUDAH DISETOR pada ' + (row.deposited_at || '—') +
                   ' oleh ' + (row.deposited_by || 'admin'),
          data: {
            id: Number(row.id),
            kode_tutup: row.kode_tutup,
            kasir: row.kasir,
            buka_at: row.buka_at,
            tutup_at: row.tutup_at,
            nominal_aktual: Number(row.nominal_aktual) || 0,
            saldo_awal: Number(row.saldo_awal) || 0,
            uang_laci: Number(row.uang_laci) || 0,
            pending_close_snapshot: row.pending_close_snapshot,
            status: row.status,
            status_bank: row.status_bank,
            deposited_at: row.deposited_at,
            deposited_by: row.deposited_by,
          },
        });
      }

      // Kasus 3: valid & masih pending
      json(200, {
        success: true,
        is_found: true,
        is_deposited: false,
        data: {
          id: Number(row.id),
          kode_tutup: row.kode_tutup,
          kasir: row.kasir,
          buka_at: row.buka_at,
          tutup_at: row.tutup_at,
          nominal_aktual: Number(row.nominal_aktual) || 0,
          saldo_awal: Number(row.saldo_awal) || 0,
          uang_laci: Number(row.uang_laci) || 0,
          pending_close_snapshot: row.pending_close_snapshot,
          status: row.status,
          status_bank: row.status_bank,
        },
      });
    }
  );
}

// GET /api/admin/bank/history
// Riwayat setoran yang sudah masuk bank (DISETOR), terbaru dulu.
// Fix #36 B: hanya baris status_bank='DISETOR', termasuk snapshot
// rekapitulasi penutupan kasir (detail drawer di frontend).
function handleAdminBankHistory(req, res, parsedUrl) {
  const json = (code, payload) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  };

  db.all(
    `SELECT s.id,
            s.kode_tutup AS kode_unik,
            date(s.tutup_at) AS tanggal_tutup,
            s.deposited_at AS tanggal_setor,
            COALESCE(k.nama, CAST(s.kasir_id AS TEXT)) AS kasir,
            s.nominal_aktual AS nominal_setoran,
            s.deposited_by AS diinput_oleh,
            s.buka_at, s.tutup_at, s.saldo_awal, s.uang_laci,
            s.pending_close_snapshot,
            'DISETOR' AS status
     FROM shift_kasir s
     LEFT JOIN kasir k ON k.id = s.kasir_id
     WHERE s.kode_tutup IS NOT NULL AND s.kode_tutup != ''
       AND s.status IN ('CLOSED', 'PENDING_CLOSE')
       AND s.status_bank = 'DISETOR'
     ORDER BY s.deposited_at DESC, s.id DESC
     LIMIT 200`,
    [],
    (err, rows) => {
      if (err) return json(500, { success: false, message: 'Gagal membaca riwayat bank: ' + err.message });
      // Fix #36: parse snapshot untuk detail drawer (ringkasan penjualan,
      // rekap produk, daftar transaksi, performa meja).
      const data = (rows || []).map(r => ({
        id: Number(r.id),
        kode_unik: r.kode_unik,
        tanggal_tutup: r.tanggal_tutup || '—',
        tanggal_setor: r.tanggal_setor || '—',
        kasir: r.kasir,
        nominal_setoran: Number(r.nominal_setoran) || 0,
        diinput_oleh: r.diinput_oleh || '—',
        status: r.status,
        // Data lengkap untuk detail drawer
        detail: {
          id: Number(r.id),
          kode_tutup: r.kode_unik,
          kasir: r.kasir,
          buka_at: r.buka_at,
          tutup_at: r.tutup_at,
          nominal_aktual: Number(r.nominal_setoran) || 0,
          saldo_awal: Number(r.saldo_awal) || 0,
          uang_laci: Number(r.uang_laci) || 0,
          pending_close_snapshot: r.pending_close_snapshot,
          deposited_at: r.tanggal_setor,
          deposited_by: r.diinput_oleh,
        },
      }));
      const totalHistory = data.reduce((s, r) => s + r.nominal_setoran, 0);
      json(200, {
        success: true,
        count: data.length,
        total_history: totalHistory,
        data,
      });
    }
  );
}

// ── API: GET /api/admin/reports/sales-chart?period=monthly_daily|last_30_days
// Data agregasi omzet penjualan harian untuk grafik batang dashboard admin.
// Parameter:
//   period : 'monthly_daily' (default) — tanggal 1 bulan berjalan s/d hari ini
//            'last_30_days'           — 30 hari terakhir (hari ini - 29 s/d hari ini)
// Respons:
//   labels[] : array string "DD Mon" (mis. "01 Oct")
//   data[]   : array integer omzet per label
//   summary  : { max_omzet, avg_omzet, total_omzet_period }
// Fix #33 — agregasi langsung dari DB (GROUP BY date), bukan dari cache client.

function handleAdminSalesChart(req, res, parsedUrl) {
  const json = (code, payload) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  };

  const q = (parsedUrl && parsedUrl.query) || {};
  const periodParam = String(q.period || 'monthly_daily');
  const validPeriods = ['monthly_daily', 'last_30_days'];
  const period = validPeriods.includes(periodParam) ? periodParam : 'monthly_daily';

  const n = new Date();
  const pad = (v) => String(v).padStart(2, '0');
  const todayYMD = n.getFullYear() + '-' + pad(n.getMonth() + 1) + '-' + pad(n.getDate());
  const monthStartYMD = n.getFullYear() + '-' + pad(n.getMonth() + 1) + '-01';

  // Hitung tanggal 30 hari lalu (hari ini - 29)
  const d30 = new Date(n);
  d30.setDate(d30.getDate() - 29);
  const d30YMD = d30.getFullYear() + '-' + pad(d30.getMonth() + 1) + '-' + pad(d30.getDate());

  const startDate = period === 'last_30_days' ? d30YMD : monthStartYMD;
  const endDate = todayYMD;

  db.all(
    `SELECT
       date(tanggal)                  AS tgl,
       COALESCE(SUM(total), 0)        AS total_omzet,
       COUNT(id)                       AS total_transaksi
     FROM transaksi
     WHERE date(tanggal) >= ?
       AND date(tanggal) <= ?
       AND UPPER(COALESCE(tipe_transaksi, 'PENJUALAN')) = 'PENJUALAN'
     GROUP BY date(tanggal)
     ORDER BY date(tanggal) ASC`,
    [startDate, endDate],
    (err, rows) => {
      if (err) {
        return json(500, { success: false, message: 'Gagal membaca grafik penjualan: ' + err.message });
      }

      // Susun array lengkap per-tanggal (isi 0 untuk tanggal kosong)
      const monthNames = ['Jan','Feb','Mar','Apr','Mei','Jun','Jul','Agu','Sep','Okt','Nov','Des'];
      const dayList = [];
      const d = new Date(startDate);
      const endD = new Date(endDate);
      while (d <= endD) {
        const ymd = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
        dayList.push({ ymd, label: pad(d.getDate()) + ' ' + monthNames[d.getMonth()] });
        d.setDate(d.getDate() + 1);
      }

      const rowByDay = {};
      for (const r of (rows || [])) {
        rowByDay[r.tgl] = r;
      }

      const labels = dayList.map(d => d.label);
      const data   = dayList.map(d => Number(rowByDay[d.ymd] ? rowByDay[d.ymd].total_omzet : 0));
      const counts = dayList.map(d => Number(rowByDay[d.ymd] ? rowByDay[d.ymd].total_transaksi : 0));

      const maxOmzet = Math.max(0, ...data);
      const totalPeriod = data.reduce((s, v) => s + v, 0);
      const avgOmzet = data.length ? Math.round(totalPeriod / data.length) : 0;

      json(200, {
        success: true,
        period,
        labels,
        data,
        counts,
        summary: {
          max_omzet: maxOmzet,
          avg_omzet: avgOmzet,
          total_omzet_period: totalPeriod,
        },
      });
    }
  );
}

// ── API: GET /api/admin/qris/history?startDate=&endDate=&search=&status=
// Riwayat transaksi QRIS per rentang tanggal, dipakai modal
// "Pencatatan & Riwayat QRIS" di dashboard admin.
// Parameter (Fix #25):
//   startDate / endDate : rentang (default: tgl 1 bulan berjalan s/d hari ini)
//   search              : cari di nomor_transaksi, kasir, atau no_ref_qris
//   status              : filter status_qris (ALL | TERVERIFIKASI | PENDING)
// Kolom yang dikembalikan sudah diformat: `waktu` HH:mm dari `jam`
// (lokal), `total_bayar` = total, `status_qris` & `no_ref_qris`.
function handleAdminQrisHistory(req, res, parsedUrl) {
  const json = (code, payload) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  };

  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  const localTodayYMD = () => {
    const n = new Date();
    return n.getFullYear() + '-' +
      String(n.getMonth() + 1).padStart(2, '0') + '-' +
      String(n.getDate()).padStart(2, '0');
  };
  const localMonthStartYMD = () => {
    const n = new Date();
    return n.getFullYear() + '-' +
      String(n.getMonth() + 1).padStart(2, '0') + '-01';
  };

  const q = (parsedUrl && parsedUrl.query) || {};
  const startDate = dateRe.test(q.startDate || '') ? q.startDate : localMonthStartYMD();
  const endDate = dateRe.test(q.endDate || '') ? q.endDate : localTodayYMD();
  const search = String(q.search || '').trim().toLowerCase();
  const statusParam = String(q.status || 'ALL').toUpperCase();
  const statusValid = ['ALL', 'TERVERIFIKASI', 'PENDING', 'BATAL'].includes(statusParam)
    ? statusParam : 'ALL';

  // Filter di-client untuk rentang + search (data QRIS bulan berjalan
  // = ~100-200 baris; ringan, konsisten pola kasLaci/setoran Fix #20/#21)
  db.all(
    `SELECT id,
            nomor_transaksi AS kode_transaksi,
            jam AS waktu,
            tanggal,
            total AS total_bayar,
            kasir,
            no_ref_qris,
            COALESCE(status_qris, 'TERVERIFIKASI') AS status_qris
     FROM transaksi
     WHERE UPPER(metode_pembayaran) LIKE '%QRIS%'
       AND date(tanggal, 'localtime') >= date(?, 'localtime')
       AND date(tanggal, 'localtime') <= date(?, 'localtime')
     ORDER BY tanggal DESC, jam DESC, id DESC`,
    [startDate, endDate],
    (err, rows) => {
      if (err) return json(500, { success: false, message: 'Gagal membaca riwayat QRIS: ' + err.message });

      const data = (rows || []).filter(r => {
        const matchStatus = statusValid === 'ALL'
          || String(r.status_qris || '').toUpperCase() === statusValid;
        const matchSearch = !search
          || String(r.kode_transaksi || '').toLowerCase().includes(search)
          || String(r.kasir || '').toLowerCase().includes(search)
          || String(r.no_ref_qris || '').toLowerCase().includes(search);
        return matchStatus && matchSearch;
      }).map(r => ({
        id: Number(r.id),
        kode_transaksi: r.kode_transaksi || '—',
        // Format HH:mm dari kolom jam (HH:mm:ss atau HH:mm)
        waktu: String(r.waktu || '').slice(0, 5),
        tanggal: r.tanggal || '—',
        total_bayar: Number(r.total_bayar) || 0,
        kasir: r.kasir || '—',
        no_ref_qris: r.no_ref_qris || '-',
        status_qris: r.status_qris || 'TERVERIFIKASI',
      }));

      json(200, {
        success: true,
        startDate,
        endDate,
        status: statusValid,
        data,
      });
    }
  );
}

// ── API: PATCH /api/admin/qris/verify/:id ───────────────────────
// Perbarui status verifikasi QRIS & nomor referensi (RRN) pada
// transaksi QRIS tertentu — dipanggil tombol aksi di modal riwayat.
// Request body JSON: { status_qris, no_ref_qris }
// - status_qris : 'TERVERIFIKASI' | 'PENDING' | 'BATAL'
// - no_ref_qris : string (RRN / ID referensi bank/e-wallet)
function handleAdminQrisVerify(req, res, txId) {
  const json = (code, payload) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  };

  const validStatus = ['TERVERIFIKASI', 'PENDING', 'BATAL'];
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    let payload = {};
    try { payload = JSON.parse(body || '{}'); } catch (e) { /* fallback */ }
    const newStatus = String(payload.status_qris || '').toUpperCase();
    if (!validStatus.includes(newStatus)) {
      return json(400, { success: false, message: 'status_qris harus TERVERIFIKASI, PENDING, atau BATAL' });
    }
    const newRef = String(payload.no_ref_qris || '').trim() || '-';

    db.get(
      `SELECT id, nomor_transaksi, status_qris, no_ref_qris
       FROM transaksi WHERE id = ? AND UPPER(metode_pembayaran) LIKE '%QRIS%' LIMIT 1`,
      [Number(txId)],
      (err, tx) => {
        if (err) return json(500, { success: false, message: 'Gagal membaca transaksi: ' + err.message });
        if (!tx) return json(404, { success: false, message: 'Transaksi QRIS tidak ditemukan' });

        db.run(
          `UPDATE transaksi
           SET status_qris = ?, no_ref_qris = ?
           WHERE id = ?`,
          [newStatus, newRef, Number(txId)],
          (err2) => {
            if (err2) return json(500, { success: false, message: 'Gagal memperbarui: ' + err2.message });
            json(200, {
              success: true,
              id: tx.id,
              kode_transaksi: tx.nomor_transaksi,
              status_qris: newStatus,
              no_ref_qris: newRef,
            });
          }
        );
      }
    );
  });
}

// ── API: GET /api/admin/transactions/today ──────────────────────
// Support query ?date=YYYY-MM-DD (fallback = hari ini bila kosong/invalid)
function handleAdminTransactionsToday(req, res, parsedUrl) {
  const queryDate = (parsedUrl && parsedUrl.query && parsedUrl.query.date) || '';
  // Validasi format YYYY-MM-DD; fallback ke hari ini bila kosong/invalid
  const dateParam = /^\d{4}-\d{2}-\d{2}$/.test(queryDate)
    ? queryDate
    : new Date().toISOString().slice(0, 10);

  res.writeHead(200, { 'Content-Type': 'application/json' });
  db.all(
    `SELECT id, nomor_transaksi AS no_struk, jam AS waktu, kasir,
            metode_pembayaran AS metode, total
     FROM transaksi
     WHERE date(tanggal) = date(?)
       AND tipe_transaksi = 'PENJUALAN'
     ORDER BY jam DESC, id DESC`,
    [dateParam],
    (err, rows) => {
      if (err) {
        res.write(JSON.stringify({ success: false, message: 'Gagal membaca transaksi: ' + err.message }));
        return res.end();
      }
      res.end(JSON.stringify({
        success: true,
        date: dateParam,
        data: (rows || []).map(r => ({
          id: r.id,
          no_struk: r.no_struk,
          waktu: r.waktu,
          kasir: r.kasir,
          metode: r.metode,
          total: r.total,
        })),
      }));
    }
  );
}

// ── API: GET /api/admin/transactions/detail/:id ─────────────────
function handleAdminTransactionDetail(req, res, txId) {
  const json = (code, payload) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  };

  const id = Number(txId);
  if (!Number.isInteger(id) || id <= 0) {
    return json(400, { success: false, message: 'ID transaksi tidak valid' });
  }

  db.get(
    `SELECT id, nomor_transaksi, tanggal, jam, kasir, total,
            metode_pembayaran, bayar, kembalian
     FROM transaksi WHERE id = ? LIMIT 1`,
    [id],
    (err, tx) => {
      if (err) return json(500, { success: false, message: 'Gagal membaca transaksi: ' + err.message });
      if (!tx) return json(404, { success: false, message: 'Transaksi tidak ditemukan' });

      db.all(
        `SELECT nama_barang, qty, harga_jual AS harga, subtotal
         FROM detail_transaksi WHERE transaksi_id = ? ORDER BY id ASC`,
        [id],
        (err2, items) => {
          if (err2) return json(500, { success: false, message: 'Gagal membaca detail: ' + err2.message });
          json(200, {
            success: true,
            header: {
              id: tx.id,
              no_struk: tx.nomor_transaksi,
              tanggal: tx.tanggal,
              waktu: tx.jam,
              kasir: tx.kasir,
              metode: tx.metode_pembayaran,
              total: tx.total,
              bayar: tx.bayar,
              kembalian: tx.kembalian,
            },
            items: (items || []).map(r => ({
              nama_barang: r.nama_barang,
              qty: r.qty,
              harga: r.harga,
              subtotal: r.subtotal,
            })),
          });
        }
      );
    }
  );
}

// ── API: POST /api/admin/pembelian (Fix #45 — Purchase Cart Checkout) ───
// Terima payload: { admin_name, catat_kas_keluar, items: [{barang_id, hpp_baru, harga_jual_baru, qty}] }
// Jalankan di transaction terpisah (BEGIN IMMEDIATE) agar atomic:
//   insert pembelian → insert detail → update master_barang (stok+_hpp+hj)
//   → opsional insert kas_laci_transaksi UANG_KELUAR.
// `admin_name` = username admin yang melakukan restok (disimpan di pembelian.created_by).
function handleAdminPembelian(req, res) {
  const json = (code, payload) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  };

  let body = '';
  req.on('data', (chunk) => { body += chunk; if (body.length > 102400) req.destroy(); });
  req.on('end', () => {
    let payload;
    try { payload = JSON.parse(body || '{}'); }
    catch (e) { return json(400, { success: false, message: 'Body JSON tidak valid.' }); }

    const items = Array.isArray(payload.items) ? payload.items : [];
    if (!items.length) return json(400, { success: false, message: 'Keranjang kosong — minimal 1 item.' });
    const adminName = String(payload.admin_name || 'admin').trim() || 'admin';
    const catatKasKeluar = payload.catat_kas_keluar === true;

    // Validasi setiap item
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (!Number.isInteger(it.barang_id) || it.barang_id <= 0)
        return json(400, { success: false, message: `Item #${i+1}: barang_id tidak valid.` });
      if (!Number.isInteger(it.qty) || it.qty <= 0)
        return json(400, { success: false, message: `Item #${i+1}: qty harus bilangan bulat > 0.` });
      const hpp = Number(it.hpp_baru) || 0;
      const hj  = Number(it.harga_jual_baru) || 0;
      if (hpp < 0 || hj < 0)
        return json(400, { success: false, message: `Item #${i+1}: harga tidak boleh negatif.` });
    }

    // Buka connection terpisah untuk transaction (pola server.js)
    const conn = new sqlite3.Database(path.join(__dirname, 'pos.db'));

    const finishTx = (stmt, cb) => {
      conn.run(stmt, () => { conn.close(); cb(); });
    };

    conn.run('SELECT 1', (openErr) => {
      if (openErr) {
        conn.close();
        return json(500, { success: false, message: 'Gagal membuka DB: ' + openErr.message });
      }

      // Generate nota_no: PO-YYYYMMDD-XXXX (urutan hari ini)
      const now = new Date();
      const ymd = now.getFullYear()
        + String(now.getMonth() + 1).padStart(2, '0')
        + String(now.getDate()).padStart(2, '0');

      conn.get(
        `SELECT COUNT(*) AS c FROM pembelian WHERE nota_no LIKE ?`,
        ['PO-' + ymd + '-%'],
        (err, row) => {
          if (err) { conn.close(); return json(500, { success: false, message: err.message }); }
          const seq = ((row && row.c) || 0) + 1;
          const notaNo = 'PO-' + ymd + '-' + String(seq).padStart(4, '0');

          // Hitung total
          let totalModal = 0, totalQty = 0;
          items.forEach(it => {
            totalModal += (Number(it.hpp_baru) || 0) * (Number(it.qty) || 0);
            totalQty   += (Number(it.qty) || 0);
          });

          // 1. BEGIN
          conn.run('BEGIN IMMEDIATE', (beginErr) => {
            if (beginErr) {
              conn.close();
              return json(500, { success: false, message: 'BEGIN gagal: ' + beginErr.message });
            }

            // 2. Insert pembelian (kasir_id=0 → admin action, bukan kasir session)
            // (Fix #46) kategori_target = kategori tab yang sedang di-checkout
            // (Fix #54) status = 'PENDING', no_po = nota_no — stok BULKAN ditambah
            //   pada tahap ini. Stok hanya bertambah setelah PO DITERIMA (endpoint lain).
            const kategoriTarget = String(payload.kategori_target || '').toUpperCase();
            const poStatus = String(payload.status || 'PENDING').toUpperCase() || 'PENDING';
            conn.run(
              `INSERT INTO pembelian
                 (nota_no, kasir_id, total_modal, total_qty, catat_kas_keluar,
                  kategori_target, status, no_po)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
              [notaNo, 0, totalModal, totalQty, catatKasKeluar ? 1 : 0,
               kategoriTarget || null, poStatus, notaNo],
              (insErr) => {
                if (insErr) {
                  return finishTx('ROLLBACK', () =>
                    json(500, { success: false, message: 'Gagal simpan pembelian: ' + insErr.message }));
                }
                // 3. Ambil id
                conn.get('SELECT last_insert_rowid() AS id', [], (idErr, idRow) => {
                  if (idErr) {
                    return finishTx('ROLLBACK', () =>
                      json(500, { success: false, message: idErr.message }));
                  }
                  const pembelianId = Number((idRow && idRow.id) || 0);

                  // 4. (Fix #54) Insert detail item TANPA update stok.
                  //    Stok_aktual di master_barang tetap apa adanya sampai
                  //    PO disetujui/diterima oleh endpoint terpisah.
                  processItemsNoStock(conn, pembelianId, items, (ok, errMsg) => {
                    if (!ok) {
                      return finishTx('ROLLBACK', () =>
                        json(400, { success: false, message: errMsg }));
                    }
                    // 5. Opsional: catat kas keluar
                    if (catatKasKeluar) {
                      insertKasKeluar(conn, totalModal, notaNo, adminName, (ok2, err2) => {
                        if (!ok2) {
                          return finishTx('ROLLBACK', () =>
                            json(409, { success: false, message: err2 }));
                        }
                        finishTx('COMMIT', () => json(200, {
                          success: true,
                          nota_no: notaNo,
                          no_po: notaNo,
                          status: poStatus,
                          total_modal: totalModal,
                          total_qty: totalQty,
                          item_count: items.length,
                          catat_kas_keluar: true,
                          kategori_target: kategoriTarget || null,
                          stok_ditambah: false, // (Fix #54) stok BELUM ditambah
                        }));
                      });
                    } else {
                      finishTx('COMMIT', () => json(200, {
                        success: true,
                        nota_no: notaNo,
                        no_po: notaNo,
                        status: poStatus,
                        total_modal: totalModal,
                        total_qty: totalQty,
                        item_count: items.length,
                        catat_kas_keluar: false,
                        kategori_target: kategoriTarget || null,
                        stok_ditambah: false,
                      }));
                    }
                  });
                });
              }
            );
          });
        }
      );
    });
  });
}

// ── API: GET /api/admin/pembelian/po (Fix #54) ──────────────────
// Daftar PO: ?status=PENDING|DITERIMA|BATAL — default semua.
// Return: { success, po: [{id, no_po, status, total_modal, total_qty,
//         kategori_target, created_at, item_count}] }
function handleAdminGetListPO(req, res, parsed) {
  const q = parsed.query || {};
  const status = q.status ? String(q.status).toUpperCase() : '';

  const json = (code, payload) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  };

  let sql = `
    SELECT p.id, p.no_po, p.nota_no, p.status,
           p.total_modal, p.total_qty, p.kategori_target,
           p.created_at,
           (SELECT COUNT(*) FROM detail_pembelian d WHERE d.pembelian_id = p.id) AS item_count
    FROM pembelian p`;
  const args = [];
  if (status) { sql += ' WHERE p.status = ?'; args.push(status); }
  sql += ' ORDER BY p.id DESC LIMIT 200';

  db.all(sql, args, (err, rows) => {
    if (err) return json(500, { success: false, message: err.message });
    json(200, {
      success: true,
      po: (rows || []).map(r => ({
        id: r.id,
        no_po: r.no_po || r.nota_no,
        status: r.status || 'PENDING',
        total_modal: Number(r.total_modal) || 0,
        total_qty: Number(r.total_qty) || 0,
        kategori_target: r.kategori_target || null,
        created_at: r.created_at,
        item_count: Number(r.item_count) || 0,
      })),
    });
  });
}

// ── API: PUT /api/admin/pembelian/po/:id/status (Fix #54) ────────
// Batalkan / tolak PO yang masih PENDING.
// Payload: { status: 'BATAL' }
// (DITERIMA = menambah stok, itu di luar scope Fix #54 — endpoint DITERIMA
//  baru dibuat nanti saat disetujui/diterima oleh fitur lain.)
function handleAdminUpdatePOStatus(req, res, poIdStr) {
  const poId = Number(poIdStr);
  if (!poId) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: false, message: 'ID PO tidak valid.' }));
  }

  let body = '';
  req.on('data', (chunk) => { body += chunk; if (body.length > 512) req.destroy(); });
  req.on('end', () => {
    let payload;
    try { payload = JSON.parse(body || '{}'); }
    catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: false, message: 'Body JSON tidak valid.' }));
    }

    const allowed = ['BATAL']; // (Fix #54) hanya batalkan; DITERIMA butuh alur terpisah
    const newStatus = String(payload.status || '').toUpperCase();
    if (!allowed.includes(newStatus)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        success: false,
        message: `Status harus salah satu: ${allowed.join(', ')} (DITERIMA alur terpisah).`,
      }));
    }

    db.get('SELECT id, no_po, status FROM pembelian WHERE id = ?', [poId], (err, row) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: false, message: err.message }));
      }
      if (!row) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: false, message: 'PO tidak ditemukan.' }));
      }
      // Hanya PENDING yang bisa dibatalkan (DITERIMA/BATAL permanen)
      if (row.status !== 'PENDING') {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          success: false,
          message: `PO ${row.no_po} sudah berstatus ${row.status} — tidak bisa diubah.`,
        }));
      }

      db.run(
        `UPDATE pembelian SET status = ? WHERE id = ?`,
        [newStatus, poId],
        (uErr) => {
          if (uErr) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ success: false, message: 'Gagal update: ' + uErr.message }));
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            po_id: poId,
            no_po: row.no_po,
            status: newStatus,
          }));
        }
      );
    });
  });
}

// ── API: GET /api/admin/pembelian/po/:id/detail (Fix #55) ───────
// Rincian PO: header + daftar item (detail_pembelian).
// Return: { success, po: {id, no_po, status, total_modal, total_qty,
//          kategori_target, created_at},
//          items: [{id, barang_id, hpp_lama, hpp_baru,
//                  harga_jual_lama, harga_jual_baru, qty, subtotal_modal}] }
function handleAdminGetPODetail(req, res, poIdStr) {
  const poId = Number(poIdStr);
  if (!poId) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: false, message: 'ID PO tidak valid.' }));
  }

  db.get(
    `SELECT id, no_po, nota_no, status, total_modal, total_qty,
            kategori_target, created_at, catat_kas_keluar
     FROM pembelian WHERE id = ?`,
    [poId],
    (err, poRow) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: false, message: err.message }));
      }
      if (!poRow) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: false, message: 'PO tidak ditemukan.' }));
      }

      db.all(
        `SELECT id, barang_id, hpp_lama, hpp_baru,
                harga_jual_lama, harga_jual_baru, qty, subtotal_modal
         FROM detail_pembelian WHERE pembelian_id = ? ORDER BY id ASC`,
        [poId],
        (err2, itemRows) => {
          if (err2) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ success: false, message: err2.message }));
          }

          // Ambil nama barang untuk tiap item (JOIN master_barang)
          const itemIds = (itemRows || []).map(r => r.barang_id).filter(Boolean);
          const placeholders = itemIds.map(() => '?').join(',') || 'null';

          db.all(
            `SELECT id, nama, id_barang AS kode_barang, kategori FROM master_barang WHERE id IN (${itemIds.length ? placeholders : '0'})`,
            itemIds.length ? itemIds : [0],
            (err3, mbRows) => {
              if (err3) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ success: false, message: err3.message }));
              }

              const mbMap = {};
              (mbRows || []).forEach(m => { mbMap[m.id] = m; });

              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({
                success: true,
                po: {
                  id: poRow.id,
                  no_po: poRow.no_po || poRow.nota_no,
                  status: poRow.status || 'PENDING',
                  total_modal: Number(poRow.total_modal) || 0,
                  total_qty: Number(poRow.total_qty) || 0,
                  kategori_target: poRow.kategori_target || null,
                  created_at: poRow.created_at,
                },
                items: (itemRows || []).map(r => {
                  const mb = mbMap[Number(r.barang_id)] || {};
                  return {
                    id: r.id,
                    barang_id: Number(r.barang_id),
                    nama_barang: mb.nama || mb.kode_barang || ('#' + r.barang_id),
                    kategori: mb.kategori || '',
                    hpp_lama: Number(r.hpp_lama) || 0,
                    hpp_baru: Number(r.hpp_baru) || 0,
                    harga_jual_lama: Number(r.harga_jual_lama) || 0,
                    harga_jual_baru: Number(r.harga_jual_baru) || 0,
                    qty: Number(r.qty) || 0,
                    subtotal_modal: Number(r.subtotal_modal) || 0,
                  };
                }),
              }));
            }
          );
        }
      );
    }
  );
}

// ── API: PUT /api/admin/pembelian/po/:id (Fix #55) ─────────────
// Edit PO PENDING: update header (total_modal, total_qty) & perbarui item.
// DILARANG mengubah stok_aktual di master_barang.
// Payload: { total_modal, total_qty, kategori_target,
//            items: [{barang_id, hpp_baru, harga_jual_baru, qty}] }
// Jika status sudah bukan PENDING → HTTP 409.
function handleAdminEditPO(req, res, poIdStr) {
  const poId = Number(poIdStr);
  if (!poId) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: false, message: 'ID PO tidak valid.' }));
  }

  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
    if (body.length > 50000) req.destroy();
  });
  req.on('end', () => {
    let payload;
    try { payload = JSON.parse(body || '{}'); }
    catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: false, message: 'Body JSON tidak valid.' }));
    }

    const items = Array.isArray(payload.items) ? payload.items : [];
    if (!items.length) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: false, message: 'items tidak boleh kosong.' }));
    }

    // Validasi items
    for (const it of items) {
      if (!it.barang_id) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: false, message: 'barang_id wajib di setiap item.' }));
      }
      if (Number(it.qty) < 1) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: false, message: 'qty minimal 1 per item.' }));
      }
    }

    db.get('SELECT id, no_po, status FROM pembelian WHERE id = ?', [poId], (err, poRow) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: false, message: err.message }));
      }
      if (!poRow) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: false, message: 'PO tidak ditemukan.' }));
      }
      // Hanya PENDING yang bisa diedit
      if (poRow.status !== 'PENDING') {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          success: false,
          message: `PO ${poRow.no_po} sudah berstatus ${poRow.status} — tidak bisa diedit.`,
        }));
      }

      const kategoriTarget = String(payload.kategori_target || poRow.kategori_target || '').toUpperCase() || null;
      const totalModal = Number(payload.total_modal) || 0;
      const totalQty = Number(payload.total_qty) || 0;

      const conn = new sqlite3.Database(DB_PATH);
      const finishTx = (txSql, cb) => {
        conn.run(txSql, (txErr) => {
          if (txErr) console.error('[ADMIN][edit-po] ' + txSql + ':', txErr.message);
          conn.close();
          cb();
        });
      };

      conn.run('BEGIN IMMEDIATE', (beginErr) => {
        if (beginErr) {
          conn.close();
          res.writeHead(500, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, message: 'BEGIN gagal: ' + beginErr.message }));
        }

        // Update header
        conn.run(
          `UPDATE pembelian
           SET total_modal = ?, total_qty = ?, kategori_target = ?
           WHERE id = ? AND status = 'PENDING'`,
          [totalModal, totalQty, kategoriTarget, poId],
          (upErr) => {
            if (upErr) {
              return finishTx('ROLLBACK', () =>
                json500(res, 'Gagal update header: ' + upErr.message));
            }

            // Hapus detail lama
            conn.run('DELETE FROM detail_pembelian WHERE pembelian_id = ?', [poId], (delErr) => {
              if (delErr) {
                return finishTx('ROLLBACK', () =>
                  json500(res, 'Gagal hapus detail lama: ' + delErr.message));
              }

              // Insert detail baru — TANPA update stok (pola processItemsNoStock)
              let i = 0;
              const next = () => {
                if (i >= items.length) {
                  return finishTx('COMMIT', () => {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                      success: true,
                      po_id: poId,
                      no_po: poRow.no_po,
                      status: 'PENDING',
                      total_modal: totalModal,
                      total_qty: totalQty,
                      kategori_target: kategoriTarget,
                      item_count: items.length,
                      stok_ditambah: false,
                    }));
                  });
                }
                const it = items[i];
                const hppBaru = Number(it.hpp_baru) || 0;
                const hjBaru  = Number(it.harga_jual_baru) || 0;
                const qty     = Number(it.qty) || 1;
                const subtotal = hppBaru * qty;

                conn.run(
                  `INSERT INTO detail_pembelian
                   (pembelian_id, barang_id, hpp_lama, hpp_baru,
                    harga_jual_lama, harga_jual_baru, qty, subtotal_modal)
                   VALUES (?, ?, 0, ?, 0, ?, ?, ?)`,
                  [poId, Number(it.barang_id), hppBaru, hjBaru, qty, subtotal],
                  (insErr) => {
                    if (insErr) {
                      return finishTx('ROLLBACK', () =>
                        json400(res, 'Gagal insert detail: ' + insErr.message));
                    }
                    i++;
                    next();
                  }
                );
              };
              next();
            });
          }
        );
      });
    });
  });
}

const json500 = (res, msg) => {
  res.writeHead(500, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ success: false, message: msg }));
};
const json400 = (res, msg) => {
  res.writeHead(400, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ success: false, message: msg }));
};

// ── API: GET /api/admin/pembelian/trend-hpp (Fix #47) ──────────
// Time-series fluktuasi HPP vs Harga Jual dari histori pembelian.
// Query: ?barang_id=<n>  → time series semua catatan harga jual + HPP terakhir
//         ?kategori=<k>   → agregat rata-rata per tanggal (untuk grafik per kategori)
//         (none)          → seluruh histori (agregat rata-rata per tanggal)
// Response: { success, series: [{tanggal, hpp, harga_jual, nama_barang?, kategori?}],
//             items: [ ...master_barang snapshot per barang ],
//             margin_warning: [ {id, nama_barang, kategori, hpp, harga_jual, margin_pct} ] }
function handleAdminPembelianTrendHpp(req, res, parsed) {
  const q = parsed.query || {};
  const barangId = q.barang_id ? Number(q.barang_id) : null;
  const kategori = q.kategori ? String(q.kategori).toUpperCase() : null;

  res.writeHead(200, { 'Content-Type': 'application/json' });
  const done = (payload) => res.end(JSON.stringify(payload));

  // 1. Ambil histori detail + data master barang
  db.all(
    `SELECT d.pembelian_id, d.barang_id, d.hpp_lama, d.hpp_baru,
            d.harga_jual_lama, d.harga_jual_baru, d.qty,
            p.created_at AS tanggal, p.kategori_target,
            m.nama        AS nama_barang,
            m.kategori    AS kategori,
            m.hpp         AS hpp_riil,
            m.harga_jual  AS harga_jual_riil,
            m.stok_aktual AS stok_riil
     FROM detail_pembelian d
     JOIN pembelian p ON p.id = d.pembelian_id
     LEFT JOIN master_barang m ON m.id = d.barang_id
     ORDER BY p.created_at ASC`,
    [],
    (err, rows) => {
      if (err) {
        res.statusCode = 500;
        return done({ success: false, message: 'Gagal baca histori: ' + err.message });
      }
      rows = rows || [];

      // Filter
      let filtered = rows;
      if (barangId)       filtered = filtered.filter(r => Number(r.barang_id) === barangId);
      if (kategori)      filtered = filtered.filter(r =>
        String(r.kategori_target || r.kategori || '').toUpperCase() === kategori
      );

      // ── Time series: rata-rata HPP & Harga Jual per tanggal ──
      const byTanggal = {};
      filtered.forEach(r => {
        const tgl = (r.tanggal || '').substring(0, 10);
        if (!tgl) return;
        if (!byTanggal[tgl]) byTanggal[tgl] = { hppSum: 0, hjSum: 0, count: 0, barangIds: new Set() };
        byTanggal[tgl].hppSum += Number(r.hpp_baru) || 0;
        byTanggal[tgl].hjSum  += Number(r.harga_jual_baru) || 0;
        byTanggal[tgl].count  += 1;
        byTanggal[tgl].barangIds.add(r.barang_id);
      });
      const series = Object.keys(byTanggal).sort().map(tgl => {
        const g = byTanggal[tgl];
        const avgHpp = g.count ? Math.round(g.hppSum / g.count) : 0;
        const avgHj  = g.count ? Math.round(g.hjSum  / g.count) : 0;
        return {
          tanggal:   tgl,
          hpp:       avgHpp,
          harga_jual: avgHj,
          // margin rata-rata tanggal ini (%)
          margin_pct: avgHj > 0 ? Math.round(((avgHj - avgHpp) / avgHj) * 100) : 0,
        };
      });

      // ── Margin warning: barang riil yang margin-nya < 20% dari harga jual ──
      // (Margin riil = harga jual saat ini vs HPP riil saat ini)
      db.all(
        `SELECT id, id_barang AS kode_barang, nama AS nama_barang,
                kategori, hpp, harga_jual, stok_aktual
         FROM master_barang
         WHERE harga_jual > 0
         ORDER BY nama ASC`,
        [],
        (err2, mbRows) => {
          if (err2) {
            res.statusCode = 500;
            return done({ success: false, message: 'Gagal baca master: ' + err2.message });
          }
          const mb = (mbRows || []).map(r => ({
            id: r.id,
            kode_barang: r.kode_barang,
            nama_barang: r.nama_barang,
            kategori: r.kategori,
            hpp: Number(r.hpp) || 0,
            harga_jual: Number(r.harga_jual) || 0,
            stok_riil: Number(r.stok_aktual) || 0,
            margin_pct: Number(r.harga_jual) > 0
              ? Math.round(((Number(r.harga_jual) - (Number(r.hpp) || 0)) / Number(r.harga_jual)) * 100)
              : 0,
          }));

          // Filter kategori bila diminta
          let mbFiltered = mb;
          if (kategori) mbFiltered = mbFiltered.filter(r =>
            String(r.kategori || '').toUpperCase() === kategori
          );

          const marginWarning = mbFiltered
            .filter(r => r.margin_pct < 20)
            .sort((a, b) => a.margin_pct - b.margin_pct);

          const allCategories = [...new Set(mb.map(r => r.kategori).filter(Boolean))].sort();

          done({
            success: true,
            series:        series,
            items:         mbFiltered,
            categories:    allCategories,
            margin_warning: marginWarning,
            // Riwayat per barang (jika filter barang_id)
            per_barang:    barangId
              ? filtered.filter(r => Number(r.barang_id) === barangId).map(r => ({
                  tanggal:      (r.tanggal || '').substring(0, 10),
                  hpp_baru:     Number(r.hpp_baru) || 0,
                  harga_jual_baru: Number(r.harga_jual_baru) || 0,
                  nama_barang:  r.nama_barang,
                  kategori:     r.kategori,
                }))
              : null,
          });
        }
      );
    }
  );
}

// Helper: proses setiap item pembelian di dalam transaction
function processItems(conn, pembelianId, items, done) {
  let i = 0;
  const next = () => {
    if (i >= items.length) return done(true, null);
    const it = items[i];
    conn.get(
      `SELECT id, hpp, harga_jual, stok_aktual FROM master_barang WHERE id = ?`,
      [it.barang_id],
      (err, baris) => {
        if (err) return done(false, 'Gagal baca master_barang: ' + err.message);
        if (!baris) return done(false, `Barang id=${it.barang_id} tidak ditemukan.`);
        const hppLama = Number(baris.hpp) || 0;
        const hjLama  = Number(baris.harga_jual) || 0;
        const hppBaru  = Number(it.hpp_baru) || 0;
        const hjBaru   = Number(it.harga_jual_baru) || 0;
        const qty      = Number(it.qty) || 0;
        const subtotal = hppBaru * qty;

        conn.run(
          `INSERT INTO detail_pembelian
           (pembelian_id, barang_id, hpp_lama, hpp_baru, harga_jual_lama, harga_jual_baru, qty, subtotal_modal)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [pembelianId, it.barang_id, hppLama, hppBaru, hjLama, hjBaru, qty, subtotal],
          (err2) => {
            if (err2) return done(false, 'Gagal simpan detail item: ' + err2.message);
            // Update master_barang: stok naik, hpp & harga_jual diganti
            conn.run(
              `UPDATE master_barang
               SET stok_aktual = stok_aktual + ?, hpp = ?, harga_jual = ?, updated_at = datetime('now','localtime')
               WHERE id = ?`,
              [qty, hppBaru, hjBaru, it.barang_id],
              (err3) => {
                if (err3) return done(false, 'Gagal update stok barang: ' + err3.message);
                i++;
                next();
              }
            );
          }
        );
      }
    );
  };
  next();
}

// (Fix #54) Variasi processItems yang HANYA insert detail, TANPA update
// stok_aktual di master_barang. Dipakai saat PO status PENDING — stok
// baru ditambah nanti ketika PO disetujui/diterima oleh endpoint lain.
function processItemsNoStock(conn, pembelianId, items, done) {
  let i = 0;
  const next = () => {
    if (i >= items.length) return done(true, null);
    const it = items[i];
    conn.get(
      `SELECT hpp, harga_jual FROM master_barang WHERE id = ?`,
      [it.barang_id],
      (err, baris) => {
        if (err) return done(false, 'Gagal baca master_barang: ' + err.message);
        if (!baris) return done(false, `Barang id=${it.barang_id} tidak ditemukan.`);
        const hppLama = Number(baris.hpp) || 0;
        const hjLama  = Number(baris.harga_jual) || 0;
        const hppBaru = Number(it.hpp_baru) || 0;
        const hjBaru  = Number(it.harga_jual_baru) || 0;
        const qty     = Number(it.qty) || 0;
        const subtotal = hppBaru * qty;

        conn.run(
          `INSERT INTO detail_pembelian
           (pembelian_id, barang_id, hpp_lama, hpp_baru, harga_jual_lama, harga_jual_baru, qty, subtotal_modal)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [pembelianId, it.barang_id, hppLama, hppBaru, hjLama, hjBaru, qty, subtotal],
          (err2) => {
            if (err2) return done(false, 'Gagal simpan detail item: ' + err2.message);
            // (Fix #54) TIDAK ada UPDATE master_barang di sini.
            i++;
            next();
          }
        );
      }
    );
  };
  next();
}

// Helper: insert pengeluaran ke kas_laci_transaksi (jenis UANG_KELUAR)
// (Fix #45) Dipanggil dari handleAdminPembelian — konteks admin, bukan kasir session.
// Menggunakan kasir_id=0 & kasir='admin' agar konsisten dengan transaksi admin.
function insertKasKeluar(conn, nominal, notaNo, adminName, done) {
  conn.get(
    `SELECT MAX(CAST(substr(transaction_id,4) AS INTEGER)) AS nomor
     FROM kas_laci_transaksi
     WHERE jenis='UANG_KELUAR' AND transaction_id GLOB 'KLK[0-9]*' AND substr(transaction_id,4) NOT GLOB '*[^0-9]*'`,
    [],
    (err2, lastRow) => {
      if (err2) return done(false, 'Gagal cek nomor transaksi: ' + err2.message);
      const nomor = Number((lastRow && lastRow.nomor) || 0) + 1;
      const txId = `KLK${String(nomor).padStart(4,'0')}`;
      const now  = new Date().toISOString();
      conn.run(
        `INSERT INTO kas_laci_transaksi (transaction_id, jenis, nominal, keterangan, kasir_id, kasir, waktu, kode_setoran)
         VALUES (?, 'UANG_KELUAR', ?, ?, ?, ?, ?, '')`,
        [txId, nominal, `[Pembelian Barang] Restok ${notaNo} oleh ${adminName}`, 0, adminName, now],
        (err3) => {
          if (err3) return done(false, 'Gagal catat kas keluar: ' + err3.message);
          done(true, null);
        }
      );
    }
  );
}

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);
  let pathname = decodeURIComponent(parsed.pathname || '/');

  // ── URL REWRITE: /admin/* → /* (folder admin/ di-serve sebagai root) ──
  // Mirip middleware express: req.url.startsWith('/admin/') → strip prefix.
  if (pathname.startsWith('/admin/')) {
    pathname = pathname.replace(/^\/admin/, '');
    if (pathname === '' || pathname === '/') {
      pathname = '/index.html';
    }
  }

  // API routes
  if (req.method === 'POST' && pathname === '/api/admin/login') {
    return handleAdminLogin(req, res);
  }

  if (req.method === 'GET' && pathname === '/api/admin/overview-stats') {
    return handleAdminOverviewStats(req, res);
  }

  if (req.method === 'GET' && pathname === '/api/admin/transactions/today') {
    return handleAdminTransactionsToday(req, res, parsed);
  }

  if (req.method === 'GET' && pathname === '/api/admin/cash-flow') {
    return handleAdminCashFlow(req, res, parsed);
  }

  if (req.method === 'GET' && pathname === '/api/admin/cashier-deposits') {
    return handleAdminCashierDeposits(req, res, parsed);
  }

  if (req.method === 'GET' && pathname === '/api/admin/inventory/master') {
    return handleAdminInventoryMaster(req, res);
  }

  // (Fix #47) GET /api/admin/pembelian/trend-hpp — time-series HPP vs harga jual
  if (req.method === 'GET' && pathname === '/api/admin/pembelian/trend-hpp') {
    return handleAdminPembelianTrendHpp(req, res, parsed);
  }

  // (Fix #47) PUT /api/admin/inventory/price — quick-update harga jual / HPP
  // Payload: { barang_id, harga_jual?, hpp? } — tanpa perlu buka modal restok.
  if (req.method === 'PUT' && pathname === '/api/admin/inventory/price') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; if (body.length > 2048) req.destroy(); });
    req.on('end', () => {
      let payload;
      try { payload = JSON.parse(body || '{}'); }
      catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: false, message: 'Body JSON tidak valid.' }));
      }
      const barangId = Number(payload.barang_id);
      if (!barangId || barangId <= 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: false, message: 'barang_id tidak valid.' }));
      }
      const newHj = payload.harga_jual !== undefined ? Number(payload.harga_jual) : null;
      const newHpp = payload.hpp !== undefined ? Number(payload.hpp) : null;
      if ((newHj !== null && newHj < 0) || (newHpp !== null && newHpp < 0)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: false, message: 'Harga tidak boleh negatif.' }));
      }
      if (newHj === null && newHpp === null) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: false, message: 'Kirim harga_jual atau hpp.' }));
      }

      db.get('SELECT nama, hpp, harga_jual FROM master_barang WHERE id = ?', [barangId],
        (err, baris) => {
          if (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ success: false, message: err.message }));
          }
          if (!baris) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ success: false, message: 'Barang tidak ditemukan.' }));
          }
          const setHj = newHj !== null ? newHj : Number(baris.harga_jual);
          const setHpp = newHpp !== null ? newHpp : Number(baris.hpp);
          db.run(
            `UPDATE master_barang SET hpp = ?, harga_jual = ?, updated_at = datetime('now','localtime') WHERE id = ?`,
            [setHpp, setHj, barangId],
            (upErr) => {
              if (upErr) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ success: false, message: upErr.message }));
              }
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({
                success: true,
                nama_barang: baris.nama,
                hpp: setHpp,
                harga_jual: setHj,
                margin_pct: setHj > 0 ? Math.round(((setHj - setHpp) / setHj) * 100) : 0,
              }));
            }
          );
        }
      );
    });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/admin/tables/revenue') {
    return handleAdminTablesRevenue(req, res, parsed);
  }

  if (req.method === 'GET' && pathname === '/api/admin/stock-opname/losses') {
    return handleAdminStockOpnameLosses(req, res, parsed);
  }

  if (req.method === 'GET' && pathname === '/api/admin/stock-opname/surplus') {
    return handleAdminStockOpnameSurplus(req, res, parsed);
  }

  if (req.method === 'GET' && pathname === '/api/admin/members') {
    return handleAdminMembers(req, res, parsed);
  }

  // GET /api/admin/member/total — hanya COUNT(*) FROM member, sub-ms
  // Dipakai dashboard untuk mengisi stat card "Daftar Member" secara
  // realtime (fallback saat localStorage pbms_cached_total_member kosong).
  if (req.method === 'GET' && pathname === '/api/admin/member/total') {
    db.get('SELECT COUNT(*) AS c FROM member', [], (err, row) => {
      const total = row ? row.c : 0;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, totalMember: total }));
    });
    return;
  }

  // DELETE /api/admin/member/:id
  const memberDeleteMatch = /^\/api\/admin\/member\/(\d+)$/.exec(pathname);
  if (req.method === 'DELETE' && memberDeleteMatch) {
    return handleAdminDeleteMember(req, res, memberDeleteMatch[1]);
  }

  if (req.method === 'GET' && pathname === '/api/admin/reports/sales-chart') {
    return handleAdminSalesChart(req, res, parsed);
  }

  if (req.method === 'GET' && pathname === '/api/admin/bank/summary') {
    return handleAdminBankSummary(req, res);
  }

  if (req.method === 'GET' && pathname === '/api/admin/bank/pending-deposits') {
    return handleAdminBankPendingDeposits(req, res, parsed);
  }

  if (req.method === 'POST' && pathname === '/api/admin/bank/process-deposit') {
    return handleAdminBankProcessDeposit(req, res);
  }

  // GET /api/admin/bank/check-code/:code (Fix #36)
  const bankCheckCodeMatch = /^\/api\/admin\/bank\/check-code\/([A-Za-z0-9]{1,6})$/.exec(pathname);
  if (req.method === 'GET' && bankCheckCodeMatch) {
    return handleAdminBankCheckCode(req, res, bankCheckCodeMatch);
  }

  if (req.method === 'GET' && pathname === '/api/admin/bank/history') {
    return handleAdminBankHistory(req, res, parsed);
  }

  // (Fix #54) PO lifecycle:
  // GET  /api/admin/pembelian/po — daftar PO (filter ?status=PENDING|DITERIMA|BATAL)
  // PUT  /api/admin/pembelian/po/:id/status — ubah status / batalkan PO
  if (req.method === 'GET' && pathname === '/api/admin/pembelian/po') {
    return handleAdminGetListPO(req, res, parsed);
  }
  const poStatusMatch = /^\/api\/admin\/pembelian\/po\/(\d+)\/status$/.exec(pathname);
  if (req.method === 'PUT' && poStatusMatch) {
    return handleAdminUpdatePOStatus(req, res, poStatusMatch[1]);
  }
  // (Fix #55) Edit PO: GET detail + PUT update
  const poDetailMatch = /^\/api\/admin\/pembelian\/po\/(\d+)\/detail$/.exec(pathname);
  if (req.method === 'GET' && poDetailMatch) {
    return handleAdminGetPODetail(req, res, poDetailMatch[1]);
  }
  const poEditMatch = /^\/api\/admin\/pembelian\/po\/(\d+)$/.exec(pathname);
  if (req.method === 'PUT' && poEditMatch) {
    return handleAdminEditPO(req, res, poEditMatch[1]);
  }

  if (req.method === 'GET' && pathname === '/api/admin/qris/summary') {
    return handleAdminQrisSummary(req, res);
  }

  if (req.method === 'GET' && pathname === '/api/admin/qris/history') {
    return handleAdminQrisHistory(req, res, parsed);
  }

  // PATCH /api/admin/qris/verify/:id
  const qrisVerifyMatch = /^\/api\/admin\/qris\/verify\/(\d+)$/.exec(pathname);
  if (req.method === 'PATCH' && qrisVerifyMatch) {
    return handleAdminQrisVerify(req, res, qrisVerifyMatch[1]);
  }

  // /api/admin/transactions/detail/:id
  const detailMatch = /^\/api\/admin\/transactions\/detail\/(\d+)$/.exec(pathname);
  if (req.method === 'GET' && detailMatch) {
    return handleAdminTransactionDetail(req, res, detailMatch[1]);
  }

  // Fix #45 — Purchase Cart: POST /api/admin/pembelian
  if (req.method === 'POST' && pathname === '/api/admin/pembelian') {
    return handleAdminPembelian(req, res);
  }

  // Static files from admin/ directory
  let filePath;
  if (pathname === '/' || pathname === '' || pathname === '/admin') {
    filePath = path.join(ADMIN_DIR, 'index.html');
  } else {
    // Strip leading slash to avoid path traversal
    const relative = pathname.replace(/^\/+/, '');
    filePath = path.join(ADMIN_DIR, relative);
    // Security: ensure resolved path is within ADMIN_DIR
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(path.resolve(ADMIN_DIR))) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: false, message: 'Akses ditolak' }));
    }
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      // 404 fallback
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: false, message: 'Not found: ' + pathname }));
    }
    serveStatic(res, filePath);
  });
});

server.listen(PORT, () => {
  console.log(`[ADMIN] PBMS Admin server berjalan di http://0.0.0.0:${PORT}`);
});
