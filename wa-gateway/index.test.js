const { Client, LocalAuth } = require('whatsapp-web.js');
const { MessageAck } = require('whatsapp-web.js/src/util/Constants');
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ACK VALUES yang dianggap sebagai konfirmasi sukses (bukan ERROR, bukan PENDING)
const CONFIRMED_ACK_VALUES = new Set([
    MessageAck.ACK_SERVER,
    MessageAck.ACK_DEVICE,
    MessageAck.ACK_READ,
    MessageAck.ACK_PLAYED,
]);

/**
 * PendingEntry menyimpan status satu pengiriman pesan.
 */
function createPendingEntry(chatId) {
    return {
        chatId,
        resolve: null,
        reject: null,
        confirmed: false,
        ackError: false,
        ack: undefined,
        ackTs: undefined,
        serverId: undefined,
        created: false,
        createdTs: undefined,
        lastActivityTs: Date.now(),
        _timeoutHandle: null,
        correlId: null,
        rawTo: null, // Untuk reverse-index
    };
}

function clearTimeoutFor(entry) {
    if (entry._timeoutHandle !== null) {
        clearTimeout(entry._timeoutHandle);
        entry._timeoutHandle = null;
    }
}

const pendingSends = new Map();
let sendSeq = 0;
const STALE_TIMEOUT_MS = 60_000;
const SEND_TIMEOUT_MS = 30_000;

// Reverse-index: msg._serialized (serverId) → entry
const pendingSendsByServerId = new Map();

// Reverse-index: raw msg.to (any format) → entry
// WhatsApp sends messages with server-format IDs like "179422711791710@lid" as msg.to,
// which never matches our chatId key "6281775042284@c.us". Direct mapping fixes this.
const pendingSendsByTo = new Map();

// Normalize chat ID format
function normalizeChatId(raw) {
  if (!raw) return raw;
  let id = raw.replace(/^\+/, '').trim();
  const numericMatch = id.match(/^(\d+)/);
  if (numericMatch) {
    id = numericMatch[1] + '@c.us';
  } else if (!id.includes('@')) {
    id = id + '@c.us';
  }
  return id;
}

// Extract just the phone number from various formats
function extractPhone(raw) {
  if (!raw) return null;
  const match = raw.toString().match(/^(\d+)/);
  return match ? match[1] : null;
}

function lookupPending(msg) {
  if (!msg || !msg.id) return null;

  const normalizedTo = normalizeChatId(msg.to);
  const phone = extractPhone(msg.to);

  // 1. Cari langsung dengan msg.id.id
  if (msg.id.id) {
    const byId = pendingSends.get(msg.id.id);
    if (byId) return byId;
  }
  // 2. Fallback: normalized msg.to
  if (normalizedTo) {
    const byTo = pendingSends.get(normalizedTo);
    if (byTo) return byTo;
  }
  // 3. Fallback: reverse-index by raw msg.to
  if (msg.to) {
    const byTo = pendingSendsByTo.get(msg.to);
    if (byTo) return byTo;
  }
  // 4. Fallback: match by phone number
  if (phone) {
    for (const [k, v] of pendingSends) {
      const entryPhone = extractPhone(v.chatId);
      if (entryPhone && entryPhone === phone) return v;
    }
  }
  // 5. Fallback terakhir: cocokkan normalized msg.to dengan entry.chatId
  if (normalizedTo) {
    for (const [k, v] of pendingSends) {
      if (v.chatId === normalizedTo) return v;
    }
  }
  // 6. Fallback: reverse-index by msg.id.id
  if (msg.id && msg.id.id) {
    const byInternalId = pendingSendsByServerId.get(msg.id.id);
    if (byInternalId) return byInternalId;
  }
  return null;
}

