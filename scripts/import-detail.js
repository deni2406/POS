const Database = require('better-sqlite3');
const fs = require('fs');

const targetDbPath = 'C:\\pos\\pos.db';
const sourceDbPath = 'C:\\pos\\pos_detail_server.db';

console.log('--- PBMS Detail Transaction Import Tool ---');

if (!fs.existsSync(targetDbPath)) {
  console.error(`[Error] Database target tidak ditemukan di: ${targetDbPath}`);
  process.exit(1);
}

if (!fs.existsSync(sourceDbPath)) {
  console.error(`[Error] Database source tidak ditemukan di: ${sourceDbPath}`);
  process.exit(1);
}

const db = new Database(targetDbPath);

try {
  const formattedSourcePath = sourceDbPath.replace(/\\/g, '/');
  db.exec(`ATTACH DATABASE '${formattedSourcePath}' AS source_db;`);
  console.log('✓ Berhasil mengaitkan pos_detail_server.db ke DB utama.');

  const sourceTables = db.prepare(`SELECT name FROM source_db.sqlite_master WHERE type='table'`).all().map(t => t.name);
  const targetTables = db.prepare(`SELECT name FROM main.sqlite_master WHERE type='table'`).all().map(t => t.name);

  const detailCandidates = ['transaction_details', 'sale_items', 'order_items', 'details', 'detail_transaksi'];
  const targetDetailTable = targetTables.find(t => detailCandidates.includes(t.toLowerCase()))
    || targetTables.find(t => t.includes('detail'))
    || 'transaction_details';

  const sourceDetailTable = sourceTables.find(t => detailCandidates.includes(t.toLowerCase()))
    || sourceTables.find(t => t.includes('detail'))
    || targetDetailTable;

  const mainTxTable = targetTables.find(t => ['transaksi', 'transactions', 'sales', 'orders'].includes(t.toLowerCase()))
    || 'transaksi';

  console.log(`- Tabel Target Detail   : ${targetDetailTable}`);
  console.log(`- Tabel Source Detail   : ${sourceDetailTable}`);
  console.log(`- Tabel Transaksi Utama : ${mainTxTable}`);

  const targetColumnsInfo = db.prepare(`PRAGMA main.table_info(${targetDetailTable})`).all();
  const columns = targetColumnsInfo.map(c => c.name);
  const columnListStr = columns.join(', ');

  const txCol = columns.find(c => ['transaction_id', 'trans_id', 'sale_id', 'order_id', 'transaksi_id'].includes(c.toLowerCase()))
    || 'transaksi_id';

  const executeImport = db.transaction(() => {
    const query = `
      INSERT OR IGNORE INTO main.${targetDetailTable} (${columnListStr})
      SELECT ${columnListStr}
      FROM source_db.${sourceDetailTable}
      WHERE ${txCol} IN (
        SELECT id FROM main.${mainTxTable}
      );
    `;
    const stmt = db.prepare(query);
    const info = stmt.run();
    return info.changes;
  });

  const insertedRows = executeImport();
  console.log(`\nSUkses: ${insertedRows} baris detail transaksi berhasil diimpor ke '${targetDetailTable}'.`);

  const countStmt = db.prepare(`SELECT COUNT(*) as total FROM main.${targetDetailTable}`).get();
  console.log(`Total Baris Detail Sekarang di ${targetDetailTable}: ${countStmt.total}`);

} catch (err) {
  console.error('\nGAGAL MENGIMPOR DATA:', err.message);
} finally {
  try {
    db.exec(`DETACH DATABASE source_db;`);
  } catch (e) {}
  db.close();
}
