// ==================================================
// MEJA TIMER LIBRARY (meja-timer.js)
// ==================================================

(function () {
  'use strict';

  // Menyimpan referensi interval timer (countdown & count-up) per elemen DOM
  const activeTimers = new WeakMap();

  /** Helper parse date yang aman untuk berbagai format string atau objek Date. */
  function parseDate(value) {
    if (!value) return null;

    if (value instanceof Date) {
      return isNaN(value.getTime()) ? null : value;
    }

    // Format ISO atau SQLite (YYYY-MM-DD HH:mm:ss / YYYY-MM-DDTHH:mm:ss.sssZ)
    let parsed = new Date(value);
    if (!isNaN(parsed.getTime())) {
      return parsed;
    }

    // Fallback parsing manual untuk format "YYYY-MM-DD HH:mm:ss"
    if (typeof value === 'string') {
      const normalized = value.replace(' ', 'T');
      parsed = new Date(normalized);

      if (!isNaN(parsed.getTime())) {
        return parsed;
      }
    }

    return null;
  }

  /** Menghitung waktu selesai berdasarkan waktu mulai dan durasi (dalam jam). */
  function hitungWaktuSelesai(waktuMulai, durasiJam) {
    const start = parseDate(waktuMulai);

    if (!start) return null;

    const durasiMs =
      Number(durasiJam || 0) *
      3600 *
      1000;

    return new Date(
      start.getTime() + durasiMs
    );
  }

  /** Menghitung sisa waktu secara real-time terhadap waktu selesai (Mode DURASI). */
  function hitungSisaWaktu(waktuSelesai) {
    const end = parseDate(waktuSelesai);
    const now = new Date();

    if (!end) {
      return {
        habis: true,
        totalMs: 0,
        jam: 0,
        menit: 0,
        detik: 0
      };
    }

    const totalMs =
      end.getTime() -
      now.getTime();

    if (totalMs <= 0) {
      return {
        habis: true,
        totalMs: 0,
        jam: 0,
        menit: 0,
        detik: 0
      };
    }

    const totalDetik =
      Math.floor(totalMs / 1000);

    const jam =
      Math.floor(totalDetik / 3600);

    const menit =
      Math.floor(
        (totalDetik % 3600) / 60
      );

    const detik =
      totalDetik % 60;

    return {
      habis: false,
      totalMs,
      jam,
      menit,
      detik
    };
  }

  /** Menentukan status waktu ("HABIS", "HAMPIR_HABIS", atau "AKTIF") untuk Mode DURASI. */
  function getStatusWaktu(waktuSelesai) {
    const sisa =
      hitungSisaWaktu(waktuSelesai);

    if (sisa.habis) {
      return "HABIS";
    }

    if (sisa.totalMs <= 30 * 60 * 1000) {
      return "HAMPIR_HABIS";
    }

    return "AKTIF";
  }

  /** Memformat countdown menjadi string HH:mm:ss atau "00:00:00" (Mode DURASI). */
  function formatCountdown(waktuSelesai) {
    const sisa =
      hitungSisaWaktu(waktuSelesai);

    if (sisa.habis) {
      return "00:00:00";
    }

    const h =
      String(sisa.jam)
        .padStart(2, '0');

    const m =
      String(sisa.menit)
        .padStart(2, '0');

    const s =
      String(sisa.detik)
        .padStart(2, '0');

    return `${h}:${m}:${s}`;
  }

  /** Memformat elapsed time menjadi string HH:mm:ss (Mode LOSS). */
  function formatCountUp(waktuMulai) {
    const start = parseDate(waktuMulai);
    if (!start) return "00:00:00";

    const elapsedMs = Math.max(0, Date.now() - start.getTime());
    const totalSeconds = Math.floor(elapsedMs / 1000);

    const jam = Math.floor(totalSeconds / 3600);
    const menit = Math.floor((totalSeconds % 3600) / 60);
    const detik = totalSeconds % 60;

    const h = String(jam).padStart(2, '0');
    const m = String(menit).padStart(2, '0');
    const s = String(detik).padStart(2, '0');

    return `${h}:${m}:${s}`;
  }

  /** Memformat nilai waktu menjadi string jam (HH:mm:ss). */
  function formatJam(value) {
    const date =
      parseDate(value);

    if (!date) return "-";

    const h =
      String(date.getHours())
        .padStart(2, '0');

    const m =
      String(date.getMinutes())
        .padStart(2, '0');

    const s =
      String(date.getSeconds())
        .padStart(2, '0');

    return `${h}:${m}:${s}`;
  }

  /** Memformat nilai waktu menjadi string tanggal & jam (DD/MM/YYYY HH:mm:ss). */
  function formatTanggalJam(value) {
    const date =
      parseDate(value);

    if (!date) return "-";

    const dd =
      String(date.getDate())
        .padStart(2, '0');

    const mm =
      String(date.getMonth() + 1)
        .padStart(2, '0');

    const yyyy =
      date.getFullYear();

    const h =
      String(date.getHours())
        .padStart(2, '0');

    const m =
      String(date.getMinutes())
        .padStart(2, '0');

    const s =
      String(date.getSeconds())
        .padStart(2, '0');

    return `${dd}/${mm}/${yyyy} ${h}:${m}:${s}`;
  }

  /**
   * Normalisasi data sesi meja untuk mendukung
   * mode DURASI dan mode WAKTU LOSS.
   */
  function normalisasiSesiMeja(data) {
    if (
      !data ||
      typeof data !== 'object'
    ) {
      return {
        sessionId: "",
        nomorMeja: 0,
        namaPemesan: "",
        kasir: "",
        waktuMulai: null,
        durasiJam: 0,
        waktuSelesai: null,
        status: "AKTIF",
        statusWaktu: "AKTIF",
        jenisSesi: "BIASA"
      };
    }

    const sessionId =
      data.sessionId ||
      data.session_id ||
      "";

    const nomorMeja =
      Number(
        data.nomorMeja ||
        data.nomor_meja ||
        0
      );

    const namaPemesan =
      data.namaPemesan ||
      data.nama_pemesan ||
      "";

    const kasir =
      data.kasir ||
      "";

    const waktuMulaiVal =
      data.waktuMulai ||
      data.waktu_mulai ||
      null;

    const jenisSesi = String(
      data.jenisSesi ||
      data.jenis_sesi ||
      "BIASA"
    ).toUpperCase();

    const durasiJamVal =
      Number(
        data.durasiJam !== undefined
          ? data.durasiJam
          : (
              data.durasi_jam !== undefined
                ? data.durasi_jam
                : 0
            )
      );

    let waktuSelesaiVal =
      data.waktuSelesai ||
      data.waktu_selesai ||
      null;

    if (jenisSesi !== "LOSS" && !parseDate(waktuSelesaiVal)) {
      const calculatedEnd =
        waktuMulaiVal && durasiJamVal > 0
          ? hitungWaktuSelesai(waktuMulaiVal, durasiJamVal)
          : null;

      // Nilai akhir malformed dibuang; tanpa fallback yang valid, timer tetap tidak tersedia.
      waktuSelesaiVal = calculatedEnd
        ? calculatedEnd.toISOString()
        : null;
    }

    // Status database tetap mengikuti data sumber.
    const status =
      String(
        data.status ||
        "AKTIF"
      ).toUpperCase();

    // Status waktu untuk LOSS selalu AKTIF selama sesi aktif.
    let statusWaktu = "AKTIF";
    if (jenisSesi === "LOSS") {
      statusWaktu = (status === "AKTIF") ? "AKTIF" : "SELESAI";
    } else if (waktuSelesaiVal) {
      statusWaktu = getStatusWaktu(waktuSelesaiVal);
    }

    return {
      sessionId,
      nomorMeja,
      namaPemesan,
      kasir,
      waktuMulai: waktuMulaiVal,
      durasiJam: durasiJamVal,
      waktuSelesai: waktuSelesaiVal,
      status,
      statusWaktu,
      jenisSesi
    };
  }

  /** Menjalankan countdown real-time pada elemen DOM target (Mode DURASI). */
  function mulaiCountdownMeja(
    element,
    waktuSelesai,
    options = {}
  ) {
    if (
      !element ||
      !(element instanceof Element)
    ) {
      return;
    }

    // PROTEKSI KHUSUS WAKTU LOSS:
    // Mencegah sesi LOSS terproses sebagai countdown DURASI (yang menyebabkan 00:00:00 HABIS).
    const jenisSesi = String(options.jenisSesi || options.jenis_sesi || "").toUpperCase();
    if (jenisSesi === "LOSS" || (!waktuSelesai && (options.waktuMulai || options.waktu_mulai))) {
      const startVal = options.waktuMulai || options.waktu_mulai;
      if (startVal) {
        return mulaiCountUpLoss(element, startVal, options);
      }
      return function stopNoop() {};
    }

    // Hentikan timer lama jika elemen sudah memiliki active timer.
    if (activeTimers.has(element)) {
      clearInterval(
        activeTimers.get(element)
      );

      activeTimers.delete(element);
    }

    const card = element.closest('.meja-card, .card-meja, .table-card, .meja-item, button');

    const updateDOM = () => {
      const sisa =
        hitungSisaWaktu(
          waktuSelesai
        );

      const status =
        getStatusWaktu(
          waktuSelesai
        );

      element.dataset.statusWaktu =
        status;

      if (sisa.habis) {
        element.textContent =
          "00:00:00";

        element.classList.add(
          "timer-habis"
        );
        element.classList.remove(
          "timer-hampir-habis",
          "timer-loss"
        );

        if (card) {
          card.classList.add("habis");
          card.classList.remove("hampir-habis", "loss");
        }

        if (
          typeof options.onHabis ===
          'function'
        ) {
          options.onHabis(element);
        }
      } else if (sisa.totalMs <= 30 * 60 * 1000) {
        element.textContent =
          formatCountdown(
            waktuSelesai
          );

        element.classList.remove(
          "timer-habis",
          "timer-loss"
        );
        element.classList.add(
          "timer-hampir-habis"
        );

        if (card) {
          card.classList.remove("habis", "loss");
          card.classList.add("hampir-habis");
        }

        if (
          typeof options.onTick ===
          'function'
        ) {
          options.onTick(
            element,
            sisa
          );
        }
      } else {
        element.textContent =
          formatCountdown(
            waktuSelesai
          );

        element.classList.remove(
          "timer-habis",
          "timer-hampir-habis",
          "timer-loss"
        );

        if (card) {
          card.classList.remove("habis", "hampir-habis", "loss");
        }

        if (
          typeof options.onTick ===
          'function'
        ) {
          options.onTick(
            element,
            sisa
          );
        }
      }
    };

    // Jalankan sekali di awal tanpa delay 1 detik.
    updateDOM();

    const intervalId =
      setInterval(
        updateDOM,
        1000
      );

    activeTimers.set(
      element,
      intervalId
    );

    // Mengembalikan fungsi stop countdown.
    return function stopCountdown() {
      if (
        activeTimers.has(element)
      ) {
        clearInterval(
          activeTimers.get(element)
        );

        activeTimers.delete(
          element
        );
      }
    };
  }

  /** Menjalankan count-up real-time pada elemen DOM target (Mode WAKTU LOSS). */
  function mulaiCountUpLoss(
    element,
    waktuMulai,
    options = {}
  ) {
    if (
      !element ||
      !(element instanceof Element)
    ) {
      return;
    }

    // Hentikan timer lama jika elemen sudah memiliki active timer.
    if (activeTimers.has(element)) {
      clearInterval(
        activeTimers.get(element)
      );

      activeTimers.delete(element);
    }

    const card = element.closest('.meja-card, .card-meja, .table-card, .meja-item, button');
    const start = parseDate(waktuMulai);

    const updateDOM = () => {
      if (!start) {
        element.textContent = "00:00:00";
        return;
      }

      const elapsedMs = Math.max(0, Date.now() - start.getTime());
      const totalSeconds = Math.floor(elapsedMs / 1000);

      const jam = Math.floor(totalSeconds / 3600);
      const menit = Math.floor((totalSeconds % 3600) / 60);
      const detik = totalSeconds % 60;

      const h = String(jam).padStart(2, '0');
      const m = String(menit).padStart(2, '0');
      const s = String(detik).padStart(2, '0');

      element.textContent = `${h}:${m}:${s}`;
      element.dataset.statusWaktu = "AKTIF";

      element.classList.remove("timer-habis", "timer-hampir-habis");
      element.classList.add("timer-loss");

      if (card) {
        card.classList.remove("habis", "hampir-habis");
        card.classList.add("loss");
      }

      if (typeof options.onTick === 'function') {
        options.onTick(element, {
          elapsedMs,
          jam,
          menit,
          detik
        });
      }
    };

    // Jalankan sekali di awal.
    updateDOM();

    const intervalId = setInterval(updateDOM, 1000);

    activeTimers.set(
      element,
      intervalId
    );

    // Mengembalikan fungsi stop count-up timer.
    return function stopCountUp() {
      if (activeTimers.has(element)) {
        clearInterval(activeTimers.get(element));
        activeTimers.delete(element);
      }
    };
  }

  /**
   * Menghitung harga sewa meja menggunakan window.PricingMeja
   * berdasarkan data sesi: kategori, durasiJam, dan waktuMulai.
   * (Mode WAKTU LOSS dikecualikan dari kalkulasi frontend).
   */
  function hitungHargaSesiMeja(data) {
    const sesi =
      normalisasiSesiMeja(data);

    if (sesi.jenisSesi === "LOSS") {
      return {
        success: false,
        message: "Harga Waktu Loss dihitung oleh server saat sesi dihentikan"
      };
    }

    const kat = (
      data?.kategori ||
      data?.kategoriId ||
      data?.member?.kategori ||
      data?.member?.kategoriId ||
      ""
    )
      .toString()
      .trim()
      .toUpperCase();

    let kategori =
      "NON_MEMBER";

    if (kat === "PELAJAR") {
      kategori =
        "PELAJAR";
    } else if (kat === "UMUM") {
      kategori =
        "UMUM";
    } else if (kat === "PLATINUM") {
      kategori =
        "PLATINUM";
    }

    if (
      typeof window ===
        "undefined" ||
      !window.PricingMeja
    ) {
      return {
        success: false,
        message:
          "PricingMeja belum tersedia"
      };
    }

    const durasiJam =
      Math.max(
        1,
        Number(
          sesi.durasiJam
        ) || 1
      );

    const waktuMulai =
      sesi.waktuMulai ||
      data?.waktuMulai ||
      data?.waktu_mulai ||
      null;

    if (
      kategori ===
      "PLATINUM"
    ) {
      const hargaPerJam =
        15000;

      return {
        success: true,
        sessionId:
          sesi.sessionId,

        nomorMeja:
          sesi.nomorMeja,

        kategori:
          "PLATINUM",

        durasiJam:
          durasiJam,

        hargaPerJam:
          hargaPerJam,

        total:
          durasiJam *
          hargaPerJam,

        promo: false,

        namaPromo:
          null,

        waktuMulai:
          waktuMulai
      };
    }

    if (
      typeof window
        .PricingMeja
        .hitungHargaMeja !==
      'function'
    ) {
      return {
        success: false,
        message:
          "Fungsi PricingMeja.hitungHargaMeja tidak tersedia"
      };
    }

    const hasil =
      window.PricingMeja
        .hitungHargaMeja(
          kategori,
          durasiJam,
          waktuMulai
        );

    if (
      !hasil ||
      hasil.success !== true
    ) {
      return {
        success: false,
        message:
          hasil
            ? hasil.message
            : "Gagal menghitung harga sewa meja"
      };
    }

    return {
      ...hasil,
      sessionId:
        sesi.sessionId,

      nomorMeja:
        sesi.nomorMeja,

      waktuMulai:
        waktuMulai
    };
  }

  // Global Export ke window.MejaTimer.
  window.MejaTimer = {
    parseDate,
    hitungWaktuSelesai,
    hitungSisaWaktu,
    getStatusWaktu,
    formatCountdown,
    formatCountUp,
    formatJam,
    formatTanggalJam,
    normalisasiSesiMeja,
    mulaiCountdownMeja,
    mulaiCountUpLoss,
    hitungHargaSesiMeja
  };

  // Test ringan di browser.
  if (
    typeof window !==
    "undefined"
  ) {
    setTimeout(() => {
      if (
        window.PricingMeja
      ) {
        console.log(
          "=== DEBUG TEST PRICING MEJA (meja-timer.js) ==="
        );

        console.log(
          "[TEST] PELAJAR 1 jam 10:00:",
          window.MejaTimer
            .hitungHargaSesiMeja({
              member: {
                kategori:
                  "PELAJAR"
              },
              durasiJam: 1,
              waktuMulai:
                "2026-08-24T10:00:00+08:00"
            })
        );

        console.log(
          "[TEST] UMUM 2 jam 10:00:",
          window.MejaTimer
            .hitungHargaSesiMeja({
              member: {
                kategori:
                  "UMUM"
              },
              durasiJam: 2,
              waktuMulai:
                "2026-08-24T10:00:00+08:00"
            })
        );

        console.log(
          "[TEST] PLATINUM 1 jam:",
          window.MejaTimer
            .hitungHargaSesiMeja({
              member: {
                kategori:
                  "PLATINUM"
              },
              durasiJam: 1
            })
        );
      }
    }, 1000);
  }

})();
