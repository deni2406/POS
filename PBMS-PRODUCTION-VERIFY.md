# PBMS Production Verification

Pemeriksaan dilakukan pada 2026-09-29. Database dibuka menggunakan SQLite CLI dalam mode `-readonly`. Tidak ada endpoint yang dipanggil, migration yang dijalankan, atau operasi tulis/schema yang dilakukan.

## Status

* Database yang diperiksa: `C:\POS\pos.db`. `server.js` membuka `path.join(__dirname, "pos.db")`, yang menunjuk ke file ini.
* Tabel `pembelian_kwh`: tersedia.
* Jumlah row saat pemeriksaan: **2**.
* Database menggunakan journal mode `delete`. `PRAGMA foreign_keys` pada koneksi pemeriksaan read-only bernilai OFF; ini adalah pengaturan per-koneksi. Source aplikasi menjalankan `PRAGMA foreign_keys = ON` pada koneksi utamanya.
* Metadata ukuran dan waktu modifikasi file berubah di antara pembacaan terpisah, sehingga kemungkinan ada aktivitas writer lain selama pemeriksaan. Seluruh agregat pemeriksaan data diulang dalam satu transaksi read-only; laporan ini mencatat snapshot transaksi tersebut dan tidak mengatribusikan perubahan file kepada pemeriksaan.

## Schema Aktual

Sumber pemeriksaan struktur: `PRAGMA table_info('pembelian_kwh')`, `PRAGMA foreign_key_list('pembelian_kwh')`, dan definisi tabel dalam `sqlite_master`.

| Kolom | Tipe | Nullable | Default | Constraint |
|---|---|---|---|---|
| `id` | INTEGER | PK rowid; `notnull=0` pada `table_info` | — | `PRIMARY KEY AUTOINCREMENT` |
| `shift_id` | INTEGER | Tidak | — | FK ke `shift_kasir(id)` |
| `kasir_id` | INTEGER | Tidak | — | FK ke `kasir(id)` |
| `waktu` | TEXT | Tidak | — | — |
| `jenis_kwh` | TEXT | Tidak | — | `CHECK (jenis_kwh IN ('DALAM', 'LUAR'))` |
| `nominal_pembelian` | INTEGER | Tidak | — | CHECK tipe penyimpanan integer dan nilai `>= 0` |
| `kwh_didapat` | INTEGER | Tidak | — | CHECK tipe penyimpanan integer dan nilai `> 0` |
| `harga_per_kwh` | INTEGER | Tidak | — | CHECK tipe penyimpanan integer dan nilai `>= 0` |
| `sisa_kwh` | INTEGER | Tidak | `0` | Tidak ada CHECK rentang pada definisi tabel |
| `keterangan` | TEXT | Tidak | `''` | — |

Semua kolom selain `id` ditandai `notnull=1` oleh `table_info`. `id` adalah `INTEGER PRIMARY KEY AUTOINCREMENT` khusus SQLite; nilai ID dihasilkan sebagai rowid.

## Perbandingan dengan Target Migration

Target yang dibandingkan adalah definisi `CREATE TABLE` di `create-pembelian-kwh.js` saat pemeriksaan.

### Sesuai

* Kesepuluh kolom, tipe, urutan, nullability, dan default aktual sesuai definisi migration.
* Primary key/autoincrement, CHECK untuk jenis/nominal/KWh/harga, serta kedua foreign key sesuai.
* Definisi SQL tabel dalam database cocok dengan SQL `CREATE TABLE` pada file migration.

### Berbeda

* Tidak ditemukan perbedaan antara definisi tabel aktual dan target migration.
* Definisi migration aktual menyimpan `harga_per_kwh` sebagai `INTEGER`; nilainya bukan generated column.
* Definisi migration aktual tidak menetapkan CHECK rentang untuk `sisa_kwh` dan tidak membuat trigger. Ini sesuai dengan tabel aktual. Catatan terdahulu di `PBMS-AUDIT.md` yang menyebut generated `REAL`/trigger atau CHECK sisa adalah deskripsi berbeda dari file migration saat ini.

### Belum dapat diverifikasi

* Makna skala x100 untuk setiap nilai KWh historis tidak dapat dibuktikan hanya dari tipe/nilai tabel. Penyimpanan integer dan perilaku konversi di kode dapat diperiksa; ketepatan konversi atas nota sumber memerlukan bukti nota, yang tidak diperiksa di sini.

