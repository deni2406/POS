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

  if (member) {
    pendingMemberForMeja = member;
    if (activeMeja) {
      memberByMeja.set(String(activeMeja), member);
    }
  } else {
    pendingMemberForMeja = null;
    if (activeMeja) {
      memberByMeja.delete(String(activeMeja));
    }
  }

  renderCart();
  sinkronTampilanPilihanBonus();
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

  const heartbeat = async () => {
    const rawSessionId = sessionStorage.getItem("pbms_session_id");
    if (!rawSessionId) {
      stopSessionTimer();
      return;
    }
    await cekSessionLogin();
  };

  // Heartbeat interval is a lease refresh, not the session's only safeguard.
  // Visibility/focus handlers below refresh immediately after throttling or resume.
  sessionCheckInterval = setInterval(heartbeat, 30000);
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

async function jalankanTestLampu() {
  // UI loading state — cegah double-click
  const confirmBuka = confirm("Pemeriksaan lampu meja akan dijalankan sekarang.\n\nSemua lampu meja non-aktif akan diuji.\nLanjutkan?");
  if (!confirmBuka) return;

  // Simpan referensi tombol untuk disabling
  const semuaItem = document.querySelectorAll(".hamburger-item");
  let tombolTestLampu = null;
  semuaItem.forEach(el => {
    if (el.textContent.trim() === "TEST LAMPU") tombolTestLampu = el;
  });
  if (tombolTestLampu) {
    tombolTestLampu.disabled = true;
    tombolTestLampu.style.opacity = "0.6";
  }

  try {
    const res = await authenticatedFetch("/api/lamp/test-check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}"
    });
    let data;
    try {
      data = await res.json();
    } catch {
      data = {};
    }

    if (res.ok && data.success === true) {
      let pesan;
      if (data.status === "TIDAK_ADA_MEJA_TEST") {
        pesan = "Semua meja sedang aktif. Tidak ada meja yang dapat dites lampu.";
      } else if (data.status === "NORMAL") {
        const summary = data.summary || {};
        pesan = "Pemeriksaan lampu selesai normal.\n\n" +
          "Lampu ON: " + (summary.onSuccess || 0) + " berhasil, " + (summary.onFailure || 0) + " gagal\n" +
          "Lampu OFF: " + (summary.offSuccess || 0) + " berhasil, " + (summary.offFailure || 0) + " gagal";
      } else {
        pesan = "Pemeriksaan lampu selesai. Status: " + (data.status || "NORMAL");
      }
      alert(pesan);
    } else {
      let pesanError;
      if (data.code === "LAMP_TEST_RUNNING") {
        pesanError = data.message || "Lampu sedang dalam pemeriksaan, silakan tunggu hingga selesai.";
      } else if (data.message) {
        pesanError = data.message;
      } else {
        pesanError = "Gagal menjalankan pemeriksaan lampu. HTTP status: " + res.status;
      }
      alert("Pemeriksaan lampu gagal:\n" + pesanError);
    }
  } catch (e) {
    console.error("Error test lampu:", e);
    alert("Gagal menghubungi server untuk pemeriksaan lampu.\n" + e.message);
  } finally {
    if (tombolTestLampu) {
      tombolTestLampu.disabled = false;
      tombolTestLampu.style.opacity = "";
    }
  }
}

async function logoutKasir() {
  const rawSessionId = sessionStorage.getItem("pbms_session_id");
  const sessionId = rawSessionId ? rawSessionId.trim() : "";
  const deviceId = getOrCreateDeviceId().trim();
  const kasirId = Number(sessionStorage.getItem("pbms_kasir_id") || (currentKasir && currentKasir.id));

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
          deviceId,
          kasirId
        })
      });
    } catch (e) {
      console.error("Logout request error:", e);
    }
  }

  stopSessionTimer();
  openingBalancePending = false;
  pendingCloseLocked = false;
  previewTutupKasir = null;
  dataLaporanTutupKasirUntukCetak = null;
  prosesTutupKasirAktif = false;
  if (timerTutupKasir) {
    clearInterval(timerTutupKasir);
    timerTutupKasir = null;
  }
  document.getElementById("closeModal").classList.add("hidden");
  const closeReport = document.getElementById("closeReport");
  closeReport.innerHTML = "";
  closeReport.classList.add("hidden");
  document.getElementById("lockedArea").classList.remove("hidden");
  ["actualCash"].forEach(id => {
    const input = document.getElementById(id);
    input.value = "";
    input.disabled = false;
    input.readOnly = false;
  });
  const calculateCloseButton = document.getElementById("calculateCloseBtn");
  calculateCloseButton.classList.remove("hidden");
  calculateCloseButton.disabled = false;
  calculateCloseButton.textContent = "LIHAT HASIL";

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

async function cekSemuaPrinterSaatStartup() {
  const status = {
    kasir: false,
    bar: false,
    dapur: false
  };

  // =========================
  // KASIR
  // =========================
  try {
    if (typeof window.cekStatusPrinterBluetooth === "function") {
      const result = await window.cekStatusPrinterBluetooth();
      status.kasir = !!result?.connected;
    }
  } catch (error) {
    console.warn("[PRINTER STARTUP] Check KASIR gagal:", error);
  }

  // =========================
  // BAR & DAPUR
  // =========================
  try {
    const config =
      typeof window.ambilConfigPrinterPesanan === "function"
        ? window.ambilConfigPrinterPesanan()
        : null;

    if (
      config &&
      typeof window.hubungkanPrinterPesanan === "function"
    ) {
      for (const jenis of ["bar", "dapur"]) {
        const printerConfig = config[jenis];

        if (!printerConfig?.address) {
          status[jenis] = false;
          continue;
        }

        try {
          const result = await window.hubungkanPrinterPesanan(
            jenis,
            printerConfig.address,
            printerConfig.name || ""
          );

          status[jenis] = !!result?.success;
        } catch (error) {
          console.warn(
            `[PRINTER STARTUP] Check ${jenis.toUpperCase()} gagal:`,
            error
          );

          status[jenis] = false;
        }
      }
    }
  } catch (error) {
    console.warn(
      "[PRINTER STARTUP] Gagal membaca konfigurasi printer pesanan:",
      error
    );
  }

  console.log(
    "[PRINTER STARTUP] Status semua printer:",
    status
  );

  const printerOffline = [];

  if (!status.kasir) {
    printerOffline.push("KASIR");
  }

  if (!status.bar) {
    printerOffline.push("BAR");
  }

  if (!status.dapur) {
    printerOffline.push("DAPUR");
  }

  console.log("[PRINTER STATUS]", status, "offline:", printerOffline);

  if (printerOffline.length > 0) {
    alert(
      "⚠️ PRINTER TIDAK TERHUBUNG\n\n" +
      "Printer yang offline:\n" +
      printerOffline.map((nama) => `• ${nama}`).join("\n")
    );
  }

  return status;
}


let openingBalancePending = false;
let pendingCloseLocked = false;

// ── Countdown 60 detik pada tombol konfirmasi saldo awal ────────
(function initOpeningCountdown() {
  let _countdownTimer = null;
  let _countdownRunning = false;

  function startOpeningCountdown() {
    const btn = document.getElementById("btnKonfirmasiMulai");
    if (!btn) return;
    if (_countdownTimer) clearInterval(_countdownTimer);
    let remaining = 60;
    btn.disabled = true;
    btn.style.opacity = "0.5";
    btn.style.cursor = "not-allowed";
    btn.textContent = "KONFIRMASI (" + remaining + "s)";
    _countdownRunning = true;
    _countdownTimer = setInterval(function () {
      remaining--;
      if (remaining <= 0) {
        clearInterval(_countdownTimer);
        _countdownTimer = null;
        _countdownRunning = false;
        btn.disabled = false;
        btn.style.opacity = "1";
        btn.style.cursor = "pointer";
        btn.textContent = "KONFIRMASI";
      } else {
        btn.textContent = "KONFIRMASI (" + remaining + "s)";
      }
    }, 1000);
  }

  function stopOpeningCountdown(reset) {
    if (_countdownTimer) {
      clearInterval(_countdownTimer);
      _countdownTimer = null;
      _countdownRunning = false;
    }
    if (reset) {
      const btn = document.getElementById("btnKonfirmasiMulai");
      if (btn) {
        btn.disabled = true;
        btn.style.opacity = "0.5";
        btn.style.cursor = "not-allowed";
        btn.textContent = "KONFIRMASI (60s)";
      }
    }
  }

  window.startOpeningCountdown = startOpeningCountdown;
  window.stopOpeningCountdown = stopOpeningCountdown;
})();

function showOpeningBalanceModal() {
  openingBalancePending = true;
  const app = document.getElementById("app");
  if (app) app.classList.add("hidden");
  // Modal openingBalanceModal dihapus dari index.html — lompatkan ke submitOpeningBalance()
  // setelah jeda singkat agar UI sempat merender sebelum fetch dimulai.
  setTimeout(() => {
    submitOpeningBalance();
  }, 0);
}

function showNoCurrentOpenShiftMessage() {
  openingBalancePending = false;
  const modal = document.getElementById("openingBalanceModal");
  if (modal) modal.classList.remove("show");
  document.getElementById("app").classList.add("hidden");
  document.getElementById("loginScreen").classList.remove("hidden");
  const errorBox = document.getElementById("loginError");
  if (errorBox) {
    errorBox.textContent = "Saat ini tidak ada shift OPEN untuk kasir ini. Silakan gunakan alur login/pembukaan shift yang biasa untuk mendapatkan shift yang memenuhi syarat.";
    errorBox.classList.remove("hidden");
  }
}

function kunciInputTutupKasir() {
  ["actualCash"].forEach(id => {
    const input = document.getElementById(id);
    input.readOnly = true;
    input.disabled = true;
  });
  const calculateButton = document.getElementById("calculateCloseBtn");
  calculateButton.disabled = true;
  calculateButton.classList.add("hidden");
  const app = document.getElementById("app");
  const modal = document.getElementById("closeModal");
  const inertSiblings = node => {
    Array.from(node.children).forEach(child => {
      if (child === modal) return;
      if (child.contains(modal)) inertSiblings(child);
      else child.inert = true;
    });
  };
  if (app && modal && app.contains(modal)) inertSiblings(app);
}

(function() {
  const el = document.getElementById("actualCash");
  if (!el) return;
  function fmt(digits) {
    if (!digits) return "";
    return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  }
  function stripNonDigits(s) {
    return String(s).replace(/\D/g, "");
  }
  function setCash(rawValue) {
    const raw = stripNonDigits(rawValue).replace(/^0+(?=\d)/, "");
    el.dataset.raw = raw;
    el.value = fmt(raw);
  }
  el.addEventListener("focus", () => {
    setCash(el.value);
  });
  el.addEventListener("beforeinput", (e) => {
    e.preventDefault();
    const raw = stripNonDigits(el.dataset.raw || el.value);
    if (e.inputType === "insertText" && e.data) {
      const d = stripNonDigits(e.data);
      if (!d) return;
      setCash(raw + d);
    } else if (e.inputType === "deleteContentBackward") {
      setCash(raw.slice(0, -1));
    } else if (e.inputType === "deleteContentForward" || e.inputType === "deleteByCut") {
      setCash("");
    } else {
      return;
    }
    el.setSelectionRange(el.value.length, el.value.length);
  });
  el.addEventListener("paste", (e) => {
    e.preventDefault();
    const d = stripNonDigits(e.clipboardData.getData("text"));
    if (!d) return;
    const raw = stripNonDigits(el.dataset.raw || el.value);
    setCash(raw + d);
    el.setSelectionRange(el.value.length, el.value.length);
  });
  window.setActualCashValue = function (nominal) {
    setCash(nominal);
  };
})();

function pulihkanTutupKasirPending(rawSnapshot) {
  const report = document.getElementById("closeReport");
  const closeModal = document.getElementById("closeModal");
  pendingCloseLocked = true;
  document.getElementById("loginScreen").classList.add("hidden");
  document.getElementById("app").classList.remove("hidden");
  closeModal.classList.remove("hidden");
  kunciInputTutupKasir();
  try {
    const snapshot = typeof rawSnapshot === "string" ? JSON.parse(rawSnapshot) : rawSnapshot;
    if (!snapshot || snapshot.success !== true || !snapshot.shift || Number(snapshot.shift.shiftId) !== Number(currentKasir && currentKasir.shiftId) ||
        !/^[A-Z0-9]{6}$/.test(String(snapshot.kode_tutup || "")) || !snapshot.rekonsiliasiKas || !snapshot.kwh ||
        !["dalam", "luar"].every(side => {
          const value = snapshot.kwh[side] && snapshot.kwh[side].akhir;
          if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return false;
          const match = String(value).match(/^(\d+)(?:\.(\d{1,2}))?$/);
          return !!match && BigInt(match[1]) * 100n + BigInt((match[2] || "").padEnd(2, "0") || "0") <= BigInt(Number.MAX_SAFE_INTEGER);
        })) {
      throw new Error("Snapshot penutupan dari server tidak lengkap atau tidak sesuai shift.");
    }
    const rec = snapshot.rekonsiliasiKas;
    if (window.setActualCashValue) window.setActualCashValue(String(rec.nominalAktual));
    previewTutupKasir = snapshot;
    renderLaporanTutupKasir(snapshot);
    tampilkanTombolCetakLaporan(report);
    report.classList.remove("hidden");
    document.getElementById("lockedArea").classList.add("hidden");
  } catch (error) {
    previewTutupKasir = null;
    report.innerHTML = `<div class="close-verification">Shift sedang menunggu konfirmasi tutup, tetapi snapshot laporan gagal dipulihkan: ${escapeCloseHtml(error.message)}. Hubungi manager; jangan mulai transaksi baru.</div>`;
    report.classList.remove("hidden");
    document.getElementById("lockedArea").classList.add("hidden");
  }
}

document.addEventListener("keydown", (event) => {
  if ((openingBalancePending || pendingCloseLocked) && event.key === "Escape") {
    event.preventDefault();
    event.stopImmediatePropagation();
  }
}, true);

async function submitOpeningBalance() {
  const sessionId = (sessionStorage.getItem("pbms_session_id") || "").trim();
  const deviceId = getOrCreateDeviceId().trim();
  if (!sessionId) {
    console.error("Sesi login tidak ditemukan untuk submitOpeningBalance.");
    return;
  }
  try {
    const response = await fetch(apiUrl("/api/confirm-opening-balance"), {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Session-Id": sessionId, "X-Device-Id": deviceId },
      body: JSON.stringify({ saldo_awal: 0, saldo_kwh_dalam_awal: 0, saldo_kwh_luar_awal: 0, sessionId, deviceId })
    });
    const result = await response.json();
    if (!response.ok || result.success !== true) throw new Error(result.message || "Konfirmasi saldo awal gagal. Silakan coba lagi.");
    openingBalancePending = false;
    document.getElementById("loginScreen").classList.add("hidden");
    document.getElementById("app").classList.remove("hidden");
    if (currentKasir) document.getElementById("cashierName").childNodes[0].nodeValue = "KASIR: " + (currentKasir.nama || "") + " ";
    await muatSaldoKasLaci();
    await loadBarang();
    await fetchMejaSessions();
    if (!activeMeja || !mejaSessions[activeMeja]) await loadCartDraftServer();
    cekServer();
    updateMejaHeaderUI();
    updateSaveOrderButton();
    startSessionTimer(currentKasir?.expiresAt || sessionStorage.getItem("pbms_expires_at"));
  } catch (e) {
    alert("Konfirmasi saldo awal gagal: " + (e.message || "Periksa koneksi lalu coba lagi."));
  }
}
window.submitOpeningBalance = submitOpeningBalance;

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
        if (result.shiftState === "NO_CURRENT_OPEN_SHIFT") {
          showNoCurrentOpenShiftMessage();
          return;
        }
        const kId = result.kasirId;
        const kName = result.nama;
        const sId = result.shiftId;
        sessionStorage.setItem("pbms_kasir_id", result.kasirId);
        sessionStorage.setItem("pbms_nama", result.nama);
        sessionStorage.setItem("pbms_shift_id", result.shiftId);
        currentKasir = {
          id: kId,
          kasirId: kId,
          nama: kName,
          shiftId: sId,
          sessionId: result.sessionId,
          expiresAt: result.expiresAt
        };
        if (result.shiftState === "PENDING_CLOSE") {
          if (result.expiresAt) sessionStorage.setItem("pbms_expires_at", result.expiresAt);
          document.getElementById("cashierName").childNodes[0].nodeValue = "KASIR: " + (kName || "") + " ";
          pulihkanTutupKasirPending(result.pendingCloseSnapshot);
          startSessionTimer(result.expiresAt || sessionStorage.getItem("pbms_expires_at"));
          return;
        }
        if (Number(result.opening_confirmed) !== 1) {
          document.getElementById("loginScreen").classList.add("hidden");
          showOpeningBalanceModal();
          return;
        }
        if (result.expiresAt) {
          sessionStorage.setItem("pbms_expires_at", result.expiresAt);
        }

        document.getElementById("loginScreen").classList.add("hidden");
        document.getElementById("app").classList.remove("hidden");
        document.getElementById("cashierName").childNodes[0].nodeValue = "KASIR: " + (kName || "") + " ";

        await muatSaldoKasLaci();
        await loadBarang();
        await fetchMejaSessions();
        if (!activeMeja || !mejaSessions[activeMeja]) {
          await loadCartDraftServer();
        }

        await new Promise(resolve => setTimeout(resolve, 1500));
        await cekSemuaPrinterSaatStartup();

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

