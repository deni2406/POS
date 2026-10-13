// ============================================================
// PBMS ADMIN — MODUL PEMBELIAN BANK (Fix #92)
// Dipisahkan dari dashboard.js (blok Fix #77, baris ~1457–1584).
//
// TUGAS:
//   1. Form pengeluaran bank (kategori, nama, nominal, keterangan)
//   2. Tabel riwayat pengeluaran bank (filter q + kategori, debounce 250 ms)
//   3. Bridge refresh: window.__loadPengeluaranBank — dipanggil
//      oleh dashboard.js saat tab panel-pembelian-bank aktif.
//
// DEPENDENSI:
//   escapeHtml  — lokal (identik dengan dashboard.js)
//   safeAddEvt  — lokal (identik dengan dashboard.js)
//   pbTglJam    — lokal, implementasi identik fmtTglJam di bank.js
//
// CATATAN:
//   - Tidak ada state internal yang diekspor selain
//     window.__loadPengeluaranBank (untuk navigasi tab).
//   - API: GET /api/admin/pengeluaran-bank, POST /api/admin/pengeluaran-bank
//   - Jangan mengubah aturan bisnis atau payload di sini.
// ============================================================

// ── Helper lokal (jangan eksport ke window — cukup untuk modul ini) ─────
const pbEscapeHtml = (str) =>
  String(str ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));

const pbSafeAddEvt = (elementId, eventType, handler) => {
  const elem = typeof elementId === 'string'
    ? document.getElementById(elementId)
    : elementId;
  if (elem && typeof elem.addEventListener === 'function' && typeof handler === 'function') {
    elem.removeEventListener(eventType, handler);
    elem.addEventListener(eventType, handler);
  }
};

// (Fix #92) Format tgl+jam — implementasi identik dengan fmtTglJam di bank.js
// karena fmtTglJam adalah const lokal (tidak terleak ke window) dan
// pembelian-bank.js dipanggil sebelum bank.js dalam urutan script.
const pbTglJam = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '—'
    : d.toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' })
      + ' ' + d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
};

// ── ELEMEN DOM PEMBELIAN BANK ──────────────────────────────────────────────
const pbForm           = document.getElementById('formPengeluaranBank');
const pbTableBody      = document.getElementById('pbTableBody');
const pbBankSaldoDisplay = document.getElementById('pbBankSaldoDisplay');
const pbAlertBox       = document.getElementById('pbAlert');
const pbKategori       = document.getElementById('pbKategori');
const pbNama           = document.getElementById('pbNama');
const pbNominal        = document.getElementById('pbNominal');
const pbKeterangan     = document.getElementById('pbKeterangan');
const pbFilterQ        = document.getElementById('pbFilterQ');
const pbFilterKategori = document.getElementById('pbFilterKategori');
let   pbSearchTimeout  = null;

// ── LABEL KATEGORI (Fix #77) ───────────────────────────────────────────────
const PB_KATEGORI_LABEL = {
  LISTRIK_LUAR:       'Listrik Luar',
  LISTRIK_DALAM:      'Listrik Dalam',
  PERLENGKAPAN_DAPUR: 'Perlengkapan / Operasional Dapur',
  PERLENGKAPAN_BAR:   'Perlengkapan / Operasional Bar',
  PERLENGKAPAN_KASIR: 'Perlengkapan / Operasional Kasir',
  PERLENGKAPAN_BILLIARD: 'Perlengkapan Billiard',
  LAINNYA:            'Lainnya',
};

// ── FORMATTER NOMINAL ────────────────────────────────────────────────────��─
const pbRupiah = (n) => 'Rp ' + Number(n || 0).toLocaleString('id-ID');

// ── FORMAT / PARSE NOMINAL INPUT (Fix #97) ────────────────────────────────
// Format angka dengan pemisah ribuan titik (id-ID) saat user mengetik.
// Kursor dipertahankan relatif terhadap digit agar edit tengah nyaman.
const pbFormatNominal = (input) => {
  if (!input) return;
  const raw = String(input.value ?? '').replace(/\D/g, '');
  const formatted = raw ? Number(raw).toLocaleString('id-ID') : '';
  if (formatted === input.value) return;
  // Jumlah digit sebelum posisi kursor (untuk meletakkan kursor kembali)
  const pos = input.selectionStart ?? raw.length;
  const digitsBefore = (String(input.value ?? '').slice(0, pos).match(/\d/g) || []).length;
  let caret = formatted.length;
  let seen = 0;
  for (let i = 0; i < formatted.length; i++) {
    if (/\d/.test(formatted[i])) {
      if (seen === digitsBefore) { caret = i; break; }
      seen++;
    }
  }
  input.value = formatted;
  input.setSelectionRange(caret, caret);
};