## Constraint, Index, Foreign Key, Trigger

* Constraint: primary key `id`; CHECK enum `jenis_kwh`, nominal integer non-negatif, KWh integer positif, dan harga integer non-negatif. Tidak ada unique constraint tambahan.
* Index: tidak ada index tambahan yang terdaftar untuk tabel. Primary key `INTEGER` menggunakan rowid SQLite.
* Foreign key: `shift_id → shift_kasir(id)` dan `kasir_id → kasir(id)`; `ON UPDATE` dan `ON DELETE` keduanya `NO ACTION`.
* Trigger terkait `pembelian_kwh`: tidak ada.
* `PRAGMA foreign_key_check('pembelian_kwh')` tidak menghasilkan temuan.

## Pemeriksaan Data

* Total row: **2**.
* NULL: **0** pada seluruh kolom yang diwajibkan (`shift_id`, `kasir_id`, `waktu`, `jenis_kwh`, `nominal_pembelian`, `kwh_didapat`, `harga_per_kwh`, `sisa_kwh`, `keterangan`). ID terisi pada seluruh row.
* Invalid enum (`jenis_kwh` selain `DALAM`/`LUAR`): **0**.
* Nominal: nilai negatif atau tipe penyimpanan bukan integer: **0**.
* KWh: nilai tidak positif atau tipe penyimpanan bukan integer: **0**. Tidak ditemukan bukti nilai storage bertipe selain integer; kesesuaian semantik skala x100 untuk nota sumber belum dapat dipastikan.
* Sisa KWh: nilai di bawah 0, di atas `kwh_didapat`, atau bukan integer: **0**.
* Harga/KWh: nilai negatif atau bukan integer: **0**. Ketidaksesuaian dengan pembulatan rumus route saat ini (`nominal_pembelian * 10000 / kwh_didapat`, dibulatkan ke integer): **0**.
* Foreign key: orphan `shift_id`: **0**; orphan `kasir_id`: **0**.
* Duplikasi/anomali: **0** grup row yang identik pada seluruh kolom bisnis (termasuk waktu dan keterangan). Tidak ada row bermasalah untuk dicontohkan; nilai row dan data identitas tidak dicantumkan.

## Route/API

`POST /api/pembelian-kwh` di `server.js` memerlukan sesi login dan JSON objek dengan:

* `jenis_kwh`: string `DALAM` atau `LUAR`.
* `nominal_pembelian`: angka Rupiah integer aman, non-negatif.
* `kwh_didapat`: angka atau string desimal positif dengan maksimal dua angka pecahan, titik atau koma; server mengubahnya menjadi integer skala x100.
* `keterangan`: opsional, harus berupa string; server memangkas spasi dan menyimpan string kosong bila tidak diberikan.

Shift dan kasir diambil dari sesi server, bukan dari input client. Route memvalidasi shift, menghitung harga/KWh di server, lalu menyimpan pembelian. Respons sukses HTTP 201 berisi `success`, `id`, `jenis_kwh`, `nominal_pembelian`, `kwh_didapat`, `harga_per_kwh`, `sisa_kwh`, dan `waktu`; nilai KWh/harga pada respons dikonversi kembali dari skala x100. Penolakan validasi menghasilkan HTTP 400; status shift/session dapat menghasilkan 403, 423, atau 409; kesalahan server menghasilkan 500.

## Temuan

* Tabel tersedia dengan 2 row dan definisi aktualnya sesuai migration `create-pembelian-kwh.js`.
* Tidak ada temuan pada pemeriksaan NULL, enum, nominal, nilai/type KWh tersimpan, rentang/type sisa, formula harga, foreign key, atau duplikasi identik.
* Tidak ada index tambahan atau trigger.
* Skala x100 secara semantik per pembelian tidak dapat dibuktikan dari database saja.

## Rekomendasi

### Aman dilakukan

* Pertahankan pemeriksaan produksi lanjutan dalam mode read-only.
* Jika perlu menguji ketepatan skala KWh historis, cocokkan secara read-only dengan nota sumber yang berwenang tanpa menampilkan data sensitif.

### Memerlukan persetujuan

* Perubahan schema, migration apply, pembuatan index/trigger/constraint, atau koreksi/penghapusan data memerlukan persetujuan eksplisit dan prosedur perubahan production tersendiri. Tidak ada perubahan tersebut dilakukan dalam verifikasi ini.
