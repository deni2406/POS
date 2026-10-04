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

