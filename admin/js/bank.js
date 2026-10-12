/* ============================================================
   SALDO BANK — Modul Terpisah (Fix #34, #36, #41, #77, #80)
   ============================================================ */

// Format rupiah tersedia dari kas.js (dimuat lebih dulu di dashboard.html)
// const formatRupiah = ...  — gunakan yang sudah didefinisikan

// ── SALDO BANK & VERIFIKASI SETORAN KODE UNIK (Fix #34) ─────
const SALDO_BANK_CACHE_KEY = 'pbms_cached_saldo_bank';
const cardSaldoBank      = document.getElementById('cardSaldoBank');
const statSaldoBankTotal = document.getElementById('statSaldoBankTotal');
const modalSaldoBank     = document.getElementById('modalSaldoBank');
const btnCloseModalBank  = document.getElementById('btnCloseModalBank');
const bankSumSaldo       = document.getElementById('bankSumSaldo');
const bankSumPending     = document.getElementById('bankSumPending');
const bankCountPending   = document.getElementById('bankCountPending');
const btnBankTabPending  = document.getElementById('btnBankTabPending');
const btnBankTabHistory  = document.getElementById('btnBankTabHistory');
const bankPanelPending   = document.getElementById('bankPanelPending');
const bankPanelHistory   = document.getElementById('bankPanelHistory');
const bankPendingList    = document.getElementById('bankPendingList');
const bankSelectAllPending = document.getElementById('bankSelectAllPending');
const inputBankKodeUnik  = document.getElementById('inputBankKodeUnik');
const btnBankCheckCode   = document.getElementById('btnBankCheckCode');
const bankAlertBox       = document.getElementById('bankAlertBox');
const cardBankDepositPreview = document.getElementById('cardBankDepositPreview');
const bankPreviewKode    = document.getElementById('bankPreviewKode');
const bankPreviewKasir   = document.getElementById('bankPreviewKasir');
const bankPreviewTanggal = document.getElementById('bankPreviewTanggal');
const bankPreviewNominal = document.getElementById('bankPreviewNominal');
const bankPreviewOmzet   = document.getElementById('bankPreviewOmzet');
const bankActionBar      = document.getElementById('bankActionBar');
const btnBankSubmitDeposit = document.getElementById('btnBankSubmitDeposit');
const btnBankConfirm     = document.getElementById('btnBankConfirm');
const bankHistoryBody    = document.getElementById('bankHistoryBody');
const bankDetailDrawer   = document.getElementById('bankDetailDrawer');
const bankDetailBody     = document.getElementById('bankDetailBody');
const btnCloseBankDetail = document.getElementById('btnCloseBankDetail');
let bankPendingCache = [];
let bankHistoryCache = [];
let lastCheckedDeposit = null; // data dari check-code untuk submit

const persistSaldoBankCache = (value) => {
  try { localStorage.setItem(SALDO_BANK_CACHE_KEY, value); }
  catch (e) { /* private mode — abaikan */ }
};

// Instant cache: 0 ms saat init (pola Fix #29/#32)
(function initSaldoBankInstant() {
  try {
    const cached = localStorage.getItem(SALDO_BANK_CACHE_KEY);
    if (cached !== null && cached !== '') statSaldoBankTotal.textContent = cached;
  } catch (e) { /* abaikan */ }
})();

const openBankModal = () => {
  modalSaldoBank.classList.add('is-open');
  modalSaldoBank.removeAttribute('hidden');
  modalSaldoBank.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';

  // Sembunyikan alert & reset form
  if (bankAlertBox) bankAlertBox.hidden = true;
  if (cardBankDepositPreview) cardBankDepositPreview.hidden = true;
  if (inputBankKodeUnik) {
    inputBankKodeUnik.value = '';
    setTimeout(() => inputBankKodeUnik.focus(), 100);
  }

  loadBankSummary();
  loadBankPendingDeposits();
  loadBankHistory();
};

// Expose to global scope for access from other modules (e.g., burger menu)
window.openBankModal = openBankModal;

const closeBankModal = () => {
  modalSaldoBank.classList.remove('is-open');
  modalSaldoBank.setAttribute('hidden', '');
  modalSaldoBank.setAttribute('aria-hidden', 'true');
  document.body.style.overflow = '';
};