// === MODAL RIWAYAT SHIFT & CETAK ULANG ===
function bukaModalRiwayatShift() {
  const modal = document.getElementById("modalRiwayatShift");
  if (!modal) return;
  modal.classList.remove("hidden");
  muatRiwayatShift();
}

function tutupModalRiwayatShift() {
  const modal = document.getElementById("modalRiwayatShift");
  if (!modal) return;
  modal.classList.add("hidden");
}

async function muatRiwayatShift() {
  const container = document.getElementById("daftarRiwayatShiftContainer");
  if (!container) return;
  try {
    const res = await fetch("/api/shift/history");
    const json = await res.json();
    if (!json.success || !json.data) {
      container.innerHTML = "<div style='text-align:center; padding:20px; color:#dc2626;'>Gagal memuat riwayat shift.</div>";
      return;
    }
    if (json.data.length === 0) {
      container.innerHTML = "<div style='text-align:center; padding:20px; color:#666;'>Belum ada riwayat shift.</div>";
      return;
    }
    container.innerHTML = json.data.map(function (row) {
      const buka = new Date(row.buka_at);
      const tutup = row.tutup_at ? new Date(row.tutup_at) : null;
      const waktuBuka = buka.toLocaleString("id-ID", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
      const waktuTutup = tutup ? tutup.toLocaleString("id-ID", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "-";
      const nominal = row.nominal_aktual != null ? "Rp " + Number(row.nominal_aktual).toLocaleString("id-ID") : "-";
      const kode = row.kode_tutup || "-";
      return "<div style='border:1px solid #e5e7eb; border-radius:8px; padding:10px 12px; margin-bottom:8px;'>"
        + "<div style='display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;'>"
        + "<strong>" + (row.nama_kasir || "-") + "</strong>"
        + "<span style='color:#64748b; font-size:.8rem;'>#" + row.id + "</span>"
        + "</div>"
        + "<div style='font-size:.85rem; color:#334155;'>Buka: " + waktuBuka + " &middot; Tutup: " + waktuTutup + "</div>"
        + "<div style='font-size:.85rem; color:#334155;'>Kode: " + kode + " &middot; Total: " + nominal + "</div>"
        + "<div style='margin-top:8px; display:flex; justify-content:flex-end;'>"
        + "<button type='button' class='btn-reprint-shift' onclick='cetakUlangTutupKasir(" + row.id + ")' style='padding: 6px 12px; background: #0f766e; color: #fff; border: none; border-radius: 4px; cursor: pointer; font-weight: bold; font-size: 0.8rem;'>CETAK ULANG</button>"
        + "</div>"
        + "</div>";
    }).join("");
  } catch (error) {
    container.innerHTML = "<div style='text-align:center; padding:20px; color:#dc2626;'>Gagal memuat riwayat shift.</div>";
  }
}

async function cetakUlangTutupKasir(shiftId) {
  const btn = event.target;
  const btnText = btn ? btn.textContent : "";
  if (btn) {
    btn.disabled = true;
    btn.style.opacity = "0.6";
    btn.textContent = "MEMUAT...";
  }
  try {
    const res = await fetch("/api/shift/snapshot/" + shiftId);
    const json = await res.json();
    if (json.success && json.snapshot) {
      renderLaporanTutupKasir(json.snapshot);
      await cetakLaporanTutupKasir();
    } else {
      alert("Gagal memuat snapshot laporan tutup kasir: " + (json.message || "Data tidak ditemukan."));
    }
  } catch (error) {
    alert("Gagal memuat snapshot laporan tutup kasir: " + (error.message || "Terjadi kesalahan."));
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.style.opacity = "";
      btn.textContent = btnText;
    }
  }
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

let testPrintBluetoothSedangBerjalan = false;
async function testPrintBluetoothUI() {
  if (testPrintBluetoothSedangBerjalan) {
    return;
  }

  testPrintBluetoothSedangBerjalan = true;

  try {
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
  } finally {
    testPrintBluetoothSedangBerjalan = false;
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

    const loginPayload = {
      kasirId,
      pin,
      deviceId
    };
    let response =
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
            JSON.stringify(loginPayload)
        }
      );


    let result =
      await response.json();

    if (response.status === 409 || result.code === "SESSION_ACTIVE_OTHER_DEVICE") {
      const pindah = confirm('Akun ini masih aktif di perangkat lain.\n\nApakah Anda ingin keluar dari perangkat lama dan masuk di perangkat ini?');
      if (pindah) {
        response = await fetch(apiUrl("/api/login"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...loginPayload, forceLogin: true })
        });
        result = await response.json();
      } else {
        throw new Error("Login dibatalkan. Akun masih aktif di perangkat lain.");
      }
    }


    if (
      !result.success
    ) {
      throw new Error(
        result.message ||
        "Login gagal"
      );
    }

    if (result.shiftState === "NO_CURRENT_OPEN_SHIFT") {
      showNoCurrentOpenShiftMessage();
      return;
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

    if (result.shiftState === "PENDING_CLOSE") {
      pulihkanTutupKasirPending(result.pendingCloseSnapshot);
      startSessionTimer(result.expiresAt);
      return;
    }

    if (Number(result.opening_confirmed) !== 1) {
      document.getElementById("loginScreen").classList.add("hidden");
      showOpeningBalanceModal();
      return;
    }


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


    await muatSaldoKasLaci();
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
window.loginKasir = loginKasir;


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

    await loadBarang();
    alert("Katalog lokal dimuat ulang. Tidak ada sinkronisasi eksternal.");

  } catch (error) {

    alert(
      "GAGAL MEMUAT KATALOG LOKAL\n\n" +
      error.message
    );

  } finally {

    if (syncOverlay) {
      syncOverlay.classList.remove("show");
      syncOverlay.setAttribute("aria-hidden", "true");
    }

    if (button) {
      button.disabled = false;
      button.textContent = "MUAT ULANG KATALOG LOKAL";
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
        item => {
          // "Meja Billiard" selalu nonaktif; Meja Pagi/Malam mengikuti jadwal isMejaWaktuNonaktif().
          const nonaktifMejaBilliard = String(item.nama || "").trim() === "Meja Billiard";
          const nonaktifMejaWaktu = isMejaWaktuNonaktif(item.nama);
          const nonaktif = nonaktifMejaBilliard || nonaktifMejaWaktu;
          const isStokHabis = Number(item.stokAktual) <= 0;
          return `

          <button
            class="product-card"
            ${nonaktif ? 'disabled aria-disabled="true" tabindex="-1"' : ''}
            ${nonaktif || isStokHabis ? 'disabled aria-disabled="true" tabindex="-1"' : ''}
            ${!nonaktif && !isStokHabis ? `onclick='tambahBarang(${JSON.stringify(item)})'` : ''}
            ${isStokHabis ? `onclick="alert('Stok barang ini sedang habis');"` : ''}
            style="${isStokHabis ? 'pointer-events: none;' : ''}"
          >

            <div class="product-name">

              ${escapeHtml(
                item.nama
              )}${nonaktif ? ' <span style="display: inline-block; margin-left: 6px; padding: 2px 6px; border-radius: 999px; background: #dc2626; color: #fff; font-size: 0.65rem; font-weight: 800; vertical-align: middle;">NONAKTIF</span>' : ""}

            </div>

            ${isStokHabis ? '<span class="badge-stok-habis" style="position: absolute; top: 8px; right: 8px; background: #ff0000; color: #ffffff; font-size: 10px; font-weight: bold; padding: 2px 6px; border-radius: 4px; z-index: 10;">STOK HABIS</span>' : ''}

            <div class="product-price">

              ${rupiah(
                item.hargaJual
              )}

            </div>

          </button>

        `;
        }
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

document
  .getElementById(
    "searchClearBtn"
  )
  .addEventListener(
    "click",
    function () {

      const searchInput = document.getElementById("search");
      if (searchInput) {
        searchInput.value = "";
        searchInput.dispatchEvent(new Event("input"));
        searchInput.focus();
      }

    }
  );

setInterval(tampilkanBarang, 60000);


// ==================================================
// LOGIKA API MEJA & SESI (SQLITE BACKEND)
// ==================================================

function isItemMejaBilliard(value) {
  const nama = typeof value === "string" ? value : value?.nama;
  return ["Meja Billiard", "Meja Pagi", "Meja Malam"].includes(String(nama || "").trim());
}

function isPaket3Jam(value) {
  const nama = typeof value === "string" ? value : value?.nama;
  const trimmed = String(nama || "").trim();
  return trimmed === "Paket 3 Jam" || trimmed === "Paket 3 Jam Non Member";
}

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
    console.error("Gagal mengambil sesi meja:", error?.message || error, error?.stack || "");
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
        sinkronTampilanPilihanBonus();
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
              x => isItemMejaBilliard(x)
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
    if (session && session.status === "AKTIF") {
      cardClass += " meja-active-card";
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

    if (bookingForTable) {
      cardClass += " booking-new";
    }

    let topBadgesHtml = "";
    let bookingNoticeHtml = "";
    let bookingTimeHtml = "";

    if (isKaryawan) {
      topBadgesHtml += `<span class="ribbon-karyawan">KARYAWAN</span>`;
    }

    // BOOKING HANYA DARI WAITING LIST.
    // Tampilkan nama sebagai "BOOKING Nama" dan jam booking.
    if (bookingForTable && bookingForTable.namaCustomer) {
      const namaBooking = escapeHtml(String(bookingForTable.namaCustomer).trim());
      const jamBooking = escapeHtml(String(bookingForTable.jamBooking || bookingForTable.jam_booking || "").trim());

      bookingNoticeHtml = `<div class="cart-booking-notice">
  <div class="cart-booking-icon">&#128276;</div>
  <div class="cart-booking-title">BOOKING BARU!</div>
  <div class="cart-booking-name">${namaBooking}</div>
  ${jamBooking ? `<div class="cart-booking-time">&#128337; ${jamBooking}</div>` : ""}
</div>`;

      if (jamBooking) {
        bookingTimeHtml = `<div style="font-size: 0.7rem; font-weight: 800; color: #d97706; line-height: 1.1; margin-top: 1px;">${jamBooking}</div>`;
      }
    }
    if (session && session.status === "AKTIF" && session.namaPemesan) {
      topBadgesHtml += `<span class="badge-member" title="${escapeHtml(session.namaPemesan)}">${escapeHtml(session.namaPemesan)}</span>`;
    }

    const topContainerHtml = `<div class="meja-top-badge-container"${!topBadgesHtml ? ' style="visibility: hidden;"' : ''}>${topBadgesHtml || '<span class="badge-member">-</span>'}${bookingTimeHtml}</div>`;

    // 2. MEJA XX
    const isMejaKosong = !session || String(session.status || "").toUpperCase() !== "AKTIF";
    const mejaNumHtml = isMejaKosong ? `<div class="popup-table-num"></div>` : `<div class="popup-table-num">MEJA ${i < 10 ? '0' + i : i}</div>`;

    // 3. STATUS AKTIF / KOSONG
    const statusHtml = `<div class="popup-table-status">${statusText}</div>`;

    // 4. BADGE BOOKING
    // Jika booking berasal dari Waiting List dan sudah ditampilkan di bagian atas,
    // jangan tampilkan badge BOOKING kedua di bawah MEJA.
    const bookingBadgeHtml = `<div class="meja-booking-container"${(!isBooking || bookingForTable) ? ' style="visibility: hidden;"' : ''}><span class="ribbon-booking">BOOKING</span></div>`;

    if (isMejaKosong && !isBooking) cardClass += " meja-empty-card";
    const emptyArtHtml = (isMejaKosong && !isBooking) ? `<div class="meja-empty-copy"><div class="meja-empty-title"><span>—</span><strong>MEJA ${i < 10 ? "0" + i : i}</strong><span>—</span></div><div class="meja-empty-pill">KOSONG</div></div>` : "";

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
        ${bookingNoticeHtml}
        ${emptyArtHtml}
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
          if (!window.MejaTimer.parseDate(session.waktuSelesai)) {
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
let currentBukaMejaDraft = null;

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

  sinkronTampilanPilihanBonus();
}

// Pilihan bonus untuk Paket 3 Jam kini ditangani lewat modal
// #modalPilihanBonusBukaMeja saat tombol MULAI MAIN ditekan, bukan
// dropdown di form utama. Elemen #pilihanBonusBukaMeja di form utama
// tetap disembunyikan agar tidak memenuhi tampilan form Buka Meja.
function sinkronTampilanPilihanBonus() {
  const container = document.getElementById("containerPilihanBonus");
  const select = document.getElementById("pilihanBonusBukaMeja");
  if (container) {
    container.style.display = "none";
  }
  if (select) {
    select.value = "";
    select.disabled = true;
  }
}

window.bukaMejaDariModalBaru = async function(nomor, namaPemesan, durasiJam, draft, jenisSesi) {
  targetBukaMejaNomor = nomor;
  currentBukaMejaDraft = draft;
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

  sinkronTampilanPilihanBonus();

  const berhasil = await konfirmasiMulaiSesi(durasiJam, draft, jenisSesi);
  return berhasil;
};

window.handleMulaiMain = window.handleMulaiMain || window.bukaMejaDariModalBaru;

function tutupModalBukaMeja() {
  document.getElementById("bukaMejaModal").classList.remove("show");
  targetBukaMejaNomor = null;
  currentBukaMejaDraft = null;
  setModeSesiBukaMeja("DURASI");
  sinkronTampilanPilihanBonus();
}

function tutupModalBukaMejaLuar(event) {
  if (event.target.id === "bukaMejaModal") {
    tutupModalBukaMeja();
  }
}

// Payload tersimpan sementara saat modal pilihan bonus tampil.
// Setelah kasir memilih bonus di modal, eksekusi ulang POST /api/meja/buka.
let pendingPilihanBonus = null;

async function konfirmasiMulaiSesi(durasiJam = 1, draft = [], jenisSesiParam = null, pilihanBonusNilai = null) {
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


  // Paket 3 Jam: draft hanya berisi paket qty 1 => sesi 3 jam.
  // Backend menyimpan satu baris paket sebagai bagian pembukaan sesi,
  // sehingga frontend tidak mengirim paket via /api/meja/pesanan generik.
  const isPaket3JamSaja = selectedMode !== "LOSS"
    && Array.isArray(draft)
    && draft.length === 1
    && ["Paket 3 Jam", "Paket 3 Jam Non Member"].includes(String(draft[0]?.nama || "").trim())
    && Number(draft[0]?.qty) === 1;
  if (isPaket3JamSaja) {
    finalDurasiJam = 3;
  }
  // Paket 3 Jam non-member tidak punya tarif member, tapi sesi Member tetap
  // boleh pakai Paket 3 Jam + pilihan bonus, jadi memberId tidak lagi
  // dipaksa null saat isPaket3JamSaja.
  const memberId = selectedMember?.idMember || selectedMember?.id || selectedMember?.kodeMember || null;

  const requestPayload = {
    nomorMeja: targetBukaMejaNomor,
    namaPemesan: namaPemesan,
    kasir: currentKasir ? currentKasir.nama : "-",
    durasiJam: finalDurasiJam,
    jenisSesi: finalJenisSesi,
    modeSesi: finalJenisSesi,
    draft: draft
  };

  if (isPaket3JamSaja) {
    requestPayload.paket = "Paket 3 Jam";
    requestPayload.namaPaket = "Paket 3 Jam";
  }

  if (memberId) {
    requestPayload.memberId = memberId;
  }

  // Non-member atau sesi bukan Paket 3 Jam langsung dilanjutkan tanpa bonus.
  // Member + Paket 3 Jam tanpa nilai bonus: tunjukkan modal interaktif
  // untuk memilih bonus; pilihBonusBukaMeja() memanggil kembali fungsi
  // ini setelah nilai bonus dipilih.
  if (isPaket3JamSaja && selectedMember && !pilihanBonusNilai) {
    const pendingBonus = {
      durasiJam: durasiJam,
      draft: draft,
      jenisSesi: jenisSesiParam
    };
    pendingPilihanBonus = pendingBonus;
    const modalBonus = document.getElementById("modalPilihanBonusBukaMeja");
    if (modalBonus) {
      modalBonus.classList.add("show");
    }
    return false;
  }

  if (pilihanBonusNilai) {
    requestPayload.pilihanBonus = pilihanBonusNilai;
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
        if (!item || !item.nama || isItemMejaBilliard(item)) continue;
        if (isPaket3JamSaja && isPaket3Jam(item)) continue;
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

// Dipanggil saat kasir mengklik salah satu tombol di modal pilihan bonus.
// Mengambil nilai bonus yang dipilih, memanggil kembali konfirmasiMulaiSesi
// dengan nilai bonus tersebut, dan melanjutkan pengiriman POST /api/meja/buka.
window.pilihBonusBukaMeja = function(nilaiBonus) {
  const modalBonus = document.getElementById("modalPilihanBonusBukaMeja");
  if (modalBonus) {
    modalBonus.classList.remove("show");
  }

  if (!pendingPilihanBonus) {
    return;
  }

  const pending = pendingPilihanBonus;
  pendingPilihanBonus = null;

  konfirmasiMulaiSesi(
    pending.durasiJam,
    pending.draft,
    pending.jenisSesi,
    nilaiBonus
  ).catch(error => {
    console.error("Gagal lanjutkan buka meja setelah pilih bonus:", error);
  });
};

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
      if (isItemMejaBilliard(item) || item.nama === "Billiard Waktu Loss") continue;

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
  if (isItemMejaBilliard(item) || item.nama === "Billiard Waktu Loss") {
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
    if (isPaket3Jam(item)) {
      alert("Paket 3 Jam hanya qty 1 dan tidak dapat diubah via tambah qty.");
      return;
    }

    if (isItemMejaBilliard(item)) {
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

  if (isItemMejaBilliard(item)) {
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

  if (isPaket3Jam(item)) {
    alert("Paket 3 Jam hanya qty 1 dan tidak dapat diubah via kurang qty.");
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

function isMejaWaktuNonaktif(nama) {
  const namaNormal = String(nama || "").trim().toLowerCase();
  if (namaNormal !== "meja pagi" && namaNormal !== "meja malam") return false;

  const waktuMakassar = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Makassar",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(new Date());
  const jam = Number(waktuMakassar.find(part => part.type === "hour").value);
  const menit = Number(waktuMakassar.find(part => part.type === "minute").value);
  const menitDalamHari = jam * 60 + menit;
  const jadwalPagi = menitDalamHari >= 7 * 60 && menitDalamHari < 18 * 60;

  return namaNormal === "meja pagi" ? !jadwalPagi : jadwalPagi;
}
window.isMejaWaktuNonaktif = isMejaWaktuNonaktif;

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
    } else if (isItemMejaBilliard(item) && activeMeja && mejaSessions[activeMeja]) {
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
            ${escapeHtml(item.nama)}${isMejaWaktuNonaktif(item.nama) ? ' <span style="display: inline-block; margin-left: 6px; padding: 2px 6px; border-radius: 999px; background: #dc2626; color: #fff; font-size: 0.65rem; font-weight: 800; vertical-align: middle;">NONAKTIF</span>' : ""}
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
      isItemMejaBilliard(item) &&
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
          // Normalisasi identitas member: string/number yang sama menghasilkan key yang sama,
          // sehingga hasil harga member sebelumnya tidak pernah dipakai ulang di meja ini.
          const memberIdCache = (member.idMember ?? member.memberId ?? member.id ?? member.kodeMember ?? member.kode_member ?? "");
          const cacheKey = `${activeMeja}_${String(memberIdCache).trim()}_${kategori}_${durasiJam}_${waktuMulai}`;

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

function isiUangPas() {
  const total = getTotal();
  const bayar = document.getElementById("bayar");
  if (!bayar || total <= 0) return;
  bayar.value = formatCurrencyInput(total);
  updateKembalian();
}



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
  const session = activeMeja ? mejaSessions[activeMeja] : null;
  if (!session) {
    alert("Pilih meja terlebih dahulu.");
    return;
  }

  if (btn) {
    btn.disabled = true;
    btn.textContent = "MENGECEK...";
  }

  let cekHargaBerhasil = false;
  try {
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

  const waktuMulai = session.waktuMulai || session.waktu_mulai;
  const jamMakassar = waktuMulai ? Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Makassar", hour: "2-digit", hourCycle: "h23" }).format(new Date(waktuMulai))) : -1;
  const bonusLayak = ["PLATINUM", "UMUM", "PELAJAR"].includes(kategori) && MEMBER_SCHEDULE.isNightHour(jamMakassar) && Math.floor(durasiJam / 3) > 0;
  const currentBonus = cart.find(item => ["kopi bonus", "es teh bonus"].includes(String(item.nama || "").trim().toLowerCase()));
  let bonusProduct = currentBonus?.nama || null;

    const response = await authenticatedFetch("/api/meja/hitung-harga", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: session.sessionId || session.session_id || null,
        kategori,
        durasiJam,
        bonusProduct
      })
    });

    let result = await response.json();

    if (!result.success) {
      throw new Error(result.message || "Harga member tidak tersedia.");
    }

    if (bonusLayak) {
      const pilihan = window.prompt("Harga berhasil. Pilih bonus: ketik 1 untuk Kopi atau 2 untuk Es Teh", bonusProduct === "Es Teh Bonus" ? "2" : "1");
      if (pilihan !== "1" && pilihan !== "2") throw new Error("Pilih Kopi atau Es Teh untuk bonus sesi.");
      bonusProduct = pilihan === "1" ? "Kopi Bonus" : "Es Teh Bonus";
      const bonusResponse = await authenticatedFetch("/api/meja/hitung-harga", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: session.sessionId || session.session_id || null, kategori, durasiJam, bonusProduct })
      });
      result = await bonusResponse.json();
      if (!result.success) throw new Error(result.message || "Gagal menerapkan bonus sesi.");
    }

    const itemMeja = cart.find(isItemMejaBilliard);

    if (!itemMeja) {
      throw new Error("Item meja tidak ditemukan di keranjang.");
    }

    itemMeja.qty = durasiJam;
    itemMeja.hargaJual = Number(result.hargaPerJam);
    itemMeja.harga = Number(result.hargaPerJam);
    itemMeja.subtotal = Number(result.total);

    const bonusInCart = cart.find(item => ["kopi bonus", "es teh bonus"].includes(String(item.nama || "").trim().toLowerCase()));
    if (result.bonusQty > 0 && result.bonusProduct) {
      if (bonusInCart && bonusInCart.nama !== result.bonusProduct) cart.splice(cart.indexOf(bonusInCart), 1);
      let bonusItem = cart.find(item => String(item.nama || "").trim().toLowerCase() === result.bonusProduct.toLowerCase());
      if (!bonusItem) {
        bonusItem = { nama: result.bonusProduct, qty: result.bonusQty, harga: 0, hargaJual: 0, subtotal: 0, kategori: "BONUS" };
        cart.push(bonusItem);
      }
      bonusItem.qty = result.bonusQty;
      bonusItem.harga = bonusItem.hargaJual = bonusItem.subtotal = 0;
    } else if (bonusInCart) {
      cart.splice(cart.indexOf(bonusInCart), 1);
    }

    renderCart();
    updateSaveOrderButton();

    cekHargaBerhasil = true;
    alert(
      `Harga ${kategori} diterapkan: ${rupiah(result.hargaPerJam)}/jam x ${durasiJam} jam = ${rupiah(result.total)}`
    );
  } catch (error) {
    alert("Gagal cek harga meja: " + error.message);
  } finally {
    if (btn) {
      btn.disabled = false;
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

function getSessionIdToCloseAfterTransaction(finishedSession, targetSessionId, isFreeKaryawan) {
  if (!finishedSession || !targetSessionId) return null;

  const finishedStatus = String(finishedSession.status || "").toUpperCase();
  if (finishedStatus === "AKTIF" || (isFreeKaryawan && finishedStatus === "DIBAYAR")) {
    return targetSessionId;
  }

  return null;
}

async function executePayment(payment, targetSessionId, targetSession, nomorMeja, pendingMemberForMeja) {
  const button = document.getElementById("payBtn");
  button.disabled = true;
  button.innerHTML = "<span>MEMPROSES...</span>";

  try {
    const yakin = confirm("Apakah Anda yakin melakukan pembayaran ini?");
    if (!yakin) {
      return;
    }

    const requestPayload = {
      shiftId: currentKasir.shiftId,
      nomorMeja: nomorMeja || null,
      metodePembayaran: payment.metodePembayaran === "GRATIS"
        ? "GRATIS"
        : (metodePembayaran === "SPLIT" ? "CASH+QRIS" : metodePembayaran),
      bayar: payment.bayar,
      cashAmount: payment.cash,
      qrisAmount: payment.qris,
      items: cart
    };

    if (targetSessionId) {
      requestPayload.sessionId = targetSessionId;
    }

    if (!targetSessionId && pendingMemberForMeja) {
      const selectedMemberId =
        pendingMemberForMeja?.idMember ||
        pendingMemberForMeja?.id ||
        pendingMemberForMeja?.kodeMember ||
        null;
      if (selectedMemberId) {
        requestPayload.memberId = selectedMemberId;
      }
    }

    const response = await authenticatedFetch("/api/transaksi", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestPayload)
    });

    const result = await response.json();

    if (!result.success) {
      throw new Error(result.message || "Transaksi gagal");
    }

    const finishedMeja = nomorMeja;
    const finishedSession = finishedMeja ? targetSession : null;
    const pemesanName = finishedSession ? finishedSession.namaPemesan : "-";
    await fetchMejaSessions();

    currentFinishedSessionInfo = {
      nomorTransaksi: result.nomorTransaksi,
      meja: finishedMeja || "-",
      pemesan: pemesanName,
      total: payment.total,
      bayar: payment.bayar,
      kembalian: Math.max(0, payment.bayar - payment.total)
    };

    // CETAK STRUK BLUETOOTH
    try {
      const semuaItem = Array.isArray(cart) ? [...cart] : [];
      const itemMeja = semuaItem.find(item => isItemMejaBilliard(item));
      const produk = semuaItem
        .filter(item => !isItemMejaBilliard(item))
        .map(item => {
          const master = masterBarang.find(x => x.nama === item.nama);
          const harga = Number(
            item.hargaJual !== undefined
              ? item.hargaJual
              : (item.harga !== undefined ? item.harga : (master?.hargaJual || 0))
          );
          const qty = Number(item.qty || 0);
          return { nama: item.nama || "-", qty, harga: rupiah(harga) };
        });

      const now = new Date();
      const tanggalStruk =
        String(now.getDate()).padStart(2, "0") + "/" +
        String(now.getMonth() + 1).padStart(2, "0") + "/" +
        now.getFullYear() + " " +
        String(now.getHours()).padStart(2, "0") + ":" +
        String(now.getMinutes()).padStart(2, "0");

      const durasiJam = Number(
        finishedSession?.durasiJam ?? finishedSession?.durasi_jam ?? itemMeja?.qty ?? 0
      );
      const hargaJam = durasiJam > 0
        ? Math.round(Number(itemMeja?.hargaJual ?? itemMeja?.harga ?? 0) / durasiJam)
        : Number(itemMeja?.hargaJual ?? itemMeja?.harga ?? 0);

      const teksStruk = buatStrukTransaksi({
        nomorTransaksi: result.nomorTransaksi,
        tanggal: tanggalStruk,
        kasir: currentKasir?.nama || "ADMIN",
        meja: finishedMeja ? "Meja " + finishedMeja : null,
        durasi: durasiJam + " Jam",
        hargaJam: rupiah(hargaJam),
        subtotalMeja: rupiah(itemMeja?.subtotal !== undefined ? Number(itemMeja.subtotal) : hargaJam * durasiJam),
        produk,
        total: rupiah(payment.total),
        metodeBayar: payment.metodePembayaran || "-",
        bayar: rupiah(payment.bayar),
        kembali: rupiah(Math.max(0, payment.bayar - payment.total))
      });

      const hasilCetak = await cetakStrukBluetooth(teksStruk);
      if (!hasilCetak?.success) {
        console.error("Transaksi berhasil, tetapi struk gagal dicetak:", hasilCetak?.message || "Unknown printer error");
      }
    } catch (printError) {
      console.error("Transaksi berhasil, tetapi terjadi error saat mencetak struk:", printError);
    }

    // CETAK PESANAN BAR/DAPUR KHUSUS TRANSAKSI TANPA MEJA
    if (!nomorMeja && !targetSessionId && !result.sessionId) {
      const namaPemesanInput = document.getElementById("namaPemesanTanpaMeja");
      const namaPemesan = namaPemesanInput ? namaPemesanInput.value.trim() : "";
      if (namaPemesan) {
        const itemsUntukCetak = cart.map(item => ({ nama: item.nama, qty: item.qty }));
        if (itemsUntukCetak.length > 0) {
          try {
            await window.cetakPesananBerdasarkanKategori({
              meja: "TANPA MEJA",
              sessionId: "-",
              pemesan: namaPemesan,
              items: itemsUntukCetak
            });
          } catch (err) {
            console.error("[TRANSAKSI TANPA MEJA] Gagal cetak pesanan BAR/DAPUR:", err);
          }
        }
      }
    }

    const sessionIdToClose = getSessionIdToCloseAfterTransaction(finishedSession, targetSessionId, payment.total === 0);
    if (sessionIdToClose) {
      try {
        await authenticatedFetch("/api/meja/tutup", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId: sessionIdToClose })
        });
      } catch (err) {
        console.error("Gagal menutup sesi meja di server:", err);
      }
    }

    await fetchMejaSessions();
    const wasTableTrx = Boolean(finishedMeja);
    if (finishedMeja && stoppedSessionIdsByMeja[finishedMeja] === targetSessionId) {
      delete stoppedSessionIdsByMeja[finishedMeja];
    }
    if (pendingPaymentTableNo !== null && Number(pendingPaymentTableNo) === Number(finishedMeja)) {
      pendingPaymentTableNo = null;
    }
    activeMeja = null;
    nomorMeja = null;
    cart = [];

    const namaPemesanInput2 = document.getElementById("namaPemesanTanpaMeja");
    if (namaPemesanInput2) {
      namaPemesanInput2.value = "";
    }

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

  } catch (error) {
    alert("Transaksi gagal:\n" + error.message);
  } finally {
    button.disabled = false;
    button.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: middle; margin-right: 6px; flex-shrink: 0;"><rect x="2" y="5" width="20" height="14" rx="2"></rect><line x1="2" y1="10" x2="22" y2="10"></line></svg><span>BAYAR</span>';
  }
}


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

  // VALIDASI SESSION ID UNTUK TRANSAKSI MEJA
  if (!activeMeja) {
    nomorMeja = null;
    pendingPaymentTableNo = null;
  }
  let targetSessionId = null;
  let targetSession = null;
  if (nomorMeja) {
    targetSession = mejaSessions[nomorMeja] || null;
    // Setelah STOP LOSS, sesi sudah berstatus SELESAI sehingga GET /api/meja/sesi
    // tidak lagi menaruhnya di mejaSessions. Gunakan sessionId yang disimpan saat STOP.
    targetSessionId = targetSession?.sessionId || stoppedSessionIdsByMeja[nomorMeja] || null;
    if (!targetSessionId) {
      alert("Session meja tidak valid atau tidak tersedia.");
      return;
    }
  }

  const isFreeKaryawan = payment.total === 0 &&
    Boolean(targetSessionId) &&
    String(targetSession?.jenisSesi || targetSession?.jenis_sesi || "").trim().toUpperCase() === "KARYAWAN";
  if (!Number.isFinite(payment.total) || payment.total < 0 || (payment.total === 0 && !isFreeKaryawan)) {
    alert("Total transaksi harus lebih dari 0.");
    return;
  }

  if (isFreeKaryawan) {
    payment.cash = 0;
    payment.qris = 0;
    payment.bayar = 0;
    payment.metodePembayaran = "GRATIS";
  } else {
    if (metodePembayaran === "CASH" && payment.cash < payment.total) {
      alert("Nominal Cash kurang.");
      return;
    }

    if (metodePembayaran === "SPLIT" && payment.bayar !== payment.total) {
      alert("Cash + QRIS harus sama persis dengan total transaksi.");
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

  // Show QRIS confirmation popup if needed
  const qrisMethod = (payment.metodePembayaran === "GRATIS")
    ? null
    : (metodePembayaran === "SPLIT" ? "CASH+QRIS" : metodePembayaran);

  if (qrisMethod === "QRIS") {
    window.pendingQrisData = {
      payment: payment,
      targetSessionId: targetSessionId,
      targetSession: targetSession,
      nomorMeja: nomorMeja,
      pendingMemberForMeja: pendingMemberForMeja
    };
    document.getElementById("qrisConfirmPopup").classList.add("show");
    return;
  }

  await executePayment(payment, targetSessionId, targetSession, nomorMeja, pendingMemberForMeja);
}

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

let previewTutupKasir = null;
let prosesTutupKasirAktif = false;
let timerTutupKasir = null;

function bukaTutupKasir() {
  if (pendingCloseLocked && previewTutupKasir) {
    pulihkanTutupKasirPending(previewTutupKasir);
    return;
  }
  if (timerTutupKasir) { clearInterval(timerTutupKasir); timerTutupKasir = null; }
  prosesTutupKasirAktif = false;
  document.getElementById("closeModal").classList.remove("hidden");
  const calculateButton = document.getElementById("calculateCloseBtn");
  calculateButton.classList.remove("hidden");
  calculateButton.disabled = false;
  ["actualCash"].forEach(id => { if (window.setActualCashValue) window.setActualCashValue(""); document.getElementById(id).disabled = false; });
  previewTutupKasir = null;
  document.getElementById("closeReport").classList.add("hidden");
  document.getElementById("closeReport").innerHTML = "";
  document.getElementById("lockedArea").classList.remove("hidden");
}

let setoranKasMasukValid = null;
let validasiSetoranKasMasukAktif = false;
let simpanKasMasukAktif = false;

function resetKasMasukFlow() {
  setoranKasMasukValid = null;
  validasiSetoranKasMasukAktif = false;
  simpanKasMasukAktif = false;
  document.getElementById("kasMasukForm").reset();
  document.getElementById("kasKodeSetoran").disabled = false;
  document.getElementById("kasSaldoSetoranInfo").hidden = true;
  document.getElementById("kasSaldoSetoranInfo").textContent = "";
  document.getElementById("kasNominal").disabled = true;
  document.getElementById("kasMasukSubmit").disabled = true;
  document.getElementById("kasMasukSubmit").style.opacity = ".55";
  document.getElementById("kasMasukSubmit").style.cursor = "not-allowed";
  document.getElementById("kasMasukMessage").textContent = "";
}

function bukaModalKasMasuk(event) {
  if (event) {
    event.stopPropagation();
    const choices = document.getElementById("drawerBalanceChoices");
    choices.hidden = true;
    choices.style.display = "none";
    document.getElementById("drawerBalanceButton").setAttribute("aria-expanded", "false");
  }
  resetKasMasukFlow();
  const modal = document.getElementById("kasMasukModal");
  modal.classList.add("show");
  modal.setAttribute("aria-hidden", "false");
  window.setTimeout(() => document.getElementById("kasKodeSetoran").focus(), 0);
}

function tutupModalKasMasuk() {
  const modal = document.getElementById("kasMasukModal");
  modal.classList.remove("show");
  modal.setAttribute("aria-hidden", "true");
  resetKasMasukFlow();
}

function tutupModalKasMasukLuar(event) {
  if (event.target.id === "kasMasukModal") tutupModalKasMasuk();
}

function ubahKodeSetoranKasMasuk() {
  setoranKasMasukValid = null;
  document.getElementById("kasNominal").value = "";
  document.getElementById("kasNominal").disabled = true;
  document.getElementById("kasSaldoSetoranInfo").hidden = true;
  document.getElementById("kasMasukSubmit").disabled = true;
  document.getElementById("kasMasukSubmit").style.opacity = ".55";
  document.getElementById("kasMasukMessage").textContent = "";
}

async function validasiKodeSetoranKasMasuk() {
  const input = document.getElementById("kasKodeSetoran");
  const kode = input.value.trim();
  const message = document.getElementById("kasMasukMessage");
  if (!kode || validasiSetoranKasMasukAktif) return;
  validasiSetoranKasMasukAktif = true;
  message.textContent = "Memeriksa kode setoran…";
  message.style.color = "#64748b";
  try {
    const response = await authenticatedFetch(`/api/kas-laci/setoran?kode=${encodeURIComponent(kode)}`);
    const result = await response.json();
    if (!response.ok || !result.success) throw new Error(result.message || "Kode Setoran tidak valid.");
    if (input.value.trim().toLowerCase() !== kode.toLowerCase()) return;
    setoranKasMasukValid = result.setoran;
    const saldoInfo = document.getElementById("kasSaldoSetoranInfo");
    saldoInfo.textContent = `Saldo Setoran tersedia: ${rupiah(setoranKasMasukValid.saldoTersisa)}`;
    saldoInfo.hidden = false;
    document.getElementById("kasNominal").disabled = false;
    message.textContent = "Kode Setoran valid.";
    message.style.color = "#15803d";
    validasiNominalKasMasuk();
  } catch (error) {
    setoranKasMasukValid = null;
    message.textContent = error.message || "Kode Setoran gagal diperiksa.";
    message.style.color = "#b91c1c";
  } finally { validasiSetoranKasMasukAktif = false; }
}

function validasiNominalKasMasuk() {
  const field = document.getElementById("kasNominal");
  const nominal = Number(field.value);
  const valid = !!setoranKasMasukValid && Number.isSafeInteger(nominal) && nominal > 0 && nominal <= setoranKasMasukValid.saldoTersisa;
  const submit = document.getElementById("kasMasukSubmit");
  submit.disabled = !valid || simpanKasMasukAktif;
  submit.style.opacity = submit.disabled ? ".55" : "1";
  submit.style.cursor = submit.disabled ? "not-allowed" : "pointer";
  if (field.value && !valid) {
    const message = document.getElementById("kasMasukMessage");
    message.textContent = nominal > (setoranKasMasukValid?.saldoTersisa || 0) ? "Nominal melebihi saldo Setoran yang tersedia." : "Masukkan nominal rupiah bulat yang lebih besar dari 0.";
    message.style.color = "#b91c1c";
  }
  return valid;
}

async function simpanFormKasMasuk(event) {
  event.preventDefault();
  if (simpanKasMasukAktif) return;
  const nominal = Number(document.getElementById("kasNominal").value);
  const message = document.getElementById("kasMasukMessage");
  if (!setoranKasMasukValid || !validasiNominalKasMasuk()) return;
  simpanKasMasukAktif = true;
  document.getElementById("kasMasukSubmit").disabled = true;
  message.textContent = "Menyimpan Uang Masuk…";
  message.style.color = "#64748b";
  try {
    const response = await authenticatedFetch("/api/kas-laci/uang-masuk", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kodeSetoran: setoranKasMasukValid.kodeSetoran, nominal, keterangan: document.getElementById("kasKeterangan").value.trim() }) });
    const result = await response.json();
    if (!response.ok || !result.success) throw new Error(result.message || "Uang Masuk gagal disimpan.");
// ==================================================
// HELPER FORMAT STRUK KAS 32 KOLOM
// ==================================================
function formatStrukCenter32(text) {
  const t = String(text || "").trim();
  if (t.length >= 32) return t.slice(0, 32);
  const padLeft = Math.floor((32 - t.length) / 2);
  const padRight = 32 - t.length - padLeft;
  return " ".repeat(padLeft) + t + " ".repeat(padRight);
}

function formatStrukRow32(label, value) {
  const l = String(label || "").trim();
  const v = String(value || "").trim();
  const maxLabelWidth = 32 - v.length - 1;
  const safeLabel = l.length > maxLabelWidth ? l.slice(0, maxLabelWidth) : l;
  const spaces = Math.max(1, 32 - safeLabel.length - v.length);
  return safeLabel + " ".repeat(spaces) + v;
}

function formatStrukWrap32(text) {
  const words = String(text || "").trim().split(/\s+/);
  const lines = [];
  let cur = "";
  words.forEach(w => {
    if (!cur) {
      cur = w;
    } else if ((cur + " " + w).length <= 32) {
      cur += " " + w;
    } else {
      lines.push(cur);
      cur = w;
    }
  });
  if (cur) lines.push(cur);
  return lines;
}

    const tanggalWaktu = new Date(result.waktu);
    const tglStr = String(tanggalWaktu.getDate()).padStart(2, '0') + '/' + String(tanggalWaktu.getMonth() + 1).padStart(2, '0') + '/' + tanggalWaktu.getFullYear() + ' ' + String(tanggalWaktu.getHours()).padStart(2, '0') + ':' + String(tanggalWaktu.getMinutes()).padStart(2, '0');
    const notaUangMasuk = [
      formatStrukCenter32("POLLARD BILLIARD"),
      formatStrukCenter32("BUKTI UANG MASUK"),
      "================================",
      formatStrukRow32("ID Transaksi", result.transactionId),
      formatStrukRow32("Kode Setoran", result.kodeSetoran),
      formatStrukRow32("Tanggal", tglStr),
      formatStrukRow32("Kasir", result.kasir),
      "--------------------------------",
      formatStrukRow32("Setoran Awal", rupiah(result.nominalAwal)),
      formatStrukRow32("Uang Masuk", rupiah(result.nominalUangMasuk)),
      formatStrukRow32("Sisa Setoran", rupiah(result.saldoSetoranSesudah)),
      "--------------------------------",
      formatStrukRow32("Saldo Laci", rupiah(result.saldoKasLaci)),
      ...(result.keterangan ? ["Keterangan:", ...formatStrukWrap32(result.keterangan)] : []),
      "================================",
      formatStrukCenter32("TRANSAKSI BERHASIL"),
      formatStrukCenter32("Simpan sebagai bukti sah"),
      "", "", ""
    ];
    let printerError = null;
    try {
      if (typeof window.cetakStrukBluetooth !== "function") throw new Error("Modul cetak printer belum tersedia.");
      const printResult = await window.cetakStrukBluetooth(notaUangMasuk.join("\n"));
      if (!printResult || printResult.success !== true) throw new Error(printResult?.message || "Printer tidak mengonfirmasi keberhasilan cetak.");
    } catch (error) {
      printerError = error;
      console.error("Uang Masuk tersimpan, tetapi nota gagal dicetak:", error);
    }
    message.textContent = `${result.transactionId} tersimpan. Saldo Setoran ${rupiah(result.saldoSetoranSesudah)}; saldo Kas Laci ${rupiah(result.saldoKasLaci)}.${printerError ? ` Pencetakan gagal: ${printerError.message}` : " Nota berhasil dicetak."}`;
    message.style.color = "#15803d";
    setoranKasMasukValid = null;
    document.getElementById("kasNominal").disabled = true;
    document.getElementById("kasKodeSetoran").disabled = true;
    document.getElementById("kasMasukSubmit").disabled = true;
    muatSaldoKasLaci();
    if (printerError) alert(`Uang Masuk ${result.transactionId} berhasil tersimpan, tetapi pencetakan gagal: ${printerError.message}`);
  } catch (error) {
    message.textContent = error.message || "Uang Masuk gagal disimpan.";
    message.style.color = "#b91c1c";
  } finally {
    simpanKasMasukAktif = false;
    if (setoranKasMasukValid) validasiNominalKasMasuk();
  }
}

let simpanKasKeluarLaciAktif = false;
function bukaModalKasKeluar(event) {
  if (event) {
    event.stopPropagation();
    const choices = document.getElementById("drawerBalanceChoices");
    choices.hidden = true;
    choices.style.display = "none";
    document.getElementById("drawerBalanceButton").setAttribute("aria-expanded", "false");
  }
  document.getElementById("kasKeluarLaciForm").reset();
  document.getElementById("kasKeluarLaciNominal").disabled = false;
  document.getElementById("kasKeluarLaciKeterangan").disabled = false;
  document.getElementById("kasKeluarLaciMessage").textContent = "";
  simpanKasKeluarLaciAktif = false;
  const modal = document.getElementById("kasKeluarLaciModal");
  modal.classList.add("show");
  modal.setAttribute("aria-hidden", "false");
  validasiNominalKasKeluar();
  window.setTimeout(() => document.getElementById("kasKeluarLaciNominal").focus(), 0);
}
function tutupModalKasKeluar() {
  const modal = document.getElementById("kasKeluarLaciModal");
  modal.classList.remove("show");
  modal.setAttribute("aria-hidden", "true");
}
function tutupModalKasKeluarLuar(event) {
  if (event.target.id === "kasKeluarLaciModal") tutupModalKasKeluar();
}
function validasiNominalKasKeluar() {
  const field = document.getElementById("kasKeluarLaciNominal");
  const nominal = Number(field.value);
  const valid = field.value.trim() !== "" && Number.isSafeInteger(nominal) && nominal > 0;
  const submit = document.getElementById("kasKeluarLaciSubmit");
  submit.disabled = !valid || simpanKasKeluarLaciAktif;
  submit.style.opacity = submit.disabled ? ".55" : "1";
  submit.style.cursor = submit.disabled ? "not-allowed" : "pointer";
  if (field.value && !valid) {
    const message = document.getElementById("kasKeluarLaciMessage");
    message.textContent = "Masukkan nominal rupiah bulat yang lebih besar dari 0.";
    message.style.color = "#b91c1c";
  }
  return valid;
}
async function simpanFormKasKeluar(event) {
  event.preventDefault();
  if (simpanKasKeluarLaciAktif || !validasiNominalKasKeluar()) return;
  const nominal = Number(document.getElementById("kasKeluarLaciNominal").value);
  const keterangan = document.getElementById("kasKeluarLaciKeterangan").value.trim();
  const message = document.getElementById("kasKeluarLaciMessage");
  if (!keterangan) {
    message.textContent = "Keterangan wajib diisi sebagai tujuan penggunaan uang.";
    message.style.color = "#b91c1c";
    document.getElementById("kasKeluarLaciKeterangan").focus();
    return;
  }
  if (keterangan.length > 200) {
    message.textContent = "Keterangan maksimal 200 karakter.";
    message.style.color = "#b91c1c";
    return;
  }
  simpanKasKeluarLaciAktif = true;
  document.getElementById("kasKeluarLaciSubmit").disabled = true;
  message.textContent = "Menyimpan Uang Keluar…";
  message.style.color = "#64748b";
  let committed = false;
  try {
    const response = await authenticatedFetch("/api/kas-laci/uang-keluar", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ nominal, keterangan }) });
    const result = await response.json();
    if (!response.ok || !result.success) throw new Error(result.message || "Uang Keluar gagal disimpan.");
    committed = true;
    document.getElementById("drawerBalanceAmount").textContent = rupiah(result.saldoKasLaciSesudah);
    const tanggalWaktu = new Date(result.waktu);
    const tglKeluarStr = String(tanggalWaktu.getDate()).padStart(2, '0') + '/' + String(tanggalWaktu.getMonth() + 1).padStart(2, '0') + '/' + tanggalWaktu.getFullYear() + ' ' + String(tanggalWaktu.getHours()).padStart(2, '0') + ':' + String(tanggalWaktu.getMinutes()).padStart(2, '0');
    const notaUangKeluar = [
      formatStrukCenter32("POLLARD BILLIARD"),
      formatStrukCenter32("BUKTI UANG KELUAR"),
      "================================",
      formatStrukRow32("ID Transaksi", result.transactionId),
      formatStrukRow32("Tanggal", tglKeluarStr),
      formatStrukRow32("Kasir", result.kasir),
      "--------------------------------",
      formatStrukRow32("Uang Keluar", rupiah(result.nominal)),
      formatStrukRow32("Saldo Kasir", rupiah(result.saldoKasLaciSesudah)),
      "--------------------------------",
      "Keperluan:",
      ...formatStrukWrap32(result.keterangan || "-"),
      "================================",
      formatStrukCenter32("TRANSAKSI BERHASIL"),
      formatStrukCenter32("Simpan sebagai bukti sah"),
      "", "", ""
    ];
    let printerError = null;
    try {
      if (typeof window.cetakStrukBluetooth !== "function") throw new Error("Modul cetak printer belum tersedia.");
      const printResult = await window.cetakStrukBluetooth(notaUangKeluar.join("\n"));
      if (!printResult || printResult.success !== true) throw new Error(printResult?.message || "Printer tidak mengonfirmasi keberhasilan cetak.");
    } catch (error) {
      printerError = error;
      console.error("Uang Keluar tersimpan, tetapi struk gagal dicetak:", error);
    }
    message.textContent = `${result.transactionId} berhasil tersimpan. Saldo Kas Laci terbaru: ${rupiah(result.saldoKasLaciSesudah)}.`;
    message.style.color = "#15803d";
    document.getElementById("kasKeluarLaciNominal").disabled = true;
    document.getElementById("kasKeluarLaciKeterangan").disabled = true;
    alert(printerError
      ? `Uang Keluar ${result.transactionId} berhasil tersimpan. Saldo Kas Laci: ${rupiah(result.saldoKasLaciSesudah)}. Transaksi berhasil, tetapi pencetakan gagal: ${printerError.message}`
      : `Uang Keluar ${result.transactionId} berhasil tersimpan. Saldo Kas Laci terbaru: ${rupiah(result.saldoKasLaciSesudah)}.`);
  } catch (error) {
    message.textContent = committed ? `Transaksi tersimpan. Saldo Kas Laci: ${rupiah(Number(document.getElementById("drawerBalanceAmount").textContent.replace(/[^0-9]/g, "")) || 0)}.` : error.message || "Uang Keluar gagal disimpan.";
    message.style.color = committed ? "#15803d" : "#b91c1c";
  } finally {
    simpanKasKeluarLaciAktif = false;
    if (!committed) validasiNominalKasKeluar();
  }
}

document.addEventListener("keydown", event => {
  if (event.key === "Escape" && document.getElementById("kasMasukModal").classList.contains("show")) {
    tutupModalKasMasuk();
  }
  if (event.key === "Escape" && document.getElementById("kasKeluarLaciModal").classList.contains("show")) tutupModalKasKeluar();
});

async function muatSaldoKasLaci() {
  const host = document.getElementById("drawerBalanceAmount");
  if (!currentKasir || !currentKasir.shiftId) { host.textContent = "—"; return; }
  try {
    const response = await authenticatedFetch(`/api/kasir/kas-laci-saldo?shiftId=${Number(currentKasir.shiftId)}`);
    const data = await response.json();
    if (!response.ok || !data.success) throw new Error(data.message || "Saldo Kas Laci gagal dimuat");
    host.textContent = rupiah(data.saldoKasLaci);
  } catch (error) {
    host.textContent = "—";
    console.error("Saldo Kas Laci gagal dimuat:", error);
  }
}

function toggleDrawerBalanceChoices(event) {
  event.stopPropagation();
  const choices = document.getElementById("drawerBalanceChoices");
  choices.hidden = !choices.hidden;
  choices.style.display = choices.hidden ? "none" : "flex";
  document.getElementById("drawerBalanceButton").setAttribute("aria-expanded", String(!choices.hidden));
}

function resetFormPembelianKwh() {
  document.getElementById("pembelianKwhJenis").value = "";
  document.getElementById("pembelianKwhFields").hidden = true;
  document.getElementById("pembelianKwhNominal").value = "";
  document.getElementById("pembelianKwhDidapat").value = "";
  document.getElementById("pembelianKwhKeterangan").value = "";
  document.getElementById("pembelianKwhHarga").textContent = "Ditampilkan setelah berhasil disimpan";
}

function bukaPembelianKwhModal() {
  if (!currentKasir) return alert("Kasir belum login.");
  resetFormPembelianKwh();
  document.getElementById("pembelianKwhMessage").textContent = "";
  document.getElementById("pembelianKwhResult").hidden = true;
  document.getElementById("pembelianKwhModal").classList.add("show");
}

function tutupPembelianKwhModal() {
  document.getElementById("pembelianKwhModal").classList.remove("show");
}

function tutupPembelianKwhModalLuar(event) {
  if (event.target.id === "pembelianKwhModal") tutupPembelianKwhModal();
}

function ubahJenisPembelianKwh() {
  const visible = Boolean(document.getElementById("pembelianKwhJenis").value);
  document.getElementById("pembelianKwhFields").hidden = !visible;
  document.getElementById("pembelianKwhHarga").textContent = "Ditampilkan setelah berhasil disimpan";
  document.getElementById("pembelianKwhMessage").textContent = "";
  document.getElementById("pembelianKwhResult").hidden = true;
}

function formatKwhPembelian(value) {
  return Number(value).toLocaleString("id-ID", { maximumFractionDigits: 2 });
}

function formatHargaModalKwh(value) {
  return "Rp" + Number(value).toLocaleString("id-ID", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

async function catatPembelianKwh() {
  const jenisKwh = document.getElementById("pembelianKwhJenis").value;
  const nominalInput = document.getElementById("pembelianKwhNominal").value.trim();
  const nominalMatch = nominalInput.match(/^(?:\d+|\d{1,3}(?:\.\d{3})+)$/);
  if (!nominalMatch) {
    document.getElementById("pembelianKwhMessage").textContent =
      "Nominal pembelian harus Rupiah integer non-negatif; gunakan angka bulat.";
    return;
  }
  const nominalPembelian = Number(nominalInput.replace(/\./g, ""));
  if (!Number.isSafeInteger(nominalPembelian) || nominalPembelian < 0) {
    document.getElementById("pembelianKwhMessage").textContent =
      "Nominal pembelian melebihi batas angka yang dapat disimpan.";
    return;
  }

  const kwhDidapat = document.getElementById("pembelianKwhDidapat").value.trim();
  const kwhMatch = kwhDidapat.match(/^(\d+)(?:[.,](\d{1,2}))?$/);
  if (!kwhMatch || (BigInt(kwhMatch[1]) === 0n && Number(kwhMatch[2] || 0) === 0)) {
    document.getElementById("pembelianKwhMessage").textContent =
      "KWh didapat harus lebih dari 0 dengan maksimal 2 angka desimal; gunakan titik atau koma.";
    return;
  }
  if (jenisKwh !== "DALAM" && jenisKwh !== "LUAR") {
    document.getElementById("pembelianKwhMessage").textContent = "Pilih jenis KWh Dalam atau KWh Luar.";
    return;
  }

  const payload = {
    jenis_kwh: jenisKwh,
    nominal_pembelian: nominalPembelian,
    kwh_didapat: kwhDidapat
  };
  const keterangan = document.getElementById("pembelianKwhKeterangan").value.trim();
  if (keterangan) payload.keterangan = keterangan;

  const button = document.getElementById("pembelianKwhSubmit");
  const message = document.getElementById("pembelianKwhMessage");
  button.disabled = true;
  button.textContent = "MENYIMPAN...";
  message.textContent = "";
  document.getElementById("pembelianKwhResult").hidden = true;

  try {
    const response = await authenticatedFetch("/api/pembelian-kwh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const result = await response.json();
    if (!response.ok || !result.success) {
      throw new Error(result.message || "Pembelian token KWh gagal dicatat.");
    }

    const typeNames = { DALAM: "KWh Dalam", LUAR: "KWh Luar" };
    const waktu = new Date(result.waktu);
    document.getElementById("pembelianKwhHarga").textContent =
      formatHargaModalKwh(result.harga_per_kwh);
    document.getElementById("pembelianKwhResultId").textContent = String(result.id);
    document.getElementById("pembelianKwhResultJenis").textContent =
      typeNames[result.jenis_kwh] || result.jenis_kwh;
    document.getElementById("pembelianKwhResultNominal").textContent =
      rupiah(result.nominal_pembelian);
    document.getElementById("pembelianKwhResultDidapat").textContent =
      `${formatKwhPembelian(result.kwh_didapat)} KWh`;
    document.getElementById("pembelianKwhResultHarga").textContent =
      `${formatHargaModalKwh(result.harga_per_kwh)} / KWh`;
    document.getElementById("pembelianKwhResultSisa").textContent =
      `${formatKwhPembelian(result.sisa_kwh)} KWh`;
    document.getElementById("pembelianKwhResultWaktu").textContent =
      Number.isNaN(waktu.getTime()) ? String(result.waktu) : waktu.toLocaleString("id-ID");
    document.getElementById("pembelianKwhResult").hidden = false;
    resetFormPembelianKwh();
  } catch (error) {
    message.textContent = error.message || "Pembelian token KWh gagal dicatat.";
  } finally {
    button.disabled = false;
    button.textContent = "SIMPAN NOTA PEMBELIAN";
  }
}


// ==================================================
// HITUNG TUTUP KASIR
// ==================================================

async function hitungTutupKasir() {
  if (pendingCloseLocked) return;
  if (prosesTutupKasirAktif) return;
  prosesTutupKasirAktif = true;
  const report = document.getElementById("closeReport");
  const button = document.getElementById("calculateCloseBtn");
  previewTutupKasir = null;
  report.classList.add("hidden");
  report.innerHTML = "";
  document.getElementById("lockedArea").classList.add("hidden");
  const status = document.createElement("div");
  status.className = "close-verification";
  status.textContent = "PEMERIKSAAN OTOMATIS: menyiapkan pemeriksaan data…";
  report.appendChild(status);
  report.classList.remove("hidden");
  button.disabled = true;
  button.classList.remove("hidden");
  button.textContent = "SEDANG MEMPROSES...";
  if (["actualCash"].some(id => document.getElementById(id).value === "")) {
    status.textContent = "Gagal: lengkapi Cash Sales.";
    prosesTutupKasirAktif = false; button.disabled = false; button.textContent = "LIHAT HASIL"; return;
  }
  const readInteger = id => Number(String(document.getElementById(id).value).replace(/[.,]/g, ""));
  const actual = readInteger("actualCash");
  if (!Number.isSafeInteger(actual) || actual < 0) {
    status.textContent = "Gagal: semua nilai penutupan wajib berupa bilangan bulat non-negatif yang aman.";
    prosesTutupKasirAktif = false; button.disabled = false; button.textContent = "LIHAT HASIL"; return;
  }
  if (!currentKasir || !currentKasir.shiftId) {
    status.textContent = "Gagal: shift kasir tidak ditemukan.";
    prosesTutupKasirAktif = false; button.disabled = false; button.textContent = "LIHAT HASIL"; return;
  }
  try {
    const response = await authenticatedFetch("/api/kasir/tutup-preview", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ shiftId: Number(currentKasir.shiftId), nominalAktual: actual })
    });
    const result = await response.json();
    if (!response.ok || !result.success) throw new Error(result.message || "Preview penutupan gagal dimuat.");
    if (result.shift && result.shift.status === "PENDING_CLOSE" && result.kode_tutup) {
      previewTutupKasir = result;
      pendingCloseLocked = true;
      const actualCashInput = document.getElementById("actualCash");
      if (window.setActualCashValue) window.setActualCashValue(String(result.rekonsiliasiKas.nominalAktual));
      actualCashInput.readOnly = true;
      actualCashInput.disabled = true;
      kunciInputTutupKasir();
    } else {
      throw new Error("Server tidak mengembalikan snapshot penutupan yang terkunci.");
    }
    const startedAt = Date.now();
    const checks = [
      ["Tahap 1 dari 6 — Identitas dan status shift", () => validasiTahapTutupKasir(1, result)],
      ["Tahap 2 dari 6 — Transaksi dan ringkasan penjualan", () => validasiTahapTutupKasir(2, result)],
      ["Tahap 3 dari 6 — Rekonsiliasi kas", () => validasiTahapTutupKasir(3, result)],
      ["Tahap 4 dari 6 — Data token KWh (info)", () => {}],
      ["Tahap 5 dari 6 — Performa meja, sesi, dan produk", () => validasiTahapTutupKasir(5, result)],
      ["Tahap 6 dari 6 — Pemeriksaan silang akhir", () => { validasiTahapTutupKasir(6, result); validasiHasilTutupKasir(result); }]
    ];
    for (let i = 0; i < checks.length; i++) {
      checks[i][1]();
      const stageEnd = Date.now() + 10000;
      status.innerHTML = `<strong>${checks[i][0]}</strong><div class="close-check-progress"><span style="width:${Math.round(i / 6 * 100)}%"></span></div><div class="close-check-countdown">Sisa pemeriksaan: <b>60</b> detik</div><div>${i + 1} / 6 tahap tervalidasi</div>`;
      await new Promise((resolve, reject) => {
        const tick = () => {
          if (!report.isConnected || !prosesTutupKasirAktif) { clearInterval(timerTutupKasir); timerTutupKasir = null; reject(new Error("Pemeriksaan dibatalkan.")); return; }
          const stageRemaining = Math.max(0, Math.ceil((stageEnd - Date.now()) / 1000));
          const totalRemaining = Math.max(0, Math.ceil((startedAt + 60000 - Date.now()) / 1000));
          const count = status.querySelector(".close-check-countdown b");
          if (count) count.textContent = String(Math.max(stageRemaining, totalRemaining));
          const bar = status.querySelector(".close-check-progress span");
          if (bar) bar.style.width = `${Math.min(100, ((i + 1 - stageRemaining / 10) / 6) * 100)}%`;
          if (!stageRemaining) { clearInterval(timerTutupKasir); timerTutupKasir = null; resolve(); }
        };
        tick(); timerTutupKasir = setInterval(tick, 250);
      });
    }
    if (Date.now() - startedAt < 60000) await new Promise(resolve => setTimeout(resolve, 60000 - (Date.now() - startedAt)));
    validasiHasilTutupKasir(result);
    previewTutupKasir = result;
    status.remove();
    renderLaporanTutupKasir(result);
    tampilkanTombolCetakLaporan(report);
    ["actualCash"].forEach(id => { document.getElementById(id).disabled = true; });
    document.getElementById("lockedArea").classList.add("hidden");
    document.getElementById("closeReport").classList.remove("hidden");
  } catch (error) {
    if (timerTutupKasir) { clearInterval(timerTutupKasir); timerTutupKasir = null; }
    if (pendingCloseLocked && previewTutupKasir) {
      renderLaporanTutupKasir(previewTutupKasir);
      report.classList.remove("hidden");
      document.getElementById("lockedArea").classList.add("hidden");
    } else {
      previewTutupKasir = null;
      report.innerHTML = "";
    }
    const errorStatus = document.createElement("div");
    errorStatus.className = "close-verification";
    errorStatus.textContent = "Pemeriksaan otomatis gagal. Laporan tidak dibuka: " + error.message;
    report.appendChild(errorStatus);
    if (!pendingCloseLocked || !previewTutupKasir) {
      const closeButton = document.createElement("button");
      closeButton.type = "button";
      closeButton.className = "confirm-close-btn";
      closeButton.textContent = "CLOSE";
      closeButton.onclick = () => {
        report.classList.add("hidden");
        report.innerHTML = "";
        document.getElementById("closeModal").classList.add("hidden");
        document.getElementById("lockedArea").classList.remove("hidden");
        button.disabled = false;
        button.classList.remove("hidden");
        button.textContent = "LIHAT HASIL";
      };
      report.appendChild(closeButton);
    }
  } finally {
    prosesTutupKasirAktif = false;
    button.disabled = pendingCloseLocked;
    button.textContent = pendingCloseLocked ? "PREVIEW TERKUNCI" : "LIHAT HASIL";
    if (pendingCloseLocked) button.classList.add("hidden");
  }
}

function isValidClosingTransactionMethod(tx, method, cashAmount, qrisAmount) {
  if (method === "GRATIS") {
    return tx.total === 0 &&
      cashAmount === 0 &&
      qrisAmount === 0 &&
      String(tx.tipe_transaksi || "") === "PENJUALAN";
  }
  return ["CASH", "QRIS", "CASH+QRIS"].includes(method);
}

function nilaiPenjualanCash(tx, method, cashAmount) {
  return method === "CASH" && String(tx.tipe_transaksi || "PENJUALAN") === "PENJUALAN"
    ? Number(tx.total || 0)
    : cashAmount;
}

function nilaiPenjualanQris(tx, method, qrisAmount) {
  return method === "QRIS" && String(tx.tipe_transaksi || "PENJUALAN") === "PENJUALAN"
    ? Number(tx.total || 0)
    : qrisAmount;
}

function validasiTahapTutupKasir(tahap, data) {
  const fail = message => { throw new Error(message); };
  const finite = value => typeof value === "number" && Number.isFinite(value);
  const valid = value => finite(value) && value >= 0;
  const near = (a, b) => Math.abs(a - b) <= 0.01;
  const shift = data && data.shift, sales = data && data.ringkasanPenjualan, rec = data && data.rekonsiliasiKas;
  if (tahap === 1) {
    if (!currentKasir || !Number.isSafeInteger(Number(currentKasir.shiftId)) || !shift || Number(shift.shiftId) !== Number(currentKasir.shiftId)) fail("Identitas shift preview tidak sama dengan shift kasir yang sedang ditutup.");
    if (!["OPEN", "PENDING_CLOSE"].includes(String(shift.status || "").toUpperCase())) fail("Status shift bukan OPEN atau PENDING_CLOSE.");
    if (!String(shift.kasir || "").trim() || !Number.isFinite(new Date(shift.buka_at).getTime())) fail("Identitas kasir atau waktu buka shift tidak valid.");
    if (![shift.saldo_awal, shift.saldo_kwh_dalam_awal, shift.saldo_kwh_luar_awal].every(valid)) fail("Saldo awal shift tidak lengkap atau tidak valid.");
  }
  if (tahap === 2) {
    if (!sales || !Array.isArray(data.transaksi)) fail("Rincian transaksi atau ringkasan penjualan tidak tersedia.");
    if (![sales.jumlahTransaksi, sales.jumlahTransaksiCash, sales.jumlahTransaksiQris].every(n => Number.isSafeInteger(n) && n >= 0) || ![sales.totalPenjualan, sales.totalCash, sales.totalQris, sales.nominalAktual].every(valid)) fail("Jumlah atau total transaksi tidak valid.");
    if (sales.jumlahTransaksi !== data.transaksi.length || sales.jumlahTransaksiCash > sales.jumlahTransaksi || sales.jumlahTransaksiQris > sales.jumlahTransaksi) fail("Jumlah transaksi tidak konsisten.");
    let total = 0, cash = 0, qris = 0, cashCount = 0, qrisCount = 0, tarikTunaiCount = 0, tarikTunaiTotal = 0;
    data.transaksi.forEach(tx => {
      if (!tx || !valid(tx.total) || !Array.isArray(tx.detail_produk) || ["BATAL", "CANCELLED"].includes(String(tx.status_sync || "").toUpperCase())) fail("Ada transaksi batal atau detail transaksi tidak valid di laporan aktif.");
      const method = String(tx.metode_pembayaran || "").toUpperCase();
      const cashAmount = Number(tx.cash_amount || 0), qrisAmount = Number(tx.qris_amount || 0);
      if (!valid(cashAmount) || !Number.isSafeInteger(cashAmount) || !valid(qrisAmount) || !Number.isSafeInteger(qrisAmount)) fail("Rincian nominal CASH/QRIS transaksi tidak valid.");
      if (!isValidClosingTransactionMethod(tx, method, cashAmount, qrisAmount)) fail("Metode pembayaran transaksi tidak dikenal atau nominal GRATIS tidak valid.");
      const cashValue = nilaiPenjualanCash(tx, method, cashAmount);
      const qrisValue = nilaiPenjualanQris(tx, method, qrisAmount);
      cash += cashValue;
      qris += qrisValue;
      if (cashValue > 0) cashCount++;
      if (qrisValue > 0) qrisCount++;
      const type = String(tx.tipe_transaksi || "PENJUALAN");
      if (type === "TARIK_TUNAI") {
        const amount = Number(tx.nominal_tarik_tunai ?? qrisAmount);
        if (method !== "QRIS" || cashAmount !== 0 || qrisAmount <= 0 || amount !== qrisAmount || !tx.kode_setoran || tx.detail_produk.length !== 0) fail("Data Tarik Tunai pada laporan tidak konsisten.");
        tarikTunaiCount++;
        tarikTunaiTotal += amount;
      } else if (type !== "PENJUALAN") fail("Tipe transaksi pada laporan tidak dikenal.");
      tx.detail_produk.forEach(item => { if (!item || !String(item.nama_barang || "").trim() || !valid(item.qty) || !valid(item.subtotal)) fail("Detail produk transaksi tidak lengkap atau tidak valid."); });
    });
    total = cash + qris;
    if (cashCount !== sales.jumlahTransaksiCash || qrisCount !== sales.jumlahTransaksiQris || !near(cash, sales.totalCash) || !near(qris, sales.totalQris) || !near(total, sales.totalPenjualan)) fail("Rincian transaksi berbeda dari ringkasan penjualan.");
    if (Number(sales.jumlahTarikTunai || 0) !== tarikTunaiCount || Number(sales.totalTarikTunai || 0) !== tarikTunaiTotal) fail("Rincian Tarik Tunai berbeda dari ringkasan closing.");
    if (!near(sales.nominalAktual, Number(String(document.getElementById("actualCash").value).replace(/[.,]/g, ""))) || !near(data.selisihPenjualan, sales.nominalAktual - sales.totalCash)) fail("Selisih penjualan tidak konsisten dengan Cash Penjualan dan Cash Sales.");
    if (data.jumlahTransaksiBatal != null && (!Number.isSafeInteger(data.jumlahTransaksiBatal) || data.jumlahTransaksiBatal < 0)) fail("Metadata transaksi batal tidak valid.");
  }
  if (tahap === 3) {
    if (!rec || !valid(shift && shift.saldo_awal) || !valid(sales && sales.totalCash)) fail("Data rekonsiliasi kas tidak lengkap.");
    if (!data.kas || !valid(data.kas.masuk) || !valid(data.kas.keluar)) fail("Total kas masuk atau kas keluar tidak valid.");
    if (![rec.uangSeharusnya, rec.nominalAktual].every(valid) || !finite(rec.selisih)) fail("Nilai rekonsiliasi kas tidak valid.");
    // Saldo Kas Akhir (uangSeharusnya) kini bersumber dari Kas Laci resmi,
    // bukan dari shift.saldo_awal + kas_masuk + totalCash - kas_keluar.
    const saldoAkharLaci = data.kasLaci ? data.kasLaci.saldoAkhir : null;
    if (saldoAkharLaci !== null && !near(rec.uangSeharusnya, saldoAkharLaci)) fail("Rekonsiliasi kas tidak sesuai saldo Kas Laci resmi.");
    if (!near(rec.nominalAktual, Number(String(document.getElementById("actualCash").value).replace(/[.,]/g, ""))) || !near(rec.selisih, rec.nominalAktual - rec.uangSeharusnya)) fail("Rekonsiliasi kas tidak konsisten secara matematis atau dengan input.");
  }
  if (tahap === 5) {
    if (!Array.isArray(data.performaMeja) || data.performaMeja.length !== 10 || !Array.isArray(data.rekapProduk)) fail("Data performa meja atau rekap produk tidak lengkap.");
    const tables = new Map(), sessions = new Set(), products = new Map();
    data.performaMeja.forEach(row => {
      const no = Number(row && row.nomor_meja);
      if (!Number.isInteger(no) || no < 1 || no > 10 || tables.has(no) || ![row.jumlah_sesi, row.total_durasi_jam, row.omzet].every(valid)) fail("Daftar performa harus berisi tepat 10 meja dengan nilai valid.");
      tables.set(no, row);
    });
    const tableSales = new Map();
    data.transaksi.forEach(tx => {
      if (tx.nomor_meja != null) { const no = Number(tx.nomor_meja); if (!tables.has(no)) fail("Detail transaksi merujuk meja di luar 1–10."); tableSales.set(no, (tableSales.get(no) || 0) + tx.total); }
      if (tx.session_id) sessions.add(`${tx.nomor_meja}:${tx.session_id}`);
      tx.detail_produk.forEach(item => {
        if (["meja billiard", "meja pagi", "meja malam"].includes(String(item.nama_barang).trim().toLowerCase())) return;
        const p = products.get(item.nama_barang) || { qty: 0, subtotal: 0 }; p.qty += item.qty; p.subtotal += item.subtotal; products.set(item.nama_barang, p);
      });
    });
    for (const [no, row] of tables) if (!near(row.omzet, tableSales.get(no) || 0)) fail(`Omzet meja ${no} tidak sama dengan detail transaksi.`);
    for (const key of sessions) { const no = Number(key.split(":")[0]); if (tables.get(no).jumlah_sesi < 1) fail(`Sesi meja ${no} tidak tercermin pada jumlah sesi.`); }
    const reported = new Map();
    data.rekapProduk.forEach(p => { if (!p || !String(p.nama_barang || "").trim() || !valid(p.qty) || !valid(p.subtotal) || reported.has(p.nama_barang)) fail("Baris rekap produk tidak valid atau duplikat."); reported.set(p.nama_barang, p); });
    for (const [name, sums] of products) { const p = reported.get(name); if (!p || !near(p.qty, sums.qty) || !near(p.subtotal, sums.subtotal)) fail(`Rekap produk tidak cocok dengan transaksi: ${name}.`); }
  }
  if (tahap === 6) {
    if (!data.generatedAt || !Number.isFinite(new Date(data.generatedAt).getTime())) fail("Waktu pembuatan preview tidak valid.");
    if (!data.shift || !data.ringkasanPenjualan || !data.rekonsiliasiKas || !data.kwh || !Array.isArray(data.performaMeja) || !Array.isArray(data.rekapProduk) || !Array.isArray(data.transaksi)) fail("Ada bagian wajib laporan yang hilang.");
    if (Number(data.shift.shiftId) !== Number(currentKasir && currentKasir.shiftId)) fail("Shift pada pemeriksaan silang akhir tidak cocok.");
    if (typeof data.selisihPenjualan !== "number" || !Number.isFinite(data.selisihPenjualan)) fail("Selisih penjualan tidak valid.");
  }
}

function escapeCloseHtml(value) {
  return String(value == null ? "—" : value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[char]));
}

function tampilkanTombolCetakLaporan(report) {
  const button = report.querySelector("#printCloseReportBtn");
  if (button) button.classList.remove("hidden");
}

let dataLaporanTutupKasirUntukCetak = null;

function buatTeksLaporanTutupKasir(data) {
  const width = 32;
  const lines = [];
  const addLine = value => {
    const text = String(value == null ? "—" : value).replace(/[\r\n\t]/g, " ").trim();
    if (!text) { lines.push(""); return; }
    let remaining = text;
    while (remaining.length > width) {
      let splitAt = remaining.lastIndexOf(" ", width);
      if (splitAt <= 0) splitAt = width;
      lines.push(remaining.slice(0, splitAt));
      remaining = remaining.slice(splitAt).trim();
    }
    if (remaining) lines.push(remaining);
  };
  const addCenter = value => {
    const text = String(value);
    if (text.length > width) { addLine(text); return; }
    const left = Math.floor((width - text.length) / 2);
    lines.push(`${" ".repeat(left)}${text}`);
  };
  const separator = () => lines.push("=".repeat(width));
  const section = title => { lines.push(""); separator(); addCenter(title); separator(); };
  const labelValue = (label, value) => {
    const labelAliases = {
      "Cash Penjualan": ["Penjualan Cash", "Cash"],
      "Cash Sales": ["Cash"],
      "Total Penjualan": ["Total Jual", "Total"],
      "Jumlah transaksi": ["Jml Transaksi", "Transaksi"],
      "Saldo Kas Awal (Kas Laci)": ["Saldo Awal", "Kas Awal", "Saldo Kas Awal"],
      "Saldo Kas Akhir (Kas Laci)": ["Saldo Seharusnya", "Saldo Akhir", "Saldo Kas Akhir"],
      "Kas Masuk (info)": ["Masuk", "Kas Masuk"],
      "Kas Keluar (info)": ["Keluar", "Kas Keluar"],
      "Selisih Penjualan": ["Selisih Jual", "Selisih"],
      "Uang Kas Aktual / Laci": ["Kas Aktual / Laci"],
      "Cash Sales Aktual": ["Cash Sales", "Sales Aktual"]
    };
    const rawLabel = String(label == null ? "—" : label).replace(/[\r\n\t]/g, " ").replace(/\s+/g, " ").trim();
    const valueText = String(value == null ? "—" : value).replace(/[\r\n\t]/g, " ").replace(/\s+/g, " ").trim();
    const availableLabelWidth = Math.max(0, width - valueText.length - 1);
    const candidates = [rawLabel, ...(labelAliases[rawLabel] || [])];
    let labelText = candidates.find(candidate => candidate.length <= availableLabelWidth);
    if (labelText === undefined) {
      labelText = rawLabel;
      while (labelText.length > availableLabelWidth && labelText.includes(" ")) {
        labelText = labelText.slice(labelText.indexOf(" ") + 1);
      }
      if (labelText.length > availableLabelWidth) {
        labelText = labelText.slice(0, availableLabelWidth);
      }
    }
    const padding = width - labelText.length - valueText.length;
    lines.push(`${labelText}${" ".repeat(Math.max(1, padding))}${valueText}`);
  };
  const money = value => {
    const amount = Number(value || 0);
    return amount < 0 ? `-Rp${Math.abs(amount).toLocaleString("id-ID")}` : rupiah(amount);
  };
  const dateTime = value => {
    if (!value) return "—";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString("id-ID");
  };
  const dateOnly = value => {
    if (!value) return "—";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleDateString("id-ID", { day: "2-digit", month: "2-digit", year: "numeric" });
  };
  const shift = data.shift || {};
  const sales = data.ringkasanPenjualan || {};
  const rec = data.rekonsiliasiKas || {};
  const tables = Array.from({ length: 10 }, (_, index) =>
    (data.performaMeja || []).find(item => Number(item.nomor_meja) === index + 1) ||
    { nomor_meja: index + 1, jumlah_sesi: 0, total_durasi_jam: 0, omzet: 0 }
  );
  const transactions = data.transaksi || [];

  addCenter("LAPORAN TUTUP KASIR");
  addCenter(dateTime(data.generatedAt));
  section("IDENTITAS SHIFT");
  labelValue("Kasir", shift.kasir || currentKasir?.nama || "Kasir");
  labelValue("Shift ID", shift.shiftId ?? currentKasir?.shiftId ?? "—");
  labelValue("Status", shift.status || "OPEN");
  labelValue("Tanggal", dateOnly(shift.buka_at));
  labelValue("Kode tutup", data.kode_tutup || "Akan dibuat setelah tutup berhasil");

  section("RINGKASAN PENJUALAN");
  labelValue("Cash Penjualan", money(sales.totalCash));
  labelValue("QRIS", money(sales.totalQris));
  labelValue("Jumlah Tarik Tunai", Number(sales.jumlahTarikTunai || 0));
  labelValue("Total Nominal Tarik Tunai", money(sales.totalTarikTunai));
  labelValue("Cash Sales", money(sales.nominalAktual));
  labelValue("Total Penjualan", money(sales.totalPenjualan));
  labelValue("Jumlah transaksi", sales.jumlahTransaksi || 0);
  const salesDifference = Number(data.selisihPenjualan || 0);
  labelValue("Selisih Penjualan", `${salesDifference < 0 ? "MINUS" : salesDifference > 0 ? "PLUS" : "SESUAI"} ${money(salesDifference)}`);

  section("PERFORMA MEJA 1-10");
  tables.forEach(row => {
    const label = `Meja ${String(row.nomor_meja).padStart(2, "0")}`;
    const duration = `${Number(row.total_durasi_jam || 0)} jam`;
    const omzet = money(row.omzet);
    labelValue(label, `${duration} ${omzet}`);
  });

  section("PENJUALAN PER KATEGORI");
  const categorySales = { BAR: 0, DAPUR: 0, KASIR: 0 };
  transactions.forEach(tx => {
    (tx.detail_produk || []).forEach(item => {
      if (["meja billiard", "meja pagi", "meja malam"].includes(String(item.nama_barang || "").trim().toLowerCase())) return;
      const master = Array.isArray(masterBarang)
        ? masterBarang.find(product =>
            String(product.nama || "").trim().toLowerCase() ===
            String(item.nama_barang || "").trim().toLowerCase()
          )
        : null;
      const category = String(master?.kategori || "").trim().toUpperCase();
      const bucket = category === "BAR" || category === "DAPUR" ? category : "KASIR";
      categorySales[bucket] += Number(item.subtotal || 0);
    });
  });
  labelValue("BAR", money(categorySales.BAR));
  labelValue("DAPUR", money(categorySales.DAPUR));
  labelValue("KASIR", money(categorySales.KASIR));
  addLine("-".repeat(width));
  labelValue("TOTAL", money(categorySales.BAR + categorySales.DAPUR + categorySales.KASIR));

  section("REKAP SALDO KAS");
  const laci = data.kasLaci || {};
  labelValue("Saldo Kas Awal (Kas Laci)", money(laci.saldoAwal ?? shift.saldo_awal));
  labelValue("Kas Masuk (info)", money(data.kas?.masuk));
  labelValue("Kas Keluar (info)", money(data.kas?.keluar));
  labelValue("Saldo Kas Akhir (Kas Laci)", money(laci.saldoAkhir ?? rec.uangSeharusnya));
  labelValue("Cash Sales Aktual", money(rec.nominalAktual));
  labelValue("Selisih Kas", money(rec.selisih));

  lines.push("", "", "");
  return lines.join("\n");
}

async function cetakLaporanTutupKasir() {
  if (!dataLaporanTutupKasirUntukCetak) {
    alert("Laporan Tutup Kasir belum tersedia untuk dicetak.");
    return;
  }
  try {
    const teks = buatTeksLaporanTutupKasir(dataLaporanTutupKasirUntukCetak);
    const hasil = await cetakStrukBluetooth(teks);
    if (!hasil || hasil.success !== true) {
      alert(`Gagal mencetak laporan ke printer KASIR: ${(hasil && hasil.message) || "printer tidak mengonfirmasi keberhasilan cetak."}`);
    }
  } catch (error) {
    alert(`Gagal mencetak laporan ke printer KASIR: ${error && error.message ? error.message : error}`);
  }
}

function renderLaporanTutupKasir(data) {
  dataLaporanTutupKasirUntukCetak = data;
  const shift = data.shift || {}, sales = data.ringkasanPenjualan || {}, rec = data.rekonsiliasiKas || {};
  const tables = Array.from({ length: 10 }, (_, index) => (data.performaMeja || []).find(item => Number(item.nomor_meja) === index + 1) || { nomor_meja: index + 1, jumlah_sesi: 0, total_durasi_jam: 0, omzet: 0 });
  const products = (data.rekapProduk || []).filter(item => !["meja billiard", "meja pagi", "meja malam"].includes(String(item.nama_barang || "").trim().toLowerCase()));
  const txs = data.transaksi || [];
  const salesDifference = data.selisihPenjualan;
  const salesDifferenceClass = salesDifference < 0 ? "sales-difference-negative" : salesDifference > 0 ? "sales-difference-positive" : "";
  const shiftEndAt =
    (shift.status === "PENDING_CLOSE" && shift.pending_close_at)
      ? new Date(shift.pending_close_at).getTime()
      : (shift.status === "CLOSED" && shift.tutup_at)
        ? new Date(shift.tutup_at).getTime()
        : Date.now();
  const elapsed = shift.buka_at ? Math.max(0, shiftEndAt - new Date(shift.buka_at).getTime()) : 0;
  const duration = shift.buka_at && Number.isFinite(elapsed) ? `${Math.floor(elapsed / 3600000)} jam ${Math.floor((elapsed % 3600000) / 60000)} menit` : "—";
  const dateTime = value => { if (!value) return "—"; const date = new Date(value); return Number.isNaN(date.getTime()) ? escapeCloseHtml(value) : date.toLocaleString("id-ID"); };
  const money = value => rupiah(Number(value || 0));
  const salesDifferenceAmount = salesDifference < 0 ? `-Rp${Math.abs(salesDifference).toLocaleString("id-ID")}` : money(salesDifference);
  document.getElementById("closeReport").innerHTML = `
    <div class="close-report">
      <section class="close-section"><h3>Header Shift</h3><div class="close-shift"><strong>${escapeCloseHtml(shift.kasir || currentKasir?.nama || "Kasir")}</strong><span>Shift ID: ${escapeCloseHtml(shift.shiftId ?? currentKasir?.shiftId)}</span><span>Buka: ${dateTime(shift.buka_at)}</span><span class="close-badge">${escapeCloseHtml(shift.status || "OPEN")}</span><span>Durasi: ${duration}</span>${data.kode_tutup ? `<span class="close-code"><strong>Kode Unik Tutup:</strong> ${escapeCloseHtml(data.kode_tutup)}</span>` : String(shift.status || "").toUpperCase() === "OPEN" ? `<span class="close-code"><strong>Kode Unik Tutup:</strong> Akan dibuat setelah tutup berhasil</span>` : ""}</div></section>
      <section class="close-section"><h3>Ringkasan Penjualan</h3><div class="close-kpis"><div class="close-kpi"><span>Cash Penjualan</span><strong>${money(sales.totalCash)}</strong></div><div class="close-kpi"><span>QRIS</span><strong>${money(sales.totalQris)}</strong></div><div class="close-kpi"><span>Jumlah Tarik Tunai</span><strong>${Number(sales.jumlahTarikTunai || 0)}</strong></div><div class="close-kpi"><span>Total Nominal Tarik Tunai</span><strong>${money(sales.totalTarikTunai)}</strong></div><div class="close-kpi"><span>Cash Sales</span><strong>${money(sales.nominalAktual)}</strong></div></div><div class="close-kpis"><div class="close-kpi"><span>Total Transaksi</span><strong>${Number(sales.jumlahTransaksi || 0)}</strong></div><div class="close-kpi"><span>Jumlah Transaksi Cash Penjualan</span><strong>${Number(sales.jumlahTransaksiCash || 0)}</strong></div><div class="close-kpi"><span>Total QRIS</span><strong>${Number(sales.jumlahTransaksiQris || 0)}</strong></div></div></section>
      <section class="close-section"><h3>Selisih Penjualan</h3><div class="close-difference ${salesDifferenceClass}">${salesDifference < 0 ? "MINUS" : salesDifference > 0 ? "PLUS" : "SESUAI"} ${salesDifferenceAmount}</div></section>
      <section class="close-section"><h3>Performa 10 Meja</h3><div class="close-table-wrap"><table class="close-table"><thead><tr><th>Meja</th><th class="num">Jumlah sesi</th><th class="num">Durasi (jam)</th><th class="num">Omzet</th></tr></thead><tbody>${tables.map(row => `<tr><td>Meja ${escapeCloseHtml(row.nomor_meja)}</td><td class="num">${Number(row.jumlah_sesi || 0)}</td><td class="num">${Number(row.total_durasi_jam || 0)}</td><td class="num">${money(row.omzet)}</td></tr>`).join("")}</tbody></table></div></section>
      <section class="close-section"><h3>Rekap Produk</h3><div class="close-table-wrap"><table class="close-table"><thead><tr><th>Produk</th><th class="num">Qty</th><th class="num">Harga jual</th><th class="num">Subtotal</th></tr></thead><tbody>${products.length ? products.map(item => `<tr><td>${escapeCloseHtml(item.nama_barang)}</td><td class="num">${Number(item.qty || 0)}</td><td class="num">${item.harga_jual == null ? "Bervariasi" : money(item.harga_jual)}</td><td class="num">${money(item.subtotal)}</td></tr>`).join("") : `<tr><td colspan="4">Belum ada penjualan produk.</td></tr>`}</tbody></table></div></section>
      <section class="close-section"><h3>Detail Transaksi (${txs.length})</h3><div class="close-table-wrap"><table class="close-table"><thead><tr><th>No. transaksi / detail</th><th>Waktu</th><th>Meja</th><th>Session</th><th class="num">Total</th><th>Metode</th></tr></thead><tbody>${txs.length ? txs.map(tx => { const isTarikTunai = tx.tipe_transaksi === "TARIK_TUNAI"; return `<tr><td><strong>${escapeCloseHtml(tx.nomor_transaksi)}</strong>${isTarikTunai ? `<div class="close-tx-detail"><strong>TARIK TUNAI</strong> &bull; Setoran ${escapeCloseHtml(tx.kode_setoran)}</div>` : `<div class="close-tx-detail">${(tx.detail_produk || []).map(item => `${escapeCloseHtml(item.nama_barang)} × ${Number(item.qty || 0)} (${money(item.subtotal)})`).join("<br>") || "—"}</div>`}</td><td>${dateTime(tx.waktu || [tx.tanggal, tx.jam].filter(Boolean).join(" "))}</td><td>${tx.nomor_meja ? `Meja ${escapeCloseHtml(tx.nomor_meja)}` : "—"}</td><td>${escapeCloseHtml(tx.session_id)}</td><td class="num">${money(isTarikTunai ? tx.nominal_tarik_tunai : tx.total)}</td><td>${isTarikTunai ? "TARIK TUNAI &bull; QRIS" : escapeCloseHtml(tx.metode_pembayaran)}</td></tr>`; }).join("") : `<tr><td colspan="6">Belum ada transaksi.</td></tr>`}</tbody></table></div></section>
      <section class="close-section"><h3>Rekap Saldo Kas</h3><div class="close-kpis"><div class="close-kpi"><span>Saldo Kas Awal (Kas Laci)</span><strong>${money(data.kasLaci?.saldoAwal ?? shift.saldo_awal)}</strong></div><div class="close-kpi"><span>Kas Masuk (info)</span><strong>${money(data.kas?.masuk)}</strong></div><div class="close-kpi"><span>Kas Keluar (info)</span><strong>${money(data.kas?.keluar)}</strong></div><div class="close-kpi"><span>Saldo Kas Akhir (Kas Laci)</span><strong>${money(data.kasLaci?.saldoAkhir ?? rec.uangSeharusnya)}</strong></div></div></section>
      <section class="close-section close-actions-section"><div class="close-actions"><button class="confirm-close-btn close-confirm-btn" id="confirmCloseBtn" onclick="konfirmasiTutupKasir()">KONFIRMASI TUTUP KASIR</button></div></section>
    </div>
    <button type="button" id="printCloseReportBtn" class="close-print-btn hidden" onclick="cetakLaporanTutupKasir()">CETAK LAPORAN</button>`;
}

function validasiHasilTutupKasir(data) {
  const fail = message => { throw new Error(message); };
  const isNum = value => typeof value === "number" && Number.isFinite(value) && value >= 0;
  const reqNums = (obj, fields, label) => fields.forEach(field => {
    if (!obj || !isNum(obj[field])) fail(`${label}: nilai ${field} tidak valid.`);
  });
  const shift = data.shift, sales = data.ringkasanPenjualan, rec = data.rekonsiliasiKas;
  if (!shift || !shift.shiftId || !["OPEN", "PENDING_CLOSE"].includes(String(shift.status || "").toUpperCase())) fail("Shift tidak tersedia atau status shift bukan OPEN/PENDING_CLOSE.");
  reqNums(shift, ["saldo_awal"], "Shift");
  if (!sales) fail("Ringkasan transaksi tidak tersedia.");
  reqNums(sales, ["jumlahTransaksi", "totalPenjualan", "totalCash", "totalQris", "nominalAktual", "jumlahTransaksiCash", "jumlahTransaksiQris"], "Ringkasan transaksi");
  for (const key of ["jumlahTransaksi", "jumlahTransaksiCash", "jumlahTransaksiQris"]) if (!Number.isSafeInteger(sales[key])) fail(`Ringkasan transaksi: ${key} bukan bilangan bulat.`);
  if (sales.jumlahTarikTunai != null && (!Number.isSafeInteger(sales.jumlahTarikTunai) || sales.jumlahTarikTunai < 0)) fail("Jumlah Tarik Tunai tidak valid.");
  if (sales.totalTarikTunai != null && !isNum(sales.totalTarikTunai)) fail("Total Tarik Tunai tidak valid.");
  if (sales.jumlahTransaksiCash > sales.jumlahTransaksi || sales.jumlahTransaksiQris > sales.jumlahTransaksi) fail("Jumlah transaksi cash atau QRIS tidak konsisten.");
  if (!rec) fail("Rekonsiliasi kas tidak tersedia.");
  reqNums(rec, ["uangSeharusnya", "nominalAktual"], "Rekonsiliasi kas");
  if (typeof rec.selisih !== "number" || !Number.isFinite(rec.selisih) || Math.abs(rec.selisih) > Number.MAX_SAFE_INTEGER) fail("Rekonsiliasi kas: selisih tidak valid.");
  if (Math.abs(rec.nominalAktual - Number(String(document.getElementById("actualCash").value).replace(/[.,]/g, ""))) > 0.01) fail("Nilai Cash Sales Aktual tidak sesuai input.");
  for (const side of ["dalam", "luar"]) {
    const meter = data.kwh && data.kwh[side];
    if (!meter) fail(`KWh ${side} tidak tersedia.`);
    reqNums(meter, ["awal", "akhir", "penggunaan"], `KWh ${side}`);
    if (Math.abs(meter.penggunaan - (meter.awal - meter.akhir)) > 0.01) fail(`Penggunaan KWh ${side} tidak konsisten.`);
  }
  if (!Array.isArray(data.performaMeja) || data.performaMeja.length !== 10) fail("Performa meja harus memuat tepat 10 meja.");
  const tableIds = new Set();
  data.performaMeja.forEach(row => {
    if (!row || !Number.isInteger(Number(row.nomor_meja)) || Number(row.nomor_meja) < 1 || Number(row.nomor_meja) > 10 || tableIds.has(Number(row.nomor_meja))) fail("Daftar performa meja tidak valid.");
    tableIds.add(Number(row.nomor_meja)); reqNums(row, ["jumlah_sesi", "total_durasi_jam", "omzet"], "Performa meja");
  });
  if (tableIds.size !== 10) fail("Performa meja tidak lengkap.");
  if (!Array.isArray(data.rekapProduk) || data.rekapProduk.some(row => !row || typeof row !== "object")) fail("Rekap produk tidak tersedia atau tidak valid.");
  data.rekapProduk.forEach(row => reqNums(row, ["qty", "subtotal"], "Rekap produk"));
  if (!Array.isArray(data.transaksi) || data.transaksi.length !== sales.jumlahTransaksi) fail("Detail transaksi tidak tersedia atau jumlahnya tidak sesuai ringkasan.");
  let cashCount = 0, qrisCount = 0, cashTotal = 0, qrisTotal = 0, tarikTunaiCount = 0, tarikTunaiTotal = 0;
  data.transaksi.forEach(tx => {
    if (!tx || !isNum(tx.total) || !Array.isArray(tx.detail_produk)) fail("Detail transaksi tidak valid.");
    const method = String(tx.metode_pembayaran || "").toUpperCase();
    const cashAmount = Number(tx.cash_amount || 0), qrisAmount = Number(tx.qris_amount || 0);
    if (!isNum(cashAmount) || !Number.isSafeInteger(cashAmount) || !isNum(qrisAmount) || !Number.isSafeInteger(qrisAmount)) fail("Nominal CASH/QRIS transaksi tidak valid.");
    if (!isValidClosingTransactionMethod(tx, method, cashAmount, qrisAmount)) fail("Metode pembayaran transaksi bukan CASH/QRIS atau nominal GRATIS tidak valid.");
    const cashValue = nilaiPenjualanCash(tx, method, cashAmount);
    const qrisValue = nilaiPenjualanQris(tx, method, qrisAmount);
    cashTotal += cashValue;
    qrisTotal += qrisValue;
    if (cashValue > 0) cashCount++;
    if (qrisValue > 0) qrisCount++;
    const type = String(tx.tipe_transaksi || "PENJUALAN");
    if (type === "TARIK_TUNAI") {
      const amount = Number(tx.nominal_tarik_tunai ?? qrisAmount);
      if (method !== "QRIS" || cashAmount !== 0 || qrisAmount <= 0 || amount !== qrisAmount || !tx.kode_setoran || tx.detail_produk.length !== 0) fail("Data Tarik Tunai pada closing tidak konsisten.");
      tarikTunaiCount++;
      tarikTunaiTotal += amount;
    } else if (type !== "PENJUALAN") fail("Tipe transaksi closing tidak dikenal.");
    tx.detail_produk.forEach(item => { if (!item || !isNum(item.qty) || !isNum(item.subtotal)) fail("Detail produk transaksi tidak valid."); });
  });
  if (cashCount !== sales.jumlahTransaksiCash || qrisCount !== sales.jumlahTransaksiQris || Math.abs(cashTotal - sales.totalCash) > 0.01 || Math.abs(qrisTotal - sales.totalQris) > 0.01 || Math.abs(cashTotal + qrisTotal - sales.totalPenjualan) > 0.01) fail("Jumlah atau total transaksi cash/QRIS tidak cocok dengan ringkasan.");
  if (Number(sales.jumlahTarikTunai || 0) !== tarikTunaiCount || Number(sales.totalTarikTunai || 0) !== tarikTunaiTotal) fail("Jumlah atau nominal Tarik Tunai tidak cocok dengan rincian closing.");
}

async function konfirmasiTutupKasir() {
  if (!pendingCloseLocked || !previewTutupKasir || !document.getElementById("closeReport").querySelector("#confirmCloseBtn")) return;
  const button = document.getElementById("confirmCloseBtn");
  button.disabled = true; button.textContent = "MENUTUP SHIFT...";
  try {
    const response = await authenticatedFetch("/api/kasir/tutup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ shiftId: Number(currentKasir.shiftId), kode_tutup: previewTutupKasir.kode_tutup }) });
    const result = await response.json();
    if (!response.ok || !result.success) throw new Error(result.message || "Gagal menutup shift.");
    if (typeof result.kode_tutup !== "string" || !/^[A-Z0-9]{6}$/.test(result.kode_tutup)) throw new Error("Kode unik tutup kasir dari server tidak valid.");
    if (result.kode_tutup !== previewTutupKasir.kode_tutup || !result.preview) throw new Error("Snapshot atau kode tutup server tidak sesuai preview.");
    previewTutupKasir = result.preview;
    previewTutupKasir.shift.status = "CLOSED";
    renderLaporanTutupKasir(previewTutupKasir);
    const report = document.getElementById("closeReport");
    tampilkanTombolCetakLaporan(report);
    report.classList.remove("hidden");
    document.getElementById("lockedArea").classList.add("hidden");
    const confirmButton = report.querySelector("#confirmCloseBtn");
    if (confirmButton) { confirmButton.disabled = true; confirmButton.textContent = "SHIFT BERHASIL DITUTUP"; }
    await logoutKasir();
  } catch (error) { alert("Gagal tutup kasir:\n" + error.message); button.disabled = false; button.textContent = "KONFIRMASI TUTUP KASIR"; }
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

let setoranTarikTunaiTervalidasi = null;
let tarikTunaiSedangDiproses = false;

function bukaTarikTunai() {
  setoranTarikTunaiTervalidasi = null;
  document.getElementById("tarikTunaiKode").value = "";
  document.getElementById("tarikTunaiNominal").value = "";
  document.getElementById("tarikTunaiReferensiQris").value = "";
  document.getElementById("tarikTunaiSetoranInfo").style.display = "none";
  document.getElementById("tarikTunaiNominalInfo").textContent = "";
  document.getElementById("konfirmasiTarikTunaiBtn").disabled = true;
  document.getElementById("tarikTunaiModal").classList.remove("hidden");
}

function tutupTarikTunai() {
  document.getElementById("tarikTunaiModal").classList.add("hidden");
}

function resetValidasiSetoranTarikTunai() {
  setoranTarikTunaiTervalidasi = null;
  document.getElementById("tarikTunaiSetoranInfo").style.display = "none";
  document.getElementById("konfirmasiTarikTunaiBtn").disabled = true;
  validasiNominalTarikTunai();
}

async function cekSetoranTarikTunai() {
  const button = document.getElementById("cekSetoranTarikTunaiBtn");
  const kode = document.getElementById("tarikTunaiKode").value.trim();
  const info = document.getElementById("tarikTunaiSetoranInfo");
  setoranTarikTunaiTervalidasi = null;
  document.getElementById("konfirmasiTarikTunaiBtn").disabled = true;
  if (!kode) {
    info.textContent = "Masukkan kode Setoran.";
    info.style.display = "block";
    return;
  }
  button.disabled = true;
  button.textContent = "MEMERIKSA...";
  try {
    const response = await authenticatedFetch(`/api/tarik-tunai/setoran?kode=${encodeURIComponent(kode)}`);
    const result = await response.json();
    if (!response.ok || !result.success) throw new Error(result.message || "Setoran tidak dapat diperiksa.");
    const setoran = result.setoran;
    setoranTarikTunaiTervalidasi = setoran;
    info.style.color = "#334155";
    const identitas = [
      setoran.namaKasirSumber ? `Kasir sumber: <strong>${escapeHtml(setoran.namaKasirSumber)}</strong>` : "",
      Number.isSafeInteger(setoran.shiftIdSumber) ? `Shift sumber: <strong>${setoran.shiftIdSumber}</strong>` : ""
    ].filter(Boolean);
    info.innerHTML = `<div style="font-weight:800; margin-bottom:5px;">Kode Setoran: ${escapeHtml(setoran.kodeSetoran)}</div>${identitas.length ? `<div>${identitas.join("<br>")}</div>` : ""}<div style="margin-top:7px;">Saldo tersedia: <strong>${rupiah(setoran.saldoTersisa)}</strong></div>${setoran.tersedia ? "" : `<div style="color:#b91c1c; font-weight:700; margin-top:5px;">Setoran tidak memiliki saldo yang dapat digunakan.</div>`}`;
    info.style.display = "block";
    validasiNominalTarikTunai();
  } catch (error) {
    setoranTarikTunaiTervalidasi = null;
    info.textContent = error.message || "Setoran tidak dapat diperiksa.";
    info.style.color = "#b91c1c";
    info.style.display = "block";
  } finally {
    button.disabled = false;
    button.textContent = "CEK";
  }
}

function validasiNominalTarikTunai() {
  const value = parseFormattedCurrency(document.getElementById("tarikTunaiNominal").value);
  const info = document.getElementById("tarikTunaiNominalInfo");
  const validSetoran = setoranTarikTunaiTervalidasi && setoranTarikTunaiTervalidasi.tersedia;
  const validNominal = Number.isSafeInteger(value) && value > 0;
  const withinBalance = validSetoran && value <= Number(setoranTarikTunaiTervalidasi.saldoTersisa);
  info.style.color = validNominal && validSetoran && !withinBalance ? "#b91c1c" : "#64748b";
  info.textContent = !validNominal
    ? "Nominal harus lebih dari Rp0."
    : validSetoran && !withinBalance
      ? "Nominal melebihi saldo Setoran tersedia."
      : "Metode pembayaran transaksi adalah QRIS.";
  document.getElementById("konfirmasiTarikTunaiBtn").disabled = !(validSetoran && validNominal && withinBalance) || tarikTunaiSedangDiproses;
}

async function prosesTarikTunai() {
  if (tarikTunaiSedangDiproses) return;
  validasiNominalTarikTunai();
  const kodeSetoran = document.getElementById("tarikTunaiKode").value.trim();
  const nominal = parseFormattedCurrency(document.getElementById("tarikTunaiNominal").value);
  if (!setoranTarikTunaiTervalidasi || setoranTarikTunaiTervalidasi.kodeSetoran.toLowerCase() !== kodeSetoran.toLowerCase()) {
    alert("Periksa kembali kode Setoran sebelum melanjutkan.");
    return;
  }
  if (!Number.isSafeInteger(nominal) || nominal <= 0 || nominal > Number(setoranTarikTunaiTervalidasi.saldoTersisa)) {
    alert("Nominal Tarik Tunai tidak valid atau melebihi saldo Setoran.");
    return;
  }
  if (!confirm(`Konfirmasi Tarik Tunai ${rupiah(nominal)} dari Setoran ${setoranTarikTunaiTervalidasi.kodeSetoran}?`)) return;

  const button = document.getElementById("konfirmasiTarikTunaiBtn");
  tarikTunaiSedangDiproses = true;
  button.disabled = true;
  button.textContent = "MENYIMPAN...";
  let committed = false;
  try {
    const response = await authenticatedFetch("/api/tarik-tunai", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kodeSetoran,
        nominal,
        referensiQris: document.getElementById("tarikTunaiReferensiQris").value.trim()
      })
    });
    const result = await response.json();
    if (!response.ok || !result.success) throw new Error(result.message || "Tarik Tunai gagal disimpan.");
    committed = true;

    const lines = [
      "================================",
      "          TARIK TUNAI",
      "================================",
      `No. Transaksi : ${result.nomorTransaksi}`,
      `Kasir         : ${currentKasir?.nama || "Kasir"}`,
      `Tanggal       : ${result.tanggal}`,
      `Jam           : ${result.jam}`,
      `Nominal       : ${rupiah(result.nominal)}`,
      `Kode Setoran  : ${result.kodeSetoran}`,
      `Saldo Setoran : ${rupiah(result.saldoSetelah)}`,
      "Metode        : QRIS",
      "Jenis         : TARIK TUNAI"
    ];
    const referensi = document.getElementById("tarikTunaiReferensiQris").value.trim();
    if (referensi) lines.push(`Referensi QRIS : ${referensi}`);
    lines.push("================================", "", "", "");
    let printerError = null;
    try {
      if (typeof window.cetakStrukBluetooth !== "function") throw new Error("Modul cetak printer belum tersedia.");
      const printResult = await window.cetakStrukBluetooth(lines.join("\n"));
      if (!printResult || printResult.success !== true) {
        throw new Error(printResult?.message || "Printer tidak mengonfirmasi keberhasilan cetak.");
      }
    } catch (error) {
      printerError = error;
      console.error("Tarik Tunai tersimpan, tetapi bukti gagal dicetak:", error);
    }

    tutupTarikTunai();
    alert(printerError
      ? `Tarik Tunai ${result.nomorTransaksi} berhasil tersimpan, tetapi bukti gagal dicetak: ${printerError.message}`
      : `Tarik Tunai ${result.nomorTransaksi} berhasil tersimpan dan bukti telah dikirim ke printer.`);
  } catch (error) {
    alert(committed
      ? `Tarik Tunai berhasil tersimpan, tetapi terjadi kesalahan setelah penyimpanan: ${error.message}`
      : error.message || "Tarik Tunai gagal diproses.");
  } finally {
    tarikTunaiSedangDiproses = false;
    button.textContent = "KONFIRMASI TARIK TUNAI";
    validasiNominalTarikTunai();
  }
}

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
      itemsHtml = `<div style="font-size: 0.9rem; color: #9ca3af;">${trx.tipeTransaksi === "TARIK_TUNAI" ? "Bukan transaksi penjualan barang." : "Tidak ada rincian item."}</div>`;
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
    const isTarikTunai = trx.tipeTransaksi === "TARIK_TUNAI";

    return `
      <div 
        style="border: 1px solid #e5e7eb; border-radius: 8px; padding: 15px; cursor: pointer; background-color: #f9fafb; transition: all 0.2s;"
        onclick="toggleDetailRiwayat(${index})"
      >
        <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 4px;">
          <div>
            <div style="font-weight: bold; color: #111827; font-size: 1.05rem;">${escapeHtml(trx.nomorTransaksi)}${isTarikTunai ? ` <span style="font-size:.72rem; color:#b45309; background:#fef3c7; padding:3px 6px; border-radius:5px;">TARIK TUNAI</span>` : ""}</div>
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
          ${isTarikTunai ? `
            <div style="display:flex; justify-content:space-between; font-size:.95rem; color:#4b5563; margin-bottom:4px;"><span>Kode Setoran</span><strong>${escapeHtml(trx.kodeSetoran || "-")}</strong></div>
            <div style="display:flex; justify-content:space-between; font-size:.95rem; color:#4b5563; margin-bottom:4px;"><span>Nominal Tarik Tunai</span><strong>${rupiah(trx.nominalTarikTunai)}</strong></div>
          ` : ""}
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
            ${isTarikTunai ? `
              <span style="font-size:0.85rem; font-weight:bold; color:#b45309;">TARIK TUNAI &bull; QRIS</span>
            ` : !isBatal ? `
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

function tutupKonfirmasiQris() {
  document.getElementById("qrisConfirmPopup").classList.remove("show");
}

function tutupKonfirmasiQrisLuar(event) {
  if (event.target.id === "qrisConfirmPopup") {
    tutupKonfirmasiQris();
  }
}

function lanjutkanPembayaranQris() {
  const data = window.pendingQrisData;
  window.pendingQrisData = null;
  tutupKonfirmasiQris();
  document.getElementById("payBtn").disabled = false;
  document.getElementById("payBtn").innerHTML = "<span>BAYAR</span>";
  if (!data) return;
  executePayment(data.payment, data.targetSessionId, data.targetSession, data.nomorMeja, data.pendingMemberForMeja);
}

let _qrisConfirmed = false;

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

let lampWatchdogAlarms = [];
const LAMP_WATCHDOG_NOTIFICATION_STORAGE_KEY = 'pos.lampWatchdog.notifications.v1';

function getLampWatchdogNotificationState() {
  try {
    const state = JSON.parse(localStorage.getItem(LAMP_WATCHDOG_NOTIFICATION_STORAGE_KEY) || '{}');
    return { readIds: Array.isArray(state.readIds) ? state.readIds.map(String) : [], dismissedIds: Array.isArray(state.dismissedIds) ? state.dismissedIds.map(String) : [] };
  } catch (_) { return { readIds: [], dismissedIds: [] }; }
}
function saveLampWatchdogNotificationState(state) {
  try { localStorage.setItem(LAMP_WATCHDOG_NOTIFICATION_STORAGE_KEY, JSON.stringify(state)); } catch (_) {}
}
function getLampWatchdogAlarmId(alarm) {
  return alarm?.id === undefined || alarm?.id === null ? '' : String(alarm.id);
}
function updateLampWatchdogBadge() {
  const badge = document.getElementById('lampWatchdogBadge');
  if (!badge) return;
  const state = getLampWatchdogNotificationState();
  const read = new Set(state.readIds), dismissed = new Set(state.dismissedIds);
  const unread = lampWatchdogAlarms.filter(alarm => { const id = getLampWatchdogAlarmId(alarm); return id && !read.has(id) && !dismissed.has(id); }).length;
  badge.textContent = unread ? String(unread) : '';
  badge.hidden = unread === 0;
  document.getElementById('lampWatchdogBtn')?.classList.toggle('has-unread', unread > 0);
  badge.setAttribute('aria-label', `${unread} notifikasi belum dibaca`);
}

async function loadLampWatchdogAlarms() {
  try {
    const response = await fetch('/api/lamp-watchdog/alarms');
    if (!response.ok) return;

    const data = await response.json();
    if (!data.success) return;

    lampWatchdogAlarms = Array.isArray(data.alarms) ? data.alarms : [];

    updateLampWatchdogBadge();
    if (lampWatchdogDropdown && !lampWatchdogDropdown.hidden) renderLampWatchdogDetails();
  } catch (error) {
    console.warn('[LAMP WATCHDOG]', error);
  }
}

function startLampWatchdogPolling() {
  loadLampWatchdogAlarms();
  setInterval(loadLampWatchdogAlarms, 10000);
}

function renderLampWatchdogDetails() {
  const details = document.getElementById('lampWatchdogDetails');
  if (!details) return;

  const alarms = [...lampWatchdogAlarms]
    .sort((a, b) => new Date(b.last_failed_at || b.started_at || 0) - new Date(a.last_failed_at || a.started_at || 0))
    .slice(0, 40);

  if (alarms.length === 0) {
    details.textContent = 'Tidak ada notifikasi';
    return;
  }

  const formatDate = (value) => {
    if (!value) return '-';
    const date = new Date(value);
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Makassar',
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23'
    }).format(date).replace(',', '');
  };
  const formatValue = (value) => value === null || value === undefined || value === '' ? '-' : String(value);

  const state = getLampWatchdogNotificationState();
  const read = new Set(state.readIds), dismissed = new Set(state.dismissedIds);
  const visibleAlarms = alarms.filter(alarm => { const id = getLampWatchdogAlarmId(alarm); return id && !dismissed.has(id); });
  if (!visibleAlarms.length) { details.textContent = 'Tidak ada notifikasi'; return; }
  details.replaceChildren(...visibleAlarms.map((alarm, index) => {
    const item = document.createElement('div');
    item.className = 'lamp-watchdog-notification';
    const alarmId = getLampWatchdogAlarmId(alarm);
    if (!read.has(alarmId)) item.classList.add('is-unread');
    const status = String(alarm.status || '').toUpperCase() === 'ACTIVE' ? 'ACTIVE' : 'CLEARED';
    const command = String(alarm.command || alarm.command_type || '').toUpperCase();
    const summary = document.createElement('button');
    summary.type = 'button';
    summary.setAttribute('aria-expanded', 'false');
    summary.setAttribute('aria-controls', `lamp-watchdog-alarm-${index}`);
    summary.className = 'lamp-watchdog-summary';
    summary.setAttribute('aria-label', `Alarm lampu meja ${alarm.table_number ?? alarm.meja ?? '-'}, ${command || '-'}, ${status}`);
    summary.textContent = `Meja ${alarm.table_number ?? alarm.meja ?? '-'} Â· ${command || '-'} Â· ${status}`;

    const panel = document.createElement('div');
    panel.id = `lamp-watchdog-alarm-${index}`;
    panel.hidden = true;
    panel.className = 'lamp-watchdog-alarm-detail';
    const fields = [
      ['Command', command || '-'],
      ['Failure count', alarm.failure_count ?? 0],
      ['Started', formatDate(alarm.started_at)],
      ['Last failed', formatDate(alarm.last_failed_at)],
      ...(alarm.cleared_at ? [['Cleared', formatDate(alarm.cleared_at)]] : []),
      ['Error', formatValue(alarm.error_message)],
      ['Error category', formatValue(alarm.error_category)],
      ['Artinya', formatValue(alarm.error_meaning)],
      ['Tindakan', formatValue(alarm.troubleshooting)]
    ];

    for (const [label, value] of fields) {
      const row = document.createElement('div');
      const name = document.createElement('strong');
      name.textContent = `${label}: `;
      row.append(name, document.createTextNode(String(value)));
      panel.append(row);
    }

    summary.addEventListener('click', () => {
      const opening = panel.hidden;
      panel.hidden = !opening;
      summary.setAttribute('aria-expanded', String(opening));
    });
    item.append(summary, panel);
    return item;
  }));
}
const lampWatchdogBtn = document.getElementById('lampWatchdogBtn');
const lampWatchdogDropdown = document.getElementById('lampWatchdogDropdown');
const lampWatchdogContainer = document.getElementById('lampWatchdogContainer');

if (lampWatchdogBtn && lampWatchdogDropdown) {
  lampWatchdogBtn.addEventListener('click', () => {
    const opening = lampWatchdogDropdown.hidden;
    lampWatchdogDropdown.hidden = !opening;
    lampWatchdogBtn.setAttribute('aria-expanded', String(opening));
    if (opening) {
      const state = getLampWatchdogNotificationState();
      const dismissed = new Set(state.dismissedIds);
      const displayedAlarms = [...lampWatchdogAlarms]
        .sort((a, b) => new Date(b.last_failed_at || b.started_at || 0) - new Date(a.last_failed_at || a.started_at || 0))
        .slice(0, 40);
      state.readIds = [...new Set([...state.readIds, ...displayedAlarms.map(getLampWatchdogAlarmId).filter(id => id && !dismissed.has(id))])];
      saveLampWatchdogNotificationState(state);
      renderLampWatchdogDetails();
      updateLampWatchdogBadge();
    }
  });
}

document.getElementById('lampWatchdogClearBtn')?.addEventListener('click', () => {
  const state = getLampWatchdogNotificationState();
  state.dismissedIds = [...new Set([...state.dismissedIds, ...lampWatchdogAlarms.map(getLampWatchdogAlarmId).filter(Boolean)])];
  state.readIds = [];
  saveLampWatchdogNotificationState(state);
  renderLampWatchdogDetails();
  updateLampWatchdogBadge();
});

document.addEventListener('click', (event) => {
  if (lampWatchdogContainer && !lampWatchdogContainer.contains(event.target) && lampWatchdogDropdown && !lampWatchdogDropdown.hidden) {
    lampWatchdogDropdown.hidden = true;
    lampWatchdogBtn?.setAttribute('aria-expanded', 'false');
  }
});

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', startLampWatchdogPolling, { once: true });
} else {
  startLampWatchdogPolling();
}
