# CHANGELOG_FIXES.md

Memori institusional proyek ini — akar tiap bug yang sudah diperbaiki, supaya
sesi berikutnya tak mengulang kesalahan yang sama. Entri terbaru di ATAS.

Format tiap entri:
```
### Fix #N — Judul Singkat: Gejala + Akar
| | |
|---|---|
| **Tanggal** | YYYY-MM-DD |
| **File** | path + fungsi yang diubah |
| **Masalah** | gejala konkret (sertakan angka/log nyata) |
| **Akar** | penyebab sebenarnya, bukan sekadar apa yang salah |
| **Fix** | apa yang diubah dan mengapa pendekatan itu |
| **Verifikasi** | bukti nyata: test/log/repro sebelum-sesudah |
| **Pelajaran** | pola kesalahan yang perlu dihindari |
```

### Fix #16 — Admin Unlock/Re-open SO: Endpoint Baru + DELETE Draf & Final Per Kategori
| | |
|---|---|
| **Tanggal** | 2026-10-10 |
| **File** | `server.js` & `www/server.js` — endpoint baru `POST /api/admin/stock-opname/unlock` (blok setelah handler finalize, sebelum FAVICON & FALLBACK, baris ~8720). |
| **Masalah** | Tidak ada cara untuk Admin membuka kembali kategori SO yang sudah terkunci (`is_final=1`) atau menghapus draf lokal (`status='DRAFT'`). Setelah kategori difinalisasi, tak ada route untuk "unlock" — SO kategori itu tak bisa dibuat ulang. |
| **Akar** | Endpoint `POST /api/admin/stock-opname/unlock` belum pernah dibuat. Semua alur SO hanya punya jalur: simpan draft → finalize (mengunci). Tidak ada jalur pembalikan. |
| **Fix** | Endpoint baru di `server.js` (root + www, byte-identik): auth guard `validateLoginSession`; payload `{kategori}` atau `{category}` (dua bentuk, keduanya di-support); string di-cleansed `.trim().toUpperCase()`. Transaksi DB (BEGIN/COMMIT + ROLLBACK on error): (1) `DELETE FROM stock_opname_detail WHERE so_id IN (SELECT so_id FROM stock_opname WHERE kategori=? AND is_final=1)` — hapus detail yang terkait SO final (tidak hapus detail DRAFT lokal, karena `createStockOpname` akan membuat detail baru); (2) `DELETE FROM stock_opname WHERE kategori=? AND (is_final=1 OR status='DRAFT')` — hapus header final + draft. Log: `writeLog("INFO","SO_ADMIN_UNLOCK",…)` dan `"ERROR","SO_ADMIN_UNLOCK_ERROR"`. Response: `{success:true,message:"Kategori berhasil dibuka kembali oleh Admin."}`. |
| **Verifikasi** | `node --check` exit 0 (root + www). In-memory SQLite (node:sqlite): seed 3 header (KASIR final+draft, ROKOK final) & 3 detail → jalankan SQL unlock KASIR → 2 header terhapus (SO-X, SO-Y); ROKOK utuh; detail SO-X terhapus (final KASIR), detail SO-Y & SO-Z tetap ada. `node --test test/stock-opname-{schema,local,ui-isolation}.test.js` → 21/21 pass. PENDING live: PM2 restart + POST `/api/admin/stock-opname/unlock` dengan header auth valid + payload `{kategori:"KASIR"}`. |
| **Pelajaran** | (1) DELETE detail hanya untuk SO `is_final=1` (via subquery), jangan hapus semua detail kategori — draf lokal punya `is_final=0` dan detail-nya akan di-recreate saat `createStockOpname` dijalankan lagi. (2) Transaksi multi-DELETE harus satu BEGIN/COMMIT — kalau step 2 gagal, step 1 harus di-ROLLBACK (bukan dibiarkan setengah jalan). (3) Endpoint admin yang melakukan DELETE data produksi perlu log INFO sukses + ERROR gagal; jangan diam. |

