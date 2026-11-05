# Handoff: Fix Race Condition di wa-gateway `/send`

**Tanggal:** 2026-10-14
**File target:** `C:\POS\wa-gateway\index.new.js`
**Status:** PERBAIKAN SELESAI — perlu verifikasi dengan test real

## Masalah yang Diperbaiki

### Bug 1: Concurrent Check Salah Deteksi (409 Palsu)
Dua pesan berurutan ke nomor yang sama ditolak dengan 409 Conflict padahal seharusnya bisa并行.

**Akar:** `pendingSends` keyed by `chatId` (contoh: `628123456789@c.us`). Pesan pertama masuk, event `message_create` belum tiba, pesan kedua langsung cek `pendingSends.has(chatId)` → true → tolak.

**Fix:**
- Tambah `sendSeq` counter global, tiap pengiriman dapat key unik: `send_1`, `send_2`, dst.
- Entry didaftarkan dengan key ini, bukan `chatId`.
- `lookupPending()` punya 3 tahap fallback:
  1. `msg.id.id` → langsung ketemu setelah migrasi
  2. `msg.to` → fallback key lama
  3. Loop all entries, cocokkan `entry.chatId === msg.to` → untuk kasus entry keyed `send_N`

### Bug 2: Race Condition di Lookup (CorrelId Tabrakan)
Jika `message_create` dan `message_ack` untuk pesan berbeda tiba bersamaan, bisa salah korelasi karena Map keyed by `chatId` yang sama.

**Fix:**
- `handleSendEvent()` mendeteksi transisi dari `send_N` ke `msg.id.id` riil WhatsApp.
- Saat migrasi: hapus key lama (`send_N`), ganti dengan `msg.id.id`.
- Cleanup callback (resolve/reject/timeout) juga membersihkan kedua key.

### Bug 3: Orphan Entry Menumpuk
Entry yang timeout tapi tidak pernah dapat ACK bisa menumpuk di Map.

**Fix:**
- `cleanupStaleEntries()` jalan setiap 10 detik, hapus entri yang:
  - `!entry.createdTs` (belum pernah dapat message_create)
  - `!entry.confirmed && !entry.ackError` (belum settle)

## Ringkasan Perubahan Kode

| Bagian | Sebelum | Sesudah |
|--------|---------|---------|
| Key Map | `chatId` (`628xxx@c.us`) | `send_N` → migrasi ke `msg.id.id` |
| Concurrent check | `pendingSends.has(chatId)` | Scan values, cek `!confirmed && !ackError` |
| Lookup | 2 tahap (id.id, msg.to) | 3 tahap (+ fallback chatId match) |
| Cleanup | Tidak ada | Interval 10s, hapus orphan |

## Verifikasi yang Perlu Dilakukan

1. **Test normal:** Kirim pesan ke nomor A → dapat response sukses.
2. **Test rapid-fire:** Kirim 2 pesan berurutan ke nomor A dalam 1 detik → harus keduanya sukses (bukan 409).
3. **Test concurrent:** Kirim pesan ke nomor A dan B bersamaan → keduanya sukses.
4. **Monitor log:** Pastikan tidak ada `[cleanup] Removed stale entry` berulang di kondisi normal.
5. **Monitor memory:** Pastikan `pendingSends.size` tidak tumbuh tanpa batas.

## Cara Test Manual

```bash
# Start gateway
cd C:\POS\wa-gateway
node index.new.js

# Test 1: Single send
curl -X POST http://127.0.0.1:3101/send \
  -H "x-api-token: YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"number":"628123456789","message":"Test 1"}'

# Test 2: Rapid fire (2 pesan berurutan ke nomor sama)
curl -X POST http://127.0.0.1:3101/send \
  -H "x-api-token: YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"number":"628123456789","message":"Rapid 1"}'
  
curl -X POST http://127.0.0.1:3101/send \
  -H "x-api-token: YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"number":"628123456789","message":"Rapid 2"}'
```

## Catatan Penting

- **Jangan replace `index.js` dengan `index.new.js` sebelum verifikasi.**
- Simpan `index.new.js` sebagai branch/testing dulu.
- Jika ada masalah, bandingkan dengan `index.js` (original) yang masih utuh.
- Log penting untuk diagnosa:
  - `[cleanup] Removed stale entry send_N` → normal jika ada timeout
  - `Gagal mengirim pesan:` → cek error detailnya