// Bersihkan pemisah titik → angka bulat untuk payload API (1.500.000 → 1500000)
const pbParseNominal = (val) => Math.round(Number(String(val ?? '').replace(/\./g, '')) || 0);

// ── FORMATTER NAMA ADMIN (Fix #96) ────────────────────────────────────────
// Normalisasi identitas admin dari field created_by yang mungkin berupa:
// - String biasa (nama admin)
// - Objek admin { username, nama, ... }
// - String JSON yang harus di-parse
// - null/undefined/empty → fallback 'admin'
const pbFormatAdmin = (val) => {
  if (val === null || val === undefined || val === '') return 'admin';

  // Jika sudah objek, ekstrak field
  if (typeof val === 'object') {
    const nama = String(val.nama || '').trim();
    const username = String(val.username || '').trim();
    // Prioritas: nama > username > 'admin'
    return nama || username || 'admin';
  }

  // Jika string, coba parse sebagai JSON
  if (typeof val === 'string') {
    const trimmed = val.trim();
    // Jika string kosong setelah trim → 'admin'
    if (!trimmed) return 'admin';

    // Coba parse sebagai JSON objek
    if (trimmed.startsWith('{')) {
      try {
        const obj = JSON.parse(trimmed);
        // Hanya terima objek (bukan array / primitive)
        if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
          const nama = String(obj.nama || '').trim();
          const username = String(obj.username || '').trim();
          return nama || username || 'admin';
        }
      } catch (e) {
        // JSON tidak valid → fallback
        return 'admin';
      }
      // Parse berhasil tapi bukan objek valid → fallback
      return 'admin';
    }

    // Jika string biasa (bukan JSON), kembalikan apa adanya
    return trimmed;
  }

  // Tipe data lain → fallback
  return 'admin';
};

// ── ALERT BOX (timeout 5 dtk) ─────────────────────────────────────────────
const showPbAlert = (kind, msg) => {
  if (!pbAlertBox) return;
  pbAlertBox.className = 'bank-alert-box ' + (kind === 'success' ? 'is-success' : 'is-danger');
  pbAlertBox.textContent = msg;
  pbAlertBox.hidden = false;
  clearTimeout(showPbAlert._t);
  showPbAlert._t = setTimeout(() => { pbAlertBox.hidden = true; }, 5000);
};

// ── LOAD RIWAYAT PEMBELIAN BANK ───────────────────────────────────────────
const loadPengeluaranBank = async () => {
  const kategori = pbFilterKategori ? pbFilterKategori.value : '';
  const q = pbFilterQ ? pbFilterQ.value.trim() : '';
  try {
    const url = '/api/admin/pengeluaran-bank' +
      (kategori ? ('?kategori=' + encodeURIComponent(kategori)) : '') +
      (q ? ((kategori ? '&' : '?') + 'q=' + encodeURIComponent(q)) : '');
    const resp = await fetch(url);
    const data = await resp.json();
    if (!data.success) throw new Error(data.message || 'Gagal memuat');
    if (data.saldo_bank_saat_ini !== undefined) {
      const elSaldo = pbBankSaldoDisplay ||
        document.getElementById('pbSaldoBank') ||
        document.querySelector('#sumberDanaBadge');
      if (elSaldo) elSaldo.textContent = 'Saldo Bank: ' + pbRupiah(data.saldo_bank_saat_ini);
    }
    const rows = data.data || [];
    if (!rows.length) {
      pbTableBody.innerHTML = '<tr><td colspan="6" class="text-center">Belum ada pengeluaran bank</td></tr>';
      return;
    }
    pbTableBody.innerHTML = rows.map((r, i) => {
      const ket = r.keterangan ? '<div class="pb-keterangan">' + pbEscapeHtml(r.keterangan) + '</div>' : '';
      return '<tr>' +
        '<td class="col-no">' + (i + 1) + '</td>' +
        '<td class="time">' + pbEscapeHtml(pbTglJam(r.tanggal)) + '</td>' +
        '<td>' + pbEscapeHtml(PB_KATEGORI_LABEL[r.kategori] || r.kategori || '') + '</td>' +
        '<td><strong>' + pbEscapeHtml(r.nama_barang) + '</strong>' + ket + '</td>' +
        '<td class="col-num">' + pbRupiah(r.nominal) + '</td>' +
        '<td>' + pbEscapeHtml(pbFormatAdmin(r.created_by)) + '</td>' +
        '</tr>';
    }).join('');
  } catch (err) {
    pbTableBody.innerHTML = '<tr><td colspan="6" class="text-center">Gagal memuat: ' + pbEscapeHtml(err.message) + '</td></tr>';
  }
};

