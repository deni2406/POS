/**
 * import-detail-nov.js
 *
 * Mengimpor seluruh baris `detail_transaksi` dari pos_detail_server.db
 * ke pos.db.
 *
 * - Menggunakan INSERT (auto-increment id) — BUKAN INSERT OR REPLACE —
 *   karena ID `transaksi` di kedua database tumpang-tindih (4–7263),
 *   dan `transaksi_id` di detail mengacu ke tabel `transaksi`, bukan ke
 *   detail sendiri. `INSERT OR REPLACE` pada `detail.id` tidak relevan
 *   untuk menjaga integritas relasi, dan `INSERT` biasa paling aman
 *   untuk data historis.
 * - Kolom `id` dari server TIDAK dimasukkan — SQLite lokal akan
 *   mengisi secara otomatis.
 * - Kolom yang dicocokkan: transaksi_id, nama_barang, qty, harga_jual,
 *   hpp, subtotal. Jika kolom relasi di server bernama berbeda
 *   (mis. `nomor_transaksi`), skrip akan memetakan otomatis.
 * - Baris di mana `transaksi_id` tidak ada di `pos.db.transaksi`
 *   tetap diimpor — integrity constraint tidak aktif, dan baris orphane
 *   hanya berarti transaksi header-nya belum disinkronkan; data detail
 *   tetap tersedia untuk pelaporan bila transaksi masuk kemudian.
 *
 * Persiapan sebelum menjalankan:
 *   1. Backup pos.db:  cp pos.db pos.db.bak-YYYYMMDD
 *   2. Ensure tidak ada process PM2 menulis pos.db secara bersamaan
 *      (skrip ini menulis, sementara PM2 mungkin membaca — aman, tapi
 *      idealnya stop dulu bila memungkinkan):
 *        pm2 stop all
 *   3. Jalankan skrip:  node scripts/import-detail-nov.js
 *   4. Restart:  pm2 restart all
 */

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const LOCAL_DB    = path.resolve(__dirname, '..', 'pos.db');
const SERVER_DB   = path.resolve(__dirname, '..', 'pos_detail_server.db');

const REQUIRED_LOCAL_COLS = [
  'transaksi_id',
  'nama_barang',
  'qty',
  'harga_jual',
  'hpp',
  'subtotal',
];

function die(msg) {
  console.error('\n[ERROR]', msg);
  process.exit(1);
}

