// ==================================================
// STATE WAITING LIST
// ==================================================
let waitingListData = [];
let currentSelectedBookingId = null;
let waitingListFormData = { pesanan: [] };
let wlSelectedNomorMeja = null;
let wlSelectedMember = null;

// ==================================================
// TAMPILKAN / TUTUP MODAL WAITING LIST
// ==================================================
function initWaitingListDOM() {
  if (document.getElementById("waitingListModal")) return;

  // Tambahkan style animasi spinner dinamis
  const styleEl = document.createElement("style");
  styleEl.innerHTML = `
    @keyframes wlSpin {
      0% { transform: rotate(0deg); }
      100% { transform: rotate(360deg); }
    }
    .wl-pay-spinner {
      display: inline-block;
      width: 14px;
      height: 14px;
      border: 2px solid #ffffff;
      border-top-color: transparent;
      border-radius: 50%;
      animation: wlSpin 0.6s linear infinite;
    }
  `;
  document.head.appendChild(styleEl);

  const modalHtml = `
    <div id="waitingListModal" class="wl-modal-overlay" onclick="tutupWaitingListLuar(event)">
      <div class="wl-modal-card">
        <div class="wl-modal-header">
          <h3 class="wl-modal-title">WAITING LIST</h3>
          <button class="wl-modal-close-btn" onclick="tutupWaitingList()">&times;</button>
        </div>
        
        <div class="wl-action-bar">
          <button class="wl-add-btn" onclick="bukaFormBooking()">+ TAMBAH BOOKING</button>
        </div>

        <div id="waitingListContainer" class="wl-list-container">
          <!-- Card booking akan dirender di sini -->
        </div>
      </div>
    </div>

    <!-- MODAL FORM TAMBAH BOOKING -->
    <div id="wlBookingFormModal" class="wl-modal-overlay" onclick="tutupFormBookingLuar(event)">
      <div class="wl-modal-card">
        <div class="wl-modal-header">
          <h3 class="wl-modal-title">TAMBAH BOOKING</h3>
          <button class="wl-modal-close-btn" onclick="tutupFormBooking()">&times;</button>
        </div>

        <div class="wl-list-container" style="max-height: 70vh; overflow-y: auto;">
          <div style="display: flex; flex-direction: column; gap: 12px;">
            
            <!-- PILIH MEMBER -->
            <div>
              <label class="wl-info-label" style="display: block; margin-bottom: 4px;">Member (Opsional)</label>
              <div style="display: flex; align-items: center; justify-content: space-between; background: #f9fafb; border: 1px solid #d1d5db; border-radius: 6px; padding: 8px 12px;">
                <span id="wlFormSelectedMemberText" style="font-weight: bold; color: #374151;">Belum dipilih</span>
                <div style="display: flex; gap: 8px;">
                  <button type="button" id="wlClearMemberBtn" class="popup-table-btn" style="padding: 6px 10px; background: #ef4444; color: #ffffff; font-weight: bold; border-radius: 6px; border: none; cursor: pointer; font-size: 0.8rem; display: none;" onclick="hapusPilihanMember()">&times;</button>
                  <button type="button" class="popup-table-btn" style="padding: 6px 12px; background: #3b82f6; color: #ffffff; font-weight: bold; border-radius: 6px; border: none; cursor: pointer; font-size: 0.8rem;" onclick="bukaPilihMemberModal()">PILIH MEMBER</button>
                </div>
              </div>
            </div>

            <div>
              <label class="wl-info-label" style="display: block; margin-bottom: 4px;">Nama Customer</label>
              <input type="text" id="wlInputNama" class="form-input" placeholder="Masukkan nama customer" style="width: 100%; box-sizing: border-box;" autocomplete="off">
            </div>

            <div>
              <label class="wl-info-label" style="display: block; margin-bottom: 4px;">No. WhatsApp</label>
              <input type="text" id="wlInputWa" class="form-input" placeholder="Contoh: 08123456789" style="width: 100%; box-sizing: border-box;" autocomplete="off">
            </div>

            <div style="display: flex; gap: 10px;">
              <div style="flex: 1;">
                <label class="wl-info-label" style="display: block; margin-bottom: 4px;">Tanggal Booking</label>
                <input type="date" id="wlInputTanggal" class="form-input" style="width: 100%; box-sizing: border-box;">
              </div>
              <div style="flex: 1;">
                <label class="wl-info-label" style="display: block; margin-bottom: 4px;">Jam Booking</label>
                <input type="time" id="wlInputJam" class="form-input" style="width: 100%; box-sizing: border-box;">
              </div>
            </div>

            <div>
              <label class="wl-info-label" style="display: block; margin-bottom: 4px;">Nomor Meja</label>
              <div style="display: flex; align-items: center; justify-content: space-between; background: #f9fafb; border: 1px solid #d1d5db; border-radius: 6px; padding: 8px 12px;">
                <span id="wlFormSelectedMejaText" style="font-weight: bold; color: #374151;">Belum dipilih</span>
                <button type="button" class="popup-table-btn" style="padding: 6px 12px; background: #3b82f6; color: #ffffff; font-weight: bold; border-radius: 6px; border: none; cursor: pointer; font-size: 0.8rem;" onclick="bukaCekMejaModal()">CEK MEJA</button>
              </div>
            </div>

            <div>
              <label class="wl-info-label" style="display: block; margin-bottom: 4px;">Catatan</label>
              <textarea id="wlInputCatatan" class="form-input" placeholder="Catatan tambahan (opsional)" style="width: 100%; box-sizing: border-box; resize: vertical; min-height: 60px;"></textarea>
            </div>

            <!-- BAGIAN PRE-ORDER PESANAN -->
            <div style="border-top: 1px solid #e5e7eb; padding-top: 10px; margin-top: 5px;">
              <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                <span class="wl-info-label" style="font-weight: bold;">PRE-ORDER PESANAN</span>
                <button type="button" class="popup-table-btn" style="padding: 6px 10px; background: #10b981; color: #ffffff; font-weight: bold; border-radius: 6px; border: none; font-size: 0.8rem; cursor: pointer;" onclick="bukaPilihProdukModal()">+ TAMBAH PRODUK</button>
              </div>

              <div id="wlFormPesananContainer" style="display: flex; flex-direction: column; gap: 6px; max-height: 180px; overflow-y: auto;">
                <!-- Daftar pesanan form akan dirender di sini -->
              </div>

              <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 8px; font-weight: bold; font-size: 0.95rem; color: #111827;">
                <span>TOTAL PRE-ORDER</span>
                <span id="wlFormTotalPreorder">Rp0</span>
              </div>
            </div>

            <div style="display: flex; gap: 10px; margin-top: 10px;">
              <button class="popup-table-btn" style="flex: 1; padding: 12px; background: #f3f4f6; font-weight: bold; border-radius: 8px;" onclick="tutupFormBooking()">BATAL</button>
              <button class="popup-table-btn" style="flex: 1; padding: 12px; background: #3b82f6; color: #ffffff; font-weight: bold; border-radius: 8px; border: none;" onclick="simpanFormBooking()">SIMPAN BOOKING</button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- MODAL CEK MEJA -->
    <div id="wlCekMejaModal" class="wl-modal-overlay" onclick="tutupCekMejaModalLuar(event)">
      <div class="popup-card" style="max-width: 480px; width: 95%;">
        <div class="popup-header">
          <h3 class="popup-title">CEK MEJA</h3>
          <button class="popup-close-btn" onclick="tutupCekMejaModal()">&times;</button>
        </div>
        <div id="wlCekMejaContainer" style="display: flex; flex-direction: column; gap: 8px; max-height: 60vh; overflow-y: auto; padding-right: 4px;">
          <!-- Daftar 10 Meja akan dirender dinamis dari server -->
        </div>
      </div>
    </div>

    <!-- MODAL PILIH PRODUK POS -->
    <div id="wlPilihProdukModal" class="wl-modal-overlay" onclick="tutupPilihProdukModalLuar(event)">
      <div class="popup-card" style="max-width: 480px;">
        <div class="popup-header">
          <h3 class="popup-title">PILIH PRODUK</h3>
          <button class="popup-close-btn" onclick="tutupPilihProdukModal()">&times;</button>
        </div>
        <div style="margin-bottom: 10px;">
          <input type="text" id="wlSearchProduk" class="form-input" placeholder="Cari produk..." style="width: 100%; box-sizing: border-box;" oninput="renderDaftarProdukPopup()">
        </div>
        <div id="wlDaftarProdukContainer" style="max-height: 50vh; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; padding-right: 4px;">
          <!-- Daftar produk dari masterBarang POS -->
        </div>
      </div>
    </div>

    <!-- MODAL DETAIL BOOKING WAITING LIST -->
    <div id="wlDetailModal" class="wl-modal-overlay" onclick="tutupDetailWaitingListLuar(event)">
      <div class="wl-modal-card">
        <div class="wl-modal-header">
          <h3 class="wl-modal-title">DETAIL BOOKING</h3>
          <button class="wl-modal-close-btn" onclick="tutupDetailWaitingList()">&times;</button>
        </div>

        <div id="wlDetailContentContainer" class="wl-list-container" style="max-height: 70vh; overflow-y: auto;">
          <!-- Content detail booking akan dirender secara dinamis -->
        </div>
      </div>
    </div>

    <!-- MODAL POPUP BATAL & BAYAR PESANAN PRE-ORDER -->
    <div id="wlCancelPayModal" class="wl-modal-overlay" onclick="tutupCancelPayModalLuar(event)">
      <div class="popup-card" style="max-width: 420px; width: 95%;">
        <div class="popup-header">
          <h3 class="popup-title">PEMBAYARAN PRE-ORDER</h3>
          <button class="popup-close-btn" onclick="tutupCancelPayModal()">&times;</button>
        </div>
        <div id="wlCancelPayContent" style="display: flex; flex-direction: column; gap: 12px; max-height: 65vh; overflow-y: auto; padding-right: 2px;">
          <!-- Konten pembayaran pre-order -->
        </div>
      </div>
    </div>

    <!-- MODAL POPUP BERAPA JAM BERMAIN (MEJA SIAP) -->
    <div id="wlDurasiModal" class="wl-modal-overlay" onclick="tutupDurasiModalLuar(event)">
      <div class="popup-card" style="max-width: 380px; text-align: center;">
        <div class="popup-header">
          <h3 class="popup-title">BERAPA JAM BERMAIN?</h3>
          <button class="popup-close-btn" onclick="tutupDurasiModal()">&times;</button>
        </div>
        <div style="font-weight: bold; font-size: 1.05rem; color: #111827; margin-bottom: 15px;">
          1 Jam
        </div>

        <div style="display: flex; justify-content: center; align-items: center; gap: 15px; margin-bottom: 20px;">
          <button type="button" class="qty-btn" style="width: 40px; height: 40px; font-size: 1.2rem; background: #e5e7eb; border: none; border-radius: 8px; cursor: pointer; font-weight: bold;" onclick="ubahDurasiQty(-1)">&minus;</button>
          <strong id="wlDurasiQtyVal" style="font-size: 1.5rem; min-width: 40px; text-align: center;">1</strong>
          <button type="button" class="qty-btn" style="width: 40px; height: 40px; font-size: 1.2rem; background: #e5e7eb; border: none; border-radius: 8px; cursor: pointer; font-weight: bold;" onclick="ubahDurasiQty(1)">+</button>
        </div>

        <!-- TOMBOL CEPAT -->
        <div style="display: grid; grid-template-columns: repeat(5, 1fr); gap: 6px; margin-bottom: 20px;">
          <button type="button" class="popup-table-btn" style="padding: 8px 0; background: #f3f4f6; font-weight: bold; border-radius: 6px; border: 1px solid #d1d5db; font-size: 0.8rem; cursor: pointer;" onclick="setDurasiQty(1)">1 JAM</button>
          <button type="button" class="popup-table-btn" style="padding: 8px 0; background: #f3f4f6; font-weight: bold; border-radius: 6px; border: 1px solid #d1d5db; font-size: 0.8rem; cursor: pointer;" onclick="setDurasiQty(2)">2 JAM</button>
          <button type="button" class="popup-table-btn" style="padding: 8px 0; background: #f3f4f6; font-weight: bold; border-radius: 6px; border: 1px solid #d1d5db; font-size: 0.8rem; cursor: pointer;" onclick="setDurasiQty(3)">3 JAM</button>
          <button type="button" class="popup-table-btn" style="padding: 8px 0; background: #f3f4f6; font-weight: bold; border-radius: 6px; border: 1px solid #d1d5db; font-size: 0.8rem; cursor: pointer;" onclick="setDurasiQty(4)">4 JAM</button>
          <button type="button" class="popup-table-btn" style="padding: 8px 0; background: #f3f4f6; font-weight: bold; border-radius: 6px; border: 1px solid #d1d5db; font-size: 0.8rem; cursor: pointer;" onclick="setDurasiQty(5)">5 JAM</button>
        </div>

        <div style="display: flex; gap: 10px;">
          <button type="button" class="popup-table-btn" style="flex: 1; padding: 12px; background: #f3f4f6; font-weight: bold; border-radius: 8px; border: 1px solid #d1d5db; cursor: pointer;" onclick="tutupDurasiModal()">BATAL</button>
          <button type="button" class="popup-table-btn" style="flex: 1; padding: 12px; background: #3b82f6; color: #ffffff; font-weight: bold; border-radius: 8px; border: none; cursor: pointer;" onclick="konfirmasiDurasiWaitingList()">KONFIRMASI</button>
        </div>
      </div>
    </div>
  `;

  const div = document.createElement("div");
  div.innerHTML = modalHtml;
  document.body.appendChild(div);
}


