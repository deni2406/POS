// ============================================================
// PBMS ADMIN — MODUL PEMBELIAN (Cart Restok & PO Management)
// (dipisahkan dari dashboard.js, pola Fix #81/#84/#86/#87)
// Helper mandiri berawalan `pembelian*` agar tidak memicu
// ReferenceError — modul ini berdiri sendiri.
//
// Sub-modul yang dikelola file ini:
//   1. Cart Restok Barang (Fix #45/#46)
//   2. Pengelolaan Purchase Order / PO (Fix #54/#55)
// ============================================================

// Helper format rupiah — identik dengan dashboard.js
const pembelianFormatRupiah = (num) =>
  'Rp ' + (num || 0).toLocaleString('id-ID');

// Helper format angka — identik dengan dashboard.js
const pembelianFormatNumber = (num) =>
  (num || 0).toLocaleString('id-ID');

// Helper escape HTML — identik dengan global di dashboard.js
const pembelianEscapeHtml = (str) =>
  String(str ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));

// ── ELEMEN MODAL PEMBELIAN ─────────────────────────────────────
const modalPembelian        = document.getElementById('modalPembelian');
const btnCloseModalPem      = document.getElementById('btnCloseModalPembelian');
const pemSearchBarang       = document.getElementById('pemSearchBarang');
const pemQty                = document.getElementById('pemQty');
const pemHppBaru            = document.getElementById('pemHppBaru');
const pemHjBaru             = document.getElementById('pemHjBaru');
const btnPemAddItem         = document.getElementById('btnPemAddItem');
const pemSearchResults      = document.getElementById('pemSearchResults');
const pemCartBody           = document.getElementById('pemCartBody');
const pemCartCount          = document.getElementById('pemCartCount');
const pemSumVariasi         = document.getElementById('pemSumVariasi');
const pemSumQty             = document.getElementById('pemSumQty');
const pemSumModal           = document.getElementById('pemSumModal');
const pemSumMargin          = document.getElementById('pemSumMargin');
const pemCatatKasKeluar     = document.getElementById('pemCatatKasKeluar');
const btnPemCheckout        = document.getElementById('btnPemCheckout');
const pemKategoriTab        = document.getElementById('pemKategoriTab');
const pemKategoriBadge      = document.getElementById('pemKategoriBadge');

// ── ELEMEN PANEL DAFTAR PO ─────────────────────────────────────
const selectPoStatus        = document.getElementById('selectPoStatus');
const btnPoRefresh          = document.getElementById('btnPoRefresh');
const poListBody            = document.getElementById('poListBody');

// ── STATE MODUL ───────────────────────────────────────────────
let pemCart = []; // [{ barang_id, nama, stok, kategori, hpp_lama, hj_lama, hpp_baru, hj_baru, qty }]
let pemActiveKategori = 'KASIR'; // (Fix #46) kategori tab aktif — filter pencarian
let editingPoId = null; // (Fix #55) reference PO yang sedang diedit di modal pembelian
let editingPoNo = '';   // (Fix #55) no_po untuk notifikasi sukses

// ── FUNGSI: TAB KATEGORI (Fix #46) ─────────────────────────────
const pembelianSetPemKategori = (kat) => {
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
  if (modalPembelian) modalPembelian._selectedBarang = null;
  // Bersihkan hasil pencarian yang tersisa
  if (pemSearchBarang) pemSearchBarang.value = '';
  if (pemSearchResults) { pemSearchResults.hidden = true; pemSearchResults.innerHTML = ''; }
  if (pemHppBaru) pemHppBaru.value = '';
  if (pemHjBaru)  pemHjBaru.value  = '';
  // Re-render cart (filter sesuai kategori aktif)
  pembelianRenderPemCart();
};

if (pemKategoriTab) {
  pemKategoriTab.querySelectorAll('.pem-kategori-tab__btn').forEach(btn => {
    btn.addEventListener('click', () => pembelianSetPemKategori(btn.dataset.pemKategori));
  });
}

// ── FUNGSI: OPEN / CLOSE MODAL PEMBELIAN ──────────────────────
const pembelianOpenModal = () => {
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
  pembelianResetPoEditMode();
  pembelianRenderPemCart();
};

