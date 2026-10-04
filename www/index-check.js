
















// ==================================================
// API CONFIGURATION
// ==================================================

const isCapacitor = (typeof window !== 'undefined') && (
  (window.Capacitor !== undefined && typeof window.Capacitor.isNativePlatform === 'function' && window.Capacitor.isNativePlatform()) ||
  window.location.protocol === 'capacitor:' ||
  window.location.protocol === 'file:'
);

const API_BASE_URL = isCapacitor ? "https://192.168.1.140:3100" : "";

function apiUrl(path) {
  if (!path) return API_BASE_URL;
  if (!API_BASE_URL) {
    return path.startsWith('/') ? path : '/' + path;
  }
  const base = API_BASE_URL.endsWith('/') ? API_BASE_URL.slice(0, -1) : API_BASE_URL;
  const p = path.startsWith('/') ? path : '/' + path;
  return base + p;
}


// ==================================================
// STATE
// ==================================================

let masterBarang = [];

let cart = [];

let activeCategory = "SEMUA";

let metodePembayaran = "CASH";

let currentKasir = null;

let nomorMeja = null; // Sinkronisasi untuk pembayaran backend

// State Sesi Meja (Sumber Kebenaran Utama = SQLite via API)
let mejaSessions = {};
let activeMeja = null;
let cekHargaSessionId = null;
// Menyimpan sessionId sesi meja yang sudah di-STOP tetapi tidak lagi dikembalikan oleh GET /api/meja/sesi.
// Dipakai hanya sebagai referensi pembayaran setelah STOP LOSS.
const stoppedSessionIdsByMeja = {};
// Meja yang sudah STOP LOSS dan menunggu pembayaran.
let pendingPaymentTableNo = null;
let pendingMemberForMeja = null;
const memberByMeja = new Map();

// Global Loading Lock State untuk Stop Waktu Loss
let isProcessingStopLoss = false;

// State untuk Pindah Meja
let targetPindahSessionId = null;
let targetPindahMejaAsal = null;

window.addEventListener("memberSelected", function (event) {
  const member = event.detail?.member || null;
  if (!member) return;

  pendingMemberForMeja = member;

  if (activeMeja) {
    memberByMeja.set(String(activeMeja), member);
  }

  renderCart();
});

let targetBukaMejaNomor = null;
let targetKurangSessionId = null;
let targetKurangProdukNama = null; // State untuk tracking produk biasa yang akan dikurangi QTY-nya

// Registry untuk menyimpan fungsi stop countdown/count-up per meja agar bisa dibersihkan saat render ulang
let mejaTimersCleanup = {};

// State untuk Riwayat
let riwayatData = [];
let riwayatSearchTimer = null;
let selectedTrxIndex = null;


// ==================================================
// DEVICE & SESSION UTILITIES
// ==================================================

function getOrCreateDeviceId() {
  let deviceId = localStorage.getItem("pbms_device_id");
  if (deviceId) {
    deviceId = deviceId.trim();
  }
  if (!deviceId) {
    try {
      if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
        deviceId = crypto.randomUUID();
      } else if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
        const arr = new Uint8Array(16);
        crypto.getRandomValues(arr);
        deviceId = Array.from(arr, b => b.toString(16).padStart(2, '0')).join('');
      } else {
        throw new Error("Browser/Device tidak mendukung secure random (crypto API).");
      }
    } catch (e) {
      console.error("Gagal membuat Device ID aman:", e);
      alert("Error: Browser/Device tidak mendukung secure random UUID.");
      throw e;
    }
    deviceId = deviceId.trim();
    localStorage.setItem("pbms_device_id", deviceId);
  }
  return deviceId;
}

async function authenticatedFetch(url, options = {}) {
  const deviceId = getOrCreateDeviceId().trim();
  const rawSessionId = sessionStorage.getItem("pbms_session_id");
  const sessionId = rawSessionId ? rawSessionId.trim() : "";

  const headers = {
    ...(options.headers || {})
  };

  if (sessionId) {
    headers["X-Session-Id"] = sessionId;
  }
  if (deviceId) {
    headers["X-Device-Id"] = deviceId;
  }

  let response;
  try {
    response = await fetch(apiUrl(url), {
      ...options,
      headers
    });
  } catch (e) {
    throw e;
  }

  if (response.status === 401 || response.status === 403) {
    try {
      const clone = response.clone();
      const json = await clone.json();
      if (json && json.code && ["SESSION_EXPIRED", "SESSION_NOT_FOUND", "INVALID_SESSION", "DEVICE_MISMATCH"].includes(json.code)) {
        handleSessionExpired(json.message || "Session berakhir");
        throw new Error(json.message || "Session berakhir");
      }
    } catch (e) {
      if (e.message === "Session berakhir") {
        throw e;
      }
    }
  }

  return response;
}

let sessionTimerInterval = null;
let sessionCheckInterval = null;

function startSessionTimer(expiresAt) {
  stopSessionTimer();

  const expTime = Number(expiresAt);
  if (!expTime || isNaN(expTime)) return;

  sessionTimerInterval = setInterval(() => {
    const currentExpiresAt =
      Number(sessionStorage.getItem("pbms_expires_at")) || expTime;

    if (!currentExpiresAt) return;

    if (Date.now() >= currentExpiresAt) {
      cekSessionLogin().then(valid => {
        if (valid) {
          const newExp = sessionStorage.getItem("pbms_expires_at");
          if (newExp && Number(newExp) > Date.now()) {
            startSessionTimer(newExp);
          }
        }
      }).catch(error => {
        console.error("Refresh session saat timer error:", error);
      });
    }
  }, 1000);

  sessionCheckInterval = setInterval(async () => {
    const rawSessionId = sessionStorage.getItem("pbms_session_id");
    if (!rawSessionId) {
      stopSessionTimer();
      return;
    }

    await cekSessionLogin();
  }, 30000);
}

function startSessionTimer(expiresAt) {
  stopSessionTimer();

  const expTime = Number(expiresAt);
  if (!expTime || isNaN(expTime)) return;

  sessionTimerInterval = setInterval(() => {
    const currentExpiresAt =
      Number(sessionStorage.getItem("pbms_expires_at")) || expTime;

    if (!currentExpiresAt) return;

    if (Date.now() >= currentExpiresAt) {
      cekSessionLogin().then(valid => {
        if (valid) {
          const newExp = sessionStorage.getItem("pbms_expires_at");
          if (newExp && Number(newExp) > Date.now()) {
            startSessionTimer(newExp);
          }
        }
      }).catch(error => {
        console.error("Refresh session saat timer error:", error);
      });
    }
  }, 1000);

  sessionCheckInterval = setInterval(async () => {
    const rawSessionId = sessionStorage.getItem("pbms_session_id");
    if (!rawSessionId) {
      stopSessionTimer();
      return;
    }

    await cekSessionLogin();
  }, 30000);
}

function stopSessionTimer() {
  if (sessionTimerInterval) {
    clearInterval(sessionTimerInterval);
    sessionTimerInterval = null;
  }

  if (sessionCheckInterval) {
    clearInterval(sessionCheckInterval);
    sessionCheckInterval = null;
  }
}

function handleSessionExpired(message = "Session login sudah berakhir. Silakan login kembali.") {
  stopSessionTimer();
  sessionStorage.removeItem("pbms_session_id");
  sessionStorage.removeItem("pbms_login_at");
  sessionStorage.removeItem("pbms_expires_at");
  sessionStorage.removeItem("pbms_kasir_id");
  sessionStorage.removeItem("pbms_nama");
  sessionStorage.removeItem("pbms_shift_id");

  currentKasir = null;
  activeMeja = null;
  nomorMeja = null;
  cart = [];

  renderCart();
  updateMejaHeaderUI();
  updateSaveOrderButton();

  document.getElementById("app").classList.add("hidden");
  const loginScreen = document.getElementById("loginScreen");
  loginScreen.classList.remove("hidden");

  const errorBox = document.getElementById("loginError");
  if (errorBox) {
    errorBox.textContent = message;
    errorBox.classList.remove("hidden");
  }
}

async function cekSessionLogin() {
  const rawSessionId = sessionStorage.getItem("pbms_session_id");
  const sessionId = rawSessionId ? rawSessionId.trim() : "";
  const deviceId = getOrCreateDeviceId().trim();
  if (!sessionId) return false;

  try {
    const response = await fetch(apiUrl("/api/session"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Session-Id": sessionId,
        "X-Device-Id": deviceId
      },
      body: JSON.stringify({
        sessionId,
        deviceId
      })
    });

    const result = await response.json();

    if (response.ok && result.success === true && result.valid === true) {
      if (result.expiresAt) {
        sessionStorage.setItem("pbms_expires_at", result.expiresAt);
      }
      return true;
    }

    if (result && result.code && ["SESSION_EXPIRED", "SESSION_NOT_FOUND", "INVALID_SESSION", "DEVICE_MISMATCH"].includes(result.code)) {
      handleSessionExpired(result.message || "Session login sudah berakhir. Silakan login kembali.");
      return false;
    }

    console.warn("Cek session menerima respons server non-valid:", response.status, result);
    return true;
  } catch (e) {
    console.error("Cek session network error:", e);
    return true;
  }
}

async function logoutKasir() {
  const rawSessionId = sessionStorage.getItem("pbms_session_id");
  const sessionId = rawSessionId ? rawSessionId.trim() : "";
  const deviceId = getOrCreateDeviceId().trim();

  if (sessionId) {
    try {
      await fetch(apiUrl("/api/logout"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Session-Id": sessionId,
          "X-Device-Id": deviceId
        },
        body: JSON.stringify({
          sessionId,
          deviceId
        })
      });
    } catch (e) {
      console.error("Logout request error:", e);
    }
  }

  stopSessionTimer();
  sessionStorage.removeItem("pbms_session_id");
  sessionStorage.removeItem("pbms_login_at");
  sessionStorage.removeItem("pbms_expires_at");
  sessionStorage.removeItem("pbms_kasir_id");
  sessionStorage.removeItem("pbms_nama");
  sessionStorage.removeItem("pbms_shift_id");

  currentKasir = null;
  activeMeja = null;
  nomorMeja = null;
  cart = [];

  renderCart();
  updateMejaHeaderUI();
  updateSaveOrderButton();

  document.getElementById("app").classList.add("hidden");
  document.getElementById("loginScreen").classList.remove("hidden");
  loadKasirList();
}

function loadKasirList() {
  // Menggunakan daftar kasir tetap pada HTML
}

document.addEventListener("DOMContentLoaded", async () => {
  loadKasirList();
  const sessionId = sessionStorage.getItem("pbms_session_id");
  if (sessionId) {
    const deviceId = getOrCreateDeviceId();
    try {
      const response = await fetch(apiUrl("/api/session"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Session-Id": sessionId,
          "X-Device-Id": deviceId
        },
        body: JSON.stringify({
          sessionId,
          deviceId
        })
      });
      const result = await response.json();
      if (result.success && result.valid) {
        const kId = result.kasirId || sessionStorage.getItem("pbms_kasir_id");
        const kName = sessionStorage.getItem("pbms_nama");
        const sId = sessionStorage.getItem("pbms_shift_id");
        currentKasir = {
          id: kId,
          kasirId: kId,
          nama: kName,
          shiftId: sId,
          sessionId: result.sessionId,
          expiresAt: result.expiresAt
        };
        if (result.expiresAt) {
          sessionStorage.setItem("pbms_expires_at", result.expiresAt);
        }

        document.getElementById("loginScreen").classList.add("hidden");
        document.getElementById("app").classList.remove("hidden");
        document.getElementById("cashierName").childNodes[0].nodeValue = "KASIR: " + (kName || "") + " ";

        await loadBarang();
        await fetchMejaSessions();
        if (!activeMeja || !mejaSessions[activeMeja]) {
          await loadCartDraftServer();
        }
        cekServer();
        updateMejaHeaderUI();
        updateSaveOrderButton();
        startSessionTimer(result.expiresAt || sessionStorage.getItem("pbms_expires_at"));
      } else {
        sessionStorage.clear();
        document.getElementById("app").classList.add("hidden");
        document.getElementById("loginScreen").classList.remove("hidden");
      }
    } catch (e) {
      console.error("Session validation on load error:", e);
      sessionStorage.clear();
      document.getElementById("app").classList.add("hidden");
      document.getElementById("loginScreen").classList.remove("hidden");
    }
  }
});


// ==================================================
// FORMAT RUPIAH
// ==================================================

function rupiah(value) {

  return "Rp" +
    Number(value || 0)
      .toLocaleString("id-ID");

}

// ==================================================
// PARSE & FORMAT CURRENCY (NEW)
// ==================================================

function parseFormattedCurrency(value) {
  if (!value) return 0;
  const str = String(value).trim();
  return Number(str.replace(/\./g, ''));
}

function formatCurrencyInput(value) {
  if (!value) return '';
  const num = parseFormattedCurrency(value);
  if (num === 0) return '';
  return num.toLocaleString('id-ID');
}

function tutupHamburgerMenu() {
  // kode tutup hamburger yang sudah ada
}
 
// === TAHAP 1: UI MODAL PRINTER BLUETOOTH ===
async function bukaModalPengaturanPrinter() {
  document
    .getElementById("modalPengaturanPrinter")
    .classList.remove("hidden");

  muatKonfigurasiPrinterPesananUI();

  const printerApi = window.PBMSBluetoothPrinter;

  if (!printerApi) return;

  const state = printerApi.getState();

  const config = printerApi.getPrinterConfig();

  if (!config) return;

  const namaEl = document.getElementById("namaPrinterAktif");
  const macEl = document.getElementById("macPrinterAktif");

  const statusEl = document.getElementById("statusPrinterBluetooth");

  let isConnected = false;

  if (state && state.bluetoothPrinterHashKey) {
    try {
      const plugin =
        window.Capacitor &&
        window.Capacitor.Plugins &&
        window.Capacitor.Plugins.EscPosPrinter;

      if (plugin && typeof plugin.isPrinterConnected === "function") {
        const nativeResult = await plugin.isPrinterConnected({
          hashKey: state.bluetoothPrinterHashKey
        });

        isConnected = !!(
          nativeResult &&
          nativeResult.value === true
        );
      }
    } catch (error) {
      console.warn(
        "[PRINTER BLUETOOTH] Gagal membaca status native:",
        error
      );
      isConnected = false;
    }
  }

  if (statusEl) {
    statusEl.textContent = isConnected
      ? "Terhubung"
      : "Tidak Terhubung";
    statusEl.style.color = isConnected ? "#16a34a" : "red";
  }

  if (namaEl) {
    namaEl.textContent = config.name || "-";
  }

  if (macEl) {
    macEl.textContent = config.address || "-";
  }
}

function tutupModalPengaturanPrinter() {
  document
    .getElementById("modalPengaturanPrinter")
    .classList.add("hidden");
}

let printerTerpilihBluetooth = null;

async function cariPrinterBluetoothUI() {
  const container = document.getElementById("daftarPrinterBluetooth");
  if (!container) return;

  if (typeof window.cariPrinterBluetooth !== "function") {
    container.innerHTML =
      "<em style='color:#dc2626;'>Modul printer belum termuat.</em>";
    return;
  }

  container.innerHTML =
    "<em style='color:#666;'>Memindai printer Bluetooth...</em>";

  try {
    const devices = await window.cariPrinterBluetooth();

    if (!devices || devices.length === 0) {
      container.innerHTML =
        "<em style='color:#888;'>Tidak ada printer ditemukan.</em>";
      return;
    }

    container.innerHTML = "";
    printerTerpilihBluetooth = null;

    devices.forEach((device) => {
      const label = escapeHtml(device.name || device.alias || "Tanpa Nama");
      const mac = escapeHtml(device.address || "-");

      const item = document.createElement("div");
      item.style.cssText =
        "padding:8px 10px;margin:4px 0;border:2px solid #ddd;" +
        "border-radius:5px;cursor:pointer;background:#fff;";

      item.innerHTML =
        "<strong>" + label + "</strong>" +
        "<div style='font-size:12px;color:#666;'>" + mac + "</div>";

      item.onclick = function () {
        printerTerpilihBluetooth = {
          name: device.name || device.alias || "Tanpa Nama",
          address: device.address || null
        };

        Array.prototype.forEach.call(container.children, function (child) {
          child.style.borderColor = "#ddd";
          child.style.background = "#fff";
        });

        item.style.borderColor = "#007bff";
        item.style.background = "#e7f1ff";

        // STEP 4: Tampilkan printer terpilih sebagai "Printer Aktif"
        const namaEl = document.getElementById("namaPrinterAktif");
        const macEl = document.getElementById("macPrinterAktif");
        if (namaEl) namaEl.textContent = printerTerpilihBluetooth.name;
        if (macEl) macEl.textContent = printerTerpilihBluetooth.address || "-";
      };

      container.appendChild(item);
    });
  } catch (error) {
    console.error("cariPrinterBluetoothUI error:", error);
    container.innerHTML =
      "<em style='color:#dc2626;'>Gagal memindai printer.</em>";
  }
}

