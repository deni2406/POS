# Audit PBMS — Pencatatan Pembelian KWh

Catatan ini merangkum temuan audit yang sudah tercatat pada pekerjaan PBMS sebelumnya. Tidak ada audit ulang terhadap database atau source code yang dilakukan untuk membuat dokumen ini. Hasil di bawah membedakan fakta yang terverifikasi dari schema yang baru didefinisikan oleh migration.

## 1. Sumber data PBMS yang ditemukan

- Database SQLite project: `pos.db`.
- Tabel PBMS yang ditemukan pada audit struktur terkait: `kasir`, `shift_kasir`, `kas_masuk`, dan `kas_keluar`.
- Tabel `pembelian_kwh` belum ada pada saat dry-run migration awal.
- Endpoint pencatatan yang sudah digunakan UI: `POST /api/pembelian-kwh`.
- Audit read-only setelah implementasi UI mencatat **0 row** di `pembelian_kwh` pada database production saat itu.

## 2. Format sumber data

- Sumber persisten adalah database SQLite `pos.db`.
- Input endpoint adalah JSON dari UI. Payload yang diaudit berisi `jenis_kwh`, `nominal_pembelian`, `kwh_didapat`, dan `keterangan` bila diisi.
- Harga modal/KWh ditampilkan UI dari response server, bukan dipercaya dari nilai input client.
- KWh disimpan sebagai integer dengan skala x100 pada schema yang didefinisikan migration. Contoh yang terdokumentasi: `1,23 KWh` disimpan sebagai `123`.

## 3. Struktur/nama kolom atau field

Schema target pada `create-pembelian-kwh.js` mendefinisikan tabel `pembelian_kwh` dengan field:

| Kolom | Struktur/aturan yang didefinisikan |
|---|---|
| `id` | `INTEGER PRIMARY KEY AUTOINCREMENT` |
| `shift_id` | `INTEGER NOT NULL`, foreign key ke `shift_kasir(id)` |
| `kasir_id` | `INTEGER NOT NULL`, foreign key ke `kasir(id)` |
| `waktu` | `TEXT NOT NULL` |
| `jenis_kwh` | `TEXT NOT NULL`, dibatasi ke `DALAM` atau `LUAR` |
| `nominal_pembelian` | `INTEGER NOT NULL`, harus integer dan non-negatif |
| `kwh_didapat` | `INTEGER NOT NULL`, harus integer positif dan memakai skala x100 |
| `harga_per_kwh` | Kolom generated `REAL`, dihitung sebagai `nominal_pembelian * 100 / kwh_didapat` |
| `sisa_kwh` | `INTEGER NOT NULL`, dibatasi dari 0 sampai `kwh_didapat`; trigger migration menginisialisasi nilainya ke `kwh_didapat` |
| `keterangan` | `TEXT NOT NULL DEFAULT ''` |

Migration awal berjalan dalam mode dry-run dan tidak dijalankan dengan `--apply`; karena itu keberadaan schema target tersebut tidak membuktikan tabel production sudah dibuat. Catatan implementasi UI berikutnya melaporkan endpoint sudah ada, tetapi tidak mencatat hasil inspeksi schema production setelah migration.

Field payload UI yang terverifikasi: `jenis_kwh`, `nominal_pembelian`, `kwh_didapat`, dan `keterangan` opsional. UI tidak mengirim `harga_per_kwh`, `shiftId`, atau ID kasir sebagai input tepercaya.

## 4. File dan fungsi kode terkait PBMS

- `create-pembelian-kwh.js` — migration schema `pembelian_kwh`; dry-run sebagai default dan `--apply` untuk pembuatan tabel.
- `server.js:2813–2890` — route `POST /api/pembelian-kwh`; memilih shift berstatus OPEN berdasarkan sesi kasir terautentikasi, bukan ID shift dari payload.
- `index.html:1811` — item menu UI pembelian token.
- `index.html:2527` — modal/form dan hasil pencatatan.
- `index.html:2631` — styling responsif terkait UI.
- `index.html:7573–7690` — validasi input, pengiriman payload, dan tampilan response.
- `test/pembelian-kwh-calculation-harness.js:208` — harness menggunakan kontrak request tanpa `shiftId`.

