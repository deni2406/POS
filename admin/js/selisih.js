// ============================================================
// PBMS ADMIN — MODUL SELISIH KASIR & STOCK OPNAME (SO)
// (dipisahkan dari dashboard.js, pola Fix #81/#84). Helper
// mandiri berawalan `selisih*` agar tidak memicu ReferenceError
// — modul ini berdiri sendiri.
// ============================================================

// Helper format rupiah — identik dengan dashboard.js
const selisihFormatRupiah = (num) =>
  'Rp ' + (num || 0).toLocaleString('id-ID');

// Helper format angka — identik dengan dashboard.js
const selisihFormatNumber = (num) =>
  (num || 0).toLocaleString('id-ID');

// Helper escape HTML — identik dengan global di dashboard.js
const selisihEscapeHtml = (str) =>
  String(str ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));

// Helper format bulan YYYY-MM lokal
const selisihToYM = (d = new Date()) => {
  const date = d instanceof Date ? d : new Date(d);
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
};

// ── MODAL: Detail Kerugian Stock Opname (Barang Minus) ─────────
const soModal = document.getElementById('modalKerugianSO');
const soBtnClose = document.getElementById('btnCloseModalKerugianSO');
const inputBulanKerugianSO = document.getElementById('inputBulanKerugianSO');
const inputSearchKerugianSO = document.getElementById('inputSearchKerugianSO');
const countProdukMinus = document.getElementById('countProdukMinus');
const sumUnitMinus = document.getElementById('sumUnitMinus');
const sumNominalKerugian = document.getElementById('sumNominalKerugian');
const kerugianBody = document.getElementById('kerugianSOTableBody');
const cardKerugianSO = document.getElementById('cardKerugianSO');
let soLoaded = false;

const initSoMonthInput = () => {
  if (!inputBulanKerugianSO.value) {
    inputBulanKerugianSO.value = selisihToYM(new Date());
  }
};

const openSoModal = () => {
  initSoMonthInput();
  soModal.classList.add('is-open');
  soModal.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
  if (!soLoaded) loadSoLosses(inputBulanKerugianSO.value);
};

const closeSoModal = () => {
  soModal.classList.remove('is-open');
  soModal.setAttribute('aria-hidden', 'true');
  document.body.style.overflow = '';
};

const loadSoLosses = async (monthYM) => {
  kerugianBody.innerHTML =
    '<tr class="tx-table__empty"><td colspan="8">Memuat data…</td></tr>';
  try {
    const m = monthYM || inputBulanKerugianSO.value;
    const query = m ? '?month=' + encodeURIComponent(m) : '';
    const resp = await fetch('/api/admin/stock-opname/losses' + query);
    const data = await resp.json();
    if (!resp.ok || !data.success) {
      throw new Error(data.message || 'Gagal memuat kerugian SO');
    }

    window.kerugianSOCache = data.data || [];

    // Chip ringkasan mengikuti data bulan yang diambil dari API
    countProdukMinus.textContent = selisihFormatNumber(data.summary ? data.summary.totalJenisBarangMinus : 0);
    sumUnitMinus.textContent = selisihFormatNumber(data.summary ? data.summary.totalUnitMinus : 0);
    sumNominalKerugian.textContent = selisihFormatRupiah(data.summary ? data.summary.totalNominalKerugian : 0);

    reRenderSoLossTable();
    soLoaded = true;
  } catch (err) {
    kerugianBody.innerHTML =
      `<tr class="tx-table__empty">
         <td colspan="8">Gagal memuat kerugian SO: ${selisihEscapeHtml(err.message)}</td>
       </tr>`;
  }
};