async function hubungkanPrinterBluetoothUI() {
  const statusEl = document.getElementById("statusPrinterBluetooth");

  if (!printerTerpilihBluetooth || !printerTerpilihBluetooth.address) {
    alert("Pilih printer dari daftar terlebih dahulu.");
    return;
  }

  if (statusEl && statusEl.textContent === "Menghubungkan...") return;

  if (typeof window.hubungkanPrinterBluetooth !== "function") {
    alert("Modul hubungkan printer belum tersedia.");
    return;
  }

  if (statusEl) {
    statusEl.textContent = "Menghubungkan...";
    statusEl.style.color = "#f59e0b";
  }

  try {
    const hasil = await window.hubungkanPrinterBluetooth(printerTerpilihBluetooth.address);

    if (hasil && hasil.success === true) {
      if (statusEl) {
        statusEl.textContent = "Terhubung";
        statusEl.style.color = "#16a34a";
      }
    } else {
      const pesan = hasil && hasil.message ? hasil.message : "Koneksi gagal.";
      if (statusEl) {
        statusEl.textContent = "Tidak Terhubung";
        statusEl.style.color = "red";
      }
      alert("Gagal menghubungkan printer: " + pesan);
    }
  } catch (error) {
    console.error("hubungkanPrinterBluetoothUI error:", error);
    if (statusEl) {
      statusEl.textContent = "Tidak Terhubung";
      statusEl.style.color = "red";
    }
    alert("Terjadi kesalahan saat menghubungkan printer.");
  }
}

async function testPrintBluetoothUI() {
  if (typeof window.cetakStrukBluetooth !== "function") {
    alert("Modul cetak printer belum tersedia.");
    return;
  }

  const now = new Date();
  const timestamp = now.toLocaleString("id-ID");

  const teksTest =
    "================================\n" +
    "        TEST PRINT PBMS\n" +
    "================================\n" +
    "Printer : RPP02N\n" +
    "Status  : OK\n" +
    "Waktu   : " + timestamp + "\n" +
    "================================\n\n\n";

  try {
    const hasil = await window.cetakStrukBluetooth(teksTest);

    if (hasil && hasil.success === true) {
      alert("Test print berhasil dikirim.");
    } else {
      const pesan =
        hasil && hasil.message
          ? hasil.message
          : "Cetak gagal.";

      alert("Gagal mencetak: " + pesan);
    }
  } catch (error) {
    console.error("testPrintBluetoothUI error:", error);
    alert("Terjadi kesalahan saat mencetak.");
  }
}

async function putuskanPrinterBluetoothUI() {
  const printerApi = window.PBMSBluetoothPrinter;

  if (!printerApi) {
    alert("Modul printer Bluetooth belum tersedia.");
    return;
  }

  const state = printerApi.getState();

  if (!state || !state.bluetoothPrinterHashKey) {
    alert("Printer Bluetooth tidak sedang terhubung.");
    return;
  }

  const konfirmasi = confirm(
    "Putuskan printer Bluetooth " +
    (state.bluetoothPrinterName || "printer ini") +
    "?"
  );

  if (!konfirmasi) {
    return;
  }

  try {
    const hasil = await window.putuskanPrinterBluetooth();

    if (hasil && hasil.success === true) {
      const statusEl = document.getElementById("statusPrinterBluetooth");

      if (statusEl) {
        statusEl.textContent = "Tidak Terhubung";
        statusEl.style.color = "red";
      }

      alert("Printer Bluetooth berhasil diputuskan.");
    } else {
      const pesan =
        hasil && hasil.message
          ? hasil.message
          : "Gagal memutuskan printer Bluetooth.";

      alert(pesan);
    }
  } catch (error) {
    console.error("putuskanPrinterBluetoothUI error:", error);
    alert("Terjadi kesalahan saat memutuskan printer Bluetooth.");
  }
}


// ==================================================
// CART DRAFT HELPERS (TANPA MEJA)
// ==================================================

async function syncCartDraftItem(namaBarang, qty) {
  if (activeMeja && mejaSessions[activeMeja]) return;
  try {
    await authenticatedFetch("/api/cart-draft", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ namaBarang, qty })
    });
  } catch (e) {
    console.error("Gagal sync cart draft item:", e);
  }
}

async function clearCartDraftServer() {
  if (activeMeja && mejaSessions[activeMeja]) return;
  try {
    await authenticatedFetch("/api/cart-draft", {
      method: "DELETE"
    });
  } catch (e) {
    console.error("Gagal clear cart draft:", e);
  }
}

async function loadCartDraftServer() {
  if (activeMeja && mejaSessions[activeMeja]) return;
  try {
    const res = await authenticatedFetch("/api/cart-draft");
    const data = await res.json();
    let draftList = [];
    if (Array.isArray(data)) {
      draftList = data;
    } else if (Array.isArray(data?.data)) {
      draftList = data.data;
    }
    cart = draftList.map(item => ({
      nama: item.nama || item.namaBarang || item.nama_barang,
      qty: Number(item.qty || 1)
    }));
    renderCart();
    updateSaveOrderButton();
    } catch (e) {
    console.error("Gagal load cart draft:", e);
  }
}


// ==================================================
// HAMBURGER MENU TOGGLE
// ==================================================

function toggleHamburgerMenu(event) {
  if (event) {
    event.stopPropagation();
  }

  const dropdown = document.getElementById("hamburgerDropdown");

  if (!dropdown) return;

  dropdown.classList.toggle("show");
}

function tutupHamburgerMenu() {
  const dropdown = document.getElementById("hamburgerDropdown");

  if (!dropdown) return;

  dropdown.classList.remove("show");
}

document.addEventListener("click", function(event) {
  const dropdown = document.getElementById("hamburgerDropdown");
  const button = document.getElementById("menuToggleBtn");

  if (!dropdown || !button) return;

  if (
    !dropdown.contains(event.target) &&
    !button.contains(event.target)
  ) {
    dropdown.classList.remove("show");
  }
});


// ==================================================
// LOGIN KASIR
// ==================================================

async function loginKasir() {

  const kasirIdSelect =
    document.getElementById(
      "loginKasirId"
    );

  const kasirId =
    kasirIdSelect ? Number(kasirIdSelect.value) : 0;


  const pin =
    document
      .getElementById(
        "loginPin"
      )
      .value
      .trim();


  const errorBox =
    document.getElementById(
      "loginError"
    );


  errorBox.classList.add(
    "hidden"
  );


  if (
    !kasirId || isNaN(kasirId)
  ) {

    errorBox.textContent =
      "Silakan pilih kasir.";

    errorBox.classList.remove(
      "hidden"
    );

    return;
  }

  if (
    !pin || pin.length < 6 || !/^\d+$/.test(pin)
  ) {

    errorBox.textContent =
      "PIN harus berupa angka dan minimal 6 digit.";

    errorBox.classList.remove(
      "hidden"
    );

    return;
  }

  const deviceId = getOrCreateDeviceId();

  try {

    const response =
      await fetch(
        apiUrl("/api/login"),
        {
          method:
            "POST",

          headers: {
            "Content-Type":
              "application/json"
          },

          body:
            JSON.stringify({
              kasirId,
              pin,
              deviceId
            })
        }
      );


    const result =
      await response.json();


    if (
      !result.success
    ) {
      if (response.status === 409 || result.code === "SESSION_ACTIVE_OTHER_DEVICE") {
        throw new Error(result.message || "AKUN SEDANG DIGUNAKAN DI DEVICE LAIN.");
      }

      throw new Error(
        result.message ||
        "Login gagal"
      );
    }


    sessionStorage.setItem("pbms_session_id", result.sessionId);
    sessionStorage.setItem("pbms_login_at", result.loginAt);
    sessionStorage.setItem("pbms_expires_at", result.expiresAt);
    sessionStorage.setItem("pbms_kasir_id", result.kasirId);
    sessionStorage.setItem("pbms_nama", result.nama);
    sessionStorage.setItem("pbms_shift_id", result.shiftId);

    if (sessionStorage.getItem("pbms_session_id")) {
      updateWaitingListBadge();
    }

    currentKasir = {
      id: result.kasirId,
      kasirId: result.kasirId,
      nama: result.nama,
      shiftId: result.shiftId,
      sessionId: result.sessionId,
      expiresAt: result.expiresAt
    };


    document
      .getElementById(
        "loginScreen"
      )
      .classList.add(
        "hidden"
      );


    document
      .getElementById(
        "app"
      )
      .classList.remove(
        "hidden"
      );


    document
      .getElementById(
        "cashierName"
      )
      .childNodes[0].nodeValue =
        "KASIR: " + (result.nama || "") + " ";


    await loadBarang();
    await fetchMejaSessions();
    if (!activeMeja || !mejaSessions[activeMeja]) {
      await loadCartDraftServer();
    }


    cekServer();

    updateMejaHeaderUI();
    updateSaveOrderButton();

    startSessionTimer(result.expiresAt);

  } catch (error) {

    errorBox.textContent =
      error.message;

    errorBox.classList.remove(
      "hidden"
    );

  }

}


// ==================================================
// STATUS INTERNET
// ==================================================

let internetStatusTimer = null;

async function cekStatusInternet() {
  const el = document.getElementById("internetStatus");
  if (!el) return;

  let online = navigator.onLine;

  if (online) {
    try {
      await fetch("https://www.gstatic.com/generate_204", {
        method: "GET",
        mode: "no-cors",
        cache: "no-store"
      });
      online = true;
    } catch {
      online = false;
    }
  }

  const textEl = document.getElementById("internetStatusText");
  const dotEl = document.getElementById("internetStatusDot");
  if (textEl) {
    textEl.textContent = online ? "ONLINE" : "OFFLINE";
    textEl.style.color = online ? "#16a34a" : "#dc2626";
  }
  if (dotEl) {
    dotEl.style.backgroundColor = online ? "#16a34a" : "#dc2626";
  }
  el.style.color = "inherit";
}

function mulaiCekStatusInternet() {
  cekStatusInternet();
  clearInterval(internetStatusTimer);
  internetStatusTimer = setInterval(cekStatusInternet, 15000);
}

window.addEventListener("online", cekStatusInternet);
window.addEventListener("offline", cekStatusInternet);

// Jalankan setelah halaman siap.
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", mulaiCekStatusInternet);
} else {
  mulaiCekStatusInternet();
}


// ==================================================
// CEK SERVER
// ==================================================

async function cekServer() {

  try {

    const response =
      await fetch(
        apiUrl("/api/status")
      );


    const result =
      await response.json();


    document
      .getElementById(
        "serverStatus"
      )
      .textContent =
        result.success
          ? "" : "";

  } catch {

    document
      .getElementById(
        "serverStatus"
      )
      .textContent =
        "";

  }

}


// ==================================================
// LOAD BARANG DARI SQLITE
// ==================================================

async function loadBarang() {

  const response =
    await authenticatedFetch(
      "/api/barang"
    );


  const result =
    await response.json();


  if (
    !result.success
  ) {

    throw new Error(
      result.message ||
      "Master Barang gagal dimuat"
    );

  }


  masterBarang =
    result.data;


  const syncInfoTextEl = document.getElementById("syncInfoText");

  if (
    result.updatedAt
  ) {

    if (syncInfoTextEl) {
      syncInfoTextEl.textContent =
        "Produk sync: " +
        new Date(
          result.updatedAt
        ).toLocaleString(
          "id-ID"
        );
    }

  } else {

    if (syncInfoTextEl) {
      syncInfoTextEl.textContent =
        "Database produk lokal kosong";
    }

  }


  activeCategory =
    "SEMUA";


  tampilkanKategori();


  tampilkanBarang();

}


// ==================================================
// SYNC PRODUK
// ==================================================

async function syncProduk() {

  const button =
    document.getElementById(
      "syncProdukBtn"
    );

  const syncOverlay =
    document.getElementById(
      "syncLoadingOverlay"
    );

  if (button) {
    button.disabled = true;
    button.textContent = "SYNC...";
  }

  if (syncOverlay) {
    syncOverlay.classList.add("show");
    syncOverlay.setAttribute("aria-hidden", "false");
  }

  try {

    const response =
      await authenticatedFetch(
        "/api/sync-produk",
        {
          method: "POST"
        }
      );

    const result =
      await response.json();

    if (!result.success) {
      throw new Error(
        result.error ||
        result.message ||
        "Sync produk gagal"
      );
    }

    await loadBarang();

    alert(
      "SYNC PRODUK BERHASIL\n\n" +
      result.jumlah +
      " produk tersimpan."
    );

  } catch (error) {

    alert(
      "SYNC PRODUK GAGAL\n\n" +
      error.message
    );

  } finally {

    if (syncOverlay) {
      syncOverlay.classList.remove("show");
      syncOverlay.setAttribute("aria-hidden", "true");
    }

    if (button) {
      button.disabled = false;
      button.textContent = "SYNC PRODUK";
    }

  }

}


// ==================================================
// KATEGORI
// ==================================================

function getKategori() {

  const kategori =
    masterBarang
      .map(
        item =>
          String(
            item.kategori ||
            "Lainnya"
          ).trim()
      )
      .filter(Boolean);


  return [
    "SEMUA",
    ...new Set(
      kategori
    )
  ];

}


function getCategoryIcon(nama) {
  const nameUpper = String(nama || "").trim().toUpperCase();
  if (nameUpper === "SEMUA") {
    return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"></rect><rect x="14" y="3" width="7" height="7"></rect><rect x="14" y="14" width="7" height="7"></rect><rect x="3" y="14" width="7" height="7"></rect></svg>`;
  } else if (nameUpper === "ROKOK") {
    return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="12" x2="22" y2="12"></line><line x1="18" y1="8" x2="18" y2="16"></line><rect x="2" y="8" width="16" height="8" rx="1"></rect><line x1="6" y1="8" x2="6" y2="16"></line></svg>`;
  } else if (nameUpper === "KASIR") {
    return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"></rect><line x1="2" y1="10" x2="22" y2="10"></line></svg>`;
  } else if (nameUpper === "DAPUR") {
    return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a5 5 0 0 1 5 5v3H7V7a5 5 0 0 1 5-5z"></path><path d="M5 10h14v7a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3v-7z"></path><line x1="9" y1="14" x2="15" y2="14"></line></svg>`;
  } else if (nameUpper === "BAR") {
    return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 22h8"></path><path d="M12 15v7"></path><path d="M6 3h12l-1 8a5 5 0 0 1-5 4 5 5 0 0 1-5-4L6 3z"></path></svg>`;
  } else if (nameUpper === "MEJA") {
    return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"></circle><circle cx="12" cy="12" r="3"></circle></svg>`;
  }
  return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 2 7 12 12 22 7 12 2"></polygon><polyline points="2 17 12 22 22 17"></polyline><polyline points="2 12 12 17 22 12"></polyline></svg>`;
}


function tampilkanKategori() {

  const bar =
    document.getElementById(
      "categoryBar"
    );


  const kategori =
    getKategori();


  bar.innerHTML =
    kategori
      .map(
        nama => `

          <button
            class="category-btn ${
              activeCategory === nama
                ? "active"
                : ""
            }"
            onclick='pilihKategori(${JSON.stringify(nama)})'
          >
            ${getCategoryIcon(nama)}
            <span>${escapeHtml(nama)}</span>

          </button>

        `
      )
      .join("");

}


