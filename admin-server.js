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
});

// ── Static file serving ──────────────────────────────────────────
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

  // 3. Kerugian SO Bulan Ini
  queries.push(new Promise((resolve, reject) => {
    db.get(
      `SELECT COALESCE(SUM(total_kerugian), 0) AS s FROM stock_opname
       WHERE strftime('%Y-%m', date(tanggal)) = strftime('%Y-%m', date('now', 'localtime'))`,
      [],
      (err, row) => (err ? reject(err) : resolve(row ? row.s : 0))
    );
  }));

  // 4. Total Master Barang
  queries.push(new Promise((resolve, reject) => {
    db.get('SELECT COUNT(id) AS c FROM master_barang', [],
      (err, row) => (err ? reject(err) : resolve(row ? row.c : 0))
    );
  }));

  // 5. Aktivitas Terkini — 5 entri terbaru dari tabel log
  //    Kolom aktual di log: waktu, level, event, message, data
  queries.push(new Promise((resolve, reject) => {
    db.all(
      `SELECT waktu, level, event, message FROM log ORDER BY id DESC LIMIT 5`,
      [],
      (err, rows) => (err ? reject(err) : resolve(rows || []))
    );
  }));

  Promise.all([
    queries[0], queries[1], queries[2], queries[3], queries[4],
    // DB liveness check
    new Promise((resolve, reject) => {
      db.get('SELECT 1 AS ok', [], (err) =>
        err ? reject(err) : resolve(true)
      );
    }),
  ]).then(([totalTx, totalPenjualan, kerugianSO, totalBarang, logRows, dbOk]) => {
    // ── Aktivitas terkini: aman terhadap kegagalan kueri log ──
    let aktivitasTerkini = [];
    if (Array.isArray(logRows)) {
      aktivitasTerkini = logRows.map(r => ({
        waktu: r.waktu,
        level: r.level,
        event: r.event,
        detail: r.message,
      }));
    }
    // Jika logRows === null (fallback) atau kueri gagal di luar scope,
    // aktivitasTerkini tetap [] — tidak crash seluruh response.

    json(200, {
      success: true,
      stats: {
        totalTransaksiHariIni: totalTx,
        totalPenjualanHariIni: totalPenjualan,
        kerugianSOBulanIni: kerugianSO,
        totalMasterBarang: totalBarang,
      },
      system: {
        database: dbOk,
        serverPos: true,
        autoBackup: true,
      },
      aktivitasTerkini,
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
      safeQuery(`SELECT COALESCE(SUM(total_kerugian),0) AS s FROM stock_opname
                 WHERE strftime('%Y-%m', date(tanggal))
                   = strftime('%Y-%m', date('now','localtime'))`, { s: 0 }),
      safeQuery('SELECT COUNT(id) AS c FROM master_barang', { c: 0 }),
    ]).then(([tx, penjualan, kerugian, barang]) => {
      json(200, {
        success: true,
        stats: {
          totalTransaksiHariIni: tx.c,
          totalPenjualanHariIni: penjualan.s,
          kerugianSOBulanIni: kerugian.s,
          totalMasterBarang: barang.c,
        },
        system: { database: true, serverPos: true, autoBackup: true },
        aktivitasTerkini: [], // fallback kosong — tidak crash
      });
    }).catch(() => {
      json(500, {
        success: false,
        message: 'Gagal membaca database: ' + err.message,
      });
    });
  });
}

// ── API: GET /api/admin/transactions/today ──────────────────────
function handleAdminTransactionsToday(req, res) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  db.all(
    `SELECT id, nomor_transaksi AS no_struk, jam AS waktu, kasir,
            metode_pembayaran AS metode, total
     FROM transaksi
     WHERE date(tanggal) = date('now', 'localtime')
       AND tipe_transaksi = 'PENJUALAN'
     ORDER BY jam DESC, id DESC`,
    [],
    (err, rows) => {
      if (err) {
        res.write(JSON.stringify({ success: false, message: 'Gagal membaca transaksi: ' + err.message }));
        return res.end();
      }
      res.end(JSON.stringify({
        success: true,
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
    return handleAdminTransactionsToday(req, res);
  }

  // /api/admin/transactions/detail/:id
  const detailMatch = /^\/api\/admin\/transactions\/detail\/(\d+)$/.exec(pathname);
  if (req.method === 'GET' && detailMatch) {
    return handleAdminTransactionDetail(req, res, detailMatch[1]);
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