// (Fix #55) Reset mode edit PO — kembalikan label tombol & state normal
const pembelianResetPoEditMode = () => {
  editingPoId = null;
  editingPoNo = '';
  if (btnPemCheckout) btnPemCheckout.textContent = 'Simpan & Buat Nomor PO';
  const pemTitle = document.getElementById('modalPembelianTitle');
  if (pemTitle) pemTitle.textContent = 'Restok Barang / Purchase Cart';
};

const pembelianCloseModal = () => {
  if (!modalPembelian) return;
  modalPembelian.classList.remove('is-open');
  modalPembelian.setAttribute('hidden', '');
  modalPembelian.setAttribute('aria-hidden', 'true');
  document.body.style.overflow = '';
  // (Fix #55) Reset mode edit & bersihkan cart
  pembelianResetPoEditMode();
  pemCart = [];
  pembelianRenderPemCart();
};

// ── FUNGSI: ALERT PEMBELIAN ───────────────────────────────────
const pembelianShowAlert = (kind, msg) => {
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

// ── FUNGSI: SEARCH BARANG ──────────────────────────────────────
const pemSearchTimer = {};
if (pemSearchBarang) {
  pemSearchBarang.addEventListener('input', () => {
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
            <span class="pembelian-search-item__nama">${pembelianEscapeHtml(b.nama_barang || '')}</span>
            <span class="pembelian-search-item__meta">
              <span>${pembelianEscapeHtml(b.kode_barang || '')}</span>
              <span>Stok: ${b.stok || 0}</span>
              <span>HPP: ${pembelianFormatRupiah(b.harga_modal)}</span>
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
          '<div class="pembelian-search-empty">Gagal memuat: ' + pembelianEscapeHtml(err.message) + '</div>';
      }
    }, 250);
  });
}

// ── FUNGSI: TAMBAH ITEM KE CART ───────────────────────────────
const pembelianAddItem = () => {
  const b = modalPembelian?._selectedBarang;
  if (!b) { pembelianShowAlert('danger', 'Pilih barang dulu dari pencarian.'); return; }
  const qty = Number(pemQty.value) || 0;
  if (qty < 1) { pembelianShowAlert('danger', 'Qty minimal 1.'); return; }
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
  pembelianRenderPemCart();
};

const pembelianRemoveItem = (barangId) => {
  pemCart = pemCart.filter(c => c.barang_id !== barangId);
  pembelianRenderPemCart();
};