const reRenderSoLossTable = () => {
  const rows = Array.isArray(window.kerugianSOCache)
    ? window.kerugianSOCache
    : [];
  const q = String(inputSearchKerugianSO.value || '').trim().toLowerCase();

  // PERBAIKAN: Filter hanya barang MINUS (stok_fisik < stok_sistem)
  const minusItems = rows.filter(r => {
    const isMinus = Number(r.stok_fisik || 0) < Number(r.stok_sistem || 0);
    return isMinus && (!q
      || String(r.nama_barang || '').toLowerCase().includes(q)
      || String(r.kode_barang || '').toLowerCase().includes(q));
  });

  // Update stat chips ringkasan (mengikuti filter)
  countProdukMinus.textContent = selisihFormatNumber(minusItems.length);
  sumUnitMinus.textContent = selisihFormatNumber(
    minusItems.reduce((s, r) => s + Math.max(0, Number(r.stok_sistem) - Number(r.stok_fisik)), 0)
  );
  sumNominalKerugian.textContent = selisihFormatRupiah(
    minusItems.reduce((s, r) => {
      const selisih = Math.max(0, Number(r.stok_sistem) - Number(r.stok_fisik));
      return s + (selisih * (Number(r.hpp) || 0));
    }, 0)
  );

  kerugianBody.innerHTML = minusItems.length
    ? minusItems.map(r => {
        const hpp = Number(r.hpp) || 0;
        const selisihMinus = Math.max(0, Number(r.stok_sistem) - Number(r.stok_fisik));
        const totalKerugian = selisihMinus * hpp;
        return `<tr>
           <td class="col-no">${selisihEscapeHtml(r.kode_barang) || String(r.id_barang) || '—'}</td>
           <td>${selisihEscapeHtml(r.nama_barang) || '—'}</td>
           <td>${selisihEscapeHtml(r.kategori) || '—'}</td>
           <td class="col-num col-center">${selisihFormatNumber(r.stok_sistem)}</td>
           <td class="col-num col-center">${selisihFormatNumber(r.stok_fisik)}</td>
           <td class="col-num selisih-minus">${selisihMinus}</td>
           <td class="col-num">${selisihFormatRupiah(hpp)}</td>
           <td class="col-num total-kerugian">${selisihFormatRupiah(totalKerugian)}</td>
         </tr>`;
      }).join('')
    : '<tr class="tx-table__empty"><td colspan="8">Tidak ada barang minus untuk bulan ini</td></tr>';
};

// Pemicu klik card kerugian di dashboard.js (null-check) — tak
// di-bind di sini (anti double-bind, pola Fix #81).
soBtnClose.addEventListener('click', closeSoModal);
soModal.addEventListener('click', (e) => {
  if (e.target === soModal) closeSoModal();
});

inputSearchKerugianSO.addEventListener('input', reRenderSoLossTable);

// Ganti bulan → fetch ulang data untuk bulan terpilih.
inputBulanKerugianSO.addEventListener('change', () => {
  const selected = inputBulanKerugianSO.value;
  if (!selected) return;
  soLoaded = false;
  loadSoLosses(selected);
});

// ESC khusus kerugian SO
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && soModal.classList.contains('is-open')) {
    closeSoModal();
  }
});

// ── MODAL: Detail Kelebihan Stock Opname (Barang Plus) ─────────
const plusModal = document.getElementById('modalKelebihanSO');
const plusBtnClose = document.getElementById('btnCloseModalKelebihanSO');
const inputBulanKelebihanSO = document.getElementById('inputBulanKelebihanSO');
const inputSearchKelebihanSO = document.getElementById('inputSearchKelebihanSO');
const countProdukPlus = document.getElementById('countProdukPlus');
const sumUnitPlus = document.getElementById('sumUnitPlus');
const sumNominalPlus = document.getElementById('sumNominalPlus');
const kelebihanBody = document.getElementById('kelebihanSOTableBody');
let plusLoaded = false;

const initPlusMonthInput = () => {
  if (!inputBulanKelebihanSO.value) {
    inputBulanKelebihanSO.value = selisihToYM(new Date());
  }
};

const openPlusModal = () => {
  initPlusMonthInput();
  plusModal.classList.add('is-open');
  plusModal.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
  if (!plusLoaded) loadSoSurplus(inputBulanKelebihanSO.value);
};

const closePlusModal = () => {
  plusModal.classList.remove('is-open');
  plusModal.setAttribute('aria-hidden', 'true');
  document.body.style.overflow = '';
};

const loadSoSurplus = async (monthYM) => {
  kelebihanBody.innerHTML =
    '<tr class="tx-table__empty"><td colspan="8">Memuat data…</td></tr>';
  try {
    const m = monthYM || inputBulanKelebihanSO.value;
    const query = m ? '?month=' + encodeURIComponent(m) : '';
    const resp = await fetch('/api/admin/stock-opname/surplus' + query);
    const data = await resp.json();
    if (!resp.ok || !data.success) {
      throw new Error(data.message || 'Gagal memuat kelebihan SO');
    }

    window.kelebihanSOCache = data.data || [];

    reRenderSoSurplusTable();
    plusLoaded = true;
  } catch (err) {
    kelebihanBody.innerHTML =
      `<tr class="tx-table__empty">
         <td colspan="8">Gagal memuat kelebihan SO: ${selisihEscapeHtml(err.message)}</td>
       </tr>`;
  }
};

