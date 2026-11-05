# PBMS: status migrasi dari GAS

Audit runtime dilakukan pada 2026-10-02. Database `pos.db` hanya dibaca selama audit; tidak ada backup/migrasi data karena belum ada penulisan ke database.

## Sumber data yang diperiksa

| Tabel | Baris | Peran |
| --- | ---: | --- |
| `master_barang` | 113 | Katalog operasional. `id` integer lokal adalah identitas stabil; `id_barang` tidak unik dan tidak aman sebagai kunci penggabungan. |
| `harga_member_cache` | 6 | Aturan harga lokal yang dipakai `getHargaMemberDariCache`; pembacaan ini dipertahankan. Tidak ada sumber lokal master harga lebih lengkap yang terbukti. |
| `member` | 137 | Data member lokal. |
| `member_cache` | 137 | Cache baca member lokal. |
| `stock_opname` | 0 | Header SO. |
| `stock_opname_detail` | 0 | Rincian SO. |

Schema keenam tabel diperiksa dari `PRAGMA table_info`. Tidak ada field yang ditulis atau dihapus.

## Perilaku yang dipindahkan / dihentikan

- GET `/api/barang` dan muat ulang katalog membaca `master_barang` lokal. Tombol kini hanya memuat ulang data; POST `/api/sync-produk` dipertahankan sebagai stub kompatibilitas HTTP 410 dan tidak mengubah katalog/harga.
- `syncProduk()` lama mengambil `get_barang`, menghapus seluruh `master_barang`, lalu memasukkan ulang berdasarkan `id_barang`. Ini dapat mengubah ID lokal, relasi, stok, dan menggabungkan identitas duplikat; operasi tersebut telah dihapus.
- Cache harga member tidak lagi dihapus/diisi dari endpoint harga eksternal. Harga transaksi tetap membaca enam aturan lokal yang ada. Belum ada alat pengelolaan harga lokal terverifikasi; jangan menambah harga berdasarkan tebakan.
- Registrasi/member berjalan lewat endpoint dan tabel SQLite (`member`, `member_cache`). Connector eksternal tidak lagi digunakan. Pemeriksaan status harian legacy tetap nonaktif karena aturannya belum terverifikasi.
- Audit pencarian runtime menemukan pemanggilan connector GAS hanya di sinkronisasi katalog/harga dan proses/finalisasi SO. Transaksi utama serta fitur member memakai SQLite.
- Jalur SO lokal hanya menyimpan draft dan selisih kuantitas. Detail mengikat `master_barang.id` melalui `local_master_barang_id`, sehingga produk dengan `id_barang` sama tetap terpisah. Nominal plus/minus/kerugian masih nol dan finalisasi tidak tersedia.
- SO legacy sebelumnya mengirim `proses_stock_opname`, mendukung satu revisi in-place, mengganti rincian saat revisi, dan menyimpan nominal hasil GAS. Finalisasi mengirim persetujuan `APPROVED` sebelum mengunci status `FINAL`. Rumus nominal, audit trail revisi, otorisasi approver, dan efek stok tidak terbukti setara lokal. Endpoint proses legacy dan finalisasi menolak dengan HTTP 503; tidak ada migrasi destruktif.

## Rahasia

Kredensial connector GAS/API key tidak dipakai runtime lagi. `MANAGER_TOTP_SECRET` sekarang hanya dibaca dari environment process (contoh nama variabel di `.env.example`). Nilai yang sebelumnya tertanam di konfigurasi harus dianggap terekspos: rotasi secret TOTP dan update service manager deployment. Cabut API key lama di pihak pemilik endpoint bila ternyata digunakan aplikasi lain. Jangan menaruh nilai rahasia ke log atau dokumen.

## Referensi GAS yang tersisa

Tidak ada connector/fetch GAS aktif pada server atau CLI. `/api/sync-produk` adalah stub 410; proses/finalisasi SO legacy menolak 503. `stock-opname-legacy.js` hanya memberi penolakan aman, sementara komentar UI/tes menjelaskan pembatasan dan aturan yang belum diketahui. Shadow source adapter dan runner manual tetap ada sebagai stub disabled yang tidak mengirim request.

Referensi tersisa berada di bahan historis/non-build: `MIGRATION_BASELINE.md`, bagian historis `PBMS-MASTER-BARANG-AUDIT.md`, `server.js.lamp-fix-tested`, `index-check.html`/`index-check.js`, `99_DebugMemberNode.js.disabled`, skrip patch `patch-disable-member-gas-config.js` dan `patch-remove-member-*.js`, arsip `backup/`, file `*.before-*`/`*.pre-*`, `apk-check/`, dan APK lama. `config.js.pre-member-gas-disconnect-20260922` serta `gas-member.js.pre-disconnect-20260922` adalah salinan lama yang mungkin masih memuat kredensial; keduanya tidak dipakai runtime dan tidak diedit agar arsip kerja tetap utuh. Batasi aksesnya dan rotasi kredensial terkait.

Spreadsheet tidak diubah. Pemilik harus mengidentifikasi spreadsheet/cakupan dan mengonfirmasi backup sebelum penanganan manual.

## Verifikasi manual

1. Muat katalog di POS/Android dan pastikan jumlah produk serta ID tetap sama.
2. Jalankan transaksi produk dan sesi meja untuk member yang memiliki aturan cache; bandingkan nominal dengan struk historis yang disetujui.
3. Pastikan tombol muat ulang tidak mengubah `master_barang` maupun `harga_member_cache`.
4. Jangan revisi/finalisasi SO produksi sebelum pemilik bisnis menetapkan rumus nominal, revisi, approver, efek stok, dan audit history lokal.
5. Konfirmasi identitas spreadsheet dan backup sebelum tindakan manual apa pun.
