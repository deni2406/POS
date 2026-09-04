/**
 * pricing-meja.js
 * Modul mandiri:
 * - State meja
 * - Timer per meja
 * - Member per meja
 * - Perhitungan harga member dinamis melalui endpoint /api/meja/hitung-harga
 * - Perhitungan harga NON_MEMBER melalui promo.js / hitungHargaSewa
 *
 * Mendukung Universal Module Definition (UMD)
 * Bisa dipanggil dari Node.js (CommonJS) maupun Browser (window.PricingMeja)
 */

(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    // Lingkungan Node.js (CommonJS)
    module.exports = factory(require("./promo"));
  } else {
    // Lingkungan Browser (Global object)
    root.PricingMeja = factory(root);
  }
})(typeof window !== "undefined" ? window : globalThis, function (promoDep) {
  
  if (typeof window !== "undefined") {
    console.log("[PRICING-MEJA] Browser module loaded");
  }

  const mejaMap = new Map();
  let hargaUpdateCallback = null;

  /**
   * Helper konversi waktuMulai menjadi string format HH:mm.
   */
  function extractHHMM(waktuMulai) {
    try {
      if (!waktuMulai) {
        const now = new Date();
        return String(now.getHours()).padStart(2, "0") + ":" + String(now.getMinutes()).padStart(2, "0");
      }
      if (typeof waktuMulai === "string" && /^\d{2}:\d{2}/.test(waktuMulai)) {
        return waktuMulai.substring(0, 5);
      }
      const d = new Date(waktuMulai);
      if (isNaN(d.getTime())) {
        const now = new Date();
        return String(now.getHours()).padStart(2, "0") + ":" + String(now.getMinutes()).padStart(2, "0");
      }
      return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
    } catch (e) {
      const now = new Date();
      return String(now.getHours()).padStart(2, "0") + ":" + String(now.getMinutes()).padStart(2, "0");
    }
  }

  /**
   * Helper pembentukan URL API yang kompatibel dengan Web dan APK (Capacitor).
   */
  function getEndpointUrl() {
    const path = "/api/meja/hitung-harga";

    if (typeof window !== "undefined" && typeof window.apiUrl === "function") {
      return window.apiUrl(path);
    }

    let isCapacitor = false;
    if (typeof window !== "undefined") {
      isCapacitor = !!(
        window.Capacitor ||
        (window.location && (
          window.location.protocol === "capacitor:" ||
          window.location.protocol === "file:"
        ))
      );
    }

    const baseUrl = isCapacitor ? "https://192.168.1.140:3100" : "";
    return `${baseUrl}${path}`;
  }

  /**
   * Helper pembentukan Header Request dengan Session ID dan Device ID yang benar.
   */
  function getHeaders() {
    const headers = {
      "Content-Type": "application/json"
    };

    try {
      if (typeof sessionStorage !== "undefined") {
        const sId = sessionStorage.getItem("pbms_session_id");
        if (sId) headers["X-Session-Id"] = sId;
      }

      if (typeof localStorage !== "undefined") {
        const dId = localStorage.getItem("pbms_device_id");
        if (dId) headers["X-Device-Id"] = dId;
      }
    } catch (e) {
      // Abaikan error akses storage
    }

    return headers;
  }

  /**
   * Ambil atau buat state meja.
   */
  function getOrCreateMeja(nomorMeja) {
    const key = String(nomorMeja).trim();

    if (!key) {
      throw new Error("Nomor meja wajib diisi");
    }

    if (!mejaMap.has(key)) {
      mejaMap.set(key, {
        nomorMeja: key,
        member: null,
        kategori: "NON_MEMBER",
        status: "STOPPED",
        startTime: null,
        elapsedSeconds: 0,
        intervalId: null,
        waktuMulai: null,
        lastCacheKey: null,
        hargaCached: null,
        isFetchingPrice: false
      });
    }

    return mejaMap.get(key);
  }

  /**
   * Normalisasi kategori customer.
   */
  function normalisasiKategori(member) {
    if (!member) {
      return "NON_MEMBER";
    }

    const kategori = String(
      member.kategori || member.kategoriId || ""
    )
      .trim()
      .toUpperCase();

    if (kategori === "PELAJAR") {
      return "PELAJAR";
    }

    if (kategori === "UMUM") {
      return "UMUM";
    }

    if (kategori === "PLATINUM") {
      return "PLATINUM";
    }

    return "NON_MEMBER";
  }

  /**
   * Pasang member ke meja tertentu.
   */
  function setMemberMeja(nomorMeja, member) {
    const meja = getOrCreateMeja(nomorMeja);

    meja.member = member || null;
    meja.kategori = normalisasiKategori(member);
    meja.lastCacheKey = null;
    meja.hargaCached = null;

    refreshHargaMeja(nomorMeja);
    emitHargaUpdate(meja.nomorMeja);

    return getTimer(nomorMeja);
  }

  /**
   * Ambil durasi aktual dalam jam.
   * Minimum 1 jam untuk perhitungan harga.
   */
  function getDurasiJam(nomorMeja) {
    const meja = getOrCreateMeja(nomorMeja);

    return Math.max(
      1,
      Math.ceil(Number(meja.elapsedSeconds || 0) / 3600)
    );
  }

  /**
   * Hitung harga lokal untuk NON_MEMBER via promo.js / hitungHargaSewa.
   */
  function hitungHargaMejaSync(kategori, durasiJam, waktuMulai) {
    const durasi = Math.max(1, Number(durasiJam) || 1);
    const kat = String(kategori || "NON_MEMBER").trim().toUpperCase();

    let hitungHargaSewaFunc = null;
    if (typeof promoDep !== "undefined" && promoDep && typeof promoDep.hitungHargaSewa === "function") {
      hitungHargaSewaFunc = promoDep.hitungHargaSewa;
    } else if (typeof window !== "undefined" && typeof window.hitungHargaSewa === "function") {
      hitungHargaSewaFunc = window.hitungHargaSewa;
    } else if (typeof globalThis !== "undefined" && typeof globalThis.hitungHargaSewa === "function") {
      hitungHargaSewaFunc = globalThis.hitungHargaSewa;
    }

    if (typeof hitungHargaSewaFunc !== "function") {
      return {
        success: false,
        message: "Modul promo belum tersedia"
      };
    }

    return hitungHargaSewaFunc({
      kategori: kat,
      durasiJam: durasi,
      waktuMulai: waktuMulai
    });
  }

  /**
   * Hitung harga meja secara langsung berdasarkan kategori, durasi, dan waktu mulai.
   * - Member (PLATINUM, UMUM, PELAJAR) -> /api/meja/hitung-harga
   * - NON_MEMBER -> promo.js / hitungHargaSewa
   */
  async function hitungHargaMeja(kategori, durasiJam, waktuMulai) {
    const durasi = Math.max(1, Number(durasiJam) || 1);
    const kat = String(kategori || "NON_MEMBER").trim().toUpperCase();

    // Jika NON_MEMBER, gunakan promo.js / hitungHargaSewa (JANGAN kirim ke endpoint backend)
    if (!["PLATINUM", "UMUM", "PELAJAR"].includes(kat)) {
      return hitungHargaMejaSync(kat, durasi, waktuMulai);
    }

    const jamStr = extractHHMM(waktuMulai);
    console.log(`[PRICING-MEJA] REQUEST HARGA MEMBER: kategori=${kat}, durasiJam=${durasi}, jam=${jamStr}`);

    try {
      const url = getEndpointUrl();
      const headers = getHeaders();

      const response = await fetch(url, {
        method: "POST",
        headers: headers,
        body: JSON.stringify({
          kategori: kat,
          durasiJam: durasi,
          jam: jamStr
        })
      });

      const data = await response.json();
      console.log("[PRICING-MEJA] RESPONSE HARGA MEMBER:", data);

      if (data && data.success === true) {
        return {
          ...data,
          success: true,
          kategori: data.kategori || kat,
          durasiJam: Number(data.durasiJam || durasi),
          hargaPerJam: Number(data.hargaPerJam || 0),
          total: Number(data.total || 0),
          waktuMulai: waktuMulai || null
        };
      } else {
        return {
          success: false,
          message: data?.message || "Harga meja tidak dapat diambil dari server."
        };
      }
    } catch (error) {
      console.error("[PRICING-MEJA] FETCH ERROR:", error.message);
      return {
        success: false,
        message: "Harga meja tidak dapat diambil dari server."
      };
    }
  }

  /**
   * Hitung harga meja berdasarkan nomor meja (Async / Direct Call).
   */
  async function getHargaMeja(nomorMeja, waktuMulaiArg) {
    const meja = getOrCreateMeja(nomorMeja);
    const durasiJam = getDurasiJam(nomorMeja);
    const waktuMulai = waktuMulaiArg || meja.waktuMulai;
    const jamStr = extractHHMM(waktuMulai);

    const cacheKey = `${meja.kategori}_${durasiJam}_${jamStr}`;

    if (meja.lastCacheKey === cacheKey && meja.hargaCached) {
      return {
        ...meja.hargaCached,
        nomorMeja: meja.nomorMeja,
        waktuMulai: waktuMulai
      };
    }

    const hasil = await hitungHargaMeja(meja.kategori, durasiJam, waktuMulai);

    if (!hasil || hasil.success !== true) {
      return {
        success: false,
        nomorMeja: meja.nomorMeja,
        kategori: meja.kategori,
        durasiJam: durasiJam,
        message: hasil?.message || "Harga meja tidak dapat diambil dari server."
      };
    }

    meja.lastCacheKey = cacheKey;
    meja.hargaCached = hasil;

    return {
      ...hasil,
      nomorMeja: meja.nomorMeja,
      waktuMulai: waktuMulai
    };
  }

  /**
   * Refresh harga meja di background dan trigger update callback jika ada perubahan harga.
   */
  function refreshHargaMeja(nomorMeja) {
    const meja = getOrCreateMeja(nomorMeja);
    const durasiJam = getDurasiJam(nomorMeja);
    const waktuMulai = meja.waktuMulai;
    const jamStr = extractHHMM(waktuMulai);
    const cacheKey = `${meja.kategori}_${durasiJam}_${jamStr}`;

    if (meja.lastCacheKey === cacheKey && meja.hargaCached) {
      return Promise.resolve(meja.hargaCached);
    }

    // Untuk NON_MEMBER, jalankan kalkulasi sync langsung tanpa fetch
    if (!["PLATINUM", "UMUM", "PELAJAR"].includes(meja.kategori)) {
      const hasil = hitungHargaMejaSync(meja.kategori, durasiJam, waktuMulai);
      if (hasil && hasil.success === true) {
        meja.lastCacheKey = cacheKey;
        meja.hargaCached = hasil;
      } else {
        meja.lastCacheKey = null;
        meja.hargaCached = null;
      }
      return Promise.resolve(hasil);
    }

    if (meja.isFetchingPrice) {
      return Promise.resolve(null);
    }

    meja.isFetchingPrice = true;

    return hitungHargaMeja(meja.kategori, durasiJam, waktuMulai).then(hasil => {
      meja.isFetchingPrice = false;
      if (hasil && hasil.success === true) {
        meja.lastCacheKey = cacheKey;
        meja.hargaCached = hasil;
        emitHargaUpdate(meja.nomorMeja);
      } else {
        meja.lastCacheKey = null;
        meja.hargaCached = null;
      }
      return hasil;
    }).catch(err => {
      meja.isFetchingPrice = false;
      meja.lastCacheKey = null;
      meja.hargaCached = null;
    });
  }

  /**
   * Mulai timer meja.
   */
  function startTimer(nomorMeja, waktuMulai) {
    const meja = getOrCreateMeja(nomorMeja);

    if (meja.intervalId) {
      clearInterval(meja.intervalId);
    }

    meja.status = "RUNNING";
    meja.startTime = meja.startTime || Date.now();
    if (waktuMulai) {
      meja.waktuMulai = waktuMulai;
    } else if (!meja.waktuMulai) {
      meja.waktuMulai = new Date(meja.startTime).toISOString();
    }

    meja.lastCacheKey = null;
    meja.hargaCached = null;

    meja.intervalId = setInterval(() => {
      meja.elapsedSeconds += 1;
      refreshHargaMeja(meja.nomorMeja);
      emitHargaUpdate(meja.nomorMeja);
    }, 1000);

    refreshHargaMeja(meja.nomorMeja);
    emitHargaUpdate(meja.nomorMeja);

    return getTimer(nomorMeja);
  }

  /**
   * Pause timer.
   */
  function pauseTimer(nomorMeja) {
    const meja = getOrCreateMeja(nomorMeja);

    if (meja.intervalId) {
      clearInterval(meja.intervalId);
      meja.intervalId = null;
    }

    if (meja.status === "RUNNING") {
      meja.status = "PAUSED";
    }

    emitHargaUpdate(meja.nomorMeja);

    return getTimer(nomorMeja);
  }

  /**
   * Resume timer.
   */
  function resumeTimer(nomorMeja) {
    const meja = getOrCreateMeja(nomorMeja);

    if (meja.status !== "PAUSED") {
      return getTimer(nomorMeja);
    }

    meja.status = "RUNNING";

    meja.intervalId = setInterval(() => {
      meja.elapsedSeconds += 1;
      refreshHargaMeja(meja.nomorMeja);
      emitHargaUpdate(meja.nomorMeja);
    }, 1000);

    emitHargaUpdate(meja.nomorMeja);

    return getTimer(nomorMeja);
  }

  /**
   * Stop timer.
   */
  function stopTimer(nomorMeja) {
    const meja = getOrCreateMeja(nomorMeja);

    if (meja.intervalId) {
      clearInterval(meja.intervalId);
      meja.intervalId = null;
    }

    meja.status = "STOPPED";

    emitHargaUpdate(meja.nomorMeja);

    return getTimer(nomorMeja);
  }

  /**
   * Reset timer dan member meja.
   */
  function resetTimer(nomorMeja) {
    const meja = getOrCreateMeja(nomorMeja);

    if (meja.intervalId) {
      clearInterval(meja.intervalId);
      meja.intervalId = null;
    }

    meja.member = null;
    meja.kategori = "NON_MEMBER";
    meja.status = "STOPPED";
    meja.startTime = null;
    meja.elapsedSeconds = 0;
    meja.waktuMulai = null;
    meja.lastCacheKey = null;
    meja.hargaCached = null;

    emitHargaUpdate(meja.nomorMeja);

    return getTimer(nomorMeja);
  }

  /**
   * Ambil snapshot meja (Synchronous).
   */
  function getTimer(nomorMeja) {
    const meja = getOrCreateMeja(nomorMeja);
    const durasiJam = getDurasiJam(nomorMeja);
    const waktuMulai = meja.waktuMulai;
    const jamStr = extractHHMM(waktuMulai);
    const cacheKey = `${meja.kategori}_${durasiJam}_${jamStr}`;

    let hargaResult;
    if (meja.lastCacheKey === cacheKey && meja.hargaCached) {
      hargaResult = {
        ...meja.hargaCached,
        nomorMeja: meja.nomorMeja,
        waktuMulai: waktuMulai
      };
    } else if (!["PLATINUM", "UMUM", "PELAJAR"].includes(meja.kategori)) {
      const hasil = hitungHargaMejaSync(meja.kategori, durasiJam, waktuMulai);
      if (hasil && hasil.success === true) {
        meja.lastCacheKey = cacheKey;
        meja.hargaCached = hasil;
        hargaResult = {
          ...hasil,
          nomorMeja: meja.nomorMeja,
          waktuMulai: waktuMulai
        };
      } else {
        hargaResult = {
          success: false,
          nomorMeja: meja.nomorMeja,
          kategori: meja.kategori,
          durasiJam: durasiJam,
          message: hasil?.message || "Gagal menghitung harga meja"
        };
      }
    } else {
      refreshHargaMeja(nomorMeja);
      hargaResult = {
        success: false,
        nomorMeja: meja.nomorMeja,
        kategori: meja.kategori,
        durasiJam: durasiJam,
        message: "Harga meja tidak dapat diambil dari server."
      };
    }

    return {
      nomorMeja: meja.nomorMeja,
      member: meja.member,
      kategori: meja.kategori,
      status: meja.status,
      startTime: meja.startTime,
      elapsedSeconds: meja.elapsedSeconds,
      durasiJam: durasiJam,
      waktuMulai: waktuMulai,
      harga: hargaResult
    };
  }

  /**
   * Ambil semua meja yang sudah dibuat.
   */
  function getSemuaMeja() {
    return Array.from(mejaMap.keys()).map(
      nomorMeja => getTimer(nomorMeja)
    );
  }

  /**
   * Daftarkan callback perubahan harga.
   */
  function setHargaUpdateCallback(callback) {
    if (
      callback !== null &&
      typeof callback !== "function"
    ) {
      throw new Error(
        "Callback harga harus berupa function atau null"
      );
    }

    hargaUpdateCallback = callback;
  }

  /**
   * Emit perubahan harga.
   */
  function emitHargaUpdate(nomorMeja) {
    if (typeof hargaUpdateCallback !== "function") {
      return;
    }

    try {
      hargaUpdateCallback(
        getTimer(nomorMeja)
      );
    } catch (error) {
      console.error(
        `[MEJA-TIMER] Callback harga error meja ${nomorMeja}:`,
        error.message
      );
    }
  }

  /**
   * Hentikan semua timer.
   */
  function stopSemuaTimer() {
    for (const meja of mejaMap.values()) {
      if (meja.intervalId) {
        clearInterval(meja.intervalId);
        meja.intervalId = null;
      }

      if (meja.status === "RUNNING") {
        meja.status = "STOPPED";
      }
    }
  }

  /**
   * Format durasi menjadi HH:MM:SS.
   */
  function formatWaktu(seconds) {
    const total = Math.max(
      0,
      Number(seconds) || 0
    );

    const jam = Math.floor(total / 3600);
    const menit = Math.floor(
      (total % 3600) / 60
    );
    const detik = total % 60;

    return [
      String(jam).padStart(2, "0"),
      String(menit).padStart(2, "0"),
      String(detik).padStart(2, "0")
    ].join(":");
  }

  /**
   * Test mandiri.
   *
   * Jalankan:
   * node pricing-meja.js
   */
  async function runSelfTest() {
    console.log("=== TEST PRICING-MEJA ===");

    // Non-member 1 jam
    setMemberMeja("1", null);

    console.log(
      "NON_MEMBER 1 jam:",
      await getHargaMeja("1")
    );

    // Non-member 3 jam
    const meja2 = getOrCreateMeja("2");
    meja2.elapsedSeconds = 3 * 3600;

    console.log(
      "NON_MEMBER 3 jam:",
      await getHargaMeja("2")
    );

    // Umum 1 jam
    setMemberMeja("3", {
      idMember: "UMM-TEST",
      kategori: "UMUM"
    });

    console.log(
      "UMUM 1 jam:",
      await getHargaMeja("3")
    );

    // Umum 2 jam
    mejaMap.get("3").elapsedSeconds = 2 * 3600;

    console.log(
      "UMUM 2 jam:",
      await getHargaMeja("3")
    );

    // Pelajar 1 jam
    setMemberMeja("4", {
      idMember: "PLJ-TEST",
      kategori: "PELAJAR"
    });

    console.log(
      "PELAJAR 1 jam:",
      await getHargaMeja("4")
    );

    // Platinum
    setMemberMeja("5", {
      idMember: "PLT-TEST",
      kategori: "PLATINUM"
    });

    console.log(
      "PLATINUM 1 jam:",
      await getHargaMeja("5")
    );

    // Test Wajib Berdasarkan Waktu Mulai
    console.log("\n=== TEST WAJIB WAKTU MULAI ===");

    // 1. PELAJAR 1 jam 10:00
    console.log("Test 1 (PELAJAR 1 jam 10:00):", await hitungHargaMeja("PELAJAR", 1, "2026-08-24T10:00:00+08:00"));

    // 2. PELAJAR 1 jam 18:00
    console.log("Test 2 (PELAJAR 1 jam 18:00):", await hitungHargaMeja("PELAJAR", 1, "2026-08-24T18:00:00+08:00"));

    // 3. UMUM 2 jam 10:00
    console.log("Test 3 (UMUM 2 jam 10:00):", await hitungHargaMeja("UMUM", 2, "2026-08-24T10:00:00+08:00"));

    // 4. UMUM 2 jam 17:00
    console.log("Test 4 (UMUM 2 jam 17:00):", await hitungHargaMeja("UMUM", 2, "2026-08-24T17:00:00+08:00"));

    // 5. NON_MEMBER 3 jam 10:00
    console.log("Test 5 (NON_MEMBER 3 jam 10:00):", await hitungHargaMeja("NON_MEMBER", 3, "2026-08-24T10:00:00+08:00"));

    // 6. NON_MEMBER 3 jam 17:00
    console.log("Test 6 (NON_MEMBER 3 jam 17:00):", await hitungHargaMeja("NON_MEMBER", 3, "2026-08-24T17:00:00+08:00"));

    // 7. PLATINUM 1 jam 10:00
    console.log("Test 7 (PLATINUM 1 jam 10:00):", await hitungHargaMeja("PLATINUM", 1, "2026-08-24T10:00:00+08:00"));

    // Format waktu
    console.log(
      "Format 3661 detik:",
      formatWaktu(3661)
    );

    // Test isolasi kategori per meja
    console.log(
      "Kategori meja 3:",
      getTimer("3").kategori
    );

    console.log(
      "Kategori meja 4:",
      getTimer("4").kategori
    );

    console.log(
      "Kategori meja 5:",
      getTimer("5").kategori
    );

    stopSemuaTimer();

    console.log("TEST SELESAI");
  }

  // Mengembalikan objek public API
  return {
    startTimer,
    pauseTimer,
    resumeTimer,
    stopTimer,
    resetTimer,
    getTimer,
    getSemuaMeja,
    setMemberMeja,
    getDurasiJam,
    getHargaMeja,
    hitungHargaMeja,
    setHargaUpdateCallback,
    stopSemuaTimer,
    formatWaktu,
    runSelfTest
  };
});

// Menjalankan self-test jika dipanggil langsung via Node.js
if (typeof require !== "undefined" && typeof module !== "undefined" && require.main === module) {
  module.exports.runSelfTest().catch(console.error);
}