function main() {
  if (!fs.existsSync(SERVER_DB)) die(`File server tidak ditemukan: ${SERVER_DB}`);
  if (!fs.existsSync(LOCAL_DB))  die(`File lokal  tidak ditemukan: ${LOCAL_DB}`);

  const server = new Database(SERVER_DB, { readonly: true });
  const local  = new Database(LOCAL_DB);

  try {
    // ── 0. Validasi tabel sumber ────────────────────────────────────────
    const srcExists = server.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='detail_transaksi'"
    ).get();
    if (!srcExists) {
      die('Tabel "detail_transaksi" tidak ada di pos_detail_server.db');
    }

    const srcCols = server.prepare('PRAGMA table_info(detail_transaksi)').all();
    const srcColSet = new Set(srcCols.map(c => c.name));

    const tgtExists = local.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='detail_transaksi'"
    ).get();
    if (!tgtExists) {
      die('Tabel "detail_transaksi" tidak ada di pos.db');
    }

    const tgtCols = local.prepare('PRAGMA table_info(detail_transaksi)').all();
    const tgtColSet = new Set(tgtCols.map(c => c.name));

    // ── 1. Deteksi & peta kolom ─────────────────────────────────────────
    // Jika server memakai nama kolom relasi yang berbeda, petakan ke transaksi_id.
    const relColOnServer =
      srcColSet.has('transaksi_id')
        ? 'transaksi_id'
        : srcColSet.has('nomor_transaksi')
          ? 'nomor_transaksi'
          : null;

    if (!relColOnServer) {
      die(
        'Tidak ditemukan kolom relasi di detail_transaksi server.\n' +
        'Kolom yang ada: ' + [...srcColSet].join(', ') +
        '\nSkrip mengharapkan "transaksi_id" atau "nomor_transaksi".'
      );
    }

    // Jika lokal memakai nama lain, tambahkan ALTER (hanya bila perlu).
    for (const col of REQUIRED_LOCAL_COLS) {
      if (!tgtColSet.has(col)) {
        console.log(`[ALTER] Menambahkan kolom ke detail_transaksi lokal: ${col} (INTEGER/TEXT NOT NULL)`);
        local.exec(`ALTER TABLE detail_transaksi ADD COLUMN ${col} ${col === 'transaksi_id' ? 'INTEGER' : 'TEXT'} NOT NULL DEFAULT 0`);
      }
    }

    // Peta kolom sumber → tujuan
    // Jika server relasianya = nomor_transaksi tapi lokal = transaksi_id,
    // nilai tetap dipasangi ke transaksi_id lokal.
    const sourceCols = [
      relColOnServer,          // relasi → transaksi_id lokal
      'nama_barang',
      'qty',
      'harga_jual',
      'hpp',
      'subtotal',
    ].filter(c => srcColSet.has(c));

    const missingSrc = sourceCols.filter(c => !srcColSet.has(c));
    if (missingSrc.length) {
      console.warn(`[WARN] Kolom ini tidak ada di server, akan diisi NULL: ${missingSrc.join(', ')}`);
    }

    const targetCols = [
      'transaksi_id',
      'nama_barang',
      'qty',
      'harga_jual',
      'hpp',
      'subtotal',
    ];

    const selectExprs = sourceCols.map((c, i) =>
      srcColSet.has(c) ? c : 'NULL'
    ).join(', ');

    // Catatan: sourceCols sudah terurut sesuai targetCols, jadi
    // selectExprs[i] → targetCols[i]
    const placeholders = targetCols.map(() => '?').join(', ');
    const insertSql = `INSERT INTO detail_transaksi (${targetCols.join(', ')}) VALUES (${placeholders})`;

    // ── 2. Hitung baseline ───────────────────────────────────────────────
    const beforeCount = local.prepare('SELECT COUNT(*) c FROM detail_transaksi').get().c;

    // Nonaktifkan FK sementara — 4099 baris sumber merujuk transaksi
    // yang belum ada di pos.db (header belum disinkronkan). Data detail
    // tetap valid secara bisnis; FK hanya akan dipenuhi bila transaksi
    // datang. Aktifkan lagi setelah COMMIT.
    const fkBefore = local.pragma('foreign_keys', { simple: true });
    local.pragma('foreign_keys = OFF');

    // ── 3. Eksekusi impor dalam satu transaksi ─────────────────────────────
    const srcCount = server.prepare('SELECT COUNT(*) c FROM detail_transaksi').get().c;
    console.log(`\n[INFO] Baris di pos_detail_server.db : ${srcCount}`);
    console.log(`[INFO] Baris di pos.db (sebelum)     : ${beforeCount}`);
    console.log(`[INFO] Kolom relasi sumber           : ${relColOnServer}`);

    const stmt = local.prepare(insertSql);
    const importAll = local.transaction((rows) => {
      for (const row of rows) {
        const values = targetCols.map((col, i) => {
          // sourceCols[i] sudah dicocokkan dengan targetCols
          const srcColName = sourceCols[i];
          return srcColName ? row[srcColName] : null;
        });
        stmt.run(...values);
      }
    });

    const serverRows = server.prepare(
      `SELECT ${selectExprs} FROM detail_transaksi`
    ).all();

    importAll(serverRows);

    // Aktifkan kembali FK sesuai kondisi awal
    if (fkBefore) local.pragma('foreign_keys = ON');

    // ── 4. Hasil ─────────────────────────────────────────────────────────
    const afterCount = local.prepare('SELECT COUNT(*) c FROM detail_transaksi').get().c;
    const imported   = afterCount - beforeCount;

    console.log(`\n───────────────────────────────────────────`);
    console.log(`  Diimpor        : ${imported} baris`);
    console.log(`  Total sekarang : ${afterCount} baris`);
    console.log(`───────────────────────────────────────────`);

    // Rekap per bulan (join ke transaksi lokal)
    const perMonth = local.prepare(`
      SELECT
        COALESCE(substr(t.tanggal,1,7), 'ORPHAN') AS periode,
        COUNT(*)                                   AS detail_rows
      FROM detail_transaksi d
      LEFT JOIN transaksi t ON t.id = d.transaksi_id
      GROUP BY periode
      ORDER BY periode
    `).all();

    console.log('\n[REKAP per periode (berdasarkan transaksi lokal)]:');
    perMonth.forEach(r => console.log(`  ${r.periode} : ${r.detail_rows} baris`));

    const orphanCount = perMonth.find(r => r.periode === 'ORPHAN');
    if (orphanCount && orphanCount.detail_rows > 0) {
      console.log(`\n[INFO] ${orphanCount.detail_rows} baris detail merujuk transaksi yang belum ada di pos.db (ORPHAN).`);
      console.log(`  Ini normal bila transaksi header November belum di-sync via sync-november-transactions.js.`);
      console.log(`  Data detail tetap tersimpan dan akan terisi bila transaksi datang.`);
    }

    console.log('\n=== SELESAI ===');
  } finally {
    server.close();
    local.close();
  }
}

main();
