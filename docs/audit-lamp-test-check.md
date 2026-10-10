# Audit Fitur "Cek Lampu COM3" — Read-Only

Tanggal audit: 2026-10-07
Batasan: TIDAK mengubah file, TIDAK membuat fungsi baru, TIDAK restart PM2.

---

## 1. FILE YANG DIAUDIT

| File | Peran |
|------|-------|
| `\\100.117.233.11\pos\lamp-controlle\lamp-controller.js` | Controller serial COM3 |
| `\\100.117.233.11\pos\server.js` | Server utama (root) |
| `\\100.117.233.11\pos\www\server.js` | Server mirror (www) |

---

## 2. CONTROLLER COM3

**File**: `\\100.117.233.11\pos\lamp-controlle\lamp-controller.js`

### Konfigurasi Serial Port
| Parameter | Nilai |
|-----------|-------|
| Path / COM port | `COM3` (konstanta `SERIAL_PATH`) |
| Baud rate | `9600` |
| Data bits | `8` |
| Stop bits | `1` |
| Parity | `'none'` |
| RTS/CTS | `false` |
| XON/XOFF | `false` |
| autoOpen | `false` (dibuka manual via `ensureSerialPortOpen()`) |
| Line terminator | `'\r'` |

### Mekanisme Open/Close/Error
- **Init**: `initSerialPort()` dipanggil saat module load (baris 374), membuat instance `SerialPort` tapi **tidak langsung membuka**.
- **Lazy open**: `ensureSerialPortOpen()` (baris 90) membuka port saat perintah pertama dikirim.
- **Opening promise**: `openingPromise` mencegah buka port ganda saat proses open berlangsung.
- **Error handling**:
  - Buka gagal → reject promise, `port = null`, `openingPromise = null`.
  - Port tertutup sebelum terbuka → reject promise.
  - Setelah close → `port = null`, `openingPromise = null` (akan dibuka ulang otomatis pada command berikutnya).
- **Command format**: `${table}${stat}\r` — contoh: `"21\r"` (meja 2 ON), `"30\r"` (meja 3 OFF).

### Queue / Lock / Serialisasi
- **Ada global command queue** (baris 24): `let commandQueue = Promise.resolve();`
- Setiap panggilan `lampSet` menambahkan promise ke antrian:
  ```js
  const task = commandQueue.then(() => sendLampCommand(table, stat), () => sendLampCommand(table, stat));
  commandQueue = task.catch(() => {}); // tetap lanjut meski gagal
  ```
- **Semua command lampu tereksekusi SEKUENSIAL** — tidak ada dua command yang menulis ke COM3 bersamaan.
- Setelah write sukses, `serialPort.drain()` dipanggil untuk menunggu buffer kosong sebelum command berikutnya di-antri.

### Fungsi yang Diekspor
```js
module.exports = { lampSet, lampOn, lampOff, lampBlink15Minute };
```

### Apakah aman dipanggil fitur baru?
- **Ya, secara teknis aman** karena sudah ada queue.
- **TAPI**: queue hanya mencegah WRITE konkuren, **TIDAK melindungi dari interleaving dengan watchdog**. Watchdog juga membaca & menulis via queue yang sama, sehingga hasil test bisa "diganggu" oleh command watchdog yang masuk di tengah siklus test.

---

## 3. PEMAKAI COM3 (Seluruh Pemanggil)

### A. Pembayaran / Transaksi
| Baris | Fungsi | Aksi |
|-------|--------|------|
| 5114 | (mulai paket/session baru) | `lampOn(nomorMeja)` |
| 5572 | (mulai session baru) | `lampOn(nomorMeja)` |
| 6023 | (perpanjangan durasi) | `lampOn(nomorMejaPaket)` |
| 6113 | (perpanjangan durasi) | `lampOn(nomorMeja)` |

### B. Sesi Selesai / Tutup Meja
| Baris | Fungsi | Aksi |
|-------|--------|------|
| 3496 | `lampOff(tableSession.nomor_meja)` | Matikan lampu setelah aksi tertentu |
| 5858 | `lampOff(mejaSession.nomor_meja)` | Matikan lampu saat sesai |
| 6558 | `lampOff(nomorMeja)` dalam `closeTableSession()` | Matikan lampu saat sesi ditutup |

