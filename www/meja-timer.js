// ==================================================
// MEJA TIMER LIBRARY (meja-timer.js)
// ==================================================

(function () {
  'use strict';

  // Menyimpan referensi interval countdown per elemen DOM
  const activeTimers = new WeakMap();

  /**
   * Helper parse date yang aman untuk berbagai format string atau objek Date
   */
  function parseDate(value) {
    if (!value) return null;
    if (value instanceof Date) {
      return isNaN(value.getTime()) ? null : value;
    }
    
    // Jika format string ISO atau SQLite (YYYY-MM-DD HH:mm:ss / YYYY-MM-DDTHH:mm:ss.sssZ)
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

  /**
   * Menghitung waktu selesai berdasarkan waktu mulai dan durasi (dalam jam)
   */
  function hitungWaktuSelesai(waktuMulai, durasiJam) {
    const start = parseDate(waktuMulai);
    if (!start) return null;

    const durasiMs = Number(durasiJam || 0) * 3600 * 1000;
    return new Date(start.getTime() + durasiMs);
  }

  /**
   * Menghitung sisa waktu secara real-time terhadap waktu selesai
   */
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

    const totalMs = end.getTime() - now.getTime();

    if (totalMs <= 0) {
      return {
        habis: true,
        totalMs: 0,
        jam: 0,
        menit: 0,
        detik: 0
      };
    }

    const totalDetik = Math.floor(totalMs / 1000);
    const jam = Math.floor(totalDetik / 3600);
    const menit = Math.floor((totalDetik % 3600) / 60);
    const detik = totalDetik % 60;

    return {
      habis: false,
      totalMs,
      jam,
      menit,
      detik
    };
  }

  /**
   * Menentukan status waktu ("AKTIF" atau "HABIS")
   */
  function getStatusWaktu(waktuSelesai) {
    const sisa = hitungSisaWaktu(waktuSelesai);
    return sisa.habis ? "HABIS" : "AKTIF";
  }

  /**
   * Memformat countdown menjadi string HH:mm:ss atau "WAKTU HABIS"
   */
  function formatCountdown(waktuSelesai) {
    const sisa = hitungSisaWaktu(waktuSelesai);
    if (sisa.habis) {
      return "WAKTU HABIS";
    }

    const h = String(sisa.jam).padStart(2, '0');
    const m = String(sisa.menit).padStart(2, '0');
    const s = String(sisa.detik).padStart(2, '0');

    return `${h}:${m}:${s}`;
  }

  /**
   * Memformat nilai waktu menjadi string jam (HH:mm:ss)
   */
  function formatJam(value) {
    const date = parseDate(value);
    if (!date) return "-";

    const h = String(date.getHours()).padStart(2, '0');
    const m = String(date.getMinutes()).padStart(2, '0');
    const s = String(date.getSeconds()).padStart(2, '0');

    return `${h}:${m}:${s}`;
  }

  /**
   * Memformat nilai waktu menjadi string tanggal & jam (DD/MM/YYYY HH:mm:ss)
   */
  function formatTanggalJam(value) {
    const date = parseDate(value);
    if (!date) return "-";

    const dd = String(date.getDate()).padStart(2, '0');
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const yyyy = date.getFullYear();

    const h = String(date.getHours()).padStart(2, '0');
    const m = String(date.getMinutes()).padStart(2, '0');
    const s = String(date.getSeconds()).padStart(2, '0');

    return `${dd}/${mm}/${yyyy} ${h}:${m}:${s}`;
  }

  /**
   * Normalisasi data sesi meja untuk mendukung berbagai variasi key (camelCase / snake_case)
   */
  function normalisasiSesiMeja(data) {
    if (!data || typeof data !== 'object') {
      return {
        sessionId: "",
        nomorMeja: 0,
        namaPemesan: "",
        kasir: "",
        waktuMulai: null,
        durasiJam: 0,
        waktuSelesai: null,
        status: "AKTIF",
        statusWaktu: "AKTIF"
      };
    }

    const sessionId = data.sessionId || data.session_id || "";
    const nomorMeja = Number(data.nomorMeja || data.nomor_meja || 0);
    const namaPemesan = data.namaPemesan || data.nama_pemesan || "";
    const kasir = data.kasir || "";
    
    const waktuMulaiVal = data.waktuMulai || data.waktu_mulai || null;
    const durasiJamVal = Number(data.durasiJam !== undefined ? data.durasiJam : (data.durasi_jam !== undefined ? data.durasi_jam : 0));
    
    let waktuSelesaiVal = data.waktuSelesai || data.waktu_selesai || null;

    if (!waktuSelesaiVal && waktuMulaiVal && durasiJamVal > 0) {
      const calculatedEnd = hitungWaktuSelesai(waktuMulaiVal, durasiJamVal);
      if (calculatedEnd) {
        waktuSelesaiVal = calculatedEnd.toISOString();
      }
    }

    // Status database tetap mengikuti data sumber (tidak dioverwrite oleh waktu)
    const status = String(data.status || "AKTIF").toUpperCase();
    
    // Status waktu (timer) dihitung terpisah
    const statusWaktu = waktuSelesaiVal ? getStatusWaktu(waktuSelesaiVal) : "AKTIF";

    return {
      sessionId,
      nomorMeja,
      namaPemesan,
      kasir,
      waktuMulai: waktuMulaiVal,
      durasiJam: durasiJamVal,
      waktuSelesai: waktuSelesaiVal,
      status,
      statusWaktu
    };
  }

  /**
   * Menjalankan countdown real-time pada elemen DOM target
   */
  function mulaiCountdownMeja(element, waktuSelesai, options = {}) {
    if (!element || !(element instanceof Element)) return;

    // Hentikan timer lama jika elemen sudah memiliki active timer
    if (activeTimers.has(element)) {
      clearInterval(activeTimers.get(element));
      activeTimers.delete(element);
    }

    const updateDOM = () => {
      const sisa = hitungSisaWaktu(waktuSelesai);
      const status = getStatusWaktu(waktuSelesai);

      element.dataset.statusWaktu = status;

      if (sisa.habis) {
        element.textContent = "WAKTU HABIS";
        element.classList.add("timer-habis");
        if (typeof options.onHabis === 'function') {
          options.onHabis(element);
        }
      } else {
        element.textContent = formatCountdown(waktuSelesai);
        element.classList.remove("timer-habis");
        if (typeof options.onTick === 'function') {
          options.onTick(element, sisa);
        }
      }
    };

    // Jalankan sekali di awal tanpa delay 1 detik
    updateDOM();

    const intervalId = setInterval(updateDOM, 1000);
    activeTimers.set(element, intervalId);

    // Mengembalikan fungsi stop countdown untuk elemen ini
    return function stopCountdown() {
      if (activeTimers.has(element)) {
        clearInterval(activeTimers.get(element));
        activeTimers.delete(element);
      }
    };
  }

  // Global Export ke window.MejaTimer
  window.MejaTimer = {
    parseDate,
    hitungWaktuSelesai,
    hitungSisaWaktu,
    getStatusWaktu,
    formatCountdown,
    formatJam,
    formatTanggalJam,
    normalisasiSesiMeja,
    mulaiCountdownMeja
  };

})();