// ── SUBMIT FORM PENYIMPANAN PEMBELIAN BANK ────────────────────────────────
const submitPengeluaranBank = async (e) => {
  e.preventDefault();
  const adminName = sessionStorage.getItem('pbms_admin_session') || 'admin';
  const kategori = pbKategori.value;
  const nama = pbNama.value.trim();
  // Fix #97: nilai input kini berisi pemisah titik (mis. 1.500.000) —
  // bersihkan jadi angka bulat sebelum validasi & payload API.
  const nominal = pbParseNominal(pbNominal.value);
  const keterangan = pbKeterangan.value.trim();

  if (!nama) { showPbAlert('danger', 'Nama barang / item wajib diisi.'); return; }
  if (!(nominal > 0)) { showPbAlert('danger', 'Nominal harus > 0.'); return; }

  const btn = document.getElementById('btnSimpanPengeluaranBank');
  if (btn) { btn.disabled = true; btn.textContent = 'Memproses…'; }
  try {
    const resp = await fetch('/api/admin/pengeluaran-bank', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kategori, nama_barang: nama, nominal, keterangan, admin_name: adminName,
      }),
    });
    const data = await resp.json();
    if (!resp.ok || !data.success) {
      if (data.code === 'SALDO_BANK_TIDAK_CUKUP') {
        showPbAlert('danger',
          'Saldo bank tidak cukup (Saldo: Rp ' +
          Number(data.saldo_bank_saat_ini || 0).toLocaleString('id-ID') + ').');
      } else {
        showPbAlert('danger', data.message || 'Gagal menyimpan.');
      }
      return;
    }
    showPbAlert('success',
      'Pengeluaran bank tersimpan. Saldo kini: ' + pbRupiah(data.saldo_bank_saat_ini) + '.');
    pbNama.value = ''; pbNominal.value = ''; pbKeterangan.value = '';
    await loadPengeluaranBank();
  } catch (err) {
    showPbAlert('danger', 'Gagal menyimpan: ' + err.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'SIMPAN PEMBELIAN'; }
  }
};

// ── EVENT LISTENER ─────────────────────────────────────────────────────────
if (pbForm) {
  pbSafeAddEvt(pbForm, 'submit', submitPengeluaranBank);
}
// (Fix #97) Format input nominal saat ketik: angka → 1.500.000
if (pbNominal) {
  pbSafeAddEvt(pbNominal, 'input', () => pbFormatNominal(pbNominal));
}
if (pbFilterQ) {
  pbSafeAddEvt(pbFilterQ, 'input', () => {
    clearTimeout(pbSearchTimeout);
    pbSearchTimeout = setTimeout(loadPengeluaranBank, 250);
  });
}
if (pbFilterKategori) {
  pbSafeAddEvt(pbFilterKategori, 'change', loadPengeluaranBank);
}

// ── INIT: muat riwayat saat halaman load ───────────────────────────────────
loadPengeluaranBank();

// ── BRIDGE PUBLIK UNTUK DASHBOARD.JS (Fix #92) ───────────────────────────
// Dipanggil oleh handler tab di dashboard.js ketika
// tab panel-pembelian-bank aktif, agar refresh berjalan
// di modul ini tanpa akses fungsi lokal dashboard.js.
window.__loadPengeluaranBank = loadPengeluaranBank;