### C. Pindah Meja
| Baris | Fungsi | Aksi |
|-------|--------|------|
| 5699 | `lampOff(nomorMejaAsal)` | Matikan lampu meja asal |
| 5713 | `lampOn(nomorMejaTujuan)` | Nyalakan lampu meja tujuan |

### D. Watchdog (Reconcile)
| Baris | Fungsi | Aksi |
|-------|--------|------|
| 8010-8011 | `reconcileLampState()` | `lampOn(table)` atau `lampOff(table)` sesuai status sesi |

### E. Peringatan 15 Menit
| Baris | Fungsi | Aksi |
|-------|--------|------|
| 1465 | `trigger15MinuteLampWarning()` | `lampBlink15Minute(nomorMeja)` — ON/OFF/ON/OFF/ON berurutan |

### F. Endpoint API Manual
| Baris | Fungsi | Aksi |
|-------|--------|------|
| 2945 | `POST /api/lamp` | `lampSet(table, status)` |
| 2947 | `POST /api/lamp/on` | `lampOn(table)` |
| 2949 | `POST /api/lamp/off` | `lampOff(table)` |

**Ringkasan**: 7 kategori pemakai, semua melalui fungsi yang sama di `lamp-controller.js`.

---

## 4. WATCHDOG

### Nama fungsi
`reconcileLampState()` — baris 7901

### Interval / Cadence
```js
setInterval(reconcileLampState, 10 * 1000); // setiap 10 detik
```

### Mekanisme Lock
- Variabel `lampWatchdogRunning` (baris 7898) berfungsi sebagai **mutex boolean**:
  ```js
  async function reconcileLampState() {
    if (lampWatchdogRunning) return; // skip jika sedang berjalan
    lampWatchdogRunning = true;
    try { ... } finally {
      lampWatchdogRunning = false;
    }
  }
  ```
- **TIDAK ADA lock bersama dengan command queue** — `lampWatchdogRunning` hanya mencegah watchdog berjalan paralleldirinya sendiri, TIDAK menghalangi pemanggil lain (`lampOn`, `lampOff` dari endpoint, dll).

### Cara `activeTables` Diperoleh
```sql
SELECT nomor_meja, waktu_selesai, jenis_sesi
FROM sesi_meja
WHERE status = 'AKTIF'
```
Hasilnya dibangun menjadi `desiredLampState` Map:
- Table dengan sesi LOSS atau tanpa `waktu_selesai` → state = 1 (ON)
- Table dengan `waktu_selesai` di masa depan → state = 1 (ON)
- Table dengan `waktu_selesai` sudah lewat → state = 0 (OFF)
- Table tanpa entri di `desiredLampState` dan `lastState === undefined` → skip (anggap OFF)

### Command yang Dikirim
- Loop table 1–10:
  - Jika desired == last sent → skip
  - Jika desired = 1 → `lampOn(table)`
  - Jika desired = 0 → `lampOff(table)`

### Risiko Interleaving dengan Test Lampu
**SANGAT RELEVAN — ini masalah utama.**

Skenario nyata yang bisa terjadi:
```
[W0]  TEST: queue.push(lampOn(2))  → meja 2 nyala
[W1]  WATCHDOG jalannya: query DB → meja 2 TIDAK ada sesi AKTIF → desired = 0
[W2]  WATCHDOG: queue.push(lampOff(2)) → meja 2 mati
[W3]  TEST berlanjut: queue.push(lampOn(3)) → meja 3 nyala
[W4]  WATCHDOG jalannya lagi (10 detik kemudian): query DB → meja 3 TIDAK ada sesi AKTIF → desired = 0
[W5]  WATCHDOG: queue.push(lampOff(3)) → meja 3 mati
```

**Kesimpulan**: Watchdog akan secara berkala (setiap 10 detik) mengecek DB dan mematikan lampu meja yang tidak punya sesi aktif. Selama test berjalan, semua meja yang dites adalah NON-AKTIF → watchdog akan mematikan mereka.

