# CHANGELOG

Memori perubahan proyek ALVA-POS. Setiap entri dicatat saat perubahan dilakukan.
Format: Tanggal · Deskripsi · File · Kolom/Tabel baru.

## [Unreleased]
### Fix Skema Tabel Pembelian & PO (`admin-server.js`, `pos.db`)
Memperbaiki error SQLITE_ERROR pada tombol "Simpan & Buat Nomor PO" — skema tabel `pembelian` dan `detail_pembelian` di database tidak cocok dengan query INSERT di `admin-server.js`. Kolom lama (`nomor_pembelian, supplier, total, id_barang TEXT, harga_beli, subtotal`) diganti dengan kolom yang diharapkan kode (`nota_no, kasir_id, total_modal, total_qty, catat_kas_keluar, barang_id INTEGER, hpp_lama, hpp_baru, harga_jual_lama, harga_jual_baru, subtotal_modal`). Migrasi dilakukan dengan DROP + CREATE ulang karena tabel kosong (0 baris). Semua endpoint PO (POST create, GET list, GET detail, PUT edit, PUT status) diverifikasi berfungsi dengan skema baru.
### Fix Bug Kategori PO (`pembelian.js`)
Memperbaiki array `PEM_KASIR_KATEGORI` menjadi uppercase (`["KASIR", "ROKOK"]`) agar barang kategori ROKOK dapat dicari dan muncul saat tab KASIR/ROKOK aktif. Sebelumnya array menggunakan lowercase (`["kasir", "rokok"]`) sedangkan fungsi `pemIsKasirKategori()` meng-on-convert input ke uppercase sebelum `.includes()`, menyebabkan pencocokan SELALU false.
### Fix Pencarian Barang Kasir (`pembelian.js`)
Memperbaiki pemfilteran pencarian barang kasir agar kategori ROKOK diikutsertakan dan dapat dicari secara normal di modal kasir/PO. Sebelumnya filter `=== 'KASIR'` hanya mencocokkan kategori EXAK "KASIR", sehingga barang kategori "ROKOK" terbuang. Sekarang menggunakan pola `KASIR_KATEGORI` (sinkron dengan `barang.js`) yang menganggap KASIR & ROKOK setara saat tab kasir aktif.

## 2026-11-04 — Auto-Migration untuk memperbaiki SQLITE_ERROR: no such column: uang_laci

**Masalah:** `server.js` gagal start dengan error `SQLITE_ERROR: no such column: uang_laci` pada tabel `shift_kasir`. Database `pos.db` belum memiliki kolom-kolom dan tabel yang dibutuhkan oleh skrip migrasi internal server.js dan admin-server.js.

**Solusi:** Membuat script `migrate.js` yang:
- Memeriksa skema database saat ini
- Menambahkan kolom-kolom yang hilang menggunakan `ALTER TABLE ... ADD COLUMN`
- Membuat tabel-tabel yang belum ada
- Menjalankan tanpa merusak data yang sudah ada

**Perubahan skema:**

### Tabel `shift_kasir` — 12 kolom baru ditambahkan:
| Kolom | Tipe | Default |
|-------|------|---------|
| `uang_laci` | INTEGER | 0 |
| `saldo_kwh_awal` | INTEGER | 0 |
| `saldo_kwh_dalam_awal` | INTEGER | 0 |
| `saldo_kwh_luar_awal` | INTEGER | 0 |
| `saldo_kwh_dalam_akhir` | INTEGER | 0 |
| `saldo_kwh_luar_akhir` | INTEGER | 0 |
| `opening_confirmed` | INTEGER | 0 |
| `kode_tutup` | TEXT | NULL |
| `pending_close_at` | TEXT | NULL |
| `pending_close_snapshot` | TEXT | NULL |
| `status_bank` | TEXT | 'PENDING' |
| `deposited_at` | TEXT | NULL |
| `deposited_by` | TEXT | NULL |

### Tabel `transaksi` — 1 kolom baru ditambahkan:
| Kolom | Tipe | Default |
|-------|------|---------|
| `tipe_transaksi` | TEXT | 'PENJUALAN' |

