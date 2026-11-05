/**
 * promo.js
 * Modul mandiri untuk menghitung harga sewa meja berdasarkan kategori customer, durasi bermain, dan rentang waktu (zona waktu WITA / GMT+8).
 */

function getAturanPromo() {
  return [
    {
      kategori: "PELAJAR",
      hargaNormal: 30000,
      hargaPromo: 10000,
      minimumJamPromo: 1
    },
    {
      kategori: "UMUM",
      hargaNormal: 25000,
      hargaPromo: 15000,
      minimumJamPromo: 2
    },
    {
      kategori: "NON_MEMBER",
      hargaNormal: 30000,
      hargaPromo: 15000,
      minimumJamPromo: 3
    }
  ];
}

function isSesiDalamPromo(waktuMulai, durasiJam) {
  if (!waktuMulai) return true;
  const date = new Date(waktuMulai);
  if (isNaN(date.getTime())) return true;

  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Makassar',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      hour12: false
    });
    const parts = formatter.formatToParts(date);
    let hour = 0, minute = 0, second = 0;
    for (const p of parts) {
      if (p.type === 'hour') hour = parseInt(p.value, 10);
      if (p.type === 'minute') minute = parseInt(p.value, 10);
      if (p.type === 'second') second = parseInt(p.value, 10);
    }
    const startSec = hour * 3600 + minute * 60 + second;
    const endSec = startSec + durasiJam * 3600;

    const promoStartSec = 10 * 3600; // 10:00:00
    const promoEndSec = 18 * 3600;   // 18:00:00

    return startSec >= promoStartSec && endSec <= promoEndSec;
  } catch (e) {
    return true;
  }
}

function hitungHargaSewa({ kategori, durasiJam, waktuMulai }) {
  const validCategories = ["PELAJAR", "UMUM", "NON_MEMBER", "PLATINUM"];
  if (!validCategories.includes(kategori)) {
    return {
      success: false,
      message: "Kategori customer tidak valid"
    };
  }

  const durasi = Math.max(1, Number(durasiJam));
  if (isNaN(durasi) || durasi <= 0) {
    return {
      success: false,
      message: "Durasi sewa tidak valid"
    };
  }

  if (kategori === "PLATINUM") {
    const hargaPerJam = 30000;
    return {
      success: true,
      kategori: "PLATINUM",
      durasiJam: durasi,
      hargaPerJam,
      total: durasi * hargaPerJam,
      promo: false,
      namaPromo: null
    };
  }

  const promoAktif = isSesiDalamPromo(waktuMulai, durasi);

  let hargaPerJam = 0;
  let promo = false;
  let namaPromo = null;

  if (kategori === "PELAJAR") {
    if (promoAktif) {
      hargaPerJam = 10000;
      promo = true;
      namaPromo = "PELAJAR";
    } else {
      hargaPerJam = 30000;
      promo = false;
      namaPromo = null;
    }
  } else if (kategori === "UMUM") {
    if (promoAktif && durasi >= 2) {
      hargaPerJam = 15000;
      promo = true;
      namaPromo = "UMUM_PROMO";
    } else {
      hargaPerJam = 25000;
      promo = false;
      namaPromo = null;
    }
  } else if (kategori === "NON_MEMBER") {
    if (promoAktif && durasi >= 3) {
      hargaPerJam = 15000;
      promo = true;
      namaPromo = "NON_MEMBER_PROMO";
    } else {
      hargaPerJam = 30000;
      promo = false;
      namaPromo = null;
    }
  }

  const total = durasi * hargaPerJam;

  return {
    success: true,
    kategori,
    durasiJam: durasi,
    hargaPerJam,
    total,
    promo,
    namaPromo
  };
}

if (typeof window !== "undefined") {
  window.hitungHargaSewa = hitungHargaSewa;
  window.getAturanPromo = getAturanPromo;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    hitungHargaSewa,
    getAturanPromo
  };
}

if (typeof require !== "undefined" && require.main === module) {
  const testCases = [
    { kategori: "PELAJAR", durasiJam: 1, waktuMulai: "2026-08-24T10:00:00+08:00" },
    { kategori: "PELAJAR", durasiJam: 1, waktuMulai: "2026-08-24T18:00:00+08:00" },
    { kategori: "UMUM", durasiJam: 1, waktuMulai: "2026-08-24T10:00:00+08:00" },
    { kategori: "UMUM", durasiJam: 2, waktuMulai: "2026-08-24T10:00:00+08:00" },
    { kategori: "UMUM", durasiJam: 2, waktuMulai: "2026-08-24T17:00:00+08:00" },
    { kategori: "NON_MEMBER", durasiJam: 2, waktuMulai: "2026-08-24T10:00:00+08:00" },
    { kategori: "NON_MEMBER", durasiJam: 3, waktuMulai: "2026-08-24T10:00:00+08:00" },
    { kategori: "NON_MEMBER", durasiJam: 3, waktuMulai: "2026-08-24T17:00:00+08:00" },
    { kategori: "NON_MEMBER", durasiJam: 1, waktuMulai: "2026-08-24T20:00:00+08:00" }
  ];

  console.log("=== ATURAN PROMO ===");
  console.log(JSON.stringify(getAturanPromo(), null, 2));

  console.log("\n=== HASIL TEST HITUNG HARGA SEWA ===");
  testCases.forEach((test, index) => {
    const hasil = hitungHargaSewa(test);
    console.log(`Test ${index + 1} (${test.kategori}, ${test.durasiJam} jam, mulai: ${test.waktuMulai}):`, hasil);
  });
}