// ==================================================
// LOGIKA POPUP CEK MEJA
// ==================================================

async function bukaCekMejaModal() {
  initWaitingListDOM();
  const modal = document.getElementById("wlCekMejaModal");
  const container = document.getElementById("wlCekMejaContainer");
  
  if (!modal || !container) return;

  container.innerHTML = `<div style="text-align: center; padding: 20px; color: #6b7280;">Memuat data meja dari server...</div>`;
  modal.classList.add("show");

  try {
    const sesiList = await getSesiMejaWaitingList();
    
    let html = "";
    const now = new Date();

    for (let i = 1; i <= 10; i++) {
      const session = sesiList.find(s => Number(s.nomorMeja) === i && s.status === "AKTIF");
      const mejaStr = `MEJA ${String(i).padStart(2, '0')}`;

      if (!session) {
        // MEJA KOSONG
        html += `
          <div style="display: flex; justify-content: space-between; align-items: center; padding: 12px; border: 1px solid #d1d5db; border-radius: 8px; background: #f9fafb;">
            <div>
              <div style="font-weight: bold; font-size: 1rem; color: #111827;">${mejaStr}</div>
              <div style="font-size: 0.85rem; color: #10b981; font-weight: bold; margin-top: 2px;">&#9989; KOSONG</div>
              <div style="font-size: 0.8rem; color: #6b7280; margin-top: 2px;">Bisa langsung dimainkan</div>
            </div>
            <button type="button" class="popup-table-btn" style="padding: 8px 16px; background: #3b82f6; color: #ffffff; font-weight: bold; border-radius: 6px; border: none; cursor: pointer;" onclick="pilihMejaDariCekMeja(${i})">PILIH</button>
          </div>
        `;
      } else {
        // MEJA AKTIF
        const waktuSelesaiStr = session.waktuSelesai ? session.waktuSelesai.replace(' ', 'T') : null;
        const selesais = waktuSelesaiStr ? new Date(waktuSelesaiStr) : null;
        
        if (!selesais || isNaN(selesais)) {
           // Jika waktuSelesai tidak ada tetapi status AKTIF
           html += `
             <div style="display: flex; justify-content: space-between; align-items: center; padding: 12px; border: 1px solid #d1d5db; border-radius: 8px; background: #fef2f2;">
               <div>
                 <div style="font-weight: bold; font-size: 1rem; color: #111827;">${mejaStr}</div>
                 <div style="font-size: 0.85rem; color: #ef4444; font-weight: bold; margin-top: 2px;">&#128308; AKTIF</div>
                 <div style="font-size: 0.8rem; color: #6b7280; margin-top: 2px;">Sedang digunakan (tanpa batas waktu)</div>
               </div>
               <button type="button" class="popup-table-btn" style="padding: 8px 16px; background: #3b82f6; color: #ffffff; font-weight: bold; border-radius: 6px; border: none; cursor: pointer;" onclick="pilihMejaDariCekMeja(${i})">PILIH</button>
             </div>
           `;
        } else {
           const diffMs = selesais - now;
           
           if (diffMs <= 0) {
              // Waktu habis tapi masih AKTIF
              html += `
                <div style="display: flex; justify-content: space-between; align-items: center; padding: 12px; border: 1px solid #d1d5db; border-radius: 8px; background: #f9fafb;">
                  <div>
                    <div style="font-weight: bold; font-size: 1rem; color: #111827;">${mejaStr}</div>
                    <div style="font-size: 0.85rem; color: #10b981; font-weight: bold; margin-top: 2px;">&#9989; BISA LANGSUNG</div>
                    <div style="font-size: 0.8rem; color: #6b7280; margin-top: 2px;">Waktu sudah habis</div>
                  </div>
                  <button type="button" class="popup-table-btn" style="padding: 8px 16px; background: #3b82f6; color: #ffffff; font-weight: bold; border-radius: 6px; border: none; cursor: pointer;" onclick="pilihMejaDariCekMeja(${i})">PILIH</button>
                </div>
              `;
           } else {
              // Masih berjalan
              const diffMins = Math.ceil(diffMs / 60000);
              const jam = String(selesais.getHours()).padStart(2, '0');
              const menit = String(selesais.getMinutes()).padStart(2, '0');
              
              html += `
                <div style="display: flex; justify-content: space-between; align-items: center; padding: 12px; border: 1px solid #d1d5db; border-radius: 8px; background: #fef2f2;">
                  <div>
                    <div style="font-weight: bold; font-size: 1rem; color: #111827;">${mejaStr}</div>
                    <div style="font-size: 0.85rem; color: #ef4444; font-weight: bold; margin-top: 2px;">&#128308; AKTIF</div>
                    <div style="font-size: 0.8rem; color: #6b7280; margin-top: 2px;">Tersedia pukul ${jam}:${menit}</div>
                    <div style="font-size: 0.8rem; color: #d97706; margin-top: 2px; font-weight: 500;">Menunggu &plusmn;${diffMins} menit</div>
                  </div>
                  <button type="button" class="popup-table-btn" style="padding: 8px 16px; background: #3b82f6; color: #ffffff; font-weight: bold; border-radius: 6px; border: none; cursor: pointer;" onclick="pilihMejaDariCekMeja(${i})">PILIH</button>
                </div>
              `;
           }
        }
      }
    }
    container.innerHTML = html;
  } catch (error) {
    container.innerHTML = `<div style="text-align: center; padding: 20px; color: #ef4444; font-weight: bold;">Gagal memuat meja: ${error.message}</div>`;
  }
}

