# Handoff — Fix #52: Expose masterBarangCache & Auto-fetch saat Modal Kasir Dibuka (2026-10-11)

## Akar masalah
1. `window.masterBarangCache` undefined saat dashboard init — `loadMasterBarang()` hanya dipanggil
   saat modal master barang dibuka (guard `barangLoaded`), bukan saat dashboard load.
2. Tidak ada auto-fetch saat modal kasir dibuka — `openKasirModal` → `loadKasirTable` membaca
   cache kosong tanpa fetch.
3. Tidak ada variabel modul `masterBarangCache` — hanya `window.masterBarangCache`, tidak
   konsisten.

## Perbaikan
- `let masterBarangCache = Array.isArray(window.masterBarangCache) ? window.masterBarangCache : []`
  di level modul (source of truth).
- `loadMasterBarang` sekarang set **dua** tempat: `masterBarangCache` (modul) + `window.masterBarangCache`.
- Helper `getMasterBarangCache()` — baca modul-variabel, fallback ke `window`. Semua call-site
  (reRenderBarangTable, initHppChart, updateKasirCardMetrics, loadKasirTable) pakai helper.
- `loadMasterBarang` di-wrap: dedupe via `loadMasterBarangPromise` (mencegah double-fetch).
- `updateKasirCardMetrics` & `loadKasirTable` dibuat **async** — auto-`await loadMasterBarang()`
  bila cache kosong.
- `openKasirModal` async: placeholder "Memuat data…", buka modal, `await loadKasirTable()`.

## Verifikasi
- `node --check admin/js/dashboard.js` → SYNTAX OK
- Test browser: dashboard init → stat card Kasir terisi (auto-fetch)
- Klik card Kasir → modal 63 item (filter Fix #51)

## Catatan
- Tidak ada perubahan backend / server — murni frontend.
- Bila user report "double-fetch" di network tab, cek `loadMasterBarangPromise` dedupe
