# Handoff — Fix #47: Fluktuasi HPP vs Harga Jual & Margin Warning (2026-10-11)

## Apa yang selesai
- **GET /api/admin/pembelian/trend-hpp** — query `?barang_id=&kategori=`, JOIN `detail_pembelian × pembelian × master_barang`
- **PUT /api/admin/inventory/price** — quick-update HPP/harga_jual satu barang tanpa transaksi
- **Widget "Fluktuasi HPP vs Harga Jual"** di dashboard — Canvas line chart 2 garis (HPP amber + Harga Jual cyan), area margin hijau pucat, tooltip hover, filter dropdown kategori + barang
- **Widget "Margin Squeeze Warning"** — daftar barang margin < 20% (badge critical <10% / low), tombol aksi "Ubah Harga"
- **Modal Ubah Harga Cepat** — 420px, live preview margin, simpan via PUT endpoint

## Catatan teknis
- `hppKategoriFilter` & `hppBarangFilter` di `dashboard.js` — state filter aktif
- Dropdown kategori di-init dari `window.masterBarangCache` (sudah di-load saat dashboard init)
- Dropdown barang di-filter mengikuti kategori aktif
- Cache localStorage: `pbms_cached_hpp_trend` (key `pbms_cached_hpp_trend`)
- Chart meta `_hppMeta` modul-scope untuk tooltip hover (pola Fix #40 — listener di-bind satu kali)
- Margin warning max 12 item ditampilkan + "+ N item lainnya" jika lebih
- `PUT /api/admin/inventory/price` hanya ubah `hpp` & `harga_jual` di `master_barang`, tanpa transaksi

## Apa yang BELUM selesai (Phase 4 — bila diminta user)
- Filter histori per kategori di panel "Histori Pembelian" (parameter `?kategori=`)
- Grafik per barang individual (pilih satu barang → line chart HPP/HJ per tanggal, bukan agregat)
- Ekspor histori (CSV/PDF)
- Notifikasi push/pull ketika margin squeeze mendadak (mis. HPP naik tiba-tiba)
- Threshold margin yang bisa dikustomisasi (saat ini hard-coded 20%)
