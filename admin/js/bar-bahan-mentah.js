// ============================================================
// PBMS ADMIN — MODUL BAR BAHAN MENTAH
// Dipisahkan dari dashboard.js ke halaman mandiri.
//
// TUGAS:
//   1. Pemuatan & penampilan inventaris bahan mentah kategori BAR
//   2. Form tambah bahan baru dengan nama, satuan, stok, harga per satuan
//   3. Pencarian/autocomplete bahan yang sudah ada
//   4. Pemilihan bahan untuk restok (satuan dikunci, label berubah)
//   5. Format nominal rupiah + parsing untuk payload API + posisi kursor
//   6. Indikator jumlah bahan & stok rendah
//   7. Kolom tabel, nilai stok, waktu pembaruan, aksi hapus, konfirmasi
//   8. Pesan sukses/gagal, validasi, pemuatan ulang setelah operasi
//
// API: GET /api/admin/bar/raw-materials
//      POST /api/admin/bar/raw-materials
//      DELETE /api/admin/bar/raw-materials
//
// CATATAN:
//   - Tidak bergantung pada dashboard.js atau CSS-nya.
//   - escapeHtml & safeAddEvt lokal (jangan ekspos ke window).
// ============================================================

// ── Helper lokal ──────────────────────────────────────────────
const barEscapeHtml = (str) =>
  String(str ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));

const barSafeAddEvt = (elementId, eventType, handler) => {
  const elem = typeof elementId === 'string'
    ? document.getElementById(elementId)
    : elementId;
  if (elem && typeof elem.addEventListener === 'function' && typeof handler === 'function') {
    elem.removeEventListener(eventType, handler);
    elem.addEventListener(eventType, handler);
  }
};

// ── DOM References ────────────────────────────────────────────
const formBarMaterial   = document.getElementById('formBarMaterial');
const barMaterialBody   = document.getElementById('barMaterialBody');
const barTotalItems     = document.getElementById('barTotalItems');
const barLowStock       = document.getElementById('barLowStock');
const barNamaInput      = document.getElementById('barNama');
const barNamaList       = document.getElementById('barNamaList');
const barNamaResult     = document.getElementById('barNamaResult');
const barKodeInput      = document.getElementById('barKode');
const barSatuanSelect   = document.getElementById('barSatuan');
const barStokLabel      = document.getElementById('barStokLabel');
const barStokInput      = document.getElementById('barStok');
const barHargaInput     = document.getElementById('barHarga');
const btnBarSubmit      = document.getElementById('btnBarSubmit');

// ── State ─────────────────────────────────────────────────────
let barMaterialsCache = [];
let barSelectedId = null;
let barSearchTimeout = null;

// ── Formatters ────────────────────────────────────────────────
const formatBarRupiah = (n) => {
  if (!n && n !== 0) return 'Rp 0';
  return 'Rp ' + Number(n).toLocaleString('id-ID');
};

// Format angka dengan pemisah ribuan titik (id-ID) saat user mengetik.
// Kursor dipertahankan relatif terhadap digit agar edit tengah nyaman.
// Input menggunakan type="text" + inputmode="numeric" agar string "1.500.000"
// bisa ditampilkan — parseBarHarga() membersihkan titik sebelum kirim API.
// Hanya memanggil setSelectionRange() jika elemen mendukungnya.
const formatBarHargaInput = () => {
  const raw = String(barHargaInput.value ?? '').replace(/\D/g, '');
  const formatted = raw ? Number(raw).toLocaleString('id-ID') : '';
  if (formatted === barHargaInput.value) return formatted;
  // Hitung posisi kursor relatif terhadap digit sebelum posisi saat ini
  const pos = barHargaInput.selectionStart ?? raw.length;
  const digitsBefore = (String(barHargaInput.value ?? '').slice(0, pos).match(/\d/g) || []).length;
  let caret = formatted.length;
  let seen = 0;
  for (let i = 0; i < formatted.length; i++) {
    if (/\d/.test(formatted[i])) {
      if (seen === digitsBefore) { caret = i; break; }
      seen++;
    }
  }
  barHargaInput.value = formatted;
  // Hanya panggil setSelectionRange jika elemen mendukung (input teks)
  if (typeof barHargaInput.setSelectionRange === 'function') {
    barHargaInput.setSelectionRange(caret, caret);
  }
  return formatted;
};

// Bersihkan pemisah titik → angka bulat untuk payload API (1.500.000 → 1500000)
const parseBarHarga = (val) => Math.round(Number(String(val ?? '').replace(/\./g, '')) || 0);

// ── Alert Box ─────────────────────────────────────────────────
// Signature: showAlert(type, msg). Call sites pass two args; window.alert
// only renders the first, so drop the type prefix to show the real message.
const showAlert = (_type, msg) => window.alert(msg);