function tutupCekMejaModal() {
  const modal = document.getElementById("wlCekMejaModal");
  if (modal) {
    modal.classList.remove("show");
  }
}

function tutupCekMejaModalLuar(event) {
  if (event.target.id === "wlCekMejaModal") {
    tutupCekMejaModal();
  }
}

function pilihMejaDariCekMeja(nomor) {
  wlSelectedNomorMeja = nomor;
  const textEl = document.getElementById("wlFormSelectedMejaText");
  if (textEl) {
    textEl.innerHTML = `MEJA ${String(nomor).padStart(2, '0')} &#10003;`;
    textEl.style.color = "#10b981"; // warna hijau sukses
  }
  tutupCekMejaModal();
}


// ==================================================
// FUNGSI UTAMA WAITING LIST
// ==================================================


async function bukaWaitingList() {
  initWaitingListDOM();
  try {
    const list = await getWaitingList();
    waitingListData = Array.isArray(list) ? list : [];
    window.waitingListData = waitingListData;
    renderWaitingList();

    const modal = document.getElementById("waitingListModal");
    if (modal) {
      modal.classList.remove("hidden");
      modal.classList.add("show");
    }
  } catch (error) {
    console.error("Gagal membuka waiting list:", error);
    alert("Gagal memuat data waiting list.");
  }
}

