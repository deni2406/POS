// ============================================================
// PBMS ADMIN — MODUL QRIS (dipisah dari dashboard.js)
// Helper pendukung mandiri agar tidak memicu ReferenceError
// (beberapa helper lain sudah global di dashboard.js/kas.js,
// tapi modul ini harus berdiri sendiri).
// ============================================================

// Helper format rupiah — identik dengan di dashboard.js (reused)
const qrisFormatRupiah = (num) =>
  'Rp ' + (num || 0).toLocaleString('id-ID');

// Helper escape HTML — identik dengan global di dashboard.js
const qrisEscapeHtml = (str) =>
  String(str ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));

// Helper format tanggal YYYY-MM-DD lokal (salinan dari kas.js)
const qrisToYMD = (d = new Date()) => {
  const date = d instanceof Date ? d : new Date(d);
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

// Helper awal bulan berjalan YYYY-MM-01 (salinan dari kas.js)
const qrisKasMonthStartYMD = () => {
  const n = new Date();
  return n.getFullYear() + '-' + String(n.getMonth() + 1).padStart(2, '0') + '-01';
};

// ── MODAL: Pencatatan & Riwayat QRIS (Fix #25) ─────────────────
const qrisModal = document.getElementById('modalQrisHistory');
const qrisBtnClose = document.getElementById('btnCloseModalQris');
const inputStartDateQris = document.getElementById('inputStartDateQris');
const inputEndDateQris = document.getElementById('inputEndDateQris');
const selectFilterStatusQris = document.getElementById('selectFilterStatusQris');
const inputSearchQris = document.getElementById('inputSearchQris');
const sumQrisHariIni = document.getElementById('sumQrisHariIni');
const sumQrisCountHariIni = document.getElementById('sumQrisCountHariIni');
const sumQrisBulanIni = document.getElementById('sumQrisBulanIni');
const sumQrisPending = document.getElementById('sumQrisPending');
const statQrisHariIni = document.getElementById('statQrisHariIni');
const qrisBody = document.getElementById('qrisTableBody');
const cardQrisHistory = document.getElementById('cardQrisHistory');
// Card disembunyikan dari grid dashboard (Fix #83 QRIS). Elemen tetap ada di DOM
// agar referensi tidak null, namun akses klik dibiarkan pada dashboard.js.
let qrisLoaded = false;

// ── INSTANT RENDER QRIS akumulasi bulan (Fix #32) ─────────────
// Card QRIS di dashboard utama menampilkan akumulasi bulan berjalan
// (bukan hari ini). Cache format-Rp di localStorage agar refresh
// berikutnya angka muncul instan tanpa berkedip "Rp --".
const QRIS_MONTH_CACHE_KEY = 'pbms_cached_total_qris_month';
const persistQrisMonthCache = (value) => {
  try {
    localStorage.setItem(QRIS_MONTH_CACHE_KEY, value);
  } catch (e) { /* private mode — abaikan */ }
};
(function initQrisInstantCache() {
  try {
    const cached = localStorage.getItem(QRIS_MONTH_CACHE_KEY);
    if (cached !== null && cached !== '') {
      statQrisHariIni.textContent = cached;
    }
  } catch (e) { /* abaikan */ }
})();

const qrisStatusBadge = (status) => {
  switch (String(status || '').toUpperCase()) {
    case 'PENDING':
      return '<span class="badge badge-qris--pending">Pending</span>';
    case 'BATAL':
      return '<span class="badge badge-qris--batal">Batal</span>';
    case 'TERVERIFIKASI':
    default:
      return '<span class="badge badge-qris--terverifikasi">Terverifikasi</span>';
  }
};

const openQrisModal = () => {
  if (!inputStartDateQris.value) inputStartDateQris.value = qrisKasMonthStartYMD();
  if (!inputEndDateQris.value) inputEndDateQris.value = qrisToYMD(new Date());
  qrisModal.classList.add('is-open');
  qrisModal.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
  if (!qrisLoaded) loadQrisHistory();
  loadQrisSummary();
};

const closeQrisModal = () => {
  qrisModal.classList.remove('is-open');
  qrisModal.setAttribute('aria-hidden', 'true');
  document.body.style.overflow = '';
};

const loadQrisSummary = async () => {
  try {
    const resp = await fetch('/api/admin/qris/summary');
    const data = await resp.json();
    if (!resp.ok || !data.success) return;
    sumQrisHariIni.textContent = qrisFormatRupiah(data.total_hari_ini);
    sumQrisCountHariIni.textContent = String(data.count_hari_ini || 0);
    sumQrisBulanIni.textContent = qrisFormatRupiah(data.total_bulan_ini);
    sumQrisPending.textContent = String(data.total_pending || 0);
    // Card dashboard utama: akumulasi bulan berjalan (Fix #32)
    const formattedBulan = qrisFormatRupiah(data.total_bulan_ini);
    statQrisHariIni.textContent = formattedBulan;
    persistQrisMonthCache(formattedBulan);
  } catch (err) {
    // Ringkasan tak kritis — biarkan nilai default saat gagal
    console.warn('Gagal memuat ringkasan QRIS:', err.message);
  }
};

const loadQrisHistory = async () => {
  qrisBody.innerHTML =
    '<tr class="tx-table__empty"><td colspan="5">Memuat data…</td></tr>';
  try {
    const s = inputStartDateQris.value || qrisKasMonthStartYMD();
    const e = inputEndDateQris.value || qrisToYMD(new Date());
    const query = `?startDate=${encodeURIComponent(s)}` +
      `&endDate=${encodeURIComponent(e)}` +
      `&status=${encodeURIComponent(selectFilterStatusQris.value || 'ALL')}` +
      `&search=${encodeURIComponent(inputSearchQris.value || '')}`;
    const resp = await fetch('/api/admin/qris/history' + query);
    const data = await resp.json();
    if (!resp.ok || !data.success) {
      throw new Error(data.message || 'Gagal memuat riwayat QRIS');
    }
    window.qrisHistoryCache = data.data || [];
    reRenderQrisTable();
    qrisLoaded = true;
  } catch (err) {
    qrisBody.innerHTML =
      `<tr class="tx-table__empty">
         <td colspan="5">Gagal memuat riwayat QRIS: ${qrisEscapeHtml(err.message)}</td>
       </tr>`;
  }
};

const reRenderQrisTable = () => {
  const rows = Array.isArray(window.qrisHistoryCache)
    ? window.qrisHistoryCache
    : [];
  const q = String(inputSearchQris.value || '').trim().toLowerCase();

  const filtered = rows.filter(r => {
    const matchSearch = !q
      || String(r.kode_transaksi || '').toLowerCase().includes(q)
      || String(r.kasir || '').toLowerCase().includes(q)
      || String(r.no_ref_qris || '').toLowerCase().includes(q);
    return matchSearch;
  });

  qrisBody.innerHTML = filtered.length
    ? filtered.map(r => {
        // Tombol "Verifikasi" HANYA untuk PENDING — transaksi yang sudah
        // TERVERIFIKASI / BATAL tidak perlu tindakan manual (badge saja).
        const status = String(r.status_qris || '').toUpperCase();
        const tombolVerifikasi = status === 'PENDING'
          ? `<button type="button" class="btn-qris-verify"
                     data-id="${r.id}" aria-label="Verifikasi QRIS transaksi ${qrisEscapeHtml(r.kode_transaksi)}">
               Verifikasi
             </button>`
          : '';
        return `<tr data-qris-id="${r.id}">
           <td class="time col-qris-waktu">${qrisEscapeHtml(r.waktu)} - ${qrisEscapeHtml(r.tanggal)}</td>
           <td class="col-qris-kode">${qrisEscapeHtml(r.kode_transaksi)}</td>
           <td class="col-qris-kasir">${qrisEscapeHtml(r.kasir)}</td>
           <td class="col-num col-qris-nominal">${qrisFormatRupiah(r.total_bayar)}</td>
           <td class="col-qris-status">
             ${qrisStatusBadge(r.status_qris)}${tombolVerifikasi}
           </td>
         </tr>`;
      }).join('')
    : '<tr class="tx-table__empty"><td colspan="5">Tidak ada riwayat QRIS untuk filter ini</td></tr>';
};

// Delegate event: tombol "Verifikasi" → prompt status + RRN → PATCH
qrisBody.addEventListener('click', async (e) => {
  const btn = e.target.closest('.btn-qris-verify');
  if (!btn) return;
  const txId = btn.dataset.id;
  const row = (window.qrisHistoryCache || []).find(r => String(r.id) === txId);
  if (!row) return;

  const statusKasus = ['TERVERIFIKASI', 'PENDING', 'BATAL'];
  const pilihan =
    `Pilih status verifikasi QRIS:\n` +
    `1 = Terverifikasi  (saat ini: ${row.status_qris})\n` +
    `2 = Pending\n3 = Batal\n\n` +
    `Masukkan nomor: (Enter = simpan status saja, ketik status & RRN) `;
  const masuk = window.prompt(pilihan, '');
  if (masuk === null) return;

  let statusFinal = row.status_qris;
  let refFinal = row.no_ref_qris;
  const tokens = masuk.trim().split(/\s+/).filter(Boolean);
  if (tokens.length) {
    const kodeStatus = tokens[0].toUpperCase();
    if (kodeStatus === '1' || kodeStatus === 'TERVERIFIKASI') statusFinal = 'TERVERIFIKASI';
    else if (kodeStatus === '2' || kodeStatus === 'PENDING') statusFinal = 'PENDING';
    else if (kodeStatus === '3' || kodeStatus === 'BATAL') statusFinal = 'BATAL';
    else {
      const upper = kodeStatus;
      if (statusKasus.includes(upper)) statusFinal = upper;
    }
    if (tokens.length > 1) refFinal = tokens.slice(1).join(' ');
  }

  try {
    const resp = await fetch('/api/admin/qris/verify/' + txId, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status_qris: statusFinal, no_ref_qris: refFinal }),
    });
    const data = await resp.json();
    if (!resp.ok || !data.success) {
      throw new Error(data.message || 'Gagal memperbarui status QRIS');
    }
    // Perbarui cache lokal agar tabel langsung menampilkan hasil baru
    row.status_qris = data.status_qris;
    row.no_ref_qris = data.no_ref_qris;
    reRenderQrisTable();
    loadQrisSummary(); // pending count bisa berubah
  } catch (err) {
    window.alert('Gagal memperbarui QRIS: ' + err.message);
  }
});

