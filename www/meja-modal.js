/**
 * meja-modal.js
 * Modul khusus mandiri untuk menangani UI modal ketika kasir memilih MEJA KOSONG.
 * POS PollarBilliard
 */

(function () {
  let nomorMejaAktif = 1;
  let modalElement = null;

  // STATE DRAFT
  let draftProdukMeja = [];
  let durasiJamDraft = 0;

  // LISTENER DARI MEJA PRODUK MODAL
  window.addEventListener("mejaProdukDraftSaved", function(event) {
    draftProdukMeja = Array.isArray(event.detail?.draft) ? event.detail.draft : [];
    renderDraftSummary();
  });

  // LISTENER DARI MEMBER MODAL
  window.addEventListener("memberSelected", function(event) {
    const member = event.detail?.member || null;
    console.log("DEBUG MEMBER DIPILIH:", member);

    if (!member) return;

    const inputNama =
      document.getElementById("mejaModalInputNama");

    if (inputNama) {
      inputNama.value = member.nama || "";
      inputNama.dispatchEvent(new Event("input", {
        bubbles: true
      }));
    }
  });

  // Membuat dan menyuntikkan elemen modal beserta stylingnya secara mandiri ke DOM (Singleton)
  function initModal() {
    if (document.getElementById('mejaModal')) return;

    const overlay = document.createElement('div');
    overlay.id = 'mejaModal';
    overlay.className = 'meja-modal-overlay';

    overlay.innerHTML = `
      <style>
        .meja-modal-overlay {
          position: fixed;
          top: 0;
          left: 0;
          width: 100%;
          height: 100%;
          background: rgba(0, 0, 0, 0.6);
          display: flex;
          justify-content: center;
          align-items: center;
          z-index: 3000;
          opacity: 0;
          visibility: hidden;
          transition: all 0.25s ease-in-out;
          padding: 15px;
          box-sizing: border-box;
          font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        }
        .meja-modal-overlay.show {
          opacity: 1;
          visibility: visible;
        }
        .meja-modal-card {
          background: #ffffff;
          width: 100%;
          max-width: 480px;
          border-radius: 16px;
          padding: 24px;
          box-shadow: 0 20px 40px rgba(0, 0, 0, 0.25);
          transform: scale(0.95);
          transition: transform 0.25s ease-in-out;
          box-sizing: border-box;
        }
        .meja-modal-overlay.show .meja-modal-card {
          transform: scale(1);
        }
        .meja-modal-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 20px;
          border-bottom: 1px solid #e5e7eb;
          padding-bottom: 12px;
        }
        .meja-modal-title {
          font-size: 1.2rem;
          font-weight: 800;
          color: #111827;
          margin: 0;
          letter-spacing: 0.5px;
        }
        .meja-modal-close {
          background: none;
          border: none;
          font-size: 26px;
          line-height: 1;
          cursor: pointer;
          color: #6b7280;
          padding: 4px 8px;
          border-radius: 8px;
        }
        .meja-modal-close:hover {
          color: #111827;
          background: #f3f4f6;
        }
        .meja-modal-label {
          font-size: 0.85rem;
          font-weight: 700;
          color: #374151;
          margin-bottom: 8px;
          display: block;
          text-transform: uppercase;
        }
        .meja-modal-input {
          width: 100%;
          padding: 14px 16px;
          font-size: 1.05rem;
          border: 2px solid #d1d5db;
          border-radius: 10px;
          outline: none;
          box-sizing: border-box;
          transition: border-color 0.2s;
          margin-bottom: 20px;
          background: #f9fafb;
        }
        .meja-modal-input:focus {
          border-color: #3b82f6;
          background: #ffffff;
        }
        .meja-modal-grid-actions {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 12px;
          margin-bottom: 20px;
        }
        .meja-modal-action-btn {
          padding: 14px 10px;
          font-size: 0.9rem;
          font-weight: 700;
          border: 2px dashed #cbd5e1;
          border-radius: 10px;
          background: #f8fafc;
          color: #334155;
          cursor: pointer;
          transition: all 0.2s;
          text-align: center;
        }
        .meja-modal-action-btn:hover {
          background: #f1f5f9;
          border-color: #94a3b8;
          color: #0f172a;
        }
        
        /* STYLE UNTUK SUMMARY DRAFT */
        .meja-modal-draft-summary {
          background: #f8fafc;
          border: 1px dashed #cbd5e1;
          border-radius: 10px;
          padding: 14px 16px;
          margin-bottom: 20px;
          display: none;
        }
        .meja-modal-draft-title {
          font-size: 0.85rem;
          font-weight: 800;
          color: #1e293b;
          margin-bottom: 10px;
        }
        .meja-modal-draft-item {
          display: flex;
          justify-content: space-between;
          font-size: 0.9rem;
          color: #475569;
          margin-bottom: 4px;
        }
        .meja-modal-draft-divider {
          border-top: 1px dashed #cbd5e1;
          margin: 10px 0;
        }
        .meja-modal-draft-durasi {
          font-size: 0.95rem;
          font-weight: 800;
          color: #3b82f6;
          text-align: right;
        }

        .meja-modal-promo-box {
          background: #f8fafc;
          border: 1px solid #e2e8f0;
          border-radius: 10px;
          padding: 14px 16px;
          margin-bottom: 24px;
        }
        .meja-modal-promo-title {
          font-size: 0.85rem;
          font-weight: 800;
          color: #1e293b;
          margin-bottom: 8px;
          text-transform: uppercase;
        }
        .meja-modal-promo-list {
          margin: 0;
          padding-left: 18px;
          font-size: 0.9rem;
          color: #475569;
          line-height: 1.5;
        }
        .meja-modal-footer {
          display: flex;
          gap: 12px;
        }
        .meja-modal-btn-batal {
          flex: 1;
          padding: 14px;
          background: #f3f4f6;
          color: #374151;
          border: none;
          border-radius: 10px;
          font-size: 1rem;
          font-weight: 700;
          cursor: pointer;
          transition: background 0.2s;
        }
        .meja-modal-btn-batal:hover {
          background: #e5e7eb;
        }
        .meja-modal-btn-mulai {
          flex: 1;
          padding: 14px;
          background: #3b82f6;
          color: #ffffff;
          border: none;
          border-radius: 10px;
          font-size: 1rem;
          font-weight: 700;
          cursor: pointer;
          transition: background 0.2s;
        }
        .meja-modal-btn-mulai:hover {
          background: #2563eb;
        }
        .meja-modal-btn-mulai:disabled {
          background: #9ca3af;
          cursor: not-allowed;
        }
      </style>

      <div class="meja-modal-card">
        <div class="meja-modal-header">
          <h3 id="mejaModalTitle" class="meja-modal-title">BUKA MEJA 01</h3>
          <button class="meja-modal-close" onclick="MejaModal.tutup()">&times;</button>
        </div>

        <label class="meja-modal-label">NAMA PEMESAN</label>
        <input 
          id="mejaModalInputNama" 
          class="meja-modal-input" 
          type="text" 
          placeholder="Masukkan nama pemesan" 
          autocomplete="off"
        >

        <div class="meja-modal-grid-actions">
          <button class="meja-modal-action-btn" onclick="handleTambahProduk()">
            + TAMBAH PRODUK
          </button>
          <button class="meja-modal-action-btn" onclick="handleMember()">
            MEMBER
          </button>
        </div>

        <!-- AREA SUMMARY DRAFT -->
        <div id="mejaModalDraftSummary" class="meja-modal-draft-summary"></div>

        <div class="meja-modal-promo-box">
          <div class="meja-modal-promo-title">PROMO YANG BERLAKU</div>
          <ul class="meja-modal-promo-list">
            <li>Promo Senin</li>
            <li>Promo Member</li>
            <li>Paket Billiard</li>
          </ul>
        </div>

        <div class="meja-modal-footer">
          <button class="meja-modal-btn-batal" onclick="MejaModal.tutup()">BATAL</button>
          <button id="mejaModalBtnMulai" class="meja-modal-btn-mulai" onclick="handleMulaiMain()">MULAI MAIN</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);
    modalElement = overlay;

    // Menutup modal saat area latar belakang luar diklik
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) {
        MejaModal.tutup();
      }
    });

    // Menangani tombol Enter pada input nama pemesan
    const inputNama = document.getElementById('mejaModalInputNama');
    if (inputNama) {
      inputNama.addEventListener('keypress', function (e) {
        if (e.key === 'Enter') {
          handleMulaiMain();
        }
      });
    }
  }

  // Merender Ringkasan Produk dari Draft
  function renderDraftSummary() {
    const container = document.getElementById("mejaModalDraftSummary");
    if (!container) return;

    if (!draftProdukMeja || draftProdukMeja.length === 0) {
      container.style.display = "none";
      container.innerHTML = "";
      durasiJamDraft = 0;
      return;
    }

    durasiJamDraft = 0;
    let itemsHtml = "";

    draftProdukMeja.forEach(item => {
      // Hitung durasi jam HANYA berdasarkan produk billiard
      if (window.MejaProdukModal && typeof window.MejaProdukModal.isProdukBillard === "function") {
        if (window.MejaProdukModal.isProdukBillard(item)) {
          durasiJamDraft += item.qty;
        }
      }
      
      itemsHtml += `
        <div class="meja-modal-draft-item">
          <span>${item.nama} &times; ${item.qty}</span>
        </div>
      `;
    });

    container.innerHTML = `
      <div class="meja-modal-draft-title">PRODUK DIPILIH</div>
      ${itemsHtml}
      <div class="meja-modal-draft-divider"></div>
      <div class="meja-modal-draft-durasi">DURASI: ${durasiJamDraft} JAM</div>
    `;
    
    container.style.display = "block";
  }

  // Mengatur nomor meja aktif dan memperbarui judul modal secara dinamis
  function setNomorMeja(nomor) {
    nomorMejaAktif = nomor;
    initModal();
    const titleEl = document.getElementById('mejaModalTitle');
    if (titleEl) {
      const formattedNum = nomor < 10 ? '0' + nomor : nomor;
      titleEl.textContent = `BUKA MEJA ${formattedNum}`;
    }
  }

  // Membuka modal
  function buka(nomor) {
    setNomorMeja(nomor);
    const inputNama = document.getElementById('mejaModalInputNama');
    if (inputNama) {
      inputNama.value = '';
    }

    // RESET STATE DRAFT SAAT BUKA MEJA BARU
    draftProdukMeja = [];
    durasiJamDraft = 0;
    renderDraftSummary();

    if (modalElement) {
      modalElement.classList.add('show');
    }
  }

  // Menutup modal tanpa mengubah data/memanggil API
  function tutup() {
    if (modalElement) {
      modalElement.classList.remove('show');
    }
  }

  // Mengambil isi teks dari input nama pemesan
  function getNamaPemesan() {
    const inputNama = document.getElementById('mejaModalInputNama');
    return inputNama ? inputNama.value.trim() : '';
  }

  // Handler interaksi tombol TAMBAH PRODUK
  window.handleTambahProduk = function() {
    if (
      window.MejaProdukModal &&
      typeof window.MejaProdukModal.buka === "function"
    ) {
      window.MejaProdukModal.buka();
    } else {
      alert("Modul produk belum termuat. Silakan refresh aplikasi.");
    }
  };

  // Handler interaksi tombol MEMBER
  window.handleMember = function() {
    if (
      window.MemberModal &&
      typeof window.MemberModal.buka === "function"
    ) {
      window.MemberModal.buka();
    } else {
      alert("Modul Member belum termuat. Silakan refresh aplikasi.");
    }
  };

  // Handler interaksi tombol MULAI MAIN dengan proteksi double-click dan bridge
  async function handleMulaiMain() {
    const namaPemesan = getNamaPemesan();
    if (!namaPemesan) {
      alert("Nama pemesan wajib diisi.");
      const inputNama = document.getElementById('mejaModalInputNama');
      if (inputNama) {
        inputNama.focus();
      }
      return;
    }

    // Validasi produk billiard wajib dipilih dan durasi minimal 1 jam
    if (durasiJamDraft < 1) {
      alert("Silakan pilih paket billiard terlebih dahulu.");
      return;
    }

    if (typeof window.bukaMejaDariModalBaru !== "function") {
      alert("Modul buka meja belum siap. Silakan refresh aplikasi.");
      return;
    }

    const btnMulai = document.getElementById('mejaModalBtnMulai');
    
    try {
      // Cegah klik berulang (double click)
      if (btnMulai) {
        btnMulai.disabled = true;
        btnMulai.textContent = "MEMPROSES...";
      }

      const hasilBridge = await window.bukaMejaDariModalBaru(
        nomorMejaAktif,
        namaPemesan,
        durasiJamDraft,
        draftProdukMeja
      );

      // Jika bridge mengembalikan true, tutup modal
      if (hasilBridge === true) {
        tutup();
      }
    } catch (error) {
      console.error("Gagal membuka meja melalui bridge:", error);
      alert("Meja gagal dibuka. Silakan coba lagi.");
    } finally {
      // Kembalikan tombol ke keadaan semula jika gagal atau selesai
      if (btnMulai) {
        btnMulai.disabled = false;
        btnMulai.textContent = "MULAI MAIN";
      }
    }
  }

  window.handleMulaiMain = handleMulaiMain;

  // Expose API global sesuai spesifikasi
  window.MejaModal = {
    buka,
    tutup,
    setNomorMeja,
    getNamaPemesan
  };

  // Inisialisasi awal saat DOM siap
  document.addEventListener('DOMContentLoaded', () => {
    initModal();
  });
})();