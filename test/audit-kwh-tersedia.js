const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./pos.db', sqlite3.OPEN_READONLY);

db.get(`
  SELECT
    s.id AS shift_id,
    s.saldo_kwh_dalam_awal,
    s.saldo_kwh_luar_awal,
    COALESCE(SUM(CASE WHEN p.jenis_kwh = 'DALAM' THEN p.kwh_didapat ELSE 0 END), 0) AS token_dalam,
    COALESCE(SUM(CASE WHEN p.jenis_kwh = 'LUAR' THEN p.kwh_didapat ELSE 0 END), 0) AS token_luar
  FROM shift_kasir s
  LEFT JOIN pembelian_kwh p ON p.shift_id = s.id
  WHERE s.id = 151
  GROUP BY s.id
`, (err, row) => {
  if (err) throw err;

  console.log('=== KWH TERSEDIA SHIFT 151 ===');
  console.log({
    shift: row.shift_id,
    dalamAwal: row.saldo_kwh_dalam_awal / 100,
    tokenDalam: row.token_dalam / 100,
    tersediaDalam: (row.saldo_kwh_dalam_awal + row.token_dalam) / 100,
    luarAwal: row.saldo_kwh_luar_awal / 100,
    tokenLuar: row.token_luar / 100,
    tersediaLuar: (row.saldo_kwh_luar_awal + row.token_luar) / 100
  });

  db.close();
});
