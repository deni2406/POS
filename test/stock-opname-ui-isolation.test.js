'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

test('local Stock Opname UI cannot call legacy snapshot or finalize endpoints', async () => {
  const requests = [];
  const source = fs.readFileSync(path.join(__dirname, '..', 'stock-opname.js'), 'utf8');
  const modal = { style: {}, innerHTML: '', appendChild() {} };
  const document = {
    body: { appendChild() {} },
    getElementById(id) { return id === 'soModal' ? modal : null; },
    createElement() { return { style: {}, remove() {} }; },
    querySelector() { return null; }
  };
  const context = {
    window: {}, document,
    localStorage: { getItem() { return null; }, setItem() {} },
    sessionStorage: { getItem() { return null; } },
    fetch: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, status: 200, json: async () => ({ data: [] }) };
    },
    alert() {}, console,
    Set, Date, Number, String, Array, JSON, Math, parseInt, isNaN, encodeURIComponent
  };

  vm.runInNewContext(source, context, { filename: 'stock-opname.js' });
  const ui = context.window.StockOpname;

  assert.equal(typeof ui.handleSelesai, 'undefined');
  assert.equal(typeof ui.finalizeSO, 'undefined');
  assert.equal(typeof ui.saveSnapshotToServer, 'undefined');

  // Exercise the public local UI load flow using fetch only as a recording stub.
  await ui.open();
  assert.deepEqual(requests.map(request => request.url), ['/api/stock-opname/local/barang']);
  assert.equal(requests.some(({ url }) =>
    url === '/api/stock-opname/snapshot' || url === '/api/stock-opname/finalize'), false);

  // Legacy paths are absent from the loaded UI bundle as well as its public API.
  assert.doesNotMatch(source, /saveSnapshotToServer|finalizeSO|\/api\/stock-opname\/(?:snapshot|finalize)/);
});
