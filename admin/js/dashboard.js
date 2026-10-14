/* ============================================================
   PBMS ADMIN — DASHBOARD OVERVIEW
   ============================================================ */

// Top-level helpers — needed by both DCL handlers AND bar section (outside DCL)
const escapeHtml = (str) =>
  String(str ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));

// Safe DOM event listener — top-level scope agar bisa diakses dari mana saja.
// Guard null element + hapus listener lama dulu agar tak double-bind.
function safeAddEventListener(elementId, eventType, handler) {
  const elem = typeof elementId === 'string'
    ? document.getElementById(elementId)
    : elementId;
  if (elem && typeof elem.addEventListener === 'function' && typeof handler === 'function') {
    elem.removeEventListener(eventType, handler);
    elem.addEventListener(eventType, handler);
  }
}

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

  // Safe DOM text setter — guard null agar tidak throw
  const safeSetText = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  };
  const safeSetInnerHTML = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = val;
  };

  // ── FETCH OVERVIEW STATS (Fix #59) ──────────────────────────
  // Satu fetch overview-stats, hasil di-parse 3 kali terpisah agar
  // satu field gagal tidak memacetkan field lain.
  const fetchStats = async () => {
    let data = null;
    try {
      const resp = await fetch('/api/admin/overview-stats');
      data = await resp.json();
      if (!resp.ok || !data.success) data = null;
    } catch (err) { /* handled per-block below */ }

    if (!data) {
      ['statTotalTx','statTotalPenjualan','statTotalModal','statLabaKotor',
       'statKerugianSO','statKelebihanSO','statSaldoKas','statSetoranKasir',
       'statTotalBarang','statMejaAktif'].forEach(id => safeSetText(id, '—'));
      safeSetInnerHTML('systemStatus',
        `<div class="status-row" role="listitem">
           <span class="status-dot status-dot--error" aria-hidden="true"></span>
           <span class="status-text">Gagal memuat overview-stats</span>
         </div>`);
      return;
    }

    const s = data.stats || {};
    const sys = data.system || {};

    // ── 1. Metrik utama hari ini ──
    try {
      safeSetText('statTotalTx',        formatNumber(s.totalTransaksiHariIni ?? 0));
      safeSetText('statTotalPenjualan', formatRupiah(s.totalPenjualanHariIni ?? 0));
      safeSetText('statTotalModal',     formatRupiah(s.totalModalHariIni ?? 0));
      safeSetText('statLabaKotor',      formatRupiah(s.labaKotorHariIni ?? 0));
      safeSetText('statSaldoKas',       formatRupiah(s.saldoKasLaci ?? 0));
      safeSetText('statSetoranKasir',   formatRupiah(s.totalSetoranHariIni ?? 0));
    } catch (err) {
      ['statTotalTx','statTotalPenjualan','statTotalModal','statLabaKotor',
       'statSaldoKas','statSetoranKasir'].forEach(id => safeSetText(id, '—'));
    }

    // ── 2. Stock-opname & master barang ──
    try {
      safeSetText('statKerugianSO',  formatRupiah(s.kerugianSOBulanIni ?? 0));
      safeSetText('statKelebihanSO', formatRupiah(s.kelebihanSOBulanIni ?? 0));
      safeSetText('statTotalBarang', formatNumber(s.totalMasterBarang ?? 0));
      safeSetText('statMejaAktif',   formatNumber(s.totalMejaAktif ?? 0));
    } catch (err) {
      ['statKerugianSO','statKelebihanSO','statTotalBarang','statMejaAktif']
        .forEach(id => safeSetText(id, '—'));
    }

    // ── 3. System status ──
    try {
      safeSetInnerHTML('systemStatus', [
        { label: 'Database',           ok: sys.database },
        { label: 'Server POS',         ok: sys.serverPos },
        { label: 'Jadwal Auto-Backup', ok: sys.autoBackup },
      ].map(item =>
        `<div class="status-row" role="listitem">
           <span class="status-dot ${item.ok ? 'status-dot--ok' : 'status-dot--warn'}" aria-hidden="true"></span>
           <span class="status-text">${item.label}: ${item.ok ? 'Normal' : 'Perlu dicek'}</span>
         </div>`
      ).join(''));
    } catch (err) {
      safeSetInnerHTML('systemStatus',
        `<div class="status-row" role="listitem">
           <span class="status-dot status-dot--error" aria-hidden="true"></span>
           <span class="status-text">Gagal memuat status</span>
         </div>`);
    }
  };

  // ── MODAL: Detail Transaksi Hari Ini ──────────────────────────
  const modal = document.getElementById('modalDetailTransaksi');
  const cardHeroTx = document.getElementById('cardHeroTx');
  const btnClose = document.getElementById('btnCloseModalTx');
  const txBody = document.getElementById('txTableBody');
  const modalTxCount = document.getElementById('modalTxCount');
  const modalTxTotal = document.getElementById('modalTxTotal');
  const inputSearchTx = document.getElementById('inputSearchTx');
  const selectFilterMetode = document.getElementById('selectFilterMetode');
  const inputTanggalTx = document.getElementById('inputTanggalTx');
  const countTxFiltered = document.getElementById('countTxFiltered');
  const sumOmzetFiltered = document.getElementById('sumOmzetFiltered');
  let txLoaded = false;

  const toYMD = (d) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  };

  const initDateInput = () => {
    // Set ke hari ini lokal (bukan UTC, agar sesuai zona waktu kasir)
    if (!inputTanggalTx.value) {
      inputTanggalTx.value = toYMD(new Date());
    }
  };

  // ── TAB SWITCHING (Fix #58) ─────────────────────────────
  const tabBtns = document.querySelectorAll('.tab-btn');
  const tabPanels = document.querySelectorAll('.tab-panel');
  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      tabBtns.forEach(b => {
        b.classList.remove('is-active');
        b.setAttribute('aria-selected', 'false');
      });
      tabPanels.forEach(p => p.classList.remove('is-active'));
      btn.classList.add('is-active');
      btn.setAttribute('aria-selected', 'true');
      const target = btn.getAttribute('data-tab').replace(/^tab-/, 'panel-');
      const panel = document.getElementById(target);
      if (panel) panel.classList.add('is-active');
      // (Fix #91) Refresh daftar PO saat tab Restok Barang aktif
      if (target === 'panel-restok') {
        const wLoadPo = window.__pembelianLoadPoList;
        if (typeof wLoadPo === 'function') wLoadPo();
      }
    });
  });

  // (Fix #91) Helper: aktifkan tab tertentu dari luar (burger menu).
  // Cari tombol tab yang data-tab-nya sesuai, lalu trigger click handler
  // yang sama dengan navigasi manual — agar state is-active & refresh
  // PO berjalan persis seperti saat user klik tab langsung.
  window.__activateDashboardTab = (tabName) => {
    const target = String(tabName || '').replace(/^tab-/, '');
    if (!target) return;
    const btn = document.querySelector(
      '.tab-btn[data-tab="' + target + '"]'
    );
    if (btn) btn.click();
  };

  // ── HERO SELISIH CLICK (Fix #58) — modul selisih kini di selisih.js ──
  // cardHeroSelisih kini is-hidden (Fix #83/#84). Klik pemicu tetap
  // diformalkan ke window.openSelisihModal dengan guard null-check &
  // typeof (aman bila selisih.js gagal load atau elemen tak ada).
  const cardHeroSelisih = document.getElementById('cardHeroSelisih');
  if (cardHeroSelisih) {
    cardHeroSelisih.addEventListener('click', () => {
      if (typeof window.openSelisihModal === 'function') window.openSelisihModal();
    });
  }

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

  const formatJam = (jam) => {
    if (!jam) return '—';
    // Kolom `jam` transaksi tersimpan sebagai "HH:MM:SS" → normalisasi pad
    const m = /^(\d{1,2}):(\d{1,2}):(\d{1,2})/.exec(String(jam));
    if (m) return m.slice(0, 3).map(n => n.padStart(2, '0')).join(':');
    // ISO string (sesi_meja.waktu_mulai, dsb.) → konversi ke HH:mm lokal
    const d = new Date(jam);
    if (!isNaN(d.getTime())) {
      return d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', hour12: false });
    }
    return String(jam);
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
    initDateInput();
    modal.classList.add('is-open');
    modal.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
    if (!txLoaded) loadTransactions(inputTanggalTx.value);
  };

  const closeModal = () => {
    modal.classList.remove('is-open');
    modal.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
  };

  const loadTransactions = async (dateYMD) => {
    txBody.innerHTML =
      '<tr class="tx-table__empty"><td colspan="6">Memuat data…</td></tr>';
    try {
      const d = dateYMD || inputTanggalTx.value;
      const query = d ? '?date=' + encodeURIComponent(d) : '';
      const resp = await fetch('/api/admin/transactions/today' + query);
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

  // Ganti tanggal → fetch ulang data untuk tanggal terpilih
  inputTanggalTx.addEventListener('change', () => {
    const selected = inputTanggalTx.value;
    if (!selected) return; // biarkan fallback ke hari ini
    txLoaded = true; // tidak fetch lagi saat modal dibuka
    loadTransactions(selected);
  });

  cardHeroTx.addEventListener('click', openModal);
  btnClose.addEventListener('click', closeModal);

  // Ekspos openModal ke scope window sebagai openTxModal — agar bisa
  // dipanggil dari item burger menu "Total Penjualan" (pola Fix #81/#84
  // untuk modul terpisah; di sini openModal masih dalam scope DCL).
  window.openTxModal = openModal;

  // Klik di luar dialog (overlay) menutup modal
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeModal();
  });

  // ── MODAL BARANG & KASIR — dipisah ke barang.js (Fix #87) ─────
  // Semua fungsi master barang, edit harga, dan modal kasir kini
  // di-eksport ke window oleh admin/js/barang.js. Di dashboard.js
  // cukup null-guard saat merujuk pemicu card yang sudah disembunyikan.

  // Pemicu klik card Master Barang & Kasir — card disembunyikan
  // (is-hidden di dashboard.html), tapi guard null tetap dipasang
  // agar tak ada error bila card masih ada di DOM.
  const cardTotalMasterBarang = document.getElementById('cardTotalMasterBarang');
  const cardKategoriKasir    = document.getElementById('cardKategoriKasir');
  if (cardTotalMasterBarang) {
    cardTotalMasterBarang.addEventListener('click', () => {
      if (typeof window.openBarangModal === 'function') window.openBarangModal();
    });
  }
  if (cardKategoriKasir) {
    cardKategoriKasir.addEventListener('click', () => {
      if (typeof window.openKasirModal === 'function') window.openKasirModal();
    });
  }

  // ── MODAL LAPIS 2

  // ── MODAL BARANG & KASIR — dipisah ke barang.js (Fix #87) ─────
  // Semua fungsi openBarangModal, loadMasterBarang, getMasterBarangCache,
  // openKasirModal, updateKasirCardMetrics kini di-eksport ke window
  // oleh admin/js/barang.js. Di dashboard.js cukup akses via window.

  // (Fix #53, #89) TOMBOL "Cek Stok Kritis (< 2) & Buat PO"
  // Logika inti tetap di dashboard.js (akses cache barang via window exports),
  // namun pengisian cart & pembukaan modal DELEGASIKAN sepenuhnya ke bridge
  // publik window.openPembelianForCritical di pembelian.js.
  // State internal pemCart, pembelianSetPemKategori, openPembelianModal
  // TIDAK ADAK lagi di dashboard.js — jangan diakses langsung.
  const btnKasirCekStokKritis = document.getElementById('btnKasirCekStokKritis');

  const cekStokKritisKasir = async () => {
    // Akses via window exports dari barang.js
    const wCache  = window.getMasterBarangCache || (() => []);
    const wLoad   = window.loadMasterBarang   || (async () => {});
    const wIsKasir = window.isKasir           || (() => false);

    // Ambil data (auto-fetch bila cache kosong)
    let rows = wCache();
    if (!rows.length) {
      await wLoad();
      rows = wCache();
    }

    // Filter: kategori Kasir & stok aktual < 2
    const critical = rows
      .filter(wIsKasir)
      .filter(r => (Number(r.stok) || 0) < 2);

    if (!critical.length) {
      // Tidak ada barang kritis — hentikan, tampilkan notifikasi sukses
      const kasirTableBody = document.getElementById('kasirTableBody');
      if (kasirTableBody) {
        const okRow = kasirTableBody.querySelector('[data-kasir-ok]');
        if (!okRow) {
          kasirTableBody.insertAdjacentHTML('beforeend',
            '<tr class="kasir-stock-ok" data-kasir-ok>'+
            '<td colspan="4">'+
            '✅ Semua stok barang kategori Kasir aman (stok ≥ 2 unit).'+
            '</td></tr>');
        }
      }
      return;
    }

    // Bersihkan baris sukses lama (bila pernah tampil)
    const kasirTableBody = document.getElementById('kasirTableBody');
    const oldOk = kasirTableBody && kasirTableBody.querySelector('[data-kasir-ok]');
    if (oldOk) oldOk.remove();

    // (Fix #53) Siapkan cart restok: HAPUS SEMUA isi lama,
    // is ulang hanya dengan item kritis, qty default = 10
    // HPP/HJ baru di-default ke nilai saat ini (user bisa edit di cart).
    // Gunakan bridge publik dari pembelian.js agar tidak mengakses state internal.
    const wBridge = window.openPembelianForCritical;
    if (typeof wBridge === 'function') {
      wBridge(critical);
    } else {
      // Bridge publik belum tersedia (pembelian.js gagal load).
      // Jangan mengakses state internal pemCart — tampilkan error jelas.
      console.error('[dashboard] openPembelianForCritical tidak tersedia; modul pembelian.js belum terinisialisasi.');
      alert('Gagal membuka modal pembelian: modul pembelian belum siap. Silakan muat ulang halaman.');
    }
  };

  safeAddEventListener(btnKasirCekStokKritis, 'click', cekStokKritisKasir);


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

  // ── MODAL: Detail Kerugian & Kelebihan SO + Selisih Kasir
  //    (Fix #56/#56c) — modul dipindah ke selisih.js (pola Fix #81).
  //    Di sini tinggal pemicu klik card dengan null-check + typeof
  //    (fungsi open*Modal di-eksport ke window oleh selisih.js).
  const cardKerugianSO = document.getElementById('cardKerugianSO');
  if (cardKerugianSO) cardKerugianSO.addEventListener('click', () => {
    if (typeof window.openSoModal === 'function') window.openSoModal();
  });

  const cardKelebihanSO = document.getElementById('cardKelebihanSO');
  if (cardKelebihanSO) cardKelebihanSO.addEventListener('click', () => {
    if (typeof window.openPlusModal === 'function') window.openPlusModal();
  });

  const cardSelisihKasir = document.getElementById('cardSelisihKasir');
  if (cardSelisihKasir) cardSelisihKasir.addEventListener('click', () => {
    if (typeof window.openSelisihModal === 'function') window.openSelisihModal();
  });

  // ── MODAL: Rekap Setoran & Rincian Kasir (Fix #21) — modul dipindah
  //    ke setoran.js (pola Fix #81): open/close/load/reRender/initDate,
  //    filter tanggal & search, ESC, overlay click. Di sini tinggal
  //    pemicu klik card dengan null-check (card kini is-hidden di grid).
  const cardSetoranKasir = document.getElementById('cardSetoranKasir');
  if (cardSetoranKasir) cardSetoranKasir.addEventListener('click', () => {
    if (typeof window.openSetoranModal === 'function') window.openSetoranModal();
  });

  // ── SELISIH KASIR CARD (Fix #56) — modul dipindah ke selisih.js ──
  // open/close/load/render/filter/chip/instant-cache/ESC kini di
  // selisih.js (pola Fix #81). Pemicu klik card + null-check di atas.
  // ── MODAL: Meja Aktif & Total Belanja Berjalan (Fix #22 revisi) ──
  // Menampilkan HANYA sesi AKTIF (meja sedang berjalan) beserta total
  // belanja F&B berjalan per meja (SUM dari `pesanan_meja.subtotal`).
  const mejaModal = document.getElementById('modalPendapatanMeja');
  const mejaBtnClose = document.getElementById('btnCloseModalMeja');
  const inputTanggalMeja = document.getElementById('inputTanggalMeja');
  const mejaBody = document.getElementById('mejaRevenueBody');
  const sumBelanjaBerjalan = document.getElementById('sumBelanjaBerjalan');
  const countMejaAktifModal = document.getElementById('countMejaAktifModal');
  const cardMejaAktif = document.getElementById('cardMejaAktif');
  let mejaLoaded = false;

  const openMejaModal = () => {
    initMejaDateInput();
    mejaModal.classList.add('is-open');
    mejaModal.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
    if (!mejaLoaded) loadMejaRevenue(inputTanggalMeja.value);
  };

  const closeMejaModal = () => {
    mejaModal.classList.remove('is-open');
    mejaModal.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
  };

  const initMejaDateInput = () => {
    if (!inputTanggalMeja.value) {
      inputTanggalMeja.value = toYMD(new Date());
    }
  };

  const loadMejaRevenue = async (dateYMD) => {
    mejaBody.innerHTML =
      '<tr class="tx-table__empty"><td colspan="5">Memuat data…</td></tr>';
    try {
      const d = dateYMD || inputTanggalMeja.value;
      const query = d ? '?date=' + encodeURIComponent(d) : '';
      const resp = await fetch('/api/admin/tables/revenue' + query);
      const data = await resp.json();
      if (!resp.ok || !data.success) {
        throw new Error(data.message || 'Gagal memuat meja aktif');
      }

      const summary = data.summary || {};
      sumBelanjaBerjalan.textContent = formatRupiah(data.totalBelanjaBerjalan ?? summary.totalBelanjaBerjalan ?? 0);
      countMejaAktifModal.textContent = formatNumber(data.totalMejaAktifSekarang ?? summary.totalMejaAktifSekarang ?? 0);

      const rows = data.data || [];
      mejaBody.innerHTML = rows.length
        ? rows.map(r =>
            `<tr>
               <td>${escapeHtml('Meja ' + r.nomor_meja)}</td>
               <td>${escapeHtml(r.nama_pemesan) || '—'}</td>
               <td class="time">${escapeHtml(formatJam(r.waktu_mulai))}</td>
               <td>${escapeHtml(r.total_durasi)}</td>
               <td class="col-num">${formatRupiah(r.total_pesanan)}</td>
             </tr>`
          ).join('')
        : '<tr class="tx-table__empty"><td colspan="5">Tidak ada meja aktif pada tanggal ini</td></tr>';

      mejaLoaded = true;
    } catch (err) {
      mejaBody.innerHTML =
        `<tr class="tx-table__empty">
           <td colspan="5">Gagal memuat: ${escapeHtml(err.message)}</td>
         </tr>`;
    }
  };

  cardMejaAktif.addEventListener('click', openMejaModal);
  mejaBtnClose.addEventListener('click', closeMejaModal);
  mejaModal.addEventListener('click', (e) => {
    if (e.target === mejaModal) closeMejaModal();
  });

  inputTanggalMeja.addEventListener('change', () => {
    const selected = inputTanggalMeja.value;
    if (!selected) return;
    mejaLoaded = true;
    loadMejaRevenue(selected);
  });

  // Normalisasi tampilan nomor HP (Fix #24): nomor yang masih
  // diawali '8' ditampilkan dengan awalan '0' — mencegah input baru
  // tanpa normalisasi juga terbaca konsisten.
  const formatNoHP = (no) => {
    if (!no) return '-';
    const str = String(no).trim();
    if (str.startsWith('8')) return '0' + str;
    return str;
  };

  // ── MODAL: Daftar Member (Fix #23) ───────────────
  const memberModal = document.getElementById('modalListMember');
  const memberBtnClose = document.getElementById('btnCloseModalMember');
  const inputSearchMember = document.getElementById('inputSearchMember');
  const selectFilterKategoriMember = document.getElementById('selectFilterKategoriMember');
  const selectFilterStatusMember = document.getElementById('selectFilterStatusMember');
  const sumTotalMember = document.getElementById('sumTotalMember');
  const sumMemberAktif = document.getElementById('sumMemberAktif');
  const sumMemberExpired = document.getElementById('sumMemberExpired');
  const sumMemberPelajar = document.getElementById('sumMemberPelajar');
  const sumMemberUmum = document.getElementById('sumMemberUmum');
  const sumMemberPlatinum = document.getElementById('sumMemberPlatinum');
  const statListMember = document.getElementById('statListMember');
  const memberBody = document.getElementById('memberTableBody');
  const cardListMember = document.getElementById('cardListMember');
  // Chip Platinum (Fix #28) — disembunyikan otomatis bila count = 0 agar
  // grid chip tetap simetris & tidak ada angka "0" yang menumpuk.
  const platinumChipEl = document.querySelector('.tx-chip--member-platinum');
  let memberLoaded = false;

  // ── INSTANT RENDER total member (Fix #29) ─────────────────────
  // Baca cache localStorage → render ke card SEGERA saat init
  // (0 ms delay), sebelum fetch API selesai. Setelah fetch sukses,
  // nilai real-time dituliskan ulang ke localStorage.
  const MEMBER_TOTAL_CACHE_KEY = 'pbms_cached_total_member';
  const persistMemberTotal = (freshCount) => {
    try {
      localStorage.setItem(MEMBER_TOTAL_CACHE_KEY, String(freshCount));
    } catch (e) { /* abaikan */ }
  };

  // Fallback cepat: endpoint COUNT(*) sub-ms, dipakai saat cache kosong
  // (load pertama kali / private mode / cache di-clear). Hasilnya
  // langsung di-persist agar refresh berikutnya pakai cache.
  const fetchMemberTotalFast = async () => {
    try {
      const resp = await fetch('/api/admin/member/total');
      const data = await resp.json();
      if (resp.ok && data.success && typeof data.totalMember === 'number') {
        statListMember.textContent = String(data.totalMember);
        persistMemberTotal(data.totalMember);
      }
    } catch (e) {
      /* endpoint tak tersedia (server lama) — placeholder -- tetap valid */
    }
  };

  // Jalankan SEKARANG (init blok = sudah DOM-ready) → angka cache
  // langsung tampil tanpa berkedip 0/-- .
  // Jika cache kosong, fallback ke endpoint cepat tanpa menunggu fetchMembers
  // penuh (138 baris + 2 JOIN).
  const _cachedMemberTotal = (() => {
    try { return localStorage.getItem(MEMBER_TOTAL_CACHE_KEY); } catch (e) { return null; }
  })();
  if (_cachedMemberTotal !== null) {
    statListMember.textContent = _cachedMemberTotal;
  } else {
    // Cache kosong → isi dari endpoint cepat (COUNT(*), sub-ms)
    fetchMemberTotalFast();
  }

  const memberKategoriBadge = (kategori) => {
    switch (String(kategori || '').toUpperCase()) {
      case 'PELAJAR':
        return '<span class="badge badge-member--pelajar">PELAJAR</span>';
      case 'PLATINUM':
        return '<span class="badge badge-member--platinum">&#128081; PLATINUM</span>';
      case 'UMUM':
      default:
        return '<span class="badge badge-member--umum">UMUM</span>';
    }
  };

  const openMemberModal = () => {
    memberModal.classList.add('is-open');
    memberModal.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
    if (!memberLoaded) loadMemberList();
  };

  const closeMemberModal = () => {
    memberModal.classList.remove('is-open');
    memberModal.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
  };

  const loadMemberList = async () => {
    memberBody.innerHTML =
      '<tr class="tx-table__empty"><td colspan="8">Memuat data…</td></tr>';
    try {
      const resp = await fetch('/api/admin/members');
      const data = await resp.json();
      if (!resp.ok || !data.success) {
        throw new Error(data.message || 'Gagal memuat daftar member');
      }

      // Simpan ke cache global (sedia untuk konsumsi lain di dashboard)
      window.memberCache = data.data || [];

      // Stat card: total member aktif (tanpa filter, dari response penuh)
      // + persist ke localStorage agar refresh berikutnya = INSTANT (Fix #29)
      // NOTE: gunakan data.summary.totalMember, BUKAN window.memberCache.length —
      // cache hanya memuat member yang punya transaksi (JOIN), bukan seluruh baris member.
      const freshCount = Number(data.summary?.totalMember) || (window.memberCache || []).length || 0;
      statListMember.textContent = String(freshCount);
      persistMemberTotal(freshCount);

      // Chip counter GLOBAL — selalu total penuh, tidak terpengaruh filter
      updateGlobalMemberChips();

      reRenderMemberTable();
      memberLoaded = true;
    } catch (err) {
      memberBody.innerHTML =
        `<tr class="tx-table__empty">
           <td colspan="8">Gagal memuat daftar member: ${escapeHtml(err.message)}</td>
         </tr>`;
    }
  };

  // Member status badge — AKTIF (30 hari内有交易) vs EXPIRED (Fix #60)
  const memberStatusBadge = (status) => {
    if (status === 'AKTIF') {
      return '<span class="badge badge-member--aktif">AKTIF</span>';
    }
    return '<span class="badge badge-member--expired">EXPIRED</span>';
  };

  // ── Chip summary GLOBAL — SELALU total penuh, TIDAK terpengaruh filter (Fix #65)
