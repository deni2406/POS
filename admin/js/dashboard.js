/* ============================================================
   PBMS ADMIN — DASHBOARD OVERVIEW
   ============================================================ */

document.addEventListener('DOMContentLoaded', () => {
  // ── SESSION GUARD ────────────────────────────────────────────
  const session = sessionStorage.getItem('pbms_admin_session');
  if (!session) {
    window.location.href = 'index.html';
    return;
  }

  // ── LOGOUT HANDLER ───────────────────────────────────────────
  const btnLogout = document.getElementById('btnLogout');
  btnLogout.addEventListener('click', () => {
    sessionStorage.removeItem('pbms_admin_session');
    window.location.href = 'index.html';
  });

  // ── HELPERS ──────────────────────────────────────────────────
  const formatRupiah = (num) =>
    'Rp ' + (num || 0).toLocaleString('id-ID');

  const formatNumber = (num) =>
    (num || 0).toLocaleString('id-ID');

  const formatDateTime = (iso) => {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toLocaleString('id-ID', {
      day: '2-digit', month: 'short',
      hour: '2-digit', minute: '2-digit',
    });
  };

  // ── FETCH OVERVIEW STATS ─────────────────────────────────────
  const fetchStats = async () => {
    const statTotalTx = document.getElementById('statTotalTx');
    const statTotalPenjualan = document.getElementById('statTotalPenjualan');
    const statKerugianSO = document.getElementById('statKerugianSO');
    const statTotalBarang = document.getElementById('statTotalBarang');
    const systemStatus = document.getElementById('systemStatus');
    const recentActivity = document.getElementById('recentActivity');

    try {
      const resp = await fetch('/api/admin/overview-stats');
      const data = await resp.json();

      if (!resp.ok || !data.success) {
        throw new Error(data.message || 'Gagal memuat data');
      }

      const s = data.stats;

      statTotalTx.textContent = formatNumber(s.totalTransaksiHariIni);
      statTotalPenjualan.textContent = formatRupiah(s.totalPenjualanHariIni);
      statKerugianSO.textContent = formatRupiah(s.kerugianSOBulanIni);
      statTotalBarang.textContent = formatNumber(s.totalMasterBarang);

      // System status rows
      systemStatus.innerHTML = [
        { label: 'Database', ok: s.system.database },
        { label: 'Server POS', ok: s.system.serverPos },
        { label: 'Jadwal Auto-Backup', ok: s.system.autoBackup },
      ].map(item =>
        `<div class="status-row" role="listitem">
           <span class="status-dot ${item.ok ? 'status-dot--ok' : 'status-dot--warn'}" aria-hidden="true"></span>
           <span class="status-text">${item.label}: ${item.ok ? 'Normal' : 'Perlu dicek'}</span>
         </div>`
      ).join('');

      // Recent activity rows
      const activities = data.aktivitasTerkini || [];
      recentActivity.innerHTML = activities.length
        ? activities.map(a =>
            `<div class="activity-row" role="listitem">
               <span class="activity-time">${formatDateTime(a.waktu)}</span>
               <span class="activity-text">${a.aksinya || a.aksi || a.keterangan || a.detail || 'Aktivitas'}</span>
             </div>`
          ).join('')
        : `<div class="activity-row" role="listitem">
             <span class="activity-time">—</span>
             <span class="activity-text">Belum ada aktivitas tercatat</span>
           </div>`;

    } catch (err) {
      // Graceful error state
      statTotalTx.textContent = '—';
      statTotalPenjualan.textContent = '—';
      statKerugianSO.textContent = '—';
      statTotalBarang.textContent = '—';

      systemStatus.innerHTML =
        `<div class="status-row" role="listitem">
           <span class="status-dot status-dot--error" aria-hidden="true"></span>
           <span class="status-text">Gagal memuat: ${err.message}</span>
         </div>`;

      recentActivity.innerHTML =
        `<div class="activity-row" role="listitem">
           <span class="activity-time">—</span>
           <span class="activity-text">Tidak dapat memuat aktivitas</span>
         </div>`;
    }
  };

  // ── MODAL: Detail Transaksi Hari Ini ──────────────────────────
  const modal = document.getElementById('modalDetailTransaksi');
  const cardTotalTx = document.getElementById('cardTotalTx');
  const btnClose = document.getElementById('btnCloseModalTx');
  const txBody = document.getElementById('txTableBody');
  const modalTxCount = document.getElementById('modalTxCount');
  const modalTxTotal = document.getElementById('modalTxTotal');
  const inputSearchTx = document.getElementById('inputSearchTx');
  const selectFilterMetode = document.getElementById('selectFilterMetode');
  const countTxFiltered = document.getElementById('countTxFiltered');
  const sumOmzetFiltered = document.getElementById('sumOmzetFiltered');
  let txLoaded = false;

  // Cache transaksi harian — isian diisi loadTransactions, dipakai renderTxTable
  window.todayTransactionsCache = [];

  // Normalisasi metode untuk pembanding filter
  const normalizeMetode = (m) =>
    (String(m || 'LIAR')).trim().toUpperCase();

  const reRenderTxTable = () => {
    const rows = Array.isArray(window.todayTransactionsCache)
      ? window.todayTransactionsCache
      : [];
    const q = String(inputSearchTx.value || '').trim().toLowerCase();
    const metode = selectFilterMetode.value; // '' = semua

    const filtered = rows.filter(r => {
      const matchMetode = !metode || normalizeMetode(r.metode) === metode;
      const matchCari = !q
        || String(r.no_struk || '').toLowerCase().includes(q)
        || String(r.kasir || '').toLowerCase().includes(q);
      return matchMetode && matchCari;
    });

    // Update stat chips ringkasan
    countTxFiltered.textContent = formatNumber(filtered.length);
    sumOmzetFiltered.textContent = formatRupiah(
      filtered.reduce((sum, r) => sum + (Number(r.total) || 0), 0)
    );

    // Render baris tabel
    txBody.innerHTML = filtered.length
      ? filtered.map(r =>
          `<tr>
             <td class="num">${escapeHtml(r.no_struk) || '—'}</td>
             <td class="time">${escapeHtml(formatJam(r.waktu))}</td>
             <td>${escapeHtml(r.kasir) || '—'}</td>
             <td>${metodeBadge(r.metode)}</td>
             <td class="num">${formatRupiah(r.total)}</td>
             <td><button type="button" class="btn-detail-tx" data-tx-id="${r.id}">Detail</button></td>
           </tr>`
        ).join('')
      : '<tr class="tx-table__empty"><td colspan="6">Tidak ada transaksi yang cocok dengan filter</td></tr>';
  };

  const escapeHtml = (str) =>
    String(str ?? '').replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));

  const formatJam = (jam) => {
    // kolom `jam` tersimpan sebagai "HH:MM:SS"; pastikan format tetap
    const m = /^(\d{1,2}):(\d{1,2}):(\d{1,2})/.exec(String(jam || ''));
    if (m) return m.slice(1).map(n => n.padStart(2, '0')).join(':');
    return String(jam || '—');
  };

  const metodeBadge = (metode) => {
    const label = String(metode || 'LIAR');
    let cls = 'badge--default';
    if (label === 'CASH') cls = 'badge--tunai';
    else if (label === 'QRIS') cls = 'badge--qris';
    else if (/TRANSFER/i.test(label)) cls = 'badge--transfer';
    return `<span class="badge ${cls}">${escapeHtml(label)}</span>`;
  };

  const openModal = () => {
    modal.classList.add('is-open');
    modal.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
    if (!txLoaded) loadTransactions();
  };

  const closeModal = () => {
    modal.classList.remove('is-open');
    modal.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
  };

  const loadTransactions = async () => {
    txBody.innerHTML =
      '<tr class="tx-table__empty"><td colspan="6">Memuat data…</td></tr>';
    try {
      const resp = await fetch('/api/admin/transactions/today');
      const data = await resp.json();
      if (!resp.ok || !data.success) {
        throw new Error(data.message || 'Gagal memuat transaksi');
      }
      const rows = data.data || [];

      // Simpan ke cache lokal, lalu re-render via filter
      window.todayTransactionsCache = rows;

      modalTxCount.textContent = formatNumber(rows.length);
      modalTxTotal.textContent = formatRupiah(
        rows.reduce((sum, r) => sum + (Number(r.total) || 0), 0)
      );

      // Teks kosong saat belum ada data — pesan disesuaikan reRenderTxTable
      txLoaded = true;
      reRenderTxTable();

      // Jika cache kosong, tampilkan pesan khusus "belum ada transaksi"
      if (!rows.length) {
        txBody.innerHTML =
          '<tr class="tx-table__empty"><td colspan="6">Belum ada transaksi hari ini</td></tr>';
        countTxFiltered.textContent = '0';
        sumOmzetFiltered.textContent = 'Rp 0';
      }
    } catch (err) {
      txBody.innerHTML =
        `<tr class="tx-table__empty">
           <td colspan="6">Gagal memuat transaksi: ${escapeHtml(err.message)}</td>
         </tr>`;
    }
  };

  // Filter teks real-time & filter metode
  inputSearchTx.addEventListener('input', reRenderTxTable);
  selectFilterMetode.addEventListener('change', reRenderTxTable);

  cardTotalTx.addEventListener('click', openModal);
  btnClose.addEventListener('click', closeModal);

  // Klik di luar dialog (overlay) menutup modal
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeModal();
  });

  // ── MODAL LAPIS 2: Detail Item Transaksi ──────────────────────
  const itemModal = document.getElementById('modalItemTransaksi');
  const itemBtnClose = document.getElementById('btnCloseModalItemTx');
  const itemTxTitle = document.getElementById('modalItemTxTitle');
  const itemTxWaktu = document.getElementById('itemTxWaktu');
  const itemTxKasir = document.getElementById('itemTxKasir');
  const itemTxMetode = document.getElementById('itemTxMetode');
  const itemTxTotal = document.getElementById('itemTxTotal');
  const itemTxBayar = document.getElementById('itemTxBayar');
  const itemTxKembalian = document.getElementById('itemTxKembalian');
  const txItemsBody = document.getElementById('txItemsBody');

  const openItemModal = () => {
    itemModal.classList.add('is-open');
    itemModal.setAttribute('aria-hidden', 'false');
  };

  const closeItemModal = () => {
    itemModal.classList.remove('is-open');
    itemModal.setAttribute('aria-hidden', 'true');
  };

  const loadItemDetail = async (txId) => {
    openItemModal();
    txItemsBody.innerHTML =
      '<tr class="tx-table__empty"><td colspan="5">Memuat data…</td></tr>';
    itemTxTitle.textContent = 'Detail Belanja';
    try {
      const resp = await fetch('/api/admin/transactions/detail/' + encodeURIComponent(txId));
      const data = await resp.json();
      if (!resp.ok || !data.success) {
        throw new Error(data.message || 'Gagal memuat detail transaksi');
      }

      const h = data.header;
      const items = data.items || [];

      itemTxTitle.textContent = 'Detail Belanja - ' + (h.no_struk || '—');
      itemTxWaktu.textContent = h.waktu || '—';
      itemTxKasir.textContent = h.kasir || '—';
      itemTxMetode.innerHTML = metodeBadge(h.metode);
      itemTxTotal.textContent = formatRupiah(h.total);
      itemTxBayar.textContent = formatRupiah(h.bayar);
      itemTxKembalian.textContent = formatRupiah(h.kembalian);

      txItemsBody.innerHTML = items.length
        ? items.map((r, i) =>
            `<tr>
               <td class="col-no">${i + 1}</td>
               <td>${escapeHtml(r.nama_barang) || '—'}</td>
               <td class="col-num">${Number(r.qty) || 0}</td>
               <td class="col-num">${formatRupiah(r.harga)}</td>
               <td class="col-num">${formatRupiah(r.subtotal)}</td>
             </tr>`
          ).join('')
        : '<tr class="tx-table__empty"><td colspan="5">Tidak ada item tercatat</td></tr>';

    } catch (err) {
      txItemsBody.innerHTML =
        `<tr class="tx-table__empty">
           <td colspan="5">Gagal memuat detail: ${escapeHtml(err.message)}</td>
         </tr>`;
    }
  };

  // Delegasi klik tombol "Detail" (.btn-detail-tx) di dalam tabel
  txBody.addEventListener('click', (e) => {
    const btn = e.target.closest('.btn-detail-tx');
    if (!btn || btn.disabled) return;
    const txId = btn.getAttribute('data-tx-id');
    if (txId) loadItemDetail(txId);
  });

  itemBtnClose.addEventListener('click', closeItemModal);
  itemModal.addEventListener('click', (e) => {
    if (e.target === itemModal) closeItemModal();
  });

  // ESC tutup modal item dulu (prioritas atas modal utama)
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && itemModal.classList.contains('is-open')) {
      closeItemModal();
      return;
    }
    if (e.key === 'Escape' && modal.classList.contains('is-open')) {
      closeModal();
    }
  });

  fetchStats();
});