---

## 5. LOGIKA "MEJA AKTIF"

### Query resmi yang dipakai aplikasi
```sql
SELECT * FROM sesi_meja WHERE status = 'AKTIF'
SELECT * FROM sesi_meja WHERE nomor_meja = ? AND status = 'AKTIF'
SELECT * FROM sesi_meja WHERE session_id = ? AND status = 'AKTIF'
```

### Tabel
`sesi_meja` — struktur:
```sql
CREATE TABLE sesi_meja (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT UNIQUE NOT NULL,
  nomor_meja INTEGER NOT NULL,
  nama_pemesan TEXT NOT NULL,
  kasir TEXT NOT NULL,
  waktu_mulai TEXT NOT NULL,
  waktu_selesai TEXT,
  status TEXT NOT NULL DEFAULT 'AKTIF',
  durasi_jam INTEGER
)
```

### Status yang dianggap "aktif"
`status = 'AKTIF'` — satu-satunya status yang relevan untuk menentukan meja sedang dipakai.

### Bagaimana nomor meja dikaitkan
Field `nomor_meja` di tabel `sesi_meja` menyimpan nomor meja (1–10) yang sedang memiliki sesi aktif.

### Keamanan untuk fitur baru
**AMAN** — query ini sudah dipakai secara konsisten di seluruh aplikasi (watchdog, pindah meja, tutup sesi, dll). Menggunakan query yang sama untuk menentukan `testTables` akan konsisten dengan logika yang sudah ada.

---

## 6. LAST LAMP COMMAND STATE

### Deklarasi
```js
const lastLampCommandState = new Map(); // baris 7899
```

### Tempat State Diubah (ditulis)
| Baris | Konteks |
|-------|---------|
| 2954 | Endpoint `/api/lamp/off` berhasil |
| 3498 | Lamp off setelah aksi tertentu |
| 5115 | Lamp on saat mulai session |
| 5573 | Lamp on saat mulai session |
| 5701 | Lamp off saat pindah meja (asal) |
| 5860 | Lamp off saat sesi berakhir |
| 6024 | Lamp on saat perpanjangan |
| 6114 | Lamp on saat perpanjangan |
| 6560 | Lamp off saat closeTableSession |
| 7992 | Watchdog: inisialisasi undefined → 0 |
| 8022 | Watchdog: setelah command sukses |

### Tempat State Dibaca
| Baris | Konteks |
|-------|---------|
| 7987 | Watchdog: cek lastState sebelum mengirim command |
| 7991 | Watchdog: skip jika belum pernah mengirim dan tidak ada sesi |

### Evaluasi untuk fitur test
- `lastLampCommandState` **TIDAK BOLEH dipakai** untuk tracking status test.
- Alasannya: state ini digunakan watchdog untuk menghindari command redundan. Jika test memanipulasi state ini, watchdog bisa做出 keputusan salah.
- **Solusi**: fitur test harus mempertahankan state-nya sendiri (bukan membaca/menulis `lastLampCommandState`).

---

## 7. RECOVERY LAMPU SAAT STARTUP

### Kapan Dijalankan
- **Tidak ada fungsi recovery khusus** — recovery dilakukan oleh watchdog (`reconcileLampState`) yang berjalan setiap 10 detik sejak server start.
- Saat server pertama kali start, `initSerialPort()` dipanggil (baris 374), lalu setelah semua endpoint terdaftar, `setInterval(reconcileLampState, 10 * 1000)` di-set (baris 8093).

### Cara `activeTables` Ditentukan
Sama seperti watchdog: `SELECT ... FROM sesi_meja WHERE status = 'AKTIF'`.

### Command yang Dikirim
Sama seperti watchdog: loop 1–10, bandingkan desired vs lastState, kirim ON/OFF jika berbeda.

### Kemungkinan Benturan dengan Test
**SAMA seperti risiko watchdog** — karena sesungguhnya watchdog = recovery berkelanjutan. Selama test berjalan, watchdog akan terus berjalan setiap 10 detik dan bisa meng-overwrite status lampu yang sedang dites.

---

## 8. ENDPOINT LAMPU

