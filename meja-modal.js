/**
 * meja-modal.js
 * Modul khusus mandiri untuk menangani UI modal ketika kasir memilih MEJA KOSONG,
 * serta modul untuk MEJA KARYAWAN.
 * POS PollarBilliard
 */

(function () {
  let nomorMejaAktif = 1;
  let modalElement = null;

  // STATE DRAFT & MODE
  let draftProdukMeja = [];
  let durasiJamDraft = 0;
  let modeSesiModal = "DURASI";

  // STATE MEJA KARYAWAN
  let statusMejaSistemCache = {};
  let karyawanModalElement = null;
  let karyawanKonfirmasiElement = null;
  let karyawanAuthElement = null;
  let nomorMejaKaryawanAktif = null;

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

  // Mengatur Mode Sesi Modal (DURASI vs LOSS)
  function setModeSesiModal(mode) {
    modeSesiModal = (mode === "LOSS") ? "LOSS" : "DURASI";
    
    const cardDurasi = document.getElementById("mejaModalModeDurasi");
    const cardLoss = document.getElementById("mejaModalModeLoss");
    const lossInfo = document.getElementById("mejaModalLossInfo");

    if (modeSesiModal === "LOSS") {
      if (cardLoss) {
        cardLoss.style.borderColor = "#059669";
        cardLoss.style.background = "#ecfdf5";
        const divs = cardLoss.querySelectorAll('div');
        if (divs.length > 0) divs[0].style.color = "#065f46";
      }
      if (cardDurasi) {
        cardDurasi.style.borderColor = "#e5e7eb";
        cardDurasi.style.background = "#ffffff";
        const divs = cardDurasi.querySelectorAll('div');
        if (divs.length > 0) divs[0].style.color = "#374151";
      }
      if (lossInfo) {
        lossInfo.style.display = "block";
      }
    } else {
      if (cardDurasi) {
        cardDurasi.style.borderColor = "#2563eb";
        cardDurasi.style.background = "#eff6ff";
        const divs = cardDurasi.querySelectorAll('div');
        if (divs.length > 0) divs[0].style.color = "#1e40af";
      }
      if (cardLoss) {
        cardLoss.style.borderColor = "#e5e7eb";
        cardLoss.style.background = "#ffffff";
        const divs = cardLoss.querySelectorAll('div');
        if (divs.length > 0) divs[0].style.color = "#374151";
      }
      if (lossInfo) {
        lossInfo.style.display = "none";
      }
    }
  }

  window.setModeSesiModal = setModeSesiModal;

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
          align-items: flex-start;
          z-index: 3000;
          opacity: 0;
          visibility: hidden;
          transition: all 0.25s ease-in-out;
          padding: 12px;
          box-sizing: border-box;
          overflow-y: auto;
          -webkit-overflow-scrolling: touch;
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
          padding: 16px 18px;
          margin: auto;
          max-height: 85vh;
          max-height: calc(100dvh - 24px);
          overflow-y: auto;
          -webkit-overflow-scrolling: touch;
          box-shadow: 0 20px 40px rgba(0, 0, 0, 0.25);
          transform: scale(0.95);
          transition: transform 0.25s ease-in-out;
          box-sizing: border-box;
          display: flex;
          flex-direction: column;
        }
        .meja-modal-overlay.show .meja-modal-card {
          transform: scale(1);
        }
        .meja-modal-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 12px;
          border-bottom: 1px solid #e5e7eb;
          padding-bottom: 8px;
          flex-shrink: 0;
        }
        .meja-modal-title {
          font-size: 1.1rem;
          font-weight: 800;
          color: #111827;
          margin: 0;
          letter-spacing: 0.5px;
        }
        .meja-modal-close {
          background: none;
          border: none;
          font-size: 24px;
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
          font-size: 0.8rem;
          font-weight: 700;
          color: #374151;
          margin-bottom: 6px;
          display: block;
          text-transform: uppercase;
        }
        .meja-modal-input {
          width: 100%;
          padding: 10px 12px;
          font-size: 0.95rem;
          border: 2px solid #d1d5db;
          border-radius: 10px;
          outline: none;
          box-sizing: border-box;
          transition: border-color 0.2s;
          margin-bottom: 12px;
          background: #f9fafb;
        }
        .meja-modal-input:focus {
          border-color: #3b82f6;
          background: #ffffff;
        }
        .meja-modal-grid-actions {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 10px;
          margin-bottom: 12px;
        }
        .meja-modal-action-btn {
          padding: 10px 8px;
          font-size: 0.85rem;
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
          padding: 10px 12px;
          margin-bottom: 12px;
          display: none;
        }
        .meja-modal-draft-title {
          font-size: 0.8rem;
          font-weight: 800;
          color: #1e293b;
          margin-bottom: 6px;
        }
        .meja-modal-draft-item {
          display: flex;
          justify-content: space-between;
          font-size: 0.85rem;
          color: #475569;
          margin-bottom: 4px;
        }
        .meja-modal-draft-divider {
          border-top: 1px dashed #cbd5e1;
          margin: 8px 0;
        }
        .meja-modal-draft-durasi {
          font-size: 0.88rem;
          font-weight: 800;
          color: #3b82f6;
          text-align: right;
        }

        .meja-modal-promo-box {
          background: #f8fafc;
          border: 1px solid #e2e8f0;
          border-radius: 10px;
          padding: 10px 12px;
          margin-bottom: 16px;
        }
        .meja-modal-promo-title {
          font-size: 0.8rem;
          font-weight: 800;
          color: #1e293b;
          margin-bottom: 6px;
          text-transform: uppercase;
        }
        .meja-modal-promo-list {
          margin: 0;
          padding-left: 16px;
          font-size: 0.85rem;
          color: #475569;
          line-height: 1.4;
        }
        .meja-modal-footer {
          display: flex;
          gap: 10px;
          margin-top: auto;
          padding-top: 8px;
          flex-shrink: 0;
          position: relative;
        }
        .meja-modal-btn-batal {
          flex: 1;
          padding: 12px;
          background: #f3f4f6;
          color: #374151;
          border: none;
          border-radius: 10px;
          font-size: 0.95rem;
          font-weight: 700;
          cursor: pointer;
          transition: background 0.2s;
        }
        .meja-modal-btn-batal:hover {
          background: #e5e7eb;
        }
        .meja-modal-btn-mulai {
          flex: 1;
          padding: 12px;
          background: #3b82f6;
          color: #ffffff;
          border: none;
          border-radius: 10px;
          font-size: 0.95rem;
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

        <label class="meja-modal-label">PILIHAN MODE PERMAINAN</label>
        <div class="meja-modal-mode-container" style="display: flex; gap: 8px; margin-bottom: 12px;">
          <div 
            id="mejaModalModeDurasi" 
            onclick="setModeSesiModal('DURASI')"
            style="flex: 1; padding: 10px 8px; border: 2px solid #2563eb; background: #eff6ff; border-radius: 10px; cursor: pointer; text-align: center; transition: all 0.2s; box-shadow: 0 1px 3px rgba(0,0,0,0.05);"
          >
            <div style="font-weight: 800; font-size: 0.9rem; color: #1e40af;">DURASI</div>
            <div style="font-size: 0.7rem; color: #3b82f6; font-weight: 600; margin-top: 2px;">Paket Billiard</div>
          </div>
          
          <div 
            id="mejaModalModeLoss" 
            onclick="setModeSesiModal('LOSS')"
            style="flex: 1; padding: 10px 8px; border: 2px solid #e5e7eb; background: #ffffff; border-radius: 10px; cursor: pointer; text-align: center; transition: all 0.2s; box-shadow: 0 1px 3px rgba(0,0,0,0.05);"
          >
            <div style="font-weight: 800; font-size: 0.9rem; color: #374151;">WAKTU LOSS</div>
            <div style="font-size: 0.7rem; color: #059669; font-weight: 700; margin-top: 2px;">Rp30.000 / jam</div>
          </div>
        </div>

        <div id="mejaModalLossInfo" style="display: none; background: #ecfdf5; border: 1px solid #a7f3d0; border-radius: 10px; padding: 10px 12px; margin-bottom: 12px; font-size: 0.8rem; color: #065f46; line-height: 1.35;">
          <strong style="font-weight: 700;">MODE WAKTU LOSS:</strong><br>
          Bermain tanpa batas jam. Waktu berjalan dari 00:00:00 (Count-Up). Tarif Rp30.000/jam (Rp500/menit). Billing dihitung server saat sesi STOP.
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
      // Paket 3 Jam qty 1 menghasilkan durasi 3 jam.
      // Produk billiard lain (Meja Billiard/Pagi/Malam) tetap dihitung per qty.
      const namaPaket = String(item.nama || "").trim().toUpperCase();
      if (namaPaket === "PAKET 3 JAM" || namaPaket === "PAKET 3 JAM NON MEMBER") {
        durasiJamDraft += Number(item.qty || 0) * 3;
        return;
      }
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

    // RESET STATE DRAFT & MODE SAAT BUKA MEJA BARU
    draftProdukMeja = [];
    durasiJamDraft = 0;
    renderDraftSummary();
    setModeSesiModal('DURASI');

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

    // Validasi produk billiard wajib dipilih jika dalam mode DURASI
    if (modeSesiModal === "DURASI" && durasiJamDraft < 1) {
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

      const jenisSesiKirim = (modeSesiModal === "LOSS") ? "LOSS" : "BIASA";
      const durasiKirim = (modeSesiModal === "LOSS") ? 0 : durasiJamDraft;

      // 1. Definisikan bridgePromise tanpa ditunggu (await) terlebih dahulu
      const bridgePromise = window.bukaMejaDariModalBaru(
        nomorMejaAktif,
        namaPemesan,
        durasiKirim,
        draftProdukMeja,
        jenisSesiKirim
      );

      // 2. Buat promise timeout 15 detik
      const timeoutPromise = new Promise((resolve) => {
        setTimeout(() => {
          resolve({
            success: false,
            timeout: true,
            message: "Proses buka meja terlalu lama"
          });
        }, 15000);
      
      });

      // 3. Gunakan Promise.race untuk bertarung mana yang selesai duluan
      const hasilBridge = await Promise.race([
        bridgePromise,
        timeoutPromise
      ]);

      if (hasilBridge === true) {
        tutup();
      } else if (hasilBridge && hasilBridge.timeout === true) {
        console.warn("Bridge buka meja timeout setelah 15 detik.");
        tutup();
      }

    } catch (error) {
      console.error("Gagal MULAI MAIN:", error);
      alert(error.message || "Gagal membuka meja.");
    } finally {
      // 4. Pastikan blok finally mengembalikan tombol ke sedia kala
      if (btnMulai) {
        btnMulai.disabled = false;
        btnMulai.textContent = "MULAI MAIN";
      }
    }
  }

  window.handleMulaiMain = handleMulaiMain;

  // ==========================================
  // MODUL MEJA KARYAWAN
  // ==========================================

  function initMejaKaryawanModal() {
    if (document.getElementById('mejaKaryawanModal')) return;

    const overlay = document.createElement('div');
    overlay.id = 'mejaKaryawanModal';
    overlay.className = 'meja-modal-overlay';

    overlay.innerHTML = `
      <style>
        .karyawan-grid {
          display: grid;
          grid-template-columns: repeat(2, 1fr);
          gap: 10px;
          max-height: 320px;
          overflow-y: auto;
          margin-bottom: 20px;
        }
        .karyawan-meja-card {
          padding: 14px;
          border-radius: 10px;
          border: 2px solid #e5e7eb;
          background: #f9fafb;
          text-align: center;
          cursor: pointer;
          transition: all 0.2s;
        }
        .karyawan-meja-card.tersedia {
          border-color: #3b82f6;
          background: #eff6ff;
          cursor: pointer;
        }
        .karyawan-meja-card.tersedia:hover {
          background: #dbeafe;
        }
        .karyawan-meja-card.disabled {
          opacity: 0.5;
          cursor: not-allowed;
          background: #f3f4f6;
          border-color: #d1d5db;
        }
        .karyawan-meja-title {
          font-weight: 800;
          font-size: 1rem;
          color: #111827;
          margin-bottom: 4px;
        }
        .karyawan-meja-status {
          font-size: 0.75rem;
          font-weight: 700;
          text-transform: uppercase;
        }
      </style>
      <div class="meja-modal-card" style="max-width: 520px;">
        <div class="meja-modal-header">
          <h3 class="meja-modal-title">MEJA KARYAWAN</h3>
          <button class="meja-modal-close" onclick="MejaKaryawanModal.tutup()">&times;</button>
        </div>
        <div class="meja-modal-label" style="margin-bottom: 12px;">PILIH MEJA (01 - 10)</div>
        <div id="karyawanMejaGrid" class="karyawan-grid"></div>
        <div class="meja-modal-footer">
          <button class="meja-modal-btn-batal" onclick="MejaKaryawanModal.tutup()">TUTUP</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);
    karyawanModalElement = overlay;

    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) {
        MejaKaryawanModal.tutup();
      }
    });
  }

  function initMejaKaryawanKonfirmasi() {
    if (document.getElementById('mejaKaryawanKonfirmasi')) return;

    const overlay = document.createElement('div');
    overlay.id = 'mejaKaryawanKonfirmasi';
    overlay.className = 'meja-modal-overlay';

    overlay.innerHTML = `
      <div class="meja-modal-card" style="max-width: 420px;">
        <div class="meja-modal-header">
          <h3 class="meja-modal-title">MEJA KARYAWAN</h3>
          <button class="meja-modal-close" onclick="MejaKaryawanModal.tutupKonfirmasi()">&times;</button>
        </div>
        <div style="font-size: 1rem; color: #374151; margin-bottom: 20px; line-height: 1.6;">
          <div style="margin-bottom: 8px;"><strong>MEJA:</strong> <span id="karyawanKonfirmasiMeja">MEJA 01</span></div>
          <div style="margin-bottom: 8px;"><strong>DURASI:</strong> 1 JAM</div>
          <div><strong>BIAYA:</strong> GRATIS</div>
        </div>
        <div class="meja-modal-footer">
          <button class="meja-modal-btn-batal" onclick="MejaKaryawanModal.tutupKonfirmasi()">BATAL</button>
          <button class="meja-modal-btn-mulai" onclick="MejaKaryawanModal.eksekusiAktifkan()">AKTIFKAN MEJA</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);
    karyawanKonfirmasiElement = overlay;

    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) {
        MejaKaryawanModal.tutupKonfirmasi();
      }
    });
  }

  function initMejaKaryawanAuth() {
    if (document.getElementById('mejaKaryawanAuth')) return;

    const overlay = document.createElement('div');
    overlay.id = 'mejaKaryawanAuth';
    overlay.className = 'meja-modal-overlay';

    overlay.innerHTML = `
      <div class="meja-modal-card" style="max-width: 380px;">
        <div class="meja-modal-header">
          <h3 class="meja-modal-title">OTORISASI MEJA KARYAWAN</h3>
          <button class="meja-modal-close" onclick="MejaKaryawanModal.tutupAuth()">&times;</button>
        </div>
        <div style="font-size: 0.95rem; color: #374151; margin-bottom: 15px; line-height: 1.5;">
          <div style="margin-bottom: 6px;"><strong>MEJA:</strong> <span id="karyawanAuthMeja">MEJA 01</span></div>
          <div style="margin-bottom: 6px;"><strong>DURASI:</strong> 1 JAM</div>
          <div style="margin-bottom: 15px;"><strong>BIAYA:</strong> GRATIS</div>
          <div style="color: #4b5563; font-size: 0.9rem; margin-bottom: 8px;">Masukkan kode Manager</div>
        </div>
        <input
          id="inputKaryawanTotpCode"
          class="meja-modal-input"
          type="text"
          inputmode="numeric"
          maxlength="6"
          placeholder="6 DIGIT KODE"
          style="text-align: center; font-size: 1.2rem; letter-spacing: 4px; font-weight: bold; margin-bottom: 20px;"
          autocomplete="off"
        >
        <div class="meja-modal-footer">
          <button class="meja-modal-btn-batal" onclick="MejaKaryawanModal.tutupAuth()">BATAL</button>
          <button id="verifikasiKaryawanTotpBtn" class="meja-modal-btn-mulai" onclick="MejaKaryawanModal.prosesAktifkan()">VERIFIKASI</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);
    karyawanAuthElement = overlay;

    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) {
        MejaKaryawanModal.tutupAuth();
      }
    });
  }

  function renderKaryawanGrid() {
    const gridEl = document.getElementById('karyawanMejaGrid');
    if (!gridEl) return;

    let html = '';
    for (let i = 1; i <= 10; i++) {
      const formattedNum = i < 10 ? '0' + i : i;
      const status = statusMejaSistemCache[i] || 'TIDAK DIKETAHUI';
      const isTersedia = status === 'TERSEDIA';

      let statusColor = '#6b7280';
      if (status === 'TERSEDIA') statusColor = '#10b981';
      else if (status === 'AKTIF') statusColor = '#3b82f6';
      else if (status === 'HAMPIR_HABIS') statusColor = '#f59e0b';
      else if (status === 'HABIS') statusColor = '#ef4444';

      html += `
        <div class="karyawan-meja-card ${isTersedia ? 'tersedia' : 'disabled'}" ${isTersedia ? `onclick="MejaKaryawanModal.pilihMeja(${i})"` : ''}>
          <div class="karyawan-meja-title">MEJA ${formattedNum}</div>
          <div class="karyawan-meja-status" style="color: ${statusColor};">${status}</div>
        </div>
      `;
    }
    gridEl.innerHTML = html;
  }

  function updateStatusMejaKaryawan(dataMejaList) {
    statusMejaSistemCache = {};
    if (Array.isArray(dataMejaList)) {
      dataMejaList.forEach(meja => {
        const nomor = Number(meja.nomorMeja || meja.nomor);
        const status = String(meja.status || 'TIDAK DIKETAHUI').toUpperCase();
        if (nomor >= 1 && nomor <= 10) {
          statusMejaSistemCache[nomor] = status;
        }
      });
    }
    if (karyawanModalElement && karyawanModalElement.classList.contains('show')) {
      renderKaryawanGrid();
    }
  }

  window.updateStatusMejaKaryawan = updateStatusMejaKaryawan;

  function bukaMejaKaryawan() {
    initMejaKaryawanModal();
    initMejaKaryawanKonfirmasi();
    initMejaKaryawanAuth();
    renderKaryawanGrid();
    if (karyawanModalElement) {
      karyawanModalElement.classList.add('show');
    }
  }

  function tutupMejaKaryawan() {
    if (karyawanModalElement) {
      karyawanModalElement.classList.remove('show');
    }
  }

  function pilihMejaKaryawan(nomor) {
    nomorMejaKaryawanAktif = nomor;
    tutupMejaKaryawan();
    const formattedNum = nomor < 10 ? '0' + nomor : nomor;
    const mejaTextEl = document.getElementById('karyawanKonfirmasiMeja');
    if (mejaTextEl) {
      mejaTextEl.textContent = `MEJA ${formattedNum}`;
    }
    if (karyawanKonfirmasiElement) {
      karyawanKonfirmasiElement.classList.add('show');
    }
  }

  function tutupKonfirmasiKaryawan() {
    if (karyawanKonfirmasiElement) {
      karyawanKonfirmasiElement.classList.remove('show');
    }
  }

  function eksekusiAktifkanKaryawan() {
    tutupKonfirmasiKaryawan();
    if (nomorMejaKaryawanAktif !== null) {
      initMejaKaryawanAuth();
      const formattedNum = nomorMejaKaryawanAktif < 10 ? '0' + nomorMejaKaryawanAktif : nomorMejaKaryawanAktif;
      const mejaAuthTextEl = document.getElementById('karyawanAuthMeja');
      if (mejaAuthTextEl) {
        mejaAuthTextEl.textContent = `MEJA ${formattedNum}`;
      }
      const input = document.getElementById("inputKaryawanTotpCode");
      if (input) input.value = "";
      
      const btn = document.getElementById("verifikasiKaryawanTotpBtn");
      if (btn) {
        btn.disabled = false;
        btn.textContent = "VERIFIKASI";
      }

      if (karyawanAuthElement) {
        karyawanAuthElement.classList.add('show');
      }
    }
  }

  function tutupAuthKaryawan() {
    if (karyawanAuthElement) {
      karyawanAuthElement.classList.remove('show');
    }
    const btn = document.getElementById("verifikasiKaryawanTotpBtn");
    if (btn) {
      btn.disabled = false;
      btn.textContent = "VERIFIKASI";
    }
  }

  async function prosesAktifkanKaryawan() {
    const input = document.getElementById("inputKaryawanTotpCode");
    const code = input ? input.value.trim() : "";

    if (!/^\d{6}$/.test(code)) {
      alert("Kode Manager harus 6 digit.");
      return;
    }

    if (nomorMejaKaryawanAktif === null) {
      alert("Nomor meja tidak valid.");
      return;
    }

    const btn = document.getElementById("verifikasiKaryawanTotpBtn");
    if (btn) {
      btn.disabled = true;
      btn.textContent = "MEMPROSES...";
    }

    try {
      const response = await authenticatedFetch("/api/meja-karyawan/aktifkan", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          nomorMeja: nomorMejaKaryawanAktif,
          totpCode: code
        })
      });

      const result = await response.json();

      if (!result.success) {
        throw new Error(result.message || "Gagal mengaktifkan meja karyawan");
      }

      tutupAuthKaryawan();
      alert("Meja Karyawan berhasil diaktifkan.");

      if (typeof window.fetchMejaSessions === "function") {
        await window.fetchMejaSessions();
      }

    } catch (error) {
      alert(error.message || "Terjadi kesalahan saat mengaktifkan meja karyawan.");
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = "VERIFIKASI";
      }
    }
  }

  window.MejaKaryawanModal = {
    buka: bukaMejaKaryawan,
    tutup: tutupMejaKaryawan,
    pilihMeja: pilihMejaKaryawan,
    tutupKonfirmasi: tutupKonfirmasiKaryawan,
    eksekusiAktifkan: eksekusiAktifkanKaryawan,
    tutupAuth: tutupAuthKaryawan,
    prosesAktifkan: prosesAktifkanKaryawan
  };

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
    initMejaKaryawanModal();
    initMejaKaryawanKonfirmasi();
    initMejaKaryawanAuth();
  });
})();
