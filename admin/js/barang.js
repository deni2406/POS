// ============================================================
// PBMS ADMIN — MODUL BARANG & KASIR
// (dipisahkan dari dashboard.js, pola Fix #81/#84/#86).
// Helper mandiri berawalan `barang*` agar tidak memicu
// ReferenceError — modul ini berdiri sendiri.
//
// Sub-modul yang dikelola file ini:
//   1. Modal Master Barang & Stok Terkini (#modalMasterBarang)
//   2. Modal Edit HPP & Harga Jual       (#modalEditBarangHarga)
//   3. Modal Daftar Barang Kasir         (#modalKasir)
//      + stat card "Barang Kategori Kasir"
// ============================================================

// Helper format rupiah — identik dengan dashboard.js
const barangFormatRupiah = (num) =>
  'Rp ' + (num || 0).toLocaleString('id-ID');

// Helper format angka — identik dengan dashboard.js
const barangFormatNumber = (num) =>
  (num || 0).toLocaleString('id-ID');

// Helper escape HTML — identik dengan global di dashboard.js
const barangEscapeHtml = (str) =>
  String(str ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));

// ── KONSTANTA KASIR ────────────────────────────────────────────
// Kategori yang dianggap "Kasir" di level POS:
//  - kasir : item counter (minuman, korek, snack, dsb.)
//  - rokok : rokok dijual di counter kasir
// Pembanding flexible: trim + case-insensitive, toleransi spasi ganda.
const KASIR_KATEGORI = ['kasir', 'rokok'];
const isKasir = (r) => {
  const k = String(r.kategori || '').trim().toLowerCase().replace(/\s+/g, ' ');
  return KASIR_KATEGORI.includes(k);
};

// ── CACHE MASTER BARANG (shared di modul) ──────────────────────
// Sinkron dengan window.masterBarangCache (expose ke window agar
// bisa dicek via browser console & dipakai modul lain — Pola Fix #85).
let masterBarangCache = Array.isArray(window.masterBarangCache)
  ? window.masterBarangCache
  : [];
let loadMasterBarangPromise = null;

// ── ELEMEN MODAL MASTER BARANG ────────────────────────────────
const barangModal             = document.getElementById('modalMasterBarang');
const barangBtnClose         = document.getElementById('btnCloseModalBarang');
const inputSearchBarang      = document.getElementById('inputSearchBarang');
const selectFilterKategoriBarang = document.getElementById('selectFilterKategoriBarang');
const countJenisBarang       = document.getElementById('countJenisBarang');
const sumStokBarang          = document.getElementById('sumStokBarang');
const sumNilaiAsetBarang     = document.getElementById('sumNilaiAsetBarang');
const barangBody             = document.getElementById('barangTableBody');
const cardTotalMasterBarang  = document.getElementById('cardTotalMasterBarang');
let barangLoaded = false;

