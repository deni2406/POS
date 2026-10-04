// ==================================================
// STATE WAITING LIST
// ==================================================
let waitingListData = [];
let currentSelectedBookingId = null;

// ==================================================
// TAMPILKAN / TUTUP MODAL WAITING LIST
// ==================================================
async function bukaWaitingList() {
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
  const container = document.getElementById("waitingListTableBody");
  if (!container) return;

  if (!waitingListData || waitingListData.length === 0) {
    container.innerHTML = `
      <tr>
        <td colspan="7" style="text-align: center; padding: 20px; color: #6b7280;">
          Tidak ada data waiting list / booking.
        </td>
      </tr>
    `;
    return;
  }

  container.innerHTML = waitingListData.map((item, index) => {
    const status = String(item.status || "WAITING").toUpperCase();
    let badgeColor = "#f59e0b"; // WAITING / BOOKING
    if (status === "SERVED" || status === "SELESAI" || status === "CONFIRMED") {
      badgeColor = "#10b981";
    } else if (status === "CANCELLED" || status === "BATAL") {
      badgeColor = "#ef4444";
    }

    const nomorMejaText = item.nomorMeja ? `Meja ${item.nomorMeja < 10 ? '0' + item.nomorMeja : item.nomorMeja}` : "Bebas";
    const tglText = item.tanggalBooking || "-";
    const jamText = item.jamBooking || "-";

    return `
      <tr>
        <td style="text-align: center; font-weight: bold;">${index + 1}</td>
        <td style="font-weight: bold; color: #111827;">${escapeHtml(item.namaCustomer || "-")}</td>
        <td>${escapeHtml(item.noWa || "-")}</td>
        <td style="text-align: center; font-weight: bold; color: #2563eb;">${nomorMejaText}</td>
        <td style="text-align: center;">${tglText} ${jamText}</td>
        <td style="text-align: center;">
          <span style="background: ${badgeColor}; color: #ffffff; padding: 3px 8px; border-radius: 9999px; font-size: 0.75rem; font-weight: bold;">
            ${status}
          </span>
        </td>
        <td style="text-align: center;">
          ${status === "WAITING" ? `
            <button 
              onclick="mejaSiap('${item.id}')"
              style="padding: 5px 10px; background: #16a34a; color: #ffffff; border: none; border-radius: 6px; font-weight: bold; cursor: pointer; font-size: 0.8rem;"
            >
              PROSES MEJA
            </button>
            <button 
              onclick="batalkanBooking('${item.id}')"
              style="padding: 5px 10px; background: #ef4444; color: #ffffff; border: none; border-radius: 6px; font-weight: bold; cursor: pointer; font-size: 0.8rem; margin-left: 4px;"
            >
              BATAL
            </button>
          ` : '-'}
        </td>
      </tr>
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

async function simpanFormBooking() {
  const namaCustomer = document.getElementById("inputNamaBooking")?.value.trim();
  const noWa = document.getElementById("inputWaBooking")?.value.trim();
  const nomorMeja = document.getElementById("selectMejaBooking")?.value;
  const tanggalBooking = document.getElementById("inputTanggalBooking")?.value;
  const jamBooking = document.getElementById("inputJamBooking")?.value;

  if (!namaCustomer) {
    alert("Nama customer wajib diisi.");
    return;
  }

  try {
    const payload = {
      namaCustomer,
      noWa: noWa || "",
      nomorMeja: nomorMeja ? Number(nomorMeja) : null,
      tanggalBooking: tanggalBooking || new Date().toISOString().split("T")[0],
      jamBooking: jamBooking || "12:00",
      status: "WAITING"
    };

    await tambahWaitingList(payload);
    tutupModalTambahBooking();
    await bukaWaitingList();
    if (typeof renderPopupMeja === "function") {
      renderPopupMeja();
    }
    alert("Booking berhasil ditambahkan.");
  } catch (error) {
    console.error("Gagal menyimpan booking:", error);
    alert("Gagal menyimpan booking: " + error.message);
  }
}

// ==================================================
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
  const preOrderItems = booking.items || booking.preOrder || [];

  try {
    // Update status booking di waiting list menjadi SERVED / SELESAI
    if (typeof updateStatusWaitingList === "function") {
      await updateStatusWaitingList(booking.id, "SERVED");
    }

    tutupModalDurasiBooking();
    tutupWaitingList();

    // Buka meja sesi aktif dengan data booking
    if (typeof window.bukaMejaDariModalBaru === "function") {
      await window.bukaMejaDariModalBaru(nomorMeja, namaCustomer, durasiJam, preOrderItems, "DURASI");
    } else if (typeof konfirmasiMulaiSesi === "function") {
      targetBukaMejaNomor = nomorMeja;
      const inputNama = document.getElementById("inputNamaPemesan");
      if (inputNama) inputNama.value = namaCustomer;
      await konfirmasiMulaiSesi(durasiJam, preOrderItems, "DURASI");
    }

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