const reRenderSoSurplusTable = () => {
  const rows = Array.isArray(window.kelebihanSOCache)
    ? window.kelebihanSOCache
    : [];
  const q = String(inputSearchKelebihanSO.value || '').trim().toLowerCase();

  const filtered = rows.filter(r => {
    return !q
      || String(r.nama_barang || '').toLowerCase().includes(q)
      || String(r.kode_barang || '').toLowerCase().includes(q);
  });

  // Update stat chips ringkasan (mengikuti filter pencarian)
  countProdukPlus.textContent = selisihFormatNumber(filtered.length);
  sumUnitPlus.textContent = selisihFormatNumber(
    filtered.reduce((s, r) => s + (Number(r.qty_plus) || 0), 0)
  );
  sumNominalPlus.textContent = selisihFormatRupiah(
    filtered.reduce((s, r) => s + (Number(r.total_nilai_plus) || 0), 0)
  );

  kelebihanBody.innerHTML = filtered.length
    ? filtered.map(r => {
        const selisihPlus = Math.max(0, Number(r.qty_plus) || 0);
        const hpp = Number(r.hpp) || 0;
        const totalPlus = (Number(r.total_nilai_plus) || 0) || (selisihPlus * hpp);
        return `<tr>
           <td class="col-no">${selisihEscapeHtml(r.kode_barang) || String(r.id_barang) || '—'}</td>
           <td>${selisihEscapeHtml(r.nama_barang) || '—'}</td>
           <td>${selisihEscapeHtml(r.kategori) || '—'}</td>
           <td class="col-num col-center">${selisihFormatNumber(r.stok_sistem)}</td>
           <td class="col-num col-center">${selisihFormatNumber(r.stok_fisik)}</td>
           <td class="col-num selisih-plus">${selisihPlus}</td>
           <td class="col-num">${selisihFormatRupiah(hpp)}</td>
           <td class="col-num total-nilai-plus">${selisihFormatRupiah(totalPlus)}</td>
         </tr>`;
      }).join('')
    : '<tr class="tx-table__empty"><td colspan="8">Tidak ada barang plus untuk bulan ini</td></tr>';
};

inputSearchKelebihanSO.addEventListener('input', reRenderSoSurplusTable);
plusBtnClose.addEventListener('click', closePlusModal);
plusModal.addEventListener('click', (e) => {
  if (e.target === plusModal) closePlusModal();
});

// Ganti bulan → fetch ulang data untuk bulan terpilih
inputBulanKelebihanSO.addEventListener('change', () => {
  const selected = inputBulanKelebihanSO.value;
  if (!selected) return;
  plusLoaded = false;
  loadSoSurplus(selected);
});

// ESC khusus kelebihan SO
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && plusModal.classList.contains('is-open')) {
    closePlusModal();
  }
});

// ── SELISIH KASIR CARD (Fix #56) ────────────────────────────────
const cardSelisihKasir    = document.getElementById('cardSelisihKasir');
const statSelisihKasir    = document.getElementById('statSelisihKasir');
const modalSelisihKasir   = document.getElementById('modalSelisihKasir');
const btnCloseModalSelisih= document.getElementById('btnCloseModalSelisih');
const sumSelisihTotal     = document.getElementById('sumSelisihTotal');
const sumSelisihPlus      = document.getElementById('sumSelisihPlus');
const sumSelisihMinus     = document.getElementById('sumSelisihMinus');
const selisihTableBody    = document.getElementById('selisihTableBody');
const chipSelisihPlus     = document.getElementById('chipSelisihPlus');
const chipSelisihMinus    = document.getElementById('chipSelisihMinus');
let   selisihAllRows      = [];  // cached full dataset for re-filtering
let   currentSelisihFilter = 'ALL';
const SELISIH_CACHE_KEY   = 'pbms_cached_selisih_kasir';

const persistSelisihCache = (val) => {
  try { localStorage.setItem(SELISIH_CACHE_KEY, val); } catch (e) { /* private mode */ }
};
(function initSelisihInstant() {
  try {
    const c = localStorage.getItem(SELISIH_CACHE_KEY);
    if (c !== null && c !== '') {
      statSelisihKasir.textContent = c;
      const heroSelisih = document.getElementById('heroSelisihValue');
      if (heroSelisih) heroSelisih.textContent = c;
    }
  } catch (e) { /* abaikan */ }
})();

function openSelisihModal() {
  modalSelisihKasir.classList.add('is-open');
  modalSelisihKasir.removeAttribute('hidden');
  modalSelisihKasir.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
  loadSelisihKasir();
}
function closeSelisihModal() {
  modalSelisihKasir.classList.remove('is-open');
  modalSelisihKasir.setAttribute('hidden', '');
  modalSelisihKasir.setAttribute('aria-hidden', 'true');
  document.body.style.overflow = '';
}

const loadSelisihKasir = async () => {
  selisihTableBody.innerHTML = '<tr class="tx-table__empty"><td colspan="6">Memuat data…</td></tr>';
  try {
    const resp = await fetch('/api/admin/selisih-kasir');
    const data = await resp.json();
    if (!resp.ok || !data.success) throw new Error(data.message || 'Gagal memuat');
    selisihAllRows   = data.data || [];
    currentSelisihFilter = 'ALL';
    chipSelisihPlus.classList.remove('chip--filter-active');
    chipSelisihMinus.classList.remove('chip--filter-active');
    chipSelisihPlus.setAttribute('aria-pressed', 'false');
    chipSelisihMinus.setAttribute('aria-pressed', 'false');
    renderSelisihTable(selisihAllRows, data.total || 0);
  } catch (err) {
    selisihTableBody.innerHTML =
      `<tr class="tx-table__empty"><td colspan="6">Gagal memuat: ${selisihEscapeHtml(err.message)}</td></tr>`;
  }
};