### Tabel baru dibuat (7 tabel):
| Tabel | Keterangan |
|-------|-----------|
| `kas_laci_transaksi` | Transaksi uang masuk/keluar laci kas |
| `rekonsiliasi_kasir` | Rekonsiliasi shift kasir |
| `setoran` | Data setoran kas |
| `nomor_transaksi_sequence` | Sequence nomor transaksi |
| `tarik_tunai` | Tarik tunai dari kas |
| `pembelian` | Data pembelian barang |
| `detail_pembelian` | Detail item pembelian |

### Index baru:
- `idx_shift_kasir_kode_tutup_unique` — unique index pada `kode_tutup` (WHERE NOT NULL)

**File:**
- `migrate.js` — script auto-migration baru
- `CHANGELOG.md` — file changelog baru (ini)

**Verifikasi:**
- `node server.js` berhasil start di port 3100 tanpa error SQL
- Total tabel: 29 (naik dari 22)
- `shift_kasir` memiliki 20 kolom (sebelumnya 8)
- Tidak ada data lama yang hilang

## [Unreleased] - 2026-11-04

### Changed
- **Fitur PO Barang Kasir** (`admin/js/dashboard.js` & `admin/js/pembelian.js`):
  - Menghapus logika auto-fill pendorongan barang otomatis ke keranjang PO saat tombol **Buat PO** diklik pada modal Barang Kasir.
  - Memperbarui fungsi `cekStokKritisKasir` di `dashboard.js` untuk memanggil `wBridge([])` dengan array kosong.
  - Memperbarui fungsi `window.openPembelianForCritical` di `pembelian.js` untuk mengosongkan keranjang (`pemCart = []`) tanpa pemetaan item otomatis.

<!-- ENTRI BARU DI BAWAH BARIS INI -->
### Fix #NEW — Query SQL Grafik Tren Penjualan: kolom `tanggal` & `total`
**Tanggal:** 2026-11-04 · **File:** `admin/admin-server.js` · **Masalah:** Grafik tren penjualan dapat menampilkan data kosong bila data transaksi berada di bulan September 2026 (`2026-09`) dan filter custom di-set ke rentang itu — bar omzet tidak render. · **Akar:** Kolom tanggal tabel `transaksi` di `pos.db` adalah `tanggal` (bukan `created_at`), dan kolom omzet adalah `total` (bukan `total_harga`). Query lama mengacu `created_at` / `total_harga` sehingga hasil SQL selalu NULL / error. · **Fix:** Backend `handleAdminSalesChart` di `admin-server.js` (endpoint `GET /api/admin/reports/sales-chart`) kini menggunakan `date(tanggal)` dan `SUM(total)` — query: `SELECT date(tanggal) AS tgl, COALESCE(SUM(total), 0) AS total_omzet, COUNT(id) AS total_transaksi FROM transaksi WHERE date(tanggal) >= ? AND date(tanggal) <= ? AND UPPER(COALESCE(tipe_transaksi,'PENJUALAN'))='PENJUALAN' GROUP BY date(tanggal) ORDER BY date(tanggal) ASC`. · **Verifikasi:** Filter custom `2026-09-01` s/d `2026-09-30` → grafik menampilkan bar omzet dari data transaksi September 2026. · **Pelajaran:** Selalu verifikasi nama kolom yang dipergunakan sesuai skema riil di `pos.db`, bukan asumsi dari naming umum.
### Fix #NEW — Filter Tanggal Custom (Rentang) Grafik Tren Penjualan
**Tanggal:** 2026-11-04 · **File:** `admin/admin-server.js`, `admin/dashboard.html`, `admin/js/penjualan.js`, `admin/css/dashboard.css` · **Masalah:** Grafik tren penjualan hanya bisa difilter dengan 4 periode preset; admin tidak bisa memilih rentang tanggal bebas (misal: periode tertentu di tahun lalu). · **Akar:** Backend tidak mendukung periode `custom`; tidak ada UI input tanggal di header grafik. · **Fix:** (1) `admin-server.js`: Extend `validPeriods` dengan `"custom"`; baca `startDate`/`endDate` dari query param (format `YYYY-MM-DD`, validasi regex `^\d{4}-\d{2}-\d{2}$`, swap bila start > end); (2) `dashboard.html`: Tambah tombol `#btnPeriodCustom` di `.chart-period-toggle` + form `#dashCustomDateWrap` (2 input date + tombol Terapkan + error message) yang awalnya `hidden`; (3) `penjualan.js`: `loadSalesChart(period, opts)` kini menerima `opts={startDate,endDate}` dan mengombinasikan ke URL saat `period='custom'`; handler klik `btnPeriodCustom` toggle form; handler `btnApplyCustomDate` validasi (start ≤ end) lalu panggil `loadSalesChart('custom', {startDate,endDate})`; form auto-hide setelah terapkan; (4) `dashboard.css`: style `.dash-custom-date-wrap` dark mode, `color-scheme: dark` pada input date agar picker juga dark. · **Verifikasi:** Klik "Custom" → form muncul → masukkan rentang → Terapkan → grafik menampilkan bar per-tanggal di rentang tersebut. · **Pelajaran:** Saat menambah periode baru, backend + tombol + handler JS harus sinkron; `color-scheme: dark` pada `input[type=date]` penting agar ikon calendar tidak putih di tema dark.

