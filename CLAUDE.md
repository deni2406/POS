# Instruksi Proyek (adaVIBE)

Berkas ini dibaca mesin tiap sesi. Ringkas dengan sengaja — instruksi panjang
justru diabaikan.

## Memori perbaikan — CHANGELOG_FIXES.md
SEBELUM memperbaiki bug: cari riwayatnya dulu (jangan baca seluruh file).
```
grep -n -i "<gejala|komponen>" CHANGELOG_FIXES.md
```
Banyak bug adalah regresi/kembaran fix lama — akarnya sudah tercatat. Sebutkan
temuan itu sebelum mulai.

SESUDAH fix TERBUKTI bekerja: tambah entri di paling ATAS —
`### Fix #N — Judul: Gejala + Akar`, lalu: Tanggal · File · Masalah · Akar ·
Fix · Verifikasi · Pelajaran. Hanya tulis yang sudah terverifikasi (ada bukti);
sertakan angka nyata, bukan klaim umum.

## Serah-terima — handoffs/
Satu berkas per pekerjaan yang MELEWATI batas sesi. Fix kecil yang selesai
langsung ke changelog, tanpa handoff. Tulis rencana ke berkas SAAT disusun,
bukan disimpan di kepala.

## Kebiasaan
- Jalankan test sebelum menyatakan selesai.
- Jangan jalankan perintah perusak (rm -rf, DROP, migrate:fresh, force-push)
  tanpa konfirmasi eksplisit.
