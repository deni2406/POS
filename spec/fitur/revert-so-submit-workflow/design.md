# Revert alur pasca-SIMPAN STOCK — Design

Slug: `revert-so-submit-workflow`
Status: Tahap 2 (menunggu persetujuan)

## Temuan saat baca kode (berbeda dari kutipan prompt)

Blok `json.success` di file **aktual** (baris 1154–1164, `C:\POS\stock-opname.js`
dan `C:\POS\www\stock-opname.js`) berbentuk:

```js
if (json.success) {
  const soId = json.data?.so_id;
  alert('Stock Opname berhasil disimpan!');
  closeStockOpnameModal();
  // Auto-buka modal detail setelah simpan sukses
  if (soId) showDetail(soId);
  // Refresh history if open
  if (document.getElementById('soHistoryModal') && !document.getElementById('soHistoryModal').classList.contains('hidden')) {
    loadHistory();
    loadRekapBulanan(document.getElementById('soFilterBulan')?.value || todayYYYYMM());
  }
}
```

Perbedaan vs kutipan prompt: variabel bernama `soId` (bukan `createdSoId`);
urutan alert→close sudah benar; `if (soId) showDetail(soId)` berada **sebelum**
blok refresh.

## Pendekatan

**Minimal-diff**: cukup **hapus** dua baris —
- `if (soId) showDetail(soId);`
- komentar `// Auto-buka modal detail setelah simpan sukses`

Baris `const soId = json.data?.so_id;` ikut dihapus karena jadi tak terpakai
(unused), dan baris alert/close/refresh sudah berada pada urutan yang
dikehendaki. Hasil akhir blok:

```js
if (json.success) {
  alert('Stock Opname berhasil disimpan!');
  closeStockOpnameModal();
  // Refresh history if open
  if (document.getElementById('soHistoryModal') && !document.getElementById('soHistoryModal').classList.contains('hidden')) {
    loadHistory();
    loadRekapBulanan(document.getElementById('soFilterBulan')?.value || todayYYYYMM());
  }
}
```

Catatan: `showDetail` tetap dipaparkan di namespace publik (baris 1185) dan
tetap dipakai tombol "Detail" di tabel riwayat (baris 754) — sehingga akses
manual ke hasil lewat Menu Riwayat & Rekap SO tetap berfungsi. Tidak ada
fungsi lain yang dihapus.

## Berkas yang disentuh

- `C:\POS\stock-opname.js` — satu blok `json.success` di dalam `submitStockOpname`.
- `C:\POS\www\stock-opname.js` — perubahan identik (mirror).

Tidak ada berkas lain yang diubah (termasuk `www/server.js`, CSS, HTML).

## Penanganan galat

Tidak ada jalur error baru. Blok `else { alert('Gagal menyimpan: ' + ...) }`
dan `catch { alert('Error: ' + ...) }` tidak disentuh.

## Keputusan + alasan

| Keputusan | Alasan |
|---|---|
| Hapus `const soId` juga | Jadi unused setelah `showDetail` dihapus; hindari variabel mati. |
| Pertahankan blok refresh riwayat | Sesuai CP-3: bila modal Riwayat terbuka, baris SO baru langsung terlihat. |
| Mirror sync identik byte-untuk-byte | Aturan proyek; verifikasi dengan `fc /b`. |

## Verifikasi (kriteria selesai)

1. `node --check C:\POS\stock-opname.js` → tanpa error.
2. `node --check C:\POS\www\stock-opname.js` → tanpa error.
3. `fc.exe /b C:\POS\stock-opname.js C:\POS\www\stock-opname.js` →
   "no differences encountered."
4. grep `showDetail` di blok `json.success` → tidak ada (hanya di tombol
   riwayat & namespace publik).
