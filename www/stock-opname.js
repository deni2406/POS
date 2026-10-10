/**
 * STOCK OPNAME (SO) MODULE
 * Project: POS POLAR BILLIARD
 * Path: C:\POS\stock-opname.js
 * 
 * Logic Frontend Stock Opname:
 * - POS menyimpan draft hitung fisik ke SQLite; nominal dan finalisasi masih diblokir.
 * - Tidak melakukan perhitungan selisih, kerugian, atau total di frontend.
 * - Revisi dinonaktifkan sampai riwayat lokal dapat mempertahankan aturan lama.
 */

(function () {
  'use strict';

  // ==================================================
  // MODULE STATE (Scoped Namespace)
  // ==================================================
  const state = {
    modalContainerId: 'soModal',
    kategoriAktif: '',
    masterBarang: [],
    categories: [],
    inputSO: {},         // Key: barangId, Value: number (jumlah fisik)
    hasilSO: null,       // Hasil draft lokal dari server
    revisiKe: 0,        // 0 = Belum revisi, 1 = Sudah revisi
    isRevising: false,   // true saat petugas sedang berada di mode edit revisi
    isFinal: false,      // true jika SO sudah difinalisasi & dikunci
    sedangMemproses: false
  };

  // ==================================================
  // LOCAL STORAGE PERSISTENCE
  // ==================================================
  const STORAGE_KEY_PREFIX = 'pos_so_state_';

  function getCategoryStateKey(kategori) {
    const cleanCat = String(kategori || '').trim().toUpperCase();
    return `${STORAGE_KEY_PREFIX}${cleanCat}`;
  }

  function loadCategoryState(kategori) {
    if (!kategori) return { revisiKe: 0, isFinal: false };
    try {
      const saved = localStorage.getItem(getCategoryStateKey(kategori));
      if (saved) {
        const parsed = JSON.parse(saved);
        return {
          revisiKe: Number(parsed.revisiKe) || 0,
          isFinal: Boolean(parsed.isFinal)
        };
      }
    } catch (e) {
      console.warn('[SO] Gagal membaca state lokal:', e);
    }
    return { revisiKe: 0, isFinal: false };
  }

  function saveCategoryState(kategori, revisiKe, isFinal) {
    if (!kategori) return;
    try {
      const data = {
        revisiKe: Number(revisiKe) || 0,
        isFinal: Boolean(isFinal),
        updatedAt: new Date().toISOString()
      };
      localStorage.setItem(getCategoryStateKey(kategori), JSON.stringify(data));
    } catch (e) {
      console.warn('[SO] Gagal menyimpan state lokal:', e);
    }
  }

  // ==================================================
  // UTILITY HELPERS
  // ==================================================
  function getAuthHeaders() {
    const headers = {
      'Content-Type': 'application/json'
    };
    const sessionId =
      sessionStorage.getItem('pbms_session_id') ||
      localStorage.getItem('pbms_session_id') ||
      sessionStorage.getItem('sessionId') ||
      localStorage.getItem('sessionId');

    const deviceId =
      localStorage.getItem('pbms_device_id') ||
      sessionStorage.getItem('pbms_device_id') ||
      localStorage.getItem('deviceId') ||
      sessionStorage.getItem('deviceId');
    if (sessionId) headers['X-Session-Id'] = sessionId;
    if (deviceId) headers['X-Device-Id'] = deviceId;
    return headers;
  }

  function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function formatRupiah(numberVal) {
    const val = Number(numberVal) || 0;
    return val.toLocaleString('id-ID');
  }

  function sanitizeNonNegativeQty(val) {
    if (val === '' || val === null || val === undefined) return '';
    const clean = String(val).replace(/[^0-9]/g, '');
    if (clean === '') return '';
    const num = parseInt(clean, 10);
    return isNaN(num) || num < 0 ? 0 : num;
  }

  function getPetugasName() {
    return localStorage.getItem('kasirNama') || 
           sessionStorage.getItem('kasirNama') || 
           localStorage.getItem('username') || 
           'Petugas Kasir';
  }

  // ==================================================
  // MODAL DOM MANAGEMENT
  // ==================================================
  function getOrCreateModalElement() {
    let modalEl = document.getElementById(state.modalContainerId);
    if (!modalEl) {
      modalEl = document.createElement('div');
      modalEl.id = state.modalContainerId;
      modalEl.className = 'so-modal-overlay';
      modalEl.style.display = 'none';
      document.body.appendChild(modalEl);
    }
    return modalEl;
  }

  // ==================================================
  // PUBLIC METHOD: OPEN MODAL
  // ==================================================
  async function openSOModal() {
    const modalEl = getOrCreateModalElement();
    modalEl.style.display = 'flex';

    state.kategoriAktif = '';
    state.inputSO = {};
    state.hasilSO = null;
    state.isRevising = false;
    state.sedangMemproses = false;

    showLoadingOverlay(true, 'MEMUAT MASTER BARANG...', 'Mohon tunggu sebentar.');

    try {
      const response = await fetch('/api/stock-opname/local/barang', {
        method: 'GET',
        headers: getAuthHeaders()
      });

      if (!response.ok) {
        throw new Error(`Gagal mengambil data master barang (HTTP ${response.status})`);
      }

      const json = await response.json();
      const rawData = Array.isArray(json) ? json : (json.data || json.items || []);

      state.masterBarang = rawData;

      // Ekstrak kategori/area unik dari Master Barang
      const catSet = new Set();
      state.masterBarang.forEach(item => {
        const cat = item.kategori || item.area || 'Lainnya';
        if (cat) catSet.add(String(cat).trim().toUpperCase());
      });

      state.categories = Array.from(catSet).sort();

      showLoadingOverlay(false);
      renderInputView();

    } catch (err) {
      showLoadingOverlay(false);
      alert('Terjadi kesalahan saat memuat data: ' + err.message);
      closeSOModal();
    }
  }

  // ==================================================
  // PUBLIC METHOD: CLOSE MODAL
  // ==================================================
  function closeSOModal() {
    if (state.sedangMemproses) return;
    const modalEl = document.getElementById(state.modalContainerId);
    if (modalEl) {
      modalEl.style.display = 'none';
      modalEl.innerHTML = '';
    }
  }

  // ==================================================
  // EVENT HANDLER: KATEGORI CHANGED
  // ==================================================
  async function handleCategoryChange(kategoriSelectValue) {
    const category = String(kategoriSelectValue || '').trim().toUpperCase();
    state.kategoriAktif = category;
    state.inputSO = {};
    state.hasilSO = null;
    state.isRevising = false;

    if (!category) {
      state.revisiKe = 0;
      state.isFinal = false;
      renderInputView();
      return;
    }

    // Load status dari storage lokal
    const localState = loadCategoryState(category);
    state.revisiKe = localState.revisiKe;
    state.isFinal = localState.isFinal;

    // Sinkronkan status dengan server jika endpoint tersedia
    try {
      const res = await fetch(`/api/stock-opname/local/status?category=${encodeURIComponent(category)}`, {
        method: 'GET',
        headers: getAuthHeaders()
      });
      if (res.ok) {
        const statusJson = await res.json();
        if (statusJson && statusJson.success) {
          if (statusJson.revisiKe !== undefined) state.revisiKe = Number(statusJson.revisiKe);
          if (statusJson.isFinal !== undefined) state.isFinal = Boolean(statusJson.isFinal);
          saveCategoryState(category, state.revisiKe, state.isFinal);
        }
      }
    } catch (e) {
      // Fallback tetap menggunakan localState
    }

    renderInputView();
  }

  // ==================================================
  // EVENT HANDLER: INPUT QTY CHANGED
  // ==================================================
  function handleQtyInput(barangId, rawValue) {
    const sanitized = sanitizeNonNegativeQty(rawValue);
    
    const inputEl = document.querySelector(`.so-qty-input[data-id="${barangId}"]`);
    if (inputEl && inputEl.value !== String(sanitized)) {
      inputEl.value = sanitized;
    }

    state.inputSO[barangId] = sanitized;
  }

  // ==================================================
  // RENDER VIEW 1: INPUT HASIL SO (AWAL & REVISI)
  // ==================================================
  function renderInputView() {
    const modalEl = getOrCreateModalElement();

    // 1. Opsi Kategori
    let categoryOptionsHtml = `<option value="">-- PILIH KATEGORI --</option>`;
    state.categories.forEach(cat => {
      const selected = cat === state.kategoriAktif ? 'selected' : '';
      categoryOptionsHtml += `<option value="${escapeHtml(cat)}" ${selected}>${escapeHtml(cat)}</option>`;
    });

    // 2. Filter Barang Berdasarkan Kategori
    const filteredItems = state.kategoriAktif
      ? state.masterBarang.filter(item => {
          const cat = String(item.kategori || item.area || 'Lainnya').trim().toUpperCase();
          return cat === state.kategoriAktif;
        })
      : [];

    let bodyContentHtml = '';

    if (!state.kategoriAktif) {
      bodyContentHtml = `
        <div style="text-align: center; padding: 40px 20px; color: #64748b;">
          Pilih kategori di atas untuk memulai penghitungan Stock Opname.
        </div>
      `;
    } else if (state.isFinal) {
      bodyContentHtml = `
        <div style="text-align: center; padding: 40px 20px; color: #d32f2f; font-weight: 600;">
          🔒 Stock Opname untuk kategori "${escapeHtml(state.kategoriAktif)}" telah FINALISED / TERKUNCI.<br>
          Data tidak dapat diubah lagi.
        </div>
      `;
    } else if (filteredItems.length === 0) {
      bodyContentHtml = `
        <div style="text-align: center; padding: 40px 20px; color: #64748b;">
          Tidak ada barang pada kategori "${escapeHtml(state.kategoriAktif)}".
        </div>
      `;
    } else {
      bodyContentHtml = `<div class="so-item-list">`;
      filteredItems.forEach(item => {
        // Tampilkan input lama jika sudah pernah diisi
        const currentQty = state.inputSO[item.id] !== undefined ? state.inputSO[item.id] : '';
        const satuanText = item.satuan || item.Satuan || 'Pcs';

        // PENTING: Hanya tampilkan Nama Barang, Satuan, dan Input Jumlah Hasil SO.
        // Nominal tidak ditampilkan sebelum aturan perhitungan lokal tervalidasi.
        bodyContentHtml += `
          <div class="so-item-card">
            <div class="so-item-info">
              <span class="so-item-name">${escapeHtml(item.nama || item.Nama)}</span>
              <span class="so-item-satuan">${escapeHtml(satuanText)}</span>
            </div>
            <div class="so-qty-input-wrapper">
              <input 
                type="number" 
                min="0" 
                step="1"
                class="so-qty-input" 
                data-id="${item.id}" 
                value="${currentQty}" 
                placeholder="0"
                oninput="window.StockOpname.onQtyInput('${item.id}', this.value)"
              />
            </div>
          </div>
        `;
      });
      bodyContentHtml += `</div>`;
    }

    // 3. Tombol Submit
    const canSubmit = state.kategoriAktif && filteredItems.length > 0 && !state.isFinal;
    const submitBtnHtml = canSubmit
      ? `<button type="button" class="so-btn so-btn-primary" onclick="window.StockOpname.submitSO()">SIMPAN SO</button>`
      : '';

    const html = `
      <div class="so-modal-container">
        <div class="so-header">
          <h2>📦 STOCK OPNAME ${state.isRevising ? '(REVISI)' : ''}</h2>
          <button type="button" class="so-close-btn" onclick="window.StockOpname.close()">&times;</button>
        </div>

        <div class="so-body">
          <div class="so-category-wrapper">
            <label for="soCategorySelect">KATEGORI:</label>
            <select id="soCategorySelect" class="so-select" onchange="window.StockOpname.onCategoryChange(this.value)">
              ${categoryOptionsHtml}
            </select>
          </div>

          ${bodyContentHtml}
        </div>

        <div class="so-footer">
          <button type="button" class="so-btn so-btn-secondary" onclick="window.StockOpname.close()">BATAL</button>
          ${submitBtnHtml}
        </div>
      </div>
    `;

    modalEl.innerHTML = html;
  }

  // ==================================================
  // SAVE LOCAL STOCK OPNAME DRAFT
  // ==================================================
  async function submitSO() {
    if (state.sedangMemproses) return;
    if (!state.kategoriAktif) {
      alert('Pilih kategori terlebih dahulu');
      return;
    }

    const filteredItems = state.masterBarang.filter(item => {
      const cat = String(item.kategori || item.area || 'Lainnya').trim().toUpperCase();
      return cat === state.kategoriAktif;
    });

    if (filteredItems.length === 0) {
      alert('Tidak ada barang untuk dikirim');
      return;
    }

    // Susun Payload minimal tanpa melakukan perhitungan apapun di frontend
    const itemsPayload = filteredItems.map(item => {
      const val = state.inputSO[item.id];
      const qtyHasil = (val === '' || val === undefined || isNaN(Number(val))) ? 0 : Number(val);
      return {
        local_master_barang_id: item.id || item.local_master_barang_id,
        namaBarang: item.nama || item.Nama,
        area: item.area || item.kategori || state.kategoriAktif,
        satuan: item.satuan || item.Satuan || 'Pcs',
        jumlahHasilSO: qtyHasil
      };
    });

    // Server menggunakan mode untuk membedakan SO baru dan revisi.
    const mode = state.isRevising ? 'REVISION' : 'NEW';
    const petugas = getPetugasName();
    const tanggalSO = new Date().toISOString();

    const payload = {
      mode: mode,
      category: state.kategoriAktif,
      petugas: petugas,
      tanggalSO: tanggalSO,
      soId: mode === 'REVISION' ? (state.soId || '') : '',
      items: itemsPayload
    };

    state.sedangMemproses = true;
    showLoadingOverlay(true, 'MENGHITUNG STOCK OPNAME...', 'Mohon tunggu.');

    try {
      const res = await fetch('/api/stock-opname/local/simpan', {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify(payload)
      });

      const json = await res.json();

      if (!res.ok || !json || json.success === false) {
        throw new Error(json.message || `Gagal memproses SO (HTTP ${res.status})`);
      }

      // Hasil lokal berasal dari SQLite; stok operasional tidak diubah oleh draft.
      const hasilData = json.data || json;
      state.hasilSO = hasilData;
      state.soId = json.soId || hasilData.soId;

      // HANYA jika pengiriman berhasil, revisiKe resmi menjadi 1
      if (state.isRevising) {
        state.revisiKe = 1;
        state.isRevising = false;
      }

      // Simpan status revisi & final ke storage lokal
      saveCategoryState(state.kategoriAktif, state.revisiKe, state.isFinal);

      showLoadingOverlay(false);
      state.sedangMemproses = false;

      // Tampilkan hasil perhitungan
      renderResultsView();

    } catch (err) {
      showLoadingOverlay(false);
      state.sedangMemproses = false;
      // Jika gagal: revisiKe TIDAK bertambah, input tetap ada, user dapat mencoba lagi
      alert('Gagal mengirim Stock Opname: ' + err.message);
    }
  }

  // ==================================================
  // SAVE SNAPSHOT TO SERVER (C:\POS\data\stock-opname\)
  // ==================================================
  // ==================================================
  // RENDER VIEW 2: HASIL DRAFT SQLITE
  // ==================================================
  function renderResultsView() {
    const modalEl = getOrCreateModalElement();
    const resData = state.hasilSO || {};
    const items = resData.items || [];
    
    // Ambil nilai ringkasan dari response lokal.
    const summary = resData.summary || {
      totalPlus: resData.totalPlus || 0,
      totalMinus: resData.totalMinus || 0,
      totalKerugian: resData.totalKerugian || 0
    };

    let itemsListHtml = '';

    items.forEach(item => {
      // Selisih kuantitas berasal dari response SQLite lokal.
      const selisih = Number(item.selisihBarang || 0);

      let badgeClass = 'so-badge-zero';
      let selisihText = '0';

      if (selisih > 0) {
        badgeClass = 'so-badge-plus';
        selisihText = `+${selisih}`;
      } else if (selisih < 0) {
        badgeClass = 'so-badge-minus';
        selisihText = `${selisih}`;
      }

      const namaBarang = item.namaBarang || item.nama || 'Barang';
      const stokAktual = item.jumlahBarangAktual !== undefined ? item.jumlahBarangAktual : (item.stokAktual || 0);
      const hasilSO = item.jumlahHasilSO !== undefined ? item.jumlahHasilSO : 0;

      itemsListHtml += `
        <div class="so-result-card">
          <div>
            <div class="so-item-name">${escapeHtml(namaBarang)}</div>
            <div class="so-result-details">
              <span><span class="so-result-label">Aktual Sistem :</span> <span class="so-result-val">${stokAktual}</span></span>
              <span><span class="so-result-label">Hasil SO :</span> <span class="so-result-val">${hasilSO}</span></span>
            </div>
          </div>
          <div>
            <span class="so-badge ${badgeClass}">${selisihText}</span>
          </div>
        </div>
      `;
    });

    // Batas Revisi Check: Disabled jika sudah pernah revisi (revisiKe >= 1) atau sudah final
    const isRevisiDisabled = true; // Local revision history is not implemented yet.
    const revisiBtnAttr = isRevisiDisabled
      ? 'disabled title="Revisi menunggu aturan riwayat lokal tervalidasi" class="so-btn so-btn-warning disabled"'
      : 'class="so-btn so-btn-warning"';

    const html = `
      <div class="so-modal-container">
        <div class="so-header">
          <h2>📦 HASIL STOCK OPNAME — ${escapeHtml(state.kategoriAktif)}</h2>
          <button type="button" class="so-close-btn" onclick="window.StockOpname.close()">&times;</button>
        </div>

        <div class="so-body">
          <div class="so-results-header">DAFTAR HASIL PERHITUNGAN</div>
          
          ${itemsListHtml}

          <!-- Ringkasan draft lokal; nominal diblokir sampai formula lama terverifikasi. -->
          <div class="so-summary-box">
            <div class="so-summary-item">
              <span class="so-summary-title">TOTAL PLUS</span>
              <span class="so-summary-val plus">+${summary.totalPlus || 0}</span>
            </div>
            <div class="so-summary-item">
              <span class="so-summary-title">TOTAL MINUS</span>
              <span class="so-summary-val minus">${summary.totalMinus || 0}</span>
            </div>
            <div class="so-summary-item">
              <span class="so-summary-title">TOTAL KERUGIAN</span>
              <span class="so-summary-val loss">Rp ${formatRupiah(summary.totalKerugian || 0)}</span>
            </div>
          </div>
          <div style="padding: 10px 14px; color: #92400e; background: #fffbeb; border-radius: 8px;">
            Draft tersimpan di SQLite. Rumus nominal plus/minus dan finalisasi masih diblokir sampai aturan lama tervalidasi.
          </div>
        </div>

        <div class="so-footer">
          <button type="button" ${revisiBtnAttr} onclick="window.StockOpname.handleRevisi()">REVISI</button>
          <button type="button" class="so-btn so-btn-secondary" disabled title="Finalisasi menunggu verifikasi aturan dan persetujuan">DRAFT TERSIMPAN</button>
        </div>
      </div>
    `;

    modalEl.innerHTML = html;
  }

  // ==================================================
  // REVISI FLOW
  // ==================================================
  function handleRevisi() {
    if (state.revisiKe >= 1) {
      alert('Revisi hanya dapat dilakukan maksimal 1 kali.');
      return;
    }
    if (state.isFinal) {
      alert('Stock Opname sudah difinalisasi dan tidak dapat direvisi.');
      return;
    }

    // Masuk ke mode revisi (revisiKe BELUM diubah ke 1 sampai kirim revisi berhasil)
    state.isRevising = true;

    // Kembali ke tampilan input (data inputSO sebelumnya tetap tersimpan)
    renderInputView();
  }

  // ==================================================
  // FINALISASI FLOW WITH CONFIRMATION
  // ==================================================
  // ==================================================
  // UI DIALOGS: LOADING & CONFIRMATION
  // ==================================================
  function showLoadingOverlay(show, title = 'MENGHITUNG STOCK OPNAME...', sub = 'Mohon tunggu.') {
    let loader = document.getElementById('soLoaderOverlay');
    if (show) {
      if (!loader) {
        loader = document.createElement('div');
        loader.id = 'soLoaderOverlay';
        loader.className = 'so-loader-overlay';
        loader.innerHTML = `
          <div class="so-billiard-ball"></div>
          <div class="so-loader-title" id="soLoaderTitle">${escapeHtml(title)}</div>
          <div class="so-loader-sub" id="soLoaderSub">${escapeHtml(sub)}</div>
        `;
        const modalContainer = document.querySelector('.so-modal-container');
        if (modalContainer) {
          modalContainer.appendChild(loader);
        } else {
          document.body.appendChild(loader);
        }
      } else {
        const titleEl = document.getElementById('soLoaderTitle');
        const subEl = document.getElementById('soLoaderSub');
        if (titleEl) titleEl.innerText = title;
        if (subEl) subEl.innerText = sub;
        loader.style.display = 'flex';
      }
    } else {
      if (loader) {
        loader.remove();
      }
    }
  }

  function showConfirmationDialog(title, message, onConfirm) {
    const existing = document.getElementById('soConfirmOverlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'soConfirmOverlay';
    overlay.className = 'so-confirm-overlay';

    overlay.innerHTML = `
      <div class="so-confirm-box">
        <div class="so-confirm-title">${escapeHtml(title)}</div>
        <div class="so-confirm-msg">${escapeHtml(message)}</div>
        <div class="so-confirm-actions">
          <button type="button" class="so-btn so-btn-secondary" id="soConfirmBatal">BATAL</button>
          <button type="button" class="so-btn so-btn-primary" id="soConfirmYa">YA, SELESAIKAN</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    document.getElementById('soConfirmBatal').addEventListener('click', () => {
      overlay.remove();
    });

    document.getElementById('soConfirmYa').addEventListener('click', () => {
      overlay.remove();
      if (typeof onConfirm === 'function') {
        onConfirm();
      }
    });
  }

  // ==================================================
  // HISTORY & REKAP MODULE STATE
  // ==================================================
  const historyState = {
    modalContainerId: 'soHistoryModal',
    historyData: [],
    rekapData: null
  };

  // ==================================================
  // FORMAT HELPERS
  // ==================================================
  function formatRupiah(n) {
    return 'Rp ' + Number(n || 0).toLocaleString('id-ID');
  }

  function formatDateTime(isoStr) {
    if (!isoStr) return '-';
    try {
      const d = new Date(isoStr);
      return d.toLocaleString('id-ID', {
        day: '2-digit', month: 'short', year: 'numeric',
        hour: '2-digit', minute: '2-digit'
      });
    } catch (_) { return String(isoStr); }
  }

  function formatMonth(isoStr) {
    if (!isoStr) return '-';
    try {
      const d = new Date(isoStr);
      return d.toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' });
    } catch (_) { return String(isoStr); }
  }

  function todayYYYYMM() {
    const d = new Date();
    return d.toISOString().slice(0, 7);
  }

  function selisihClass(n) {
    if (n > 0) return 'positive';
    if (n < 0) return 'negative';
    return '';
  }

  // ==================================================
  // RENDER: REKAP BULANAN
  // ==================================================
  function renderRekapCard(container) {
    if (!container) { console.error('[SO] renderRekapCard: container soRekapContent tidak ditemukan'); return; }
    const d = historyState.rekapData;
    if (!d) {
      container.innerHTML = '<div class="so-empty-state">Tidak ada data rekap untuk periode ini.</div>';
      return;
    }
    container.innerHTML = `
      <div class="so-rekap-card">
        <div class="so-rekap-stat">
          <div class="so-rekap-stat-label">Total Transaksi SO</div>
          <div class="so-rekap-stat-val">${d.total_transaksi_so ?? 0}</div>
        </div>
        <div class="so-rekap-stat">
          <div class="so-rekap-stat-label">Total Selisih Unit</div>
          <div class="so-rekap-stat-val ${d.total_selisih_qty < 0 ? 'loss' : ''}">${d.total_selisih_qty ?? 0}</div>
        </div>
        <div class="so-rekap-stat">
          <div class="so-rekap-stat-label">Akumulasi Kerugian Modal</div>
          <div class="so-rekap-stat-val loss">${formatRupiah(d.akumulasi_kerugian_modal)}</div>
        </div>
      </div>`;
  }

  // ==================================================
  // RENDER: TABEL RIWAYAT
  // ==================================================
  function renderHistoryTable(container) {
    if (!container) { console.error('[SO] renderHistoryTable: container soHistoryContent tidak ditemukan'); return; }
    const rows = historyState.historyData;
    if (!rows || rows.length === 0) {
      container.innerHTML = '<div class="so-empty-state">Belum ada riwayat Stock Opname.</div>';
      return;
    }
    container.innerHTML = `
      <table class="so-history-table">
        <thead>
          <tr>
            <th>Tanggal & Waktu</th>
            <th>Kategori</th>
            <th>Petugas</th>
            <th>Selisih Unit</th>
            <th>Kerugian Modal</th>
            <th>Aksi</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map(r => `
            <tr>
              <td>${formatDateTime(r.tanggal)}</td>
              <td>${r.kategori || '-'}</td>
              <td>${r.nama_kasir || '-'}</td>
              <td class="so-selisih-cell ${selisihClass(r.total_selisih_qty || 0)}">${r.total_selisih_qty ?? 0}</td>
              <td class="so-loss-cell">${formatRupiah(r.total_kerugian_modal)}</td>
              <td>
                <button class="so-detail-btn" onclick="window.StockOpname.showDetail(${r.id})">Detail</button>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>`;
  }

  // ==================================================
  // RENDER: TABEL DETAIL PRODUK
  // ==================================================
  function renderDetailTable(container, data) {
    if (!data || data.length === 0) {
      container.innerHTML = '<div class="so-empty-state">Tidak ada rincian produk.</div>';
      return;
    }
    container.innerHTML = `
      <table class="so-detail-table">
        <thead>
          <tr>
            <th>Nama Barang</th>
            <th>Stok Sistem</th>
            <th>Stok Fisik</th>
            <th>Selisih</th>
            <th>Harga Modal</th>
            <th>Total Rugi Modal</th>
            <th>Keterangan</th>
          </tr>
        </thead>
        <tbody>
          ${data.map(d => `
            <tr>
              <td>${d.nama_produk || '-'}</td>
              <td>${d.stok_sistem ?? 0}</td>
              <td>${d.stok_fisik ?? 0}</td>
              <td class="so-selisih-val ${selisihClass(d.selisih || 0)}">${d.selisih ?? 0}</td>
              <td>${formatRupiah(d.harga_modal)}</td>
              <td class="so-loss-val">${formatRupiah(d.total_rugi_modal)}</td>
              <td>${d.keterangan || '-'}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>`;
  }

  // ==================================================
  // LOAD REKAP BULANAN
  // ==================================================
  async function loadRekapBulanan(bulan) {
    try {
      const url = `/api/stock-opname/rekap-bulanan?bulan=${encodeURIComponent(bulan || '')}`;
      const resp = await fetch(url, { headers: getAuthHeaders() });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const json = await resp.json();
      if (json.success && json.data) {
        historyState.rekapData = json.data;
        renderRekapCard(document.getElementById('soRekapContent'));
      }
    } catch (err) {
      console.error('[SO] loadRekapBulanan error:', err);
    }
  }

  // ==================================================
  // LOAD RIWAYAT
  // ==================================================
  async function loadHistory() {
    try {
      const resp = await fetch('/api/stock-opname/history', { headers: getAuthHeaders() });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const json = await resp.json();
      if (json.success && Array.isArray(json.data)) {
        historyState.historyData = json.data;
        renderHistoryTable(document.getElementById('soHistoryContent'));
      }
    } catch (err) {
      console.error('[SO] loadHistory error:', err);
    }
  }

  // ==================================================
  // OPEN HISTORY MODAL
  // ==================================================
  async function openHistoryModal() {
    const containerId = historyState.modalContainerId;
    let modalEl = document.getElementById(containerId);
    if (!modalEl) {
      modalEl = document.createElement('div');
      modalEl.id = containerId;
      modalEl.className = 'so-modal-overlay';
      modalEl.style.display = 'none';
      document.body.appendChild(modalEl);
    }
    modalEl.classList.remove('hidden');
    modalEl.style.display = 'flex';

    // Reset inner containers (don't wipe the modal itself, so static
    // children soRekapContent / soHistoryContent / soFilterBulan survive).
    document.getElementById('soRekapContent').innerHTML = '';
    document.getElementById('soHistoryContent').innerHTML = '';

    // Set default month to current
    const currentMonth = todayYYYYMM();
    const filterInput = document.getElementById('soFilterBulan');
    if (filterInput) filterInput.value = currentMonth;

    await Promise.all([loadHistory(), loadRekapBulanan(currentMonth)]);
  }

  // ==================================================
  // CLOSE HISTORY MODAL
  // ==================================================
  function closeHistoryModal() {
    const modalEl = document.getElementById(historyState.modalContainerId);
    if (modalEl) {
      modalEl.classList.add('hidden');
      modalEl.style.display = 'none';
      modalEl.setAttribute('aria-hidden', 'true');
    }
  }

  // ==================================================
  // CLOSE DETAIL MODAL
  // ==================================================
  function closeDetail() {
    const modalEl = document.getElementById('soDetailModal');
    if (modalEl) {
      modalEl.classList.add('hidden');
      modalEl.style.display = 'none';
      modalEl.innerHTML = '';
    }
  }

  // ==================================================
  // SHOW DETAIL MODAL
  // ==================================================
  async function showDetail(opnameId) {
    let modalEl = document.getElementById('soDetailModal');
    if (!modalEl) {
      modalEl = document.createElement('div');
      modalEl.id = 'soDetailModal';
      modalEl.className = 'so-modal-overlay';
      document.body.appendChild(modalEl);
    }
    modalEl.classList.remove('hidden');
    modalEl.style.display = 'flex';

    modalEl.innerHTML = `
      <div class="so-modal-content" style="background:#fff;border-radius:12px;width:90%;max-width:750px;overflow:hidden;box-shadow:0 10px 25px rgba(0,0,0,0.2);">
        <div class="so-header" style="background:#1e293b;color:#fff;padding:16px 20px;display:flex;justify-content:space-between;align-items:center;">
          <h3 style="margin:0;font-size:1.1rem;font-weight:600;">DETAIL STOCK OPNAME #${opnameId}</h3>
          <button class="so-close-btn" onclick="window.StockOpname.closeDetail()" style="background:none;border:none;color:#fff;font-size:1.5rem;cursor:pointer;">&times;</button>
        </div>
        <div style="text-align:center;padding:40px;">
          <div style="font-size:0.95rem;color:#475569;">Memuat detail...</div>
        </div>
      </div>`;

    try {
      const resp = await fetch(`/api/stock-opname/detail/${opnameId}`, {
        headers: typeof getAuthHeaders === 'function' ? getAuthHeaders() : {}
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const json = await resp.json();

      const items = Array.isArray(json)
        ? json
        : (json.data?.items || (json.success && Array.isArray(json.data) ? json.data : []) || []);

      let rowsHtml;
      if (!items.length) {
        rowsHtml = '<tr><td colspan="6" style="text-align:center;padding:15px;color:#888;">Tidak ada rincian barang.</td></tr>';
      } else {
        rowsHtml = items.map((item, idx) => {
          const nama = item.nama || item.nama_barang || '-';
          const stokSistem = item.stok_sistem ?? 0;
          const stokFisik = item.stok_fisik ?? 0;
          const selisih = item.selisih ?? (stokFisik - stokSistem);
          const totalRugi = item.total_rugi_modal ?? item.kerugian_hpp ?? 0;
          const satuan = item.satuan || 'Pcs';

          const selisihStyle = selisih < 0
            ? 'color:#ef4444;font-weight:bold;'
            : selisih > 0
              ? 'color:#10b981;font-weight:bold;'
              : 'color:#6b7280;';
          const selisihText = selisih > 0 ? `+${selisih}` : `${selisih}`;

          return `
            <tr style="border-bottom:1px solid #f1f5f9;">
              <td style="padding:10px;text-align:center;">${idx + 1}</td>
              <td style="padding:10px;font-weight:500;color:#1e293b;">${nama}</td>
              <td style="padding:10px;text-align:right;color:#475569;">${stokSistem} ${satuan}</td>
              <td style="padding:10px;text-align:right;font-weight:600;color:#0f172a;">${stokFisik} ${satuan}</td>
              <td style="padding:10px;text-align:right;${selisihStyle}">${selisihText}</td>
              <td style="padding:10px;text-align:right;color:#dc2626;font-weight:600;">Rp ${Number(totalRugi).toLocaleString('id-ID')}</td>
            </tr>`;
        }).join('');
      }

      modalEl.innerHTML = `
        <div class="so-modal-content" style="background:#fff;border-radius:12px;width:90%;max-width:750px;max-height:85vh;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 10px 25px rgba(0,0,0,0.2);">
          <div class="so-header" style="background:#1e293b;color:#fff;padding:16px 20px;display:flex;justify-content:space-between;align-items:center;">
            <h3 style="margin:0;font-size:1.1rem;font-weight:600;">DETAIL STOCK OPNAME #${opnameId}</h3>
            <button class="so-close-btn" onclick="window.StockOpname.closeDetail()" style="background:none;border:none;color:#fff;font-size:1.5rem;cursor:pointer;">&times;</button>
          </div>
          <div class="so-body" style="padding:20px;overflow-y:auto;flex:1;">
            <div style="overflow-x:auto;">
              <table style="width:100%;border-collapse:collapse;font-size:0.9rem;text-align:left;">
                <thead>
                  <tr style="background:#f8fafc;border-bottom:2px solid #e2e8f0;color:#475569;">
                    <th style="padding:10px;text-align:center;width:40px;">#</th>
                    <th style="padding:10px;">Nama Barang</th>
                    <th style="padding:10px;text-align:right;">Sistem</th>
                    <th style="padding:10px;text-align:right;">Fisik</th>
                    <th style="padding:10px;text-align:right;">Selisih</th>
                    <th style="padding:10px;text-align:right;">Kerugian Modal</th>
                  </tr>
                </thead>
                <tbody>${rowsHtml}</tbody>
              </table>
            </div>
          </div>
          <div class="so-footer" style="padding:12px 20px;background:#f8fafc;border-top:1px solid #e2e8f0;text-align:right;">
            <button onclick="window.StockOpname.closeDetail()" style="padding:8px 16px;background:#64748b;color:#fff;border:none;border-radius:6px;cursor:pointer;font-weight:500;">Tutup</button>
          </div>
        </div>`;
    } catch (err) {
      console.error('[SO] showDetail error:', err);
      modalEl.innerHTML = `
        <div class="so-modal-content" style="background:#fff;border-radius:12px;width:90%;max-width:500px;padding:20px;text-align:center;">
          <div style="color:#ef4444;margin-bottom:10px;font-size:1.1rem;font-weight:600;">Gagal Memuat Detail</div>
          <div style="color:#64748b;margin-bottom:15px;font-size:0.9rem;">${err.message || 'Terjadi kesalahan sistem.'}</div>
          <button onclick="window.StockOpname.closeDetail()" style="padding:8px 16px;background:#64748b;color:#fff;border:none;border-radius:6px;cursor:pointer;">Tutup</button>
        </div>`;
    }
  }

  // ==================================================
  // ==================================================
  // EXPORT (Defensive & Complete Aliases)
  // ==================================================
  const getFn = (fnName, fallbackMsg) => {
    if (typeof window[fnName] === 'function') return window[fnName];
    try {
      const fn = eval(fnName);
      if (typeof fn === 'function') return fn;
    } catch (e) {}
    return function () { console.error(`[SO] ${fallbackMsg || fnName + ' tidak terdefinisi'}`); };
  };

  const openMainFn  = typeof openSOModal === 'function' ? openSOModal : (typeof openStockOpnameModal === 'function' ? openStockOpnameModal : getFn('openSOModal'));
  const closeMainFn = typeof closeSOModal === 'function' ? closeSOModal : (typeof closeStockOpnameModal === 'function' ? closeStockOpnameModal : getFn('closeSOModal'));
  const openHistFn  = typeof openHistoryModal === 'function' ? openHistoryModal : (typeof openHistory === 'function' ? openHistory : getFn('openHistoryModal'));
  const closeHistFn = typeof closeHistoryModal === 'function' ? closeHistoryModal : (typeof closeHistory === 'function' ? closeHistory : getFn('closeHistoryModal'));

  window.StockOpname = Object.assign(window.StockOpname || {}, {
    // Main Modal Aliases
    open:                  openMainFn,
    close:                 closeMainFn,
    openSOModal:           openMainFn,
    openStockOpnameModal:  openMainFn,
    closeSOModal:          closeMainFn,
    closeStockOpnameModal: closeMainFn,

    // History Modal Aliases
    openHistory:           openHistFn,
    openHistoryModal:      openHistFn,
    closeHistory:          closeHistFn,
    closeHistoryModal:     closeHistFn,

    // Detail Modal Aliases
    showDetail:  typeof showDetail   === 'function' ? showDetail   : getFn('showDetail'),
    closeDetail: typeof closeDetail  === 'function' ? closeDetail  : getFn('closeDetail'),

    // Action Handlers
    loadSOProducts:   typeof loadSOProducts   === 'function' ? loadSOProducts   : getFn('loadSOProducts'),
    submitStockOpname: typeof submitStockOpname === 'function' ? submitStockOpname : getFn('submitStockOpname'),
    loadRekapBulanan: typeof loadRekapBulanan === 'function' ? loadRekapBulanan : getFn('loadRekapBulanan'),
  });
})();