// ── Load ──────────────────────────────────────────────────────
const loadBarMaterials = async () => {
  const bodyEl = barMaterialBody;
  barMaterialsCache = [];
  try {
    const resp = await fetch('/api/admin/bar/raw-materials');
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const data = await resp.json();
    if (!data.success) throw new Error(data.message || 'Gagal memuat');

    barMaterialsCache = (data.data || []).map(m => ({
      ...m,
      harga_per_satuan: Number(m.harga_per_satuan || m.harga_satuan) || 0,
      updated_at: m.updated_at || m.terakhir_update || '—'
    }));

    renderBarMaterials();
    updateBarDatalist();
  } catch (err) {
    console.error('Gagal memuat bar materials:', err);
    if (bodyEl) {
      bodyEl.innerHTML = '<tr><td colspan="8" style="text-align: center; color: #f87171; padding: 20px;">Gagal memuat data: ' + barEscapeHtml(err.message) + '</td></tr>';
    }
  }
};

// ── Render ────────────────────────────────────────────────────
const renderBarMaterials = () => {
  const bodyEl = barMaterialBody;
  if (!bodyEl) return;

  const items = barMaterialsCache;
  if (barTotalItems) barTotalItems.textContent = String(items.length);
  if (barLowStock) barLowStock.textContent = String(items.filter(m => (Number(m.stok) || 0) < 10).length);

  if (!items.length) {
    bodyEl.innerHTML = '<tr><td colspan="8" style="text-align: center; color: #94a3b8; padding: 20px;">Belum ada data bahan mentah bar</td></tr>';
    return;
  }

  bodyEl.innerHTML = items.map(m => {
    const stok = Number(m.stok) || 0;
    const hpp = Number(m.harga_per_satuan) || 0;
    const nilaiStok = stok * hpp;
    const isLow = stok < 10;
    return '<tr>' +
      '<td><code>' + barEscapeHtml(String(m.kode_barang || '')) + '</code></td>' +
      '<td><strong>' + barEscapeHtml(String(m.nama_barang || '')) + '</strong></td>' +
      '<td class="col-num' + (isLow ? ' bar-low-stock' : '') + '">' + stok.toLocaleString('id-ID') + '</td>' +
      '<td>' + barEscapeHtml(String(m.satuan || '')) + '</td>' +
      '<td class="col-num">' + formatBarRupiah(hpp) + '</td>' +
      '<td class="col-num">' + formatBarRupiah(nilaiStok) + '</td>' +
      '<td>' + barEscapeHtml(String(m.updated_at || '')) + '</td>' +
      '<td><button type="button" class="btn btn-danger btn-sm" data-bar-delete="' + barEscapeHtml(String(m.kode_barang)) + '">Hapus</button></td>' +
      '</tr>';
  }).join('');

  bodyEl.querySelectorAll('[data-bar-delete]').forEach(btn => {
    btn.addEventListener('click', () => deleteBarMaterial(btn.dataset.barDelete));
  });
};

// ── Datalist ──────────────────────────────────────────────────
const updateBarDatalist = () => {
  if (!barNamaList) return;
  barNamaList.innerHTML = barMaterialsCache.map(m =>
    '<option value="' + barEscapeHtml(String(m.nama_barang)) + '">'
  ).join('');
};

