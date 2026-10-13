// ============================================================
// PBMS ADMIN — MODUL SETORAN KASIR (dipisahkan dari dashboard.js,
// pola Fix #81 modul QRIS). Helper pendukung mandiri di bagian
// paling atas agar tidak memicu ReferenceError — modul ini harus
// berdiri sendiri (formatRupiah/escapeHtml/toYMD di dashboard.js
// scope-nya berbeda).
// ============================================================

// Helper format rupiah — identik dengan di dashboard.js
const setoranFormatRupiah = (num) =>
  'Rp ' + (num || 0).toLocaleString('id-ID');

// Helper escape HTML — identik dengan global di dashboard.js
const setoranEscapeHtml = (str) =>
  String(str ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));

// Helper format tanggal YYYY-MM-DD lokal (salinan dari kas.js)
const setoranToYMD = (d = new Date()) => {
  const date = d instanceof Date ? d : new Date(d);
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

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
// Card disembunyikan dari grid dashboard (is-hidden + display:none,
// pola Fix #83). Elemen tetap ada di DOM agar referensi tak null;
// pemicu klik card (bila masih ada) diberi null-check di dashboard.js.
let setoranLoaded = false;

const initSetoranDateInput = () => {
  if (!inputTanggalSetoran.value) {
    inputTanggalSetoran.value = setoranToYMD(new Date());
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
         <td colspan="6">Gagal memuat rekap setoran: ${setoranEscapeHtml(err.message)}</td>
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
  sumSetoranTunai.textContent = setoranFormatRupiah(
    filtered.reduce((s, r) => s + (Number(r.omzet_tunai) || 0), 0)
  );
  sumNonTunai.textContent = setoranFormatRupiah(
    filtered.reduce((s, r) =>
      s + (Number(r.omzet_qris) || 0) + (Number(r.omzet_transfer) || 0), 0)
  );
  sumTotalOmzet.textContent = setoranFormatRupiah(
    filtered.reduce((s, r) => s + (Number(r.total_omzet) || 0), 0)
  );

  setoranBody.innerHTML = filtered.length
    ? filtered.map(r =>
        `<tr>
           <td>${setoranEscapeHtml(r.kasir) || '—'}</td>
           <td class="col-num">${Number(r.total_transaksi) || 0}</td>
           <td class="col-num">${setoranFormatRupiah(r.omzet_tunai)}</td>
           <td class="col-num">${setoranFormatRupiah(r.omzet_qris)}</td>
           <td class="col-num">${setoranFormatRupiah(r.omzet_transfer)}</td>
           <td class="col-num">${setoranFormatRupiah(r.total_omzet)}</td>
         </tr>`
      ).join('')
    : '<tr class="tx-table__empty"><td colspan="6">Tidak ada transaksi kasir untuk tanggal ini</td></tr>';
};

inputSearchSetoran.addEventListener('input', reRenderSetoranTable);
// Pemicu klik card (bila card aktif di grid) tetap ada di dashboard.js
// (double-bind dilarang, pola Fix #81). cardSetoranKasir di atas hanya
// untuk referensi, tidak di-bind di file ini.
setoranBtnClose.addEventListener('click', closeSetoranModal);

// Klik overlay modal = tutup
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

// ESC khusus setoran: tutup modal bila terbuka (z-index 1000 kini
// sejajar/atas — handler terpisah, pola qris.js; ESC lain di dashboard.js)
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && setoranModal.classList.contains('is-open')) {
    closeSetoranModal();
  }
});

// Eksport ke global scope agar bisa dipanggil dari dashboard.js
// (pemicu card + item burger menu "Rekap Setoran")
window.openSetoranModal = openSetoranModal;