Nama fungsi JavaScript spesifik tidak tercatat pada ringkasan audit terdahulu; dokumen ini tidak menebaknya.

## 5. Aturan validasi yang ditemukan

- `jenis_kwh` hanya `DALAM` atau `LUAR` pada schema target migration.
- `nominal_pembelian` harus berupa Rupiah integer non-negatif.
- `kwh_didapat` harus positif; UI menerima koma atau titik untuk desimal, maksimum dua angka di belakang separator.
- Penyimpanan KWh menggunakan integer skala x100.
- `harga_per_kwh` diturunkan dari nominal dan KWh pada schema target; UI menggunakan nilai dari response server untuk tampilan.
- `sisa_kwh` pada schema target harus integer antara nol dan total KWh; saat LOT dibuat, trigger menginisialisasinya ke total KWh.
- Route memakai kasir terautentikasi dan memilih shift OPEN; payload client tidak menyediakan `shiftId` atau ID kasir yang dipercaya.
- Harga pembelian token tidak dicatat sebagai Kas Masuk/Kas Keluar. Audit read-only atas route mengonfirmasi tidak ada penulisan ke tabel kas atau shift.

## 6. Alur data PBMS saat ini

1. Kasir membuka form pembelian token melalui menu UI dan memilih KWh Dalam atau KWh Luar.
2. UI memvalidasi nominal Rupiah dan jumlah KWh, lalu mengirim jenis, nominal, KWh, serta keterangan bila ada ke `POST /api/pembelian-kwh`.
3. Route mengidentifikasi kasir dari sesi autentikasi dan memilih shift OPEN; UI tidak memasok ID shift/kasir.
4. Server memproses pencatatan dan mengembalikan informasi yang dipakai UI untuk menampilkan ID, jenis, nominal, KWh, harga modal/KWh, sisa LOT, dan waktu.
5. Harga modal di UI bersumber dari response server. Setelah sukses, form direset untuk pencatatan berikutnya.
6. Pencatatan berbasis nota tidak mengubah Kas Masuk/Kas Keluar atau penjualan.

## 7. Masalah atau kekurangan yang ditemukan

- Pada audit awal, `pembelian_kwh` belum ada. Migration yang dibuat saat itu hanya dry-run; tidak ada bukti dari catatan audit bahwa `--apply` kemudian dijalankan.
- Ada incompatibility antara kontrak UI (tidak mengirim `shiftId`) dan route sebelumnya (mewajibkan `shiftId` dari body). Implementasi route berikutnya menyelesaikannya dengan mengambil shift OPEN dari sesi kasir.
- Audit read-only setelah implementasi mencatat jumlah row production `pembelian_kwh` sebesar 0. Ini menunjukkan belum ada row pada saat pemeriksaan tersebut, bukan kegagalan route.
- Pengurangan LOT, laporan, dan admin panel belum termasuk implementasi yang diaudit.
- Schema aktual `pembelian_kwh` setelah perubahan tidak tercatat terverifikasi pada ringkasan audit. Jangan menganggap schema target migration sudah sama dengan schema production tanpa pemeriksaan tersendiri.

## 8. Rekomendasi tahap implementasi berikutnya

1. Sebelum tahap berikutnya, lakukan pemeriksaan read-only untuk memastikan schema production `pembelian_kwh` sesuai dengan schema migration; jangan menjalankan migration atau mengubah database tanpa persetujuan eksplisit.
2. Tambahkan atau pertahankan test terisolasi untuk nominal integer, KWh positif hingga dua desimal, pemetaan `DALAM`/`LUAR`, pemilihan shift dari sesi, response harga dari server, dan tidak adanya perubahan pada tabel kas.
3. Jika fitur pengurangan sisa LOT akan dibuat, tentukan dan uji aturan pemilihan LOT serta perilaku transaksi secara terpisah sebelum implementasi. Audit terdahulu secara eksplisit belum mencakup pengurangan LOT.
4. Implementasikan laporan/admin panel hanya setelah kontrak data dan schema aktual terverifikasi; keduanya belum termasuk lingkup pekerjaan yang tercatat.