function handleSendEvent(msg, ack, isAckEvent) {
  if (!msg || !msg.id || !msg.id.fromMe) return;

  console.log(`[DIAG] ${isAckEvent ? 'ACK' : 'CREATE'} | fromMe=${msg.id.fromMe} id=${msg.id.id} serverId=${msg.id._serialized} to=${msg.to} ack=${ack}`);

  const pending = lookupPending(msg);
  if (!pending) {
    console.log(`[DIAG] Entry NOT FOUND for msg. pendingSends.size=${pendingSends.size}`);
    for (const [k, v] of pendingSends) {
      console.log(`[DIAG]   Entry key=${k} chatId=${v.chatId} correlId=${v.correlId}`);
    }
    return;
  }
  console.log(`[DIAG] Entry MATCHED: key=${pending.correlId} chatId=${pending.chatId}`);

  // Catat raw msg.to untuk reverse-index
  if (msg.to && !pending.rawTo) {
    pending.rawTo = msg.to;
    // Hapus placeholder, register dengan key asli
    for (const k of [...pendingSendsByTo.keys()]) {
      if (k.startsWith('__placeholder__')) pendingSendsByTo.delete(k);
    }
    pendingSendsByTo.set(msg.to, pending);
    console.log(`[DIAG] Registered pendingSendsByTo[${msg.to}] = ${pending.correlId}`);
  }

  // Simpan msg.id.id sebagai serverId
  if (msg.id._serialized && !pending.serverId) {
    pending.serverId = msg.id._serialized;
  }
  // Migrasi key Map
  if (msg.id.id && pending.correlId && pending.correlId.startsWith('send_')) {
    pending.correlId = msg.id.id;
    for (const [k, v] of pendingSends) {
      if (v === pending && k !== msg.id.id) {
        pendingSends.delete(k);
        break;
      }
    }
    pendingSends.set(msg.id.id, pending);
  }

  const isAckError = MessageAck.ACK_ERROR !== undefined && ack === MessageAck.ACK_ERROR;

  if (isAckEvent) {
    if (isAckError) {
      pending.ackError = true;
      pending.ackErrorTs = Date.now();
      pending.lastActivityTs = Date.now();
      clearTimeoutFor(pending);
      if (pending.reject) pending.reject(new Error('ACK_ERROR'));
      return;
    }
    if (pending.confirmed) return;
    if (ack === MessageAck.ACK_PENDING) return;
    if (!CONFIRMED_ACK_VALUES.has(ack)) return;
    pending.confirmed = true;
    pending.ack = ack;
    pending.ackTs = Date.now();
    pending.lastActivityTs = Date.now();
    clearTimeoutFor(pending);
    if (pending.resolve) pending.resolve({ id: msg.id._serialized, ack });
    return;
  }

  pending.created = true;
  pending.createdTs = Date.now();
  pending.lastActivityTs = Date.now();
  console.log(`[DIAG] message_create processed for entry ${pending.correlId}`);
}

const app = express();
const PORT = 3102;
const HOST = '127.0.0.1';
const TOKEN_PATH = path.join(__dirname, 'api-token.txt');

if (!fs.existsSync(TOKEN_PATH)) {
  throw new Error('File api-token.txt tidak ditemukan.');
}

const API_TOKEN = fs.readFileSync(TOKEN_PATH, 'utf8').trim();

app.use(express.json({ limit: '16kb' }));

let whatsappReady = false;

// TEST SESSION - use different directory to avoid lock
const client = new Client({
  authStrategy: new LocalAuth({
    dataPath: path.join(__dirname, 'session', 'session-test')
  }),
  puppeteer: {
    headless: true
  }
});

client.on('qr', (qr) => {
  console.log('QR diterima.');
  require('qrcode-terminal').generate(qr, { small: true });
});

client.on('authenticated', () => {
  console.log('WhatsApp berhasil diautentikasi.');
});

client.on('ready', () => {
  whatsappReady = true;
  console.log('TEST_GATEWAY_READY');
});

client.on('auth_failure', (message) => {
  whatsappReady = false;
  console.error('Autentikasi gagal:', message);
});

client.on('disconnected', (reason) => {
  whatsappReady = false;
  console.log('WhatsApp terputus:', reason);
});

client.on('message_ack', (msg, ack) => {
  handleSendEvent(msg, ack, true);
});

client.on('message_create', (msg) => {
  handleSendEvent(msg, ack, false);
});

app.get('/health', (req, res) => {
  res.json({ ok: true, whatsappReady });
});

