# FASE 7 — Verifikasi Mapping Local ID ↔ SOURCE_ID

Tanggal pemeriksaan: 1 Oktober 2026  
Status: **BLOCKED**

## Ringkasan keputusan

`master_barang.id` tidak dapat dipakai sebagai pengganti ID GAS secara langsung. Pada snapshot `pos.db` yang diperiksa, ada 113 baris lokal dan setiap baris mempunyai `id_barang` nonkosong. Kode sinkronisasi menyimpan `item.id` GAS ke `id_barang`; karena itu tersedia relasi eksplisit `id` lokal → `id_barang` sumber untuk tiap row.

Namun, tiga `source_id` yang sudah dinyatakan ambigu dari FASE 4 masing-masing terhubung ke dua local ID. Tidak dipilih satu row pun. Hasilnya adalah 110 pasangan unik yang tidak berkonflik dan 6 local ID unresolved akibat tiga konflik many-to-one. Karena setiap row harus bisa dipetakan secara tunggal, keseluruhan mapping **BLOCKED** dan belum aman untuk mempertahankan nilai ID legacy dalam response shadow.

## Sumber identity dan metode

- `server.js` mendefinisikan `master_barang.id` sebagai PK lokal autoincrement dan `id_barang` sebagai kolom TEXT.
- Fungsi `syncProduk()` mengambil `result.data` dari aksi GAS `get_barang` lalu memasukkan `item.id` ke kolom `id_barang`. Ini bukti eksplisit asal `id_barang` dari source adapter lama; tidak ada inferensi berdasarkan atribut produk.
- `getLocalBarang()` mengembalikan kolom lokal `id`, bukan `id_barang`. Maka kompatibilitas Stock Opname yang bergantung pada nilai `id` tidak dapat dipenuhi dengan memakai PK shadow yang baru dibuat tanpa aturan pemetaan.
- Database `pos.db` dibuka dengan mode SQLite `READONLY`. Query SELECT-only menghitung row, nilai kosong, duplicate source ID, dan pasangan `id`/`id_barang`. Tidak ada query tulis, migrasi, atau perubahan database.
- Database `pbms-shadow/data/pbms-shadow.sqlite` juga dibuka `READONLY`. Di dalamnya ada satu import run `REJECTED` dengan `source_row_count=113`, tetapi staging dan published shadow masing-masing kosong. Jadi ia tidak menyediakan tabel kandidat untuk pencocokan row demi row.
- Tidak digunakan nama, harga, kategori, atau tebakan untuk membuat mapping.

## Hasil pemeriksaan

| Pemeriksaan | Hasil |
|---|---:|
| Row `master_barang` diperiksa | 113 |
| Local ID memiliki `id_barang` nonkosong | 113 |
| Local ID tanpa source identity | 0 |
| Source ID distinct pada master lokal | 110 |
| Pasangan local ID → source ID valid dan tunggal | 110 |
| Source ID duplikat / konflik many-to-one | 3 |
| Local ID unresolved karena konflik | 6 |
| Snapshot sumber terpisah untuk mendeteksi source ID tanpa local ID | Tidak tersedia |

Duplikat yang tetap diblokir:

| `source_id` | Local ID terkait | Status |
|---|---|---|
| `RK62` | 50894, 50895 | BLOCKED — ambigu |
| `RK68` | 50901, 50902 | BLOCKED — ambigu |
| `KS06` | 50939, 50940 | BLOCKED — ambigu |

Tidak ada source ID tanpa local ID yang dapat dibuktikan dari bukti yang tersedia: katalog source aktual tidak ada di staging/published shadow. Karena itu pemeriksaan kelengkapan ke arah source → local dinyatakan **tidak dapat ditentukan**, bukan nol.

## Dampak pada kompatibilitas ID legacy

Untuk 110 pasangan unik, `id_barang` memberi hubungan eksplisit ke source identity, tetapi PK lokal `id` hanya merupakan nomor SQLite lokal dan belum menjadi ID shadow yang stabil. Belum ada mekanisme yang membawa pasangan tersebut ke shadow repository. Enam local ID dalam tiga konflik tidak memiliki pemetaan tunggal ke satu `source_id`. Menggunakan salah satu row, merge, atau menebak pengganti akan melanggar aturan identity dan mengubah makna referensi Stock Opname.

Karena itu mapping saat ini **tidak dapat dipakai sebagai aturan lengkap untuk mempertahankan `id` legacy pada shadow response**. Tidak ada compatibility layer yang dibuat.

## Bukti lanjutan untuk membuka blokir

Sediakan snapshot katalog GAS mentah yang otoritatif dengan seluruh baris dan identity sumber, serta selesaikan keputusan identity `RK62`, `RK68`, dan `KS06` secara eksplisit. Setelah itu verifikasi ulang kedua arah mapping (local → source dan source → local), uniqueness, dan row coverage sebelum memutuskan kesiapan. Laporan FASE 4 sudah mencatat ketiga ID tersebut unresolved; status BLOCKED dipertahankan.

## Batas perubahan

Hanya dokumen ini dibuat. Tidak ada perubahan pada `stock-opname.js`, GAS, kontrak `GET /api/barang`, flag `PBMS_SHADOW_CATALOG_ENABLED`, kode runtime, master aktif, atau database production.