### Endpoint yang Ada
| URL | Method | Auth | Deskripsi |
|-----|--------|------|-----------|
| `/api/lamp` | POST | `validateLoginSession` | Set status: `{table, status}` |
| `/api/lamp/on` | POST | `validateLoginSession` | Nyalkan meja: `{table}` |
| `/api/lamp/off` | POST | `validateLoginSession` | Matikan meja: `{table}` |
| `/api/lamp-watchdog/alarms` | GET | `validateLoginSession` | Ambil riwayat alarm |

### Authenticasi/Proteksi
Semua endpoint dilindungi oleh `validateLoginSession(req, res)` — mengembalikan session object atau redirect ke login.

### Validasi
- `table` harus integer 1–10.
- `/api/lamp` juga validasi `status` harus 0 atau 1.

### Mekanisme Forward
Semua endpoint memanggil fungsi yang sama dari `lamp-controller.js`: `lampSet`, `lampOn`, `lampOff`.

### Rekomendasi untuk Fitur Test
- **Lebih aman membuat endpoint terpisah** `/api/lamp/test-check` daripada memanipulasi endpoint yang sudah ada.
- Endpoint baru dapat:
  - Mengambil lock eksklusif (mencegah watchdog berjalan)
  - Melakukan test ON/OFF bertahap dengan logging
  - Mengembalikan hasil lengkap ke frontend
- **JANGAN pakai endpoint `/api/lamp/on` atau `/api/lamp/off` berulang kali** karena itu akan memicu write ke `lastLampCommandState` yang bisa mengacaukan watchdog.

---

## 9. ROOT VS WWW

### Kesimpulan
**Keduanya merupakan mirror aktif.**

Bukti:
- `server.js` baris 81: `const { lampSet, lampOn, lampOff, lampBlink15Minute } = require('./lamp-controlle/lamp-controller');`
- `www/server.js` baris 81: sama persis
- `server.js` baris 7898: `let lampWatchdogRunning = false;`
- `www/server.js` baris 7894: sama persis
- `server.js` baris 8093: `setInterval(reconcileLampState, 10 * 1000);`
- `www/server.js`: sama persis

**Jika fitur baru dibuat, harus diterapkan KE KEDUA FILE** (`server.js` dan `www/server.js`) agar konsisten.

---

## 10. RISIKO KONKURENSI

### Apakah Ada Serialisasi Global?
**YA** — `commandQueue` di `lamp-controller.js` (baris 24) menjamin semua command lampu berjalan SEKUENSIAL. Tidak ada dua command yang menulis ke COM3 bersamaan.

### Namun... Serialisasi TIDAK Mencegah Interleaving dengan Watchdog

Skenario konkrit:
```
Time 0s:   TEST mulai → queue: [ON(2), ON(3)]
Time 0.1s: ON(2) dieksekusi → meja 2 NYALA
Time 10s:  WATCHDOG cycle baru:
           - Query DB: tidak ada sesi AKTIF di meja 2, 3
           - desiredLampState = {2: 0, 3: 0}
           - queue: [OFF(2), OFF(3)]
Time 10.1s: OFF(2) dieksekusi → meja 2 MATI (TEST GAGAL!)
Time 10.2s: OFF(3) dieksekusi → meja 3 MATI (TEST GAGAL!)
```

### Semua Sumber Potensial Benturan
| Sumber | Frekuensi | Risiko |
|--------|-----------|--------|
| Watchdog (`reconcileLampState`) | Setiap 10 detik | **TINGGI** — akan mematikan lampu non-aktif |
| Sesi selesai (`closeTableSession`) | Peristiwa | Sedang — hanya memengaruhi meja dengan sesi aktual |
| Pindah meja | Peristiwa | Sedang — ON/OFF dua meja |
| Peringatan 15 menit (`lampBlink15Minute`) | Peristiwa | Sedang — blink 5x selama ~2.5 detik |
| Endpoint manual `/api/lamp*` | Peristiwa | Rendah — hanya jika user lain mengakses |
| Ekstensi durasi | Peristiwa | Rendah — hanya ON |

