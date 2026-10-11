# Handoff — Fix #53: Cek Stok Kritis (< 2) & Buat PO Kasir (2026-10-11)

## Fitur
Tombol "Cek Stok Kritis (< 2) & Buat PO" di `#modalKasir` yang:
1. Baca `getMasterBarangCache()` → filter `isKasir && stok < 2`
2. **0 item kritis** → tampilkan baris sukses di tabel kasir (tidak buka modal Pembelian)
3. **Ada item kritis** → kosongkan `pemCart`, isi ulang dengan `qty=10` per item,
   `setPemKategori('KASIR')`, buka `#modalPembelian` (ringkasan auto-hitung via `renderPemCart`)

## State DB saat ini (verifikasi)
4 item kasir kritis:
- Za Putih (stok 1), Bear Brand (stok 0), Bintang Zero (stok 0), Oronamin (stok 1)

## Catatan teknis
- Field cache: `stok` (bukan `stok_riil`) — endpoint `inventory/master` map `stok_aktual AS stok`
- HPP/HJ di cart di-default ke nilai saat ini (`harga_modal`, `harga_jual`) — user bisa edit
- `qty: 10` per item (default, bisa diedit manual di tabel cart)
- Baris sukses pakai `data-kasir-ok` attribute untuk detect & remove saat re-check

## File yang diub
- `admin/dashboard.html` — tombol `#btnKasirCekStokKritis`
- `admin/js/dashboard.js` — `cekStokKritisKasir()` + `safeAddEventListener`
- `admin/css/dashboard.css` — `.btn-kasir-check-poor`, `.kasir-stock-ok`