### Fix #NEW — Opsi Filter Periode Grafik Tren Penjualan (Hari Ini, 7 Hari, Bulan Ini, 30 Hari)
**Tanggal:** 2026-11-04 · **File:** `admin/admin-server.js`, `admin/dashboard.html`, `admin/js/penjualan.js`, `admin/css/dashboard.css` · **Masalah:** Header Grafik Tren Penjualan hanya punya 2 tombol filter (`Bulan Ini`, `30 Hari`); admin tidak bisa lihat tren untuk `Hari Ini` atau `7 Hari`. · **Akar:** Backend `validPeriods` hanya mengizinkan `["monthly_daily", "last_30_days"]`; tombol HTML & handler JS juga hanya mendaftarkan 2 periode. · **Fix:** (1) `admin-server.js`: Extend `validPeriods` jadi `["monthly_daily", "last_30_days", "last_7_days", "today"]` + logika `startDate/endDate` per periode (`today` = tanggal hari ini saja, `last_7_days` = hari ini - 6 s/d hari ini); (2) `dashboard.html`: Tambah tombol `#btnPeriodToday` ("Hari Ini") dan `#btnPeriod7Days` ("7 Hari") di `.chart-period-toggle`; (3) `penjualan.js`: Reference 2 tombol baru + `classList.toggle` di `loadSalesChart` + handler click untuk `today` & `last_7_days`; (4) `dashboard.css`: `.chart-period-toggle` sekarang `flex-wrap: wrap` + `@media (max-width:700px)` agar 4 tombol tetap rapi di layar sempit. · **Verifikasi:** Klik "Hari Ini" → grafik menampilkan 1 bar hari ini; klik "7 Hari" → grafik menampilkan 7 bar terakhir; "Bulan Ini" & "30 Hari" tetap berfungsi normal. · **Pelajaran:** Saat menambah periode, `validPeriods` di backend dan tombol + handler di frontend harus diperbarui secara berpasangan; `flex-wrap` di tombol diperlukan bila jumlah tombol > 3 agar tidak overflow di mobile.

