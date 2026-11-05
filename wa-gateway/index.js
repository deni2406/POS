const { Client, LocalAuth } = require('whatsapp-web.js');

const client = new Client({
  authStrategy: new LocalAuth({
    dataPath: './session'
  }),
  puppeteer: {
    headless: true
  }
});

client.on('qr', (qr) => {
  console.log('QR diterima. Buka WhatsApp di HP untuk menautkan perangkat.');
  require('qrcode-terminal').generate(qr, { small: true });
});

client.on('authenticated', () => {
  console.log('WhatsApp berhasil diautentikasi.');
});

client.on('ready', () => {
  console.log('WHATSAPP_GATEWAY_READY');
});

client.on('auth_failure', (message) => {
  console.error('Autentikasi gagal:', message);
});

client.on('disconnected', (reason) => {
  console.log('WhatsApp terputus:', reason);
});

client.initialize();
