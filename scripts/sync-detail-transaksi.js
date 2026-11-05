/**
 * sync-detail-transaksi.js
 *
 * Mengambil data detail_transaksi dari pos_server.db dan
 * mengimpor ke pos.db (INSERT OR REPLACE, tanpa kolom id).
 *
 * Peringatan: pos_server.db saat ini HANYA berisi tabel `transaksi`.
 * Tabel `detail_transaksi` tidak ada di sana.
 *
 * Jika data detail ada di database lain (mis. www/pos.db),
 * ubah variabel SERVER_DB di bawah.
 */

const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const LOCAL_DB = path.resolve(__dirname, '..', 'pos.db');
const SERVER_DB = path.resolve(__dirname, '..', 'pos_server.db');

function openReadonly(file) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(file, sqlite3.OPEN_READONLY, (err) =>
      err ? reject(err) : resolve(db)
    );
  });
}

function openReadWrite(file) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(file, (err) =>
      err ? reject(err) : resolve(db)
    );
  });
}

function all(db, sql, params = []) {
  return new Promise((resolve, reject) =>
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)))
  );
}

function get(db, sql, params = []) {
  return new Promise((resolve, reject) =>
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)))
  );
}

async function main() {
  console.log('=== SYNC DETAIL TRANSAKSI ===\n');
  console.log(`Local  DB : ${LOCAL_DB}`);
  console.log(`Server DB : ${SERVER_DB}\n`);

  const [localDb, serverDb] = await Promise.all([
    openReadWrite(LOCAL_DB),
    openReadonly(SERVER_DB),
  ]);

  try {
    // -- Cek apakah tabel detail_transaksi ada di server --
    const tables = await all(
      serverDb,
      "SELECT name FROM sqlite_master WHERE type='table' AND name='detail_transaksi'"
    );
    if (tables.length === 0) {
      console.error('TABEL "detail_transaksi" TIDAK ADA di pos_server.db.');
      console.error('Server hanya memiliki tabel:');
      const allTables = await all(serverDb, "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'");
      allTables.forEach(t => console.error('  -', t.name));
      console.error('\nSkrip dihentikan. Pindahkan data detail ke pos_server.db dahulu,');
      console.error('atau ubah SERVER_DB ke database yang memuat detail_transaksi.');
      process.exit(1);
    }

    // -- Ambil semua baris detail_transaksi --
    const rows = await all(serverDb, 'SELECT * FROM detail_transaksi');
    console.log(`Jumlah baris detail_transaksi di server : ${rows.length}`);

    if (rows.length === 0) {
      console.log('Tidak ada data untuk di-sync.');
      return;
    }

    // -- Cocokkan skema: ambil kolom server (tanpa id) --
    const serverCols = await all(serverDb, 'PRAGMA table_info(detail_transaksi)');
    const localCols  = await all(localDb, 'PRAGMA table_info(detail_transaksi)');
    const localColSet = new Set(localCols.map(c => c.name));

    // kolom yang ada di server TAPI tidak ada di lokal → tambahkan dulu
    const missing = serverCols.filter(c => c.name !== 'id' && !localColSet.has(c.name));
    if (missing.length > 0) {
      console.log('\nKolom kurang di lokal, akan ditambahkan:');
      const exec = (sql) =>
        new Promise((resolve, reject) =>
          localDb.exec(sql, (err) => (err ? reject(err) : resolve()))
        );
      for (const col of missing) {
        const sql = `ALTER TABLE detail_transaksi ADD COLUMN ${col.name} ${col.type || 'TEXT'}${col.default_value ? ` DEFAULT ${col.default_value}` : ''};`;
        console.log(`  -> ${sql}`);
        await exec(sql);
      }
      console.log('Skema lokal diperbarui.\n');
    }

    // -- Siapkan INSERT OR REPLACE --
    const colNames = serverCols.map(c => c.name).filter(n => n !== 'id');
    const colPlaceholders = colNames.map(() => '?').join(', ');
    const insertSql = `
      INSERT OR REPLACE INTO detail_transaksi (${colNames.join(', ')})
      VALUES (${colPlaceholders})`;

    // -- Eksekusi batch dalam satu transaksi --
    let successCount = 0;
    let failCount = 0;

    await new Promise((resolve, reject) => {
      localDb.serialize();
      localDb.run('BEGIN TRANSACTION', (err) => {
        if (err) return reject(err);
        let done = 0;
        for (const row of rows) {
          const values = colNames.map(col => row[col]);
          localDb.run(insertSql, values, (err) => {
            if (err) {
              failCount++;
              if (failCount <= 3) console.warn(`  Fail: ${err.message}`);
            } else {
              successCount++;
            }
            done++;
            if (done === rows.length) {
              localDb.run('COMMIT', (cErr) => {
                if (cErr) return reject(cErr);
                resolve();
              });
            }
          });
        }
      });
    });

    if (failCount > 0) {
      console.warn(`\nPeringatan: ${failCount} baris gagal.`);
    }

    // -- Ringkasan --
    const localTotal = await get(localDb, 'SELECT COUNT(*) as c FROM detail_transaksi');
    console.log(`\nBaris berhasil dimasukkan     : ${successCount}`);
    console.log(`Total baris di pos.db sekarang  : ${localTotal.c}`);

    const omsetRow = await get(
      localDb,
      `SELECT COALESCE(SUM(dt.subtotal), 0) AS total, COUNT(*) AS jml
       FROM detail_transaksi dt
       JOIN transaksi t ON dt.transaksi_id = t.id
       WHERE t.tanggal LIKE '2026-11%'`
    );
    console.log(`Detail November 2026 baris      : ${omsetRow.jml}`);
    console.log(`Total nominal breakdown November: Rp ${omsetRow.total.toLocaleString('id-ID')}`);

    console.log('\n=== SELESAI ===');
  } finally {
    localDb.close();
    serverDb.close();
  }
}

main().catch((err) => {
  console.error('GAGAL:', err.message);
  process.exit(1);
});
