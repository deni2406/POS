const http = require('http');
const fs = require('fs');

const token = fs.readFileSync('api-token.txt', 'utf8').trim();
const body = JSON.stringify({
  number: '6281775042284',
  message: 'Uji Fix #107 - ' + Date.now()
});

console.log('Sending at', new Date().toISOString(), '| body:', body);

const req = http.request({
  hostname: '127.0.0.1',
  port: 3101,
  path: '/send',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-api-token': token,
    'Content-Length': Buffer.byteLength(body)
  }
}, (res) => {
  let d = '';
  res.on('data', c => d += c);
  res.on('end', () => {
    console.log('STATUS:', res.statusCode, 'BODY:', d);
  });
});

req.on('error', e => console.log('ERR:', e.message));
req.write(body);
req.end();