const updateGlobalMemberChips = () => {
  const fullList = window.memberCache || [];
  sumTotalMember.textContent = String(fullList.length);
  sumMemberAktif.textContent = String(fullList.filter(m => m.status_aktif === 'AKTIF').length);
  sumMemberExpired.textContent = String(fullList.filter(m => m.status_aktif === 'EXPIRED').length);
  sumMemberPelajar.textContent = String(fullList.filter(m => String(m.kategori || '').toUpperCase() === 'PELAJAR').length);
  sumMemberUmum.textContent = String(fullList.filter(m => String(m.kategori || '').toUpperCase() === 'UMUM').length);
  sumMemberPlatinum.textContent = String(fullList.filter(m => String(m.kategori || '').toUpperCase() === 'PLATINUM').length);
};

const reRenderMemberTable = () => {
    const rows = Array.isArray(window.memberCache)
      ? window.memberCache
      : [];
    const q = String(inputSearchMember.value || '').trim().toLowerCase();
    const kategori = selectFilterKategoriMember.value; // 'ALL' = semua
    const status = selectFilterStatusMember.value; // 'ALL' | 'AKTIF' | 'EXPIRED'

    const filtered = rows.filter(r => {
      const matchKategori = kategori === 'ALL'
        || String(r.kategori || '').toUpperCase() === kategori;
      const matchStatus = status === 'ALL'
        || String(r.status_aktif || '').toUpperCase() === status;
      const matchCari = !q
        || String(r.nama || '').toLowerCase().includes(q)
        || String(r.kode_member || '').toLowerCase().includes(q)
        || String(r.nomor_hp || '').toLowerCase().includes(q);
      return matchKategori && matchStatus && matchCari;
    });

    // Sinkronkan highlight chip dengan status filter saat ini
    syncChipFilter();

    memberBody.innerHTML = filtered.length
      ? filtered.map(r =>
          `<tr>
             <td class="col-member">
               <strong>${escapeHtml(r.nama)}</strong>
               <span class="member-kode">${escapeHtml(r.kode_member)}</span>
             </td>
             <td>${escapeHtml(formatNoHP(r.nomor_hp))}</td>
             <td>${memberKategoriBadge(r.kategori)}</td>
             <td>${memberStatusBadge(r.status_aktif)}</td>
             <td class="col-num">${r.total_kunjungan} kali</td>
             <td class="col-num">${formatRupiah(r.total_belanja)}</td>
             <td class="time">${escapeHtml(r.last_transaksi)}</td>
             <td class="col-aksi">
               <div class="member-action-group">
                 ${r.status_aktif === 'EXPIRED'
                   ? `<button type="button" class="btn-activate-member"
                         data-member-id="${r.id}"
                         data-member-nama="${escapeHtml(r.nama)}"
                         aria-label="Aktifkan ${escapeHtml(r.nama)}">⚡</button>`
                   : ''}
                 <button type="button" class="btn-edit-member"
                         data-member-id="${r.id}"
                         data-member-nama="${escapeHtml(r.nama)}"
                         data-member-hp="${escapeHtml(formatNoHP(r.nomor_hp))}"
                         data-member-kategori="${escapeHtml(r.kategori)}"
                         aria-label="Edit ${escapeHtml(r.nama)}">✏️</button>
                 <button type="button" class="btn-member-delete"
                         data-member-id="${r.id}"
                         data-member-kode="${escapeHtml(r.kode_member)}"
                         data-member-nama="${escapeHtml(r.nama)}"
                         aria-label="Hapus member ${escapeHtml(r.nama)} (${escapeHtml(r.kode_member)})">
                 <svg viewBox="0 0 24 24" aria-hidden="true">
                   <polyline points="3 6 5 6 21 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                   <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                   <path d="M10 11v6M14 11v6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                   <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                 </svg>
                 </button>
               </div>
             </td>
           </tr>`
        ).join('')
      : '<tr class="tx-table__empty"><td colspan="8">Tidak ada member yang cocok dengan filter</td></tr>';
  };

  // Hapus member: konfirmasi presisi (Nama & Kode) → DELETE → refresh
  // cache + stat card + chips real-time (Fix #27)
  const handleDeleteMemberClick = async (e) => {
    const btn = e.target.closest('.btn-member-delete');
    if (!btn) return;
    const id = Number(btn.dataset.memberId);
    const kode = btn.dataset.memberKode || '';
    const nama = btn.dataset.memberNama || '';
    if (!id) return;

    const konfirmasi = window.confirm(
      `Hapus member:\n\n  Nama: ${nama}\n  Kode: ${kode}\n\n` +
      `Riwayat transaksi/omzet historis TIDAK akan terhapus — hanya ` +
      `data member ini yang dihapus.\n\nLanjutkan?`
    );
    if (!konfirmasi) return;

    try {
      const resp = await fetch('/api/admin/member/' + id, { method: 'DELETE' });
      const data = await resp.json();
      if (!resp.ok || !data.success) {
        throw new Error(data.message || 'Gagal menghapus member');
      }

      // 1. Hapus dari cache lokal (tanpa re-fetch penuh)
      window.memberCache = (window.memberCache || []).filter(
        r => Number(r.id) !== id
      );
      // 2. Perbarui stat card (total member tanpa filter)
      // Gunakan window.memberCache.length setelah filter (setelah delete), bukan length lama.
      statListMember.textContent = String(Math.max(0, (window.memberCache || []).length - 1));
      // 3. Re-render tabel + chips mengikuti filter aktif
      reRenderMemberTable();
      // 4. Info sukses singkat
      window.alert(data.message);
    } catch (err) {
      window.alert('Gagal menghapus member: ' + err.message);
    }
  };

  // ── Handle Activate Member (Fix #60) ──────────────────────────
  const handleActivateMemberClick = async (e) => {
    const btn = e.target.closest('.btn-activate-member');
    if (!btn) return;
    const id = Number(btn.dataset.memberId);
    const nama = btn.dataset.memberNama || '';
    if (!id || !nama) return;

    const konfirmasi = window.confirm(
      `Aktifkan kembali member ${nama}?`
    );
    if (!konfirmasi) return;

    try {
      const resp = await fetch('/api/admin/member/' + id + '/activate', { method: 'POST' });
      const data = await resp.json();
      if (!resp.ok || !data.success) throw new Error(data.message || 'Gagal mengaktifkan');
      // Update cache lokal tanpa re-fetch penuh
      const idx = (window.memberCache || []).findIndex(m => m.id === id);
      if (idx !== -1) {
        window.memberCache[idx].status_aktif = 'AKTIF';
      }
      reRenderMemberTable();
      window.alert(data.message);
    } catch (err) {
      window.alert('Gagal mengaktifkan member: ' + err.message);
    }
  };

  // ── Handle Edit Member (Fix #60) ────────────────────────────────
  const modalEditMember = document.getElementById('modalEditMember');
  const btnCloseModalEditMember = document.getElementById('btnCloseModalEditMember');
  const formEditMember = document.getElementById('formEditMember');
  const editMemberId = document.getElementById('editMemberId');
  const editMemberNama = document.getElementById('editMemberNama');
  const editMemberNoHp = document.getElementById('editMemberNoHp');
  const editMemberKategori = document.getElementById('editMemberKategori');
  const btnBatalEditMember = document.getElementById('btnBatalEditMember');

  const openEditMemberModal = (member) => {
    editMemberId.value = String(member.id);
    editMemberNama.value = member.nama;
    editMemberNoHp.value = member.nomor_hp || '';
    editMemberKategori.value = String(member.kategori || 'UMUM').toUpperCase();
    modalEditMember.classList.add('is-open');
    modalEditMember.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
  };

  const closeEditMemberModal = () => {
    modalEditMember.classList.remove('is-open');
    modalEditMember.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
    formEditMember.reset();
  };

  formEditMember.addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = Number(editMemberId.value);
    const nama = editMemberNama.value.trim();
    const noHp = editMemberNoHp.value.trim();
    const kategori = editMemberKategori.value;
    if (!id || !nama || !kategori) {
      window.alert('Nama dan kategori wajib diisi.');
      return;
    }
    try {
      const resp = await fetch('/api/admin/member/' + id, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nama, no_hp: noHp, kategori }),
      });
      const data = await resp.json();
      if (!resp.ok || !data.success) throw new Error(data.message || 'Gagal memperbarui member');
      // Update cache lokal
      const idx = (window.memberCache || []).findIndex(m => m.id === id);
      if (idx !== -1) {
        window.memberCache[idx].nama = nama;
        window.memberCache[idx].nomor_hp = noHp;
        window.memberCache[idx].kategori = kategori;
      }
      closeEditMemberModal();
      reRenderMemberTable();
      window.alert(data.message);
    } catch (err) {
      window.alert('Gagal memperbarui member: ' + err.message);
    }
  });

  btnCloseModalEditMember.addEventListener('click', closeEditMemberModal);
  btnBatalEditMember.addEventListener('click', closeEditMemberModal);
  modalEditMember.addEventListener('click', (e) => {
    if (e.target === modalEditMember) closeEditMemberModal();
  });

  // Delegate di tbody (tombol di-re-render setiap filter berubah)
  memberBody.addEventListener('click', (e) => {
    if (e.target.closest('.btn-activate-member')) {
      handleActivateMemberClick(e);
    } else if (e.target.closest('.btn-edit-member')) {
      const btn = e.target.closest('.btn-edit-member');
      const id = Number(btn.dataset.memberId);
      const member = (window.memberCache || []).find(m => m.id === id);
      if (member) openEditMemberModal(member);
    } else {
      handleDeleteMemberClick(e);
    }
  });

  inputSearchMember.addEventListener('input', reRenderMemberTable);
  selectFilterKategoriMember.addEventListener('change', reRenderMemberTable);
  selectFilterStatusMember.addEventListener('change', reRenderMemberTable);

  // ── Chip filter interaktif (Fix #64) ────────────────────────────
  // Klik chip → sinkronkan value <select> filter → refresh tabel
  const syncChipFilter = () => {
    const chips = document.querySelectorAll('#chipFilterTotal,#chipFilterAktif,#chipFilterExpired,#chipFilterPelajar,#chipFilterUmum,#chipFilterPlatinum');
    chips.forEach(chip => {
      const kat = chip.dataset.filterKategori || 'ALL';
      const st = chip.dataset.filterStatus || 'ALL';
      const isActive = selectFilterKategoriMember.value === kat && selectFilterStatusMember.value === st;
      chip.classList.toggle('is-active', isActive);
    });
  };

  const applyChipFilter = (chip) => {
    const kat = chip.dataset.filterKategori || 'ALL';
    const st = chip.dataset.filterStatus || 'ALL';
    selectFilterKategoriMember.value = kat;
    selectFilterStatusMember.value = st;
    syncChipFilter();
    reRenderMemberTable();
  };

  document.addEventListener('click', (e) => {
    const chip = e.target.closest('.tx-chip--clickable');
    if (chip) applyChipFilter(chip);
  });
  // Support keyboard Enter/Space
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      const chip = e.target.closest('.tx-chip--clickable');
      if (chip) { e.preventDefault(); applyChipFilter(chip); }
    }
  });

  // Sinkronisasi chip saat user mengubah dropdown filter manual
  const refreshChipHighlight = () => { syncChipFilter(); };
  selectFilterKategoriMember.addEventListener('change', refreshChipHighlight);
  selectFilterStatusMember.addEventListener('change', refreshChipHighlight);
  cardListMember.addEventListener('click', openMemberModal);
  memberBtnClose.addEventListener('click', closeMemberModal);
  memberModal.addEventListener('click', (e) => {
    if (e.target === memberModal) closeMemberModal();
  });

  // ── MODAL QRIS: pemicu card (modul penuh di qris.js) ─────────
  // Pemeriksaan aman: hanya panggil bila qris.js berhasil load & export.
  const cardQrisHistory = document.getElementById('cardQrisHistory');
  if (cardQrisHistory) cardQrisHistory.addEventListener('click', () => {
    if (typeof window.openQrisModal === 'function') window.openQrisModal();
  });

  // ESC: tutup modal yang paling atas dulu (z-index tertinggi → terendah):
  // qrisHistory (1000, qris.js) / setoranKasir (1000, setoran.js) /
  // selisihKasir & kerugianSO & kelebihanSO (1000, selisih.js) →
  // listMember (700) → barang (400) → meja (300) → item (200) → utama
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && memberModal.classList.contains('is-open')) {
      closeMemberModal();
      return;
    }
    if (e.key === 'Escape' && mejaModal.classList.contains('is-open')) {
      closeMejaModal();
      return;
    }
    if (e.key === 'Escape' && itemModal.classList.contains('is-open')) {
      closeItemModal();
      return;
    }
    if (e.key === 'Escape' && modal.classList.contains('is-open')) {
      closeModal();
      return;
    }
  });

  fetchStats();
  // (Populate card QRIS kini dilakukan qris.js saat file dimuat — Fix #32)

  // ── GRAFIK TREN PENJUALAN (Fix #33) — modul dipindah ke penjualan.js ─
  // Render/tooltip/fetch/cache instant kini di penjualan.js (pola Fix #81).
  // HPP chart tetap di sini; bridge re-render tab-aktif & resize dari
  // penjualan.js memanggil hook window di bawah.

  // ── GRAFIK FLUKTUASI HPP VS HARGA JUAL + MARGIN WARNING (Fix #47) ──
  const HPP_CHART_CACHE_KEY = 'pbms_cached_hpp_trend';
  const hppCanvas         = document.getElementById('hppTrendChart');
  const hppCanvasWrap     = document.getElementById('hppCanvasWrap');
  const hppTooltip        = document.getElementById('hppChartTooltip');
  const hppTooltipDate    = document.getElementById('hppTooltipDate');
  const hppTooltipHpp     = document.getElementById('hppTooltipHpp');
  const hppTooltipHj      = document.getElementById('hppTooltipHj');
  const selectHppKategori = document.getElementById('selectHppKategori');
  const selectHppBarang   = document.getElementById('selectHppBarang');
  const btnRefreshHppChart= document.getElementById('btnRefreshHppChart');
  const hppAvgMargin      = document.getElementById('hppAvgMargin');
  const hppMinMargin      = document.getElementById('hppMinMargin');
  let hppDataCache = null;   // { series, items, margin_warning, kategori }
  let hppKategoriFilter = '';
  let hppBarangFilter = '';

  const loadHppChartCache = () => {
    try {
      const raw = localStorage.getItem(HPP_CHART_CACHE_KEY);
      if (!raw) return null;
      const p = JSON.parse(raw);
      return (p && Array.isArray(p.series)) ? p : null;
    } catch (e) { return null; }
  };
  const persistHppChartCache = (payload) => {
    try { localStorage.setItem(HPP_CHART_CACHE_KEY, JSON.stringify(payload)); }
    catch (e) { /* private mode */ }
  };

  // HPP chart meta untuk hover (Fix #40 pattern: listener di-bind satu kali)
  let _hppMeta    = { points: [], wrapW: 800, padL: 60, padT: 16, chartH: 200 };

  const renderHppTrendChart = (data) => {
    if (!hppCanvas) return;
    const series = data.series || [];
    const n = series.length;
    const canvas = hppCanvas;
    const dpr = window.devicePixelRatio || 1;
    const wrapW = canvas.parentElement ? canvas.parentElement.clientWidth : 800;
    const H = 260;
    canvas.width  = wrapW * dpr;
    canvas.height = H * dpr;
    canvas.style.width  = wrapW + 'px';
    canvas.style.height = H + 'px';
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, wrapW, H);

    if (!n) {
      ctx.fillStyle = '#475569';
      ctx.font = '13px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Belum ada histori pembelian', wrapW / 2, H / 2);
      _hppMeta = { points: [], wrapW, padL: 0, padT: 0, chartH: 0 };
      return;
    }

    const padL = 60, padR = 20, padT = 16, padB = 40;
    const chartW = wrapW - padL - padR;
    const chartH = H - padT - padB;
    const allVals = series.flatMap(s => [s.hpp || 0, s.harga_jual || 0]);
    const maxVal = Math.max(1, ...allVals);

    // Grid
    const gridLines = 4;
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= gridLines; i++) {
      const y = padT + (chartH / gridLines) * i;
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(wrapW - padR, y); ctx.stroke();
    }

    // X positions
    const xStep = n > 1 ? chartW / (n - 1) : 0;
    const xOf = (i) => padL + (n > 1 ? i * xStep : chartW / 2);
    const yOf = (val) => padT + chartH - (maxVal > 0 ? (val / maxVal) * chartH : 0);

    _hppMeta.points = series.map((s, i) => ({
      x: xOf(i), yHpp: yOf(s.hpp || 0), yHj: yOf(s.harga_jual || 0), i,
    }));
    _hppMeta = { ..._hppMeta, points: _hppMeta.points, wrapW, padL, padT, chartH, xStep, n,
                 labels: series.map(s => s.tanggal || ''), data: series };

    // Margin area (warna merah pucat di antara garis HPP & Harga Jual)
    ctx.beginPath();
    series.forEach((s, i) => {
      const x = xOf(i);
      const yHj = yOf(s.harga_jual || 0);
      if (i === 0) ctx.moveTo(x, yHj); else ctx.lineTo(x, yHj);
    });
    for (let i = series.length - 1; i >= 0; i--) {
      const x = xOf(i);
      ctx.lineTo(x, yOf(series[i].hpp || 0));
    }
    ctx.closePath();
    ctx.fillStyle = 'rgba(16, 185, 129, 0.08)';
    ctx.fill();

    // Garis Harga Jual (cyan)
    ctx.beginPath();
    series.forEach((s, i) => {
      const x = xOf(i), y = yOf(s.harga_jual || 0);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = 'rgba(0, 210, 255, 0.9)';
    ctx.lineWidth = 2;
    ctx.stroke();
    // titik harga jual
    series.forEach((s, i) => {
      const x = xOf(i), y = yOf(s.harga_jual || 0);
      ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(0, 210, 255, 1)'; ctx.fill();
    });

    // Garis HPP (amber)
    ctx.beginPath();
    series.forEach((s, i) => {
      const x = xOf(i), y = yOf(s.hpp || 0);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = 'rgba(251, 191, 36, 0.9)';
    ctx.lineWidth = 2;
    ctx.stroke();
    series.forEach((s, i) => {
      const x = xOf(i), y = yOf(s.hpp || 0);
      ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(251, 191, 36, 1)'; ctx.fill();
    });

    // Label X
    ctx.fillStyle = '#94a3b8';
    ctx.font = '10px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const labelStep = Math.max(1, Math.ceil(n / Math.floor(chartW / 80)));
    for (let i = 0; i < n; i += labelStep) {
      ctx.fillText(series[i].tanggal || '', xOf(i), padT + chartH + 8);
    }
    // Label Y
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let i = 0; i <= gridLines; i++) {
      const y = padT + (chartH / gridLines) * i;
      const val = maxVal - (maxVal / gridLines) * i;
      const label = val >= 1000000
        ? (val / 1000000).toFixed(1).replace(/\.0$/, '') + 'jt'
        : val >= 1000 ? Math.round(val / 1000) + 'rb' : String(Math.round(val));
      ctx.fillStyle = '#64748b';
      ctx.font = '10px system-ui, sans-serif';
      ctx.fillText(label, padL - 8, y);
    }
  };

  // Tooltip hover — di-bind SATU KALI (pola Fix #40)
  safeAddEventListener(hppCanvas, 'mousemove', (e) => {
    if (!hppTooltip || !_hppMeta.points.length) return;
    const { points, labels, data, wrapW, padT, chartH, n } = _hppMeta;
    const rect = hppCanvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    // Cari titik terdekat (n < 100, O(n) aman)
    let hit = null, bestDist = Infinity;
    for (const p of points) {
      const dist = Math.abs(p.x - mx);
      if (dist < bestDist) { bestDist = dist; hit = p; }
    }
    if (hit && bestDist < 40) {
      const s = data[hit.i] || {};
      hppTooltipDate.textContent  = labels[hit.i] || '';
      hppTooltipHpp.textContent   = 'HPP ' + formatRupiah(s.hpp || 0);
      hppTooltipHj.textContent    = 'HJ ' + formatRupiah(s.harga_jual || 0);
      const tipW = 150;
      const tx = Math.max(0, Math.min(wrapW - tipW, hit.x - tipW / 2));
      hppTooltip.style.left = tx + 'px';
      hppTooltip.style.top  = '4px';
      hppTooltip.classList.add('is-visible');
    } else {
      hppTooltip.classList.remove('is-visible');
    }
  });
  safeAddEventListener(hppCanvas, 'mouseleave', () => {
    if (hppTooltip) hppTooltip.classList.remove('is-visible');
  });

  const populateHppFilters = (data) => {
    const categories = data.categories || [];
    const items = data.items || [];

    // Kategori dropdown
    if (selectHppKategori) {
      const cur = selectHppKategori.value;
      selectHppKategori.innerHTML =
        '<option value="">Semua Kategori</option>' +
        categories.map(k => `<option value="${escapeHtml(k)}">${escapeHtml(k)}</option>`).join('');
      selectHppKategori.value = cur;
    }

    // Barang dropdown (filter ikut kategori aktif)
    if (selectHppBarang) {
      const filtered = hppKategoriFilter
        ? items.filter(i => String(i.kategori || '').toUpperCase() === hppKategoriFilter)
        : items;
      const cur = selectHppBarang.value;
      selectHppBarang.innerHTML =
        '<option value="">Semua Barang</option>' +
        filtered.map(i => `<option value="${i.id}">${escapeHtml(i.nama_barang || i.kode_barang)}</option>`).join('');
      if (cur && filtered.find(i => String(i.id) === cur)) {
        selectHppBarang.value = cur;
      } else {
        selectHppBarang.value = '';
      }
    }
  };

  const loadHppChart = async (kateri, barang) => {
    hppKategoriFilter = String(kateri || '').toUpperCase();
    hppBarangFilter   = String(barang || '');
    const params = new URLSearchParams();
    if (hppKategoriFilter) params.set('kategori', hppKategoriFilter);
    if (hppBarangFilter)   params.set('barang_id', hppBarangFilter);
    try {
      const resp = await fetch('/api/admin/pembelian/trend-hpp?' + params.toString());
      const data = await resp.json();
      if (!resp.ok || !data.success) throw new Error(data.message || 'Gagal memuat');
      hppDataCache = data;
      populateHppFilters(data);
      renderHppTrendChart(data);
      persistHppChartCache(data);
    } catch (err) {
      console.warn('Gagal memuat fluktuasi HPP:', err.message);
    }
  };

  // Event listeners filter
  safeAddEventListener(selectHppKategori, 'change', () => {
    hppKategoriFilter = selectHppKategori ? selectHppKategori.value : '';
    loadHppChart(hppKategoriFilter, '');
  });
  safeAddEventListener(selectHppBarang, 'change', () => {
    hppBarangFilter = selectHppBarang ? selectHppBarang.value : '';
    loadHppChart(hppKategoriFilter, hppBarangFilter);
  });
  safeAddEventListener(btnRefreshHppChart, 'click', () => {
    loadHppChart(hppKategoriFilter, hppBarangFilter);
  });

  // Init: cache instant + fetch
  (function initHppChart() {
    // Populate kategori dari master barang yang sudah di-load
    const wCache = typeof window.getMasterBarangCache === 'function' ? window.getMasterBarangCache : () => [];
    const categories = wCache().map(r => r.kategori).filter(Boolean);
    const uniqueCats = [...new Set(categories)].sort();
    if (selectHppKategori) {
      selectHppKategori.innerHTML =
        '<option value="">Semua Kategori</option>' +
        uniqueCats.map(k => `<option value="${escapeHtml(k)}">${escapeHtml(k)}</option>`).join('');
    }
    const cached = loadHppChartCache();
    if (cached) {
      hppDataCache = cached;
      renderHppTrendChart(cached);
    }
    loadHppChart('', '');
  })();

  // ── Bridge hook untuk penjualan.js (modul grafik penjualan) ──
  // Resize + re-render tab-aktif di penjualan.js memanggil hook ini
  // untuk juga me-render ulang HPP chart (data cache-nya milik modul ini).
  window.__renderHppChartOnResize = () => {
    if (hppDataCache) renderHppTrendChart(hppDataCache);
  };
  window.__renderHppChartOnTabActivate = () => {
    if (hppDataCache) renderHppTrendChart(hppDataCache);
  };

  // Re-render kedua grafik saat tab Keuangan ditampilkan kembali
  // (Fix #58) — penjualan.js memanggil window.__salesReRenderChart;
  // HPP chart turut di-re-render lewat hook di atas.
  const tabBtnKeuangan = document.querySelector('[data-tab="tab-keuangan"]');
  if (tabBtnKeuangan) {
    tabBtnKeuangan.addEventListener('click', () => {
      if (typeof window.__salesReRenderChart === 'function') window.__salesReRenderChart();
      else if (hppDataCache) renderHppTrendChart(hppDataCache);
    });
  }


  // ── PURCHASE CART / RESTOK BARANG & PO MANAGEMENT — dipisah ke pembelian.js (Fix #89) ──
  // Semua fungsi pembelian kini di-eksport ke window oleh admin/js/pembelian.js.

  // ── Modul Bar Bahan Mentah dipisah ke
  //     admin/js/bar-bahan-mentah.js dan halaman mandiri
  //     admin/bar-bahan-mentah.html — akses via burger menu
  //     #burgerBtnBarBahanMentah. Tab & panel lama dihapus.
  //     Jangan definisi ulang fungsi Bar di sini.

  // ── DAPUR Raw Materials (Fix #75) ──────────────────────────────
  const formDapurMaterial = document.getElementById('formDapurMaterial');
  const dapurMaterialBody = document.getElementById('dapurMaterialBody');
  const dapurTotalItems = document.getElementById('dapurTotalItems');
  const dapurLowStock = document.getElementById('dapurLowStock');

  let dapurMaterialsCache = [];
  let dapurSelectedId = null;
  let dapurSearchTimeout = null;

  const formatDapurRupiah = (n) => {
    if (!n && n !== 0) return 'Rp 0';
    return 'Rp ' + Number(n).toLocaleString('id-ID');
  };

  const loadDapurMaterials = async () => {
    try {
      const resp = await fetch('/api/admin/dapur/raw-materials');
      const data = await resp.json();
      if (!data.success) throw new Error(data.message || 'Gagal memuat');
      dapurMaterialsCache = data.data || [];
      renderDapurMaterials();
    } catch (err) {
      dapurMaterialBody.innerHTML = '<tr><td colspan="8" class="text-center">Gagal memuat: ' + escapeHtml(err.message) + '</td></tr>';
    }
  };

  const renderDapurMaterials = () => {
    const items = dapurMaterialsCache;
    dapurTotalItems.textContent = String(items.length);
    dapurLowStock.textContent = String(items.filter(m => (m.stok || 0) < 10).length);
    if (!items.length) {
      dapurMaterialBody.innerHTML = '<tr><td colspan="8" class="text-center">Belum ada bahan mentah dapur</td></tr>';
      return;
    }
    dapurMaterialBody.innerHTML = items.map(m => {
      const isLow = (m.stok || 0) < 10;
      return '<tr>' +
        '<td><code>' + escapeHtml(String(m.kode_barang || '')) + '</code></td>' +
        '<td><strong>' + escapeHtml(String(m.nama_barang || '')) + '</strong></td>' +
        '<td class="col-num' + (isLow ? ' bar-low-stock' : '') + '">' + Number(m.stok || 0).toLocaleString('id-ID', {minimumFractionDigits: 2, maximumFractionDigits: 2}) + '</td>' +
        '<td>' + escapeHtml(String(m.satuan || '')) + '</td>' +
        '<td class="col-num">' + formatDapurRupiah(m.harga_per_satuan) + '</td>' +
        '<td class="col-num">' + formatDapurRupiah(Number(m.stok || 0) * Number(m.harga_per_satuan || 0)) + '</td>' +
        '<td>' + escapeHtml(String(m.updated_at || '')) + '</td>' +
        '<td><button type="button" class="btn btn-danger btn-sm" data-dapur-delete="' + escapeHtml(String(m.kode_barang)) + '">Hapus</button></td>' +
        '</tr>';
    }).join('');
    dapurMaterialBody.querySelectorAll('[data-dapur-delete]').forEach(btn => {
      btn.addEventListener('click', () => deleteDapurMaterial(btn.dataset.dapurDelete));
    });
  };

  // ── Dapur Form: Search & Auto-fill ──────────────────────────────
  const dapurNamaInput = document.getElementById('dapurNama');
  const dapurNamaList = document.getElementById('dapurNamaList');
  const dapurNamaResult = document.getElementById('dapurNamaResult');
  const dapurKodeInput = document.getElementById('dapurKode');
  const dapurSatuanSelect = document.getElementById('dapurSatuan');
  const dapurStokLabel = document.getElementById('dapurStokLabel');
  const dapurHargaInput = document.getElementById('dapurHarga');
  const btnDapurSubmit = document.getElementById('btnDapurSubmit');

  const setupDapurForm = () => {
    if (!dapurNamaInput || !dapurNamaList) return;

    const formatDapurHargaInput = (val) => {
      const clean = String(val).replace(/[^\d]/g, '');
      if (!clean) return '';
      return clean.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    };

    const refreshDapurDatalist = () => {
      dapurNamaList.innerHTML = dapurMaterialsCache.map(m =>
        '<option value="' + escapeHtml(String(m.nama_barang)) + '">'
      ).join('');
    };

    dapurHargaInput.addEventListener('input', () => {
      const raw = dapurHargaInput.value;
      const formatted = formatDapurHargaInput(raw);
      if (formatted !== raw) dapurHargaInput.value = formatted;
    });
    dapurHargaInput.addEventListener('paste', (e) => {
      setTimeout(() => {
        const formatted = formatDapurHargaInput(dapurHargaInput.value);
        if (formatted) dapurHargaInput.value = formatted;
      }, 0);
    });

    dapurNamaInput.addEventListener('input', () => {
      dapurSelectedId = null;
      dapurSatuanSelect.disabled = false;
      dapurKodeInput.value = '';
      dapurKodeInput.style.opacity = '';
      dapurStokLabel.textContent = 'Stok Tambah';
      btnDapurSubmit.textContent = '+ Tambah Bahan Dapur';

      clearTimeout(dapurSearchTimeout);
      dapurSearchTimeout = setTimeout(() => {
        const query = String(dapurNamaInput.value).trim().toLowerCase();
        if (!query) { dapurNamaResult.innerHTML = ''; return; }
        const matches = dapurMaterialsCache.filter(m =>
          String(m.nama_barang).toLowerCase().includes(query)
        );
        if (!matches.length) {
          dapurNamaResult.innerHTML = '<div class="bar-search-none">Tidak ditemukan — ketik nama baru</div>';
          return;
        }
        dapurNamaResult.innerHTML = matches.map(m =>
          '<div class="bar-search-item" data-id="' + m.id + '" data-nama="' + escapeHtml(String(m.nama_barang)) + '" data-satuan="' + escapeHtml(String(m.satuan)) + '" data-harga="' + (m.harga_per_satuan || 0) + '">' +
            '<strong>' + escapeHtml(String(m.nama_barang)) + '</strong>' +
            ' — Stok: <b>' + Number(m.stok || 0).toFixed(2) + ' ' + escapeHtml(String(m.satuan)) + '</b>' +
            ' | ' + formatDapurRupiah(m.harga_per_satuan) + '/satuan' +
          '</div>'
        ).join('');
        dapurNamaResult.querySelectorAll('.bar-search-item').forEach(el => {
          el.addEventListener('click', () => {
            dapurSelectedId = Number(el.dataset.id);
            dapurNamaInput.value = el.dataset.nama;
            dapurNamaResult.innerHTML = '';
            dapurSatuanSelect.value = el.dataset.satuan;
            dapurSatuanSelect.disabled = true;
            dapurHargaInput.value = formatDapurHargaInput(el.dataset.harga);
            dapurKodeInput.value = '— Sudah ada';
            dapurKodeInput.style.opacity = '0.6';
            dapurStokLabel.textContent = 'Tambah Stok (Restok)';
            btnDapurSubmit.textContent = '✓ Restok';
          });
        });
      }, 200);
    });

    dapurNamaInput.addEventListener('blur', () => {
      setTimeout(() => { dapurNamaResult.innerHTML = ''; }, 200);
    });

    refreshDapurDatalist();
  };

  const resetDapurForm = () => {
    dapurSelectedId = null;
    dapurKodeInput.value = '';
    dapurKodeInput.style.opacity = '';
    dapurSatuanSelect.value = 'g';
    dapurSatuanSelect.disabled = false;
    dapurStokLabel.textContent = 'Stok Tambah';
    btnDapurSubmit.textContent = '+ Tambah Bahan Dapur';
    dapurNamaInput.value = '';
    dapurNamaResult.innerHTML = '';
    document.getElementById('dapurStok').value = '0';
    dapurHargaInput.value = '';
  };

  const addDapurMaterial = async (e) => {
    if (e && typeof e.preventDefault === 'function') e.preventDefault();
    const nama = String(document.getElementById('dapurNama').value).trim();
    const satuan = document.getElementById('dapurSatuan').value;
    const stok = parseFloat(document.getElementById('dapurStok').value) || 0;
    const hargaRaw = String(document.getElementById('dapurHarga').value).replace(/\./g, '');
    const harga = parseFloat(hargaRaw) || 0;
    if (!nama) { alert('Nama bahan wajib diisi.'); return; }
    if (!satuan) { alert('Satuan wajib dipilih.'); return; }
    if (stok < 0) { alert('Stok tidak boleh negatif.'); return; }
    try {
      const resp = await fetch('/api/admin/dapur/raw-materials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nama_barang: nama, stok, satuan, harga_per_satuan: harga, id: dapurSelectedId || null })
      });
      const data = await resp.json();
      if (!data.success) throw new Error(data.message || 'Gagal simpan');
      if (data.mode === 'new') {
        alert('Bahan baru berhasil: ' + data.kode_barang + ' — ' + nama);
      } else {
        alert(data.message || 'Stok berhasil ditambahkan.');
      }
      resetDapurForm();
      await loadDapurMaterials();
      if (setupDapurForm) setupDapurForm();
    } catch (err) { alert('Gagal tambah bahan: ' + err.message); }
  };

  async function deleteDapurMaterial(kode) {
    if (!confirm('Hapus bahan ' + kode + '?')) return;
    try {
      const resp = await fetch('/api/admin/dapur/raw-materials', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kode_barang: kode })
      });
      const data = await resp.json();
      if (!data.success) throw new Error(data.message || 'Gagal hapus');
      await loadDapurMaterials();
    } catch (err) {
      alert('Gagal hapus bahan: ' + err.message);
    }
  }

  safeAddEventListener('formDapurMaterial', 'submit', addDapurMaterial);
  if (setupDapurForm) setupDapurForm();

  const tabBtnDapur = document.querySelector('[data-tab="tab-dapur"]');
  if (tabBtnDapur) {
    tabBtnDapur.addEventListener('click', () => {
      if (!dapurMaterialsCache.length) loadDapurMaterials();
    });
  }

  // ── BURGER MENU / DRAWER NAVIGATION ─────────────────────────
  // Berdiri sendiri: tak menyentuh listener modal/chart yang ada.
  // Pola sama dengan drawer bank (Fix #41): overlay .active toggle
  // pointer-events, tutup TANPA delay setTimeout (CSS transition
  // menangani animasi, layer langsung hilang dari hit-test).
  const burgerDrawer  = document.getElementById('burgerDrawer');
  const burgerOverlay = document.getElementById('burgerOverlay');

  function openBurgerDrawer() {
    if (!burgerDrawer) return;
    burgerDrawer.classList.add('active');
    if (burgerOverlay) {
      burgerOverlay.classList.add('active');
      burgerOverlay.setAttribute('aria-hidden', 'false');
    }
    const btnToggleBurger = document.getElementById('btnToggleBurger');
    if (btnToggleBurger) btnToggleBurger.setAttribute('aria-expanded', 'true');
  }

  function closeBurgerDrawer() {
    if (!burgerDrawer) return;
    burgerDrawer.classList.remove('active');
    if (burgerOverlay) {
      burgerOverlay.classList.remove('active');
      burgerOverlay.setAttribute('aria-hidden', 'true');
    }
    const btnToggleBurger = document.getElementById('btnToggleBurger');
    if (btnToggleBurger) btnToggleBurger.setAttribute('aria-expanded', 'false');
  }

  safeAddEventListener('btnToggleBurger', 'click', openBurgerDrawer);
  safeAddEventListener('btnCloseBurger', 'click', closeBurgerDrawer);
  safeAddEventListener('burgerOverlay', 'click', closeBurgerDrawer);

  // ESC menutup burger drawer (hanya jika sedang terbuka)
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && burgerDrawer && burgerDrawer.classList.contains('active')) {
      closeBurgerDrawer();
    }
  });

  // Item burger "Saldo Bank" (Fix #79): tutup drawer → buka #modalSaldoBank
  // (fungsi openBankModal sudah ada di blok SALDO BANK, baris ~2784;
  //  tak disentuh — kalkulasi saldo/riwayat/mutasi berjalan normal).
  const burgerBtnSaldoBank = document.getElementById('burgerBtnSaldoBank');
  safeAddEventListener(burgerBtnSaldoBank, 'click', () => {
    closeBurgerDrawer();
    if (typeof openBankModal === 'function') openBankModal();
  });

  // Item burger "Saldo Kas Laci": tutup drawer → buka #modalKasLaci
  // (fungsi openKasModal ada di kas.js).
  const burgerBtnSaldoKas = document.getElementById('burgerBtnSaldoKas');
  safeAddEventListener(burgerBtnSaldoKas, 'click', () => {
    closeBurgerDrawer();
    if (typeof openKasModal === 'function') openKasModal();
  });

  // Item burger "Pencatatan QRIS": tutup drawer → buka #modalQrisHistory
  // (fungsi openQrisModal di-eksport ke window oleh qris.js, Fix #81;
  //  cekaman typeof aman bila qris.js gagal load).
  safeAddEventListener('burgerBtnQris', 'click', () => {
    closeBurgerDrawer();
    if (typeof window.openQrisModal === 'function') window.openQrisModal();
  });

  // Item burger "Rekap Setoran": tutup drawer → buka #modalSetoranKasir
  // (fungsi openSetoranModal di-eksport ke window oleh setoran.js,
  //  pola Fix #81; cekaman typeof aman bila setoran.js gagal load).
  safeAddEventListener('burgerBtnSetoran', 'click', () => {
    closeBurgerDrawer();
    if (typeof window.openSetoranModal === 'function') window.openSetoranModal();
  });

  // Item burger "Selisih Kasir": tutup drawer → buka #modalSelisihKasir
  // (fungsi openSelisihModal di-eksport ke window oleh selisih.js,
  //  pola Fix #81; cekaman typeof aman bila selisih.js gagal load).
  safeAddEventListener('burgerBtnSelisih', 'click', () => {
    closeBurgerDrawer();
    if (typeof window.openSelisihModal === 'function') window.openSelisihModal();
  });

  // Item burger "Total Penjualan": tutup drawer → buka modal rincian
  // transaksi hari ini (#modalDetailTransaksi) — openTxModal = alias
  // openModal yang di-eksport ke window oleh blok modal transaksi di
  // atas (cekaman typeof ganda: window dulu, lalu scope lokal sebagai
  // fallback bila eksport belum terpasang).
  safeAddEventListener('burgerBtnPenjualan', 'click', () => {
    closeBurgerDrawer();
    if (typeof window.openTxModal === 'function') {
      window.openTxModal();
    } else if (typeof openTxModal === 'function') {
      openTxModal();
    }
  });

  // Item burger "Master Barang": tutup drawer → buka #modalMasterBarang
  // (fungsi openBarangModal di-eksport ke window oleh barang.js,
  //  pola Fix #87).
  safeAddEventListener('burgerBtnBarang', 'click', () => {
    closeBurgerDrawer();
    if (typeof window.openBarangModal === 'function') window.openBarangModal();
  });

  // Item burger "Barang Kasir": tutup drawer → buka #modalKasir
  // (fungsi openKasirModal di-eksport ke window oleh barang.js,
  //  pola Fix #87).
  safeAddEventListener('burgerBtnKasir', 'click', () => {
    closeBurgerDrawer();
    if (typeof window.openKasirModal === 'function') window.openKasirModal();
  });

  // Item burger "Mines SO": tutup drawer → buka #modalKerugianSO
  // (fungsi openSoModal di-eksport ke window oleh selisih.js,
  //  pola Fix #86).
  safeAddEventListener('burgerBtnKerugianSO', 'click', () => {
    closeBurgerDrawer();
    if (typeof window.openSoModal === 'function') window.openSoModal();
  });

  // Item burger "Plus SO": tutup drawer → buka #modalKelebihanSO
  // (fungsi openPlusModal di-eksport ke window oleh selisih.js,
  //  pola Fix #86).
  safeAddEventListener('burgerBtnKelebihanSO', 'click', () => {
    closeBurgerDrawer();
    if (typeof window.openPlusModal === 'function') window.openPlusModal();
  });

  // Item burger "Restok Barang" (Fix #91): tutup drawer → aktifkan
  // tab "Restok Barang" (panel-restok) + buka modal Cart Restok.
  // Navigasi tab memakai helper window.__activateDashboardTab agar
  // state is-active dan refresh daftar PO ikut berjalan.
  safeAddEventListener('burgerBtnRestok', 'click', () => {
    closeBurgerDrawer();
    if (typeof window.__activateDashboardTab === 'function') {
      window.__activateDashboardTab('tab-restok');
    }
    if (typeof window.openPembelianModal === 'function') {
      window.openPembelianModal();
    }
  });

  // Item burger "Pembelian Bank" (Fix #95): tutup drawer → buka halaman
  // khusus pembelian-bank.html (panel lama dihapus dari dashboard).
  safeAddEventListener('burgerBtnPembelianBank', 'click', () => {
    closeBurgerDrawer();
    window.location.href = 'pembelian-bank.html';
  });

  // Item burger "Bar — Bahan Mentah": tutup drawer → buka halaman
  // khusus bar-bahan-mentah.html (panel lama dihapus dari dashboard).
  safeAddEventListener('burgerBtnBarBahanMentah', 'click', () => {
    closeBurgerDrawer();
    window.location.href = 'bar-bahan-mentah.html';
  });
});