inputSearchQris.addEventListener('input', reRenderQrisTable);
selectFilterStatusQris.addEventListener('change', loadQrisHistory);
inputStartDateQris.addEventListener('change', () => {
  if (!inputStartDateQris.value) return;
  qrisLoaded = false;
  loadQrisHistory();
});
inputEndDateQris.addEventListener('change', () => {
  if (!inputEndDateQris.value) return;
  qrisLoaded = false;
  loadQrisHistory();
});
// Pemicu card QRIS di dashboard.js (via window.openQrisModal) — jangan
// double-bind di sini; qrisBtnClose milik modal ini tetap di sini.
qrisBtnClose.addEventListener('click', closeQrisModal);
qrisModal.addEventListener('click', (e) => {
  if (e.target === qrisModal) closeQrisModal();
});

// ESC khusus QRIS: tutup modal QRIS bila terbuka (handler lain berdiri
// sendiri di dashboard.js — z-index 1000 kini paling atas, Fix #80)
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && qrisModal.classList.contains('is-open')) {
    closeQrisModal();
  }
});

// Populate card QRIS (akumulasi bulan) saat file dimuat — Fix #32
loadQrisSummary();

// Eksport ke global scope agar bisa dipanggil dari dashboard.js
window.openQrisModal = openQrisModal;
window.loadQrisSummary = loadQrisSummary;
