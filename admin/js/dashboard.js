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

  // ── SAFE EVENT LISTENER (Fix #40) ────────────────────────────
  // Guard null element agar tidak throw dan menghentikan seluruh
  // init chain. Dipakai untuk listener kritis yang elemen DOM-nya
  // bisa tak ada (modular build, conditional render, race condition).
  const safeAddEventListener = (elementId, eventType, handler) => {
    const elem = typeof elementId === 'string'
      ? document.getElementById(elementId)
      : elementId;
    if (elem && typeof handler === 'function') {
      elem.addEventListener(eventType, handler);
    }
  };

  // ── FETCH OVERVIEW STATS ─────────────────────────────────────
  const fetchStats = async () => {
    const statTotalTx = document.getElementById('statTotalTx');
    const statTotalPenjualan = document.getElementById('statTotalPenjualan');
    const statTotalModal = document.getElementById('statTotalModal');
    const statLabaKotor = document.getElementById('statLabaKotor');
    const statKerugianSO = document.getElementById('statKerugianSO');
    const statKelebihanSO = document.getElementById('statKelebihanSO');
    const statSaldoKas = document.getElementById('statSaldoKas');
    const statSetoranKasir = document.getElementById('statSetoranKasir');
    const statTotalBarang = document.getElementById('statTotalBarang');
    const statMejaAktif = document.getElementById('statMejaAktif');
    const systemStatus = document.getElementById('systemStatus');

    try {
      const resp = await fetch('/api/admin/overview-stats');
      const data = await resp.json();

      if (!resp.ok || !data.success) {
        throw new Error(data.message || 'Gagal memuat data');
      }

      const s = data.stats || {};
      const sys = data.system || {};

      // Guard: pastikan angka ter-render walau satu field null/undefined
      statTotalTx.textContent = formatNumber(s.totalTransaksiHariIni ?? 0);
      statTotalPenjualan.textContent = formatRupiah(s.totalPenjualanHariIni ?? 0);
      statTotalModal.textContent = formatRupiah(s.totalModalHariIni ?? 0);
      statLabaKotor.textContent = formatRupiah(s.labaKotorHariIni ?? 0);
      statKerugianSO.textContent = formatRupiah(s.kerugianSOBulanIni ?? 0);
      statKelebihanSO.textContent = formatRupiah(s.kelebihanSOBulanIni ?? 0);
      statSaldoKas.textContent = formatRupiah(s.saldoKasLaci ?? 0);
      statSetoranKasir.textContent = formatRupiah(s.totalSetoranHariIni ?? 0);
      statTotalBarang.textContent = formatNumber(s.totalMasterBarang ?? 0);
      statMejaAktif.textContent = formatNumber(s.totalMejaAktif ?? 0);

      // System status rows — akses dari `data.system`, bukan `s.system`
      // (bug lama: `s` = data.stats tidak punya properti `system` → crash
      //  catch → semua stat card menampilkan '—')
      systemStatus.innerHTML = [
        { label: 'Database', ok: sys.database },
        { label: 'Server POS', ok: sys.serverPos },
        { label: 'Jadwal Auto-Backup', ok: sys.autoBackup },
      ].map(item =>
        `<div class="status-row" role="listitem">
           <span class="status-dot ${item.ok ? 'status-dot--ok' : 'status-dot--warn'}" aria-hidden="true"></span>
           <span class="status-text">${item.label}: ${item.ok ? 'Normal' : 'Perlu dicek'}</span>
         </div>`
      ).join('');

    } catch (err) {
      // Graceful error state
      statTotalTx.textContent = '—';
      statTotalPenjualan.textContent = '—';
      statTotalModal.textContent = '—';
      statLabaKotor.textContent = '—';
      statKerugianSO.textContent = '—';
      statKelebihanSO.textContent = '—';
      statSaldoKas.textContent = '—';
      statSetoranKasir.textContent = '—';
      statTotalBarang.textContent = '—';
      statMejaAktif.textContent = '—';

      systemStatus.innerHTML =
        `<div class="status-row" role="listitem">
           <span class="status-dot status-dot--error" aria-hidden="true"></span>
           <span class="status-text">Gagal memuat: ${err.message}</span>
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

  cardTotalTx.addEventListener('click', openModal);
  btnClose.addEventListener('click', closeModal);

  // Klik di luar dialog (overlay) menutup modal
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeModal();
  });

  // ── MODAL: Daftar Master Barang & Stok Terkini ─────────────────
  const barangModal = document.getElementById('modalMasterBarang');
  const barangBtnClose = document.getElementById('btnCloseModalBarang');
  const inputSearchBarang = document.getElementById('inputSearchBarang');
  const selectFilterKategoriBarang = document.getElementById('selectFilterKategoriBarang');
  const countJenisBarang = document.getElementById('countJenisBarang');
  const sumStokBarang = document.getElementById('sumStokBarang');
  const sumNilaiAsetBarang = document.getElementById('sumNilaiAsetBarang');
  const barangBody = document.getElementById('barangTableBody');
  const cardTotalMasterBarang = document.getElementById('cardTotalMasterBarang');
  let barangLoaded = false;

  const openBarangModal = () => {
    barangModal.classList.add('is-open');
    barangModal.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
    if (!barangLoaded) loadMasterBarang();
  };

  const closeBarangModal = () => {
    barangModal.classList.remove('is-open');
    barangModal.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
  };

  // Cache level modul — sinkron dengan window.masterBarangCache (expose ke
  // window agar bisa dicek via browser console & dipakai modul lain).
  let masterBarangCache = Array.isArray(window.masterBarangCache)
    ? window.masterBarangCache
    : [];
  let loadMasterBarangPromise = null;

  let loadMasterBarang = async () => {
    // Dedupe: bila sudah ada fetch sedang berjalan, tunggu hasilnya —
    // mencegah double-fetch saat modal kasir dibuka cepat berulang kali.
    if (loadMasterBarangPromise) return loadMasterBarangPromise;

    loadMasterBarangPromise = (async () => {
      barangBody.innerHTML =
        '<tr class="tx-table__empty"><td colspan="7">Memuat data…</td></tr>';
      try {
        const resp = await fetch('/api/admin/inventory/master');
        const data = await resp.json();
        if (!resp.ok || !data.success) {
          throw new Error(data.message || 'Gagal memuat master barang');
        }

        const items = Array.isArray(data.data) ? data.data : [];

        // Simpan response ke cache — variabel modul (source of truth)
        // sekaligus window (untuk inspeksi console / modul lain).
        masterBarangCache = items;
        window.masterBarangCache = items;

        const categories = data.categories || [];
        selectFilterKategoriBarang.innerHTML =
          '<option value="">Semua Kategori</option>' +
          categories.map(k =>
            `<option value="${escapeHtml(k)}">${escapeHtml(k)}</option>`
          ).join('');

        barangLoaded = true;
        reRenderBarangTable();
        updateKasirCardMetrics();
      } catch (err) {
        barangBody.innerHTML =
          `<tr class="tx-table__empty">
             <td colspan="7">Gagal memuat master barang: ${escapeHtml(err.message)}</td>
           </tr>`;
      } finally {
        loadMasterBarangPromise = null;
      }
    })();

    return loadMasterBarangPromise;
  };

  const getMasterBarangCache = () =>
    Array.isArray(masterBarangCache) && masterBarangCache.length
      ? masterBarangCache
      : (Array.isArray(window.masterBarangCache) ? window.masterBarangCache : []);

  const reRenderBarangTable = () => {
    const rows = getMasterBarangCache();
    const q = String(inputSearchBarang.value || '').trim().toLowerCase();
    const kategori = selectFilterKategoriBarang.value; // '' = semua

    const filtered = rows.filter(r => {
      const matchKategori = !kategori || String(r.kategori || '') === kategori;
      const matchCari = !q
        || String(r.nama_barang || '').toLowerCase().includes(q)
        || String(r.kode_barang || '').toLowerCase().includes(q);
      return matchKategori && matchCari;
    });

    // Update stat chips ringkasan (mengikuti filter)
    countJenisBarang.textContent = formatNumber(filtered.length);
    sumStokBarang.textContent = formatNumber(
      filtered.reduce((s, r) => s + (Number(r.stok) || 0), 0)
    );
    sumNilaiAsetBarang.textContent = formatRupiah(
      filtered.reduce((s, r) =>
        s + (Number(r.stok) || 0) * (Number(r.harga_modal) || 0), 0)
    );

    const stokBadge = (stok) =>
      Number(stok) <= 5
        ? '<span class="badge badge-stok--nipis">Peringatan</span>'
        : '<span class="badge badge-stok--aman">Aman</span>';

    // Render baris tabel
    barangBody.innerHTML = filtered.length
      ? filtered.map(r =>
          `<tr>
             <td class="num">${escapeHtml(r.kode_barang) || String(r.id) || '—'}</td>
             <td>${escapeHtml(r.nama_barang) || '—'}</td>
             <td>${escapeHtml(r.kategori) || '—'}</td>
             <td class="col-num">${formatRupiah(r.harga_modal)}</td>
             <td class="col-num">${formatRupiah(r.harga_jual)}</td>
             <td class="col-num">${formatNumber(r.stok)}</td>
             <td>${stokBadge(r.stok)}</td>
           </tr>`
        ).join('')
      : '<tr class="tx-table__empty"><td colspan="7">Tidak ada barang yang cocok dengan filter</td></tr>';
  };

  inputSearchBarang.addEventListener('input', reRenderBarangTable);
  selectFilterKategoriBarang.addEventListener('change', reRenderBarangTable);
  cardTotalMasterBarang.addEventListener('click', openBarangModal);
  barangBtnClose.addEventListener('click', closeBarangModal);
  barangModal.addEventListener('click', (e) => {
    if (e.target === barangModal) closeBarangModal();
  });

  // ── KARTU KATEGORI KASIR + MODAL DAFTAR BARANG KASIR ──────────
  // Hitung agregat kategori KASIR dari masterBarangCache, tampilkan
  // di stat card. Klik card → buka modal tabel barang kasir.
  const cardKategoriKasir  = document.getElementById('cardKategoriKasir');
  const statKasirJenis     = document.getElementById('statKasirJenis');
  const statKasirStok      = document.getElementById('statKasirStok');
  const statKasirModal     = document.getElementById('statKasirModal');
  const statKasirJual      = document.getElementById('statKasirJual');

  const modalKasir       = document.getElementById('modalKasir');
  const btnCloseModalKasir = document.getElementById('btnCloseModalKasir');
  const kasirTableBody   = document.getElementById('kasirTableBody');
  const kasirCountJenis  = document.getElementById('kasirCountJenis');
  const kasirSumStok     = document.getElementById('kasirSumStok');
  const kasirSumModal    = document.getElementById('kasirSumModal');
  const kasirSumJual     = document.getElementById('kasirSumJual');

  // Kategori yang dianggap "Kasir" di level POS:
  //  - KASIR  : item counter (minuman, korek, snack, dsb.)
  //  - ROKOK  : rokok dijual di counter kasir
  //  - BONUS  : bonus/cashback item dicatat di kasir
  // Pembanding flexible: trim + case-insensitive, toleransi spasi ganda.
  const KASIR_KATEGORI = ['kasir', 'rokok', 'bonus'];
  const isKasir = (r) => {
    const k = String(r.kategori || '').trim().toLowerCase().replace(/\s+/g, ' ');
    return KASIR_KATEGORI.includes(k);
  };

  // (Fix #52) updateKasirCardMetrics & loadKasirTable sekarang ASYNC —
  // bila cache kosong, auto-fetch via loadMasterBarang() dulu sebelum
  // me-render. Ini menghilangkan "0 item / Belum ada barang" saat
  // dashboard dibuka sebelum master barang ter-load.
  const updateKasirCardMetrics = async () => {
    let rows = getMasterBarangCache();
    if (!rows.length) {
      await loadMasterBarang();
      rows = getMasterBarangCache();
    }

    const kasirItems = rows.filter(isKasir);
    const totalJenis = kasirItems.length;
    const totalStok = kasirItems.reduce((s, r) => s + (Number(r.stok) || 0), 0);
    const totalModal = kasirItems.reduce((s, r) =>
      s + (Number(r.stok) || 0) * (Number(r.harga_modal) || 0), 0);
    const totalJual = kasirItems.reduce((s, r) =>
      s + (Number(r.stok) || 0) * (Number(r.harga_jual) || 0), 0);

    if (statKasirJenis) statKasirJenis.textContent = formatNumber(totalJenis);
    if (statKasirStok)  statKasirStok.textContent  = formatNumber(totalStok);
    if (statKasirModal) statKasirModal.textContent = formatRupiah(totalModal);
    if (statKasirJual)  statKasirJual.textContent  = formatRupiah(totalJual);

    // Simpan ke chip di modal (siap tampil tanpa reload)
    if (kasirCountJenis) kasirCountJenis.textContent = formatNumber(totalJenis);
    if (kasirSumStok)    kasirSumStok.textContent    = formatNumber(totalStok);
    if (kasirSumModal)   kasirSumModal.textContent   = formatRupiah(totalModal);
    if (kasirSumJual)    kasirSumJual.textContent    = formatRupiah(totalJual);
  };

  // (Fix #52) loadKasirTable async — auto-fetch bila cache kosong
  const loadKasirTable = async () => {
    let rows = getMasterBarangCache().filter(isKasir);
    if (!rows.length) {
      await loadMasterBarang();
      rows = getMasterBarangCache().filter(isKasir);
      // Perbarui chip metrik juga agar konsisten
      await updateKasirCardMetrics();
    }

    if (!rows.length) {
      if (kasirTableBody) kasirTableBody.innerHTML =
        '<tr class="tx-table__empty"><td colspan="4">Belum ada barang kategori Kasir.</td></tr>';
      return;
    }

    if (kasirTableBody) kasirTableBody.innerHTML = rows.map(r =>
      `<tr>
         <td>${escapeHtml(r.nama_barang) || '—'}</td>
         <td class="col-num">${formatNumber(r.stok)}</td>
         <td class="col-num">${formatRupiah(r.harga_modal)}</td>
         <td class="col-num">${formatRupiah(r.harga_jual)}</td>
       </tr>`
    ).join('');
  };

  const openKasirModal = async () => {
    if (kasirTableBody) kasirTableBody.innerHTML =
      '<tr class="tx-table__empty"><td colspan="4">Memuat data…</td></tr>';
    modalKasir.classList.add('is-open');
    modalKasir.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
    await loadKasirTable(); // auto-fetch bila perlu; render tabel
  };
  const closeKasirModal = () => {
    modalKasir.classList.remove('is-open');
    modalKasir.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
  };

  // Inisialisasi — cache bisa sudah terisi (halaman dibuka ulang /
  // fetch lain sudah jalan) atau masih kosong; updateKasirCardMetrics
  // akan auto-fetch bila perlu.
  updateKasirCardMetrics();

  // (Fix #53) TOMBOL "Cek Stok Kritis (< 2) & Buat PO"
  // Baca cache → filter kategori Kasir & stok riil < 2 → bila kosong:
  // alert sukses; bila ada: kosongkan pemCart, is ulang qty=10, buka
  // modal Pembelian (tab KASIR aktif).
  const btnKasirCekStokKritis = document.getElementById('btnKasirCekStokKritis');

  const cekStokKritisKasir = async () => {
    // Ambil data (auto-fetch bila cache kosong)
    let rows = getMasterBarangCache();
    if (!rows.length) {
      await loadMasterBarang();
      rows = getMasterBarangCache();
    }

    // Filter: kategori Kasir & stok aktual < 2
    // (stok riil = `stok` di cache, sesuai field `inventory/master`)
    const critical = rows
      .filter(isKasir)
      .filter(r => (Number(r.stok) || 0) < 2);

    if (!critical.length) {
      // Tidak ada barang kritis — hentikan, tampilkan notifikasi sukses
      if (kasirTableBody) {
        const okRow = kasirTableBody.querySelector('[data-kasir-ok]');
        if (!okRow) {
          kasirTableBody.insertAdjacentHTML('beforeend',
            '<tr class="kasir-stock-ok" data-kasir-ok>' +
            '<td colspan="4">' +
            '✅ Semua stok barang kategori Kasir aman (stok ≥ 2 unit).' +
            '</td></tr>');
        }
      }
      return;
    }

    // Bersihkan baris sukses lama (bila pernah tampil)
    const oldOk = kasirTableBody && kasirTableBody.querySelector('[data-kasir-ok]');
    if (oldOk) oldOk.remove();

    // (Fix #53) Siapkan cart restok: HAPUS SEMUA isi lama,
    // is ulang hanya dengan item kritis, qty default = 10
    // HPP/HJ baru di-default ke nilai saat ini (user bisa edit di cart).
    pemCart = [];
    critical.forEach(item => {
      pemCart.push({
        barang_id: item.id,
        nama: item.nama_barang || '',
        stok: Number(item.stok) || 0,
        kategori: 'KASIR', // semua item kritis = kategori Kasir
        hpp_lama: item.harga_modal || 0,
        hj_lama:  item.harga_jual  || 0,
        hpp_baru: item.harga_modal || 0,
        hj_baru:  item.harga_jual  || 0,
        qty: 10, // qty beli default per item
      });
    });

    // Pindah ke tab KASIR & buka modal Pembelian
    setPemKategori('KASIR');
    openPembelianModal();
  };

  if (cardKategoriKasir) cardKategoriKasir.addEventListener('click', openKasirModal);
  if (btnCloseModalKasir) btnCloseModalKasir.addEventListener('click', closeKasirModal);
  if (modalKasir) modalKasir.addEventListener('click', (e) => {
    if (e.target === modalKasir) closeKasirModal();
  });
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

  // ── MODAL: Detail Kerugian Stock Opname (Barang Minus) ──────────
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

  const toYM = (d) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    return `${y}-${m}`;
  };

  const initSoMonthInput = () => {
    if (!inputBulanKerugianSO.value) {
      inputBulanKerugianSO.value = toYM(new Date());
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
      countProdukMinus.textContent = formatNumber(data.summary ? data.summary.totalJenisBarangMinus : 0);
      sumUnitMinus.textContent = formatNumber(data.summary ? data.summary.totalUnitMinus : 0);
      sumNominalKerugian.textContent = formatRupiah(data.summary ? data.summary.totalNominalKerugian : 0);

      reRenderSoLossTable();
      soLoaded = true;
    } catch (err) {
      kerugianBody.innerHTML =
        `<tr class="tx-table__empty">
           <td colspan="8">Gagal memuat kerugian SO: ${escapeHtml(err.message)}</td>
         </tr>`;
    }
  };

  const reRenderSoLossTable = () => {
    const rows = Array.isArray(window.kerugianSOCache)
      ? window.kerugianSOCache
      : [];
    const q = String(inputSearchKerugianSO.value || '').trim().toLowerCase();

    const filtered = rows.filter(r => {
      return !q
        || String(r.nama_barang || '').toLowerCase().includes(q)
        || String(r.kode_barang || '').toLowerCase().includes(q);
    });

    // Update stat chips ringkasan (mengikuti filter pencarian)
    countProdukMinus.textContent = formatNumber(filtered.length);
    sumUnitMinus.textContent = formatNumber(
      filtered.reduce((s, r) => s + (Number(r.qty_minus) || 0), 0)
    );
    sumNominalKerugian.textContent = formatRupiah(
      filtered.reduce((s, r) => s + (Number(r.total_kerugian) || 0), 0)
    );

    kerugianBody.innerHTML = filtered.length
      ? filtered.map(r =>
          `<tr>
             <td class="num">${escapeHtml(r.kode_barang) || String(r.id_barang) || '—'}</td>
             <td>${escapeHtml(r.nama_barang) || '—'}</td>
             <td>${escapeHtml(r.kategori) || '—'}</td>
             <td class="col-num">${formatNumber(r.stok_sistem)}</td>
             <td class="col-num">${formatNumber(r.stok_fisik)}</td>
             <td class="col-num selisih-minus">-${formatNumber(r.qty_minus)}</td>
             <td class="col-num">${formatRupiah(r.hpp)}</td>
             <td class="col-num total-kerugian">${formatRupiah(r.total_kerugian)}</td>
           </tr>`
        ).join('')
      : '<tr class="tx-table__empty"><td colspan="8">Tidak ada barang minus untuk bulan ini</td></tr>';
  };

  inputSearchKerugianSO.addEventListener('input', reRenderSoLossTable);
  cardKerugianSO.addEventListener('click', openSoModal);
  soBtnClose.addEventListener('click', closeSoModal);
  soModal.addEventListener('click', (e) => {
    if (e.target === soModal) closeSoModal();
  });

  // Ganti bulan → fetch ulang data untuk bulan terpilih.
  // soLoaded di-set false dulu supaya openSoModal tak skip load saat
  // fetch-nya berjalan (loadSoLosses menyet flag-nya balik saat sukses).
  inputBulanKerugianSO.addEventListener('change', () => {
    const selected = inputBulanKerugianSO.value;
    if (!selected) return;
    soLoaded = false;
    loadSoLosses(selected);
  });

  // ── MODAL: Detail Kelebihan Stock Opname (Barang Plus) ──────────
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
      inputBulanKelebihanSO.value = toYM(new Date());
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
           <td colspan="8">Gagal memuat kelebihan SO: ${escapeHtml(err.message)}</td>
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
    countProdukPlus.textContent = formatNumber(filtered.length);
    sumUnitPlus.textContent = formatNumber(
      filtered.reduce((s, r) => s + (Number(r.qty_plus) || 0), 0)
    );
    sumNominalPlus.textContent = formatRupiah(
      filtered.reduce((s, r) => s + (Number(r.total_nilai_plus) || 0), 0)
    );

    kelebihanBody.innerHTML = filtered.length
      ? filtered.map(r =>
          `<tr>
             <td class="num">${escapeHtml(r.kode_barang) || String(r.id_barang) || '—'}</td>
             <td>${escapeHtml(r.nama_barang) || '—'}</td>
             <td>${escapeHtml(r.kategori) || '—'}</td>
             <td class="col-num">${formatNumber(r.stok_sistem)}</td>
             <td class="col-num">${formatNumber(r.stok_fisik)}</td>
             <td class="col-num selisih-plus">+${formatNumber(r.qty_plus)}</td>
             <td class="col-num">${formatRupiah(r.hpp)}</td>
             <td class="col-num total-nilai-plus">${formatRupiah(r.total_nilai_plus)}</td>
           </tr>`
        ).join('')
      : '<tr class="tx-table__empty"><td colspan="8">Tidak ada barang plus untuk bulan ini</td></tr>';
  };

  // Stat card "Kelebihan SO Bulan Ini" — buka modal kelebihan secara
  // langsung, tanpa perlu lewat modal kerugian
  document.getElementById('cardKelebihanSO').addEventListener('click', openPlusModal);

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

  // ── MODAL: Riwayat Kas Laci (Uang Masuk & Keluar) ──────────────
  const kasModal = document.getElementById('modalKasLaci');
  const kasBtnClose = document.getElementById('btnCloseModalKas');
  const inputStartDateKas = document.getElementById('inputStartDateKas');
  const inputEndDateKas = document.getElementById('inputEndDateKas');
  const selectTipeKas = document.getElementById('selectTipeKas');
  const inputSearchKas = document.getElementById('inputSearchKas');
  const sumKasMasuk = document.getElementById('sumKasMasuk');
  const sumKasKeluar = document.getElementById('sumKasKeluar');
  const sumNetKas = document.getElementById('sumNetKas');
  const kasBody = document.getElementById('kasTableBody');
  const cardSaldoKas = document.getElementById('cardSaldoKas');
  let kasLoaded = false;

  const kasMonthStartYMD = () => {
    const n = new Date();
    return n.getFullYear() + '-' + String(n.getMonth() + 1).padStart(2, '0') + '-01';
  };

  const initKasDateInputs = () => {
    if (!inputStartDateKas.value) {
      inputStartDateKas.value = kasMonthStartYMD();
    }
    if (!inputEndDateKas.value) {
      inputEndDateKas.value = toYMD(new Date());
    }
  };

  const openKasModal = () => {
    initKasDateInputs();
    kasModal.classList.add('is-open');
    kasModal.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
    if (!kasLoaded) loadKasFlow();
  };

  const closeKasModal = () => {
    kasModal.classList.remove('is-open');
    kasModal.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
  };

  const loadKasFlow = async () => {
    kasBody.innerHTML =
      '<tr class="tx-table__empty"><td colspan="5">Memuat data…</td></tr>';
    try {
      const s = inputStartDateKas.value || kasMonthStartYMD();
      const e = inputEndDateKas.value || toYMD(new Date());
      const query = `?startDate=${encodeURIComponent(s)}&endDate=${encodeURIComponent(e)}`;
      const resp = await fetch('/api/admin/cash-flow' + query);
      const data = await resp.json();
      if (!resp.ok || !data.success) {
        throw new Error(data.message || 'Gagal memuat riwayat kas');
      }

      window.kasLaciCache = data.data || [];

      // Chip ringkasan mengikuti summary dari API (rentang terpilih,
      // semua tipe — bukan hasil filter UI)
      const summary = data.summary || {};
      sumKasMasuk.textContent = formatRupiah(summary.totalKasMasuk ?? 0);
      sumKasKeluar.textContent = formatRupiah(summary.totalKasKeluar ?? 0);
      sumNetKas.textContent = formatRupiah(summary.netKasPeriod ?? 0);

      reRenderKasTable();
      kasLoaded = true;
    } catch (err) {
      kasBody.innerHTML =
        `<tr class="tx-table__empty">
           <td colspan="5">Gagal memuat riwayat kas: ${escapeHtml(err.message)}</td>
         </tr>`;
    }
  };

  const kasTipeBadge = (tipe) =>
    tipe === 'MASUK'
      ? '<span class="badge badge-kas--masuk">Masuk</span>'
      : '<span class="badge badge-kas--keluar">Keluar</span>';

  const reRenderKasTable = () => {
    const rows = Array.isArray(window.kasLaciCache)
      ? window.kasLaciCache
      : [];
    const q = String(inputSearchKas.value || '').trim().toLowerCase();
    const tipe = selectTipeKas.value; // 'ALL' = semua

    const filtered = rows.filter(r => {
      const matchTipe = tipe === 'ALL' || r.tipe === tipe;
      const matchCari = !q
        || String(r.keterangan || '').toLowerCase().includes(q)
        || String(r.kasir || '').toLowerCase().includes(q);
      return matchTipe && matchCari;
    });

    kasBody.innerHTML = filtered.length
      ? filtered.map(r =>
          `<tr>
             <td class="time">${escapeHtml(formatJam(r.waktu))}</td>
             <td>${kasTipeBadge(r.tipe)}</td>
             <td class="col-ket">${escapeHtml(r.keterangan) || '—'}</td>
             <td>${escapeHtml(r.kasir) || '—'}</td>
             <td class="col-num kas-nominal--${r.tipe === 'MASUK' ? 'masuk' : 'keluar'}">
               ${r.tipe === 'MASUK' ? '+' : '−'}${formatRupiah(r.nominal)}
             </td>
           </tr>`
        ).join('')
      : '<tr class="tx-table__empty"><td colspan="5">Tidak ada riwayat kas untuk tanggal ini</td></tr>';
  };

  inputSearchKas.addEventListener('input', reRenderKasTable);
  selectTipeKas.addEventListener('change', reRenderKasTable);
  cardSaldoKas.addEventListener('click', openKasModal);
  kasBtnClose.addEventListener('click', closeKasModal);
  kasModal.addEventListener('click', (e) => {
    if (e.target === kasModal) closeKasModal();
  });

  // Ganti rentang tanggal → fetch ulang riwayat kas untuk rentang terpilih
  inputStartDateKas.addEventListener('change', () => {
    if (!inputStartDateKas.value) return;
    kasLoaded = false;
    loadKasFlow();
  });
  inputEndDateKas.addEventListener('change', () => {
    if (!inputEndDateKas.value) return;
    kasLoaded = false;
    loadKasFlow();
  });

  // ── MODAL: Rekap Setoran & Rincian Kasir (Fix #21) ───────────────
  const setoranModal = document.getElementById('modalSetoranKasir');
  const setoranBtnClose = document.getElementById('btnCloseModalSetoran');
  const inputTanggalSetoran = document.getElementById('inputTanggalSetoran');
  const inputSearchSetoran = document.getElementById('inputSearchSetoran');
  const sumSetoranTunai = document.getElementById('sumSetoranTunai');
  const sumNonTunai = document.getElementById('sumNonTunai');
  const sumTotalOmzet = document.getElementById('sumTotalOmzet');
  const setoranBody = document.getElementById('setoranTableBody');
  const cardSetoranKasir = document.getElementById('cardSetoranKasir');
  let setoranLoaded = false;

  const initSetoranDateInput = () => {
    if (!inputTanggalSetoran.value) {
      inputTanggalSetoran.value = toYMD(new Date());
    }
  };

  const openSetoranModal = () => {
    initSetoranDateInput();
    setoranModal.classList.add('is-open');
    setoranModal.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
    if (!setoranLoaded) loadSetoranKasir(inputTanggalSetoran.value);
  };

  const closeSetoranModal = () => {
    setoranModal.classList.remove('is-open');
    setoranModal.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
  };

  const loadSetoranKasir = async (dateYMD) => {
    setoranBody.innerHTML =
      '<tr class="tx-table__empty"><td colspan="6">Memuat data…</td></tr>';
    try {
      const d = dateYMD || inputTanggalSetoran.value;
      const query = d ? '?date=' + encodeURIComponent(d) : '';
      const resp = await fetch('/api/admin/cashier-deposits' + query);
      const data = await resp.json();
      if (!resp.ok || !data.success) {
        throw new Error(data.message || 'Gagal memuat rekap setoran');
      }

      // Simpan ke cache global (sedia untuk konsumsi lain di dashboard)
      window.setoranKasirCache = data.data || [];

      reRenderSetoranTable();
      setoranLoaded = true;
    } catch (err) {
      setoranBody.innerHTML =
        `<tr class="tx-table__empty">
           <td colspan="6">Gagal memuat rekap setoran: ${escapeHtml(err.message)}</td>
         </tr>`;
    }
  };

  const reRenderSetoranTable = () => {
    const rows = Array.isArray(window.setoranKasirCache)
      ? window.setoranKasirCache
      : [];
    const q = String(inputSearchSetoran.value || '').trim().toLowerCase();

    const filtered = rows.filter(r =>
      !q || String(r.kasir || '').toLowerCase().includes(q)
    );

    // Update stat chips ringkasan (mengikuti filter pencarian)
    sumSetoranTunai.textContent = formatRupiah(
      filtered.reduce((s, r) => s + (Number(r.omzet_tunai) || 0), 0)
    );
    sumNonTunai.textContent = formatRupiah(
      filtered.reduce((s, r) =>
        s + (Number(r.omzet_qris) || 0) + (Number(r.omzet_transfer) || 0), 0)
    );
    sumTotalOmzet.textContent = formatRupiah(
      filtered.reduce((s, r) => s + (Number(r.total_omzet) || 0), 0)
    );

    setoranBody.innerHTML = filtered.length
      ? filtered.map(r =>
          `<tr>
             <td>${escapeHtml(r.kasir) || '—'}</td>
             <td class="col-num">${Number(r.total_transaksi) || 0}</td>
             <td class="col-num">${formatRupiah(r.omzet_tunai)}</td>
             <td class="col-num">${formatRupiah(r.omzet_qris)}</td>
             <td class="col-num">${formatRupiah(r.omzet_transfer)}</td>
             <td class="col-num">${formatRupiah(r.total_omzet)}</td>
           </tr>`
        ).join('')
      : '<tr class="tx-table__empty"><td colspan="6">Tidak ada transaksi kasir untuk tanggal ini</td></tr>';
  };

  inputSearchSetoran.addEventListener('input', reRenderSetoranTable);
  cardSetoranKasir.addEventListener('click', openSetoranModal);
  setoranBtnClose.addEventListener('click', closeSetoranModal);
  setoranModal.addEventListener('click', (e) => {
    if (e.target === setoranModal) closeSetoranModal();
  });

  // Ganti tanggal → fetch ulang data rekap setoran untuk tanggal terpilih
  inputTanggalSetoran.addEventListener('change', () => {
    const selected = inputTanggalSetoran.value;
    if (!selected) return;
    setoranLoaded = false;
    loadSetoranKasir(selected);
  });

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
  const sumTotalMember = document.getElementById('sumTotalMember');
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
      '<tr class="tx-table__empty"><td colspan="7">Memuat data…</td></tr>';
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
      const freshCount = (window.memberCache || []).length || 0;
      statListMember.textContent = String(freshCount);
      persistMemberTotal(freshCount);

      reRenderMemberTable();
      memberLoaded = true;
    } catch (err) {
      memberBody.innerHTML =
        `<tr class="tx-table__empty">
           <td colspan="7">Gagal memuat daftar member: ${escapeHtml(err.message)}</td>
         </tr>`;
    }
  };

  const reRenderMemberTable = () => {
    const rows = Array.isArray(window.memberCache)
      ? window.memberCache
      : [];
    const q = String(inputSearchMember.value || '').trim().toLowerCase();
    const kategori = selectFilterKategoriMember.value; // 'ALL' = semua

    const filtered = rows.filter(r => {
      const matchKategori = kategori === 'ALL'
        || String(r.kategori || '').toUpperCase() === kategori;
      const matchCari = !q
        || String(r.nama || '').toLowerCase().includes(q)
        || String(r.kode_member || '').toLowerCase().includes(q)
        || String(r.nomor_hp || '').toLowerCase().includes(q);
      return matchKategori && matchCari;
    });

    // Update stat chips ringkasan (mengikuti filter, pola setoran)
    const countKategori = (k) =>
      filtered.filter(r => String(r.kategori || '').toUpperCase() === k).length;
    const jmlPlatinum = countKategori('PLATINUM');
    sumTotalMember.textContent = String(filtered.length);
    sumMemberPelajar.textContent = String(countKategori('PELAJAR'));
    sumMemberUmum.textContent = String(countKategori('UMUM'));
    sumMemberPlatinum.textContent = String(jmlPlatinum);

    // Sembunyikan chip Platinum bila jumlahnya 0 (Fix #28) — grid chip
    // menjadi simetris 3 chip (Total / Pelajar / Umum) tanpa angka
    // "0" yang memicu tumpang-tindih angka di layar sempit.
    if (platinumChipEl) {
      platinumChipEl.style.display = jmlPlatinum === 0 ? 'none' : '';
    }

    memberBody.innerHTML = filtered.length
      ? filtered.map(r =>
          `<tr>
             <td class="col-member">
               <strong>${escapeHtml(r.nama)}</strong>
               <span class="member-kode">${escapeHtml(r.kode_member)}</span>
             </td>
             <td>${escapeHtml(formatNoHP(r.nomor_hp))}</td>
             <td>${memberKategoriBadge(r.kategori)}</td>
             <td class="col-num">${r.total_kunjungan} kali</td>
             <td class="col-num">${formatRupiah(r.total_belanja)}</td>
             <td class="time">${escapeHtml(r.tanggal_daftar || '—')}</td>
             <td class="col-aksi">
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
             </td>
           </tr>`
        ).join('')
      : '<tr class="tx-table__empty"><td colspan="7">Tidak ada member yang cocok dengan filter</td></tr>';
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
      statListMember.textContent = String(window.memberCache.length || 0);
      // 3. Re-render tabel + chips mengikuti filter aktif
      reRenderMemberTable();
      // 4. Info sukses singkat
      window.alert(data.message);
    } catch (err) {
      window.alert('Gagal menghapus member: ' + err.message);
    }
  };

  // Delegate di tbody (tombol di-re-render setiap filter berubah)
  memberBody.addEventListener('click', handleDeleteMemberClick);

  inputSearchMember.addEventListener('input', reRenderMemberTable);
  selectFilterKategoriMember.addEventListener('change', reRenderMemberTable);
  cardListMember.addEventListener('click', openMemberModal);
  memberBtnClose.addEventListener('click', closeMemberModal);
  memberModal.addEventListener('click', (e) => {
    if (e.target === memberModal) closeMemberModal();
  });

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
    if (!inputStartDateQris.value) inputStartDateQris.value = kasMonthStartYMD();
    if (!inputEndDateQris.value) inputEndDateQris.value = toYMD(new Date());
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
      sumQrisHariIni.textContent = formatRupiah(data.total_hari_ini);
      sumQrisCountHariIni.textContent = String(data.count_hari_ini || 0);
      sumQrisBulanIni.textContent = formatRupiah(data.total_bulan_ini);
      sumQrisPending.textContent = String(data.total_pending || 0);
      // Card dashboard utama: akumulasi bulan berjalan (Fix #32)
      const formattedBulan = formatRupiah(data.total_bulan_ini);
      statQrisHariIni.textContent = formattedBulan;
      persistQrisMonthCache(formattedBulan);
    } catch (err) {
      // Ringkasan tak kritis — biarkan nilai default saat gagal
      console.warn('Gagal memuat ringkasan QRIS:', err.message);
    }
  };

  const loadQrisHistory = async () => {
    qrisBody.innerHTML =
      '<tr class="tx-table__empty"><td colspan="6">Memuat data…</td></tr>';
    try {
      const s = inputStartDateQris.value || kasMonthStartYMD();
      const e = inputEndDateQris.value || toYMD(new Date());
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
           <td colspan="6">Gagal memuat riwayat QRIS: ${escapeHtml(err.message)}</td>
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
      ? filtered.map(r =>
          `<tr data-qris-id="${r.id}">
             <td class="time">${escapeHtml(r.waktu)} - ${escapeHtml(r.tanggal)}</td>
             <td>${escapeHtml(r.kode_transaksi)}</td>
             <td>${escapeHtml(r.kasir)}</td>
             <td class="col-num">${formatRupiah(r.total_bayar)}</td>
             <td>${escapeHtml(r.no_ref_qris || '-')}</td>
             <td>
               ${qrisStatusBadge(r.status_qris)}
               <button type="button" class="btn-qris-verify"
                       data-id="${r.id}" aria-label="Verifikasi QRIS transaksi ${escapeHtml(r.kode_transaksi)}">
                 Verifikasi
               </button>
             </td>
           </tr>`
        ).join('')
      : '<tr class="tx-table__empty"><td colspan="6">Tidak ada riwayat QRIS untuk filter ini</td></tr>';
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
  cardQrisHistory.addEventListener('click', openQrisModal);
  qrisBtnClose.addEventListener('click', closeQrisModal);
  qrisModal.addEventListener('click', (e) => {
    if (e.target === qrisModal) closeQrisModal();
  });

  // ESC: tutup modal yang paling atas dulu (z-index tertinggi → terendah):
  // qrisHistory (750) → listMember (700) → setoranKasir (650) → kasLaci (600)
  // → kelebihanSO (550) → kerugianSO (500) → barang (400) → meja (300)
  // → item (200) → utama
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && qrisModal.classList.contains('is-open')) {
      closeQrisModal();
      return;
    }
    if (e.key === 'Escape' && memberModal.classList.contains('is-open')) {
      closeMemberModal();
      return;
    }
    if (e.key === 'Escape' && setoranModal.classList.contains('is-open')) {
      closeSetoranModal();
      return;
    }
    if (e.key === 'Escape' && kasModal.classList.contains('is-open')) {
      closeKasModal();
      return;
    }
    if (e.key === 'Escape' && plusModal.classList.contains('is-open')) {
      closePlusModal();
      return;
    }
    if (e.key === 'Escape' && soModal.classList.contains('is-open')) {
      closeSoModal();
      return;
    }
    if (e.key === 'Escape' && barangModal.classList.contains('is-open')) {
      closeBarangModal();
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
    if (e.key === 'Escape' && modalKasir && modalKasir.classList.contains('is-open')) {
      closeKasirModal();
      return;
    }
    if (e.key === 'Escape' && modalPembelian && modalPembelian.classList.contains('is-open')) {
      closePembelianModal();
    }
  });

  fetchStats();
  // Populate card QRIS (akumulasi bulan) saat halaman load — Fix #32
  loadQrisSummary();

  // ── GRAFIK TREN PENJUALAN (Fix #33) ──────────────────────────
  // Grafik batang omzet harian via Canvas API (tanpa library eksternal).
  // Cache display di localStorage agar refresh = instant (pola Fix #29/#32).
  const SALES_CHART_CACHE_KEY = 'pbms_cached_sales_chart_data';
  const salesBarChart    = document.getElementById('salesBarChart');
  const chartCanvasWrap  = document.getElementById('chartCanvasWrap');
  const chartTooltip     = document.getElementById('chartTooltip');
  const chartTooltipDate = document.getElementById('chartTooltipDate');
  const chartTooltipValue= document.getElementById('chartTooltipValue');
  const chartTooltipCount= document.getElementById('chartTooltipCount');
  const chartMaxOmzet    = document.getElementById('chartMaxOmzet');
  const chartAvgOmzet    = document.getElementById('chartAvgOmzet');
  const chartTotalOmzet  = document.getElementById('chartTotalOmzet');
  const btnPeriodMonthly  = document.getElementById('btnPeriodMonthly');
  const btnPeriod30Days   = document.getElementById('btnPeriod30Days');
  let activeChartPeriod = 'monthly_daily';
  let chartDataCache = null; // { labels, data, counts, summary, period }
  // (Fix #40) Variabel modul untuk bar positions agar handler mousemove
  // bisa membaca posisi terbaru TANPA perlu re-register listener tiap
  // render. Listener di-bind SATU KALI di init (bukan di dalam
  // renderSalesBarChart) untuk mencegah stacking.
  let _barPositions = [];
  let _chartMeta    = { labels: [], data: [], counts: [], wrapW: 800, H: 300 };

  const persistSalesChartCache = (payload) => {
    try { localStorage.setItem(SALES_CHART_CACHE_KEY, JSON.stringify(payload)); }
    catch (e) { /* private mode — abaikan */ }
  };
  const loadSalesChartCache = () => {
    try {
      const raw = localStorage.getItem(SALES_CHART_CACHE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.labels)) return null;
      return parsed;
    } catch (e) { return null; }
  };

  // ── Render Grafik Canvas ─────────────────────────────────────
  const renderSalesBarChart = (chart) => {
    if (!salesBarChart) return;
    const canvas = salesBarChart;
    const dpr = window.devicePixelRatio || 1;
    const wrapW = canvas.parentElement ? canvas.parentElement.clientWidth : 800;
    const H = 300;
    canvas.width  = wrapW * dpr;
    canvas.height = H * dpr;
    canvas.style.width  = wrapW + 'px';
    canvas.style.height = H + 'px';
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, wrapW, H);

    const labels = chart.labels || [];
    const data   = chart.data   || [];
    const n = labels.length;
    if (!n) return;

    const padL = 60, padR = 20, padT = 16, padB = 40;
    const chartW = wrapW - padL - padR;
    const chartH = H - padT - padB;
    const maxVal = Math.max(1, ...(chart.summary ? [chart.summary.max_omzet] : [0, ...data]));

    // ── Grid lines horizontal ──
    const gridLines = 4;
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= gridLines; i++) {
      const y = padT + (chartH / gridLines) * i;
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(wrapW - padR, y);
      ctx.stroke();
    }

    // ── Barata ──
    const gapRatio = 0.25;
    const barW = Math.max(4, (chartW / n) * (1 - gapRatio));
    const barGap = (chartW / n - barW);

    // Kumpulkan posisi bar untuk tooltip
    _barPositions = [];
    // Simpan meta untuk handler mousemove satu-kali (Fix #40)
    _chartMeta = { labels, data, counts: chart.counts || [], wrapW, H, padL, padT, chartH, barGap, barW };

    for (let i = 0; i < n; i++) {
      const val = data[i] || 0;
      const x  = padL + barGap / 2 + i * (chartW / n);
      const barH = val > 0 ? Math.max(3, (val / maxVal) * chartH) : 0;
      const y = padT + chartH - barH;

      // Gradient batang: cyan terang di atas → biru gelap di bawah
      const grad = ctx.createLinearGradient(0, y, 0, padT + chartH);
      grad.addColorStop(0, 'rgba(0, 210, 255, 0.9)');
      grad.addColorStop(1, 'rgba(2, 132, 199, 0.5)');
      ctx.fillStyle = grad;

      // Batang dengan radius atas
      const r = Math.min(4, barW / 2, barH);
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.lineTo(x + barW - r, y);
      ctx.arcTo(x + barW, y, x + barW, y + r, r);
      ctx.lineTo(x + barW, padT + chartH);
      ctx.lineTo(x, padT + chartH);
      ctx.lineTo(x, y + r);
      ctx.arcTo(x, y, x + r, y, r);
      ctx.closePath();
      ctx.fill();

      _barPositions.push({ x, y, w: barW, h: barH, i });
    }

    // ── Label X (tanggal) — tampilkan tiap N bar agar tak tumpang ──
    ctx.fillStyle = '#94a3b8';
    ctx.font = '10px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const labelStep = Math.max(1, Math.ceil(n / Math.floor(chartW / 60)));
    for (let i = 0; i < n; i += labelStep) {
      const x = padL + i * (chartW / n) + (chartW / n) / 2;
      ctx.fillText(labels[i] || '', x, padT + chartH + 8);
    }

    // ── Label Y (omzet) ──
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let i = 0; i <= gridLines; i++) {
      const y = padT + (chartH / gridLines) * i;
      const val = maxVal - (maxVal / gridLines) * i;
      const label = val >= 1000000
        ? (val / 1000000).toFixed(1).replace(/\.0$/, '') + 'jt'
        : val >= 1000
          ? Math.round(val / 1000) + 'rb'
          : String(Math.round(val));
      ctx.fillStyle = '#64748b';
      ctx.font = '10px system-ui, sans-serif';
      ctx.fillText(label, padL - 8, y);
    }

  };

  // ── Tooltip via hover (Fix #40 — listener di-bind SATU KALI di sini) ──
  // Di Fix #33 listener mousemove di-register di dalam renderSalesBarChart
  // → tiap resize/reload stack 1 listener baru → N listener berjalan serentak
  // → mousemove handler O(N) per event → freeze di browser.
  // Perbaikan: _barPositions & _chartMeta dimodul-scope; handler baca
  // value terbaru tanpa perlu re-register.
  safeAddEventListener(salesBarChart, 'mousemove', (e) => {
    if (!chartTooltip || !_barPositions.length) return;
    const { labels, data, counts, wrapW, padT, chartH, barGap } = _chartMeta;
    const rect = salesBarChart.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    let hit = null;
    for (const bp of _barPositions) {
      if (mx >= bp.x && mx <= bp.x + bp.w + barGap) {
        hit = bp; break;
      }
    }
    if (hit) {
      if (chartTooltipDate)  chartTooltipDate.textContent  = labels[hit.i] || '';
      if (chartTooltipValue) chartTooltipValue.textContent = formatRupiah(data[hit.i] || 0);
      if (chartTooltipCount) chartTooltipCount.textContent = ((counts || [])[hit.i] || 0) + ' transaksi';
      const tipW = 120;
      const tx = Math.max(0, Math.min(wrapW - tipW, hit.x + hit.w / 2 - tipW / 2));
      const ty = Math.max(0, (hit.h > 0 ? hit.y : padT + chartH) - 56);
      chartTooltip.style.left = tx + 'px';
      chartTooltip.style.top  = ty + 'px';
      chartTooltip.classList.add('is-visible');
    } else {
      chartTooltip.classList.remove('is-visible');
    }
  });

  safeAddEventListener(salesBarChart, 'mouseleave', () => {
    if (chartTooltip) chartTooltip.classList.remove('is-visible');
  });

  const updateChartSummary = (chart) => {
    const s = chart.summary || {};
    chartMaxOmzet.textContent  = formatRupiah(s.max_omzet);
    chartAvgOmzet.textContent  = formatRupiah(s.avg_omzet);
    chartTotalOmzet.textContent= formatRupiah(s.total_omzet_period);
  };

  const loadSalesChart = async (period) => {
    activeChartPeriod = period;
    // Update tombol toggle
    if (btnPeriodMonthly)  btnPeriodMonthly.classList.toggle('is-active', period === 'monthly_daily');
    if (btnPeriod30Days)   btnPeriod30Days.classList.toggle('is-active', period === 'last_30_days');
    try {
      const resp = await fetch('/api/admin/reports/sales-chart?period=' + encodeURIComponent(period));
      const data = await resp.json();
      if (!resp.ok || !data.success) throw new Error(data.message || 'Gagal memuat grafik');
      const chart = {
        labels:   data.labels   || [],
        data:     data.data     || [],
        counts:   data.counts   || [],
        summary:  data.summary  || {},
        period,
      };
      chartDataCache = chart;
      renderSalesBarChart(chart);
      updateChartSummary(chart);
      persistSalesChartCache(chart);
    } catch (err) {
      console.warn('Gagal memuat grafik penjualan:', err.message);
    }
  };

  // Event listeners tombol periode
  if (btnPeriodMonthly) btnPeriodMonthly.addEventListener('click', () => loadSalesChart('monthly_daily'));
  if (btnPeriod30Days)  btnPeriod30Days.addEventListener('click',  () => loadSalesChart('last_30_days'));

  // Resize handler (debounce ringan)
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (chartDataCache) renderSalesBarChart(chartDataCache);
    }, 150);
  });

  // Init: cache instant → fetch refresh
  (function initSalesChart() {
    const cached = loadSalesChartCache();
    if (cached && Array.isArray(cached.labels) && cached.labels.length) {
      chartDataCache = cached;
      renderSalesBarChart(cached);
      updateChartSummary(cached);
      // Tetap fetch untuk refresh ke data terbaru
      loadSalesChart(cached.period || activeChartPeriod);
    } else {
      loadSalesChart('monthly_daily');
    }
  })();

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
    const categories = getMasterBarangCache().map(r => r.kategori).filter(Boolean);
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
    loadBankHistory();
  };

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

  // ── PURCHASE CART / RESTOK BARANG (Fix #45) ─────────────────
  const modalPembelian       = document.getElementById('modalPembelian');
  const btnCloseModalPem     = document.getElementById('btnCloseModalPembelian');
  const pemSearchBarang      = document.getElementById('pemSearchBarang');
  const pemQty               = document.getElementById('pemQty');
  const pemHppBaru           = document.getElementById('pemHppBaru');
  const pemHjBaru            = document.getElementById('pemHjBaru');
  const btnPemAddItem        = document.getElementById('btnPemAddItem');
  const pemSearchResults     = document.getElementById('pemSearchResults');
  const pemCartBody          = document.getElementById('pemCartBody');
  const pemCartCount         = document.getElementById('pemCartCount');
  const pemSumVariasi        = document.getElementById('pemSumVariasi');
  const pemSumQty            = document.getElementById('pemSumQty');
  const pemSumModal          = document.getElementById('pemSumModal');
  const pemSumMargin         = document.getElementById('pemSumMargin');
  const pemCatatKasKeluar    = document.getElementById('pemCatatKasKeluar');
  const btnPemCheckout       = document.getElementById('btnPemCheckout');
  const pemKategoriTab       = document.getElementById('pemKategoriTab');
  const pemKategoriBadge     = document.getElementById('pemKategoriBadge');

  let pemCart = []; // [{ barang_id, nama, stok, kategori, hpp_lama, hj_lama, hpp_baru, hj_baru, qty }]
  let pemActiveKategori = 'KASIR'; // (Fix #46) kategori tab aktif — filter pencarian
  let editingPoId = null; // (Fix #55) reference PO yang sedang diedit di modal pembelian
  let editingPoNo = '';   // (Fix #55) no_po untuk notifikasi sukses

  // ── (Fix #46) Tab Kategori ──
  const setPemKategori = (kat) => {
    pemActiveKategori = kat;
    // Update state tab
    if (pemKategoriTab) {
      pemKategoriTab.querySelectorAll('.pem-kategori-tab__btn').forEach(b => {
        const active = b.dataset.pemKategori === kat;
        b.classList.toggle('is-active', active);
        b.setAttribute('aria-pressed', String(active));
      });
    }
    // Update badge di header cart
    if (pemKategoriBadge) pemKategoriBadge.textContent = kat;
    // Hapus selected barang (barang lama tak relevan lagi)
    modalPembelian._selectedBarang = null;
    // Bersihkan hasil pencarian yang tersisa
    if (pemSearchBarang) pemSearchBarang.value = '';
    if (pemSearchResults) { pemSearchResults.hidden = true; pemSearchResults.innerHTML = ''; }
    if (pemHppBaru) pemHppBaru.value = '';
    if (pemHjBaru)  pemHjBaru.value = '';
    // Re-render cart (filter sesuai kategori aktif)
    renderPemCart();
  };

  if (pemKategoriTab) {
    pemKategoriTab.querySelectorAll('.pem-kategori-tab__btn').forEach(btn => {
      btn.addEventListener('click', () => setPemKategori(btn.dataset.pemKategori));
    });
  }

  const openPembelianModal = () => {
    if (!modalPembelian) return;
    modalPembelian.classList.add('is-open');
    modalPembelian.removeAttribute('hidden');
    modalPembelian.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
    // Reset form
    if (pemSearchBarang) pemSearchBarang.value = '';
    if (pemQty) pemQty.value = '1';
    if (pemHppBaru) pemHppBaru.value = '';
    if (pemHjBaru) pemHjBaru.value = '';
    if (pemSearchResults) pemSearchResults.hidden = true;
    if (pemCatatKasKeluar) pemCatatKasKeluar.checked = false;
    // (Fix #55) Reset mode edit saat buka dari stat card
    resetPoEditMode();
    renderPemCart();
  };

  // (Fix #55) Reset mode edit PO — kembalikan label tombol & state normal
  const resetPoEditMode = () => {
    editingPoId = null;
    editingPoNo = '';
    if (btnPemCheckout) btnPemCheckout.textContent = 'Simpan & Buat Nomor PO';
    const pemTitle = document.getElementById('modalPembelianTitle');
    if (pemTitle) pemTitle.textContent = 'Restok Barang / Purchase Cart';
  };

  const closePembelianModal = () => {
    if (!modalPembelian) return;
    modalPembelian.classList.remove('is-open');
    modalPembelian.setAttribute('hidden', '');
    modalPembelian.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
    // (Fix #55) Reset mode edit & bersihkan cart
    resetPoEditMode();
    pemCart = [];
    renderPemCart();
  };

  const showPemAlert = (kind, msg) => {
    // Reuse bankAlertBox style via inline alert in footer area
    // (use the existing bankAlertBox or create a dedicated one)
    let el = document.getElementById('pembelianAlert');
    if (!el && modalPembelian) {
      el = document.createElement('div');
      el.id = 'pembelianAlert';
      el.className = 'pembelian-alert';
      modalPembelian.querySelector('.pembelian-footer')?.prepend(el);
    }
    if (!el) return;
    el.className = 'pembelian-alert ' + (kind === 'success' ? 'is-success' : 'is-danger');
    el.textContent = msg;
    setTimeout(() => { el.className = 'pembelian-alert'; }, 4000);
  };

  // ── Search Barang ──
  const pemSearchTimer = {};
  safeAddEventListener(pemSearchBarang, 'input', () => {
    clearTimeout(pemSearchTimer._t);
    pemSearchTimer._t = setTimeout(async () => {
      const q = (pemSearchBarang.value || '').trim().toLowerCase();
      if (!pemSearchResults) return;
      if (q.length < 2) {
        pemSearchResults.hidden = true;
        pemSearchResults.innerHTML = '';
        return;
      }
      pemSearchResults.hidden = false;
      pemSearchResults.innerHTML = '<div class="pembelian-search-empty">Memuat…</div>';
      try {
        const resp = await fetch('/api/admin/inventory/master');
        const data = await resp.json();
        if (!resp.ok || !data.success) throw new Error(data.message || 'Gagal');
        // (Fix #46) Filter: kata kunci + kategori aktif (tab)
        const all = (data.data || []).filter(b => {
          const matchKata =
            (b.nama_barang || '').toLowerCase().includes(q) ||
            (b.kode_barang || '').toLowerCase().includes(q);
          const matchKategori =
            (b.kategori || '').toUpperCase() === pemActiveKategori;
          return matchKata && matchKategori;
        }).slice(0, 20);
        if (!all.length) {
          pemSearchResults.innerHTML = '<div class="pembelian-search-empty">Tidak ditemukan.</div>';
          return;
        }
        pemSearchResults.innerHTML = all.map(b => `
          <div class="pembelian-search-item" data-barang-id="${b.id}">
            <span class="pembelian-search-item__nama">${escapeHtml(b.nama_barang || '')}</span>
            <span class="pembelian-search-item__meta">
              <span>${escapeHtml(b.kode_barang || '')}</span>
              <span>Stok: ${b.stok || 0}</span>
              <span>HPP: ${formatRupiah(b.harga_modal)}</span>
            </span>
          </div>`).join('');
        // Bind clicks
        pemSearchResults.querySelectorAll('.pembelian-search-item').forEach(item => {
          item.addEventListener('click', () => {
            const id = Number(item.dataset.barangId);
            const b = all.find(x => x.id === id);
            if (!b) return;
            // Auto-fill HPP & Harga Jual lama sebagai default
            if (pemHppBaru) pemHppBaru.value = String(b.harga_modal || 0);
            if (pemHjBaru)  pemHjBaru.value  = String(b.harga_jual || 0);
            // Simpan barang terpilih (tampil di hidden state)
            modalPembelian._selectedBarang = b;
            modalPembelian._selectedKategori = (b.kategori || '').toUpperCase() || pemActiveKategori;
            pemSearchResults.hidden = true;
            pemSearchBarang.value = b.nama_barang || '';
          });
        });
      } catch (err) {
        pemSearchResults.innerHTML =
          '<div class="pembelian-search-empty">Gagal memuat: ' + escapeHtml(err.message) + '</div>';
      }
    }, 250);
  });

  // ── Tambah Item ke Cart ──
  const addPemItem = () => {
    const b = modalPembelian._selectedBarang;
    if (!b) { showPemAlert('danger', 'Pilih barang dulu dari pencarian.'); return; }
    const qty = Number(pemQty.value) || 0;
    if (qty < 1) { showPemAlert('danger', 'Qty minimal 1.'); return; }
    const hppBaru  = Number(pemHppBaru.value) || 0;
    const hjBaru   = Number(pemHjBaru.value)  || 0;

    // (Fix #46) Simpan kategori dari barang terpilih (fallback ke tab aktif)
    const katBarang = modalPembelian._selectedKategori || (b.kategori || '').toUpperCase() || pemActiveKategori;

    // Cek apakah sudah ada di cart → increment qty
    const existing = pemCart.find(c => c.barang_id === b.id);
    if (existing) {
      existing.qty += qty;
      existing.kategori = katBarang;
    } else {
      pemCart.push({
        barang_id: b.id,
        nama: b.nama_barang || '',
        stok: b.stok || 0,
        kategori: katBarang,
        hpp_lama: b.harga_modal || 0,
        hj_lama:  b.harga_jual  || 0,
        hpp_baru: hppBaru,
        hj_baru:  hjBaru,
        qty,
      });
    }
    // Reset form
    if (pemSearchBarang) pemSearchBarang.value = '';
    if (pemQty) pemQty.value = '1';
    if (pemHppBaru) pemHppBaru.value = '';
    if (pemHjBaru) pemHjBaru.value = '';
    modalPembelian._selectedBarang = null;
    renderPemCart();
  };

  const removePemItem = (barangId) => {
    pemCart = pemCart.filter(c => c.barang_id !== barangId);
    renderPemCart();
  };

  // ── Render Cart ──
  const renderPemCart = () => {
    // (Fix #46) Cart per kategori: hanya tampilkan & hitung item yang
    // sesuai tab aktif. Item kategori lain tetap ada di pemCart (data
    // tidak hilang), hanya disembunyikan sampai tab-nya dipilih.
    const visibleCart = pemCart.filter(c =>
      (c.kategori || '').toUpperCase() === pemActiveKategori
    );

    if (!pemCartBody) return;
    if (!visibleCart.length) {
      const lain = pemCart.length - visibleCart.length;
      pemCartBody.innerHTML = lain
        ? '<tr class="tx-table__empty"><td colspan="8">Keranjang kategori ' +
          escapeHtml(pemActiveKategori) + ' kosong (' + lain + ' item kategori lain tersimpan).</td></tr>'
        : '<tr class="tx-table__empty"><td colspan="8">Belum ada item di keranjang.</td></tr>';
    } else {
      pemCartBody.innerHTML = visibleCart.map(c => `
        <tr>
          <td>${escapeHtml(c.nama)}</td>
          <td><span class="pem-kategori-chip">${escapeHtml(c.kategori || pemActiveKategori)}</span></td>
          <td class="num">${c.stok}</td>
          <td class="num">${c.qty}</td>
          <td class="num">${formatRupiah(c.hpp_baru)}</td>
          <td class="num">${formatRupiah(c.hj_baru)}</td>
          <td class="num">${formatRupiah(c.hpp_baru * c.qty)}</td>
          <td class="col-aksi">
            <button type="button" class="btn-pem-remove"
                    data-pem-rm="${c.barang_id}">Hapus</button>
          </td>
        </tr>`).join('');
    }

    // Update count badge — hitung TIDAK terfilter (total semua kategori)
    if (pemCartCount) pemCartCount.textContent =
      visibleCart.length + ' item (' + pemActiveKategori.toLowerCase() +
      (pemCart.length !== visibleCart.length ? ' / ' + pemCart.length + ' total' : '') + ')';

    // Update summary — hanya item kategori aktif
    const totalModal = visibleCart.reduce((s, c) => s + c.hpp_baru * c.qty, 0);
    const totalQty   = visibleCart.reduce((s, c) => s + c.qty, 0);
    const totalHj    = visibleCart.reduce((s, c) => s + c.hj_baru * c.qty, 0);
    const marginPct  = totalModal > 0
      ? ((totalHj - totalModal) / totalHj * 100).toFixed(1)
      : '—';

    if (pemSumVariasi) pemSumVariasi.textContent = String(visibleCart.length);
    if (pemSumQty)     pemSumQty.textContent     = String(totalQty);
    if (pemSumModal)   pemSumModal.textContent   = formatRupiah(totalModal);
    if (pemSumMargin)  pemSumMargin.textContent  =
      marginPct === '—' ? '—' : (100 - Number(marginPct)).toFixed(1) + '%';

    // Enable/disable checkout — checkout kirim SEMUA kategori (data utuh)
    if (btnPemCheckout) btnPemCheckout.disabled = !pemCart.length;

    // Bind remove buttons
    if (pemCartBody) {
      pemCartBody.querySelectorAll('[data-pem-rm]').forEach(btn => {
        btn.addEventListener('click', () => removePemItem(Number(btn.dataset.pemRm)));
      });
    }
  };

  // ── Checkout (Fix #46) ──
  // (Fix #45) `admin_name` dari sessionStorage — konsisten dengan bank deposit.
  // (Fix #46) `kategori_target` = tab aktif — histori tercatat per kategori.
  // Checkout HANYA kirim item yang sesuai kategori aktif (sesuai summary cart).
  const submitPembelian = async () => {
    if (!pemCart.length || !btnPemCheckout) return;
    const adminName = sessionStorage.getItem('pbms_admin_session') || 'admin';
    if (!adminName) { showPemAlert('danger', 'Sesi admin tidak valid.'); return; }

    // (Fix #46) Filter items sesuai kategori aktif
    const itemsKategori = pemCart.filter(c =>
      (c.kategori || '').toUpperCase() === pemActiveKategori
    );
    if (!itemsKategori.length) {
      showPemAlert('danger',
        'Keranjang kategori ' + pemActiveKategori + ' kosong. Tambah item dulu.');
      return;
    }

    btnPemCheckout.disabled = true;
    const labelSimpan = btnPemCheckout.textContent;
    btnPemCheckout.textContent = 'Memproses…';

    try {
      // ── (Fix #55) MODE EDIT PO ──
      if (editingPoId) {
        const totalModal = itemsKategori.reduce((s, c) => s + c.hpp_baru * c.qty, 0);
        const totalQty   = itemsKategori.reduce((s, c) => s + c.qty, 0);
        const resp = await fetch('/api/admin/pembelian/po/' + editingPoId, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            total_modal: totalModal,
            total_qty: totalQty,
            kategori_target: pemActiveKategori,
            items: itemsKategori.map(c => ({
              barang_id: c.barang_id,
              hpp_baru: c.hpp_baru,
              harga_jual_baru: c.hj_baru,
              qty: c.qty,
            })),
          }),
        });
        const data = await resp.json();
        if (!resp.ok || !data.success) {
          throw new Error(data.message || 'Gagal simpan perubahan PO.');
        }
        showPemAlert('success',
          'PO ' + (data.no_po || editingPoNo || '') + ' berhasil diperbarui. ' +
          data.item_count + ' item, total modal ' + formatRupiah(data.total_modal || 0) + '.');
        // Reset cart & mode edit
        pemCart = [];
        resetPoEditMode();
        renderPemCart();
        loadPoList();
        closePembelianModal();
        return;
      }

      // ── MODE BARU (normal) ──
      const resp = await fetch('/api/admin/pembelian', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          admin_name: adminName,
          kategori_target: pemActiveKategori,
          catat_kas_keluar: pemCatatKasKeluar ? pemCatatKasKeluar.checked : false,
          items: itemsKategori.map(c => ({
            barang_id: c.barang_id,
            hpp_baru: c.hpp_baru,
            harga_jual_baru: c.hj_baru,
            qty: c.qty,
          })),
        }),
      });
      const data = await resp.json();
      if (!resp.ok || !data.success) {
        throw new Error(data.message || 'Gagal proses restok.');
      }
      // (Fix #54) Tampilkan Nomor PO yang berhasil dibuat — status PENDING
      showPemAlert('success',
        'PO ' + (data.no_po || data.nota_no || '') + ' dibuat ' +
        '(status PENDING). ' +
        data.item_count + ' item, total modal ' +
        formatRupiah(data.total_modal || 0) +
        '. Stok belum ditambah — akan bertambah saat PO DITERIMA.');
      // Hapus item kategori yang sudah diproses; kategori lain tetap tersimpan
      pemCart = pemCart.filter(c =>
        (c.kategori || '').toUpperCase() !== pemActiveKategori
      );
      renderPemCart();
      // Refresh master barang & daftar PO (stok tidak berubah, tapi PO list perlu update)
      loadMasterBarang();
      loadPoList();
    } catch (err) {
      showPemAlert('danger', err.message || 'Gagal proses restok. Coba lagi.');
    } finally {
      btnPemCheckout.disabled = !pemCart.length;
      // (Fix #55) Kembalikan label sesuai mode
      btnPemCheckout.textContent = editingPoId ? 'Simpan Perubahan PO' : 'Simpan & Buat Nomor PO';
    }
  };

  // ── Event Listeners ──
  safeAddEventListener(btnPemAddItem, 'click', addPemItem);
  safeAddEventListener(btnPemCheckout, 'click', submitPembelian);
  safeAddEventListener(btnCloseModalPem, 'click', closePembelianModal);
  safeAddEventListener(modalPembelian, 'click', (e) => {
    if (e.target === modalPembelian) closePembelianModal();
  });
  // ESC untuk tutup modal pembelian
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (modalPembelian && modalPembelian.classList.contains('is-open')) {
      closePembelianModal();
      e.stopPropagation();
    }
  });

  // Trigger: stat card "Restok Barang" buka modal pembelian
  safeAddEventListener('cardPembelian', 'click', openPembelianModal);

  // ── PURGE: bersihkan state purchase cart saat tutup modal ──
  const _origClosePem = closePembelianModal;
  // (sudah di-bind di atas; tak perlu override)

  // ── (Fix #54) PANEL DAFTAR PURCHASE ORDER ──────────────────────
  // Kelola PO: filter status, refresh, dan batalkan PO PENDING.
  const selectPoStatus = document.getElementById('selectPoStatus');
  const btnPoRefresh   = document.getElementById('btnPoRefresh');
  const poListBody     = document.getElementById('poListBody');

  // (Fix #55) Buka modal pembelian dengan data PO yang sudah dimuat
  const openPoEditModal = async (poId, triggerBtn) => {
    const resp = await fetch('/api/admin/pembelian/po/' + poId + '/detail');
    const data = await resp.json();
    if (!resp.ok || !data.success) throw new Error(data.message || 'Gagal muat detail PO.');

    const po = data.po;
    const items = data.items || [];
    editingPoId = po.id;
    editingPoNo = po.no_po || '';

    // Set kategori tab ke kategori_target PO (fallback KASIR)
    const kategori = po.kategori_target || 'KASIR';
    setPemKategori(kategori);

    // Load semua item ke cart
    pemCart = items.map(it => ({
      barang_id: it.barang_id,
      nama:      it.nama_barang || '',
      stok:      0, // tidak perlu, cart menampilkan qty & hpp
      kategori:  kategori,
      hpp_lama:  it.hpp_lama || 0,
      hj_lama:   it.harga_jual_lama || 0,
      hpp_baru:  it.hpp_baru || 0,
      hj_baru:   it.harga_jual_baru || 0,
      qty:       it.qty || 0,
    }));
    renderPemCart();

    // Ubah label & judul modal
    if (btnPemCheckout) btnPemCheckout.textContent = 'Simpan Perubahan PO';
    const pemTitle = document.getElementById('modalPembelianTitle');
    if (pemTitle) pemTitle.textContent = 'Edit PO: ' + (po.no_po || '');

    // Buka modal
    if (!modalPembelian) return;
    modalPembelian.classList.add('is-open');
    modalPembelian.removeAttribute('hidden');
    modalPembelian.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';

    // Restore tombol setelah modal terbuka
    if (triggerBtn) { triggerBtn.disabled = false; triggerBtn.textContent = 'Edit'; }
  };

  const loadPoList = async () => {
    if (!poListBody) return;
    poListBody.innerHTML =
      '<tr class="tx-table__empty"><td colspan="8">Memuat data…</td></tr>';
    try {
      const status = selectPoStatus ? selectPoStatus.value : '';
      const qs = status ? '?status=' + encodeURIComponent(status) : '';
      const resp = await fetch('/api/admin/pembelian/po' + qs);
      const data = await resp.json();
      if (!resp.ok || !data.success) {
        throw new Error(data.message || 'Gagal memuat daftar PO.');
      }

      const rows = Array.isArray(data.po) ? data.po : [];
      if (!rows.length) {
        poListBody.innerHTML =
          '<tr class="tx-table__empty"><td colspan="8">Belum ada Purchase Order.</td></tr>';
        return;
      }

      const statusBadge = (s) => {
        if (s === 'PENDING') return '<span class="po-status po-status--pending">PENDING</span>';
        if (s === 'BATAL')   return '<span class="po-status po-status--batal">BATAL</span>';
        if (s === 'DITERIMA')return '<span class="po-status po-status--diterima">DITERIMA</span>';
        return '<span class="po-status">' + escapeHtml(s || '—') + '</span>';
      };

      poListBody.innerHTML = rows.map(po => `
        <tr data-po-id="${po.id}">
          <td>${escapeHtml(po.no_po || '—')}</td>
          <td>${escapeHtml(po.kategori_target || '—')}</td>
          <td class="num">${po.item_count}</td>
          <td class="num">${po.total_qty}</td>
          <td class="num">${formatRupiah(po.total_modal)}</td>
          <td>${escapeHtml(po.created_at || '—')}</td>
          <td>${statusBadge(po.status)}</td>
          <td class="col-aksi">
            ${po.status === 'PENDING'
              ? '<div class="po-action-group">' +
                '<button type="button" class="btn-po-edit" data-po-edit="' +
                po.id + '" aria-label="Edit PO ' + escapeHtml(po.no_po || '') + '">Edit</button>' +
                '<button type="button" class="btn-po-batal" data-po-batal="' +
                po.id + '" aria-label="Batalkan PO ' + escapeHtml(po.no_po || '') + '">Batalkan</button>' +
                '</div>'
              : '<span class="po-aksi-noidle">—</span>'}
          </td>
        </tr>`).join('');

      // Bind tombol batalkan
      poListBody.querySelectorAll('[data-po-batal]').forEach(btn => {
        btn.addEventListener('click', async () => {
          const poId = Number(btn.dataset.poBatal);
          if (!poId) return;
          if (!window.confirm('Yakin membatalkan PO ini? Status akan menjadi BATAL.')) return;
          btn.disabled = true;
          btn.textContent = '…';
          try {
            const resp = await fetch(
              '/api/admin/pembelian/po/' + poId + '/status',
              {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ status: 'BATAL' }),
              }
            );
            const d = await resp.json();
            if (!resp.ok || !d.success) throw new Error(d.message || 'Gagal batalkan PO.');
            await loadPoList();
          } catch (err) {
            btn.disabled = false;
            btn.textContent = 'Batalkan';
            alert('Gagal batalkan PO: ' + err.message);
          }
        });
      });

      // (Fix #55) Bind tombol edit — buka modal pembelian dengan data PO
      poListBody.querySelectorAll('[data-po-edit]').forEach(btn => {
        btn.addEventListener('click', async () => {
          const poId = Number(btn.dataset.poEdit);
          if (!poId) return;
          btn.disabled = true;
          btn.textContent = '…';
          try {
            await openPoEditModal(poId, btn);
          } catch (err) {
            alert('Gagal muat detail PO: ' + err.message);
          } finally {
            // Allow re-click even after error (don't leave button stuck)
            // But keep disabled until loadPoList re-renders the table
          }
        });
      });
    } catch (err) {
      poListBody.innerHTML =
        '<tr class="tx-table__empty"><td colspan="8">Gagal memuat daftar PO: ' +
        escapeHtml(err.message) + '</td></tr>';
    }
  };

  safeAddEventListener(selectPoStatus, 'change', loadPoList);
  safeAddEventListener(btnPoRefresh, 'click', loadPoList);
  // Init — muat daftar PO saat halaman load
  loadPoList();
});
