/**
 * STOCK OPNAME (SO) MODULE
 * Project: POS POLAR BILLIARD
 * Path: C:\POS\stock-opname.js
 * 
 * Logic Frontend Stock Opname:
 * - POS hanya mengumpulkan input hitung fisik dan menampilkan hasil dari Apps Script.
 * - Tidak melakukan perhitungan selisih, kerugian, atau total di frontend.
 * - Status revisi baru terpakai setelah pengiriman revisi ke server/Apps Script berhasil.
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
    hasilSO: null,       // Response murni dari Apps Script / Server
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
      const response = await fetch('/api/barang', {
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
      const res = await fetch(`/api/stock-opname/status?category=${encodeURIComponent(category)}`, {
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
          ðŸ”’ Stock Opname untuk kategori "${escapeHtml(state.kategoriAktif)}" telah FINALISED / TERKUNCI.<br>
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
        // Stok Aktual, HPP, Harga Jual, dan Selisih TIDAK DITAMPILKAN sebelum Apps Script selesai menghitung.
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
          <h2>ðŸ“¦ STOCK OPNAME ${state.isRevising ? '(REVISI)' : ''}</h2>
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
  // PROCESS SUBMIT SO TO GOOGLE APPS SCRIPT / BACKEND
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
        idBarang: item.id || item.idBarang,
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
      action: 'proses_stock_opname',
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
      const res = await fetch('/api/stock-opname/simpan', {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify(payload)
      });

      const json = await res.json();

      if (!res.ok || !json || json.success === false) {
        throw new Error(json.message || `Gagal memproses SO (HTTP ${res.status})`);
      }

      // Terima response hasil perhitungan murni dari Apps Script
      const hasilData = json.data || json;
      state.hasilSO = hasilData;

      // HANYA jika pengiriman berhasil, revisiKe resmi menjadi 1
      if (state.isRevising) {
        state.revisiKe = 1;
        state.isRevising = false;
      }

      // Simpan status revisi & final ke storage lokal
      saveCategoryState(state.kategoriAktif, state.revisiKe, state.isFinal);

      // SIMPAN SNAPSHOT KE SERVER (Hanya jika Apps Script berhasil memberikan response)
      await saveSnapshotToServer(hasilData);

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
  async function saveSnapshotToServer(hasilData) {
    try {
      const snapshotPayload = {
        soId: hasilData.soId || `SO-${Date.now()}`,
        kategori: state.kategoriAktif,
        petugas: getPetugasName(),
        tanggal: new Date().toISOString(),
        revisi_ke: state.revisiKe,
        status: state.isFinal ? 'FINAL' : 'HASIL',
        items: hasilData.items || [],
        summary: hasilData.summary || {}
      };

      await fetch('/api/stock-opname/snapshot', {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify(snapshotPayload)
      });
    } catch (e) {
      console.warn('[SO] Gagal menyimpan snapshot lokal di server:', e);
    }
  }

  // ==================================================
  // RENDER VIEW 2: HASIL PERHITUNGAN APPS SCRIPT
  // ==================================================
  function renderResultsView() {
    const modalEl = getOrCreateModalElement();
    const resData = state.hasilSO || {};
    const items = resData.items || [];
    
    // Ambil nilai ringkasan langsung dari response Apps Script
    const summary = resData.summary || {
      totalPlus: resData.totalPlus || 0,
      totalMinus: resData.totalMinus || 0,
      totalKerugian: resData.totalKerugian || 0
    };

    let itemsListHtml = '';

    items.forEach(item => {
      // Nilai selisih murni dari response Apps Script
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
    const isRevisiDisabled = state.revisiKe >= 1 || state.isFinal;
    const revisiBtnAttr = isRevisiDisabled
      ? 'disabled class="so-btn so-btn-warning disabled"'
      : 'class="so-btn so-btn-warning"';

    const html = `
      <div class="so-modal-container">
        <div class="so-header">
          <h2>ðŸ“¦ HASIL STOCK OPNAME â€” ${escapeHtml(state.kategoriAktif)}</h2>
          <button type="button" class="so-close-btn" onclick="window.StockOpname.close()">&times;</button>
        </div>

        <div class="so-body">
          <div class="so-results-header">DAFTAR HASIL PERHITUNGAN</div>
          
          ${itemsListHtml}

          <!-- RINGKASAN HASIL DARI RESPONSE APPS SCRIPT -->
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
        </div>

        <div class="so-footer">
          <button type="button" ${revisiBtnAttr} onclick="window.StockOpname.handleRevisi()">REVISI</button>
          <button type="button" class="so-btn so-btn-primary" onclick="window.StockOpname.handleSelesai()">SELESAI</button>
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
  function handleSelesai() {
    showConfirmationDialog(
      'Apakah Anda yakin ingin menyelesaikan Stock Opname ini?',
      'Data yang sudah diselesaikan tidak dapat diubah lagi.',
      async () => {
        await finalizeSO();
      }
    );
  }

  async function finalizeSO() {
    if (state.sedangMemproses) return;

    state.sedangMemproses = true;
    showLoadingOverlay(true, 'MENYIMPAN FINALISASI...', 'Mohon tunggu.');

    try {
      const payload = {
        category: state.kategoriAktif,
        petugas: getPetugasName(),
        revisiKe: state.revisiKe,
        statusApprove: 'APPROVED'
      };

      const res = await fetch('/api/stock-opname/finalize', {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify(payload)
      });

      const json = await res.json();

      if (!res.ok || !json || json.success === false) {
        throw new Error(json.message || 'Gagal memfinalisasi Stock Opname');
      }

      // Kunci data SO & simpan status final
      state.isFinal = true;
      saveCategoryState(state.kategoriAktif, state.revisiKe, true);

      // Simpan snapshot final ke server
      if (state.hasilSO) {
        await saveSnapshotToServer({
          ...state.hasilSO,
          isFinal: true
        });
      }

      showLoadingOverlay(false);
      state.sedangMemproses = false;

      alert('Stock Opname berhasil diselesaikan dan dikunci.');
      closeSOModal();

    } catch (err) {
      showLoadingOverlay(false);
      state.sedangMemproses = false;
      alert('Gagal memfinalisasi SO: ' + err.message);
    }
  }

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
  // EXPOSE SAFE PUBLIC NAMESPACE
  // ==================================================
  window.StockOpname = {
    open: openSOModal,
    close: closeSOModal,
    onCategoryChange: handleCategoryChange,
    onQtyInput: handleQtyInput,
    submitSO: submitSO,
    handleRevisi: handleRevisi,
    handleSelesai: handleSelesai
  };

})();


