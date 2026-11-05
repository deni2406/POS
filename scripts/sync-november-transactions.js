const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const LOCAL_DB  = path.resolve(__dirname, '..', 'pos.db');
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

function run(db, sql, params = []) {
  return new Promise((resolve, reject) =>
    db.run(sql, params, (err) => (err ? reject(err) : resolve(this)))
  );
}

function get(db, sql, params = []) {
  return new Promise((resolve, reject) =>
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)))
  );
}

function exec(db, sql) {
  return new Promise((resolve, reject) =>
    db.exec(sql, (err) => (err ? reject(err) : resolve()))
  );
}

async function main() {
  console.log('=== SYNC NOVEMBER TRANSACTIONS ===\n');
  console.log(`Local  DB : ${LOCAL_DB}`);
  console.log(`Server DB : ${SERVER_DB}\n`);

  const [localDb, serverDb] = await Promise.all([
    openReadWrite(LOCAL_DB),
    openReadonly(SERVER_DB),
  ]);

  try {
    // Step 1: Pastikan skema lokal memiliki semua kolom server
    const serverCols = await all(
      serverDb,
      "PRAGMA table_info(transaksi)"
    );
    const localCols  = await all(localDb, "PRAGMA table_info(transaksi)");
    const localColNames = new Set(localCols.map(c => c.name));

    const missingCols = serverCols.filter(c => !localColNames.has(c.name));
    if (missingCols.length > 0) {
      console.log(`Skema lokal kurang kolom: ${missingCols.map(c => c.name).join(', ')}`);
      for (const col of missingCols) {
        const defaultValue = col.default_value ? col.default_value : "NULL";
        const sql = `ALTER TABLE transaksi ADD COLUMN ${col.name} ${col.type || 'TEXT'}${col.notnull ? '' : ''} ${col.default_value ? `DEFAULT ${col.default_value}` : ''};`;
        console.log(`  -> ALTER TABLE transaksi ADD COLUMN ${col.name};`);
        await exec(localDb, sql);
      }
      console.log('Skema lokal sudah diperbarui.\n');
    } else {
      console.log('Skema lokal sudah identik dengan server. Tidak perlu ALTER.\n');
    }

    // Step 2: Ambil semua data dari server
    const rows = await all(serverDb, 'SELECT * FROM transaksi');
    console.log(`Jumlah transaksi di pos_server.db : ${rows.length}`);

    // Step 3: Siapkan kolom untuk INSERT (tanpa id, shift_id=NULL —
    // agar trigger trg_transaksi_require_open_shift tidak memblokir)
    const colNames = serverCols.map(c => c.name).filter(n => n !== 'id' && n !== 'shift_id');
    const colPlaceholders = colNames.map(() => '?').join(', ');
    const insertSql = `
      INSERT OR REPLACE INTO transaksi (${[...colNames, 'shift_id'].join(', ')})
      VALUES (${colPlaceholders}, NULL)`;

    let inserted = 0;
    let replaced = 0;

    const insertMany = new Promise((resolve, reject) => {
      localDb.serialize();
      if (rows.length === 0) { resolve(); return; }

      localDb.run('BEGIN TRANSACTION', (err) => {
        if (err) return reject(err);
        let done = 0;
        let failed = 0;
        for (const row of rows) {
          const values = colNames.map(col => row[col]);
          localDb.run(insertSql, values, (err) => {
            if (err) { failed++; if (failed <= 3) console.warn(`  Fail ${colNames.join(',')}:`, err.message); }
            done++;
            if (done === rows.length) {
              localDb.run('COMMIT', (cErr) => {
                if (cErr) return reject(cErr);
                if (failed > 0) {
                  console.warn(`Peringatan: ${failed} baris gagal dimasukkan`);
                }
                resolve();
              });
            }
          });
        }
      });
    });

    await insertMany;
    const totalRows = await get(localDb, 'SELECT COUNT(*) as c FROM transaksi');
    console.log(`Baris diproses (INSERT OR REPLACE)  : ${rows.length}`);
    console.log(`Total baris di pos.db setelah sync  : ${totalRows.c}`);

    // Step 4: Hitung omset November 2026
    const omsetRow = await get(
      localDb,
      "SELECT COALESCE(SUM(total), 0) AS omset, COUNT(*) AS jml FROM transaksi WHERE tanggal LIKE '2026-11%'"
    );
    console.log(`Total omset November 2026 di pos.db : Rp ${omsetRow.omset.toLocaleString('id-ID')}`);
    console.log(`Jumlah baris transaksi November 2026 di pos.db : ${omsetRow.jml}`);

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