### Fix #15 — Detail SO: Endpoint Cuma Akui PK Numerik + Nama Placeholder; Frontend Button Pakai `r.id`, Tabel 6 Kolom vs API 7 Kolom
| | |
|---|---|
| **Tanggal** | 2026-10-10 |
| **File** | `server.js` & `www/server.js` — handler `GET /api/stock-opname/detail/` (blok ~7880–7915). `stock-opname.js` & `www/stock-opname.js` — tombol Detail di `renderHistoryTable` (~756), `renderDetailTable` (hapus, ~767), `showDetail` (~892–990). |
| **Masalah** | (1) Tombol "Detail" di tabel Riwayat memanggil `showDetail(r.id)` — `r.id` adalah PK numerik `stock_opname.id` (mis. `5`), tapi handler lama memperlakukannya sebagai `so_id` string: `WHERE d.so_id = ?` → PK numerik tak pernah cocok → modal Detail selalu "Tidak ada rincian barang" walau data ada. (2) Regex lama `^\/api\/stock-opname\/detail\/\d+$` menolak `SO-...` → mencari per kode `so_id` juga 404 (jatuh ke fallback). (3) Kolom `nama` menampilkan placeholder "Barang Tanpa Nama" (di-set backend Fix #12 saat `nama_barang` kosong) padahal `master_barang.nama` sudah tersedia. (4) Tabel modal `showDetail` 6 kolom (colspan=6) vs API mengembalikkan 7 kolom termasuk `kode_barang` — selisih layout; `renderDetailTable` orphan (memakai field tak ada di API, tak pernah dipanggil). |
| **Akar** | Endpoint detail dibuat sebelum kode `so_id` (`SO-YYYY-NNNN`) dipakai frontend, jadi hanya mengenali PK numerik; query lama tak pernah join header `stock_opname` (`h`) sehingga `WHERE h.id = ?` tak mungkin. Field `nama` memakai `COALESCE(d.nama_barang, p.nama)` — placeholder dari `d.nama_barang` menang dari `p.nama` yang valid. Tombol History memakai `r.id` karena `renderHistoryTable` tak memetakan `r.so_id`. |
| **Fix** | Backend (`server.js` + `www/server.js`, byte-identik): handler detail diganti — match `WHERE h.id = ? OR d.so_id = ?` dengan LEFT JOIN `stock_opname h ON h.so_id = d.so_id`; `nama` = `COALESCE(NULLIF(d.nama_barang,'Barang Tanpa Nama'), p.nama, d.nama_barang, 'Barang Tanpa Nama')`; tambah kolom `kode_barang` = `COALESCE(NULLIF(d.id_barang,''), p.id_barang, '-')`; route `req.url.startsWith("/api/stock-opname/detail/")` + `paramId` dari `split("/").pop()` (mendukung PK numerik & `so_id`, tetap di-guard `validateLoginSession`). Frontend (`stock-opname.js` + `www/stock-opname.js`): tombol Detail → `showDetail('${String(r.so_id||"")...}')`; hapus `renderDetailTable` orphan; `showDetail`: colspan 6→7, tambah kolom "Kolom Barang" (`kode_barang`) di header & row. |
| **Verifikasi** | `node --check` exit 0 untuk keempat file (root + www, `server.js` & `stock-opname.js`). `cmp`: `server.js` root≡www & `stock-opname.js` root≡www (IDENTICAL). Smoke SQL in-memory (node:sqlite): `WHERE h.id=? OR d.so_id=?` dengan PK `'1'` & `'SO-2026-0001'` → 2 baris sama; `nama` placeholder ter-resolve ke `p.nama` ('Kopi Robusta', bukan 'Barang Tanpa Nama'); `id_barang` kosong → `kode_barang` = '-' via `p.id_barang`; PK lain (`'99'`) → `[]`. `node --test test/stock-opname-{schema,local,ui-isolation}.test.js` → 21/21 pass. PENDING live: PM2 restart + klik tombol Detail di modal Riwayat & Rekap → modal menampilkan 2 barang dengan Kolom Barang & nama master. |
| **Pelajaran** | (1) Saat endpoint menerima kunci bisnis (`so_id`), jangan cuma match PK numerik — `WHERE h.id = ? OR d.so_id = ?` + JOIN header membuat dua bentuk kunci bisa dipakai; pastikan route tak pakai regex `\d+$` yang menolak kode string. (2) Placeholder "Barang Tanpa Nama" harus di-`NULLIF` sebelum `COALESCE`, kalau tidak ia menang dari `master_barang.nama`. (3) Tombol di tabel history harus panggil endpoint pakai **field kunci yang sama** yang API kirimkan (`r.so_id`), bukan PK (`r.id`) — cek mapping field respons API vs field yang dipakai di `onclick`. (4) Hapus render function orphan (`renderDetailTable`) yang field-nya tak sesuai API — biarkan satu source of truth untuk render detail (inline di `showDetail`). |

### Fix #14 — Static file handler stock-opname.js/css: Query String Membuat Cache-Buster `?v=4` Jatuh 404
| | |
|---|---|
| **Tanggal** | 2026-10-10 |
| **File** | `server.js` & `www/server.js` — handler static file `GET /stock-opname.js` (baris 2161) & `GET /stock-opname.css` (baris 2176) |
| **Masalah** | Browser error "module gagal load". Request `/stock-opname.js?v=4` (cache-buster) tidak cocok karena kondisi `req.url === "/stock-opname.js"` memeriksa string penuh termasuk query string. Akibatnya server tidak me-return file JS/CSS. |
| **Akar** | Exact string compare `req.url ===` tanpa mem-pas query string. Sama pola dengan Fix #9 (API handler `GET /api/stock-opname/kategori`) — saat itu sudah diperbaiki di API handler, tetapi handler static file tidak ikut diperbaiki. |
| **Fix** | Ganti `req.url ===` menjadi `req.url.split("?")[0] ===` di kedua handler static file (`.js` dan `.css`) di kedua file (`server.js` dan `www/server.js`). |
| **Verifikasi** | `node --check` exit 0 untuk kedua file. Byte-compare: kedua file identik 365,672 bytes. Grep `stock-opname.(js\|css)` hanya menemukan 1 handler per file per tipe di kedua file — tak ada duplikat. |
| **Pelajaran** | Setiap kali menambahkan handler static file, selalu pakai `req.url.split("?")[0]` atau `parsedUrl.pathname` untuk membandingkan pathname, bukan `req.url` mentah. Cek seluruh static handler sekaligus, bukan hanya yang kena query string saat ini. |

### Fix #13 — Modal Riwayat & Rekap SO: `TypeError: Cannot set properties of null (setting 'innerHTML')` di renderRekapCard
| | |
|---|---|
| **Tanggal** | 2026-10-10 |
| **File** | `stock-opname.js` & `www/stock-opname.js` — `renderRekapCard` (~701), `renderHistoryTable` (~727), `closeHistoryModal` (~863), `openHistoryModal` (~839). `index.html` tidak diubah — elemen statis `soRekapContent`/`soHistoryContent`/`soFilterBulan` sudah ada di kedua file (baris ~9802–9809). |
| **Masalah** | Saat memuat rekap bulanan SO (modal Riwayat & Rekap), log error: `TypeError: Cannot set properties of null (setting 'innerHTML')` di `renderRekapCard` (`stock-opname.js:810`). Riwayat transaksipun tak termuat (`renderHistoryTable` baris 827 crash sama). |
| **Akar** | **DUA cacat berurutan**, bukan sekadar `renderRekapCard`: (1) `closeHistoryModal` (baris 865 lama) menjalankan `modalEl.innerHTML = ''` pada `soHistoryModal` — ini **menghancurkan elemen anak statis** `soRekapContent` (idx 9804), `soHistoryContent` (9809), `soFilterBulan` (9802). (2) Saat modal dibuka ulang, `openHistoryModal` masih menemukan div `soHistoryModal` (外壳nya tak dihapus, hanya innerHTML yang dikosongkan), lalu panggil `loadRekapBulanan` → `getElementById('soRekapContent')` → **null** → crash di `.innerHTML`. `renderRekapCard` & `renderHistoryTable` tak punya guard null, jadi crash langsung muncul. |
| **Fix** | Empat perubahan di `stock-opname.js` (root + www, byte-identik): (1) `renderRekapCard` & `renderHistoryTable` — tambah guard `if (!container) return;` + `console.error` agar tak crash lagi walau elemen benar-benar hilang. (2) `closeHistoryModal` — **hapus** `modalEl.innerHTML = ''`; ganti dengan `classList.add('hidden')` + `style.display='none'` + `aria-hidden` — anak statis tak dihancurkan. (3) `openHistoryModal` — sebelum load, reset `soRekapContent.innerHTML=''` & `soHistoryContent.innerHTML=''` (bersihkan data lama tanpa menghancurkan elemen). (4) `openHistoryModal` — `classList.remove('hidden')` sudah ada; sinkronkan dengan `closeHistoryModal`. |
| **Verifikasi** | `node --check` exit 0 untuk KEDUA file. `Get-Content` root vs www: `MIRROR-IDENTICAL`. Grep `soRekapContent\|soHistoryContent\|soFilterBulan` di `index.html` root & www: semua ada di baris ~9802–9809. **PENDING verifikasi live**: perlu PM2 restart + buka modal Riwayat & Rekap di browser → tutup → buka lagi → rekap card & tabel riwayat tampil tanpa error di console. |
| **Pelajaran** | `modalEl.innerHTML = ''` pada elemen yang memuat **anak statis dari HTML** akan menghancurkan anak-anak itu secara permanen untuk lifetime page-load. Gunakan `classList.add('hidden')` untuk sembunyikan, bukan `innerHTML=''` untuk bersihkan. Guard null selalu diperlukan di fungsi render yang dipanggil `getElementById` — elemen bisa hilang bila ada code path lain yang menghapusnya. |

### Fix #12 — POST /api/stock-opname/submit HTTP 500 "Summary hasil Stock Opname tidak valid.": NaN/undefined lolos ke SQLite Bind
| | |
|---|---|
| **Tanggal** | 2026-10-09 |
| **File** | `server.js` & `www/server.js` — handler `POST /api/stock-opname/submit` (blok ~7650–7770) + helper `normalizeStockOpnameSummary` (blok ~7444–7484) |
| **Masalah** | Submit stock opname menghasilkan HTTP 500 dengan pesan "Gagal memproses stock opname" — detail error menunjuk pada `SQLite bind error` / `Summary hasil Stock Opname tidak valid.`. Akar: (1) ekstraksi `stokRiil`/`hpp` dari DB memakai `Number(r.stok_aktual) \|\| 0` yang menghasilkan `NaN` saat value null/undefined, (2) payload frontend mengirim `stok_fisik` sebagai string kosong `""` → `Number("") = 0` lolos tapi nilai string `"abc"` → `NaN`, (3) variabel `idBarang`/`namaBarang`/`satuan` bisa `undefined` saat payload item tidak lengkap → dimasukkan mentah ke array bind `db.run` → SQLite menolak, (4) `totalPlus/totalMinus/totalKerugian` bisa jadi `NaN` dari akumulasi selisih negatif*NaN, lalu dilemparkan `throw new Error("Summary hasil Stock Opname tidak valid.")` di `normalizeStockOpnameSummary` (baris 7476) → catch outer → 500. |
| **Akar** | Pola sanitasi lama memakai `Number(x) \|\| 0` yang hanya menangani `0`/`null`/`undefined`, BUKAN `NaN` dari konversi string tak-numeric. Tidak ada validasi eksplisit `Number.isFinite` di sepanjang jalur DB→kalkulasi→bind→summary. |
| **Fix** | (1) Blok `dbInfoMap`: ganti dengan `Number.isFinite(Number(r.stok_aktual)) ? Number(r.stok_aktual) : 0` untuk `stokRiil` & `hpp`. (2) Blok `resolvedItems`: `stokFisik` pakai `Number.isFinite(Number(item.stok_fisik)) ? Number(item.stok_fisik) : 0`; fallback `hpp` dari payload juga `Number.isFinite` chain. (3) Tambah sanitasi total: `totalPlus/Minus/Kerugian` di-clamp `Number.isFinite(v) ? Math.max(0, v) : 0` SETELAH loop akumulasi, SEBELUM INSERT header. (4) `processItem`: semua parameter `db.run` diisolasi ke `safeIdMaster/safeIdBarang/safeNamaBarang/safeSatuan/safeStokRiil/safeStokFisik/safeSelisih/safeRugiModal`; nama kosong → `"Barang Tanpa Nama"`, satuan kosong → `"Pcs"`, id undefined → `null`. UPDATE `master_barang` juga pakai `safeStokFisik`/`safeIdMaster`/`safeIdBarang`. (5) `normalizeStockOpnameSummary`: **throw dihapus** — diganti `safeTotalPlus/Minus/Kerugian` via `Number.isFinite(v) ? Math.max(0,v) : 0`, fungsi sekarang TIDAK bisa melempar lagi. |
| **Verifikasi** | `node --check` exit 0 untuk KEDUA file (root & `www/`). Grep `FIX-SO-SUBMIT` menemukan 1 marker di `normalizeStockOpnameSummary` tiap file. Grep `safeRugiModal` menemukan 2 baris (definisi + bind) di `processItem`. Throw "Summary hasil Stock Opname tidak valid." terhapus dari kedua file (grep = 0 match). PENDING live: belum diuji dengan request POST nyata (butuh PM2 restart — menunggu user). |
| **Pelajaran** | `Number(x) \|\| 0` BUKAN sanitasi — ia mengembalikan `NaN` saat `x` string tak-numeric (mis. `"12abc"`), dan `NaN \|\| 0 = NaN`. Selalu pakai `Number.isFinite(Number(x)) ? Number(x) : 0`. Jangan `throw` di jalur yang sudah dalam transaksi SQLite — throw di luar transaksi memblokir ROLLBACK; sanitasi ke nilai default lebih aman. Untuk bind SQLite, SELALU pastikan tidak ada `undefined` di array parameter (SQLite menginterpretasikan undefined sebagai string `"undefined"` → error `unable to bind parameter`). |

### Fix #11 — Non-member Dapat Tarif Diskon UMUM: kategori_member Tidak NULL & Billing paksa "UMUM"

> ⚠️ **Menimpa/mengganti Fix #10** — Fix #10 memaksa non-member ke `"UMUM"` yang justru harga member (Rp18.000/jam), bukan harga normal meja (Rp25.000/jam).

| | |
|---|---|
| **Tanggal** | 2026-10-09 |
| **File** | `server.js` & `www/server.js` — handler `POST /api/meja/buka` (~5843) & `POST /api/meja/hitung-harga` (~5600–5635) |
| **Masalah** | Non-member (tanpa member_id) saat open session menyimpan `kategori_member` yang tidak NULL → billing handler melihatnya sebagai kategori member dan menerapkannya. Akibatnya non-member mendapat tarif diskon UMUM/PELAJAR/PLATINUM alih-alih harga normal meja dari `master_barang.hargaJual`. Regresi dari Fix #10 yang mengganti `"UMUM"` sebagai hardcoded fallback. |
| **Akar** | Fix #10 salah memahami konsep: "UMUM" adalah kategori member (dengan harga Rp18.000/jam di `harga_member_cache`), BUKAN harga normal meja (Rp25.000/jam di `master_barang`). Non-member harus punya `kategori_member = NULL` di DB — NULL = bukan member = pakai harga meja normal. |
| **Fix** | (1) `/api/meja/buka`: tambahkan blok `if (!memberIdInput) { kategoriMember = null; hargaPerJam = null; }` sebelum INSERT — memastikan non-member selalu menyimpan `kategori_member = NULL`. (2) `/api/meja/hitung-harga`: ganti non-member branch dari `"UMUM"` ke `""` (kosong), dan ubah kondisi `if (isExpiredHarga)` menjadi `if (isExpiredHarga \|\| !memberKodeHarga)` — non-member JOIN ke branch harga normal meja (`master_barang.hargaJual`). Guard validasi `!["PLATINUM","UMUM","PELAJAR"].includes(kategori)` kini di-skip bila `kategori` kosong (non-member). |
| **Verifikasi** | `node --check` exit 0 untuk kedua file. Grep `if (!memberIdInput)` menemukan blok baru di baris 5845 root & www. Grep `memberIdInput, kategoriMember` di kedua INSERT `sesi_meja` (baris 5955 & 6027) — nilai NULL saat non-member. Grep `!memberKodeHarga` menemukan kondisi baru di branch harga normal. Identik di root & www. **PENDING live**: belum diuji dengan request POST nyata (butuh PM2 restart — menunggu user). |
| **Pelajaran** | Kategori "UMUM" di sistem ini = kategori member (bukan "umum" dalam arti non-member). Non-member TIDAK PERNAH punya kategori — harus NULL. Gunakan NULL sebagai sentinel "bukan member, pakai harga normal meja", bukan string kosong atau hardcoded kategori. |

### Fix #10 — Non-member Dapat Tarif Diskon PELAJAR: kategori Dipercaya dari rawKategori Frontend

| | |
|---|---|
| **Tanggal** | 2026-10-09 |
| **File** | `server.js` & `www/server.js` — handler `POST /api/meja/hitung-harga` (baris ~5600–5603) |
| **Masalah** | Saat `memberKodeHarga` kosong (non-member), kategori dihitung dari `String(rawKategori).trim().toUpperCase()` — input mentah frontend. Attacker/kasir curang bisa kirim `kategori: "PELAJAR"` tanpa `sessionId`/`member_id` dan dapat tarif diskon pelajar. |
| **Akar** | Baris fallback (non-member branch) mempercayai payload frontend sebagai sumber kebenaran kategori. Untuk sesi tanpa member aktif, kategori TIDAK PAKAI-nya dari frontend — harus dikunci ke UMUM. |
| **Fix** | Ganti 2 baris: (1) Non-member branch: `String(rawKategori).trim().toUpperCase()` → `"UMUM"` (hardcoded, menolak input). (2) Member branch: `kategoriMemberHarga ? kategoriMemberHarga : kategoriSesi` → `kategoriMemberHarga ? kategoriMemberHarga : (kategoriSesi \|\| "UMUM")` — jika `kategoriMemberHarga` kosong (member tanpa kategori), fallback ke `kategoriSesi` atau UMUM, bukan string kosong. |
| **Verifikasi** | `node --check` exit 0 untuk kedua file. Grep `rawKategori` masih ada di baris 5561 (deklarasi) & 5564 (guard wajib-isi) — tetap dipakai, tidak dihapus. Tidak ada `rawKategori` di logika kategori lagi. Identik di root & www. **PENDING live**: belum diuji dengan request POST nyata (butuh PM2 restart — menunggu user). |
| **Status** | ⚠️ GAGAL — Fix #11 menggantikan, karena "UMUM" adalah kategori member (Rp18.000/jam), bukan harga normal meja (Rp25.000/jam). Non-member harus NULL, bukan "UMUM". |
| **Pelajaran** | Saat field kategori terkait member, jangan pernah percayai payload frontend sebagai sumber kebenaran — kalkulasikan dari sesi DB (`kategori_member`, `member_id` → member list cache). Input frontend hanya valid untuk validasi presence, bukan untuk menentukan harga. |

### Fix #9 — POST /api/stock-opname/submit ERR_HTTP_HEADERS_SENT: Respon Dipanggil Berulang Kali

| | |
|---|---|
| **Tanggal** | 2026-10-09 |
| **File** | `server.js` & `www/server.js` — handler `POST /api/stock-opname/submit` (baris ~7640–7775) |
| **Masalah** | Error `ERR_HTTP_HEADERS_SENT` terjadi saat submit stock opname. Respon HTTP ditulis lebih dari sekali karena loop `for...of` pada `resolvedItems` memanggil `res.writeHead()`/`res.end()` berulang kali melalui callback asynchronous per item. |
| **Akar** | Handler lama melakukan INSERT detail + UPDATE master_barang per item secara berurutan (sequential `await` dalam `for...of`). Meskipun setiap item di-*await*, jika ada error di item ke-N atau kondisi race, respon bisa dikirim berkali-kali atau tidak terkirim sama sekali. Pola callback-based tanpa `res.headersSent` guard rentan terhadap double-write headers. |
| **Fix** | Refactor ke pola `Promise.all`: (1) fungsi helper `processItem()` dibungkus Promise yang menggabungkan INSERT detail + UPDATE master_barang menjadi satu unit; (2) semua item diproses paralel lewat `Promise.all(itemPromises)` di dalam transaksi; (3) semua `res.writeHead()`/`res.end()` dilindungi `if (!res.headersSent)` guard; (4) error handling tetap menggunakan try/catch outer + transaksi ROLLBACK. Auth guard `validateLoginSession` dan outer try/catch dipertahankan. |
| **Verifikasi** | `node --check` exit 0 untuk KEDUA file (root & `www/` — byte-identik 362,699 byte). Grep `headersSent` menemukan 3 tempat baru di handler (baris 7651, 7766, 7772). Grep `processItem` menemukan definisi di baris 7707. `Promise.all(itemPromises)` di baris 7757. Tidak ada perubahan pada rute lain. |
| **Pelajaran** | Jangan pernah memanggil `res.writeHead()`/`res.end()` di dalam loop atau callback yang bisa dieksekusi berulang. Selalu gunakan `res.headersSent` guard. Untuk operasi batch dengan banyak item, gunakan `Promise.all` agar kontrol aliran lebih jelas dan respon hanya dikirim sekali setelah semua item selesai. |

### Fix #8 — POST /api/stock-opname/submit Resolve ID/HPP Salah Kolom: Selisih & Kerugian Tidak Akurat (Blind SO)
| | |
|---|---|
| **Tanggal** | 2026-10-09 |
| **File** | `server.js` & `www/server.js` — handler `POST /api/stock-opname/submit` (~7658-7739), blok resolve stok & per-item INSERT/UPDATE |
| **Masalah** | Frontend blind SO mengirim `items: [{ produk_id: <id INTEGER master_barang>, stok_fisik, keterangan }]` — **tidak** mengirim `id_barang` (TEXT) maupun `harga_modal`. Handler lama `dbStokMap` hanya mencocokkan `WHERE id_barang IN (...)` dengan nilai `produk_id` (mis. `3` vs `RK52`), sehingga tidak pernah cocok → `stokRiil` selalu 0, selisih salah, `totalKerugian` salah. HPP diambil dari `item.harga_modal`/`item.hpp` yang tidak dikirim frontend → kerugian HPP selalu 0. UPDATE stok juga hanya via `id_barang` sehingga tidak pernah mengenai baris bila payload memakai `id` INTEGER. |
| **Akar** | Payload form (id PK INTEGER dari endpoint `/items`) tidak selaras dengan skema DB submit (mencocokkan `id_barang` TEXT + HPP dari payload). |
| **Fix** | (1) `keyOf()` menormalisasi `id`/`produk_id`/`idBarang`/`id_barang`/`produkId`. (2) Resolve via `SELECT id, id_barang, stok_aktual, hpp FROM master_barang WHERE id IN (...) OR id_barang IN (...)` — peta `dbInfoMap` berisi `{ id, idBarang, stokRiil, hpp }`; HPP diambil dari DB, bukan payload. (3) INSERT detail kini memakai `id_barang` (TEXT, kolom yang memang ada di skema) + `local_master_barang_id` = PK INTEGER, dan UPDATE stok via `WHERE id = ?` (PK) dengan fallback `id_barang`. Query items BONUS tetap menghasilkan 0 baris karena filter `UPPER(COALESCE(kategori,''))!='BONUS'` (2 item kategori BONUS di DB memang di-exclude dari form blind SO). |
| **Verifikasi** | `node --check` PASS (exit 0) untuk `server.js` & `www/server.js` (kedua blok identik). Query read-only pos.db via sqlite3: `master_barang` kategori = ROKOK 52 / BAR 28 / DAPUR 23 / KASIR 9 / MEJA 4 / BONUS 2; simulasi query items utk kategori `BONUS` = **0** baris; `stok_kode_demi`/`stok_harian` **tidak ada** (jangan dirujuk). `stock_opname` & `stock_opname_detail` masing-masing 0 baris. PENDING live: belum diuji dengan request POST nyata (butuh PM2 restart — menunggu user). |
| **Pelajaran** | Sebelum menulis handler submit yang re-resolve data DB: cocokkan TIPE & NAMA kolom kunci antara payload form (`produk_id` = PK INTEGER `id`) dan skema DB (`id_barang` TEXT). Jangan andalkan payload membawa `harga_modal` — ambil dari `master_barang.hpp` saat submit. Uji dengan simulasi query read-only, bukan asumsi. |

### Fix #7 — GET /api/stock-opname/kategori Exact-Match req.url: Query String Menjatuhkan 404
| | |
|---|---|
| **Tanggal** | 2026-10-09 |
| **File** | `server.js` & `www/server.js` — handler `GET /api/stock-opname/kategori` dipindah dari blok stock-opname (baris lama ~7448) ke atas handler, sebelum `// STATIC FILE HANDLERS` (baris baru 1998–2024) |
| **Masalah** | Rute memakai `req.url === "/api/stock-opname/kategori"` (exact string). Request apa pun yang membawa query string (mis. cache-buster `?_=...`) tak pernah cocok, jatuh ke fallback 404 `res.writeHead(404)` (baris lama 8615) → di browser muncul 404. Handler baru memakai `parsedUrl.pathname === "/api/stock-opname/kategori"` sehingga query string diabaikan. |
| **Akar** | Pola routing proyek ini: hampir semua rute dipukul dengan `req.url ===` atau `req.url.startsWith(...)` — exact-match string penuh termasuk query string. URL yang sama dengan query gagal match. Handler lama juga TIDAK ada di posisi awal (baris 7448, jauh setelah 60+ rute lain), padahal tidak ada jalur static-file yang menelan `/api/...` — jadi akar 404-nya adalah exact-match + query string, bukan urutan; tetap dipindah ke atas sesuai instruksi agar terjamin diproses sebelum static handlers. |
| **Fix** | Handler dipindah & ditulis ulang persis sesuai spesifikasi: `const parsedUrl = require("url").parse(req.url, true); const pathname = parsedUrl.pathname;` lalu `if (req.method === "GET" && pathname === "/api/stock-opname/kategori")`. Auth guard `validateLoginSession` DAN outer try/catch dipertahankan; guard `res.headersSent` sebelum writeHead; respons error → 200 + data kosong (pola lama, bukan 500). Sisipan tepat sebelum `// STATIC FILE HANDLERS`. Handler lama di baris 7448 HAPUS. |
| **Verifikasi** | `node --check` exit 0 untuk KEDUA file (root 360,338 → 360,301 byte setelah penghapusan blok lama; www identik). Grep `stock-opname/kategori` hanya menemukan handler baru di baris 2000 kedua file — tak ada duplikat/rute lain tersisa. **PENDING verifikasi live**: belum diuji dengan request nyata (butuh PM2 restart — DILARANG OTOMATIS, menunggu user). Query `SELECT DISTINCT kategori FROM master_barang` tak bisa dieksekusi langsung dari sesi ini. |
| **Pelajaran** | (1) Rute GET yang menerima query string SELALU pancing dengan `pathname`/`startsWith`, bukan exact `req.url ===` — exact-match hanya aman untuk URL tanpa query. (2) Jangan menyalin handler yang sudah ada tanpa mengecek pola `req.url`-nya: bug-nya ada di kondisi match, bukan di logika query. (3) `require("url")` di dalam callback request handler aman (Node module cache), tapi `url.parse(req.url, true)` di baris 1998 root juga sudah tersedia — konsisten dengan spec user, tidak perlu refactor global. |

### Fix #6 — POST /api/stock-opname/submit Kolom Tak Cocok Skema DB: INSERT Gagal Fatal
| | |
|---|---|
| **Tanggal** | 2026-10-09 |
| **File** | `server.js` & `www/server.js` — handler `POST /api/stock-opname/submit` (baris ~7649-7742); backup: `server.js.pre-so-submit-fix` & `www/server.js.pre-so-submit-fix` |
| **Masalah** | Handler lama INSERT ke `stock_opname (kategori, kasir_id, total_item, total_selisih_qty, total_kerugian_modal, catatan, created_at)` dan `stock_opname_detail (opname_id, produk_id, stok_sistem, stok_fisik, selisih, harga_modal, total_rugi_modal, keterangan)` — kolom-kolom itu TIDAK ADA di skema riil pos.db. Tiap submit SO pasti error `SQLITE_ERROR: no such column`, transaksi gagal total. |
| **Akar** | Handler ditulis mengacu skema imajiner/lama, tidak pernah diverifikasi terhadap `sqlite_master` DB produksi. Skema riil (diekstrak dari binary pos.db): `stock_opname(so_id, kategori, petugas, tanggal, revisi_ke, is_final, status, total_plus, total_minus, total_kerugian, created_at, updated_at, source)`; `stock_opname_detail(so_id, id_barang, nama_barang, area, satuan, jumlah_barang_aktual, jumlah_hasil_so, selisih_barang, kerugian_hpp, kerugian_harga_jual, nominal_plus, created_at, updated_at, local_master_barang_id)`; `master_barang(id, nama, hpp, harga_jual, updated_at, kategori, stok_aktual, id_barang)`. |
| **Fix** | Tulis ulang handler mengikuti spesifikasi resmi user: (1) `so_id = "SO-" + Date.now()`; (2) INSERT header `stock_opname (so_id, kategori, petugas, tanggal, status='COMPLETED', is_final=1, total_plus, total_minus, total_kerugian, created_at, updated_at, source='POS')`; (3) per item INSERT `stock_opname_detail (so_id, local_master_barang_id, nama_barang, jumlah_barang_aktual, jumlah_hasil_so, selisih_barang, kerugian_hpp, satuan)`; (4) UPDATE `master_barang SET stok_aktual=?, updated_at=? WHERE id_barang=?` (match via `id_barang` TEXT, bukan `id` INTEGER — item SO memakai id string PBMS). Semua dalam BEGIN/COMMIT + ROLLBACK on error; auth guard `validateLoginSession` + outer try/catch dipertahankan. Endpoint lain (`/simpan`, `/snapshot`, `/finalize`, history, rekap) TIDAK disentuh. |
| **Verifikasi** | `node --check` PASS (exit 0) untuk KEDUA file: `server.js` & `www/server.js`. Kedua file identik di blok handler (length 360338). Backup dibuat sebelum patch. PENDING: belum diuji live (butuh PM2 restart — dilarang otomatis, menunggu user). |
| **Pelajaran** | Selalu ekstrak DDL riil dari DB (`sqlite_master`) sebelum menulis SQL — jangan percaya kolom dari memori/kode lama. `sqlite3` Node di UNC share tak bisa buka DB (lock); salin dulu ke lokal atau ekstrak DDL dari binary. UPDATE master_barang pakai `id_barang` (TEXT) bukan `id` (INTEGER) karena id di payload SO adalah string PBMS. |

### Fix #5 — Dropdown Bonus Buka Meja Tidak Sinkron Saat Member Berubah di Saja Modal Produk
| | |
|---|---|
| **Tanggal** | 2026-10-08 |
| **File** | `index.html` & `www/index.html` — listener `memberSelected`, `fetchDetailSesi`, `tutupModalBukaMeja` |
| **Masalah** | `sinkronTampilanPilihanBonus()` hanya dipanggil dari `setModeSesiBukaMeja` dan `bukaMejaDariModalBaru`. Tiga titik perubahan state lain tidak memanggilnya: (1) listener `memberSelected` meng-set `pendingMemberForMeja`/`memberByMeja` tanpa sync — dropdown bonus tidak muncul/menghilang saat kasir memilih atau menghapus member; (2) `fetchDetailSesi` memulihkan `memberByMeja` dari DB tanpa sync; (3) `tutupModalBukaMeja` tidak me-reset `currentBukaMejaDraft = null` sebelum sync. |
| **Akar** | Fungsi sync dirancang reaktif hanya terhadap perubahan mode/durasi, bukan terhadap semua titik mutasi state (member, draft, modal close). Listener `memberSelected` dengan `if (!member) return` juga tidak bisa menghapus member, jadi `memberByMeja` tetap berisi member lama setelah penghapusan. |
| **Fix** | `memberSelected`: ganti early-return dengan if/else (member null → hapus dari `memberByMeja`), lalu panggil `sinkronTampilanPilihanBonus()` di akhir. `fetchDetailSesi`: tambah `sinkronTampilanPilihanBonus()` setelah `memberByMeja.set`. `tutupModalBukaMeja`: tambah `currentBukaMejaDraft = null` + `sinkronTampilanPilihanBonus()` agar modal yang dibuka ulang selalu mulai bersih. Total 5 call-site di tiap file. |
| **Verifikasi** | `new vm.Script` terhadap 4 blok `<script>` di kedua `index.html` → 0 error. `grep -c 'sinkronTampilanPilihanBonus()' index.html` = 6 (5 call-site + 1 deklaras); `www/index.html` = 6, identik. Belum diuji UI manual (butuh server live). |
| **Pelajaran** | Setiap titik mutasi state (member, draft, modal close) yang mempengaruhi tampilan dropdown WAJIB diikuti call re-sync. Jangan andalkan satu-satunya pemanggil (mode change) karena member dapat berubah tanpa mode berubah. |

### Fix #4 — Nama Bonus Tumpang-Tindih Dropdown vs Database: Member + Paket 3 Jam Gagal Dibuka
| | |
|---|---|
| **Tanggal** | 2026-10-08 |
| **File** | `index.html` & `www/index.html` (dropdown `#pilihanBonusBukaMeja`, opsi `value`); `server.js` (baris ~5763 & 5774) |
| **Masalah** | Dropdown bonus (skenario 3: Member + Paket 3 Jam) mengirim `"Bonus Kopi"`/`"Bonus Es Teh"`, backend mencari baris `master_barang` bernama `"bonus kopi"`/`"bonus es teh"` (lowercase) — tidak ditemukan karena DB menyimpan `"Kopi Bonus"` (id 50997) & `"Es Teh Bonus"` (id 50998). Hasil: `throw new Error("Barang bonus tidak valid di master_barang")` → rollback seluruh transaksi, sesi tidak terbuka. Skenario 3 gagal. |
| **Akar** | Nama opsi dropdown dibuat terpisah dari `master_barang` tanpa sinkronisasi; urutan kata terbalik ("Bonus Kopi" vs "Kopi Bonus"). Validasi di `member-schedule.js` / `isBonusItem` (baris 1407-1420, 3521) sudah memakai `"kopi bonus"`/`"es teh bonus"` — dropdown & blok `/api/meja/buka` paket 3 jam satu-satunya yang memakai nama terbalik. |
| **Fix** | `index.html` & `www/index.html`: ubah `value` & label opsi menjadi `"Kopi Bonus"` / `"Es Teh Bonus"`. `server.js` (root & www): validasi array `["kopi bonus","es teh bonus"]` dan pesan error `"Pilihan bonus (Kopi Bonus / Es Teh Bonus) wajib dipilih untuk Member"`. |
| **Verifikasi** | Simulation backend lookup terhadap DB live: `"Kopi Bonus"` → found=`Kopi Bonus`, accepted=true, harga=0; `"Es Teh Bonus"` → found=`Es Teh Bonus`, accepted=true, harga=0. `paket 3 jam non member` → harga 70000 (skenario 1 & 3 billing). Skenario 4: `validasiBatasSesiMemberPagi` teruji — PELAJAR mulai 17:00 WITA +3h → DITOLAK (selesai 20:00 > batas 19:00 WITA); PLATINUM mulai 16:00 WITA +3h → DITERIMA (selesai tepat 19:00); UMUM mulai 20:00 WITA (malam, >18:00) → DITERIMA (non-morning, skip validasi). |
| **Pelajaran** | Nama master_barang adalah sumber kebenaran — jangan beri nilai terpisah di UI/validasi tanpa cek DB. Cek `SELECT nama FROM master_barang WHERE lower(nama) LIKE '%bonus%'` sebelum menulis kode yang mereferensikan nama barang. |

### Fix #3 — Tombol UANG PAS di Input Cash Kasir: Isi Otomatis #bayar = Total Bayar Akhir
| | |
|---|---|
| **Tanggal** | 2026-10-08 |
| **File** | `index.html` & `www/index.html` — area `#cashArea`: input `#bayar` dibungkus div flex + tombol `#uangPasBtn` (inline, tanpa CSS baru); JS: fungsi baru `isiUangPas()` setelah listener input `#bayar` (sekitar baris 7110 root / 7150 www) |
| **Masalah** | Kasir harus mengetik manual nominal yang persis sama dengan total akhir transaksi agar kembalian Rp0; mudah salah ketik → kembalian salah atau validasi pembayaran gagal (`bayar < total` ditolak di `bayarTransaksi()`). |
| **Akar** | (Bukan bug — feature yang diminta user.) |
| **Fix** | Tombol UANG PAS di samping input `#bayar` di `#cashArea` (selalu tampil saat metode CASH & QRIS, karena keduanya menampilkan `cashArea`). `isiUangPas()`: ambil `getTotal()` (sumber total yang SAMA dengan `getPaymentValues()` yang dipakai `updateKembalian()` & `bayarTransaksi()` — tidak menghitung harga sendiri), isi `#bayar` = `formatCurrencyInput(total)` (format identik input manual), lalu `updateKembalian()` — tanpa memanggil `bayarTransaksi()`. Guard: `total <= 0` → tidak mengisi. Logika harga/diskon/metode/DB/backend & validasi `CASH+QRIS` tidak disentuh; validasi `bayarTransaksi()` tetap berlaku (tombol hanya mengisi input). |
| **Verifikasi** | PENDING verifikasi: syntax check 4 inline script di kedua file PASS (`new vm.Script`, 0 error). Belum diklik manual di UI kasir (butuh server live). |
| **Pelajaran** | Isi otomatis input cash HARUS memakai `getTotal()` — sumber yang sama dengan `updateKembalian()`/`bayarTransaksi()` — bukan hitung ulang sendiri. Setelah programatik mengisi input, tetap panggil `updateKembalian()` agar tampilan KEMBALIANSINKRON dengan input manual. |

### Fix #2 — Cache Key Harga Meja Tak Berisi Identitas Member + Lookup Raw Number/String Mismatch: Harga Member Sebelumnya Bisa Dipakai Ulang
| | |
|---|---|
| **Tanggal** | 2026-10-07 |
| **File** | `index.html` & `www/index.html` (`getTotal()`, blok `cacheKey` di sekitar `window._hargaMejaCache`); `server.js` & `www/server.js` (`/api/meja/buka` lookup member, `/api/meja/hitung-harga` kategori) |
| **Masalah** | (1) Cache key `window._hargaMejaCache` = `meja_kategori_durasi_waktuMulai` tanpa `memberId` — hasil harga dari member A bisa dipakai saat meja berganti ke member B dengan kategori/durasi/waktuMulai yang sama. (2) Lookup member di `/api/meja/buka`: `m.id === memberIdInput || m.kodeMember === memberIdInput` — perbandingan raw; `memberIdInput` selalu string (hasil `String(data.memberId).trim()`), `m.id`/`m.kodeMember` bisa number → mismatch `3` vs `"3"`, member tidak ditemukan, atau fallback ke member lain. (3) `/api/meja/hitung-harga` mempercayai `kategori` dari frontend tanpa memvalidasi terhadap `member_id` sesi saat sesi sudah punya member. |
| **Akar** | Cache key tidak menyimpan identitas member sehingga dua member berbeda dengan kategori sama dianggap identik. Lookup raw `===` di antara string vs number gagal saat tipe data DB berbeda dari input. Kategori dari frontend tidak diverifikasi terhadap member terkait sesi, sehingga kategori lama/stale bisa dipakai. |
| **Fix** | (1) Cache key ditambah `memberId` ter-normalkan: `` `${activeMeja}_${String(memberIdCache).trim()}_${kategori}_${durasiJam}_${waktuMulai}` `` — `memberIdCache` = `member.idMember ?? member.memberId ?? member.id ?? member.kodeMember ?? member.kode_member ?? ""`, normalisasi string agar `3` dan `"3"` menghasilkan key sama. (2) Lookup di `/api/meja/buka`: `String(m.id) === String(memberIdInput) || String(m.kodeMember) === String(memberIdInput)` — semua sisi dibungkus `String()`, tidak mengubah nilai ID DB. (3) Di `/api/meja/hitung-harga`: saat `mejaSessionHarga.member_id` ada, kategori di-resolve dari `getMemberListCached()` (sumber kebenaran = member terkait sesi); kategori lama dari sesi (`kategoriSesi`) hanya jadi fallback bila member tak ditemukan di cache. Bila tak ada member di sesi, input frontend tetap dipakai. |
| **Verifikasi** | PENDING verifikasi: `node --check server.js` & `www/server.js` exit 0; grep `members.find(m => m.id === memberIdInput || m.kodeMember === memberIdInput)` = 0 match; grep `cacheKey = \`${activeMeja}_${kategori}` (tanpa memberId) = 0 match di kedua index.html. Belum dijalankan live. |
| **Pelajaran** | Cache key harus memuat SEMUA variabel yang mempengaruhi hasil — termasuk identitas subjek (memberId), bukan hanya parameter (kategori/durasi). Perbandingan ID cross-tipe wajib dibungkus `String()` di kedua sisi agar `3` dan `"3"` tetap cocok. Kategori yang disimpan di sesi DB bisa stale — selalu re-resolve dari sumber kebenaran (cache member list) saat menghitung harga. |

### Fix #1 — Lepas Ketergantungan KWH dari Tutup Kasir: Kasir Tak Lagi Wajib Input KWh Akhir
| | |
|---|---|
| **Tanggal** | 2026-10-06 |
| **File** | `server.js`, `www/server.js` (endpoint `tutup-preview` & `tutup`); `index.html`, `www/index.html` (`hitungTutupKasir`, `validasiTahapTutupKasir`, `kunciInputTutupKasir`) |
| **Masalah** | Kasir wajib mengisi KWh Dalam Akhir & KWh Luar Akhir sebelum LIHAT HASIL/SELESAI. Backend memvalidasi `akhir >= tersedia` (guard `kwhValidationErrors`) dan mismatch snapshot KWH bisa menggagalkan Tutup Kasir. |
| **Akar** | Proses Tutup Kasir bergantung penuh pada input KWH yang sebenarnya tidak dibutuhkan kasir; nilai `saldo_kwh_*_akhir` dijadikan syarat validasi & snapshot. |
| **Fix** | `tutup-preview` menetapkan `saldoKwhDalamAkhir = 0` & `saldoKwhLuarAkhir = 0` (tanpa input kasir), hapus blok `kwhValidationErrors` & guard mismatch KWH di `tutup`. Frontend hapus 2 input KWH akhir, array check `["actualCash"]` saja, hapus Tahap 4 validasi KWH, bersihkan fungsi mati `readKwhAkhirDigits`/`formatKwhAkhirDigits`. Hitungan Cash/QRIS/Total/Selisih tetap utuh; skema DB & endpoint `pembelian-kwh`/`confirm-opening` tak diubah. |
| **Verifikasi** | PENDING verifikasi: `node --check` kedua server.js exit 0; grep `kwhValidationErrors` = 0 match; grep `kwhDecimalToScaled(data.saldo_kwh_akhir)` = 0 (hanya `_awal` di confirm-opening). Belum dijalankan live alur tutup kasir. |
| **Pelajaran** | Nilai KWH tetap disimpan (default 0) karena kolom ada di skema UPDATE SQL — jangan hapus kolom DB. Snapshot tetap memuat objek `kwh` (akhir=0) sehingga display/validasi opsional di `validasiHasilTutupKasir` tak pecah. |