// ── FUNGSI: RENDER CART ────────────────────────────────────────
const pembelianRenderPemCart = () => {
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
        pembelianEscapeHtml(pemActiveKategori) + ' kosong (' + lain + ' item kategori lain tersimpan).</td></tr>'
      : '<tr class="tx-table__empty"><td colspan="8">Belum ada item di keranjang.</td></tr>';
  } else {
    pemCartBody.innerHTML = visibleCart.map(c => `
      <tr>
        <td>${pembelianEscapeHtml(c.nama)}</td>
        <td><span class="pem-kategori-chip">${pembelianEscapeHtml(c.kategori || pemActiveKategori)}</span></td>
        <td class="num">${c.stok}</td>
        <td class="num"><input type="number" class="pem-qty-input" min="1" value="${c.qty}" data-pem-barang="${c.barang_id}"></td>
        <td class="num">${pembelianFormatRupiah(c.hpp_baru)}</td>
        <td class="num">${pembelianFormatRupiah(c.hj_baru)}</td>
        <td class="num pem-subtotal-cell" data-pem-subtotal="${c.barang_id}">${pembelianFormatRupiah(c.hpp_baru * c.qty)}</td>
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
  if (pemSumModal)   pemSumModal.textContent   = pembelianFormatRupiah(totalModal);
  if (pemSumMargin)  pemSumMargin.textContent  =
    marginPct === '—' ? '—' : (100 - Number(marginPct)).toFixed(1) + '%';

  // Enable/disable checkout — checkout kirim SEMUA kategori (data utuh)
  if (btnPemCheckout) btnPemCheckout.disabled = !pemCart.length;

  // Bind event listeners
  if (pemCartBody) {
    pemCartBody.querySelectorAll('[data-pem-rm]').forEach(btn => {
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const id = Number(btn.dataset.pemRm);
        pembelianRemoveItem(id);
      });
    });
    // (Qty interaktif) input Qty per item → update pemCart + subtotal + summary footer
    pemCartBody.querySelectorAll('.pem-qty-input').forEach(inp => {
      inp.addEventListener('change', (ev) => {
        const barangId = Number(ev.target.dataset.pemBarang);
        const newQty = Number(ev.target.value) || 1;
        const item = pemCart.find(c => c.barang_id === barangId);
        if (!item) return;
        item.qty = newQty;
        pembelianRenderPemCart();
      });
    });
  }
};

// ── FUNGSI: SUBMIT PEMBELIAN (CREATE/EDIT PO) ─────────────────
const pembelianSubmit = async () => {
  if (!pemCart.length || !btnPemCheckout) return;

  const adminName = sessionStorage.getItem('pbms_admin_session') || 'admin';
  if (!adminName) { pembelianShowAlert('danger', 'Sesi admin tidak valid.'); return; }

  // (Fix #46) Filter items sesuai kategori aktif
  const itemsKategori = pemCart.filter(c =>
    (c.kategori || '').toUpperCase() === pemActiveKategori
  );
  if (!itemsKategori.length) {
    pembelianShowAlert('danger',
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
      pembelianShowAlert('success',
        'PO ' + (data.no_po || editingPoNo || '') + ' berhasil diperbarui. ' +
        data.item_count + ' item, total modal ' +
        pembelianFormatRupiah(data.total_modal || 0) + '.');
      // Reset cart & mode edit
      pemCart = [];
      pembelianResetPoEditMode();
      pembelianRenderPemCart();
      pembelianLoadPoList();
      pembelianCloseModal();
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
    pembelianShowAlert('success',
      'PO ' + (data.no_po || data.nota_no || '') + ' dibuat ' +
      '(status PENDING). ' +
      data.item_count + ' item, total modal ' +
      pembelianFormatRupiah(data.total_modal || 0) +
      '. Stok belum ditambah — akan bertambah saat PO DITERIMA.');
    // Hapus item kategori yang sudah diproses; kategori lain tetap tersimpan
    pemCart = pemCart.filter(c =>
      (c.kategori || '').toUpperCase() !== pemActiveKategori
    );
    pembelianRenderPemCart();
    // Refresh master barang & daftar PO (stok tidak berubah, tapi PO list perlu update)
    if (typeof window.loadMasterBarang === 'function') window.loadMasterBarang();
    pembelianLoadPoList();
  } catch (err) {
    pembelianShowAlert('danger', err.message || 'Gagal proses restok. Coba lagi.');
  } finally {
    if (btnPemCheckout) {
      btnPemCheckout.disabled = !pemCart.length;
      // (Fix #55) Kembalikan label sesuai mode
      btnPemCheckout.textContent = editingPoId ? 'Simpan Perubahan PO' : 'Simpan & Buat Nomor PO';
    }
  }
};

// ── FUNGSI: LOAD & RENDER DAFTAR PO (Fix #54) ─────────────────
const pembelianLoadPoList = async () => {
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
      return '<span class="po-status">' + pembelianEscapeHtml(s || '—') + '</span>';
    };

    poListBody.innerHTML = rows.map(po => `
      <tr data-po-id="${po.id}">
        <td>${pembelianEscapeHtml(po.no_po || '—')}</td>
        <td>${pembelianEscapeHtml(po.kategori_target || '—')}</td>
        <td class="num">${po.item_count}</td>
        <td class="num">${po.total_qty}</td>
        <td class="num">${pembelianFormatRupiah(po.total_modal)}</td>
        <td>${pembelianEscapeHtml(po.created_at || '—')}</td>
        <td>${statusBadge(po.status)}</td>
        <td class="col-aksi">
          ${po.status === 'PENDING'
            ? '<div class="po-action-group">' +
              '<button type="button" class="btn-po-edit" data-po-edit="' +
              po.id + '" aria-label="Edit PO ' + pembelianEscapeHtml(po.no_po || '') + '">Edit</button>' +
              '<button type="button" class="btn-po-batal" data-po-batal="' +
              po.id + '" aria-label="Batalkan PO ' + pembelianEscapeHtml(po.no_po || '') + '">Batalkan</button>' +
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
          await pembelianLoadPoList();
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
          await pembelianOpenPoEditModal(poId, btn);
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
      pembelianEscapeHtml(err.message) + '</td></tr>';
  }
};

// (Fix #55) Buka modal pembelian dengan data PO yang sudah dimuat
const pembelianOpenPoEditModal = async (poId, triggerBtn) => {
  const resp = await fetch('/api/admin/pembelian/po/' + poId + '/detail');
  const data = await resp.json();
  if (!resp.ok || !data.success) throw new Error(data.message || 'Gagal muat detail PO.');

  const po = data.po;
  const items = data.items || [];
  editingPoId = po.id;
  editingPoNo = po.no_po || '';

  // Set kategori tab ke kategori_target PO (fallback KASIR)
  const kategori = po.kategori_target || 'KASIR';
  pembelianSetPemKategori(kategori);

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
  pembelianRenderPemCart();

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

// ── EVENT LISTENERS ─────────────────────────────────────────────
if (btnPemAddItem) btnPemAddItem.addEventListener('click', pembelianAddItem);
if (btnPemCheckout) btnPemCheckout.addEventListener('click', pembelianSubmit);
if (btnCloseModalPem) btnCloseModalPem.addEventListener('click', pembelianCloseModal);
if (modalPembelian) modalPembelian.addEventListener('click', (e) => {
  if (e.target === modalPembelian) pembelianCloseModal();
});

// ESC untuk tutup modal pembelian
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && modalPembelian && modalPembelian.classList.contains('is-open')) {
    pembelianCloseModal();
    e.stopPropagation();
  }
});