function tutupWaitingList() {
  const modal = document.getElementById("waitingListModal");
  if (modal) {
    modal.classList.add("hidden");
    modal.classList.remove("show");
  }
}

function tutupWaitingListLuar(event) {
  if (event.target.id === "waitingListModal") {
    tutupWaitingList();
  }
}

// ==================================================
// RENDER LIST BOOKING / WAITING LIST
// ==================================================
function renderWaitingList() {
  const container = document.getElementById("waitingListContainer");
  if (!container) return;

  if (!waitingListData || waitingListData.length === 0) {
    container.innerHTML = `
      <div class="wl-empty-state">
        Tidak ada data waiting list / booking.
      </div>
    `;
    return;
  }

  const activeWaitingList = waitingListData.filter(item => ["WAITING", "CONFIRMED"].includes(String(item.status || "").toUpperCase()));

  container.innerHTML = activeWaitingList.map((item, index) => {
    const status = String(item.status || "WAITING").toUpperCase();

    let statusClass = "wl-status-waiting";
    if (status === "CONFIRMED") statusClass = "wl-status-confirmed";
    else if (status === "SEATED" || status === "SERVED") statusClass = "wl-status-seated";
    else if (status === "CANCELLED" || status === "BATAL") statusClass = "wl-status-cancelled";
    else if (status === "EXPIRED") statusClass = "wl-status-expired";

    const nomorMejaText = item.nomorMeja
      ? `Meja ${Number(item.nomorMeja) < 10 ? "0" + Number(item.nomorMeja) : Number(item.nomorMeja)}`
      : "Bebas";

    const pesanan = Array.isArray(item.pesanan) ? item.pesanan : [];

    const pesananHtml = pesanan.length
      ? `
        <div class="wl-pesanan-list">
          ${pesanan.map(p => `
            <div class="wl-pesanan-row">
              <span>${escapeHtml(p.nama || p.name || p.namaProduk || "Produk")}</span>
              <span>${Number(p.qty || p.jumlah || 1)}x</span>
            </div>
          `).join("")}
        </div>
      `
      : `<div class="wl-pesanan-empty">Tidak ada pesanan pre-order</div>`;

    const actionHtml = status === "WAITING"
      ? `
        <div style="display:flex; gap:8px; margin-top:4px;">
          <button
            onclick="mejaSiap('${item.id}')"
            style="flex:1; padding:10px 12px; background:#16a34a; color:#fff; border:none; border-radius:8px; font-weight:700; cursor:pointer;"
          >
            PROSES MEJA
          </button>
          <button
            onclick="batalkanBooking('${item.id}')"
            style="padding:10px 14px; background:#ef4444; color:#fff; border:none; border-radius:8px; font-weight:700; cursor:pointer;"
          >
            BATAL
          </button>
        </div>
      `
      : "";

    return `
      <div class="wl-card">
        <div class="wl-card-header">
          <div>
            <div class="wl-customer-name">
              ${escapeHtml(item.namaCustomer || "-")}
            </div>
            <div class="wl-customer-wa">
              ${escapeHtml(item.noWa || "Nomor WA tidak tersedia")}
            </div>
          </div>

          <span class="wl-status-badge ${statusClass}">
            ${escapeHtml(status)}
          </span>
        </div>

        <div class="wl-card-info-grid">
          <div class="wl-info-box">
            <span class="wl-info-label">Tanggal</span>
            <span class="wl-info-value">${escapeHtml(item.tanggalBooking || "-")}</span>
          </div>

          <div class="wl-info-box">
            <span class="wl-info-label">Jam Booking</span>
            <span class="wl-info-value">${escapeHtml(item.jamBooking || "-")}</span>
          </div>
        </div>

        <div class="wl-meja-box">
          ${escapeHtml(nomorMejaText)}
        </div>

        <div class="wl-pesanan-section">
          <div class="wl-pesanan-title">Pre-Order</div>
          ${pesananHtml}
        </div>

        ${actionHtml}
      </div>
    `;
  }).join("");
}

