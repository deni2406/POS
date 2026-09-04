/**
 * meja-produk-modal.js
 * Modul khusus untuk memilih produk/draft saat kasir membuka meja.
 * POS PollarBilliard
 */
(function () {
  console.log("DEBUG LOAD MejaProdukModal");
  let draftItems = [];
  let modalElement = null;

  // Identifikasi ketat untuk memastikan hanya Paket Billiard yang menjadi durasi
  function isProdukBillard(item) {
    if (!item || !item.nama) return false;
    const nama = String(item.nama).trim().toUpperCase();
    const kategori = String(item.kategori || "").trim().toUpperCase();
    
    return (
      nama === "MEJA BILLIARD" ||
      nama === "1 JAM" ||
      nama === "BILLIARD 1 JAM" ||
      kategori === "BILLIARD" ||
      kategori === "PAKET BILLIARD" ||
      (nama.includes("BILLIARD") && nama.includes("JAM"))
    );
  }

  function initModal() {
    if (document.getElementById('mejaProdukModal')) return;

    const overlay = document.createElement('div');
    overlay.id = 'mejaProdukModal';
    overlay.className = 'meja-produk-modal-overlay';

    overlay.innerHTML = `
      <style>
        .meja-produk-modal-overlay {
          position: fixed; top: 0; left: 0; width: 100%; height: 100%;
          background: rgba(0, 0, 0, 0.6); display: flex; justify-content: center; align-items: center;
          z-index: 3200; opacity: 0; visibility: hidden; transition: all 0.25s ease-in-out;
          padding: 15px; box-sizing: border-box; font-family: system-ui, sans-serif;
        }
        .meja-produk-modal-overlay.show { opacity: 1; visibility: visible; }
        .meja-produk-modal-card {
          background: #ffffff; width: 100%; max-width: 680px; border-radius: 16px; padding: 24px;
          box-shadow: 0 20px 40px rgba(0, 0, 0, 0.25); transform: scale(0.95);
          transition: transform 0.25s ease-in-out; box-sizing: border-box;
          max-height: 90vh;
          display: flex;
          flex-direction: column;
          overflow: hidden;
        }
        .meja-produk-modal-overlay.show .meja-produk-modal-card { transform: scale(1); }
        .meja-produk-modal-header {
          display: flex; justify-content: space-between; align-items: center;
          margin-bottom: 16px; border-bottom: 1px solid #e5e7eb; padding-bottom: 12px;
        }
        .meja-produk-modal-title { font-size: 1.2rem; font-weight: 800; color: #111827; margin: 0; }
        .meja-produk-modal-close {
          background: none; border: none; font-size: 26px; cursor: pointer; color: #6b7280;
        }
        .meja-produk-body {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 16px;
          flex: 1;
          min-height: 0;
          overflow: hidden;
          margin-bottom: 16px;
        }
        @media (max-width: 600px) {
          .meja-produk-body {
            grid-template-columns: 1fr;
          }
        }
        .meja-produk-section-title { font-size: 0.85rem; font-weight: 800; color: #374151; margin-bottom: 8px; }
        
        .meja-produk-search-input {
          width: 100%; padding: 12px; border: 1px solid #d1d5db; border-radius: 8px;
          margin-bottom: 10px; font-size: 1rem; box-sizing: border-box; outline: none;
        }
        .meja-produk-search-input:focus {
          border-color: #3b82f6;
        }

        .meja-produk-list, .meja-draft-list {
          border: 1px solid #e5e7eb; border-radius: 10px; padding: 10px; background: #f9fafb;
          overflow-y: auto;
          min-height: 0;
          height: 100%;
          max-height: none;
          -webkit-overflow-scrolling: touch;
        }
        .meja-produk-item-btn {
          width: 100%; text-align: left; padding: 10px 12px; background: #ffffff;
          border: 1px solid #d1d5db; border-radius: 8px; margin-bottom: 8px; cursor: pointer;
        }
        .meja-produk-item-btn:hover { border-color: #3b82f6; background: #eff6ff; }
        .meja-draft-row {
          display: flex; justify-content: space-between; align-items: center; padding: 8px 10px;
          background: #ffffff; border: 1px solid #e5e7eb; border-radius: 8px; margin-bottom: 6px;
        }
        .meja-draft-controls { display: flex; align-items: center; gap: 6px; }
        .meja-draft-btn {
          width: 24px; height: 24px; background: #f3f4f6; border: 1px solid #d1d5db;
          border-radius: 4px; cursor: pointer; font-weight: bold; display: flex; align-items: center; justify-content: center;
        }
        .meja-produk-footer { display: flex; gap: 12px; border-top: 1px solid #e5e7eb; padding-top: 16px; }
        .meja-produk-btn-batal {
          flex: 1; padding: 12px; background: #f3f4f6; color: #374151; border: none; border-radius: 10px; font-weight: 700; cursor: pointer;
        }
        .meja-produk-btn-simpan {
          flex: 1; padding: 12px; background: #10b981; color: #ffffff; border: none; border-radius: 10px; font-weight: 700; cursor: pointer;
        }
      </style>
      <div class="meja-produk-modal-card">
        <div class="meja-produk-header">
          <h3 class="meja-produk-modal-title">PILIH PRODUK & PAKET BILLIARD</h3>
          <button class="meja-produk-modal-close" onclick="MejaProdukModal.tutup()">&times;</button>
        </div>
        <div class="meja-produk-body">
          <div style="display:flex; flex-direction:column; min-height: 0;">
            <div class="meja-produk-section-title">Katalog Produk</div>
            <input id="mejaProdukSearch" class="meja-produk-search-input" type="text" placeholder="Cari produk..." autocomplete="off">
            <div id="mejaProdukKatalogList" class="meja-produk-list"></div>
          </div>
          <div style="display:flex; flex-direction:column; min-height: 0;">
            <div class="meja-produk-section-title">Draft Pilihan Meja</div>
            <div id="mejaProdukDraftList" class="meja-draft-list"></div>
          </div>
        </div>
        <div class="meja-produk-footer">
          <button class="meja-produk-btn-batal" onclick="MejaProdukModal.tutup()">BATAL</button>
          <button class="meja-produk-btn-simpan" onclick="MejaProdukModal.simpanDraft()">SIMPAN DRAFT</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);
    modalElement = overlay;

    // Tutup jika klik area di luar modal
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) MejaProdukModal.tutup();
    });

    // Menempelkan event listener untuk search dinamis
    const searchInput = document.getElementById('mejaProdukSearch');
    if (searchInput) {
      searchInput.addEventListener('input', renderKatalog);
    }
  }

  function renderKatalog() {
    const container = document.getElementById('mejaProdukKatalogList');
    if (!container) return;

    let items = (typeof masterBarang !== 'undefined' && Array.isArray(masterBarang)) ? masterBarang : [];
    
    // Logic filter/pencarian dinamis
    const searchInput = document.getElementById('mejaProdukSearch');
    if (searchInput) {
      const keyword = searchInput.value.trim().toLowerCase();
      if (keyword) {
        items = items.filter(item => String(item.nama || "").toLowerCase().includes(keyword));
      }
    }

    if (!items.length) {
      container.innerHTML = `<div style="font-size: 0.85rem; color: #6b7280; text-align: center; padding: 10px;">Produk tidak ditemukan.</div>`;
      return;
    }

    container.innerHTML = items.map(item => {
      const isBilliard = isProdukBillard(item);
      return `
        <button class="meja-produk-item-btn" onclick='MejaProdukModal.tambahItemDraft(${JSON.stringify(item.nama)})'>
          <div style="font-weight: bold; font-size: 0.9rem; color: #111827;">${item.nama}</div>
          <div style="font-size: 0.8rem; color: #6b7280;">Rp${Number(item.hargaJual || 0).toLocaleString('id-ID')} &bull; <span style="color: ${isBilliard ? '#2563eb' : '#4b5563'}; font-weight: bold;">${isBilliard ? 'PAKET BILLIARD / DURASI' : 'PRODUK TAMBAHAN'}</span></div>
        </button>
      `;
    }).join("");
  }

  function renderDraft() {
    const container = document.getElementById('mejaProdukDraftList');
    if (!container) return;

    if (!draftItems.length) {
      container.innerHTML = `<div style="font-size: 0.85rem; color: #6b7280; text-align: center; margin-top: 10px;">Belum ada produk dipilih.</div>`;
      return;
    }

    container.innerHTML = draftItems.map((item, index) => {
      const isBilliard = isProdukBillard(item);
      return `
        <div class="meja-draft-row">
          <div>
            <div style="font-weight: bold; color: #111827; font-size: 0.9rem;">${item.nama}</div>
            <div style="font-size: 0.75rem; color: #6b7280;">${isBilliard ? 'Paket Billiard (Durasi)' : 'Produk Tambahan'}</div>
          </div>
          <div class="meja-draft-controls">
            <button class="meja-draft-btn" onclick="MejaProdukModal.ubahQtyDraft(${index}, -1)">-</button>
            <span style="font-weight: bold; min-width: 20px; text-align: center;">${item.qty}</span>
            <button class="meja-draft-btn" onclick="MejaProdukModal.ubahQtyDraft(${index}, 1)">+</button>
          </div>
        </div>
      `;
    }).join("");
  }

  function tambahItemDraft(namaBarang) {
    const existing = draftItems.find(x => x.nama === namaBarang);
    const master = (typeof masterBarang !== 'undefined') ? masterBarang.find(x => x.nama === namaBarang) : null;
    const kategori = master ? master.kategori : "Lainnya";

    if (existing) {
      existing.qty += 1;
    } else {
      draftItems.push({ nama: namaBarang, qty: 1, kategori: kategori });
    }
    renderDraft();
  }

  function ubahQtyDraft(index, delta) {
    draftItems[index].qty += delta;
    if (draftItems[index].qty <= 0) {
      draftItems.splice(index, 1);
    }
    renderDraft();
  }

  function simpanDraft() {
    const hasBilliard = draftItems.some(item => isProdukBillard(item));

    if (!hasBilliard) {
      alert("Silakan pilih paket billiard terlebih dahulu.");
      return false;
    }

    tutup();

    // Dispatch event secara global tanpa memanggil langsung fungsi MejaModal
    window.dispatchEvent(
      new CustomEvent("mejaProdukDraftSaved", {
        detail: {
          draft: getDraft()
        }
      })
    );

    return true;
  }

  function buka() {
    initModal();
    // Kosongkan keyword pencarian saat modal baru dibuka
    const searchInput = document.getElementById('mejaProdukSearch');
    if (searchInput) {
      searchInput.value = '';
    }
    renderKatalog();
    renderDraft();
    if (modalElement) modalElement.classList.add('show');
  }

  function tutup() {
    if (modalElement) modalElement.classList.remove('show');
  }

  function getDraft() {
    return draftItems.map(item => ({ ...item }));
  }

  function clearDraft() {
    draftItems = [];
    renderDraft();
  }

  function mulaiMejaBaru() {
    draftItems = [];

    // Sesi meja baru sudah menentukan durasi dari input sesi.
    // Jangan memasukkan "Meja Billiard" ke draft karena draft
    // akan disimpan kembali ke pesanan_meja dan menyebabkan qty dobel.
    renderDraft();
  }

  window.MejaProdukModal = {
    buka, tutup, getDraft, clearDraft, simpanDraft,
    mulaiMejaBaru,
    tambahItemDraft, ubahQtyDraft, isProdukBillard
  };
})();