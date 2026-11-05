const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./pos.db', sqlite3.OPEN_READONLY);

db.serialize(() => {
  db.get(`
    SELECT
      id,
      status,
      opening_confirmed,
      saldo_kwh_dalam_awal,
      saldo_kwh_luar_awal,
      kode_tutup,
      pending_close_at,
      pending_close_snapshot
    FROM shift_kasir
    WHERE id = 151
  `, (err, row) => {
    if (err) throw err;

    console.log('=== SHIFT 151 ===');
    console.log({
      id: row.id,
      status: row.status,
      opening_confirmed: row.opening_confirmed,
      kwhDalamAwal: row.saldo_kwh_dalam_awal / 100,
      kwhLuarAwal: row.saldo_kwh_luar_awal / 100,
      kodeTutup: row.kode_tutup,
      pendingCloseAt: row.pending_close_at
    });

    console.log('\n=== SNAPSHOT ===');
    if (!row.pending_close_snapshot) {
      console.log('Tidak ada snapshot.');
      return;
    }

    try {
      const s = JSON.parse(row.pending_close_snapshot);

      console.log({
        status: s.shift?.status,
        kodeTutup: s.kode_tutup,
        kwhDalam: s.kwh?.dalam,
        kwhLuar: s.kwh?.luar,
        generatedAt: s.generatedAt
      });
    } catch (e) {
      console.log('Snapshot tidak bisa diparse:', e.message);
    }
  });

  db.all(`
    SELECT
      id,
      jenis_kwh,
      nominal_pembelian,
      kwh_didapat,
      harga_per_kwh,
      sisa_kwh
    FROM pembelian_kwh
    WHERE shift_id = 151
    ORDER BY id
  `, (err, rows) => {
    if (err) throw err;

    console.log('\n=== PEMBELIAN KWH SHIFT 151 ===');
    console.table(rows.map(r => ({
      id: r.id,
      jenis: r.jenis_kwh,
      nominal: r.nominal_pembelian,
      kwh: r.kwh_didapat / 100,
      hargaPerKwh: r.harga_per_kwh / 100,
      sisaKwh: r.sisa_kwh / 100
    })));
  });

  db.all(`
    SELECT
      id,
      jenis,
      arah,
      nominal,
      status_pelunasan,
      kode_tutup
    FROM rekonsiliasi_kasir
    WHERE shift_id = 151
    ORDER BY id
  `, (err, rows) => {
    if (err) throw err;

    console.log('\n=== REKONSILIASI SHIFT 151 ===');
    console.table(rows);
  });
});

setTimeout(() => db.close(), 500);