### Apakah Fitur Test Membutuhkan Lock?
**YA, MUTLAK PERLU.** Tanpa mekanisme penguncian, hasil test akan tidak dapat diandalkan karena watchdog dapat mengganggu di tengah siklus test.

### Di Mana Lock Harus Diletakkan?
**Di layer server (server.js), bukan di lamp-controller.js.** Alasannya:
1. `lamp-controller.js` adalah library murni yang tidak tahu tentang konteks bisnis.
2. Lock harus mencakup: (a) mencegah watchdog berjalan, (b) memastikan test memiliki akses eksklusif ke COM3.
3. Solusi yang paling aman: buat flag `lampTestRunning` di server.js, dan modifikasi `reconcileLampState()` untuk memeriksa flag tersebut.

### Desain Lock yang Direkomendasikan
```js
let lampTestRunning = false; // baru ditambahkan

// Di reconcileLampState():
if (lampWatchdogRunning || lampTestRunning) return; // tambahkan kondisi

// Di endpoint test-check:
lampTestRunning = true;
try {
  // jalankan test
} finally {
  lampTestRunning = false;
}
```

---

## 11. RANCANGAN ARSITEKTUR

### 1. Cara Memastikan COM3 Dapat Digunakan
- Buat endpoint `/api/lamp/test-check` yang pertama-tama mencoba membuka port dengan memanggil `ensureSerialPortOpen()` (atau fungsi internal serupa).
- Jika gagal membuka → return `{ success: false, code: "COM_PORT_UNAVAILABLE", message: "COM3 tidak dapat diakses" }`.
- Jika berhasil → lanjut ke test.

### 2. Cara Mendapatkan `activeTables`
- Query: `SELECT nomor_meja FROM sesi_meja WHERE status = 'AKTIF'`
- Hasilnya dijadikan Set untuk pengecekan cepat: `new Set(rows.map(r => Number(r.nomor_meja)))`

### 3. Cara Menentukan `testTables`
```js
const activeTableSet = new Set(activeTables); // dari query di atas
const testTables = [];
for (let t = 1; t <= 10; t++) {
  if (!activeTableSet.has(t)) testTables.push(t);
}
```

### 4. Urutan ON
- Loop `testTables` dari indeks 0 sampai terakhir:
  - Kirim `lampOn(table)`
  - Tunggu response sukses
  - Log hasil (sukses/gagal + waktu)
  - Simpan ke array `results`
- Jika salah satu gagal → stop ON sequence, lanjut ke tahap recovery (OFF semua yang sudah nyala).

### 5. Urutan OFF
- Setelah semua ON berhasil (atau gagal parsial), loop `testTables` dari indeks 0 sampai terakhir:
  - Kirim `lampOff(table)`
  - Tunggu response
  - Log hasil
- Pastikan semua meja yang tadi dinyalakan kembali ke OFF.

### 6. Penanganan Error di Tengah Test
- **Failsafe**: simpan daftar meja yang berhasil ON. Jika test terputus (timeout/error), jalankan recovery: OFF semua meja di daftar tersebut sebelum mengembalikan kontrol.
- **Timeout per command**: beri batas waktu (misal 5 detik) per command. Jika timeout → anggap gagal, log, lanjut ke command berikutnya.
- **Partial failure**: tetap lanjut test ke meja berikutnya, catat kegagalan di result.

### 7. Cara Mencegah Watchdog/Command Lain Mengganggu Test
- Tambahkan flag `lampTestRunning` (boolean).
- Di `reconcileLampState()`: tambahkan kondisi `if (lampTestRunning) return;`
- Di endpoint test: set `lampTestRunning = true` sebelum test mulai, dan `false` di `finally` block.
- Untuk keamanan ekstra, gunakan `reserveShiftWrite`-style pattern: kembalikan lock hanya setelah semua command test selesai.

### 8. Apa yang Dilakukan Jika Test Gagal Setelah Beberapa Meja ON
- **Langkah 1**: Kumpulkan daftar meja yang sudah ON (berhasil sebelum error).
- **Langkah 2**: Kirim command OFF ke semua meja di daftar tersebut secara berurutan.
- **Langkah 3**: Tunggu semua OFF selesai (dengan timeout).
- **Langkah 4**: Kembalikan flag `lampTestRunning = false`.
- **Langkah 5**: Return result dengan status `partial_failure` + detail meja mana yang gagal.