// ==================================================
// FORM TAMBAH BOOKING
// ==================================================
function bukaModalTambahBooking() {
  const modal = document.getElementById("tambahBookingModal");
  if (modal) {
    modal.classList.remove("hidden");
    modal.classList.add("show");
  }
}

function tutupModalTambahBooking() {
  const modal = document.getElementById("tambahBookingModal");
  if (modal) {
    modal.classList.add("hidden");
    modal.classList.remove("show");
  }
}

function bukaPilihMemberModal() {
  if (
    window.MemberModal &&
    typeof window.MemberModal.buka === "function"
  ) {
    window.MemberModal.buka();
    return;
  }

  alert("Popup member tidak tersedia.");
}

function hapusPilihanMember() {
  wlSelectedMember = null;
  
  const textEl = document.getElementById("wlFormSelectedMemberText");
  const clearBtn = document.getElementById("wlClearMemberBtn");
  if (textEl) {
    textEl.textContent = "Belum dipilih";
    textEl.style.color = "#374151";
  }
  if (clearBtn) clearBtn.style.display = "none";
  
  // Kosongkan form agar dapat diketik manual
  const inputNama = document.getElementById("wlInputNama");
  const inputWa = document.getElementById("wlInputWa");
  if (inputNama) inputNama.value = "";
  if (inputWa) inputWa.value = "";
}