const loadBankSummary = async () => {
  try {
    const resp = await fetch('/api/admin/bank/summary');
    const data = await resp.json();
    if (!resp.ok || !data.success) return;
    const formatted = formatRupiah(data.saldo_bank_saat_ini);
    statSaldoBankTotal.textContent = formatted;
    persistSaldoBankCache(formatted);
    if (bankSumSaldo)    bankSumSaldo.textContent = formatRupiah(data.saldo_bank_saat_ini);
    if (bankSumPending)  bankSumPending.textContent = formatRupiah(data.total_pending_setoran);
    if (bankCountPending) bankCountPending.textContent = String(data.count_pending);
  } catch (err) {
    console.warn('Gagal memuat ringkasan bank:', err.message);
  }
};

const loadBankPendingDeposits = async () => {
  bankPendingList.innerHTML = '<div class="bank-empty">Memuat data…</div>';
  try {
    const resp = await fetch('/api/admin/bank/pending-deposits');
    const data = await resp.json();
    if (!resp.ok || !data.success) throw new Error(data.message || 'Gagal');
    bankPendingCache = data.data || [];
    renderBankPendingList();
  } catch (err) {
    bankPendingList.innerHTML =
      `<div class="bank-empty">Gagal memuat: ${escapeHtml(err.message)}</div>`;
  }
};

const renderBankPendingList = () => {
  if (!bankPendingCache.length) {
    bankPendingList.innerHTML =
      '<div class="bank-empty">Tidak ada setoran pending. Semua sudah dikonfirmasi.</div>';
    bankSelectAllPending.checked = false;
    bankSelectAllPending.disabled = true;
    return;
  }
  bankSelectAllPending.disabled = false;
  bankPendingList.innerHTML = bankPendingCache.map(r => {
    const cbId = 'bankPcb_' + r.id;
    return `<label class="bank-pending-item" for="${cbId}">
      <input type="checkbox" id="${cbId}" data-bank-pending-id="${r.id}"
             data-bank-pending-kode="${escapeHtml(r.kode_unik)}"
             checked>
      <span class="bank-pending-item__code">${escapeHtml(r.kode_unik)}</span>
      <span class="bank-pending-item__meta">
        <span class="bank-pending-item__kasir">${escapeHtml(r.kasir || '—')}</span>
        <span class="bank-pending-item__tanggal">${escapeHtml(r.tanggal || '—')}</span>
      </span>
      <span class="bank-pending-item__nominal">${formatRupiah(r.nominal_setoran)}</span>
    </label>`;
  }).join('');

  // Bind checkboxes
  bankPendingList.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    cb.addEventListener('change', () => {
      cb.closest('.bank-pending-item').classList.toggle('is-checked', cb.checked);
      // Update "Pilih Semua"
      const all = bankPendingList.querySelectorAll('input[type="checkbox"]');
      const checkedCount = [...all].filter(c => c.checked).length;
      bankSelectAllPending.checked = checkedCount === all.length;
      bankSelectAllPending.indeterminate = checkedCount > 0 && checkedCount < all.length;
    });
    cb.closest('.bank-pending-item').classList.add('is-checked');
  });

  // Select all
  bankSelectAllPending.addEventListener('change', (e) => {
    const val = e.target.checked;
    bankPendingList.querySelectorAll('input[type="checkbox"]').forEach(cb => {
      cb.checked = val;
      cb.closest('.bank-pending-item').classList.toggle('is-checked', val);
    });
    bankSelectAllPending.indeterminate = false;
  });
};

