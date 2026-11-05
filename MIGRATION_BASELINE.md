# Baseline Migrasi Transaksi ke SQLite

## Kondisi runtime

- SQLite adalah source of truth untuk transaksi penjualan.
- `POST /api/transaksi` menyimpan header, detail, dan perubahan stok secara lokal dalam satu transaksi SQLite.
- `POST /api/transaksi/batalkan` membaca transaksi dan detail dari SQLite, mengembalikan stok, lalu menandai transaksi `BATAL` secara lokal.
- Transaksi penjualan tidak lagi dikirim ke GAS.
- Runtime aktif tidak lagi mencakup `syncTransaction`, `syncPendingTransactions`, `getPendingTransactions`, `updateSyncStatus`, `syncingTransactionIds`, `sync-pending-once.js`, `simpan_penjualan`, atau `batalkan_penjualan`.
- GAS yang masih aktif hanya digunakan untuk fungsi nontransaksi: `get_barang`, `proses_stock_opname`, dan `finalize_stock_opname`.

## Kompatibilitas

- `status_sync` dipertahankan karena masih digunakan untuk status `BATAL` dan tampilan riwayat.
- `sync_at` dipertahankan sementara sebagai metadata kompatibilitas. Schema tidak diubah.
- Backup dan arsip historis yang masih mengandung kode sync transaksi berada di luar runtime dan tidak diubah.

## Cleanup scope

- Menghapus pemanggilan `syncTransaction` setelah transaksi berhasil disimpan.
- Menghapus scheduler `syncPendingTransactions`.
- Menghapus pemanggilan GAS `batalkan_penjualan` dari alur pembatalan.
- Menghapus gate `PENDING` pada endpoint `sync-produk`, karena sinkronisasi produk adalah fungsi nontransaksi.
- Menghapus `statusSync: PENDING` dari response sukses transaksi.
- Menghapus `sync_at` dari perintah `UPDATE` pembatalan.
- Menghapus mekanisme `syncingTransactionIds`.
- Menghapus fungsi `syncPendingTransactions`, `syncTransaction`, `getPendingTransactions`, dan `updateSyncStatus`.
- Menghapus file `sync-pending-once.js`.
- Memperbarui komentar konfigurasi GAS agar tidak lagi menyebut GAS sebagai sinkronisasi transaksi.
- Menghapus komentar legacy `SYNC TRANSAKSI KE GOOGLE`.
- `server.js` memiliki perubahan lain di luar scope cleanup ini. Status asal perubahan tersebut tidak dapat dipastikan dari Git diff saat ini; perubahan itu tidak boleh diubah sebagai bagian cleanup ini.
- Saat durasi sesi meja bertambah, termasuk melalui penambahan qty item 1 Jam, `server.js` memperbarui durasi dan waktu selesai lalu menyinkronkan ulang qty dan subtotal Meja Billiard di `pesanan_meja`, termasuk pembaruan harga per jam berdasarkan harga member bila tersedia.
- Pada `POST /api/transaksi`, untuk Meja Billiard atau 1 Jam dengan sesi valid, qty, harga, dan subtotal berasal dari `pesanan_meja` server; jika item layanan tidak ada di pesanan sesi, transaksi ditolak dengan kode `TABLE_SERVICE_ITEM_NOT_FOUND`.

## Verifikasi terakhir

- `node --check server.js`: PASS.
- Pemeriksaan database terakhir dilakukan secara read-only: 1.322 transaksi, 2.609 detail, total header Rp66.548.500, total detail Rp66.548.500; tidak ada orphan detail dan tidak ada transaksi tanpa detail.

## FINAL CLEANUP CHECKPOINT

- `test/transaksi-harness.js` berhasil dijalankan setelah perbaikan isolasi database: 3 tests PASS, 0 fail.
- Cakupan harness: atomicity rollback; validasi qty/harga tanpa perubahan database; dan `TABLE_SERVICE_ITEM_NOT_FOUND` dengan rollback.
- Harness sekarang menggunakan database temporary terisolasi dan tidak lagi boleh menyentuh `pos.db` production.
- Hasil ini hanya mencatat pengujian harness; runtime production tidak dinyatakan fully tested atau production-ready.

## CHECKPOINT AKTIVASI MIGRASI — 26 SEPTEMBER 2026

- Setelah restart production, proses PM2 `pollarbilliard-pos` kembali online dengan restart count 2.
- Production menggunakan proses baru setelah restart.
- Alur transaksi dan pembatalan telah diverifikasi berjalan SQLite-only.
- Tidak ada transaction sync runtime ke GAS.
- Fungsi GAS yang tersisa hanya fungsi nontransaksi dan stock opname.
- Harness terisolasi menghasilkan 3 tests PASS, 0 fail.
