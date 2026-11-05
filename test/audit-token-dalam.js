const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./pos.db', sqlite3.OPEN_READONLY);

db.serialize(() => {
  db.all(`
    SELECT
      id,
      shift_id,
      kasir_id,
      waktu,
      jenis_kwh,
      nominal_pembelian,
      kwh_didapat,
      harga_per_kwh,
      sisa_kwh,
      keterangan
    FROM pembelian_kwh
    ORDER BY id DESC
    LIMIT 5
  `, (err, rows) => {
    if (err) throw err;
    console.log('=== PEMBELIAN KWH ===');
    console.table(rows);
  });

  db.get(`SELECT COUNT(*) AS jumlah FROM kas_masuk`, (err, row) => {
    if (err) throw err;
    console.log('Kas Masuk:', row.jumlah);
  });

  db.get(`SELECT COUNT(*) AS jumlah FROM kas_keluar`, (err, row) => {
    if (err) throw err;
    console.log('Kas Keluar:', row.jumlah);
  });
});

db.close();