const renderSelisihTable = (rows, total) => {
  // Update summary chips — hitung dari data FULL, bukan dari filtered
  const plusCount  = selisihAllRows.filter(r => r.selisih > 0).length;
  const minusCount = selisihAllRows.filter(r => r.selisih < 0).length;
  sumSelisihTotal.textContent = selisihFormatRupiah(total);
  sumSelisihTotal.className = 'tx-chip__value' + (total < 0 ? ' tx-chip__value--minus' : total > 0 ? ' tx-chip__value--plus' : '');
  sumSelisihPlus.textContent  = String(plusCount);
  sumSelisihMinus.textContent = String(minusCount);

  if (!rows.length) {
    selisihTableBody.innerHTML = '<tr class="tx-table__empty"><td colspan="6">Tidak ada data selisih kasir untuk bulan ini</td></tr>';
    return;
  }
  selisihTableBody.innerHTML = rows.map(r => {
    const selClass = r.selisih < 0
      ? 'col-num selisih-minus'
      : r.selisih > 0 ? 'col-num selisih-plus' : 'col-num';
    const selSign  = r.selisih < 0 ? '' : '+';
    return `<tr>
      <td><code class="kode-tutup">${selisihEscapeHtml(r.kode_tutup || '—')}</code></td>
      <td>${selisihEscapeHtml(r.tgl_jam || '—')}</td>
      <td>${selisihEscapeHtml(r.kasir || '—')}</td>
      <td class="col-num">${selisihFormatRupiah(r.nominal_aktual)}</td>
      <td class="col-num">${selisihFormatRupiah(r.uang_sistem)}</td>
      <td class="${selClass}">${selSign}${selisihFormatRupiah(r.selisih)}</td>
    </tr>`;
  }).join('');

  // Toggle card color class based on total
  cardSelisihKasir.classList.remove('selisih-positive', 'selisih-negative');
  if (total > 0)      cardSelisihKasir.classList.add('selisih-positive');
  else if (total < 0) cardSelisihKasir.classList.add('selisih-negative');

  // Persist instant cache for dashboard card
  const formatted = selisihFormatRupiah(total);
  statSelisihKasir.textContent = formatted;
  const heroSelisih = document.getElementById('heroSelisihValue');
  if (heroSelisih) heroSelisih.textContent = formatted;
  persistSelisihCache(formatted);
};

// Filter toggle: chip Plus ↔ Minus ↔ All
const applySelisihFilter = (filter) => {
  currentSelisihFilter = filter;
  chipSelisihPlus.classList.toggle('chip--filter-active', filter === 'PLUS');
  chipSelisihMinus.classList.toggle('chip--filter-active', filter === 'MINUS');
  chipSelisihPlus.setAttribute('aria-pressed', filter === 'PLUS');
  chipSelisihMinus.setAttribute('aria-pressed', filter === 'MINUS');
  // Re-render table with filtered rows
  const filtered = filter === 'ALL'
    ? selisihAllRows
    : filter === 'PLUS'
      ? selisihAllRows.filter(r => r.selisih > 0)
      : selisihAllRows.filter(r => r.selisih < 0);
  const totalFiltered = filtered.reduce((s, r) => s + r.selisih, 0);
  renderSelisihTable(filtered, totalFiltered);
};

chipSelisihPlus.addEventListener('click', () => {
  applySelisihFilter(currentSelisihFilter === 'PLUS' ? 'ALL' : 'PLUS');
});
chipSelisihMinus.addEventListener('click', () => {
  applySelisihFilter(currentSelisihFilter === 'MINUS' ? 'ALL' : 'MINUS');
});

// Pemicu klik card selisih & kelebihan SO di dashboard.js (null-check)
// — tak di-bind di sini (anti double-bind).
btnCloseModalSelisih.addEventListener('click', closeSelisihModal);
modalSelisihKasir.addEventListener('click', (e) => {
  if (e.target === modalSelisihKasir) closeSelisihModal();
});

// ESC khusus selisih kasir
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && modalSelisihKasir.classList.contains('is-open')) {
    closeSelisihModal();
  }
});

// Eksport ke global scope agar bisa dipanggil dari dashboard.js
// (pemicu card + item burger menu "Selisih Kasir")
window.openSelisihModal = openSelisihModal;
window.openSoModal = openSoModal;
window.openPlusModal = openPlusModal;