// ── FUNGSI: LOAD MASTER BARANG ────────────────────────────────
const loadMasterBarang = async () => {
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
          `<option value="${barangEscapeHtml(k)}">${barangEscapeHtml(k)}</option>`
        ).join('');

      barangLoaded = true;
      reRenderBarangTable();
      await updateKasirCardMetrics();
    } catch (err) {
      barangBody.innerHTML =
        `<tr class="tx-table__empty">
           <td colspan="7">Gagal memuat master barang: ${barangEscapeHtml(err.message)}</td>
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

// ── FUNGSI: OPEN / CLOSE MODAL MASTER BARANG ──────────────────
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

// ── FUNGSI: RE-RENDER TABEL MASTER BARANG ─────────────────────
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
  countJenisBarang.textContent = barangFormatNumber(filtered.length);
  sumStokBarang.textContent = barangFormatNumber(
    filtered.reduce((s, r) => s + (Number(r.stok) || 0), 0)
  );
  sumNilaiAsetBarang.textContent = barangFormatRupiah(
    filtered.reduce((s, r) => {
      const kat = String(r.kategori || '').toUpperCase();
      if (kat === 'BAR' || kat === 'DAPUR') return s;
      return s + (Number(r.stok) || 0) * (Number(r.harga_modal) || 0);
    }, 0)
  );

  const stokBadge = (stok) =>
    Number(stok) <= 5
      ? '<span class="badge badge-stok--nipis">Peringatan</span>'
      : '<span class="badge badge-stok--aman">Aman</span>';

  // Render baris tabel
  barangBody.innerHTML = filtered.length
    ? filtered.map(r => {
        const isTrackedStock = ['ROKOK', 'KASIR'].includes(String(r.kategori || '').toUpperCase().trim());
        const displayStok = isTrackedStock ? barangFormatNumber(r.stok) : '--';
        const displayBadge = isTrackedStock ? stokBadge(r.stok) : '<span class="badge badge-neutral">-</span>';
        return `
           <tr>
             <td class="col-nama" style="color:#ffffff!important;opacity:1!important;">${barangEscapeHtml(r.nama_barang) || '—'}</td>
             <td>${barangEscapeHtml(r.kategori) || '—'}</td>
             <td class="col-num">${barangFormatRupiah(r.harga_modal)}</td>
             <td class="col-num">${barangFormatRupiah(r.harga_jual)}</td>
             <td class="col-num col-center">${displayStok}</td>
             <td class="col-center">${displayBadge}</td>
             <td class="col-center">
               <button type="button" class="btn btn-sm btn-edit-harga"
                       data-barang-id="${r.id}" title="Edit HPP &amp; Harga Jual">Edit</button>
             </td>
           </tr>`;
      }).join('')
    : '<tr class="tx-table__empty"><td colspan="7">Tidak ada barang yang cocok dengan filter</td></tr>';

  // Bind tombol Edit HPP/HJ per baris
  if (barangBody) {
    barangBody.querySelectorAll('button[data-barang-id]').forEach(btn => {
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const id = Number(btn.dataset.barangId);
        const barang = masterBarangCache.find(b => b.id === id);
        if (!barang) {
          const fallback = filtered.find(b => b.id === id);
          openEditBarangHarga(fallback || { id, nama_barang: '', kategori: '', harga_modal: 0, harga_jual: 0 });
          return;
        }
        openEditBarangHarga(barang);
      });
    });
  }
};

// ── ELEMEN MODAL EDIT HPP & HARGA JUAL ────────────────────────
const modalEditBarangHarga     = document.getElementById('modalEditBarangHarga');
const btnCloseEditBarangHarga  = document.getElementById('btnCloseEditBarangHarga');
const btnBatalEditBarangHarga  = document.getElementById('btnBatalEditBarangHarga');
const btnSimpanEditBarangHarga = document.getElementById('btnSimpanEditBarangHarga');
const editBarangNama           = document.getElementById('editBarangNama');
const editBarangKategori       = document.getElementById('editBarangKategori');
const editBarangHpp            = document.getElementById('editBarangHpp');
const editBarangHj             = document.getElementById('editBarangHj');
const editBarangAlert          = document.getElementById('editBarangAlert');
let _editBarangId = null;

const _showEditBarangAlert = (type, msg) => {
  if (!editBarangAlert) return;
  editBarangAlert.hidden = false;
  editBarangAlert.style.color = type === 'danger' ? '#ef4444' : '#16a34a';
  editBarangAlert.style.fontSize = '0.85rem';
  editBarangAlert.textContent = msg;
};

const openEditBarangHarga = (barang) => {
  if (!modalEditBarangHarga || !barang) return;
  _editBarangId = barang.id;
  if (editBarangNama) editBarangNama.value = barang.nama_barang || '';
  if (editBarangKategori) editBarangKategori.value = barang.kategori || '';
  if (editBarangHpp) editBarangHpp.value = String(barang.harga_modal ?? barang.hpp ?? 0);
  if (editBarangHj) editBarangHj.value = String(barang.harga_jual ?? 0);
  if (editBarangAlert) editBarangAlert.hidden = true;
  modalEditBarangHarga.classList.add('is-open');
  modalEditBarangHarga.removeAttribute('hidden');
  setTimeout(() => { if (editBarangHpp) editBarangHpp.focus(); }, 80);
};

const closeEditBarangHarga = () => {
  if (!modalEditBarangHarga) return;
  modalEditBarangHarga.classList.remove('is-open');
  modalEditBarangHarga.setAttribute('hidden', '');
  _editBarangId = null;
};

const saveEditBarangHarga = async () => {
  if (!_editBarangId) return;
  const newHpp = Number(editBarangHpp?.value) || 0;
  const newHj  = Number(editBarangHj?.value) || 0;
  if (newHpp < 0 || newHj < 0) { _showEditBarangAlert('danger', 'Harga tidak boleh negatif.'); return; }
  btnSimpanEditBarangHarga.disabled = true;
  btnSimpanEditBarangHarga.textContent = 'Menyimpan…';
  try {
    const resp = await fetch('/api/admin/inventory/price', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ barang_id: _editBarangId, hpp: newHpp, harga_jual: newHj })
    });
    const data = await resp.json();
    if (!resp.ok || !data.success) throw new Error(data.message || 'Gagal menyimpan');
    _showEditBarangAlert('success', 'HPP & Harga Jual berhasil diperbarui.');
    // Update cache lokal agar tabel langsung tampil nilai baru
    if (Array.isArray(masterBarangCache)) {
      const item = masterBarangCache.find(b => b.id === _editBarangId);
      if (item) {
        item.harga_modal = newHpp;
        item.hpp = newHpp;
        item.harga_jual = newHj;
        window.masterBarangCache = masterBarangCache;
      }
    }
    setTimeout(() => {
      closeEditBarangHarga();
      if (barangModal && barangModal.classList.contains('is-open')) {
        reRenderBarangTable();
      }
    }, 600);
  } catch (err) {
    _showEditBarangAlert('danger', 'Gagal simpan: ' + err.message);
  } finally {
    btnSimpanEditBarangHarga.disabled = false;
    btnSimpanEditBarangHarga.textContent = 'Simpan Perubahan';
  }
};

// ── ELEMEN KARTU KASIR + MODAL KASIR ───────────────────────────
const cardKategoriKasir  = document.getElementById('cardKategoriKasir');
const statKasirJenis     = document.getElementById('statKasirJenis');
const statKasirStok      = document.getElementById('statKasirStok');
const statKasirModal     = document.getElementById('statKasirModal');
const statKasirJual      = document.getElementById('statKasirJual');

const modalKasir         = document.getElementById('modalKasir');
const btnCloseModalKasir = document.getElementById('btnCloseModalKasir');
const kasirTableBody     = document.getElementById('kasirTableBody');
const kasirCountJenis    = document.getElementById('kasirCountJenis');
const kasirSumStok       = document.getElementById('kasirSumStok');
const kasirSumModal      = document.getElementById('kasirSumModal');
const kasirSumJual       = document.getElementById('kasirSumJual');

// (Fix #52) updateKasirCardMetrics — async; bila cache kosong,
// auto-fetch via loadMasterBarang() dulu sebelum me-render.
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

  if (statKasirJenis) statKasirJenis.textContent = barangFormatNumber(totalJenis);
  if (statKasirStok)  statKasirStok.textContent  = barangFormatNumber(totalStok);
  if (statKasirModal) statKasirModal.textContent = barangFormatRupiah(totalModal);
  if (statKasirJual)  statKasirJual.textContent  = barangFormatRupiah(totalJual);

  // Simpan ke chip di modal (siap tampil tanpa reload)
  if (kasirCountJenis) kasirCountJenis.textContent = barangFormatNumber(totalJenis);
  if (kasirSumStok)    kasirSumStok.textContent    = barangFormatNumber(totalStok);
  if (kasirSumModal)   kasirSumModal.textContent   = barangFormatRupiah(totalModal);
  if (kasirSumJual)    kasirSumJual.textContent    = barangFormatRupiah(totalJual);
};

// (Fix #52) loadKasirTable — async; auto-fetch bila cache kosong
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
       <td class="col-nama">${barangEscapeHtml(r.nama_barang) || '—'}</td>
       <td class="col-num col-center">${barangFormatNumber(r.stok)}</td>
       <td class="col-num">${barangFormatRupiah(r.harga_modal)}</td>
       <td class="col-num">${barangFormatRupiah(r.harga_jual)}</td>
     </tr>`
  ).join('');
};