function pilihKategori(
  kategori
) {

  activeCategory =
    kategori;


  tampilkanKategori();


  tampilkanBarang();

}


// ==================================================
// BARANG
// ==================================================

async function tampilkanBarang() {

  const container =
    document.getElementById(
      "products"
    );


  const keyword =
    document
      .getElementById(
        "search"
      )
      .value
      .trim()
      .toLowerCase();


  let data =
    masterBarang;


  if (
    activeCategory !==
    "SEMUA"
  ) {

    data =
      data.filter(
        item =>
          String(
            item.kategori ||
            "Lainnya"
          ).trim() ===
          activeCategory
      );

  }


  if (
    keyword
  ) {

    data =
      data.filter(
        item =>
          String(
            item.nama ||
            ""
          )
          .toLowerCase()
          .includes(
            keyword
          )
      );

  }


  if (
    !data.length
  ) {

    container.innerHTML =
      `
      <div class="empty-product">
        Barang tidak ditemukan.
      </div>
      `;

    return;

  }


  container.innerHTML =
    data
      .map(
        item => `

          <button
            class="product-card"
            onclick='tambahBarang(${JSON.stringify(item)})'
          >

            <div class="product-name">

              ${escapeHtml(
                item.nama
              )}

            </div>


            <div class="product-price">

              ${rupiah(
                item.hargaJual
              )}

            </div>

          </button>

        `
      )
      .join("");

}


// ==================================================
// SEARCH
// ==================================================

document
  .getElementById(
    "search"
  )
  .addEventListener(
    "input",
    function () {

      tampilkanBarang();

    }
  );


// ==================================================
// LOGIKA API MEJA & SESI (SQLITE BACKEND)
// ==================================================

async function fetchMejaSessions() {
  try {
    const res = await authenticatedFetch("/api/meja/sesi");
    const data = await res.json();
    mejaSessions = {};
    if (Array.isArray(data)) {
      data.forEach(m => {
        mejaSessions[m.nomorMeja] = m;
      });
    }

    const dataMejaList = [];
    for (let i = 1; i <= 10; i++) {
      const rawSession = mejaSessions[i];
      const session = window.MejaTimer ? window.MejaTimer.normalisasiSesiMeja(rawSession) : rawSession;
      
      let statusMeja = "TERSEDIA";
      if (!session || session.status !== "AKTIF") {
        statusMeja = "TERSEDIA";
      } else {
        const jenisSesiStr = String(session.jenisSesi || session.jenis_sesi || "").toUpperCase();
        if (jenisSesiStr === "LOSS") {
          statusMeja = "AKTIF";
        } else {
          const waktuSelesai = session.waktuSelesai;
          if (!waktuSelesai) {
            statusMeja = "AKTIF";
          } else {
            const end = window.MejaTimer ? window.MejaTimer.parseDate(waktuSelesai) : new Date(waktuSelesai);
            const now = new Date();
            if (!end || isNaN(end.getTime())) {
              statusMeja = "AKTIF";
            } else {
              const totalMs = end.getTime() - now.getTime();
              if (totalMs <= 0) {
                statusMeja = "HABIS";
              } else if (totalMs <= 30 * 60 * 1000) {
                statusMeja = "HAMPIR_HABIS";
              } else {
                statusMeja = "AKTIF";
              }
            }
          }
        }
      }
      dataMejaList.push({
        nomorMeja: i,
        status: statusMeja,
        session: session && session.status === "AKTIF" ? session : null
      });
    }

    if (typeof window.updateStatusMejaKaryawan === "function") {
      window.updateStatusMejaKaryawan(dataMejaList);
    }

    // Update tampilan popup meja setelah data sesi diperbarui
    renderPopupMeja();
    updateMejaHeaderUI();
  } catch (error) {
    console.error("Gagal mengambil sesi meja:", error);
  }
}

async function fetchDetailSesi(sessionId, loadCart = false) {
  try {
    const res = await authenticatedFetch(`/api/meja/sesi/${sessionId}`);
    const data = await res.json();
    if (data.success) {
      // Pulihkan identitas member dari sesi database agar harga member tidak hilang
      // ketika cart di-refresh, qty dikurangi, atau qty ditambah kembali.
      if (activeMeja && data.session?.memberId && data.session?.kategoriMember) {
        memberByMeja.set(String(activeMeja), {
          idMember: data.session.memberId,
          kategori: data.session.kategoriMember
        });
      }

      // Ambil hargaJual/subtotal dari server secara tepat
      const itemsBaru = (data.items || []).map(item => {
        const hJual = item.hargaJual !== undefined ? item.hargaJual : (item.harga !== undefined ? item.harga : 0);
        return {
          nama: item.nama,
          qty: item.qty,
          hargaJual: hJual,
          harga: hJual,
          subtotal: item.subtotal !== undefined ? item.subtotal : (hJual * item.qty)
        };
      });
      
      // Ambil data sesi terbaru dari /api/meja/sesi untuk memperbarui mejaSessions
      const resSesi = await authenticatedFetch("/api/meja/sesi");
      const dataSesi = await resSesi.json();
      if (Array.isArray(dataSesi)) {
        dataSesi.forEach(m => {
          mejaSessions[m.nomorMeja] = m;
        });
      }

      // Hanya muat cart dari server ketika explicitly diminta
      if (loadCart) {
        if (activeMeja && mejaSessions[activeMeja]) {
          const jenisSesiStr = String(mejaSessions[activeMeja].jenisSesi || mejaSessions[activeMeja].jenis_sesi || "").toUpperCase();
          if (jenisSesiStr !== "LOSS") {
            const durasiMeja = Number(mejaSessions[activeMeja].durasiJam || 0);
            const itemMeja = itemsBaru.find(
              x => String(x.nama || '').trim().toLowerCase() === 'meja billiard'
            );
            if (itemMeja && durasiMeja > 0) {
              itemMeja.qty = durasiMeja;
              const hargaPerJam = Number(
                itemMeja.hargaJual !== undefined
                  ? itemMeja.hargaJual
                  : (itemMeja.harga !== undefined ? itemMeja.harga : 0)
              );
              if (hargaPerJam > 0) {
                itemMeja.subtotal = hargaPerJam * durasiMeja;
              }
            }
          }
        }

        cart = itemsBaru;
      }

      if (activeMeja && mejaSessions[activeMeja]) {
        mejaSessions[activeMeja].cart = cart;
      }

      renderPopupMeja();
      if (loadCart) {
        renderCart();
      }
      updateSaveOrderButton();
      updateMejaHeaderUI();
    } else {
      throw new Error(data.message || "Gagal mengambil detail sesi");
    }
  } catch (error) {
    console.error("Error fetchDetailSesi:", error);
    alert("Gagal memuat detail pesanan meja: " + error.message);
  }
}

async function bukaPopupPilihMeja() {
  try {
    const tasks = [fetchMejaSessions()];

    // Pastikan data booking terbaru tersedia sebelum kartu meja dirender.
    if (typeof getWaitingList === "function") {
      tasks.push(
        getWaitingList()
          .then(latestWaitingList => {
            if (typeof waitingListData !== "undefined" && Array.isArray(latestWaitingList)) {
              waitingListData = latestWaitingList;
            }
          })
          .catch(error => {
            console.warn("Gagal refresh waiting list saat membuka popup meja:", error);
          })
      );
    }

    await Promise.all(tasks);
    renderPopupMeja();
    document.getElementById("pilihMejaPopup").classList.add("show");
  } catch (error) {
    console.error("Gagal membuka popup pilih meja:", error);
    alert("Gagal memuat data meja. Silakan coba lagi.");
  }
}

function tutupPopupPilihMeja() {
  document.getElementById("pilihMejaPopup").classList.remove("show");
}

function tutupPopupPilihMejaLuar(event) {
  if (event.target.id === "pilihMejaPopup") {
    tutupPopupPilihMeja();
  }
}

function mesaNoSafe(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : -1;
}

function renderPopupMeja() {
  const grid = document.getElementById("popupTableGrid");
  if (!grid) return;

  // Bersihkan timer lama pada elemen grid meja sebelum render ulang
  for (const key in mejaTimersCleanup) {
    if (key !== 'cart_loss' && typeof mejaTimersCleanup[key] === 'function') {
      mejaTimersCleanup[key]();
      delete mejaTimersCleanup[key];
    }
  }

  let html = "";
  for (let i = 1; i <= 10; i++) {
    const rawSession = mejaSessions[i];
    const session = window.MejaTimer ? window.MejaTimer.normalisasiSesiMeja(rawSession) : rawSession;
    const isSelected = activeMeja === i;
    
    let statusText = "KOSONG";
    let cardClass = "popup-table-btn";

    if (session && session.status === "AKTIF") {
      statusText = "AKTIF";
    }

    if (isSelected) {
      cardClass += " active-selected";
    }

    // CHECK BADGES (KARYAWAN & BOOKING)
    const jenisSesiStr = String(session?.jenisSesi || session?.jenis_sesi || "").toUpperCase();
    const isKaryawan = jenisSesiStr === "KARYAWAN";
    const isLoss = jenisSesiStr === "LOSS";

    const currentWaitingList = (typeof waitingListData !== "undefined" && Array.isArray(waitingListData))
      ? waitingListData
      : (typeof window !== "undefined" && Array.isArray(window.waitingListData) ? window.waitingListData : []);

    const isBooking = Boolean(
      session?.isBooking ||
      session?.hasBooking ||
      session?.booking ||
      jenisSesiStr === "BOOKING" ||
      currentWaitingList.some(w => {
        const mejaNo = Number(w?.nomorMeja || w?.nomor_meja);
        const status = String(w?.status || "").toUpperCase();
        return mejaNo === i && ["WAITING", "CONFIRMED", "BOOKING"].includes(status);
      })
    );

    // 1. TOP BADGES (MEMBER / KARYAWAN / BOOKING CUSTOMER)
    const bookingForTable = currentWaitingList.find(w => {
      const mejaNo = Number(w?.nomorMeja || w?.nomor_meja);
      const status = String(w?.status || "").toUpperCase();
      return mesaNoSafe(mejaNo) === mesaNoSafe(i) && ["WAITING", "CONFIRMED", "BOOKING"].includes(status);
    });

    let topBadgesHtml = "";
    let bookingTimeHtml = "";

    if (isKaryawan) {
      topBadgesHtml += `<span class="ribbon-karyawan">KARYAWAN</span>`;
    }

    // BOOKING HANYA DARI WAITING LIST.
    // Tampilkan nama sebagai "BOOKING Nama" dan jam booking.
    if (bookingForTable && bookingForTable.namaCustomer) {
      const namaBooking = escapeHtml(String(bookingForTable.namaCustomer).trim());
      const jamBooking = escapeHtml(String(bookingForTable.jamBooking || bookingForTable.jam_booking || "").trim());

      topBadgesHtml += `<span class="badge-member" title="Booking ${namaBooking}">BOOKING ${namaBooking}</span>`;

      if (jamBooking) {
        bookingTimeHtml = `<div style="font-size: 0.7rem; font-weight: 800; color: #d97706; line-height: 1.1; margin-top: 1px;">${jamBooking}</div>`;
      }
    } else if (session && session.status === "AKTIF" && session.namaPemesan) {
      topBadgesHtml += `<span class="badge-member" title="${escapeHtml(session.namaPemesan)}">${escapeHtml(session.namaPemesan)}</span>`;
    }

    const topContainerHtml = `<div class="meja-top-badge-container"${!topBadgesHtml ? ' style="visibility: hidden;"' : ''}>${topBadgesHtml || '<span class="badge-member">-</span>'}${bookingTimeHtml}</div>`;

    // 2. MEJA XX
    const mejaNumHtml = `<div class="popup-table-num">MEJA ${i < 10 ? '0' + i : i}</div>`;

    // 3. STATUS AKTIF / KOSONG
    const statusHtml = `<div class="popup-table-status">${statusText}</div>`;

    // 4. BADGE BOOKING
    // Jika booking berasal dari Waiting List dan sudah ditampilkan di bagian atas,
    // jangan tampilkan badge BOOKING kedua di bawah MEJA.
    const bookingBadgeHtml = `<div class="meja-booking-container"${(!isBooking || bookingForTable) ? ' style="visibility: hidden;"' : ''}><span class="ribbon-booking">BOOKING</span></div>`;

    // 5 & 6. TIMER & TOMBOL STOP LOSS / PINDAH MEJA
    let timerHtml = "";
    if (session && session.status === "AKTIF") {
      if (isLoss) {
        timerHtml = `
          <div class="meja-timer-box">
            <div class="meja-timer-label" style="color: #059669; font-weight: 800;">WAKTU LOSS</div>
            <div id="timer-meja-${i}" class="meja-timer-val" style="color: #059669 !important;">00:00:00</div>
            <div style="display: flex; gap: 4px; margin-top: 4px;">
              <button 
                onclick="event.stopPropagation(); bukaModalPindahMeja(${i})"
                style="padding: 3px 6px; background: #2563eb; color: #ffffff; border: none; border-radius: 6px; font-size: 0.65rem; font-weight: 800; cursor: pointer;"
              >
                PINDAH
              </button>
              <button 
                class="btn-stop-loss" 
                onclick="event.stopPropagation(); stopWaktuLoss('${session.sessionId}', this)"
                style="padding: 3px 6px; background: #dc2626; color: #ffffff; border: none; border-radius: 6px; font-size: 0.65rem; font-weight: 800; cursor: pointer;"
              >
                STOP
              </button>
            </div>
          </div>
        `;
      } else {
        timerHtml = `
          <div class="meja-timer-box">
            <div class="meja-timer-label">SISA WAKTU</div>
            <div id="timer-meja-${i}" class="meja-timer-val">00:00:00</div>
            <div style="display: flex; gap: 4px; justify-content: center; align-items: center; margin-top: 2px;">
              <span class="meja-timer-sub" style="margin-top:0;">Selesai: ${session.waktuSelesai ? window.MejaTimer.formatJam(session.waktuSelesai) : '-'}</span>
              <button 
                onclick="event.stopPropagation(); bukaModalPindahMeja(${i})"
                style="padding: 2px 6px; background: #2563eb; color: #ffffff; border: none; border-radius: 6px; font-size: 0.65rem; font-weight: 800; cursor: pointer; flex-shrink: 0;"
              >
                PINDAH
              </button>
            </div>
          </div>
        `;
      }
    } else {
      timerHtml = `
        <div class="meja-timer-box" style="visibility: hidden;">
          <div class="meja-timer-label">SISA WAKTU</div>
          <div class="meja-timer-val">--:--:--</div>
          <div class="meja-timer-sub">Selesai: -</div>
        </div>
      `;
    }

    // Menggunakan DIV dengan role="button" untuk kontainer utama meja agar struktur HTML valid tanpa nested button
    html += `
      <div class="${cardClass}" onclick="klikMejaPopup(${i})" role="button" tabindex="0">
        ${topContainerHtml}
        ${mejaNumHtml}
        ${statusHtml}
        ${bookingBadgeHtml}
        ${timerHtml}
      </div>
    `;
  }
  grid.innerHTML = html;

  if (window.MejaBubble) {
    window.MejaBubble.update(mejaSessions);
  }

  // Inisialisasi timer (Count-Up LOSS / Countdown DURASI) untuk setiap meja aktif
  for (let i = 1; i <= 10; i++) {
    const rawSession = mejaSessions[i];
    const session = window.MejaTimer ? window.MejaTimer.normalisasiSesiMeja(rawSession) : rawSession;
    if (session && session.status === "AKTIF") {
      const timerEl = document.getElementById(`timer-meja-${i}`);
      if (timerEl && window.MejaTimer) {
        const jenisSesiStr = String(session.jenisSesi || session.jenis_sesi || "").toUpperCase();
        if (jenisSesiStr === "LOSS") {
          if (session.waktuMulai) {
            const stopFn = window.MejaTimer.mulaiCountUpLoss(timerEl, session.waktuMulai);
            if (typeof stopFn === 'function') {
              mejaTimersCleanup[i] = stopFn;
            }
          } else {
            timerEl.textContent = "00:00:00";
          }
        } else {
          if (session.durasiJam === null || session.durasiJam === 0 || !session.waktuSelesai) {
            timerEl.textContent = "TIMER BELUM TERSEDIA";
          } else {
            const stopFn = window.MejaTimer.mulaiCountdownMeja(
              timerEl,
              session.waktuSelesai,
              {
                jenisSesi: session.jenisSesi || session.jenis_sesi || "BIASA"
              }
            );
            if (typeof stopFn === 'function') {
              mejaTimersCleanup[i] = stopFn;
            }
          }
        }
      }
    }
  }
}

