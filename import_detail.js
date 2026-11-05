const Database = require('better-sqlite3');
const path = require('path');

const mainDbPath = path.join('C:', 'pos', 'pos.db');
const detailDbPath = path.join('C:', 'pos', 'pos_detail_server.db');

console.log('Menghubungkan ke database...');
const db = new Database(mainDbPath);

try {
    // Nonaktifkan foreign key sementara agar tidak gagal saat insert data relasi
    db.pragma('foreign_keys = OFF');
    
    db.prepare(`ATTACH DATABASE ? AS source_detail`).run(detailDbPath);
    console.log('Database backup di-attach. Menyalin data detail...');

    const info = db.prepare(`
        INSERT OR IGNORE INTO detail_transaksi 
        SELECT * FROM source_detail.detail_transaksi
    `).run();

    console.log(`Berhasil mengimpor ${info.changes} baris data detail baru.`);
} catch (err) {
    console.error('Terjadi kesalahan:', err.message);
} finally {
    try { db.prepare(`DETACH DATABASE source_detail`).run(); } catch (e) {}
    try { db.pragma('foreign_keys = ON'); } catch (e) {}
    db.close();
    console.log('Selesai.');
}