// ── Fix #36: Tabel utama modal bank KHUSUS status DISETOR, 8 kolom ──
// Data dari /bank/history (sudah filter status_bank='DISETOR' di server).
// Setiap baris menyimpan payload `detail` untuk drawer rekapitulasi.
const loadBankHistory = async () => {
  bankHistoryBody.innerHTML =
    '<tr class="tx-table__empty"><td colspan="8">Memuat data…</td></tr>';
  try {
    const resp = await fetch('/api/admin/bank/history');
    const data = await resp.json();
    if (!resp.ok || !data.success) throw new Error(data.message || 'Gagal');
    const rows = data.data || [];
    bankHistoryCache = rows; // cache untuk drawer Detail
    // (Fix #44) Helper parse & format untuk kolom riwayat
    const parseOleh = (raw) => {
      if (!raw) return '—';
      // Jika string JSON, ambil nama/username
      if (typeof raw === 'string' && raw.startsWith('{')) {
        try {
          const obj = JSON.parse(raw);
          return obj.nama || obj.username || raw;
        } catch (e) { /* bukan JSON valid, fallback */ }
      }
      // Jika sudah object
      if (typeof raw === 'object' && raw !== null) {
        return raw.nama || raw.username || JSON.stringify(raw);
      }
      return String(raw);
    };

    const fmtTanggalSetor = (iso) => {
      if (!iso) return '—';
      const d = new Date(iso);
      if (isNaN(d.getTime())) return escapeHtml(iso);
      return d.toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' })
        + ' ' + d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
    };

    bankHistoryBody.innerHTML = rows.length
      ? rows.map((r, i) => `
        <tr>
          <td class="time">${fmtTanggalSetor(r.tanggal_setor)}</td>
          <td class="time">${escapeHtml(r.tanggal_tutup || '—')}</td>
          <td class="bank-hist-code">${escapeHtml(r.kode_unik)}</td>
          <td>${escapeHtml(r.kasir || '—')}</td>
          <td class="col-num">${formatRupiah(r.nominal_setoran)}</td>
          <td class="col-oleh">${escapeHtml(parseOleh(r.diinput_oleh))}</td>
          <td><span class="badge badge-qris--terverifikasi">DISETOR</span></td>
          <td class="col-aksi">
            <button type="button" class="bank-detail-btn" data-bank-hist-idx="${i}">Detail</button>
          </td>
        </tr>`).join('')
      : '<tr class="tx-table__empty"><td colspan="8">Belum ada setoran yang dikonfirmasi ke bank.</td></tr>';
  } catch (err) {
    bankHistoryBody.innerHTML =
      `<tr class="tx-table__empty"><td colspan="8">Gagal: ${escapeHtml(err.message)}</td></tr>`;
  }
};

// Delegate: tombol Detail di tabel riwayat → buka drawer
if (bankHistoryBody) {
  bankHistoryBody.addEventListener('click', (e) => {
    const btn = e.target.closest('.bank-detail-btn');
    if (!btn) return;
    const idx = Number(btn.dataset.bankHistIdx);
    const row = bankHistoryCache[idx];
    if (!row) return;
    openBankDetail(row);
  });
}

// Tab toggle
const switchBankTab = (tab) => {
  const isPending = tab === 'pending';
  btnBankTabPending.classList.toggle('is-active', isPending);
  btnBankTabHistory.classList.toggle('is-active', !isPending);
  bankPanelPending.classList.toggle('is-active', isPending);
  bankPanelHistory.classList.toggle('is-active', !isPending);
};
btnBankTabPending.addEventListener('click', () => switchBankTab('pending'));
btnBankTabHistory.addEventListener('click', () => { switchBankTab('history'); loadBankHistory(); });

// ── Fix #36: Sanitasi input kode unik (otomatis KAPITAL, maks 6, A-Z0-9) ──
const sanitizeBankCode = (raw) =>
  String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
// (Fix #42) Caret preservation: simpan selectionStart/End SEBELUM mutasi,
// set value hanya bila berubah, lalu restore posisi kursor.
// Sebelumnya: `setSelectionRange(pos-1, pos-1)` — saat pos=1 (pertama
// kali ketik) → pos-1=0 → kursor selalu snap ke index 0, huruf terbalik.
safeAddEventListener(inputBankKodeUnik, 'input', (e) => {
  const el = e.target;
  const start = el.selectionStart;
  const end   = el.selectionEnd;
  const cleaned = sanitizeBankCode(el.value);
  if (cleaned !== el.value) {
    el.value = cleaned;
    // Clamp posisi kursor ke panjang value baru (bisa lebih pendek setelah
    // slice(0,6) atau hapus non-alphanumeric)
    const clampPos = Math.min(start, cleaned.length);
    el.setSelectionRange(clampPos, clampPos);
  }
});
safeAddEventListener(inputBankKodeUnik, 'keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); checkBankCode(); }
});