// FUNGSI UNTUK MENGHENTIKAN SESI WAKTU LOSS
async function stopWaktuLoss(sessionId, btnElement) {
  if (!sessionId) {
    alert("Session ID tidak valid.");
    return;
  }

  if (isProcessingStopLoss) return;

  // Proteksi Double Click
  if (btnElement) {
    if (btnElement.disabled) return;
    btnElement.disabled = true;
    btnElement.dataset.originalText = btnElement.textContent || "STOP WAKTU";
    btnElement.textContent = "MEMPROSES...";
  }

  // Cari objek sesi dan tentukan nomor meja
  let targetNomorMeja = null;
  let session = null;
  for (const key in mejaSessions) {
    if (mejaSessions[key] && mejaSessions[key].sessionId === sessionId) {
      session = mejaSessions[key];
      targetNomorMeja = Number(key);
      break;
    }
  }

  if (!session || session.status !== "AKTIF") {
    alert("Sesi meja tidak dalam status AKTIF.");
    if (btnElement) {
      btnElement.disabled = false;
      btnElement.textContent = btnElement.dataset.originalText || "STOP WAKTU";
    }
    return;
  }

  const jenisSesiStr = String(session.jenisSesi || session.jenis_sesi || "").toUpperCase();
  if (jenisSesiStr !== "LOSS") {
    alert("Sesi ini bukan sesi WAKTU LOSS.");
    if (btnElement) {
      btnElement.disabled = false;
      btnElement.textContent = btnElement.dataset.originalText || "STOP WAKTU";
    }
    return;
  }

  // AKTIFKAN LOADING LOCK STATE SEBELUM PROSES DIMALAI
  isProcessingStopLoss = true;

  // PASTIKAN activeMeja DAN nomorMeja TERSINKRONISASI SEBELUM REFRESH DATA
  if (targetNomorMeja) {
    activeMeja = targetNomorMeja;
    nomorMeja = targetNomorMeja;
    // Simpan sessionId karena setelah STOP LOSS, GET /api/meja/sesi
    // hanya mengembalikan sesi yang masih AKTIF.
    stoppedSessionIdsByMeja[targetNomorMeja] = sessionId;
    pendingPaymentTableNo = targetNomorMeja;
    updateMejaHeaderUI();
  }

  try {
    // Pengiriman payload HANYA sessionId ke server
    const response = await authenticatedFetch("/api/meja/loss/stop", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        sessionId: sessionId,
        deviceId: getOrCreateDeviceId()
      })
    });

    const result = await response.json();

    if (!result.success) {
      throw new Error(result.message || "Gagal menghentikan WAKTU LOSS.");
    }

    // Refresh sesi meja & detail cart dari server
    await fetchMejaSessions();
    await fetchDetailSesi(sessionId, true);

    // Setelah STOP berhasil, tutup popup supaya cart pembayaran langsung terlihat.
    tutupPopupPilihMeja();

    alert("Waktu Loss berhasil dihentikan. Biaya telah dihitung oleh server.");

  } catch (error) {
    console.error("Gagal stop waktu loss:", error);
    alert("Gagal menghentikan waktu loss: " + error.message);
  } finally {
    isProcessingStopLoss = false;
    if (btnElement) {
      btnElement.disabled = false;
      btnElement.textContent = btnElement.dataset.originalText || "STOP WAKTU";
    }
    renderCart();
  }
}

window.stopWaktuLoss = stopWaktuLoss;

// ==================================================
// LOGIKA FITUR PINDAH MEJA
// ==================================================

async function bukaModalPindahMeja(nomorAsal) {
  const nomor = Number(nomorAsal);
  if (!nomor || nomor < 1 || nomor > 10) {
    alert("Nomor meja asal tidak valid.");
    return;
  }

  const session = mejaSessions[nomor];
  if (!session || session.status !== "AKTIF") {
    alert("Meja " + (nomor < 10 ? "0" + nomor : nomor) + " tidak dalam status AKTIF.");
    return;
  }

  targetPindahSessionId = session.sessionId;
  targetPindahMejaAsal = nomor;

  // Set teks meja asal & customer
  document.getElementById("pindahMejaAsalText").textContent = "MEJA " + (nomor < 10 ? "0" + nomor : nomor);
  document.getElementById("pindahNamaCustomerText").textContent = session.namaPemesan || "-";

  // Hitung Sisa Waktu / Status
  const timerEl = document.getElementById(`timer-meja-${nomor}`);
  let sisaText = "--:--:--";
  if (timerEl) {
    sisaText = timerEl.textContent || "--:--:--";
  } else {
    const jenisSesiStr = String(session.jenisSesi || session.jenis_sesi || "").toUpperCase();
    if (jenisSesiStr === "LOSS") {
      sisaText = "WAKTU LOSS";
    } else if (session.waktuSelesai) {
      sisaText = window.MejaTimer ? window.MejaTimer.formatJam(session.waktuSelesai) : session.waktuSelesai;
    }
  }
  document.getElementById("pindahSisaWaktuText").textContent = sisaText;

  // Ambil data booking dari waiting list
  const currentWaitingList = (typeof waitingListData !== "undefined" && Array.isArray(waitingListData))
    ? waitingListData
    : (typeof window !== "undefined" && Array.isArray(window.waitingListData) ? window.waitingListData : []);

  // Filter meja yang benar-benar KOSONG
  // Meja aktif, meja karyawan, atau meja booking TIDAK BISA dipilih sebagai tujuan.
  const selectEl = document.getElementById("pindahMejaTujuanSelect");
  selectEl.innerHTML = `<option value="">-- Pilih Meja Tujuan --</option>`;

  let countKosong = 0;
  for (let i = 1; i <= 10; i++) {
    if (i === nomor) continue; // Skip meja asal

    const sess = mejaSessions[i];
    const isAktif = sess && sess.status === "AKTIF";
    
    // Check booking status
    const isBooking = currentWaitingList.some(w => {
      const mejaNo = Number(w?.nomorMeja || w?.nomor_meja);
      const status = String(w?.status || "").toUpperCase();
      return mejaNo === i && ["WAITING", "CONFIRMED", "BOOKING"].includes(status);
    });

    if (!isAktif && !isBooking) {
      countKosong++;
      const option = document.createElement("option");
      option.value = i;
      option.textContent = `MEJA ${i < 10 ? '0' + i : i} (KOSONG)`;
      selectEl.appendChild(option);
    }
  }

  if (countKosong === 0) {
    alert("Tidak ada meja lain yang kosong saat ini.");
    return;
  }

  document.getElementById("pindahMejaModal").classList.add("show");
}

function tutupModalPindahMeja() {
  const modal = document.getElementById("pindahMejaModal");
  if (modal) modal.classList.remove("show");
  targetPindahSessionId = null;
  targetPindahMejaAsal = null;
  const btn = document.getElementById("konfirmasiPindahMejaBtn");
  if (btn) {
    btn.disabled = false;
    btn.textContent = "KONFIRMASI PINDAH";
  }
}

function tutupModalPindahMejaLuar(event) {
  if (event.target.id === "pindahMejaModal") {
    tutupModalPindahMeja();
  }
}

async function eksekusiPindahMeja() {
  const selectEl = document.getElementById("pindahMejaTujuanSelect");
  const nomorTujuan = selectEl ? Number(selectEl.value) : 0;

  if (!targetPindahSessionId || !targetPindahMejaAsal) {
    alert("Data meja asal tidak valid.");
    return;
  }

  if (!nomorTujuan || nomorTujuan < 1 || nomorTujuan > 10) {
    alert("Silakan pilih meja tujuan yang kosong.");
    return;
  }

  if (nomorTujuan === targetPindahMejaAsal) {
    alert("Meja tujuan tidak boleh sama dengan meja asal.");
    return;
  }

  // Simpan nilai asal dan sessionId ke variabel lokal SEBELUM memanggil tutupModalPindahMeja()
  const sessionIdPindah = targetPindahSessionId;
  const mejaAsalPindah = targetPindahMejaAsal;

  const textAsal = mejaAsalPindah < 10 ? "0" + mejaAsalPindah : mejaAsalPindah;
  const textTujuan = nomorTujuan < 10 ? "0" + nomorTujuan : nomorTujuan;

  const konfirmasi = confirm(`Pindahkan dari Meja ${textAsal} ke Meja ${textTujuan}?`);
  if (!konfirmasi) return;

  const btn = document.getElementById("konfirmasiPindahMejaBtn");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "MEMPROSES...";
  }

  try {
    const response = await authenticatedFetch("/api/meja/pindah", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        sessionId: sessionIdPindah,
        nomorMejaAsal: mejaAsalPindah,
        nomorMejaTujuan: nomorTujuan
      })
    });

    const result = await response.json();

    if (!result.success) {
      throw new Error(result.message || "Gagal memindahkan meja.");
    }

    tutupModalPindahMeja();

    // Transfer member mapping jika ada
    if (memberByMeja.has(String(mejaAsalPindah))) {
      const m = memberByMeja.get(String(mejaAsalPindah));
      memberByMeja.set(String(nomorTujuan), m);
      memberByMeja.delete(String(mejaAsalPindah));
    }

    // Refresh data sesi meja
    await fetchMejaSessions();

    // Pindah UI activeMeja dan nomorMeja ke meja tujuan
    activeMeja = nomorTujuan;
    nomorMeja = nomorTujuan;

    // Load detail sesi meja baru (menjaga cart & items utuh)
    await fetchDetailSesi(result.sessionId, true);

    updateMejaHeaderUI();
    renderCart();
    updateSaveOrderButton();
    alert(`Berhasil memindahkan sesi ke Meja ${textTujuan}.`);

  } catch (error) {
    console.error("Error eksekusiPindahMeja:", error);
    alert("Gagal memindahkan meja: " + error.message);
    fetchMejaSessions().catch(() => {});
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "KONFIRMASI PINDAH";
    }
  }
}

async function klikMejaPopup(nomor) {
  // Jangan izinkan cart pembayaran LOSS yang sudah di-stop ditimpa
  // oleh pemilihan meja lain sampai transaksi tersebut selesai.
  if (
    pendingPaymentTableNo !== null &&
    Number(nomor) !== Number(pendingPaymentTableNo)
  ) {
    alert(
      `Meja ${pendingPaymentTableNo < 10 ? "0" + pendingPaymentTableNo : pendingPaymentTableNo} sudah STOP WAKTU dan menunggu pembayaran. Selesaikan pembayaran terlebih dahulu.`
    );
    return;
  }

  tutupPopupPilihMeja();

  if (typeof getWaitingList === "function") {
    try {
      const latestWaitingList = await getWaitingList();
      if (typeof waitingListData !== "undefined" && Array.isArray(latestWaitingList)) {
        waitingListData = latestWaitingList;
        if (typeof window !== "undefined") {
          window.waitingListData = latestWaitingList;
        }
      }
    } catch (error) {
      console.warn("Gagal refresh waiting list saat klik meja:", error);
    }
  }

  // ==================================================
  // PRIORITAS 1: SESI AKTIF
  // ==================================================
  const session = mejaSessions[nomor];

  if (session && session.status === "AKTIF") {
    activeMeja = nomor;
    const cekBtn = document.getElementById("cekHargaMejaBtn");
    if (cekBtn) {
      cekBtn.disabled = false;
      cekBtn.textContent = "CEK";
    }

    nomorMeja = nomor;
    updateMejaHeaderUI();
    updateSaveOrderButton();
    await fetchDetailSesi(session.sessionId, true);
    return;
  }

  // ==================================================
  // PRIORITAS 2: BOOKING (WAITING LIST)
  // ==================================================
  const currentWaitingList = (typeof waitingListData !== "undefined" && Array.isArray(waitingListData))
    ? waitingListData
    : (typeof window !== "undefined" && Array.isArray(window.waitingListData) ? window.waitingListData : []);

  const foundBooking = currentWaitingList.find(w => {
    const mejaNo = Number(w?.nomorMeja || w?.nomor_meja);
    const status = String(w?.status || "").toUpperCase();
    return mesaNoSafe(mejaNo) === mesaNoSafe(nomor) && ["WAITING", "CONFIRMED", "BOOKING"].includes(status);
  });

  if (foundBooking && typeof mejaSiap === "function") {
    mejaSiap(foundBooking.id);
    return;
  }

  // ==================================================
  // PRIORITAS 3: MEJA BIASA
  // ==================================================
  if (!window.MejaModal || typeof window.MejaModal.buka !== "function") {
    alert("Modul meja-modal.js belum termuat.");
    return;
  }

  if (window.MejaProdukModal && typeof window.MejaProdukModal.mulaiMejaBaru === "function") {
    window.MejaProdukModal.mulaiMejaBaru();
  }

  window.MejaModal.buka(nomor);
}

// BRIDGE FUNCTION UNTUK MEJA-MODAL.JS & FITUR WAKTU LOSS
let modeSesiDraft = "DURASI";

function setModeSesiBukaMeja(mode) {
  modeSesiDraft = (mode === "LOSS" || mode === "WAKTU LOSS") ? "LOSS" : "DURASI";
  const hiddenInput = document.getElementById("inputJenisSesi");
  if (hiddenInput) hiddenInput.value = modeSesiDraft;

  const cardDurasi = document.getElementById("modeDurasiCard");
  const cardLoss = document.getElementById("modeLossCard");
  const containerDurasi = document.getElementById("containerDurasiMain");
  const infoLossBox = document.getElementById("infoWaktuLossBox");

  if (modeSesiDraft === "LOSS") {
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
    if (containerDurasi) containerDurasi.style.display = "none";
    if (infoLossBox) infoLossBox.style.display = "block";
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
    if (containerDurasi) containerDurasi.style.display = "block";
    if (infoLossBox) infoLossBox.style.display = "none";
  }
}

window.bukaMejaDariModalBaru = async function(nomor, namaPemesan, durasiJam, draft, jenisSesi) {
  targetBukaMejaNomor = nomor;
  if (pendingMemberForMeja) {
    memberByMeja.set(String(nomor), pendingMemberForMeja);
    pendingMemberForMeja = null;
  }
  const input = document.getElementById("inputNamaPemesan");
  if (input) {
    input.value = namaPemesan;
  }

  if (jenisSesi === "LOSS" || jenisSesi === "WAKTU LOSS") {
    setModeSesiBukaMeja("LOSS");
  } else {
    setModeSesiBukaMeja("DURASI");
  }

  const berhasil = await konfirmasiMulaiSesi(durasiJam, draft, jenisSesi);
  return berhasil;
};

window.handleMulaiMain = window.handleMulaiMain || window.bukaMejaDariModalBaru;

function tutupModalBukaMeja() {
  document.getElementById("bukaMejaModal").classList.remove("show");
  targetBukaMejaNomor = null;
  setModeSesiBukaMeja("DURASI");
}

function tutupModalBukaMejaLuar(event) {
  if (event.target.id === "bukaMejaModal") {
    tutupModalBukaMeja();
  }
}

