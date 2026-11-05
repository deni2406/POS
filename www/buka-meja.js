/**
 * meja-modal.js
 * Modul khusus untuk menangani UI modal ketika kasir memilih / membuka meja.
 * Menggunakan Vanilla JavaScript murni tanpa library tambahan.
 */

(function () {
  let nomorMejaAktif = 1;
  let modalElement = null;

  // Inisialisasi DOM modal secara dinamis saat skrip dimuat
  function initModal() {
    if (document.getElementById('mejaModalModular')) return;

    const overlay = document.createElement('div');
    overlay.id = 'mejaModalModular';
    overlay.className = 'meja-modal-overlay';
    
    // Styling inline/CSS modular agar konsisten dan langsung siap pakai tanpa mengubah file CSS lain
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
        }
        .meja-modal-overlay.show {
          opacity: 1;
          visibility: visible;
        }
        .meja-modal-card {
          background: #ffffff;
          width: 100%;
          max-width: 520px;
          border-radius: 16px;
          padding: 24px;
          box-shadow: 0 20px 40px rgba(0, 0, 0, 0.25);
          transform: scale(0.95);
          transition: transform 0.25s ease-in-out;
          box-sizing: border-box;
          font-family: inherit;
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
          font-size: 1.25rem;
          font-weight: 800;
          color: #111827;
          margin: 0;
          letter-spacing: 0.5px;
        }
        .meja-modal-close {
          background: none;
          border: none;
          font-size: 28px;
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
        }
        .meja-modal-input:focus {
          border-color: #3b82f6;
        }
        .meja-modal-grid-actions {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 12px;
          margin-bottom: 20px;
        }
        .meja-modal-action-btn {
          padding: 14px;
          font-size: 0.95rem;
          font-weight: 700;
          border: 2px dashed #9ca3af;
          border-radius: 10px;
          background: #f9fafb;
          color: #4b5563;
          cursor: pointer;
          transition: all 0.2s;
          text-align: center;
        }
        .meja-modal-action-btn:hover {
          background: #f3f4f6;
          border-color: #6b7280;
          color: #111827;
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
          <button class="meja-modal-action-btn" onclick="alert('Fitur tambah produk akan dibuka pada tahap berikutnya.')">
            + TAMBAH PRODUK
          </button>
          <button class="meja-modal-action-btn" onclick="alert('Fitur Member akan tersedia pada tahap berikutnya.')">
            MEMBER
          </button>
        </div>

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
          <button class="meja-modal-btn-mulai" onclick="konfirmasiMulaiMain()">MULAI MAIN</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);
    modalElement = overlay;

    // Tutup modal ketika mengklik area luar kartu (overlay)
    overlay.addEventListener('click', function(e) {
      if (e.target === overlay) {
        MejaModal.tutup();
      }
    });
  }

  // Fungsi internal untuk menetapkan nomor meja dan memperbarui teks judul
  function setNomorMeja(nomor) {
    nomorMejaAktif = nomor;
    initModal();
    const titleEl = document.getElementById('mejaModalTitle');
    if (titleEl) {
      const formattedNum = nomor < 10 ? '0' + nomor : nomor;
      titleEl.textContent = `BUKA MEJA ${formattedNum}`;
    }
  }

  // Fungsi publik: Membuka modal dengan nomor meja tertentu
  function buka(nomor) {
    setNomorMeja(nomor);
    const inputNama = document.getElementById('mejaModalInputNama');
    if (inputNama) {
      inputNama.value = '';
    }
    if (modalElement) {
      modalElement.classList.add('show');
      setTimeout(() => {
        if (inputNama) inputNama.focus();
      }, 100);
    }
  }

  // Fungsi publik: Menutup modal
  function tutup() {
    if (modalElement) {
      modalElement.classList.remove('show');
    }
  }

  // Fungsi publik: Mengambil nilai nama pemesan yang diinput kasir
  function getNamaPemesan() {
    const inputNama = document.getElementById('mejaModalInputNama');
    return inputNama ? inputNama.value.trim() : '';
  }

  // Placeholder interaksi tombol Mulai Main
  window.konfirmasiMulaiMain = function() {
    const nama = getNamaPemesan();
    if (!nama) {
      alert("Nama pemesan wajib diisi.");
      const inputNama = document.getElementById('mejaModalInputNama');
      if (inputNama) inputNama.focus();
      return;
    }
    alert(`Memulai sesi untuk Meja ${nomorMejaAktif} atas nama "${nama}". (Integrasi lanjut tahap berikutnya)`);
    tutup();
  };

  // Daftarkan ke objek global window sesuai spesifikasi
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