// ── Fix #36: Cek Kode + Card Preview ─────────────────────────
const showBankAlert = (kind, msg) => {
  if (!bankAlertBox) return;
  bankAlertBox.className = 'bank-alert-box ' + (kind === 'danger' ? 'is-danger' : 'is-warning');
  bankAlertBox.textContent = msg;
  bankAlertBox.hidden = false;
};
const hideBankAlert = () => {
  if (!bankAlertBox) return;
  bankAlertBox.hidden = true;
  bankAlertBox.className = 'bank-alert-box';
};

const fmtJam = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '—'
    : d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
};
const fmtTglJam = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '—'
    : d.toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' })
      + ' ' + d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
};
// (Fix #43) Format tanggal saja (contoh: "11 Okt 2026")
const fmtTanggal = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '—'
    : d.toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' });
};

const parseSnapshot = (raw) => {
  if (!raw) return null;
  try {
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (e) { return null; }
};

const renderBankPreview = (depositData) => {
  const d = depositData || {};
  const snap = parseSnapshot(d.pending_close_snapshot);
  const ring = snap && snap.ringkasanPenjualan ? snap.ringkasanPenjualan : null;

  bankPreviewKode.textContent    = d.kode_tutup || '—';
  bankPreviewKasir.textContent   = d.kasir || '—';
  // (Fix #43) Tampilkan tanggal tutup shift (bukan rentang shift)
  bankPreviewTanggal.textContent = d.tutup_at
    ? fmtTanggal(d.tutup_at)
    : '—';
  bankPreviewNominal.textContent = formatRupiah(d.nominal_aktual);
  bankPreviewOmzet.textContent = ring
    ? formatRupiah(ring.totalPenjualan) + ' (' + (ring.jumlahTransaksi || 0) + ' trx)'
    : '—';

  cardBankDepositPreview.hidden = false;
  bankActionBar.hidden = false;
  lastCheckedDeposit = d;
};

const clearBankPreview = () => {
  cardBankDepositPreview.hidden = true;
  bankActionBar.hidden = true;
  lastCheckedDeposit = null;
};

const checkBankCode = async () => {
  const code = sanitizeBankCode(inputBankKodeUnik.value);
  if (code.length < 4) {
    hideBankAlert();
    clearBankPreview();
    return;
  }
  hideBankAlert();
  clearBankPreview();
  btnBankCheckCode.disabled = true;
  try {
    const resp = await fetch('/api/admin/bank/check-code/' + encodeURIComponent(code));
    const data = await resp.json();
    if (resp.ok && data.success) {
      showBankAlert('ok', 'Kode ' + code + ' valid & masih PENDING — siap dikonfirmasi.');
      renderBankPreview(data.data);
    } else if (data.is_deposited) {
      showBankAlert('danger', 'Kode ' + code + ' SUDAH DISETOR sebelumnya.'
        + (data.data && data.data.deposited_at ? ' Pada ' + fmtTglJam(data.data.deposited_at)
          + ' oleh ' + (data.data.deposited_by || 'admin') + '.' : ''));
    } else if (data.is_found === false) {
      showBankAlert('danger', data.message || ('Kode ' + code + ' tidak ditemukan.'));
    } else {
      showBankAlert('danger', data.message || 'Gagal memvalidasi kode.');
    }
  } catch (err) {
    showBankAlert('danger', 'Gagal cek kode: ' + err.message);
  } finally {
    btnBankCheckCode.disabled = false;
  }
};
if (btnBankCheckCode) btnBankCheckCode.addEventListener('click', checkBankCode);

// ── Fix #36: Konfirmasi Setor (individual, dari preview) ─────
const submitBankDeposit = async () => {
  if (!lastCheckedDeposit) return;
  const kode = lastCheckedDeposit.kode_tutup;
  const adminName = sessionStorage.getItem('pbms_admin_session') || 'admin';
  if (!window.confirm(
    'Konfirmasi setor ' + kode + ' ke bank?\nKasir: ' + (lastCheckedDeposit.kasir || '—')
  )) return;

  btnBankSubmitDeposit.disabled = true;
  btnBankSubmitDeposit.textContent = 'Memproses…';
  try {
    const resp = await fetch('/api/admin/bank/process-deposit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kode_unik_list: [kode], admin_name: adminName }),
    });
    const data = await resp.json();
    if (!resp.ok || !data.success) {
      if (data.already_deposited && Object.keys(data.already_deposited).length) {
        showBankAlert('danger', data.message || 'Kode sudah pernah disetor sebelumnya.');
      } else {
        throw new Error(data.message || 'Gagal memproses setoran');
      }
      return;
    }
    window.alert(data.message || 'Setoran berhasil dikonfirmasi.');
    if (inputBankKodeUnik) inputBankKodeUnik.value = '';
    clearBankPreview();
    hideBankAlert();
    loadBankSummary();
    loadBankPendingDeposits();
    loadBankHistory();
  } catch (err) {
    showBankAlert('danger', 'Gagal konfirmasi: ' + err.message);
  } finally {
    btnBankSubmitDeposit.disabled = false;
    btnBankSubmitDeposit.textContent = 'Konfirmasi Setor ke Bank';
  }
};
if (btnBankSubmitDeposit) btnBankSubmitDeposit.addEventListener('click', submitBankDeposit);