async function konfirmasiMulaiSesi(durasiJam = 1, draft = [], jenisSesiParam = null) {
  const input = document.getElementById("inputNamaPemesan");
  const namaPemesan = input ? input.value.trim() : "";

  if (!namaPemesan) {
    alert("Nama pemesan wajib diisi.");
    return false;
  }

  let selectedMode = modeSesiDraft;
  if (jenisSesiParam === "LOSS" || jenisSesiParam === "WAKTU LOSS") {
    selectedMode = "LOSS";
  } else if (jenisSesiParam === "DURASI" || jenisSesiParam === "BIASA") {
    selectedMode = "DURASI";
  }

  const finalJenisSesi = (selectedMode === "LOSS") ? "LOSS" : "BIASA";

  let finalDurasiJam = Number(durasiJam);

  if (selectedMode === "LOSS") {
    finalDurasiJam = 0;
  } else {
    if (!Number.isInteger(finalDurasiJam) || finalDurasiJam < 1) {
      alert("Durasi meja tidak valid.");
      return false;
    }
  }

  if (!targetBukaMejaNomor) {
    return false;
  }

  const selectedMember = memberByMeja.get(String(targetBukaMejaNomor)) || pendingMemberForMeja;
  const memberId = selectedMember?.idMember || selectedMember?.id || selectedMember?.kodeMember || null;

  const requestPayload = {
    nomorMeja: targetBukaMejaNomor,
    namaPemesan: namaPemesan,
    kasir: currentKasir ? currentKasir.nama : "-",
    durasiJam: finalDurasiJam,
    jenisSesi: finalJenisSesi,
    modeSesi: finalJenisSesi
  };

  if (memberId) {
    requestPayload.memberId = memberId;
  }

  try {
    const response = await authenticatedFetch("/api/meja/buka", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestPayload)
    });

    const result = await response.json();

    if (!result.success) {
      throw new Error(result.message || "Gagal membuka meja");
    }

    const sessionId = result.sessionId;

    if (Array.isArray(draft) && draft.length > 0) {
      for (const item of draft) {
        if (!item || !item.nama) continue;
        const qty = Number(item.qty);
        if (!Number.isInteger(qty) || qty <= 0) continue;

        const responsePesanan = await authenticatedFetch("/api/meja/pesanan", {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            sessionId,
            namaBarang: item.nama,
            qty
          })
        });

        const resultPesanan = await responsePesanan.json();

        if (!resultPesanan.success) {
          throw new Error(
            resultPesanan.message ||
            `Gagal menyimpan produk: ${item.nama}`
          );
        }
      }
    }

    fetchMejaSessions().catch(error => {
      console.error("Gagal refresh daftar meja setelah buka:", error);
    });

    activeMeja = targetBukaMejaNomor;
    const cekBtn = document.getElementById("cekHargaMejaBtn");
    if (cekBtn) {
      cekBtn.disabled = false;
      cekBtn.textContent = "CEK";
    }

    nomorMeja = targetBukaMejaNomor;

    tutupModalBukaMeja();

    updateMejaHeaderUI();
    updateSaveOrderButton();

    if (sessionId) {
      fetchDetailSesi(sessionId, true).catch(error => {
        console.error("Gagal refresh detail sesi setelah buka:", error);
      });
    }

    return true;

  } catch (error) {
    alert("Gagal membuka meja: " + error.message);
    return false;
  }
}

function updateMejaHeaderUI() {
  const btnMejaText = document.getElementById("btnMejaText");
  if (btnMejaText) {
    btnMejaText.textContent = "MEJA";
  }

  const mejaActiveBadge = document.getElementById("mejaActiveBadge");
  const jumlahMejaAktif = Object.values(mejaSessions)
    .filter(meja => meja && meja.status === "AKTIF")
    .length;

  if (mejaActiveBadge) {
    if (jumlahMejaAktif > 0) {
      mejaActiveBadge.textContent = jumlahMejaAktif;
      mejaActiveBadge.style.display = "inline-flex";
    } else {
      mejaActiveBadge.textContent = "";
      mejaActiveBadge.style.display = "none";
    }
  }

  updateSaveOrderButton();
  if (typeof updateWaitingListBadge === "function") {
    if (sessionStorage.getItem("pbms_session_id")) {
      updateWaitingListBadge();
    }
  }
}

async function updateWaitingListBadge() {
  try {
    if (typeof getWaitingList !== "function") return;
    const list = await getWaitingList();
    const count = Array.isArray(list)
      ? list.filter(item => item && String(item.status || "").toUpperCase() === "WAITING").length
      : 0;
    const badge = document.getElementById("waitingListBadge");
    if (badge) {
      if (count > 0) {
        badge.textContent = count;
        badge.style.display = "inline-flex";
      } else {
        badge.textContent = "";
        badge.style.display = "none";
      }
    }
  } catch (error) {
    console.error("Gagal update badge waiting list:", error);
  }
}


// ==================================================
// LOGIKA VISIBILITAS TOMBOL SIMPAN PESANAN
// ==================================================

function updateSaveOrderButton() {
  const button = document.getElementById("saveOrderBtn");

  const shouldShow = Boolean(activeMeja) && cart.length > 0;

  if (!button) return;

  if (shouldShow) {
    button.style.display = "flex";
    button.style.setProperty("display", "flex", "important");
    button.style.setProperty("visibility", "visible", "important");
    button.style.setProperty("opacity", "1", "important");
    button.style.setProperty("flex-shrink", "0", "important");
    button.style.setProperty("position", "relative", "important");
    button.style.setProperty("z-index", "99", "important");
  } else {
    button.style.display = "none";
    button.style.setProperty("display", "none", "important");
  }
}


// ==================================================
// FUNGSI SIMPAN PESANAN MEJA
// ==================================================

async function simpanPesananMeja() {
  if (isProcessingStopLoss) {
    alert("Proses Stop Waktu Loss sedang berjalan. Mohon tunggu.");
    return;
  }

  if (!activeMeja) {
    alert("Pilih meja terlebih dahulu.");
    return;
  }

  const session = mejaSessions[activeMeja];
  if (!session || !session.sessionId) {
    alert("Sesi meja tidak ditemukan. Silakan pilih meja kembali.");
    return;
  }

  const btn = document.getElementById("saveOrderBtn");
  if (!btn) return;

  btn.disabled = true;
  btn.innerHTML = `
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: middle; margin-right: 6px; flex-shrink: 0;">
      <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path>
      <polyline points="17 21 17 13 7 13 7 21"></polyline>
      <polyline points="7 3 7 8 15 8"></polyline>
    </svg>
    <span>MENYIMPAN...</span>`;

  try {
    // Baca kondisi server terlebih dahulu. Simpan hanya selisih qty yang benar-benar baru.
    const detailResponse = await authenticatedFetch(`/api/meja/sesi/${session.sessionId}`);
    const detailResult = await detailResponse.json();
    if (!detailResult.success) {
      throw new Error(detailResult.message || "Gagal membaca pesanan meja dari server");
    }

    const serverQty = new Map(
      (detailResult.items || []).map(item => [
        String(item.nama || "").trim().toLowerCase(),
        Number(item.qty || 0)
      ])
    );

    const pesananBaruUntukCetak = [];

    console.log("[PRINTER PESANAN] CART SEBELUM SIMPAN:", JSON.parse(JSON.stringify(cart)));
    console.log("[PRINTER PESANAN] SESSION ID:", session.sessionId);
    console.log("[PRINTER PESANAN] SERVER ITEMS:", detailResult.items);

    for (const item of cart) {
      if (item.nama === "Meja Billiard" || item.nama === "Billiard Waktu Loss") continue;

      const namaKey = String(item.nama || "").trim().toLowerCase();
      const targetQty = Number(item.qty || 0);
      const oldQty = serverQty.get(namaKey) || 0;
      const deltaQty = targetQty - oldQty;

      if (deltaQty <= 0) continue;

      const responsePesanan = await authenticatedFetch("/api/meja/pesanan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: session.sessionId,
          namaBarang: item.nama,
          qty: deltaQty
        })
      });

      const resultPesanan = await responsePesanan.json();

      if (!resultPesanan.success) {
        throw new Error(resultPesanan.message || `Gagal menyimpan produk: ${item.nama}`);
      }

      pesananBaruUntukCetak.push({
      nama: item.nama,
      qty: deltaQty
    });

      serverQty.set(namaKey, targetQty);
    }

    const response = await authenticatedFetch(`/api/meja/sesi/${session.sessionId}`);
    const result = await response.json();
    if (!result.success) {
      throw new Error(result.message || "Gagal mengambil data sesi dari server");
    }

    console.log("[PRINTER PESANAN] Pesanan baru:", pesananBaruUntukCetak);

    cetakPesananBerdasarkanKategori({
      meja: nomorMeja,
      sessionId: session.sessionId,
      items: pesananBaruUntukCetak
    }).catch(error => {
      console.error("[PRINTER PESANAN] Cetak otomatis gagal:", error);
    });

    await fetchMejaSessions();
    renderPopupMeja();

    activeMeja = null;
    nomorMeja = null;
    cart = [];

    // Jangan memuat draft lama setelah pesanan berhasil disimpan ke meja.
    await clearCartDraftServer();
    await fetchMejaSessions();
    updateMejaHeaderUI();
    renderCart();
    updateSaveOrderButton();
    btn.innerHTML = `
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: middle; margin-right: 6px; flex-shrink: 0;">
        <polyline points="20 6 9 17 4 12"></polyline>
      </svg>
      <span>TERSIMPAN &#10003;</span>`;

    setTimeout(() => {
      btn.innerHTML = `
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: middle; margin-right: 6px; flex-shrink: 0;">
          <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path>
          <polyline points="17 21 17 13 7 13 7 21"></polyline>
          <polyline points="7 3 7 8 15 8"></polyline>
        </svg>
        <span>SIMPAN PESANAN</span>`;
      btn.disabled = false;
      updateSaveOrderButton();
    }, 1500);

  } catch (error) {
    console.error("Gagal simpan pesanan meja:", error);
    alert("Gagal memverifikasi pesanan ke server: " + error.message);
    btn.innerHTML = `
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: middle; margin-right: 6px; flex-shrink: 0;">
        <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path>
        <polyline points="17 21 17 13 7 13 7 21"></polyline>
        <polyline points="7 3 7 8 15 8"></polyline>
      </svg>
      <span>SIMPAN PESANAN</span>`;
    btn.disabled = false;
    updateSaveOrderButton();
  }
}


// ==================================================
// CART & PESANAN API
// ==================================================

async function tambahBarang(item) {
  if (item.nama === "Meja Billiard" || item.nama === "Billiard Waktu Loss") {
    if (
      !activeMeja ||
      !mejaSessions[activeMeja] ||
      mejaSessions[activeMeja].status !== "AKTIF"
    ) {
      alert("Pilih meja terlebih dahulu.");
      return;
    }
  }

  const existing = cart.find(
    x => x.nama === item.nama
  );

  let existingQty = 1;

  if (existing) {
    existing.qty += 1;
    existingQty = existing.qty;
  } else {
    cart.push({
      nama: item.nama,
      qty: 1
    });
    existingQty = 1;
  }

  renderCart();
  updateSaveOrderButton();

  if (!activeMeja || !mejaSessions[activeMeja]) {
    await syncCartDraftItem(item.nama, existingQty);
  }
}


async function tambahQty(index) {
  if (!activeMeja || !mejaSessions[activeMeja]) {
    const item = cart[index];
    if (item) {
      item.qty += 1;
      renderCart();
      await syncCartDraftItem(item.nama, item.qty);
    }
    return;
  }

  // Ambil sesi terbaru dari server sebelum mengubah qty agar
  // sessionId/cart tidak memakai data frontend yang sudah stale.
  await fetchMejaSessions();

  const s = mejaSessions[activeMeja];
  const item = cart[index];

  if (!s || !s.sessionId || !item) {
    alert("Sesi meja tidak ditemukan. Silakan pilih ulang meja.");
    return;
  }

  try {
    if (item.nama === "Meja Billiard") {
      const resDurasi = await authenticatedFetch("/api/meja/tambah-durasi", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: s.sessionId,
          durasiTambahJam: 1
        })
      });

      const resultDurasi = await resDurasi.json();

      if (!resDurasi.ok || resultDurasi.success === false) {
        throw new Error(resultDurasi.message || "Gagal menambah durasi meja");
      }

      await fetchDetailSesi(s.sessionId, true);
      updateSaveOrderButton();
      return;
    }

    if (item.nama === "Billiard Waktu Loss") {
      alert("Durasi Waktu Loss dikalkulasi secara otomatis oleh server saat Stop Waktu.");
      return;
    }

    // Refresh detail terlebih dahulu agar item di cart sama dengan item
    // yang benar-benar tersimpan pada pesanan_meja.
    await fetchDetailSesi(s.sessionId, true);

    const freshItem = cart.find(
      x => String(x.nama || "").trim().toLowerCase() ===
           String(item.nama || "").trim().toLowerCase()
    );

    if (!freshItem) {
      throw new Error("Pesanan belum tersedia pada sesi ini. Data sesi sudah disegarkan, silakan tekan + lagi.");
    }

    const response = await authenticatedFetch("/api/meja/pesanan", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: s.sessionId,
        namaBarang: freshItem.nama,
        qty: Number(freshItem.qty) + 1
      })
    });

    const result = await response.json();

    if (!result.success) {
      throw new Error(result.message || "Gagal update qty");
    }

    await fetchDetailSesi(s.sessionId, true);
    updateSaveOrderButton();

  } catch (error) {
    alert("Gagal update qty: " + error.message);
  }
}


async function kurangQty(index) {
  const item = cart[index];
  if (!item) return;

  if (item.nama === "Meja Billiard") {
    let session = mejaSessions[activeMeja];
    if (!session) {
      await fetchMejaSessions();
      session = mejaSessions[activeMeja];
    }

    if (!session || !session.sessionId) {
      alert("Session meja tidak ditemukan. Silakan pilih ulang meja.");
      return;
    }

    if (item.qty <= 1) {
      alert("Durasi meja minimal 1 jam.");
      return;
    }
    
    targetKurangSessionId = session.sessionId;
    targetKurangProdukNama = null;
    bukaPopupOtorisasiManager();
    return;
  }

  if (item.nama === "Billiard Waktu Loss") {
    alert("Durasi Waktu Loss dikalkulasi secara otomatis oleh server saat Stop Waktu.");
    return;
  }

  let session = null;

  if (activeMeja && mejaSessions[activeMeja]) {
    session = mejaSessions[activeMeja];
  }

  if (!session && activeMeja) {
    await fetchMejaSessions();
    session = mejaSessions[activeMeja];
  }

  if (session && session.sessionId) {
    try {
      const response = await authenticatedFetch("/api/meja/kurang-qty", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: session.sessionId,
          namaBarang: item.nama
        })
      });

      const result = await response.json();
      if (!result.success) {
        throw new Error(result.message || "Gagal mengurangi qty produk meja");
      }

      await fetchDetailSesi(session.sessionId, true);
      updateSaveOrderButton();
    } catch (error) {
      alert("Gagal mengurangi qty: " + error.message);
    }
    return;
  }

  try {
    const response = await authenticatedFetch("/api/cart/kurang-qty", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ namaBarang: item.nama })
    });

    const result = await response.json();
    if (!result.success) {
      throw new Error(result.message || "Gagal mengurangi qty produk");
    }

    item.qty -= 1;
    const barangNama = item.nama;
    let newQty = item.qty;
    if (item.qty <= 0) {
      cart.splice(index, 1);
      newQty = 0;
    }

    renderCart();
    updateSaveOrderButton();
    await syncCartDraftItem(barangNama, newQty);
  } catch (error) {
    alert("Gagal mengurangi qty: " + error.message);
  }
}


// ==================================================
// POPUP OTORISASI MANAGER (GOOGLE AUTHENTICATOR)
// ==================================================

function bukaPopupOtorisasiManager() {
  const input = document.getElementById("inputTotpCode");
  if (input) input.value = "";
  document.getElementById("otorisasiManagerPopup").classList.add("show");
}

function tutupPopupOtorisasiManager() {
  document.getElementById("otorisasiManagerPopup").classList.remove("show");
  targetKurangSessionId = null;
  targetKurangProdukNama = null;
  const btn = document.getElementById("verifikasiTotpBtn");
  if (btn) {
    btn.disabled = false;
    btn.textContent = "VERIFIKASI";
  }
}

function tutupPopupOtorisasiManagerLuar(event) {
  if (event.target.id === "otorisasiManagerPopup") {
    tutupPopupOtorisasiManager();
  }
}