const openKasirModal = async () => {
  if (kasirTableBody) kasirTableBody.innerHTML =
    '<tr class="tx-table__empty"><td colspan="4">Memuat data…</td></tr>';
  modalKasir.classList.add('is-open');
  modalKasir.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
  await loadKasirTable();
};

const closeKasirModal = () => {
  modalKasir.classList.remove('is-open');
  modalKasir.setAttribute('aria-hidden', 'true');
  document.body.style.overflow = '';
};

// ── LISTENER: MODAL MASTER BARANG ──────────────────────────────
inputSearchBarang.addEventListener('input', reRenderBarangTable);
selectFilterKategoriBarang.addEventListener('change', reRenderBarangTable);

// Pemicu klik card di dashboard.js — tak di-bind di sini (anti
// double-bind, pola Fix #81).
barangBtnClose.addEventListener('click', closeBarangModal);
barangModal.addEventListener('click', (e) => {
  if (e.target === barangModal) closeBarangModal();
});

// ESC khusus modal master barang
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && barangModal.classList.contains('is-open')) {
    closeBarangModal();
  }
});

// ── LISTENER: MODAL EDIT HPP & HARGA JUAL ──────────────────────
btnCloseEditBarangHarga.addEventListener('click', closeEditBarangHarga);
btnBatalEditBarangHarga.addEventListener('click', closeEditBarangHarga);
modalEditBarangHarga.addEventListener('click', (e) => {
  if (e.target === modalEditBarangHarga) closeEditBarangHarga();
});
btnSimpanEditBarangHarga.addEventListener('click', saveEditBarangHarga);

// ESC khusus modal edit harga
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && modalEditBarangHarga.classList.contains('is-open')) {
    closeEditBarangHarga();
  }
});

// ── LISTENER: MODAL KASIR ──────────────────────────────────────
btnCloseModalKasir.addEventListener('click', closeKasirModal);
modalKasir.addEventListener('click', (e) => {
  if (e.target === modalKasir) closeKasirModal();
});

// ESC khusus modal kasir
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && modalKasir.classList.contains('is-open')) {
    closeKasirModal();
  }
});

// Inisialisasi saat halaman load — cache bisa sudah terisi atau masih kosong
updateKasirCardMetrics();

// ── EKSPORT KE GLOBAL SCOPE ────────────────────────────────────
// (Pola Fix #85/#86) — pemicu card di dashboard.js & tombol Fix #53
// di modul Pembelian mengakses via window.
window.openBarangModal = openBarangModal;
window.openKasirModal  = openKasirModal;
window.loadMasterBarang = loadMasterBarang;
window.getMasterBarangCache = getMasterBarangCache;
window.isKasir = isKasir;