// ── Konfirmasi batch (checklist + kode dari daftar pending) ──
btnBankConfirm.addEventListener('click', async () => {
  const checkedKodes = [...bankPendingList.querySelectorAll('input[type="checkbox"]:checked')]
    .map(cb => cb.dataset.bankPendingKode)
    .filter(Boolean);

  if (!checkedKodes.length) {
    window.alert('Pilih minimal satu kode unik dari daftar pending.');
    return;
  }

  const adminName = sessionStorage.getItem('pbms_admin_session') || 'admin';
  if (!window.confirm(
    'Konfirmasi setor ' + checkedKodes.length + ' kode unik ke bank?\n\n' +
    checkedKodes.map(k => '• ' + k).join('\n')
  )) return;

  btnBankConfirm.disabled = true;
  const origText = btnBankConfirm.textContent;
  btnBankConfirm.textContent = 'Memproses…';

  try {
    const resp = await fetch('/api/admin/bank/process-deposit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kode_unik_list: checkedKodes, admin_name: adminName }),
    });
    const data = await resp.json();
    if (!resp.ok || !data.success) {
      // Fix #36: kode yang sudah DISETOR dilaporkan eksplisit
      const sudah = data.already_deposited ? Object.keys(data.already_deposited) : [];
      const msg = data.message || 'Gagal memproses setoran';
      if (sudah.length) {
        window.alert(msg + '\n\nKode yang sudah terlanjur disetor (dilewati):\n• ' + sudah.join('\n• '));
      } else {
        window.alert(msg);
      }
    } else {
      const sudah = data.already_deposited ? Object.keys(data.already_deposited) : [];
      if (sudah.length) {
        window.alert(data.message + '\n\nKode yang sudah terlanjur disetor:\n• ' + sudah.join('\n• '));
      } else {
        window.alert(data.message || 'Setoran berhasil dikonfirmasi.');
      }
    }
    loadBankSummary();
    loadBankPendingDeposits();
    loadBankHistory();
  } catch (err) {
    window.alert('Gagal konfirmasi: ' + err.message);
  } finally {
    btnBankConfirm.disabled = false;
    btnBankConfirm.textContent = origText;
  }
});

