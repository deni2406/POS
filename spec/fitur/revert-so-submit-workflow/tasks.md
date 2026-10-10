# Revert alur pasca-SIMPAN STOCK — Tasks

Slug: `revert-so-submit-workflow`
Status: Tahap 3 (menunggu persetujuan)

Urutan kerja: atas → bawah, satu tugas per giliran. Tandai `[x]` tiap tuntas.

- [ ] **T1 — Hapus pemicu detail di root `C:\POS\stock-opname.js`**
  Di blok `if (json.success)` dalam `submitStockOpname` (sekitar baris 1154),
  hapus 3 baris: `const soId = json.data?.so_id;`,
  komentar `// Auto-buka modal detail setelah simpan sukses`, dan
  `if (soId) showDetail(soId);`.
  Hasil akhir blok = alert → close → refresh riwayat (bila terbuka).
  Memenuhi: CP-1, CP-2.

- [ ] **T2 — Terapkan perubahan identik di mirror `C:\POS\www\stock-opname.js`**
  Edit blok yang sama, hasil byte-identik dengan T1. Memenuhi: aturan mirror
  sync.

- [ ] **T3 — Verifikasi sintaks kedua file**
  Jalankan `node --check C:\POS\stock-opname.js` dan
  `node --check C:\POS\www\stock-opname.js` → keduanya tanpa error.

- [ ] **T4 — Verifikasi mirror sync biner**
  Jalankan `fc.exe /b C:\POS\stock-opname.js C:\POS\www\stock-opname.js`
  → "FC: no differences encountered."

- [ ] **T5 — Verifikasi `showDetail` tak lagi di blok success**
  grep `showDetail` di `stock-opname.js` → hanya muncul di tombol "Detail"
  tabel riwayat (~baris 754) dan namespace publik (~baris 1185), TIDAK di
  dalam `if (json.success)`. Memenuhi: CP-2.
