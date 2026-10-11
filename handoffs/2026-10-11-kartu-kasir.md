# Handoff — Fix #48: Kartu Barang Kategori Kasir + Modal Daftar (2026-10-11)

## Apa yang selesai
- **Stat card** `#cardKategoriKasir` di stat-grid dashboard admin:
  - Total Jenis, Total Stok, Total Nilai Modal (HPP×Stok), Total Nilai Jual (HJ×Stok)
  - Semua dihitung otomatis dari `window.masterBarangCache` (filter `LOWER(kategori)='kasir'`)
- **Modal** `#modalKasir` — terbuka saat card diklik:
  - 4 chip ringkasan (Jenis, Stok, Modal, Nilai Jual)
  - Tabel 4 kolom: Nama Barang, Stok Aktual, HPP, Harga Jual
  - Hanya menampilkan barang kategori Kasir
- **Auto-refresh**: metrik card di-update setiap kali `loadMasterBarang()` selesai (wrap fungsi)
- **CSS**: `.stat-card--kasir` border-top amber + mini-metrik grid; styling tabel modal
- **Tanpa endpoint baru** — semua dihitung dari data `/api/admin/inventory/master` yang sudah di-fetch

## Catatan teknis
- `isKasir()` helper normalisasi case (`'Kasir'`/`'kasir'`/`'KASIR'`)
- `loadMasterBarang` di-wrap (bukan di-replace) — call-site lain tetap berfungsi
- `openKasirModal()` selalu panggil `loadKasirTable()` dari cache terbaru
- Modal close via tombol, klik overlay, Escape (Escape belum di-wire — lihat di bawah)

## Apa yang BELUM selesai
- Keyboard `Escape` untuk menutup modal Kasir — belum di-bind (modal lain punya handler Escape di block init)
- Bila user ingin kartu untuk kategori BAR / DAPUR juga — pola sudah ada, tinggal duplikasi