// ==================================================
// INISIALISASI CONTAINER & POPUP DINAMIS
// ==================================================


function bukaPilihProdukModal() {
  initWaitingListDOM();
  const modal = document.getElementById("wlPilihProdukModal");
  if (modal) {
    const searchInput = document.getElementById("wlSearchProduk");
    if (searchInput) searchInput.value = "";
    renderDaftarProdukPopup();
    modal.classList.add("show");
  }
}

function tutupPilihProdukModal() {
  const modal = document.getElementById("wlPilihProdukModal");
  if (modal) {
    modal.classList.remove("show");
  }
}

function tutupPilihProdukModalLuar(event) {
  if (event.target.id === "wlPilihProdukModal") {
    tutupPilihProdukModal();
  }
}

function renderDaftarProdukPopup() {
  const container = document.getElementById("wlDaftarProdukContainer");
  if (!container) return;

  const keyword = (document.getElementById("wlSearchProduk")?.value || "").trim().toLowerCase();
  
  let data = typeof masterBarang !== "undefined" ? masterBarang : [];

  if (keyword) {
    data = data.filter(item => String(item.nama || "").toLowerCase().includes(keyword));
  }

  if (!data.length) {
    container.innerHTML = `<div style="text-align: center; padding: 15px; color: #6b7280; font-size: 0.9rem;">Produk tidak ditemukan.</div>`;
    return;
  }

  container.innerHTML = data.map(item => {
    return `
      <div style="display: flex; justify-content: space-between; align-items: center; padding: 8px 12px; background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 6px;">
        <div>
          <div style="font-weight: bold; font-size: 0.95rem; color: #111827;">${escapeHtmlWaitingList(item.nama)}</div>
          <div style="font-size: 0.85rem; color: #6b7280;">${typeof rupiah === "function" ? rupiah(item.hargaJual) : "Rp" + item.hargaJual}</div>
        </div>
        <button type="button" class="popup-table-btn" style="padding: 6px 12px; background: #3b82f6; color: #ffffff; font-weight: bold; border: none; font-size: 0.85rem; cursor: pointer;" onclick='tambahProdukKeForm(${JSON.stringify(item)})'>PILIH</button>
      </div>
    `;
  }).join("");
}

function tambahProdukKeForm(item) {
  const existing = waitingListFormData.pesanan.find(p => p.nama === item.nama);
  if (existing) {
    existing.qty += 1;
    existing.subtotal = existing.qty * existing.hargaJual;
  } else {
    waitingListFormData.pesanan.push({
      nama: item.nama,
      qty: 1,
      hargaJual: Number(item.hargaJual || 0),
      hpp: Number(item.hpp || 0),
      subtotal: Number(item.hargaJual || 0)
    });
  }
  renderFormPesanan();
  tutupPilihProdukModal();
}

function ubahQtyFormPesanan(index, delta) {
  const item = waitingListFormData.pesanan[index];
  if (!item) return;

  item.qty += delta;
  if (item.qty <= 0) {
    waitingListFormData.pesanan.splice(index, 1);
  } else {
    item.subtotal = item.qty * item.hargaJual;
  }
  renderFormPesanan();
}

function hapusItemFormPesanan(index) {
  waitingListFormData.pesanan.splice(index, 1);
  renderFormPesanan();
}