app.post('/send', authMiddleware, async (req, res) => {
  if (!whatsappReady) {
    return res.status(503).json({ ok: false, error: 'WhatsApp belum siap.' });
  }

  const { number, message } = req.body || {};

  if (typeof number !== 'string' || !/^\d{8,15}$/.test(number)) {
    return res.status(400).json({ ok: false, error: 'Nomor tidak valid.' });
  }

  if (typeof message !== 'string' || !message.trim() || message.length > 4000) {
    return res.status(400).json({ ok: false, error: 'Pesan wajib diisi dan maksimal 4000 karakter.' });
  }

  try {
    const chatId = normalizeChatId(`${number}@c.us`);

    // Check concurrent sends
    for (const entry of pendingSends.values()) {
      if (entry.chatId === chatId && !entry.confirmed && !entry.ackError) {
        return res.status(409).json({ ok: false, error: 'Terdapat pengiriman ke nomor ini yang masih menunggu konfirmasi.' });
      }
    }

    const pendingEntry = createPendingEntry(chatId);
    const sendKey = `send_${++sendSeq}`;
    pendingEntry.correlId = sendKey;
    pendingSends.set(sendKey, pendingEntry);
    // Register reverse-index placeholder
    pendingSendsByTo.set(`__placeholder__${sendKey}`, pendingEntry);

    const sendPromise = client.sendMessage(chatId, message.trim(), { waitUntilMsgSent: true });

    let settled = false;
    const ackPromise = new Promise((resolve, reject) => {
      pendingEntry.resolve = (payload) => {
        if (settled) return;
        settled = true;
        pendingEntry.confirmed = true;
        clearTimeoutFor(pendingEntry);
        if (pendingEntry.correlId && pendingSends.has(pendingEntry.correlId)) pendingSends.delete(pendingEntry.correlId);
        if (pendingSends.has(chatId)) pendingSends.delete(chatId);
        if (pendingEntry.serverId && pendingSendsByServerId.has(pendingEntry.serverId)) pendingSendsByServerId.delete(pendingEntry.serverId);
        if (pendingEntry.rawTo && pendingSendsByTo.has(pendingEntry.rawTo)) pendingSendsByTo.delete(pendingEntry.rawTo);
        for (const k of [...pendingSendsByTo.keys()]) {
          if (k.startsWith('__placeholder__')) pendingSendsByTo.delete(k);
        }
        resolve(payload);
      };
      pendingEntry.reject = (err) => {
        if (settled) return;
        settled = true;
        clearTimeoutFor(pendingEntry);
        if (pendingEntry.correlId && pendingSends.has(pendingEntry.correlId)) pendingSends.delete(pendingEntry.correlId);
        if (pendingSends.has(chatId)) pendingSends.delete(chatId);
        if (pendingEntry.serverId && pendingSendsByServerId.has(pendingEntry.serverId)) pendingSendsByServerId.delete(pendingEntry.serverId);
        if (pendingEntry.rawTo && pendingSendsByTo.has(pendingEntry.rawTo)) pendingSendsByTo.delete(pendingEntry.rawTo);
        for (const k of [...pendingSendsByTo.keys()]) {
          if (k.startsWith('__placeholder__')) pendingSendsByTo.delete(k);
        }
        reject(err);
      };

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        pendingEntry._timeoutHandle = null;
        if (pendingEntry.correlId && pendingSends.has(pendingEntry.correlId)) pendingSends.delete(pendingEntry.correlId);
        if (pendingSends.has(chatId)) pendingSends.delete(chatId);
        if (pendingEntry.serverId && pendingSendsByServerId.has(pendingEntry.serverId)) pendingSendsByServerId.delete(pendingEntry.serverId);
        if (pendingEntry.rawTo && pendingSendsByTo.has(pendingEntry.rawTo)) pendingSendsByTo.delete(pendingEntry.rawTo);
        for (const k of [...pendingSendsByTo.keys()]) {
          if (k.startsWith('__placeholder__')) pendingSendsByTo.delete(k);
        }
        reject(new Error('ACK_TIMEOUT'));
      }, SEND_TIMEOUT_MS);
      pendingEntry._timeoutHandle = timer;
    });

    let sendResult = null;
    let sendError = null;
    let ackPayload = null;
    let ackTimeout = false;
    let ackError = false;

    try {
      const result = await sendPromise;
      if (result && result.id) {
        const internalId = result.id.id;
        if (internalId) {
          sendResult = internalId;
          pendingEntry.serverId = internalId;
          pendingSendsByServerId.set(internalId, pendingEntry);
          if (!pendingEntry.createdTs) {
            pendingEntry.createdTs = Date.now();
            pendingEntry.lastActivityTs = Date.now();
          }
        }
      }
    } catch (err) {
      sendError = err;
    }

    try {
      ackPayload = await ackPromise;
    } catch (ackErr) {
      if (ackErr.message === 'ACK_TIMEOUT') {
        ackTimeout = true;
      } else if (ackErr.message === 'ACK_ERROR') {
        ackError = true;
      }
    }

    if (ackError) {
      return res.status(500).json({ ok: false, error: 'ACK_ERROR', chatId });
    }

    if (ackTimeout && sendError) {
      return res.status(500).json({ ok: false, error: 'Pengiriman gagal: ' + sendError.message, chatId });
    }

    if (ackPayload) {
      let ackLevel = 'server';
      if (ackPayload.ack === MessageAck.ACK_DEVICE) ackLevel = 'device';
      else if (ackPayload.ack === MessageAck.ACK_READ) ackLevel = 'read';
      else if (ackPayload.ack === MessageAck.ACK_PLAYED) ackLevel = 'played';

      const finalMsgId = ackPayload.id || sendResult || pendingEntry.serverId;

      return res.json({
        ok: true,
        messageId: finalMsgId,
        ackLevel,
        confirmed: true,
        chatId
      });
    }

    if (sendResult) {
      return res.status(202).json({
        ok: true,
        messageId: sendResult,
        confirmed: false,
        status: 'pending_ack',
        chatId
      });
    }

    if (pendingEntry.created) {
      return res.status(202).json({
        ok: true,
        messageId: pendingEntry.serverId || null,
        confirmed: false,
        status: 'created_no_ack',
        chatId
      });
    }

    return res.status(202).json({
      ok: false,
      messageId: null,
      confirmed: false,
      status: 'unconfirmed',
      error: ackTimeout ? 'Timeout: konfirmasi ACK tidak diterima dalam 30 detik.' : 'Konfirmasi tidak lengkap.',
      chatId
    });
  } catch (error) {
    console.error('Gagal mengirim pesan:', error.message);
    return res.status(500).json({ ok: false, error: 'Pengiriman pesan gagal.' });
  }
});

function authMiddleware(req, res, next) {
  const supplied = req.get('x-api-token') || '';
  const a = Buffer.from(supplied);
  const b = Buffer.from(API_TOKEN);

  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  next();
}

app.listen(PORT, HOST, () => {
  console.log(`TEST_GATEWAY_LISTENING http://${HOST}:${PORT}`);
});

client.initialize();
