# CHANGELOG Fixes — wa-gateway

### Fix #107 — ACK NOT FOUND / Timeout: Konfirmasi Tidak Diterima
**Tanggal:** 2026-10-15
**File:** `index.new.js` (lines 269, 298–306)
**Masalah:** `POST /send` sering mengembalikan `Timeout: konfirmasi ACK tidak diterima dalam 30 detik` padahal pesan sampai. Log menunjukkan `lookupPending()` → `NOT FOUND` dengan `pendingSends.size=0`.

**Akar:**
1. `sendMessage(waitUntilMsgSent:true)` return local ID (`newId()`), sedangkan event `message_ack` membawa server-assigned ID (`179422711791710@lid`). Reverse index `pendingSendsByServerId` hanya di-register setelah `await sendPromise` resolve — jika event `message_ack` tiba lebih dulu (atau event `message_create` membawa server ID yang berbeda dari local ID), lookup gagal.
2. Guard `fromMe` hanya `!msg.id.fromMe` tidak menangani kasus `msg.id.fromMe === undefined` dengan aman.

**Fix:**
1. (L269) Guard diperketat: `typeof msg.id.fromMe !== 'boolean' || !msg.id.fromMe`.
2. (L298–306) Di `handleSendEvent`, setelah match entry ditemukan, langsung daftarkan `msg.id._serialized` ke `pendingSendsByServerId` — tidak menunggu `sendPromise` resolve. Ini memastikan event ACK dengan server ID tetap bisa dilacak meski tiba sebelum atau sesudah sendPromise.
3. `message_create` tidak mengubah perilaku resolve — hanya set `created=true` dan `createdTs`, tidak memanggil `resolve()`.

**Verifikasi:**
- `node --check index.new.js` → exit 0
- Tidak ada perubahan pada alur timeout, cleanup, atau concurrent-send check.

**Pelajaran:** Event WhatsApp bisa datang dengan ID yang berbeda dari yang dikembalikan `sendMessage()`. Selalu registrasi reverse-index dari kedua sumber (local dan server) sedini mungkin.