function renderFormPesanan() {
  const container = document.getElementById("wlFormPesananContainer");
  const totalContainer = document.getElementById("wlFormTotalPreorder");
  if (!container || !totalContainer) return;

  if (!waitingListFormData.pesanan || waitingListFormData.pesanan.length === 0) {
    container.innerHTML = `<div style="font-size: 0.85rem; color: #9ca3af; text-align: center; padding: 10px;">Belum ada pre-order produk.</div>`;
    totalContainer.textContent = typeof rupiah === "function" ? rupiah(0) : "Rp0";
    return;
  }

  let totalPreorder = 0;

  container.innerHTML = waitingListFormData.pesanan.map((p, idx) => {
    totalPreorder += p.subtotal;
    const hargaFormat = typeof rupiah === "function" ? rupiah(p.hargaJual) : "Rp" + p.hargaJual;
    const subtotalFormat = typeof rupiah === "function" ? rupiah(p.subtotal) : "Rp" + p.subtotal;

    return `
      <div style="display: flex; justify-content: space-between; align-items: center; background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 6px; padding: 6px 10px; font-size: 0.9rem;">
        <div style="flex: 1; overflow: hidden; padding-right: 8px;">
          <div style="font-weight: bold; color: #111827; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${escapeHtmlWaitingList(p.nama)}</div>
          <div style="font-size: 0.8rem; color: #6b7280;">${hargaFormat}</div>
        </div>
        <div style="display: flex; align-items: center; gap: 6px;">
          <div class="qty-row" style="display: flex; align-items: center; gap: 4px;">
            <button type="button" class="qty-btn" style="width: 24px; height: 24px; display: flex; align-items: center; justify-content: center; background: #e5e7eb; border: none; border-radius: 4px; cursor: pointer; font-weight: bold;" onclick="ubahQtyFormPesanan(${idx}, -1)">&minus;</button>
            <strong style="min-width: 18px; text-align: center; font-size: 0.85rem;">${p.qty}</strong>
            <button type="button" class="qty-btn" style="width: 24px; height: 24px; display: flex; align-items: center; justify-content: center; background: #e5e7eb; border: none; border-radius: 4px; cursor: pointer; font-weight: bold;" onclick="ubahQtyFormPesanan(${idx}, 1)">+</button>
          </div>
          <span style="font-weight: bold; min-width: 70px; text-align: right; font-size: 0.85rem; color: #111827;">${subtotalFormat}</span>
          <button type="button" style="background: none; border: none; color: #ef4444; font-weight: bold; font-size: 1.1rem; cursor: pointer; padding: 0 4px;" onclick="hapusItemFormPesanan(${idx})">&times;</button>
        </div>
      </div>
    `;
  }).join("");

  totalContainer.textContent = typeof rupiah === "function" ? rupiah(totalPreorder) : "Rp0";
}


function bukaFormBooking() {
  initWaitingListDOM();
  const formModal = document.getElementById("wlBookingFormModal");
  if (formModal) {
    const now = new Date();
    const tglStr = now.toISOString().split("T")[0];
    const jamStr = String(now.getHours()).padStart(2, "0") + ":" + String(now.getMinutes()).padStart(2, "0");

    document.getElementById("wlInputNama").value = "";
    document.getElementById("wlInputWa").value = "";
    document.getElementById("wlInputTanggal").value = tglStr;
    document.getElementById("wlInputJam").value = jamStr;
    document.getElementById("wlInputCatatan").value = "";

    // Reset Pilihan Meja
    wlSelectedNomorMeja = null;
    const textMeja = document.getElementById("wlFormSelectedMejaText");
    if (textMeja) {
       textMeja.textContent = "Belum dipilih";
       textMeja.style.color = "#374151";
    }
    
    // Reset Pilihan Member
    hapusPilihanMember();

    waitingListFormData.pesanan = [];
    renderFormPesanan();

    formModal.classList.add("show");
  }
}

function tutupFormBooking() {
  const formModal = document.getElementById("wlBookingFormModal");
  if (formModal) {
    formModal.classList.remove("show");
  }
}

function tutupFormBookingLuar(event) {
  if (event.target.id === "wlBookingFormModal") {
    tutupFormBooking();
  }
}


async function simpanFormBooking() {
  const nama = String(document.getElementById("wlInputNama").value || "").trim();
  const noWa = String(document.getElementById("wlInputWa").value || "").trim();
  const tanggal = String(document.getElementById("wlInputTanggal").value || "").trim();
  const jam = String(document.getElementById("wlInputJam").value || "").trim();
  const catatan = String(document.getElementById("wlInputCatatan").value || "").trim();

  if (!nama) {
    alert("Nama Customer wajib diisi.");
    return;
  }
  if (!tanggal) {
    alert("Tanggal Booking wajib diisi.");
    return;
  }
  if (!jam) {
    alert("Jam Booking wajib diisi.");
    return;
  }

  // Validasi Meja Wajib Dipilih
  if (wlSelectedNomorMeja === null) {
    alert("Nomor meja wajib dipilih. Silakan cek dan pilih meja terlebih dahulu.");
    return;
  }

  const payload = {
    namaCustomer: nama,
    noWa: noWa ? noWa : null,
    tanggalBooking: tanggal,
    jamBooking: jam,
    jumlahOrang: 0,
    nomorMeja: wlSelectedNomorMeja,
    status: "WAITING",
    catatan: catatan ? catatan : null,
    pesanan: waitingListFormData.pesanan
  };

  try {
    await createWaitingList(payload);
    alert("Booking berhasil disimpan");
    tutupFormBooking();
    waitingListFormData.pesanan = [];
    waitingListData = await getWaitingList();
    renderWaitingList();
  } catch (error) {
    console.error("Gagal menyimpan booking:", error);
    alert("Booking gagal disimpan: " + error.message);
  }
}