async function prosesOtorisasiManager() {
  const input = document.getElementById("inputTotpCode");
  const code = input ? input.value.trim() : "";

  if (!/^\d{6}$/.test(code)) {
    alert("Kode Google Authenticator harus 6 digit.");
    return;
  }

  const btn = document.getElementById("verifikasiTotpBtn");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "MEMVERIFIKASI...";
  }

  try {
    if (targetKurangSessionId && targetKurangProdukNama) {
      const response = await authenticatedFetch("/api/meja/kurang-qty", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          sessionId: targetKurangSessionId,
          namaBarang: targetKurangProdukNama,
          code: code
        })
      });

      const result = await response.json();

      if (!result.success) {
        throw new Error(result.message || "Gagal mengurangi qty produk meja");
      }

      const sessionIdToFetch = targetKurangSessionId;
      tutupPopupOtorisasiManager();

      await fetchDetailSesi(sessionIdToFetch, true);
      updateSaveOrderButton();
      return;
    }

    if (targetKurangProdukNama && !targetKurangSessionId) {
      const response = await authenticatedFetch("/api/cart/kurang-qty", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          namaBarang: targetKurangProdukNama,
          code: code
        })
      });

      const result = await response.json();

      if (!result.success) {
        throw new Error(result.message || "Otorisasi Manager gagal");
      }

      const itemIndex = cart.findIndex(x => x.nama === targetKurangProdukNama);
      let newQty = 0;
      let barangNama = targetKurangProdukNama;

      if (itemIndex !== -1) {
        cart[itemIndex].qty -= 1;
        newQty = cart[itemIndex].qty;
        if (cart[itemIndex].qty <= 0) {
          cart.splice(itemIndex, 1);
          newQty = 0;
        }
      }

      renderCart();
      updateSaveOrderButton();

      await syncCartDraftItem(barangNama, newQty);

      tutupPopupOtorisasiManager();
      return;
    }

    if (!targetKurangSessionId) {
      alert("Session ID tidak ditemukan.");
      return;
    }

    const response = await authenticatedFetch("/api/meja/kurang-durasi", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: targetKurangSessionId,
        durasiKurangJam: 1,
        code: code
      })
    });

    const result = await response.json();

    if (!result.success) {
      throw new Error(result.message || "Gagal mengurangi durasi meja");
    }

    const sessionIdToFetch = targetKurangSessionId;
    tutupPopupOtorisasiManager();

    await fetchDetailSesi(sessionIdToFetch, true);

  } catch (error) {
    alert(error.message || "Terjadi kesalahan saat verifikasi.");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "VERIFIKASI";
    }
  }
}


// ==================================================
// RENDER CART
// ==================================================

function renderCart() {
  const container = document.getElementById("cartItems");

  // Hentikan timer keranjang LOSS lama sebelum render ulang untuk mencegah memory leak / double timer
  if (typeof mejaTimersCleanup['cart_loss'] === 'function') {
    mejaTimersCleanup['cart_loss']();
    delete mejaTimersCleanup['cart_loss'];
  }

  if (!cart.length) {
    container.innerHTML = `
      <div class="cart-empty">
        Keranjang kosong
      </div>
    `;
    document.getElementById("total").textContent = "Rp0";
    document.getElementById("kembalian").textContent = "Rp0";
    updateSaveOrderButton();
    return;
  }

  let total = 0;
  let cartReady = true;
  const session = activeMeja ? mejaSessions[activeMeja] : null;

  // ====================================================================
// TAMBAHAN: VISIBILITY INPUT NAMA PEMESAN TANPA MEJA
// ====================================================================
const namaPemesanBox = document.getElementById("namaPemesanTanpaMejaBox");
if (namaPemesanBox) {
  namaPemesanBox.style.display = activeMeja ? "none" : "block";
}
// ====================================================================

  // Render Header Informasi Meja jika Aktif
  let lossBannerHtml = "";
  if (activeMeja && mejaSessions[activeMeja] && mejaSessions[activeMeja].status === "AKTIF") {
    const activeSession = mejaSessions[activeMeja];
    const jenisSesiStr = String(activeSession.jenisSesi || activeSession.jenis_sesi || "").toUpperCase();
    if (jenisSesiStr === "LOSS") {
      lossBannerHtml = `
        <div style="background: #ecfdf5; border: 1px solid #a7f3d0; border-radius: 8px; padding: 10px 12px; margin-bottom: 12px; display: flex; justify-content: space-between; align-items: center; box-sizing: border-box;">
          <div>
            <div style="font-size: 0.75rem; font-weight: 800; color: #065f46; letter-spacing: 0.5px;">MEJA ${activeMeja < 10 ? '0' + activeMeja : activeMeja} &mdash; WAKTU LOSS</div>
            <div id="cartLossTimerVal" style="font-size: 1.15rem; font-weight: 800; color: #047857; font-family: monospace, monospace; margin-top: 2px;">00:00:00</div>
          </div>
          <div style="display: flex; gap: 6px; align-items: center;">
            <button 
              onclick="bukaModalPindahMeja(${activeMeja})"
              style="padding: 8px 12px; background: #2563eb; color: #ffffff; border: none; border-radius: 6px; font-size: 0.75rem; font-weight: 800; cursor: pointer; box-shadow: 0 1px 2px rgba(0,0,0,0.1);"
            >
              PINDAH MEJA
            </button>
            <button 
              class="btn-stop-loss-cart"
              onclick="stopWaktuLoss('${activeSession.sessionId}', this)"
              style="padding: 8px 14px; background: #dc2626; color: #ffffff; border: none; border-radius: 6px; font-size: 0.8rem; font-weight: 800; cursor: pointer; box-shadow: 0 1px 2px rgba(0,0,0,0.1);"
            >
              STOP WAKTU
            </button>
          </div>
        </div>
      `;
    } else {
      lossBannerHtml = `
        <div style="background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 8px; padding: 10px 12px; margin-bottom: 12px; display: flex; justify-content: space-between; align-items: center; box-sizing: border-box;">
          <div>
            <div style="font-size: 0.75rem; font-weight: 800; color: #1e40af; letter-spacing: 0.5px;">MEJA ${activeMeja < 10 ? '0' + activeMeja : activeMeja} &mdash; ${escapeHtml(activeSession.namaPemesan || 'AKTIF')}</div>
            <div style="font-size: 0.75rem; color: #3b82f6; font-weight: 600; margin-top: 2px;">Selesai: ${activeSession.waktuSelesai ? window.MejaTimer.formatJam(activeSession.waktuSelesai) : '-'}</div>
          </div>
          <button 
            onclick="bukaModalPindahMeja(${activeMeja})"
            style="padding: 8px 14px; background: #2563eb; color: #ffffff; border: none; border-radius: 6px; font-size: 0.8rem; font-weight: 800; cursor: pointer; box-shadow: 0 1px 2px rgba(0,0,0,0.1);"
          >
            PINDAH MEJA
          </button>
        </div>
      `;
    }
  }

  const itemsHtml = cart.map((item, index) => {
    const master = masterBarang.find(x => x.nama === item.nama);
    let harga = Number(item.hargaJual !== undefined ? item.hargaJual : (item.harga !== undefined ? item.harga : (master?.hargaJual || 0)));
    let subtotal = item.subtotal !== undefined ? Number(item.subtotal) : (harga * item.qty);

    let isWaitingForPrice = false;
    let hargaTampil = "";
    let subtotalTampil = "";

    // MENGGUNAKAN SUBTOTAL DARI SERVER SEBAGAI SUMBER KEBENARAN UTAMA
    if (item.nama === "Billiard Waktu Loss") {
      harga = item.hargaJual !== undefined ? Number(item.hargaJual) : (item.harga !== undefined ? Number(item.harga) : 500);
      if (item.subtotal !== undefined && item.subtotal !== null) {
        subtotal = Number(item.subtotal);
      } else {
        subtotal = harga * item.qty;
      }
    } else if (item.nama === "Meja Billiard" && activeMeja && mejaSessions[activeMeja]) {
      const jenisSesi = String(session.jenisSesi || session.jenis_sesi || "").trim().toUpperCase();

      if (jenisSesi === "LOSS") {
        if (item.subtotal !== undefined && item.subtotal !== null) {
          subtotal = Number(item.subtotal);
          harga = item.hargaJual !== undefined ? Number(item.hargaJual) : (item.harga !== undefined ? Number(item.harga) : 500);
        } else {
          harga = item.hargaJual !== undefined ? Number(item.hargaJual) : 500;
          subtotal = harga * item.qty;
        }
      } else if (jenisSesi === "KARYAWAN") {
        harga = 0;
        subtotal = 0;
      } else {
        // MODE DURASI: untuk sesi meja yang sudah tersimpan di server,
        // harga_jual + subtotal server adalah sumber kebenaran.
        // Jangan hitung ulang dengan harga master/member di frontend.
        if (item.hargaJual !== undefined && item.subtotal !== undefined && item.subtotal !== null) {
          harga = Number(item.hargaJual);
          subtotal = Number(item.subtotal);
        } else {
          // Jangan gunakan harga master atau hitung ulang harga member jika
          // item meja aktif belum membawa harga dari server. Tunggu refresh
          // detail sesi agar harga sesi/database menjadi sumber kebenaran.
          isWaitingForPrice = true;
          cartReady = false;
          harga = 0;
          subtotal = 0;
        }
      }
    }

    if (isWaitingForPrice) {
      hargaTampil = "Memuat...";
      subtotalTampil = "Memuat...";
    } else {
      hargaTampil = rupiah(harga);
      subtotalTampil = rupiah(subtotal);
      total += subtotal;
    }

    return `
      <div class="cart-item">
        <div>
          <div class="cart-item-name">
            ${escapeHtml(item.nama)}
          </div>
          <div class="cart-item-price">
            ${hargaTampil}
          </div>
          <div class="qty-row">
            <button class="qty-btn" onclick="kurangQty(${index})">&minus;</button>
            <strong>${item.qty}</strong>
            <button class="qty-btn" onclick="tambahQty(${index})">+</button>
          </div>
        </div>
        <div class="cart-subtotal">
          ${subtotalTampil}
        </div>
      </div>
    `;
  }).join("");

  container.innerHTML = lossBannerHtml + itemsHtml;

  // Jalankan timer Count-Up pada banner keranjang jika meja LOSS sedang aktif
  if (activeMeja && mejaSessions[activeMeja] && mejaSessions[activeMeja].status === "AKTIF") {
    const activeSession = mejaSessions[activeMeja];
    const jenisSesiStr = String(activeSession.jenisSesi || activeSession.jenis_sesi || "").toUpperCase();
    if (jenisSesiStr === "LOSS") {
      const cartTimerEl = document.getElementById("cartLossTimerVal");
      if (cartTimerEl && window.MejaTimer && activeSession.waktuMulai) {
        const stopCartFn = window.MejaTimer.mulaiCountUpLoss(cartTimerEl, activeSession.waktuMulai);
        if (typeof stopCartFn === 'function') {
          mejaTimersCleanup['cart_loss'] = stopCartFn;
        }
      }
    }
  }

  window._isCartReady = cartReady;
  
  document.getElementById("total").textContent = cartReady ? rupiah(total) : "Memuat...";

  updateKembalian();
  updateSaveOrderButton();
}


// ==================================================
// TOTAL
// ==================================================

function getTotal() {
  let total = 0;

  cart.forEach(item => {
    const master = masterBarang.find(x => x.nama === item.nama);
    let harga = Number(item.hargaJual !== undefined ? item.hargaJual : (item.harga !== undefined ? item.harga : (master?.hargaJual || 0)));
    let subtotal = item.subtotal !== undefined ? Number(item.subtotal) : (harga * item.qty);

    if (item.nama === "Billiard Waktu Loss") {
      if (item.subtotal !== undefined && item.subtotal !== null) {
        subtotal = Number(item.subtotal);
      } else {
        const h = item.hargaJual !== undefined ? Number(item.hargaJual) : (item.harga !== undefined ? Number(item.harga) : 500);
        subtotal = h * item.qty;
      }
    } else if (
      item.nama === "Meja Billiard" &&
      activeMeja &&
      mejaSessions[activeMeja]
    ) {
      const session = mejaSessions[activeMeja];
      const jenisSesi = String(session.jenisSesi || session.jenis_sesi || "").trim().toUpperCase();

      if (jenisSesi === "LOSS") {
        if (item.subtotal !== undefined && item.subtotal !== null) {
          subtotal = Number(item.subtotal);
        } else {
          const h = item.hargaJual !== undefined ? Number(item.hargaJual) : 500;
          subtotal = h * item.qty;
        }
      } else if (jenisSesi === "KARYAWAN") {
        harga = 0;
        subtotal = 0;
      } else {
        // Sesi meja yang sudah tersimpan: gunakan harga/subtotal dari server.
        // Ini mencegah harga member Platinum kembali ke harga master Rp30.000/jam.
        if (item.hargaJual !== undefined && item.subtotal !== undefined && item.subtotal !== null) {
          harga = Number(item.hargaJual);
          subtotal = Number(item.subtotal);
        } else {
          const member = memberByMeja.get(String(activeMeja));
          const durasiJam = Number(session.durasiJam || item.qty || 1);
        const waktuMulai = session.waktuMulai || null;

        if (member && ["PLATINUM", "UMUM", "PELAJAR"].includes(String(member.kategori || member.kategoriId || "").trim().toUpperCase())) {
          const kategori = String(member.kategori || member.kategoriId).trim().toUpperCase();
          const cacheKey = `${activeMeja}_${kategori}_${durasiJam}_${waktuMulai}`;

          if (window._hargaMejaCache && window._hargaMejaCache[cacheKey]) {
            const hasilHarga = window._hargaMejaCache[cacheKey];
            if (hasilHarga && hasilHarga.success) {
              harga = Number(hasilHarga.hargaPerJam || 0);
              subtotal = Number(hasilHarga.total || 0);
            } else {
              subtotal = 0;
            }
          } else {
            subtotal = 0;
          }
        } else if (typeof window.hitungHargaSewa === "function") {
          const kategori = member ? String(member.kategori || member.kategoriId || "").trim().toUpperCase() : "NON_MEMBER";
          const hasilHarga = window.hitungHargaSewa({
            kategori,
            durasiJam,
            waktuMulai
          });

          if (hasilHarga && hasilHarga.success === true) {
            harga = Number(hasilHarga.hargaPerJam || harga);
            subtotal = Number(hasilHarga.total || (harga * durasiJam));
          }
          }
        }
      }
    }

    total += subtotal;
  });

  return total;
}


// ==================================================
// METODE PEMBAYARAN
// ==================================================

function pilihMetode(
  metode
) {

  metodePembayaran =
    metode;


  document
    .getElementById(
      "cashBtn"
    )
    .classList.toggle(
      "active",
      metode ===
        "CASH"
    );


  document
    .getElementById(
      "qrisBtn"
    )
    .classList.toggle(
      "active",
      metode ===
        "QRIS"
    );


  document
    .getElementById(
      "splitBtn"
    )
    .classList.toggle(
      "active",
      metode ===
        "SPLIT"
    );


  const cashArea =
    document.getElementById(
      "cashArea"
    );


  const splitArea =
    document.getElementById(
      "splitArea"
    );


  const bayar =
    document.getElementById(
      "bayar"
    );


  if (
    metode ===
    "CASH"
  ) {

    cashArea.classList.remove(
      "hidden"
    );


    splitArea.classList.add(
      "hidden"
    );


    bayar.disabled =
      false;


    bayar.placeholder =
      "Nominal Cash";

  }

  else if (
    metode ===
    "QRIS"
  ) {

    cashArea.classList.remove(
      "hidden"
    );


    splitArea.classList.add(
      "hidden"
    );


    bayar.value =
      "";


    bayar.disabled =
      true;


    bayar.placeholder =
      "QRIS otomatis";

  }

  else {

    cashArea.classList.add(
      "hidden"
    );


    splitArea.classList.remove(
      "hidden"
    );


    bayar.value =
      "";

  }


  updateKembalian();

}


// ==================================================
// PAYMENT VALUES
// ==================================================