### Fix #NEW — Inisialisasi & Auto-Refresh Widget Daftar PO Pending Dashboard
**Tanggal:** 2026-11-04 · **File:** `admin/js/dashboard.js` · **Masalah:** Widget "Daftar PO Pending" tidak tampil saat halaman pertama dibuka — data statistik penjualan juga belum termuat. · **Akar:** (1) Section wrapper `[aria-label="Daftar PO Pending"]` tidak di-force `display: block` saat `DOMContentLoaded`, sehingga bisa tersembunyi; (2) Tidak ada `setInterval` untuk auto-refresh — PO baru yang masuk tidak otomatis muncul. · **Fix:** Di `DOMContentLoaded`, setelah `dashLoadPendingPOs()` dipanggil, ditambahkan: (a) `document.querySelector('[aria-label="Daftar PO Pending"]').style.display = 'block'` untuk memastikan widget terlihat; (b) `setInterval(dashLoadPendingPOs, 30000)` untuk auto-refresh tiap 30 detik. · **Verifikasi:** Dashboard dibuka → widget PO Pending tampil langsung; PO baru yang dibuat akan muncul otomatis tanpa reload manual. · **Pelajaran:** Section `display: none` bawaan (dari pola sembunyikan-sementara Fix #83) bisa berakibat widget baru tak terlihat — selalu pastikan `style.display = 'block'` di dalam DCL untuk elemen yang ingin tampil.

### Fix #NEW — Widget Daftar PO Pending: Tambah Kolom QTY + Presisi 7 Kolom
**Tanggal:** 2026-11-04 · **File:** `admin/dashboard.html`, `admin/js/dashboard.js`, `admin/css/dashboard.css` · **Masalah:** Widget "Daftar PO Pending" belum menampilkan jumlah QTY beli per PO, dan tata letak 6 kolom tidak presisi — TOTAL MODAL & QTY perlu perataan eksplisit untuk readability. · **Akar:** Tabel hanya 6 kolom (tanpa QTY), lebar kolom tidak proporsional, dan style `font-feature-settings: "tnum"` belum diterapkan pada angka. · **Fix:** (1) Menambahkan kolom QTY di `dashboard.html` → total 7 kolom: Nomor PO 16%, Nama Produk 22%, Kategori 12%, QTY 8%, Total Modal 16%, Tanggal 12%, Aksi 14%; (2) Di `dashboard.js`, `dashLoadPendingPOs` kini mengambil `totalQty` dari `d.items.reduce(...)` saat fetch detail, dan render kolom QTY + class `dash-po-td--qty` (center, bold); (3) CSS: `table-layout: fixed` + lebar kolom eksplisit, `QTY` = `text-align: center; font-weight: bold`, `TOTAL MODAL` = `text-align: right; font-feature-settings: "tnum"`, kolom text = left, aksi = center. · **Verifikasi:** Tabel 7 kolom sejajar; angka QTY bold & center; TOTAL MODAL rata kanan dengan tabular numerals. · **Pelajaran:** Kolom QTY dihitung akumulasi dari detail items (bukan dari `total_qty` header PO) agar selaras dengan `fmtRp(total_modal)` yang berasal dari `total_modal` header.

### Fix #NEW — Kolom "Nama Produk" di Widget Daftar PO Pending Dashboard
**Tanggal:** 2026-11-04 · **File:** `admin/dashboard.html`, `admin/js/dashboard.js`, `admin/css/dashboard.css` · **Masalah:** Widget "Daftar PO Pending" di dashboard tidak menampilkan nama barang/produk yang ada di dalam PO, sehingga admin/kasir harus membuka detail dulu untuk tahu barang apa yang dipesan. · **Akar:** Endpoint `GET /api/admin/pembelian/po` hanya mengembalikan `item_count` tanpa rincian nama barang — nama produk hanya tersedia di endpoint detail per-PO. · **Fix:** Menambahkan kolom "Nama Produk" di tabel widget (colgroup baru 6 kolom, lebar proporsional 18/24/14/16/14/14). Di `dashLoadPendingPOs`, melakukan `Promise.all` fetch detail tiap PO untuk mengambil nama produk utama; bila >1 item, ditampilkan sebagai "Nama Utama (+N item)". Sel baru menggunakan class `dash-po-td--produk` dengan `text-overflow: ellipsis` agar tidak merusak `table-layout: fixed`. · **Verifikasi:** Tabel menampilkan 6 kolom sejajar; nama produk terisi dengan benar; tooltip full nama muncul saat hover. · **Pelajaran:** Fetch detail per-PO menggunakan `Promise.all` agar tidak n-sequential; bila detail gagal, fallback label "—" agar tabel tetap render.

### Fix #NEW — Aksi "Terima Barang" (Terima PO) di Widget Daftar PO Pending Dashboard
**Tanggal:** 2026-11-04 · **File:** `admin/js/dashboard.js`, `admin/css/dashboard.css`, `admin/admin-server.js` · **Masalah:** Admin/kasir harus membuka tab Restok Barang untuk menerima PO; stok tidak bisa langsung di-update dari dashboard utama. · **Akar:** Backend belum punya endpoint penerimaan PO — `PUT /api/admin/pembelian/po/:id/status` hanya mengizinkan `BATAL` (komentar di `handleAdminUpdatePOStatus` baris 3627 menyebut DITERIMA butuh alur terpisah). · **Fix:** (1) Menambahkan endpoint baru `PUT /api/admin/pembelian/po/:id/terima` yang mengubah status PENDING→DITERIMA + menambah `stok_aktual` dan memperbarui `hpp`/`harga_jual` tiap barang di `master_barang` (transaksi `BEGIN IMMEDIATE`/`COMMIT`/`ROLLBACK`, konsisten dengan `handleAdminEditPO`), menulis `diterima_oleh`/`diterima_at`; (2) Menambahkan tombol "Terima" di kolom aksi widget dashboard (class `btn-terima-po`), dengan konfirmasi lalu memanggil endpoint terima + reload daftar + refresh `fetchStats()` & `__pembelianLoadPoList`; (3) CSS grup tombol `.dash-po-aksi-group` (inline-flex, nowrap, gap 6px) agar Terima & Batalkan rapi tanpa merusak `table-layout: fixed`. · **Verifikasi:** PENDING PO → klik Terima → konfirmasi → status jadi DITERIMA, stok bertambah, baris hilang dari widget pending. · **Pelajaran:** Penerimaan PO = transaksi multi-tabel (header + stok per item), harus atomik; gunakan `BEGIN IMMEDIATE` dan rollback bila salah satu update stok gagal.

### Fix #NEW — Rapikan Alignment Tabel "Daftar PO Pending" Dashboard Admin
**Tanggal:** 2026-11-04 · **File:** `admin/dashboard.html`, `admin/js/dashboard.js`, `admin/css/dashboard.css` · **Masalah:** Teks isi tabel (mis. `Rp 17.000`, tanggal `04 Nov 2026`) tampak bergeser/miring dan tidak presisi di bawah header kolom "TOTAL MODAL" dan "TANGGAL". · **Akar:** Lebar kolom mengambang sesuai isi (tabel tanpa `table-layout: fixed`), dan perataan header vs isi tidak konsisten — header "Total Modal" memakai class `col-num` (rata kanan) sementara sel isi memakai `class="num"` tanpa penegasan perataan, serta kolom "Tanggal" dan "Aksi" tidak punya text-align eksplisit. · **Fix:** Menerapkan `table-layout: fixed` + `<colgroup>` dengan lebar kolom persentase identik untuk header & isi, plus text-align eksplisit per kolom (Nomor PO=left, Kategori=left, Total Modal=right, Tanggal=center, Aksi=center) dan `font-variant-numeric: tabular-nums` pada kolom modal. · **Verifikasi:** Header `<th>` dan isi `<td>` kini sejajar presisi; jumlah kolom (5) konsisten antara thead & tbody. · **Pelajaran:** Untuk tabel dengan kolom angka/tanggal, `table-layout: fixed` + `<colgroup>` mencegah kolom melebar/menyempit tak merata akibat isi yang panjang.

### Fix #NEW — Widget "Daftar PO Pending" di Dashboard Admin
**Tanggal:** 2026-11-04 · **File:** `admin/dashboard.html`, `admin/js/dashboard.js` · **Masalah:** Admin/kasir tidak langsung tahu ketika ada PO baru masuk — harus buka tab Restok Barang dulu. · **Akar:** Tidak ada ringkasan PO Pending di halaman utama dashboard. · **Fix:** Menambahkan widget card tabel "Daftar PO Pending" tepat di bawah grafik balok Penjualan (panel-keuangan). Menampilkan Nomor PO, Kategori, Total Modal, Tanggal, dan tombol Aksi (Batalkan). Data dimuat via GET `/api/admin/pembelian/po?status=PENDING`, auto-refresh setelah PO baru dibuat (bridge `window.__dashLoadPendingPOs`). · **Verifikasi:** Dashboard admin memuat halaman utama → tabel PO Pending terisi data PENDING (jika ada) · **Pelajaran:** Pastikan elemen widget punya `class="modal-table-wrap"` + `max-height` untuk scroll vertikal bila data banyak, menghindari tabel melebar tak terkendali.
### Fix #4 — UI Modal Pembelian: Alur checkout "Simpan & Buat Nomor PO" menutup modal & mengosongkan keranjang
- **Tanggal**: 2026-11-04
- **File**: `admin/js/pembelian.js`
- **Masalah**: Setelah PO baru berhasil dibuat, modal tidak ditutup dan keranjang tidak dikosongkan — pengguna tetap harus menutup manual dan item tersisa di cart.
- **Akar**: MODE BARU (create) belum punya callback cleanup seperti MODE EDIT PO yang sudah memiliki baris reset+close.
- **Fix**: Menambahkan empat baris cleanup setelah alert sukses MODE BARU: `pemCart = []` → `pembelianResetPoEditMode()` → `pembelianRenderPemCart()` → `pembelianLoadPoList()` → `pembelianCloseModal()`. Label tombol "Memproses…" juga dihapus dari line 371 (sebelumnya hanya ada di MODE EDIT).
- **Verifikasi**: Klik "Simpan & Buat Nomor PO" → alert sukses muncul → modal menutup otomatis → cart kosong → daftar PO refresh.
- **Pelajaran**: MODE BARU dan MODE EDIT harus simetris dalam hal cleanup state setelah operasi berhasil.
- **Log Keyword**: `pembelianSubmit MODE BARU closeCart` · `pembelianCloseModal setelah create`
- **Deploy**: pending

### Fix #3 — UI Modal Pembelian: Mengunci HPP BARU & HARGA JUAL BARU menjadi readonly
- **Tanggal**: 2026-11-04
- **File**: `admin/dashboard.html`, `admin/js/pembelian.js`
- **Masalah**: Field HPP Baru dan Harga Jual Baru di modal Restok Barang/PO masih bisa diedit manual oleh pengguna, padahal nilai ini seharusnya murni diambil dari Master Barang.
- **Akar**: Input `pemHppBaru` dan `pemHjBaru` tidak memiliki atribut `readonly`.
- **Fix**: Menambahkan atribut `readonly` + `title` (tooltip penjelas) pada kedua input di `dashboard.html`. Auto-fill dari `harga_modal`/`harga_jual` Master Barang tetap berjalan normal di `pembelian.js` saat barang dipilih dari pencarian.
- **Verifikasi**: Input tidak bisa diketik manual; nilai tetap terisi otomatis saat barang dipilih dari pencarian.
- **Pelajaran**: Gunakan `readonly` (bukan `disabled`) agar nilai tetap terbaca saat submit form/fetch.
- **Log Keyword**: `pemHppBaru readonly` · `pemHjBaru readonly` · `master barang harga`
- **Deploy**: pending

### Fix #2 — UI Modal Pembelian: Menyembunyikan tab pemilih kategori (Kasir/Bar/Dapur) di modal Restok Barang
- **Tanggal**: 2026-11-04
- **File**: `admin/dashboard.html`
- **Masalah**: Tab navigasi kategori (🛒 Kasir · 🍹 Bar · 🍳 Dapur) di modal Purchase Cart mengganggu UX karena pengguna tidak perlu memilih kategori secara manual — default KASIR sudah cukup.
- **Akar**: Elemen `<nav id="pemKategoriTab">` tetap ditampilkan walau logika filter kategori sudah berjalan otomatis via `pembelianSetPemKategori('KASIR')`.
- **Fix**: Menambahkan `style="display:none"` pada elemen `<nav id="pemKategoriTab">` agar tab pemilih kategori tersembunyi. JavaScript listener (`pemKategoriTab.querySelectorAll(...)`) tetap aman karena guard `if (pemKategoriTab)` melindungi null reference. Default `pemActiveKategori = 'KASIR'` (line 61 pembelian.js) tetap aktif.
- **Verifikasi**: Modal pembelian terbuka → tab kategori tidak terlihat; pencarian & submit PO tetap berjalan normal pada kategori KASIR.
- **Pelajaran**: Menyembunyikan elemen UI dengan CSS (bukan menghapus markup) menjaga DOM reference tetap valid untuk script yang bergantung padanya.
- **Log Keyword**: `pemKategoriTab display:none` · `pembelian.js pemActiveKategori KASIR`
- **Deploy**: pending

### Fix #1 — UI Barang Kasir: Mengubah label tombol "Buat PO Semua Barang Kasir" → "Buat PO"
- **Tanggal**: 2026-11-04
- **File**: `admin/dashboard.html`
- **Masalah**: Teks tombol terlalu panjang ("Buat PO Semua Barang Kasir")
- **Akar**: Label UI yang tidak ringkas
- **Fix**: Mengubah teks tombol menjadi "Buat PO" saja
- **Verifikasi**: Teks tombol pada baris 1127 `admin/dashboard.html` telah diubah
- **Pelajaran**: Pertahankan konsistensi singkat label tombol PO
- **Log Keyword**: btnKasirCekStokKritis, Buat PO
- **Deploy**: PENDING