// ── Form Setup ────────────────────────────────────────────────
const setupBarForm = () => {
  if (!barNamaInput || !barNamaList) return;

  // Real-time thousands separator on Harga field
  barSafeAddEvt(barHargaInput, 'input', () => {
    formatBarHargaInput(barHargaInput.value);
  });

  // Also handle paste — format the pasted content
  barSafeAddEvt(barHargaInput, 'paste', (e) => {
    setTimeout(() => {
      formatBarHargaInput(barHargaInput.value);
    }, 0);
  });

  // Live search on input
  barSafeAddEvt(barNamaInput, 'input', () => {
    // User is typing — enable satuan dropdown (new material mode)
    barSelectedId = null;
    barSatuanSelect.disabled = false;
    barKodeInput.value = '';
    barKodeInput.style.opacity = '';
    barStokLabel.textContent = 'Stok Tambah';
    btnBarSubmit.textContent = '+ Tambah Bahan';

    clearTimeout(barSearchTimeout);
    barSearchTimeout = setTimeout(() => {
      const query = String(barNamaInput.value).trim().toLowerCase();
      if (!query) {
        barNamaResult.innerHTML = '';
        return;
      }
      const matches = barMaterialsCache.filter(m =>
        String(m.nama_barang).toLowerCase().includes(query)
      );
      if (!matches.length) {
        barNamaResult.innerHTML = '<div class="bar-search-none">Tidak ditemukan — ketik nama baru</div>';
        return;
      }
      barNamaResult.innerHTML = matches.map(m =>
        '<div class="bar-search-item" data-id="' + m.id + '" data-nama="' + barEscapeHtml(String(m.nama_barang)) + '" data-satuan="' + barEscapeHtml(String(m.satuan)) + '" data-harga="' + (m.harga_per_satuan || 0) + '">' +
          '<strong>' + barEscapeHtml(String(m.nama_barang)) + '</strong>' +
          ' — Stok: <b>' + Number(m.stok || 0).toFixed(2) + ' ' + barEscapeHtml(String(m.satuan)) + '</b>' +
          ' | ' + formatBarRupiah(m.harga_per_satuan) + '/satuan' +
        '</div>'
      ).join('');
      barNamaResult.querySelectorAll('.bar-search-item').forEach(el => {
        el.addEventListener('click', () => {
          barSelectedId = Number(el.dataset.id);
          barNamaInput.value = el.dataset.nama;
          barNamaResult.innerHTML = '';
          // Auto-fill satuan & lock for restok mode
          barSatuanSelect.value = el.dataset.satuan;
          barSatuanSelect.disabled = true;
          // Auto-fill harga with thousands separator
          barHargaInput.value = formatBarHargaInput(el.dataset.harga);
          // Update UI for restok mode
          barKodeInput.value = '— Sudah ada';
          barKodeInput.style.opacity = '0.6';
          barStokLabel.textContent = 'Tambah Stok (Restok)';
          btnBarSubmit.textContent = '✓ Restok';
        });
      });
    }, 200);
  });

  // Blur: hide search results, don't reset form state
  barSafeAddEvt(barNamaInput, 'blur', () => {
    setTimeout(() => {
      barNamaResult.innerHTML = '';
    }, 200);
  });
};

// ── Reset Form ────────────────────────────────────────────────
const resetBarForm = () => {
  barSelectedId = null;
  barKodeInput.value = '';
  barKodeInput.style.opacity = '';
  barSatuanSelect.value = 'ml';
  barSatuanSelect.disabled = false;
  barStokLabel.textContent = 'Stok Tambah';
  btnBarSubmit.textContent = '+ Tambah Bahan';
  barNamaInput.value = '';
  barNamaResult.innerHTML = '';
  if (barStokInput) barStokInput.value = '0';
  barHargaInput.value = '';
};

// ── Add Material ──────────────────────────────────────────────
const addBarMaterial = async (e) => {
  if (e && typeof e.preventDefault === 'function') e.preventDefault();
  const nama = String(document.getElementById('barNama').value).trim();
  const satuan = document.getElementById('barSatuan').value;
  const stok = parseFloat(document.getElementById('barStok').value) || 0;
  const harga = parseBarHarga(document.getElementById('barHarga').value);

  if (!nama) { showAlert('danger', 'Nama bahan wajib diisi.'); return; }
  if (!satuan) { showAlert('danger', 'Satuan wajib dipilih.'); return; }
  if (stok < 0) { showAlert('danger', 'Stok tidak boleh negatif.'); return; }

  try {
    const payload = { nama_barang: nama, satuan: satuan, stok: stok, harga_per_satuan: harga };
    if (barSelectedId) payload.id = barSelectedId;
    const resp = await fetch('/api/admin/bar/raw-materials', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await resp.json();
    if (!data.success) throw new Error(data.message || 'Gagal menambah');

    // Show kode if new material
    if (data.kode_barang) {
      barKodeInput.value = data.kode_barang;
      barKodeInput.style.opacity = '1';
    }

    resetBarForm();
    await loadBarMaterials();

    if (data.mode === 'restok') {
      showAlert('success', 'Stok "' + nama + '" berhasil ditambahkan. Stok baru: ' + Number(data.data?.stok || 0).toFixed(2) + ' ' + satuan);
    } else {
      showAlert('success', 'Bahan baru "' + nama + '" berhasil ditambahkan dengan kode: ' + data.kode_barang);
    }
  } catch (err) {
    showAlert('danger', 'Gagal tambah bahan: ' + err.message);
  }
};

// ── Delete Material ───────────────────────────────────────────
const deleteBarMaterial = async (kode) => {
  if (!confirm('Hapus bahan ' + kode + '?')) return;
  try {
    const resp = await fetch('/api/admin/bar/raw-materials', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kode_barang: kode })
    });
    const data = await resp.json();
    if (!data.success) throw new Error(data.message || 'Gagal hapus');
    await loadBarMaterials();
  } catch (err) {
    showAlert('danger', 'Gagal hapus bahan: ' + err.message);
  }
};

// ── Event Listeners ───────────────────────────────────────────
if (formBarMaterial) {
  formBarMaterial.removeEventListener('submit', addBarMaterial);
  formBarMaterial.addEventListener('submit', addBarMaterial);
}
if (setupBarForm) setupBarForm();

// ── Init: muat Bahan Mentah Bar saat halaman load ────────────
loadBarMaterials();