// ── Fix #36: Drawer Detail Alur Penjualan & Rekapitulasi ─────
const openBankDetail = (row) => {
  const d = row.detail || row;
  const snap = parseSnapshot(d.pending_close_snapshot);
  const ring = snap && snap.ringkasanPenjualan ? snap.ringkasanPenjualan : null;

  let html = '';

  // 1. Info shift
  html += `
    <div class="bank-detail-section">
      <h3>Info Shift</h3>
      <div class="bank-detail-info-grid">
        <div class="bank-detail-info-item">
          <div class="bank-detail-info-item__label">Kode Unik</div>
          <div class="bank-detail-info-item__value">${escapeHtml(d.kode_tutup || row.kode_unik || '—')}</div>
        </div>
        <div class="bank-detail-info-item">
          <div class="bank-detail-info-item__label">Kasir</div>
          <div class="bank-detail-info-item__value">${escapeHtml(d.kasir || row.kasir || '—')}</div>
        </div>
        <div class="bank-detail-info-item">
          <div class="bank-detail-info-item__label">Jam Buka</div>
          <div class="bank-detail-info-item__value">${fmtJam(d.buka_at)}</div>
        </div>
        <div class="bank-detail-info-item">
          <div class="bank-detail-info-item__label">Jam Tutup</div>
          <div class="bank-detail-info-item__value">${fmtJam(d.tutup_at)}</div>
        </div>
        <div class="bank-detail-info-item">
          <div class="bank-detail-info-item__label">Saldo Awal</div>
          <div class="bank-detail-info-item__value">${formatRupiah(d.saldo_awal)}</div>
        </div>
        <div class="bank-detail-info-item">
          <div class="bank-detail-info-item__label">Uang Laci</div>
          <div class="bank-detail-info-item__value">${formatRupiah(d.uang_laci)}</div>
        </div>
        <div class="bank-detail-info-item">
          <div class="bank-detail-info-item__label">Total Setoran Tunai</div>
          <div class="bank-detail-info-item__value">${formatRupiah(d.nominal_aktual ?? row.nominal_setoran)}</div>
        </div>
        <div class="bank-detail-info-item">
          <div class="bank-detail-info-item__label">Setor Bank</div>
          <div class="bank-detail-info-item__value">${fmtTglJam(d.deposited_at || row.tanggal_setor)}</div>
        </div>
      </div>
    </div>`;

  // 2. Ringkasan penjualan
  if (ring) {
    html += `
      <div class="bank-detail-section">
        <h3>Ringkasan Penjualan Sesi</h3>
        <div class="bank-detail-ringkasan">
          <div class="bank-detail-ringkasan-row">
            <span class="label">Jumlah Transaksi</span>
            <span class="value">${ring.jumlahTransaksi || 0}
              (Cash ${ring.jumlahTransaksiCash || 0} · QRIS ${ring.jumlahTransaksiQris || 0})</span>
          </div>
          <div class="bank-detail-ringkasan-row">
            <span class="label">Total Cash</span>
            <span class="value">${formatRupiah(ring.totalCash)}</span>
          </div>
          <div class="bank-detail-ringkasan-row">
            <span class="label">Total QRIS</span>
            <span class="value">${formatRupiah(ring.totalQris)}</span>
          </div>
          <div class="bank-detail-ringkasan-row">
            <span class="label">Total Penjualan</span>
            <span class="value">${formatRupiah(ring.totalPenjualan)}</span>
          </div>
          <div class="bank-detail-ringkasan-row">
            <span class="label">Nominal Aktual</span>
            <span class="value">${formatRupiah(ring.nominalAktual)}</span>
          </div>
          ${snap.selisihPenjualan != null ? `<div class="bank-detail-ringkasan-row">
            <span class="label">Selisih Penjualan</span>
            <span class="value">${formatRupiah(snap.selisihPenjualan)}</span>
          </div>` : ''}
        </div>
      </div>`;
  }

  // 3. Rekap produk
  if (snap && Array.isArray(snap.rekapProduk) && snap.rekapProduk.length) {
    html += `
      <div class="bank-detail-section">
        <h3>Rekap Produk (${snap.rekapProduk.length})</h3>
        <div class="bank-scroll-x">
          <table class="bank-detail-table">
            <thead><tr>
              <th>Produk</th><th class="num">Qty</th>
              <th class="num">Harga Jual</th><th class="num">Subtotal</th>
            </tr></thead>
            <tbody>
              ${snap.rekapProduk.map(p => `<tr>
                <td>${escapeHtml(p.nama_barang || '—')}</td>
                <td class="num">${p.qty || 0}</td>
                <td class="num">${formatRupiah(p.harga_jual)}</td>
                <td class="num">${formatRupiah(p.subtotal)}</td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>`;
  }

  // 4. Daftar transaksi
  if (snap && Array.isArray(snap.transaksi) && snap.transaksi.length) {
    html += `
      <div class="bank-detail-section">
        <h3>Daftar Transaksi (${snap.transaksi.length})</h3>
        <div class="bank-scroll-x-limit">
          <table class="bank-detail-table">
            <thead><tr>
              <th>No. Transaksi</th><th>Jam</th><th>Meja</th>
              <th>Metode</th><th class="num">Total</th>
            </tr></thead>
            <tbody>
              ${snap.transaksi.map(t => `<tr>
                <td>${escapeHtml(t.nomor_transaksi || '—')}</td>
                <td>${escapeHtml(t.jam || '—')}</td>
                <td>${escapeHtml(t.nomor_meja != null ? '#' + t.nomor_meja : '—')}</td>
                <td>${escapeHtml(t.metode_pembayaran || '—')}</td>
                <td class="num">${formatRupiah(t.total)}</td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>`;
  }

  // 5. Performa meja
  if (snap && Array.isArray(snap.performaMeja) && snap.performaMeja.length) {
    const mejaAktif = snap.performaMeja.filter(m => (m.omzet || 0) > 0);
    if (mejaAktif.length) {
      html += `
        <div class="bank-detail-section">
          <h3>Performa Meja (${mejaAktif.length} meja aktif)</h3>
          <div class="bank-scroll-x">
            <table class="bank-detail-table">
              <thead><tr>
                <th>Meja</th><th class="num">Jumlah Sesi</th>
                <th class="num">Durasi (jam)</th><th class="num">Omzet</th>
              </tr></thead>
              <tbody>
                ${mejaAktif.map(m => `<tr>
                  <td>#${escapeHtml(m.nomor_meja)}</td>
                  <td class="num">${m.jumlah_sesi || 0}</td>
                  <td class="num">${m.total_durasi_jam || 0}</td>
                  <td class="num">${formatRupiah(m.omzet)}</td>
                </tr>`).join('')}
              </tbody>
            </table>
          </div>
        </div>`;
    }
  }

  if (!snap) {
    html += `<div class="bank-detail-section">
      <h3>Detail Sesi</h3>
      <p class="bank-empty">Snapshot rekapitulasi tidak tersedia untuk shift ini.</p>
    </div>`;
  }

  bankDetailBody.innerHTML = html;
  document.getElementById('bankDetailDrawerTitle').textContent =
    'Detail Setoran ' + (d.kode_tutup || row.kode_unik || '');
  bankDetailDrawer.hidden = false;
  requestAnimationFrame(() => bankDetailDrawer.classList.add('is-open'));
};

// (Fix #41) closeBankDetail: set hidden=true SEGERA (tanpa delay) agar
// layer z-850 tak intercept klik di bawah drawer. Transition CSS
// pointer-events:none (drawer tertutup) menjamin layer hilang dari
// hit-test meski animation fade-in masih berjalan.
const closeBankDetail = () => {
  if (!bankDetailDrawer) return;
  bankDetailDrawer.classList.remove('is-open');
  bankDetailDrawer.hidden = true;
};

safeAddEventListener(btnCloseBankDetail, 'click', closeBankDetail);
// (Fix #41) Overlay-click: e.target === overlay → tutup.
// Sebelumnya listener tak null-guarded; bila bankDetailDrawer null
// → throw dan menghentikan seluruh init chain.
safeAddEventListener(bankDetailDrawer, 'click', (e) => {
  if (e.target === bankDetailDrawer) closeBankDetail();
});

// Event listeners
cardSaldoBank.addEventListener('click', openBankModal);
btnCloseModalBank.addEventListener('click', closeBankModal);
modalSaldoBank.addEventListener('click', (e) => {
  if (e.target === modalSaldoBank) closeBankModal();
});

// ESC: drawer detail bank (850) → modal bank (800)
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!bankDetailDrawer.hidden && bankDetailDrawer.classList.contains('is-open')) {
    closeBankDetail();
    e.stopPropagation();
    return;
  }
  if (modalSaldoBank.classList.contains('is-open')) {
    closeBankModal();
    e.stopPropagation();
  }
});

// Init: panggil loadBankSummary saat halaman load
loadBankSummary();