### 9. Cara Memastikan Semua Meja Kembali OFF
- Setelah fase ON selesai (berhasil atau partial), langsung jalankan fase OFF untuk SEMUA `testTables`.
- Tambahkan validasi akhir: setelah semua OFF, query ulang DB untuk memastikan tidak ada lock/test yang masih berjalan.
- Jika ada meja yang masih ON setelah fase OFF (rare edge case), log warning dan rekomendasikan manual check.

### 10. Bentuk Result yang Dikirim ke Frontend
```json
{
  "success": true,
  "code": "LAMP_TEST_COMPLETE",
  "testedAt": "2026-10-07T10:30:00.000Z",
  "totalTables": 10,
  "activeTables": [2, 5, 7],
  "testTables": [1, 3, 4, 6, 8, 9, 10],
  "results": [
    { "table": 1, "phase": "ON",  "success": true,  "timestamp": "..." },
    { "table": 1, "phase": "OFF", "success": true,  "timestamp": "..." },
    { "table": 3, "phase": "ON",  "success": true,  "timestamp": "..." },
    { "table": 3, "phase": "OFF", "success": false, "timestamp": "...", "error": "timeout" },
    ...
  ],
  "summary": {
    "onSuccess": 6,
    "onFailure": 0,
    "offSuccess": 5,
    "offFailure": 1
  }
}
```

### 11. Endpoint yang Paling Aman
**Endpoint baru**: `POST /api/lamp/test-check`

Alasan:
- Tidak bercampur dengan endpoint existing (`/api/lamp`, `/api/lamp/on`, `/api/lamp/off`).
- Bisa menambahkan logic lock/flag yang spesifik untuk test.
- Hasilnya terstruktur dan berbeda dari response endpoint normal.
- Admin/manager yang membuka halaman ini secara eksplisit memahami bahwa ini adalah test diagnostik.

### 12. File yang Nanti Perlu Diubah

| File | Perubahan yang Direncanakan |
|------|----------------------------|
| `server.js` (root) | Tambah flag `lampTestRunning`, modifikasi `reconcileLampState`, tambah endpoint `/api/lamp/test-check` |
| `www/server.js` | Sama persis (mirror) |
| `lamp-controller.js` | **TIDAK PERLU DIUBAH** — fungsi yang ada sudah cukup |

**Catatan**: `lamp-controller.js` TIDAK perlu diubah sama sekali. Semua perubahan hanya di layer server.js.

---

## 12. KESIMPULAN AUDIT

### Masalah/Risiko Yang Ditemukan
1. **RISIKO TINGGI**: Watchdog (`reconcileLampState`) berjalan setiap 10 detik dan akan memadamkan lampu meja NON-AKTIF. Ini akan mengganggu test secara signifikan.
2. **RISIKO SEDANG**: `lastLampCommandState` digunakan watchdog untuk optimasi — test tidak boleh memanipulasi state ini.
3. **RISIKO RENDAH**: `lampBlink15Minute` bisa berjalan bersamaan jika ada sesi yang mendekati expiry selama test berlangsung.

### Solusi Utama
Tambahkan flag `lampTestRunning` yang:
- Mencegah watchdog berjalan saat test aktif.
- Dijamin di-clear di `finally` block (bahkan jika test gagal).
- Dilindungi oleh mutex pattern seperti `reservedClosePreviews`.

### Rekomendasi Implementasi
Endpoint `/api/lamp/test-check` dengan alur:
1. Validasi session → lock test flag.
2. Ambil active tables dari DB.
3. Hitung testTables (1-10 minus active).
4. Fase ON: loop testTables, kirim lampOn, log result.
5. Fase OFF: loop testTables, kirim lampOff, log result.
6. Release lock flag.
7. Return JSON result ke frontend.

---

**IMPLEMENTASI BELUM DILAKUKAN.**

Laporan ini bersifat READ-ONLY audit saja.