// Trigger lama: stat card "Restok Barang" buka modal pembelian
// (card disembunyikan di Fix #91 — listener tetap aman via guard null)
const cardPembelian = document.getElementById('cardPembelian');
if (cardPembelian) {
  cardPembelian.addEventListener('click', pembelianOpenModal);
}

// Trigger baru (Fix #91): tombol "+ Buka Cart Restok" di #panel-restok
const btnBukaRestok = document.getElementById('btnBukaRestok');
if (btnBukaRestok) {
  btnBukaRestok.addEventListener('click', pembelianOpenModal);
}

// (Fix #91) Export refresher daftar PO untuk tab switching di dashboard.js
window.__pembelianLoadPoList = pembelianLoadPoList;

// PO panel listeners
if (selectPoStatus) selectPoStatus.addEventListener('change', pembelianLoadPoList);
if (btnPoRefresh) btnPoRefresh.addEventListener('click', pembelianLoadPoList);
// Init — muat daftar PO saat halaman load
pembelianLoadPoList();

// ── BRIDGE PUBLIK UNTUK DASHBOARD.JS (Fix #53) ────────────────
// Fungsi ini dipanggil oleh dashboard.js ketika tombol Cek Stok Kritis
// ditekan. Terima daftar barang kritis, atur kategori KASIR, isi cart,
// dan buka modal pembelian.
window.openPembelianForCritical = (criticalItems) => {
  if (!Array.isArray(criticalItems) || !criticalItems.length) return;
  // Reset ke mode baru (tidak mengedit PO)
  editingPoId = null;
  editingPoNo = '';
  pemCart = criticalItems.map(item => ({
    barang_id: item.id,
    nama: item.nama_barang || '',
    stok: Number(item.stok) || 0,
    kategori: 'KASIR',
    hpp_lama: item.harga_modal || 0,
    hj_lama:  item.harga_jual  || 0,
    hpp_baru: item.harga_modal || 0,
    hj_baru:  item.harga_jual  || 0,
    qty: 10,
  }));
  pembelianSetPemKategori('KASIR');
  pembelianRenderPemCart();
  pembelianOpenModal();
};

// Eksport fungsi publik ke window agar bisa diakses dashboard.js
window.openPembelianModal = pembelianOpenModal;
window.pembelianSetPemKategori = pembelianSetPemKategori;
