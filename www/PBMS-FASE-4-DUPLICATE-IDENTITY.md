# FASE 4 — Investigasi identitas `source_id` duplikat

Tanggal: 1 Oktober 2026  
Status dataset: **ditahan; jangan publish**

## Ruang lingkup dan bukti yang tersedia

FASE 3 melaporkan respons GAS aktual berisi 113 baris dan `RK62`, `RK68`, serta `KS06` masing-masing muncul dua kali. Repo/artefak yang tersedia untuk audit ini tidak memuat snapshot respons tersebut atau salinan parser GAS production. Karena itu, nilai per baris aktual (termasuk `nama`, `kategori`, `satuan`, `status`, `hpp`, `hargaJual`, dan `stokAktual`) tidak dapat dibuktikan dari workspace ini dan tidak direka dalam laporan.

Pemeriksaan read-only pada `pbms-shadow/data/pbms-shadow.sqlite` menemukan tabel staging/katalog shadow, tetapi tidak ada baris untuk ketiga ID itu di `master_barang_staging` maupun `master_barang_shadow`. Repo tidak menyediakan log/snapshot lain dengan tiga ID tersebut. Fixture pada `test/pbms-shadow-source.test.js` bukan data aktual dan tidak digunakan untuk menyimpulkan identitas barang.

| source_id | Kemunculan dalam respons 113 baris menurut FASE 3 | Seluruh atribut yang diminta untuk tiap baris aktual | Kandidat identifier pembeda yang dapat diverifikasi | Klasifikasi |
|---|---:|---|---|---|
| RK62 | 2 | Tidak tersedia di artefak lokal; perlu kedua object respons mentah | Tidak ditemukan dalam artefak lokal. `satuan`/`status` muncul pada fixture contoh, tetapi adapter membuangnya; bukan bukti identifier unik/stabil | **Belum dapat ditentukan** |
| RK68 | 2 | Tidak tersedia di artefak lokal; perlu kedua object respons mentah | Tidak ditemukan dalam artefak lokal. `satuan`/`status` muncul pada fixture contoh, tetapi adapter membuangnya; bukan bukti identifier unik/stabil | **Belum dapat ditentukan** |
| KS06 | 2 | Tidak tersedia di artefak lokal; perlu kedua object respons mentah | Tidak ditemukan dalam artefak lokal. `satuan`/`status` muncul pada fixture contoh, tetapi adapter membuangnya; bukan bukti identifier unik/stabil | **Belum dapat ditentukan** |

## Pembentukan dan penggunaan ID

`pbms-shadow/source-adapter.js` memetakan `item.id` dari response `get_barang` langsung ke `source_id`. Adapter menyimpan `nama`, `kategori`, `hpp`, `hargaJual`, dan `stokAktual` (dengan nama SQL yang dinormalisasi), serta mengisi `source_updated_at: null`. Field tambahan dari object GAS seperti `satuan`, `status`, barcode, atau kolom lainnya tidak diteruskan. Maka kode repo membuktikan asal ID pada kontrak adapter, tetapi tidak membuktikan bagaimana ID dibuat di spreadsheet/GAS (misalnya nomor baris, formula, atau ID manual), apakah unik di sumber, maupun dampaknya pada konsumen GAS lain.

`pbms-shadow/importer.js` memvalidasi keunikan `source_id` setelah trim; duplicate menghasilkan issue `field: "source_id", code: "duplicate"`, membuat import berstatus `REJECTED`, dan tidak menulis baris ke staging. Schema shadow juga menetapkan ID itu sebagai primary key. `server.js` dan jalur runtime sengaja tidak diubah dalam fase ini.

## Keputusan dan bukti yang diperlukan

Untuk setiap ID, owner sistem perlu menyediakan satu snapshot response GAS mentah yang sama dengan 113 baris (dengan posisi/indeks baris) serta sumber pembentukan ID dari sheet/script. Kedua record perlu dibandingkan pada seluruh field mentah yang tersedia, khususnya nama, kategori, satuan, status, HPP, harga jual, stok, barcode/SKU bila ada, dan referensi transaksi/stok opname yang relevan.

Jika semua atribut dan riwayat menunjuk satu produk yang sama, owner harus menetapkan aturan koreksi sumber agar hanya ada satu record otoritatif. Jika record mewakili dua produk berbeda, owner harus menetapkan ID baru yang stabil untuk masing-masing dan memetakan referensi historis/stock opname sebelum perubahan sumber. Jika bukti tetap tidak membedakan, owner harus memutuskan cara verifikasi operasional (misalnya pemeriksaan label/barcode fisik) atau mempertahankan blokir publikasi. Tidak ada perubahan source ID yang dilakukan di sini.

| source_id | Keputusan owner yang masih diperlukan |
|---|---|
| RK62 | Tentukan satu produk vs dua produk berbeda berdasarkan dua row mentah, sumber pembentukan ID, serta bukti barcode/riwayat; setujui tindakan koreksi sumber dan pemetaan referensi bila perlu. |
| RK68 | Tentukan satu produk vs dua produk berbeda berdasarkan dua row mentah, sumber pembentukan ID, serta bukti barcode/riwayat; setujui tindakan koreksi sumber dan pemetaan referensi bila perlu. |
| KS06 | Tentukan satu produk vs dua produk berbeda berdasarkan dua row mentah, sumber pembentukan ID, serta bukti barcode/riwayat; setujui tindakan koreksi sumber dan pemetaan referensi bila perlu. |

Sampai keputusan eksplisit tercatat dan snapshot lolos validasi ulang, dataset aktual tidak boleh dipublish. Tidak ada penghapusan, penggabungan, pemilihan record, atau perubahan data sumber otomatis.

## Batas perubahan FASE 4

Perubahan fase ini dibatasi pada laporan ini dan regresi validator. Tidak ada perubahan `server.js`, `master_barang` aktif, stok, transaksi, SYNC PRODUK, `/api/barang`, stock opname, GAS production, atau `pos.db`.