function getPaymentValues() {

  const total =
    getTotal();


  let cash =
    0;


  let qris =
    0;


  let bayar =
    0;


  if (
    metodePembayaran ===
    "CASH"
  ) {

    cash =
      parseFormattedCurrency(
        document
          .getElementById(
            "bayar"
          )
          .value || 0
      );


    bayar =
      cash;

  }

  else if (
    metodePembayaran ===
    "QRIS"
  ) {

    qris =
      total;


    bayar =
      total;

  }

  else {

    cash =
      parseFormattedCurrency(
        document
          .getElementById(
            "cashAmount"
          )
          .value || 0
      );


    qris =
      parseFormattedCurrency(
        document
          .getElementById(
            "qrisAmount"
          )
          .value || 0
      );


    bayar =
      cash +
      qris;

  }


  return {

    total,
    cash,
    qris,
    bayar,
    metodePembayaran

  };

}


// ==================================================
// KEMBALIAN
// ==================================================

function updateKembalian() {

  const payment =
    getPaymentValues();


  const selisih =
    payment.bayar -
    payment.total;


  document
    .getElementById(
      "kembalian"
    )
    .textContent =
      rupiah(
        Math.max(
          0,
          selisih
        )
      );

}


document
  .getElementById(
    "bayar"
  )
  .addEventListener(
    "input",
    function(e) {
      e.target.value = formatCurrencyInput(e.target.value);
      updateKembalian();
    }
  );


document
  .getElementById(
    "cashAmount"
  )
  .addEventListener(
    "input",
    updateKembalian
  );


document
  .getElementById(
    "qrisAmount"
  )
  .addEventListener(
    "input",
    updateKembalian
  );


// ==================================================
// CEK HARGA MEJA
// ==================================================

async function cekHargaMeja() {
  const btn = document.getElementById("cekHargaMejaBtn");
  const session = mejaSessions[activeMeja];
  if (cekHargaSessionId === session.sessionId) return;

  if (btn) {
    btn.disabled = true;
    btn.textContent = "MENGECEK...";
  }


  if (!activeMeja || !mejaSessions[activeMeja]) {
    alert("Pilih meja terlebih dahulu.");
    return;
  }


  if (cekHargaSessionId !== session.sessionId && btn) {
    btn.disabled = false;
    btn.textContent = "CEK";
  }
  const jenisSesi = String(session.jenisSesi || session.jenis_sesi || "").trim().toUpperCase();

  if (jenisSesi === "LOSS") {
    alert("Harga Waktu Loss dihitung otomatis oleh server saat Stop Waktu.");
    return;
  }

  let member = memberByMeja.get(String(activeMeja)) || null;
  let kategori = String(
    member?.kategori ||
    member?.kategoriId ||
    session.kategoriMember ||
    session.kategori_member ||
    ""
  ).trim().toUpperCase();

  if (!["PLATINUM", "UMUM", "PELAJAR"].includes(kategori)) {
    try {
      const memberResponse = await authenticatedFetch("/api/member");
      const memberData = await memberResponse.json();
      const members = Array.isArray(memberData?.data) ? memberData.data : [];
      const targetId = session.memberId || session.member_id || member?.idMember || member?.memberId || null;
      const targetNama = String(session.namaPemesan || "").trim().toLowerCase();

      const foundMember = members.find(m => {
        const mId = m.idMember ?? m.member_id ?? m.id ?? m.kodeMember ?? m.kode_member;
        const mNama = String(m.nama || m.namaMember || m.nama_member || "").trim().toLowerCase();
        return (targetId && String(mId) === String(targetId)) ||
          (!targetId && targetNama && mNama === targetNama);
      });

      if (foundMember) {
        kategori = String(
          foundMember.kategori ||
          foundMember.kategoriId ||
          foundMember.kategori_member ||
          ""
        ).trim().toUpperCase();

        member = foundMember;

        memberByMeja.set(String(activeMeja), {
          idMember: foundMember.idMember ??
            foundMember.member_id ??
            foundMember.id ??
            foundMember.kodeMember ??
            foundMember.kode_member ??
            null,
          kategori
        });
      }
    } catch (e) {
      console.error("Gagal mengambil data member saat cek harga:", e);
    }
  }

  if (!["PLATINUM", "UMUM", "PELAJAR"].includes(kategori)) {
    alert("Member belum dipilih atau kategori member tidak tersedia.");
    return;
  }

  const durasiJam = Number(session.durasiJam || 0);

  if (!Number.isInteger(durasiJam) || durasiJam < 1) {
    alert("Durasi meja belum valid.");
    return;
  }

  const waktuMulai = session.waktuMulai || null;

  if (!waktuMulai) {
    alert("Waktu mulai sesi tidak tersedia.");
    return;
  }

  const d = new Date(waktuMulai);
  const jam = d.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });

  let cekHargaBerhasil = false;

  try {
    const response = await authenticatedFetch("/api/meja/hitung-harga", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: session.sessionId || session.session_id || null,
        kategori,
        durasiJam,
        jam
      })
    });

    const result = await response.json();

    if (!result.success) {
      throw new Error(result.message || "Harga member tidak tersedia.");
    }

    const itemMeja = cart.find(
      item => String(item.nama || "").trim().toLowerCase() === "meja billiard"
    );

    if (!itemMeja) {
      throw new Error("Item Meja Billiard tidak ditemukan di keranjang.");
    }

    itemMeja.qty = durasiJam;
    itemMeja.hargaJual = Number(result.hargaPerJam);
    itemMeja.harga = Number(result.hargaPerJam);
    itemMeja.subtotal = Number(result.total);

    renderCart();
    updateSaveOrderButton();

    cekHargaBerhasil = true;
    cekHargaSessionId = session.sessionId;

    alert(
      `Harga ${kategori} diterapkan: ${rupiah(result.hargaPerJam)}/jam ? ${durasiJam} jam = ${rupiah(result.total)}`
    );
  } catch (error) {
    alert("Gagal cek harga meja: " + error.message);
  } finally {
    if (btn) {
      if (cekHargaBerhasil) {
        btn.textContent = "SUDAH DICEK";
      } else {
        btn.disabled = false;
        btn.textContent = "CEK HARGA MEJA";
      }
    }
  }
}

// BAYAR TRANSAKSI
// ==================================================

let currentFinishedSessionInfo = null;

async function bayarTransaksi() {

  if (isProcessingStopLoss) {
    alert("Proses Stop Waktu Loss sedang berjalan. Mohon tunggu.");
    return;
  }

  // Wajib cegah pembayaran jika sesi LOSS masih AKTIF (Kasir harus STOP WAKTU terlebih dahulu)
  if (activeMeja && mejaSessions[activeMeja]) {
    const activeSession = mejaSessions[activeMeja];
    const jenisSesiStr = String(activeSession.jenisSesi || activeSession.jenis_sesi || "").toUpperCase();
    if (jenisSesiStr === "LOSS" && activeSession.status === "AKTIF") {
      alert("Sesi WAKTU LOSS masih AKTIF. Harap tekan STOP WAKTU terlebih dahulu sebelum melakukan pembayaran.");
      return;
    }
  }

  if (window._isCartReady === false) {
    alert("Harga member sedang dimuat, mohon tunggu sebentar.");
    return;
  }

  if (
    !cart.length
  ) {

    alert(
      "Keranjang masih kosong."
    );

    return;

  }


  if (
    !currentKasir
  ) {

    alert(
      "Kasir belum login."
    );

    return;

  }

  const payment =
    getPaymentValues();


  if (
    metodePembayaran ===
    "CASH"
  ) {

    if (
      payment.cash <
      payment.total
    ) {

      alert(
        "Nominal Cash kurang."
      );

      return;

    }

  }


  if (
    metodePembayaran ===
    "SPLIT"
  ) {

    if (
      payment.bayar !==
      payment.total
    ) {

      alert(
        "Cash + QRIS harus sama persis dengan total transaksi."
      );

      return;

    }

  }

  // VALIDASI SESSION ID UNTUK TRANSAKSI MEJA
  let targetSessionId = null;
  if (nomorMeja) {
    const sessionObj = mejaSessions[nomorMeja];
    // Setelah STOP LOSS, sesi sudah berstatus SELESAI sehingga GET /api/meja/sesi
    // tidak lagi menaruhnya di mejaSessions. Gunakan sessionId yang disimpan saat STOP.
    targetSessionId = sessionObj?.sessionId || stoppedSessionIdsByMeja[nomorMeja] || null;
    if (!targetSessionId) {
      alert("Session meja tidak valid atau tidak tersedia.");
      return;
    }
  }


  const button =
    document.getElementById(
      "payBtn"
    );


  button.disabled =
    true;


  button.innerHTML = `<span>MEMPROSES...</span>`;


  try {

    const yakin = confirm("Apakah Anda yakin melakukan pembayaran ini?");
    if (!yakin) {
      return;
    }

    const requestPayload = {

      shiftId:
        currentKasir.shiftId,

      nomorMeja:
        nomorMeja || null,

      metodePembayaran:

        metodePembayaran ===
        "SPLIT"
          ? "CASH+QRIS"
          : metodePembayaran,

      bayar:
        payment.bayar,

      cashAmount:
        payment.cash,

      qrisAmount:
        payment.qris,

      items:
        cart

    };

    if (targetSessionId) {
      requestPayload.sessionId = targetSessionId;
    }

    const response =
      await authenticatedFetch(
        "/api/transaksi",
        {

          method:
            "POST",

          headers: {
            "Content-Type":
              "application/json"
          },

          body:
            JSON.stringify(requestPayload)

        }
      );


    const result =
      await response.json();


    if (
      !result.success
    ) {

      throw new Error(
        result.message ||
        "Transaksi gagal"
      );

    }


    const finishedMeja = nomorMeja;
    const finishedSession = finishedMeja ? mejaSessions[finishedMeja] : null;
    const pemesanName = finishedSession ? finishedSession.namaPemesan : "-";

    currentFinishedSessionInfo = {
      nomorTransaksi: result.nomorTransaksi,
      meja: finishedMeja || "-",
      pemesan: pemesanName,
      total: payment.total,
      bayar: payment.bayar,
      kembalian: Math.max(0, payment.bayar - payment.total)
    };

    // ==================================================
// CETAK STRUK BLUETOOTH
// ==================================================
try {
  const semuaItem = Array.isArray(cart) ? [...cart] : [];

  const itemMeja = semuaItem.find(
    item => String(item.nama || "").trim() === "Meja Billiard"
  );

  const produk = semuaItem
  .filter(
    item => String(item.nama || "").trim() !== "Meja Billiard"
  )
  .map(item => {
    const master = masterBarang.find(
      x => x.nama === item.nama
    );

    const harga = Number(
      item.hargaJual !== undefined
        ? item.hargaJual
        : (
            item.harga !== undefined
              ? item.harga
              : (master?.hargaJual || 0)
          )
    );

    const qty = Number(item.qty || 0);

    return {
      nama: item.nama || "-",
      qty,
      harga: rupiah(harga)
    };
  });

  const now = new Date();

  const tanggalStruk =
    String(now.getDate()).padStart(2, "0") +
    "/" +
    String(now.getMonth() + 1).padStart(2, "0") +
    "/" +
    now.getFullYear() +
    " " +
    String(now.getHours()).padStart(2, "0") +
    ":" +
    String(now.getMinutes()).padStart(2, "0");

  const durasiJam = Number(
    finishedSession?.durasiJam ??
    finishedSession?.durasi_jam ??
    itemMeja?.qty ??
    0
  );

  const hargaJam = durasiJam > 0
    ? Math.round(Number(
        itemMeja?.hargaJual ??
        itemMeja?.harga ??
        0
      ) / durasiJam)
    : Number(
        itemMeja?.hargaJual ??
        itemMeja?.harga ??
        0
      );

  const teksStruk = buatStrukTransaksi({
    nomorTransaksi: result.nomorTransaksi,
    tanggal: tanggalStruk,
    kasir: currentKasir?.nama || "ADMIN",
    meja: finishedMeja
      ? "Meja " + finishedMeja
      : null,
    durasi: durasiJam + " Jam",
    hargaJam: rupiah(hargaJam),
    subtotalMeja: rupiah(
      itemMeja?.subtotal !== undefined
        ? Number(itemMeja.subtotal)
        : hargaJam * durasiJam
    ),
    produk,
    total: rupiah(payment.total),
    metodeBayar: payment.metodePembayaran || "-",
    bayar: rupiah(payment.bayar),
    kembali: rupiah(
      Math.max(0, payment.bayar - payment.total)
    )
  });

  const hasilCetak = await cetakStrukBluetooth(teksStruk);

  if (!hasilCetak?.success) {
    console.error(
      "Transaksi berhasil, tetapi struk gagal dicetak:",
      hasilCetak?.message || "Unknown printer error"
    );
  }
} catch (printError) {
  console.error(
    "Transaksi berhasil, tetapi terjadi error saat mencetak struk:",
    printError
  );
}

// ====================================================================
// TAMBAHAN: CETAK PESANAN BAR/DAPUR KHUSUS TRANSAKSI TANPA MEJA
// ====================================================================
if (!nomorMeja && !targetSessionId && !result.sessionId) {
  const namaPemesanInput = document.getElementById("namaPemesanTanpaMeja");
  const namaPemesan = namaPemesanInput ? namaPemesanInput.value.trim() : "";

  if (namaPemesan) {
    const itemsUntukCetak = cart.map(item => ({
      nama: item.nama,
      qty: item.qty
    }));

    if (itemsUntukCetak.length > 0) {
      try {
        await window.cetakPesananBerdasarkanKategori({
          meja: "TANPA MEJA",
          sessionId: "-",
          pemesan: namaPemesan,
          items: itemsUntukCetak
        });
      } catch (err) {
        console.error(
          "[TRANSAKSI TANPA MEJA] Gagal cetak pesanan BAR/DAPUR:",
          err
        );
      }
    }
  }
}
// ====================================================================


    // Panggil /api/meja/tutup HANYA jika sesi meja masih bernilai AKTIF (Mode DURASI)
    if (finishedSession && finishedSession.sessionId) {
      const finishedStatus = String(finishedSession.status || "").toUpperCase();
      if (finishedStatus === "AKTIF") {
        try {
          await authenticatedFetch("/api/meja/tutup", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sessionId: finishedSession.sessionId })
          });
        } catch (err) {
          console.error("Gagal menutup sesi meja di server:", err);
        }
      }
    }

    await fetchMejaSessions();
    const wasTableTrx = Boolean(finishedMeja);
    if (finishedMeja && stoppedSessionIdsByMeja[finishedMeja] === targetSessionId) {
      delete stoppedSessionIdsByMeja[finishedMeja];
    }
    if (
      pendingPaymentTableNo !== null &&
      Number(pendingPaymentTableNo) === Number(finishedMeja)
    ) {
      pendingPaymentTableNo = null;
    }
    activeMeja = null;
    nomorMeja = null;
    cart = [];

    const namaPemesanInput = document.getElementById("namaPemesanTanpaMeja");
    if (namaPemesanInput) {
      namaPemesanInput.value = "";
    }

    // Setelah transaksi berhasil, semua draft keranjang non-meja harus dibersihkan.
    // Jangan memuat kembali cart draft lama karena dapat membuat produk lama muncul lagi.
    await clearCartDraftServer();

    updateMejaHeaderUI();
    renderCart();
    updateSaveOrderButton();
    document.getElementById("resNoTrx").textContent = result.nomorTransaksi;
    document.getElementById("resMeja").textContent = finishedMeja ? ("MEJA " + finishedMeja) : "TANPA MEJA";
    document.getElementById("resPemesan").textContent = pemesanName;
    document.getElementById("resTotal").textContent = rupiah(payment.total);
    document.getElementById("resBayar").textContent = rupiah(payment.bayar);
    document.getElementById("resKembalian").textContent = rupiah(Math.max(0, payment.bayar - payment.total));

    document.getElementById("hasilTransaksiModal").classList.add("show");

  }


  catch (error) {

    alert(
      "Transaksi gagal:\n" +
      error.message
    );

  }


  finally {

    button.disabled =
      false;


    button.innerHTML = `
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: middle; margin-right: 6px; flex-shrink: 0;">
        <rect x="2" y="5" width="20" height="14" rx="2"></rect>
        <line x1="2" y1="10" x2="22" y2="10"></line>
      </svg>
      <span>BAYAR</span>`;

  }

}


