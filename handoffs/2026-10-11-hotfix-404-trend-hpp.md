# Handoff — Fix #49: Hotfix 404 `/api/admin/pembelian/trend-hpp` + Crash Loop Migrasi (2026-10-11)

## Akar masalah
1. **`parsed.get` tidak valid** — `handleAdminPembelianTrendHpp` (Fix #47) memakai `parsed.get('barang_id')`
   (API `URLSearchParams`), padahal `parsed` adalah objek dari `url.parse(req.url, true)` yang
   query-nya diakses via `parsed.query.barang_id`. Ini crash di `admin-server.js:2093` dan membuat
   route tidak ter-register → endpoint 404.
2. **Crash loop migrasi PRAGMA shift_kasir** — `db.all('PRAGMA table_info(shift_kasir)')` kadang
   mengembalikan nilai non-array (undefined/object tunggal) tergantung versi node-sqlite3,
   membuat `rows.map()` throw di line 63. PM2 restart count naik ke 78.
3. **Migrasi `kategori_target` kurang robust** — `db.get('SELECT kategori_target ...')` throw
   SQLITE_ERROR bila kolom belum ada.

## Perbaikan
- `parsed.get('x')` → `const q = parsed.query || {}; q.x` di `handleAdminPembelianTrendHpp`
- Guard PRAGMA shift_kasir diperluas: aman untuk undefined, string, number, object tunggal
- Migrasi `kategori_target` diganti: cek `PRAGMA table_info(pembelian)` dulu, `ALTER` hanya bila kolom hilang

## Verifikasi
- `curl /api/admin/pembelian/trend-hpp` → **200** `{"success":true,...}`
- `curl ?kategori=kasir` → **200**, `items` berisi kategori KASIR
- PM2 stable, restart count tidak naik lagi

## Catatan penting
- **Semua handler API baru** harus cek: query param via `parsed.query.xxx`, bukan `parsed.get()`
- Selalu `curl` setiap endpoint baru sebelum declare fix selesai