// PROSES MEJA / MEJA SIAP & KONFIRMASI DURASI
// ==================================================
async function mejaSiap(id) {
  currentSelectedBookingId = id;
  const booking = waitingListData.find(b => String(b.id) === String(id));
  
  if (!booking) {
    alert("Data booking tidak ditemukan.");
    return;
  }

  // Membuka modal konfirmasi durasi untuk proses manual kapan saja
  const modalDurasi = document.getElementById("durasiBookingModal");
  const namaEl = document.getElementById("durasiNamaCustomer");
  const mejaEl = document.getElementById("durasiNomorMeja");

  if (namaEl) namaEl.textContent = booking.namaCustomer || "-";
  if (mejaEl) mejaEl.textContent = booking.nomorMeja ? `MEJA ${booking.nomorMeja < 10 ? '0' + booking.nomorMeja : booking.nomorMeja}` : "Bebas";

  if (modalDurasi) {
    modalDurasi.classList.remove("hidden");
    modalDurasi.classList.add("show");
  } else {
    await konfirmasiDurasiWaitingList();
  }
}

function tutupModalDurasiBooking() {
  const modal = document.getElementById("durasiBookingModal");
  if (modal) {
    modal.classList.add("hidden");
    modal.classList.remove("show");
  }
  currentSelectedBookingId = null;
}

// ==================================================
// KONFIRMASI DURASI (LOGIKA VALIDASI WAKTU DIHAPUS)
// ==================================================
async function konfirmasiDurasiWaitingList() {
  if (!currentSelectedBookingId) {
    alert("Booking tidak dipilih.");
    return;
  }

  const booking = waitingListData.find(b => String(b.id) === String(currentSelectedBookingId));
  if (!booking) {
    alert("Data booking tidak ditemukan.");
    return;
  }

  // CATATAN: Pengecekan/validasi waktu booking (now < bookingDateTime) TELAH DIHAPUS TOTAL.
  // Kasir dapat memproses booking kapan saja secara manual.

  const selectDurasi = document.getElementById("selectDurasiBooking");
  const durasiJam = selectDurasi ? Number(selectDurasi.value) : 1;

  const nomorMeja = booking.nomorMeja ? Number(booking.nomorMeja) : 1;
  const namaCustomer = booking.namaCustomer || "Customer Booking";
  const preOrderItems = booking.pesanan || booking.items || booking.preOrder || [];

  try {
    let berhasilBukaMeja = false;

    // Buka meja terlebih dahulu. Booking tetap WAITING sampai proses
    // pembukaan meja dan seluruh pre-order berhasil.
    if (typeof window.bukaMejaDariModalBaru === "function") {
      berhasilBukaMeja = await window.bukaMejaDariModalBaru(
        nomorMeja,
        namaCustomer,
        durasiJam,
        preOrderItems,
        "DURASI"
      );
    } else if (typeof konfirmasiMulaiSesi === "function") {
      targetBukaMejaNomor = nomorMeja;

      const inputNama = document.getElementById("inputNamaPemesan");
      if (inputNama) {
        inputNama.value = namaCustomer;
      }

      berhasilBukaMeja = await konfirmasiMulaiSesi(
        durasiJam,
        preOrderItems,
        "DURASI"
      );
    } else {
      throw new Error("Modul buka meja belum siap. Silakan refresh aplikasi.");
    }

    if (berhasilBukaMeja !== true) {
      throw new Error("Gagal membuka meja. Booking tetap berstatus WAITING.");
    }

    // Hanya tandai SERVED setelah buka meja + pre-order berhasil.
    if (typeof updateStatusWaitingList === "function") {
      await updateStatusWaitingList(booking.id, "SERVED");
    }

    tutupModalDurasiBooking();
    tutupWaitingList();

    if (typeof fetchMejaSessions === "function") {
      await fetchMejaSessions();
    }

  } catch (error) {
    console.error("Gagal memproses booking meja:", error);
    alert("Gagal memproses booking meja: " + error.message);
  }
}
async function batalkanBooking(id) {
  if (!confirm("Apakah Anda yakin ingin membatalkan booking ini?")) {
    return;
  }

  try {
    if (typeof updateStatusWaitingList === "function") {
      await updateStatusWaitingList(id, "BATAL");
    }
    await bukaWaitingList();
    if (typeof renderPopupMeja === "function") {
      renderPopupMeja();
    }
  } catch (error) {
    console.error("Gagal membatalkan booking:", error);
    alert("Gagal membatalkan booking: " + error.message);
  }
}









window.addEventListener("memberSelected", function(event) {
  const member = event.detail?.member;
  if (!member) return;

  wlSelectedMember = member;

  const textEl = document.getElementById("wlFormSelectedMemberText");
  const clearBtn = document.getElementById("wlClearMemberBtn");
  const inputNama = document.getElementById("wlInputNama");
  const inputWa = document.getElementById("wlInputWa");

  if (textEl) {
    textEl.textContent = member.nama || "Member terpilih";
    textEl.style.color = "#2563eb";
  }

  if (clearBtn) {
    clearBtn.style.display = "inline-flex";
  }

  if (inputNama) {
    inputNama.value = member.nama || "";
  }

  if (inputWa) {
    inputWa.value = member.nomorHp || "";
  }
});
