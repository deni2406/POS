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

// Ekspos ke global scope agar bisa dipanggil dari inline onclick HTML
window.openKasModal = openKasModal;
