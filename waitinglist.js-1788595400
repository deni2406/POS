// ==================================================
// STATE WAITING LIST
// ==================================================

let waitingListData = [];

let waitingListFormData = {
  pesanan: []
};

// State Sementara untuk Popup Durasi Meja Siap
let waitingListSelectedBookingId = null;
let waitingListSelectedDurasiJam = 1;

// State Sementara untuk Pilihan Meja Booking Baru
let wlSelectedNomorMeja = null;

// State Sementara untuk Member
let wlSelectedMember = null;

// State Sementara untuk Pembayaran Pre-Order Batal & Bayar
let wlActiveCancelPayBooking = null;
let wlCancelPayMetode = "CASH";
let wlCancelPayProcessing = false;
let wlPaidPreorderBookingIds = new Set();

// ==================================================
// EVENT LISTENER MEMBER DIPILIH & LOGIKA MEMBER
// ==================================================

window.addEventListener("memberSelected", (event) => {
  if (event.detail && event.detail.member) {
    setMemberWaitingList(event.detail.member);
  }
});

function setMemberWaitingList(member) {
  if (!member) return;

  // 1. set wlSelectedMember
  wlSelectedMember = member;

  const idTampil = member.memberId || member.id || "";
  const hp =
    member.nomorHp ||
    member.telepon ||
    member.whatsapp ||
    member.noHp ||
    member.hp ||
    member.no_wa ||
    member.no_hp ||
    "";

  // 2. isi wlFormSelectedMemberText
  const textEl = document.getElementById("wlFormSelectedMemberText");
  if (textEl) {
    textEl.textContent = `${idTampil ? idTampil + " - " : ""}${member.nama || ""}`;
    textEl.style.color = "#10b981";
  }

  // 3. tampilkan tombol hapus member
  const clearBtn = document.getElementById("wlClearMemberBtn");
  if (clearBtn) {
    clearBtn.style.display = "block";
  }

  // 4. isi wlInputNama
  const inputNama = document.getElementById("wlInputNama");
  if (inputNama) {
    inputNama.value = member.nama || "";
  }

  // 5. isi wlInputWa
  const inputWa = document.getElementById("wlInputWa");
  if (inputWa) {
    inputWa.value = hp;
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
  document.getElementById("waitingListModal").classList.add("show");

  try {
    waitingListData = await getWaitingList();
  } catch (error) {
    console.error("Gagal memuat waiting list:", error);
    waitingListData = [];
  }

  renderWaitingList();
}

function tutupWaitingList() {
  const modal = document.getElementById("waitingListModal");
  if (modal) {
    modal.classList.remove("show");
  }
}

function tutupWaitingListLuar(event) {
  if (event.target.id === "waitingListModal") {
    tutupWaitingList();
  }
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

// ==================================================
// LOGIKA DETAIL BOOKING WAITING LIST
// ==================================================

function bukaDetailWaitingList(id) {
  initWaitingListDOM();
  const item = waitingListData.find(d => Number(d.id) === Number(id));
  if (!item) {
    alert("Data booking tidak ditemukan.");
    return;
  }

  const container = document.getElementById("wlDetailContentContainer");
  if (!container) return;

  const mejaText = item.nomorMeja ? `MEJA ${String(item.nomorMeja).padStart(2, "0")}` : "MEJA BELUM DITENTUKAN";
  let totalPreorder = 0;

  const pesananValid = Array.isArray(item.pesanan)
    ? item.pesanan.filter(p =>
        p &&
        String(p.nama || "").trim() !== "" &&
        Number(p.qty) > 0
      )
    : [];

  let pesananRows = "";
  if (pesananValid.length > 0) {
    pesananRows = pesananValid.map(p => {
      const sub = Number(p.subtotal || (p.hargaJual * p.qty) || 0);
      totalPreorder += sub;
      const hrgFormatted = typeof rupiah === "function" ? rupiah(p.hargaJual) : "Rp" + p.hargaJual;
      const subFormatted = typeof rupiah === "function" ? rupiah(sub) : "Rp" + sub;

      return `
        <div style="display: flex; justify-content: space-between; align-items: center; padding: 6px 0; border-bottom: 1px dashed #e5e7eb; font-size: 0.9rem;">
          <div>
            <div style="font-weight: bold; color: #111827;">${escapeHtmlWaitingList(p.nama)}</div>
            <div style="font-size: 0.8rem; color: #6b7280;">${hrgFormatted} &times; ${p.qty}</div>
          </div>
          <div style="font-weight: bold; color: #111827;">${subFormatted}</div>
        </div>
      `;
    }).join("");
  } else {
    pesananRows = `<div style="font-size: 0.85rem; color: #9ca3af; text-align: center; padding: 10px;">Tidak ada pre-order pesanan.</div>`;
  }

  const totalPreorderFormatted = typeof rupiah === "function" ? rupiah(totalPreorder) : "Rp" + totalPreorder;

  container.innerHTML = `
    <div style="display: flex; flex-direction: column; gap: 12px;">
      <div style="display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 1px solid #e5e7eb; padding-bottom: 8px;">
        <div>
          <div style="font-size: 1.1rem; font-weight: bold; color: #111827;">${escapeHtmlWaitingList(item.namaCustomer)}</div>
          <div style="font-size: 0.85rem; color: #4b5563;">${escapeHtmlWaitingList(item.noWa || "-")}</div>
        </div>
        <div class="wl-status-badge wl-status-${item.status.toLowerCase()}">${item.status}</div>
      </div>

      <div class="wl-card-info-grid">
        <div class="wl-info-box">
          <span class="wl-info-label">TANGGAL BOOKING</span>
          <span class="wl-info-value" style="font-size: 0.9rem;">${escapeHtmlWaitingList(item.tanggalBooking)}</span>
        </div>
        <div class="wl-info-box">
          <span class="wl-info-label">JAM BOOKING</span>
          <span class="wl-info-value" style="font-size: 0.9rem;">${escapeHtmlWaitingList(item.jamBooking)}</span>
        </div>
      </div>

      <div class="wl-meja-box">
        ${mejaText}
      </div>

      ${item.catatan ? `
        <div style="background: #f3f4f6; padding: 8px 12px; border-radius: 6px; font-size: 0.85rem; color: #374151;">
          <strong>Catatan:</strong> ${escapeHtmlWaitingList(item.catatan)}
        </div>
      ` : ""}

      <div style="border-top: 1px solid #e5e7eb; padding-top: 8px; margin-top: 4px;">
        <div class="wl-pesanan-title" style="margin-bottom: 6px;">PRE-ORDER PESANAN</div>
        <div style="display: flex; flex-direction: column;">
          ${pesananRows}
        </div>
        <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 10px; font-weight: bold; font-size: 0.95rem; color: #111827;">
          <span>TOTAL PRE-ORDER</span>
          <span>${totalPreorderFormatted}</span>
        </div>
      </div>

      <div style="display: flex; flex-direction: column; gap: 8px; margin-top: 12px;">
        <button type="button" class="popup-table-btn" style="width: 100%; padding: 12px; background: #10b981; color: #ffffff; font-weight: bold; border-radius: 8px; border: none; cursor: pointer;" onclick="mejaSiap(${item.id})">MEJA SIAP</button>
        <button type="button" class="popup-table-btn" style="width: 100%; padding: 12px; background: #ef4444; color: #ffffff; font-weight: bold; border-radius: 8px; border: none; cursor: pointer;" onclick="batalDanBayarPesanan(${item.id})">BATAL &amp; BAYAR PESANAN</button>
        <button type="button" class="popup-table-btn" style="width: 100%; padding: 12px; background: #f3f4f6; font-weight: bold; border-radius: 8px; border: none; cursor: pointer;" onclick="tutupDetailWaitingList()">TUTUP</button>
      </div>
    </div>
  `;

  document.getElementById("wlDetailModal").classList.add("show");
}

function tutupDetailWaitingList() {
  const modal = document.getElementById("wlDetailModal");
  if (modal) {
    modal.classList.remove("show");
  }
}

function tutupDetailWaitingListLuar(event) {
  if (event.target.id === "wlDetailModal") {
    tutupDetailWaitingList();
  }
}

// ==================================================
// LOGIKA BATAL & BAYAR PESANAN PRE-ORDER & PEMBATALAN BOOKING
// ==================================================

function bukaCancelPayModal(id) {
  if (wlPaidPreorderBookingIds.has(Number(id))) {
    alert("Booking ini sudah dibayar.\nJangan lakukan pembayaran ulang.\nSilakan periksa transaksi / status booking.");
    return;
  }

  initWaitingListDOM();
  const item = waitingListData.find(d => Number(d.id) === Number(id));
  if (!item) {
    alert("Data booking tidak ditemukan.");
    return;
  }

  wlActiveCancelPayBooking = item;
  wlCancelPayMetode = "CASH";
  wlCancelPayProcessing = false;

  const container = document.getElementById("wlCancelPayContent");
  if (!container) return;

  let totalPreorder = 0;
  let pesananListHtml = "";

  const pesananValid = Array.isArray(item.pesanan)
    ? item.pesanan.filter(p =>
        p &&
        String(p.nama || "").trim() !== "" &&
        Number(p.qty) > 0
      )
    : [];

  if (pesananValid.length > 0) {
    pesananListHtml = pesananValid.map(p => {
      const sub = Number(p.subtotal || (p.hargaJual * p.qty) || 0);
      totalPreorder += sub;
      const hrgF = typeof rupiah === "function" ? rupiah(p.hargaJual) : "Rp" + p.hargaJual;
      const subF = typeof rupiah === "function" ? rupiah(sub) : "Rp" + sub;
      return `
        <div style="display: flex; justify-content: space-between; align-items: center; font-size: 0.9rem; padding: 4px 0; border-bottom: 1px dashed #e5e7eb;">
          <div>
            <div style="font-weight: bold; color: #111827;">${escapeHtmlWaitingList(p.nama)}</div>
            <div style="font-size: 0.8rem; color: #6b7280;">${hrgF} &times; ${p.qty}</div>
          </div>
          <div style="font-weight: bold; color: #111827;">${subF}</div>
        </div>
      `;
    }).join("");
  } else {
    pesananListHtml = `<div style="font-size: 0.85rem; color: #9ca3af; text-align: center; padding: 10px;">Tidak ada pre-order pesanan.</div>`;
  }

  const totalF = typeof rupiah === "function" ? rupiah(totalPreorder) : "Rp" + totalPreorder;

  container.innerHTML = `
    <div style="background: #f3f4f6; padding: 10px; border-radius: 6px; font-size: 0.9rem; color: #374151;">
      <div><strong>Customer:</strong> ${escapeHtmlWaitingList(item.namaCustomer)}</div>
      <div><strong>Booking Jam:</strong> ${escapeHtmlWaitingList(item.jamBooking)} (${escapeHtmlWaitingList(item.tanggalBooking)})</div>
    </div>

    <div>
      <div style="font-size: 0.85rem; font-weight: bold; color: #4b5563; margin-bottom: 6px;">DAFTAR PRE-ORDER</div>
      <div style="display: flex; flex-direction: column; max-height: 120px; overflow-y: auto;">
        ${pesananListHtml}
      </div>
    </div>

    <div style="display: flex; justify-content: space-between; align-items: center; background: #eff6ff; padding: 10px 12px; border-radius: 6px; font-weight: bold; font-size: 1.05px; color: #1e3a8a;">
      <span>TOTAL</span>
      <span id="wlCancelPayTotalVal">${totalF}</span>
    </div>

    <div>
      <div style="font-size: 0.85rem; font-weight: bold; color: #4b5563; margin-bottom: 6px;">METODE PEMBAYARAN</div>
      <div style="display: flex; gap: 6px;">
        <button type="button" id="wlCPBtnCash" class="payment-btn active" style="flex: 1; padding: 8px; font-size: 0.85rem;" onclick="setCancelPayMetode('CASH')">CASH</button>
        <button type="button" id="wlCPBtnQris" class="payment-btn" style="flex: 1; padding: 8px; font-size: 0.85rem;" onclick="setCancelPayMetode('QRIS')">QRIS</button>
        <button type="button" id="wlCPBtnSplit" class="payment-btn" style="flex: 1; padding: 8px; font-size: 0.85rem;" onclick="setCancelPayMetode('SPLIT')">CASH + QRIS</button>
      </div>
    </div>

    <div id="wlCPCansArea">
      <label class="form-label" style="font-size: 0.85rem; margin-bottom: 4px;">Nominal Cash</label>
      <input type="number" id="wlCPInputCash" class="cash-input" placeholder="Nominal Cash" style="width: 100%; box-sizing: border-box;" oninput="hitungKembalianCancelPay()">
    </div>

    <div id="wlCPSplitArea" class="hidden" style="display: flex; flex-direction: column; gap: 8px;">
      <div>
        <label class="form-label" style="font-size: 0.85rem; margin-bottom: 4px;">Nominal Cash</label>
        <input type="number" id="wlCPSplitCash" class="cash-input" placeholder="Nominal Cash" style="width: 100%; box-sizing: border-box;" oninput="hitungKembalianCancelPay()">
      </div>
      <div>
        <label class="form-label" style="font-size: 0.85rem; margin-bottom: 4px;">Nominal QRIS</label>
        <input type="number" id="wlCPSplitQris" class="cash-input" placeholder="Nominal QRIS" style="width: 100%; box-sizing: border-box;" oninput="hitungKembalianCancelPay()">
      </div>
    </div>

    <div style="display: flex; justify-content: space-between; align-items: center; background: #f9fafb; padding: 8px 12px; border-radius: 6px; font-size: 0.9rem;">
      <span style="color: #6b7280; font-weight: 500;">KEMBALIAN</span>
      <span id="wlCPKembalianVal" style="font-weight: bold; color: #111827;">Rp0</span>
    </div>

    <div style="display: flex; gap: 10px; margin-top: 5px;">
      <button type="button" class="popup-table-btn" style="flex: 1; padding: 10px; background: #f3f4f6; font-weight: bold; border-radius: 8px;" onclick="tutupCancelPayModal()">BATAL</button>
      <button type="button" id="wlCancelPayBtn" class="popup-table-btn" style="flex: 1; padding: 10px; background: #10b981; color: #ffffff; font-weight: bold; border-radius: 8px; border: none; cursor: pointer;" onclick="prosesBayarCancelPay()">BAYAR</button>
    </div>
  `;

  document.getElementById("wlCancelPayModal").classList.add("show");
}

function tutupCancelPayModal() {
  const modal = document.getElementById("wlCancelPayModal");
  if (modal) modal.classList.remove("show");
  wlActiveCancelPayBooking = null;
  wlCancelPayProcessing = false;
}

function tutupCancelPayModalLuar(event) {
  if (event.target.id === "wlCancelPayModal") {
    tutupCancelPayModal();
  }
}

function setCancelPayMetode(metode) {
  wlCancelPayMetode = metode;
  document.getElementById("wlCPBtnCash").classList.toggle("active", metode === "CASH");
  document.getElementById("wlCPBtnQris").classList.toggle("active", metode === "QRIS");
  document.getElementById("wlCPBtnSplit").classList.toggle("active", metode === "SPLIT");

  const cashArea = document.getElementById("wlCPCansArea");
  const splitArea = document.getElementById("wlCPSplitArea");
  const inputCash = document.getElementById("wlCPInputCash");

  if (metode === "CASH") {
    cashArea.classList.remove("hidden");
    splitArea.classList.add("hidden");
    inputCash.disabled = false;
    inputCash.value = "";
  } else if (metode === "QRIS") {
    cashArea.classList.remove("hidden");
    splitArea.classList.add("hidden");
    inputCash.disabled = true;
    const total = hitungTotalCancelPayBooking(wlActiveCancelPayBooking);
    inputCash.value = total;
  } else {
    cashArea.classList.add("hidden");
    splitArea.classList.remove("hidden");
    document.getElementById("wlCPSplitCash").value = "";
    document.getElementById("wlCPSplitQris").value = "";
  }
  hitungKembalianCancelPay();
}

function hitungTotalCancelPayBooking(item) {
  if (!item || !item.pesanan) return 0;
  const pesananValid = Array.isArray(item.pesanan)
    ? item.pesanan.filter(p =>
        p &&
        String(p.nama || "").trim() !== "" &&
        Number(p.qty) > 0
      )
    : [];
  let total = 0;
  pesananValid.forEach(p => {
    total += Number(p.subtotal || (p.hargaJual * p.qty) || 0);
  });
  return total;
}

function hitungKembalianCancelPay() {
  if (!wlActiveCancelPayBooking) return;
  const total = hitungTotalCancelPayBooking(wlActiveCancelPayBooking);
  let bayar = 0;

  if (wlCancelPayMetode === "CASH") {
    bayar = Number(document.getElementById("wlCPInputCash")?.value || 0);
  } else if (wlCancelPayMetode === "QRIS") {
    bayar = total;
  } else {
    const c = Number(document.getElementById("wlCPSplitCash")?.value || 0);
    const q = Number(document.getElementById("wlCPSplitQris")?.value || 0);
    bayar = c + q;
  }

  const selisih = bayar - total;
  const kembalianEl = document.getElementById("wlCPKembalianVal");
  if (kembalianEl) {
    kembalianEl.textContent = typeof rupiah === "function" ? rupiah(Math.max(0, selisih)) : "Rp" + Math.max(0, selisih);
  }
}

async function prosesBayarCancelPay() {
  if (wlCancelPayProcessing) {
    return;
  }

  const item = wlActiveCancelPayBooking;
  if (!item) return;

  if (wlPaidPreorderBookingIds.has(Number(item.id))) {
    alert("Booking ini sudah dibayar.\nJangan lakukan pembayaran ulang.\nSilakan periksa transaksi / status booking.");
    return;
  }

  const pesananValid = Array.isArray(item.pesanan)
    ? item.pesanan.filter(p =>
        p &&
        String(p.nama || "").trim() !== "" &&
        Number(p.qty) > 0
      )
    : [];

  if (pesananValid.length === 0) {
    alert("Tidak ada pesanan pre-order untuk dibayar.");
    return;
  }

  const total = hitungTotalCancelPayBooking(item);
  let cashAmount = 0;
  let qrisAmount = 0;
  let bayar = 0;

  if (wlCancelPayMetode === "CASH") {
    cashAmount = Number(document.getElementById("wlCPInputCash")?.value || 0);
    bayar = cashAmount;
    if (cashAmount < total) {
      alert("Nominal Cash kurang dari total pre-order.");
      return;
    }
  } else if (wlCancelPayMetode === "QRIS") {
    qrisAmount = total;
    bayar = total;
  } else {
    cashAmount = Number(document.getElementById("wlCPSplitCash")?.value || 0);
    qrisAmount = Number(document.getElementById("wlCPSplitQris")?.value || 0);
    bayar = cashAmount + qrisAmount;
    if (bayar !== total) {
      alert("Cash + QRIS harus sama persis dengan total pre-order.");
      return;
    }
  }

  const yakin = confirm("Apakah Anda yakin ingin membatalkan booking dan membayar pesanan ini?");
  if (!yakin) {
    return;
  }

  wlCancelPayProcessing = true;
  const btnBayar = document.getElementById("wlCancelPayBtn");
  if (btnBayar) {
    btnBayar.disabled = true;
    btnBayar.innerHTML = `
      <span style="display:inline-flex;align-items:center;gap:8px;">
        <span class="wl-pay-spinner"></span>
        MEMPROSES...
      </span>
    `;
  }

  const kasirNama = typeof currentKasir !== "undefined" && currentKasir && currentKasir.nama ? currentKasir.nama : "Kasir";
  const shiftId = typeof currentKasir !== "undefined" && currentKasir && currentKasir.shiftId ? currentKasir.shiftId : null;

  const payload = {
    shiftId: shiftId,
    kasir: kasirNama,
    nomorMeja: null,
    metodePembayaran: wlCancelPayMetode === "SPLIT" ? "CASH+QRIS" : wlCancelPayMetode,
    bayar: bayar,
    cashAmount: cashAmount,
    qrisAmount: qrisAmount,
    items: pesananValid
  };

  let result;
  try {
    const response = await fetch("/api/transaksi", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    result = await response.json();
    if (!result.success) {
      throw new Error(result.message || "Gagal melakukan transaksi pembayaran pre-order");
    }

    // Tandai booking sudah dibayar
    wlPaidPreorderBookingIds.add(Number(item.id));

  } catch (error) {
    console.error("Gagal bayar pre-order waiting list:", error);
    alert("Gagal memproses pembayaran: " + error.message);

    wlCancelPayProcessing = false;
    const btnBayarReset = document.getElementById("wlCancelPayBtn");
    if (btnBayarReset) {
      btnBayarReset.disabled = false;
      btnBayarReset.innerHTML = "BAYAR";
    }
    return;
  }

  try {
    await updateStatusWaitingList(item.id, "CANCELLED");
    wlPaidPreorderBookingIds.delete(Number(item.id));

    tutupCancelPayModal();
    tutupDetailWaitingList();

    waitingListData = await getWaitingList();
    renderWaitingList();

    const totalF = typeof rupiah === "function" ? rupiah(total) : "Rp" + total;
    alert(`TRANSAKSI BERHASIL\n\nNo. Transaksi: ${result.nomorTransaksi}\nCustomer: ${item.namaCustomer}\nTotal: ${totalF}\nMetode: ${wlCancelPayMetode === "SPLIT" ? "CASH+QRIS" : wlCancelPayMetode}`);

  } catch (statusError) {
    console.error("Gagal memperbarui status waiting list setelah transaksi berhasil:", statusError);
    alert("Pembayaran berhasil, tetapi status booking belum diperbarui. Jangan ulangi pembayaran. Periksa Waiting List.");
    
    tutupCancelPayModal();
    tutupDetailWaitingList();
    try {
      waitingListData = await getWaitingList();
      renderWaitingList();
    } catch (e) {
      console.error("Gagal refresh waiting list:", e);
    }
  }
}

async function batalDanBayarPesanan(id) {
  if (wlPaidPreorderBookingIds.has(Number(id))) {
    alert("Booking ini sudah dibayar.\nJangan lakukan pembayaran ulang.\nSilakan periksa transaksi / status booking.");
    return;
  }

  const item = waitingListData.find(d => Number(d.id) === Number(id));
  if (!item) {
    alert("Data booking tidak ditemukan.");
    return;
  }

  const pesananValid = Array.isArray(item.pesanan)
    ? item.pesanan.filter(p =>
        p &&
        String(p.nama || "").trim() !== "" &&
        Number(p.qty) > 0
      )
    : [];

  if (pesananValid.length === 0) {
    const konfirmasi = confirm("Booking ini tidak memiliki pre-order.\nBatalkan booking sekarang?");
    if (konfirmasi) {
      try {
        await updateStatusWaitingList(item.id, "CANCELLED");
        tutupDetailWaitingList();
        waitingListData = await getWaitingList();
        renderWaitingList();
        alert("Booking berhasil dibatalkan.");
      } catch (error) {
        console.error("Gagal membatalkan booking:", error);
        alert("Gagal membatalkan booking: " + error.message);
      }
    }
  } else {
    tutupDetailWaitingList();
    bukaCancelPayModal(id);
  }
}

function mejaSiap(id) {
  const item = waitingListData.find(d => Number(d.id) === Number(id));
  if (!item) {
    alert("Data booking tidak ditemukan.");
    return;
  }

  if (!item.nomorMeja) {
    alert("Nomor meja belum ditentukan.");
    return;
  }

  const kasirNama = typeof currentKasir !== "undefined" && currentKasir && currentKasir.nama ? currentKasir.nama : null;
  if (!kasirNama) {
    alert("Kasir yang sedang login tidak ditemukan.");
    return;
  }

  // 1. Simpan ID booking yang sedang diproses
  waitingListSelectedBookingId = Number(id);

  // 2. Set qty awal = 1
  waitingListSelectedDurasiJam = 1;
  const qtyEl = document.getElementById("wlDurasiQtyVal");
  if (qtyEl) {
    qtyEl.textContent = "1";
  }

  // 3. Tutup detail modal dan tampilkan popup pilih durasi
  tutupDetailWaitingList();
  const durasiModal = document.getElementById("wlDurasiModal");
  if (durasiModal) {
    durasiModal.classList.add("show");
  }
}

function tutupDurasiModal() {
  const modal = document.getElementById("wlDurasiModal");
  if (modal) {
    modal.classList.remove("show");
  }
  waitingListSelectedBookingId = null;
}

function tutupDurasiModalLuar(event) {
  if (event.target.id === "wlDurasiModal") {
    tutupDurasiModal();
  }
}

function ubahDurasiQty(delta) {
  waitingListSelectedDurasiJam += delta;
  if (waitingListSelectedDurasiJam < 1) {
    waitingListSelectedDurasiJam = 1;
  }
  const qtyEl = document.getElementById("wlDurasiQtyVal");
  if (qtyEl) {
    qtyEl.textContent = String(waitingListSelectedDurasiJam);
  }
}

function setDurasiQty(val) {
  waitingListSelectedDurasiJam = Number(val) || 1;
  if (waitingListSelectedDurasiJam < 1) {
    waitingListSelectedDurasiJam = 1;
  }
  const qtyEl = document.getElementById("wlDurasiQtyVal");
  if (qtyEl) {
    qtyEl.textContent = String(waitingListSelectedDurasiJam);
  }
}

async function konfirmasiDurasiWaitingList() {
  const bookingId = waitingListSelectedBookingId;
  const durasiJam = waitingListSelectedDurasiJam;

  if (!bookingId || isNaN(bookingId)) {
    alert("Booking ID tidak valid.");
    return;
  }

  if (!Number.isInteger(durasiJam) || durasiJam < 1) {
    alert("Durasi bermain harus integer >= 1.");
    return;
  }

  const item = waitingListData.find(d => Number(d.id) === Number(bookingId));
  if (!item) {
    alert("Data booking tidak ditemukan di memory.");
    return;
  }

  const kasirNama = typeof currentKasir !== "undefined" && currentKasir && currentKasir.nama ? currentKasir.nama : null;
  if (!kasirNama) {
    alert("Kasir yang sedang login tidak ditemukan.");
    return;
  }

  try {
    console.log("[WAITING DEBUG] session:",
      sessionStorage.getItem("pbms_session_id")
    );

    console.log("[WAITING DEBUG] device:",
      localStorage.getItem("pbms_device_id") ||
      localStorage.getItem("deviceId") ||
      sessionStorage.getItem("deviceId")
    );

    // ==================================================
    // VALIDASI WAKTU BOOKING
    // Booking hanya boleh dimulai pada jam booking atau setelahnya.
    // ==================================================
    const now = new Date();
    const tanggalBooking = String(item.tanggalBooking || "").trim();
    const jamBooking = String(item.jamBooking || "").trim();

    if (!tanggalBooking || !jamBooking) {
      throw new Error("Tanggal atau jam booking tidak valid.");
    }

    const bookingDateTime = new Date(
      tanggalBooking + "T" + jamBooking + ":00"
    );

    if (isNaN(bookingDateTime.getTime())) {
      throw new Error("Waktu booking tidak valid.");
    }

    if (now < bookingDateTime) {
      alert(
        "Booking " + item.namaCustomer + " belum waktunya.\n\n" +
        "Waktu booking: " + tanggalBooking + " " + jamBooking
      );
      return;
    }

    // ==================================================
    // BOOKING TIDAK BOLEH MENGAMBIL SESSION CUSTOMER LAIN
    // ==================================================
    const sesiList = await getSesiMejaWaitingList();

    const activeSession = sesiList.find(
      s =>
        Number(s.nomorMeja) === Number(item.nomorMeja) &&
        s.status === "AKTIF"
    );

    if (activeSession) {
      alert(
        "MEJA " + String(item.nomorMeja).padStart(2, "0") +
        " masih digunakan.\n\n" +
        "Booking " + item.namaCustomer + " belum dapat dimulai.\n" +
        "Tagihan tidak akan digabung dengan customer yang sedang bermain."
      );
      return;
    }

    let sessionId = "";

    console.log("[WAITING LIST DEBUG] Durasi dipilih:", durasiJam);
    console.log("[WAITING LIST DEBUG] Nomor meja:", item.nomorMeja);
    console.log("[WAITING LIST DEBUG] Nama customer:", item.namaCustomer);

    const bukaRes = await bukaSesiMejaWaitingList(
      item.nomorMeja,
      item.namaCustomer,
      kasirNama,
      durasiJam
    );

    sessionId = bukaRes.sessionId;

    if (!sessionId) {
      throw new Error("Session ID tidak valid dari server.");
    }

    console.log("[DEBUG] Booking ID:", bookingId);
    console.log("[DEBUG] Nomor Meja:", item.nomorMeja);
    console.log("[DEBUG] Session ID:", sessionId);
    console.log("[DEBUG] Item Pesanan (Raw):", item.pesanan);

    // Mencegah error menghentikan proses pre-order jika sistem tidak mensupport paket billiard
    try {
      await tambahPaketBilliardWaitingList(sessionId, durasiJam);
    } catch (paketErr) {
      console.warn("[DEBUG] Paket billiard diabaikan (mungkin item durasi meja tidak tersedia di master_barang):", paketErr.message);
    }

    // Parsing aman & Validasi Pre-order
    let pesananArray = [];
    if (typeof item.pesanan === 'string') {
      try {
        pesananArray = JSON.parse(item.pesanan);
      } catch (e) {
        console.error("Gagal parse item.pesanan:", e);
      }
    } else if (Array.isArray(item.pesanan)) {
      pesananArray = item.pesanan;
    }

    const pesananValid = pesananArray.filter(p =>
      p &&
      String(p.nama || "").trim() !== "" &&
      Number(p.qty) > 0
    );

    // Eksekusi pesanan
    if (pesananValid && pesananValid.length > 0) {
      for (const p of pesananValid) {
        if (!p || !p.nama) {
          throw new Error("Data pesanan tidak valid (tidak memiliki properti nama).");
        }
        const qty = Number(p.qty);
        if (isNaN(qty) || qty <= 0) {
          throw new Error(`Kuantitas tidak valid untuk pesanan: ${p.nama}`);
        }
        
        console.log(`[DEBUG] Menyimpan pre-order ke ${sessionId}:`, p.nama, qty);
        const res = await tambahPesananSesiWaitingList(sessionId, p.nama, qty);
        console.log(`[DEBUG] Response POST /api/meja/pesanan (${p.nama}):`, res);
      }
    }

    await updateStatusWaitingList(item.id, "SEATED");

    tutupDurasiModal();
    tutupDetailWaitingList();

    waitingListData = await getWaitingList();
    renderWaitingList();

    if (typeof fetchMejaSessions === "function") {
      await fetchMejaSessions();
    }
    
    // Perbarui UI meja POS jika memungkinkan
    if (typeof renderPopupMeja === "function") {
      renderPopupMeja();
    }

    if (!isMejaAktif) {
      alert(`Meja siap.\nDurasi bermain ${durasiJam} jam.`);
    } else {
      alert(`Durasi meja berhasil ditambah.\nTambahan ${durasiJam} jam.`);
    }

  } catch (error) {
    console.error("Gagal memproses meja siap:", error);
    alert("Gagal memproses meja siap: " + error.message);
  }
}

// ==================================================
// LOGIKA PEMILIHAN PRODUK PRE-ORDER
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

function renderWaitingList() {
  initWaitingListDOM();
  const container = document.getElementById("waitingListContainer");
  if (!container) return;

  // Hanya menampilkan data dengan status WAITING / aktif
  const activeList = waitingListData.filter(item => String(item.status || "").toUpperCase() === "WAITING");

  if (!activeList || activeList.length === 0) {
    container.innerHTML = `
      <div class="wl-empty-state">
        Belum ada booking.
      </div>
    `;
    return;
  }

  container.innerHTML = activeList.map(item => {
    let mejaText = item.nomorMeja ? `MEJA ${String(item.nomorMeja).padStart(2, "0")}` : "MEJA BELUM DITENTUKAN";

    const pesananValid = Array.isArray(item.pesanan)
      ? item.pesanan.filter(p =>
          p &&
          String(p.nama || "").trim() !== "" &&
          Number(p.qty) > 0
        )
      : [];

    let pesananHtml = "";
    if (pesananValid.length > 0) {
      pesananHtml = pesananValid.map(p => `
        <div class="wl-pesanan-row">
          <span>${escapeHtmlWaitingList(p.nama)}</span>
          <span>&times;${p.qty}</span>
        </div>
      `).join("");
    } else {
      pesananHtml = `<div class="wl-pesanan-empty">Tidak ada pre-order pesanan.</div>`;
    }

    return `
      <div class="wl-card" onclick="bukaDetailWaitingList(${item.id})" style="cursor: pointer;">
        <div class="wl-card-header">
          <div>
            <div class="wl-customer-name">${escapeHtmlWaitingList(item.namaCustomer)}</div>
            <div class="wl-customer-wa">${escapeHtmlWaitingList(item.noWa || "-")}</div>
          </div>
          <div class="wl-status-badge wl-status-${item.status.toLowerCase()}">${item.status}</div>
        </div>

        <div class="wl-card-info-grid">
          <div class="wl-info-box">
            <span class="wl-info-label">BOOKING</span>
            <span class="wl-info-value">${escapeHtmlWaitingList(item.jamBooking)}</span>
          </div>
          <div class="wl-info-box">
            <span class="wl-info-label">TANGGAL</span>
            <span class="wl-info-value" style="font-size: 0.85rem;">${escapeHtmlWaitingList(item.tanggalBooking)}</span>
          </div>
        </div>

        <div class="wl-meja-box">
          ${mejaText}
        </div>

        <div class="wl-pesanan-section">
          <div class="wl-pesanan-title">PESANAN</div>
          <div class="wl-pesanan-list">
            ${pesananHtml}
          </div>
        </div>
      </div>
    `;
  }).join("");
}

function escapeHtmlWaitingList(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}