// ==================================================
// TUTUP HASIL TRANSAKSI (MODAL OK)
// ==================================================

function tutupHasilTransaksi() {
  document.getElementById("hasilTransaksiModal").classList.remove("show");

  document.getElementById("bayar").value = "";
  document.getElementById("cashAmount").value = "";
  document.getElementById("qrisAmount").value = "";

  pilihMetode("CASH");
}


// ==================================================
// TUTUP KASIR
// ==================================================

function bukaTutupKasir() {

  document
    .getElementById(
      "closeModal"
    )
    .classList.remove(
      "hidden"
    );


  document
    .getElementById(
      "actualCash"
    )
    .value =
      "";


  document
    .getElementById(
      "closeReport"
    )
    .classList.add(
      "hidden"
    );


  document
    .getElementById(
      "lockedArea"
    )
    .classList.remove(
      "hidden"
    );

}


// ==================================================
// HITUNG TUTUP KASIR
// ==================================================

async function hitungTutupKasir() {

  const actual =
    Number(
      document
        .getElementById(
          "actualCash"
        )
        .value || 0
    );


  if (
    !currentKasir ||
    !currentKasir.shiftId
  ) {

    alert(
      "Shift kasir tidak ditemukan."
    );

    return;

  }


  const button =
    document.getElementById(
      "calculateCloseBtn"
    );


  button.disabled =
    true;


  button.textContent =
    "MEMPROSES...";


  try {

    const response =
      await authenticatedFetch(
        "/api/kasir/tutup",
        {

          method:
            "POST",

          headers: {
            "Content-Type":
              "application/json"
          },

          body:
            JSON.stringify({

              shiftId:
                currentKasir.shiftId,

              nominalAktual:
                actual

            })

        }
      );


    const result =
      await response.json();


    if (
      !result.success
    ) {

      throw new Error(
        result.message
      );

    }


    document
      .getElementById(
        "lockedArea"
      )
      .classList.add(
        "hidden"
      );


    const differenceClass =
      result.selisih < 0
        ? "difference-negative"
        : "difference-positive";


    document
      .getElementById(
        "closeReport"
      )
      .innerHTML = `

        <div class="report-row">

          <span>
            Cash
          </span>

          <strong>
            ${rupiah(
              result.penjualanCash
            )}
          </strong>

        </div>


        <div class="report-row">

          <span>
            QRIS
          </span>

          <strong>
            ${rupiah(
              result.penjualanQris
            )}
          </strong>

        </div>


        <div class="report-row report-total">

          <span>
            Total Penjualan
          </span>

          <strong>
            ${rupiah(
              result.totalPenjualan
            )}
          </strong>

        </div>


        <div class="report-row">

          <span>
            Uang Seharusnya
          </span>

          <strong>
            ${rupiah(
              result.uangSeharusnya
            )}
          </strong>

        </div>


        <div class="report-row">

          <span>
            Uang Aktual
          </span>

          <strong>
            ${rupiah(
              result.nominalAktual
            )}
          </strong>

        </div>


        <div class="report-row report-total">

          <span>
            SELISIH
          </span>

          <strong
            class="${differenceClass}"
          >
            ${rupiah(
              result.selisih
            )}
          </strong>

        </div>


        <div class="report-row">

          <span>
            Jumlah Transaksi
          </span>

          <strong>
            ${result.jumlahTransaksi}
          </strong>

        </div>


        <button
          class="close-finish-btn"
          onclick="selesaiTutupKasir()"
        >
          SELESAI
        </button>

      `;


    document
      .getElementById(
        "closeReport"
      )
      .classList.remove(
        "hidden"
      );

  }


  catch (error) {

    alert(
      "Gagal tutup kasir:\n" +
      error.message
    );

  }


  finally {

    button.disabled =
      false;


    button.textContent =
      "LIHAT HASIL";

  }

}


// ==================================================
// SELESAI TUTUP
// ==================================================

function selesaiTutupKasir() {

  location.reload();

}


// ==================================================
// ESCAPE HTML
// ==================================================

function escapeHtml(text) {

  return String(text)

    .replace(
      /&/g,
      "&amp;"
    )

    .replace(
      /</g,
      "&lt;"
    )

    .replace(
      />/g,
      "&gt;"
    )

    .replace(
      /"/g,
      "&quot;"
    )

    .replace(
      /'/g,
      "&#039;"
    );

}


// ==================================================
// RIWAYAT TRANSAKSI
// ==================================================

function bukaRiwayat() {
  document.getElementById("riwayatModal").classList.remove("hidden");
  document.getElementById("riwayatSearch").value = "";
  document.getElementById("riwayatFilter").value = "";
  fetchRiwayat();
}

function tutupRiwayat() {
  document.getElementById("riwayatModal").classList.add("hidden");
}

function debounceFetchRiwayat() {
  clearTimeout(riwayatSearchTimer);
  riwayatSearchTimer = setTimeout(() => {
    fetchRiwayat();
  }, 500);
}

async function fetchRiwayat() {
  const container = document.getElementById("riwayatList");
  container.innerHTML = `<div style="text-align: center; padding: 14px; color: #6b7280;">Memuat data...</div>`;

  const searchVal = document.getElementById("riwayatSearch").value.trim();
  const filterVal = document.getElementById("riwayatFilter").value;

  try {
    const params = new URLSearchParams();
    if (searchVal) params.append("q", searchVal);
    if (filterVal) params.append("metode", filterVal);
    params.append("limit", "200");

    const url = "/api/riwayat-transaksi?" + params.toString();
    const response = await authenticatedFetch(url);
    const result = await response.json();

    if (!result.success) {
      throw new Error(result.message || "Gagal memuat riwayat");
    }

    riwayatData = result.data;
    renderRiwayat();
  } catch (error) {
    container.innerHTML = `<div style="text-align: center; padding: 14px; color: #ef4444;">${error.message}</div>`;
  }
}

function renderRiwayat() {
  const container = document.getElementById("riwayatList");

  if (!riwayatData || riwayatData.length === 0) {
    container.innerHTML = `<div style="text-align: center; padding: 14px; color: #6b7280; font-weight: 500;">Tidak ada transaksi ditemukan.</div>`;
    return;
  }

  container.innerHTML = riwayatData.map((trx, index) => {
    
    const syncColor = trx.statusSync === "SYNCED" ? "#10b981" : (trx.statusSync === "BATAL" ? "#ef4444" : "#f59e0b");
    
    let itemsHtml = "";
    if (trx.items && trx.items.length) {
      itemsHtml = trx.items.map(item => `
        <div style="display: flex; justify-content: space-between; font-size: 0.95rem; margin-bottom: 4px; color: #374151;">
          <span>${escapeHtml(item.nama)} &times; ${item.qty}</span>
          <span>${rupiah(item.subtotal)}</span>
        </div>
      `).join("");
    } else {
      itemsHtml = `<div style="font-size: 0.9rem; color: #9ca3af;">Tidak ada rincian item.</div>`;
    }

    let tglFormated = trx.tanggal;
    if (tglFormated && tglFormated.includes("-")) {
      const parts = tglFormated.split("-");
      if (parts.length === 3) tglFormated = `${parts[2]}-${parts[1]}-${parts[0]}`;
    }
    
    let mejaInfoHtml = "";
    if (trx.nomorMeja) {
      mejaInfoHtml = ` &bull; <strong style="color: #3b82f6;">MEJA ${escapeHtml(trx.nomorMeja)}</strong>`;
    }

    const isBatal = trx.statusSync === "BATAL";

    return `
      <div 
        style="border: 1px solid #e5e7eb; border-radius: 8px; padding: 15px; cursor: pointer; background-color: #f9fafb; transition: all 0.2s;"
        onclick="toggleDetailRiwayat(${index})"
      >
        <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 4px;">
          <div>
            <div style="font-weight: bold; color: #111827; font-size: 1.05rem;">${trx.nomorTransaksi}</div>
            <div style="font-size: 0.85rem; color: #6b7280; margin-top: 2px;">
              ${tglFormated} ${trx.jam} &bull; Kasir: <strong>${escapeHtml(trx.kasir)}</strong>${mejaInfoHtml}
            </div>
          </div>
          <div style="text-align: right;">
            <div style="font-weight: bold; color: #111827; font-size: 1.05rem;">${rupiah(trx.total)}</div>
            <div style="font-size: 0.85rem; font-weight: bold; color: ${syncColor}; margin-top: 2px;">
              ${trx.metodePembayaran} &bull; ${trx.statusSync}
            </div>
          </div>
        </div>

        <div id="riwayat-detail-${index}" class="hidden" style="margin-top: 15px; border-top: 1px dashed #d1d5db; padding-top: 15px; cursor: default;">
          
          ${itemsHtml}

          <hr style="border: 0; border-top: 1px dashed #d1d5db; margin: 12px 0;">
          
          <div style="display: flex; justify-content: space-between; font-weight: bold; font-size: 0.95rem; color: #111827; margin-bottom: 4px;">
            <span>TOTAL</span>
            <span>${rupiah(trx.total)}</span>
          </div>
          <div style="display: flex; justify-content: space-between; font-size: 0.95rem; color: #4b5563; margin-bottom: 4px;">
            <span>Cash</span>
            <span>${rupiah(trx.cashAmount)}</span>
          </div>
          <div style="display: flex; justify-content: space-between; font-size: 0.95rem; color: #4b5563; margin-bottom: 4px;">
            <span>QRIS</span>
            <span>${rupiah(trx.qrisAmount)}</span>
          </div>
          <div style="display: flex; justify-content: space-between; font-size: 0.95rem; color: #4b5563; margin-bottom: 4px;">
            <span>Dibayar</span>
            <span>${rupiah(trx.bayar)}</span>
          </div>
          <div style="display: flex; justify-content: space-between; font-weight: bold; font-size: 1rem; color: #111827; margin-top: 4px; margin-bottom: 15px;">
            <span>Kembalian</span>
            <span>${rupiah(trx.kembalian)}</span>
          </div>

          <div style="border-top: 1px solid #e5e7eb; padding-top: 12px; text-align: right;">
            ${!isBatal ? `
              <button 
                class="popup-table-btn" 
                style="padding: 8px 16px; background: #ef4444; color: #ffffff; font-weight: bold; border: none; border-radius: 6px; cursor: pointer; display: inline-block; width: auto; min-height: auto;"
                onclick="event.stopPropagation(); bukaBatalTransaksi(${index})"
              >
                BATALKAN
              </button>
            ` : `
              <span style="font-size: 0.85rem; font-weight: bold; color: #ef4444;">TRANSAKSI TELAH DIBATALKAN</span>
            `}
          </div>
          
        </div>
      </div>
    `;
  }).join("");
}

function toggleDetailRiwayat(index) {
  const el = document.getElementById("riwayat-detail-" + index);
  if (el) {
    el.classList.toggle("hidden");
  }
}

function bukaBatalTransaksi(index) {
  selectedTrxIndex = index;
  const trx = riwayatData[index];
  if (!trx) return;

  const infoEl = document.getElementById("infoTrxPembatalan");
  if (infoEl) {
    let tglFormated = trx.tanggal;
    if (tglFormated && tglFormated.includes("-")) {
      const parts = tglFormated.split("-");
      if (parts.length === 3) tglFormated = `${parts[2]}-${parts[1]}-${parts[0]}`;
    }
    infoEl.innerHTML = `
      <div><strong>No. Transaksi:</strong> ${escapeHtml(trx.nomorTransaksi)}</div>
      <div><strong>Waktu:</strong> ${tglFormated} ${escapeHtml(trx.jam)}</div>
      <div><strong>Total:</strong> ${rupiah(trx.total)}</div>
      <div><strong>Kasir:</strong> ${escapeHtml(trx.kasir)}</div>
    `;
  }

  document.getElementById("batalTransaksiPopup").classList.add("show");
}

function tutupPopupBatalTransaksi() {
  document.getElementById("batalTransaksiPopup").classList.remove("show");
  selectedTrxIndex = null;
}

function tutupPopupBatalTransaksiLuar(event) {
  if (event.target.id === "batalTransaksiPopup") {
    tutupPopupBatalTransaksi();
  }
}

function lanjutkanBatalTransaksi() {
  document.getElementById("batalTransaksiPopup").classList.remove("show");
  
  const input = document.getElementById("inputBatalTotpCode");
  if (input) input.value = "";
  
  document.getElementById("otorisasiBatalTransaksiPopup").classList.add("show");
}

function tutupPopupOtorisasiBatal() {
  document.getElementById("otorisasiBatalTransaksiPopup").classList.remove("show");
  const btn = document.getElementById("verifikasiBatalTotpBtn");
  if (btn) {
    btn.disabled = false;
    btn.textContent = "VERIFIKASI";
  }
}

function tutupPopupOtorisasiBatalLuar(event) {
  if (event.target.id === "otorisasiBatalTransaksiPopup") {
    tutupPopupOtorisasiBatal();
  }
}

async function prosesBatalTransaksi() {
  if (selectedTrxIndex === null || selectedTrxIndex === undefined) {
    alert("Transaksi belum dipilih.");
    tutupPopupOtorisasiBatal();
    return;
  }

  const trx = riwayatData[selectedTrxIndex];
  if (!trx) {
    alert("Data transaksi tidak ditemukan.");
    tutupPopupOtorisasiBatal();
    return;
  }

  const input = document.getElementById("inputBatalTotpCode");
  const code = input ? input.value.trim() : "";

  if (!/^\d{6}$/.test(code)) {
    alert("Kode Manager harus 6 digit.");
    return;
  }

  const btn = document.getElementById("verifikasiBatalTotpBtn");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "MEMVERIFIKASI...";
  }

  try {
    const response = await authenticatedFetch("/api/transaksi/batalkan", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        nomorTransaksi: trx.nomorTransaksi,
        code: code
      })
    });

    const result = await response.json();

    if (!result.success) {
      throw new Error(result.message || "Gagal membatalkan transaksi");
    }

    tutupPopupOtorisasiBatal();
    selectedTrxIndex = null;

    alert(result.message || "Transaksi berhasil dibatalkan");

    await fetchRiwayat();

  } catch (error) {
    alert(error.message || "Terjadi kesalahan saat membatalkan transaksi.");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "VERIFIKASI";
    }
  }
}








  if (typeof bukaWaitingList === "function") {
    const origBukaWaitingList = bukaWaitingList;
    window.bukaWaitingList = async function(...args) {
      const res = await origBukaWaitingList.apply(this, args);
      if (sessionStorage.getItem("pbms_session_id")) {
        updateWaitingListBadge();
      }
      return res;
    };
  }

  if (typeof simpanFormBooking === "function") {
    const origSimpanFormBooking = simpanFormBooking;
    window.simpanFormBooking = async function(...args) {
      const res = await origSimpanFormBooking.apply(this, args);
      if (sessionStorage.getItem("pbms_session_id")) {
        updateWaitingListBadge();
      }
      return res;
    };
  }

  if (typeof updateStatusWaitingList === "function") {
    const origUpdateStatusWaitingList = updateStatusWaitingList;
    window.updateStatusWaitingList = async function(...args) {
      const res = await origUpdateStatusWaitingList.apply(this, args);
      if (sessionStorage.getItem("pbms_session_id")) {
        updateWaitingListBadge();
      }
      return res;
    };
  }

  if (sessionStorage.getItem("pbms_session_id")) {
    updateWaitingListBadge();
  }









document.addEventListener("visibilitychange", async () => {
  if (document.visibilityState === "visible") {
    const rawSessionId = sessionStorage.getItem("pbms_session_id");
    if (rawSessionId && currentKasir) {
      try {
        const valid = await cekSessionLogin();
        if (valid) {
          const newExp = sessionStorage.getItem("pbms_expires_at");
          if (newExp) {
            startSessionTimer(newExp);
          }
        }
      } catch (err) {
        console.error("Error checking session on visibilitychange:", err);
      }
    }
  }
});

