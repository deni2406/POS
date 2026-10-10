# Revert alur pasca-SIMPAN STOCK (simple) — Requirements

Slug: `revert-so-submit-workflow`
Status: Tahap 1 (menunggu persetujuan)

## Latar

Saat ini, setelah tombol **SIMPAN STOCK** sukses, handler otomatis membuka
modal **Detail/Hasil SO** (fungsi `showDetail(createdSoId)`). Ini membuat alur
menjadi tergesa: user yang sekadar mau mencatat tidak dilempar ke detail.
Keputusan: hasil SO cukup diakses lewat **Menu Riwayat & Rekap SO**, bukan
otomatis.

## Cerita pengguna

### CP-1 — Tutup form + konfirmasi sederhana
- Ketika user menekan **SIMPAN STOCK** dan server menjawab sukses,
  maka modal form input SO **tutup** dan muncul **alert sukses sederhana**
  ("Stock Opname berhasil disimpan!").

### CP-2 — Tidak ada lompatan otomatis ke detail
- Ketika submit sukses (dengan atau tanpa `so_id` yang dikembalikan),
  maka **modal Detail SO TIDAK dibuka otomatis**.
- Hasil yang baru disimpan hanya dapat dilihat lewat **Menu Riwayat &
  Rekap SO** (klik item di sana), persis seperti SO lama.

### CP-3 — Sinkronisasi refresher riwayat tetap aktif
- Ketika submit sukses **dan** modal Riwayat sedang terbuka di belakang
  form, maka daftar riwayat + rekap bulanan di-refresh agar baris SO baru
  langsung terlihat.

## Kriteria di luar cakupan (SENGAJA tidak disentuh)

- Logika validasi & payload submit (apa yang dikirim ke `/api/stock-opname/submit`).
- Struktur/UI menu **Riwayat & Rekap SO** itu sendiri (sudah jalan).
- Handler lain di `stock-opname.js` di luar blok `json.success` yang relevan.
- Backend/server (file `www/server.js`, dsb.) — perilaku tidak berubah.
- Styling/CSS SO.

## Batasan / aturan

- **Mirror sync ketat:** setiap perubahan harus dibuat identik di dua file:
  - `C:\POS\stock-opname.js`
  - `C:\POS\www\stock-opname.js`
  - Verifikasi akhir dengan `fc /b` (binary compare) keduanya → harus **no
    differences**.

## Definisi selesai

- Setelah submit sukses, user melihat alert + form tertutup, tanpa lompatan
  ke detail.
- `fc /b stock-opname.js www\stock-opname.js` → no differences.
- Tidak ada perubahan file lain di luar dua berkas mirror tersebut.
