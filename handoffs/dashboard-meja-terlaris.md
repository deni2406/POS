# Fix: Widget Dashboard "Meja Terlaris (Top 10)"
Status: PENDING verifikasi runtime · Service: POS + Admin · Diperbarui: 2026-11-05

## Sedang dikerjakan
- [x] Backend server.js: route `GET /api/dashboard/meja-terlaris` (sebelum blok `/api/riwayat-transaksi`, ~baris 4933),
      WAJIB login kasir (validateLoginSession) karena memuat data omzet finansial
- [x] Backend admin-server.js: `handleDashboardMejaTerlaris()` + dispatch `GET /api/dashboard/meja-terlaris`
- [x] Frontend dashboard.html: widget "Statistik Meja Terlaris (Top 10)" di bawah Grafik Tren Penjualan (panel-keuangan)
- [x] Frontend dashboard.js: `loadTopTables()` — fetch + cache localStorage + render ranking
- [x] Frontend dashboard.css: style badge #1 emas/"Terfavorit", #2 perak, #3 perunggu, row status
- (review senior putaran 1 — sudah dikoreksi, angka teruji):
  - F1 (high) kueri omset: versi awal subquery korelatif di dalam GROUP BY → total_omset keluar
    = omset SATU sesi acak (Meja 1 = 439 sesi tapi hanya Rp 64.000 — tak masuk akal).
    Sudah diganti LEFT JOIN + SUM di server.js & admin-server.js. Hasil baru teruji:
    Meja 1 → Rp 20.184.000, Meja 6 → Rp 12.309.000 (masuk akal untuk 244–439 sesi).
  - F2 (medium) bukti git admin: `git diff --stat` di `admin/` menunjukkan 4 file diubah
    (admin-server.js, admin/css/dashboard.css, admin/dashboard.html, admin/js/dashboard.js)
    — kode handler/widget memang ada, bukan cuma pointer submodule.
  - F3 (medium) auth: route di server.js kini memanggil `validateLoginSession(req,res)`
    persis seperti `/api/riwayat-transaksi`; komentar "publik mengikuti pola riwayat-transaksi"
    sudah dihapus karena menyesatkan.

## Keputusan penting
- `sesi_meja` menyimpan `nomor_meja` sebagai INTEGER (1..10), BUKAN string 'Meja N'
  → kueri memakai `nomor_meja BETWEEN 1 AND 10` (spec user menyebut LIKE 'Meja %' — disesuaikan ke skema riil).
- `total_omset` dihitung dari `transaksi.total` via LEFT JOIN `t.session_id = sm.session_id`,
  filter BATAL/CANCELLED di klausa ON, kolom `total_harga` TIDAK ADA di skema.
  Omzet hanya terisi setelah checkout (sesi AKTIF = 0).
  COUNT(DISTINCT session_id) — guard anti-duplikat.
- Endpoint di server.js WAJIB login kasir (data omzet = data finansial, bukan publik).
  Endpoint di admin-server.js mengikuti pola endpoint admin lain (tanpa guard session khusus);
  bila user ingin admin-server juga dilindungi, tanyakan dulu — keputusan ini milik user.
- Response format: `{ status:"success", data:[{meja,nomor_meja,total_sesi,total_omset}] }`
  (sesuai spec user; `nomor_meja` ditambahkan ekstra, aman).

## Status terakhir
- `node --check` server.js / admin/admin-server.js / admin/admin/js/dashboard.js → OK.
- Query teruji langsung ke pos.db SETELAH perbaikan JOIN (2026-11-05, hasil riil):
  Meja 1 → 439 sesi / Rp 20.184.000 · Meja 10 → 392 / Rp 19.143.500 · Meja 2 → 341 / Rp 17.500.500 ·
  Meja 4 → 296 / Rp 14.576.500 · Meja 9 → 285 / Rp 15.096.000 · Meja 3 → 284 / Rp 14.703.500 ·
  Meja 5 → 283 / Rp 13.871.000 · Meja 8 → 271 / Rp 13.226.000 · Meja 7 → 261 / Rp 13.551.000 ·
  Meja 6 → 244 / Rp 12.309.000.
- `git diff --stat` (admin/): admin-server.js +56 · dashboard.css +68 · dashboard.html +37 ·
  dashboard.js +113 (semua angka dari output perintah, bukan klaim).

## Langkah berikutnya
1. Test runtime: tanyakan ke user apakah admin server (port 3200) boleh direstart/dihidupkan,
   lalu `curl /api/dashboard/meja-terlaris` di kedua server (dengan session login yang valid
   untuk server.js; admin-server tanpa login).
2. Buka dashboard admin → panel Keuangan → widget Top 10 tampil + badge benar.
3. Setelah terverifikasi → tulis entri CHANGELOG_FIXES (di atas marker, sebutkan F1/F3 sebagai
   akar bug yang sudah dikoreksi), lalu hapus handoff ini.

## Jangan lakukan
- Jangan restart admin-server/server.js tanpa izin — instance user sudah berjalan di port 3200
  (EADDRINUSE saat test, respons 404 berasal dari instance LAMA tanpa route baru).
- Jangan ganti `nomor_meja` ke string; skema DB memakai INTEGER.
- Jangan kembalikan kueri ke subquery korelatif di dalam GROUP BY (F1) — hasilnya salah.
