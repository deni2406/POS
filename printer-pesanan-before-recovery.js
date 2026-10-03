(() => {
  console.log("[PRINTER PESANAN] Modul berhasil dimuat.");
})();

const PRINTER_PESANAN_CONFIG_KEY = "pbms_printer_pesanan";

const printerPesananConfig = {
  bar: {
    name: "",
    address: ""
  },
  dapur: {
    name: "",
    address: ""
  }
};

const printerPesananState = {
  bar: {
    hashKey: null,
    address: null,
    connected: false
  },
  dapur: {
    hashKey: null,
    address: null,
    connected: false
  }
};

// C:\POS\printer-pesanan.js

// Tambahkan setelah printerPesananState didefinisikan.
  }
}

function ambilStatePrinterPesanan(jenis) {
  if (jenis !== "bar" && jenis !== "dapur") {
    throw new Error("Jenis printer tidak valid.");
  }

  return printerPesananState[jenis];
}

async function hubungkanPrinterPesanan(jenis, address, name = "") {
  if (jenis !== "bar" && jenis !== "dapur") {
    throw new Error("Jenis printer tidak valid.");
  }

  if (!address) {
    throw new Error(`MAC Address printer ${jenis.toUpperCase()} belum diisi.`);
  }

  const printerApi = window.PBMSBluetoothPrinter;

  if (!printerApi || typeof printerApi.getPrinterPlugin !== "function") {
    throw new Error("API printer Bluetooth belum tersedia.");
  }

  const plugin = printerApi.getPrinterPlugin();

  try {
    const state = printerPesananState[jenis];

    if (state.hashKey) {
      try {
        await plugin.disconnectPrinter({
          hashKey: state.hashKey
        });
      } catch (error) {
        console.warn(
          `[PRINTER PESANAN] Disconnect ${jenis} sebelumnya gagal:`,
          error
        );
      }

      try {
        await plugin.disposePrinter({
          hashKey: state.hashKey
        });
      } catch (error) {
        console.warn(
          `[PRINTER PESANAN] Dispose ${jenis} sebelumnya gagal:`,
          error
        );
      }
    }

    const created = await plugin.createPrinter({
      connectionType: "bluetooth",
      address
    });

    const hashKey = created?.value;

    if (!hashKey) {
      throw new Error(`HashKey printer ${jenis.toUpperCase()} tidak ditemukan.`);
    }

    await plugin.connectPrinter({
      hashKey
    });

    const connected = await plugin.isPrinterConnected({
      hashKey
    });

    if (!connected?.value) {
      throw new Error(`Printer ${jenis.toUpperCase()} gagal terhubung.`);
    }

    state.hashKey = hashKey;
    state.address = address;
    state.connected = true;

    const config = ambilConfigPrinterPesanan();

    config[jenis] = {
      name: name || "",
      address
    };

    simpanConfigPrinterPesanan(config);

    console.log(`[PRINTER PESANAN] ${jenis.toUpperCase()} terhubung:`, {
      name,
      address,
      hashKey
    });

    return {
      success: true,
      jenis,
      name,
      address,
      hashKey
    };
  } catch (error) {
    printerPesananState[jenis].hashKey = null;
    printerPesananState[jenis].address = null;
    printerPesananState[jenis].connected = false;

    console.error(
      `[PRINTER PESANAN] Gagal menghubungkan ${jenis.toUpperCase()}:`,
      error
    );

    return {
      success: false,
      jenis,
      message:
        error?.message ||
        `Gagal menghubungkan printer ${jenis.toUpperCase()}.`
    };
  }
}

window.hubungkanPrinterPesanan = hubungkanPrinterPesanan;

function ambilSemuaStatePrinterPesanan() {
  return {
    bar: { ...printerPesananState.bar },
    dapur: { ...printerPesananState.dapur }
  };
}

window.ambilSemuaStatePrinterPesanan = ambilSemuaStatePrinterPesanan;

async function putuskanPrinterPesanan(jenis) {
  if (jenis !== "bar" && jenis !== "dapur") {
    throw new Error("Jenis printer tidak valid.");
  }

  const printerApi = window.PBMSBluetoothPrinter;

  if (!printerApi || typeof printerApi.getPrinterPlugin !== "function") {
    throw new Error("API printer Bluetooth belum tersedia.");
  }

  const plugin = printerApi.getPrinterPlugin();
  const state = printerPesananState[jenis];

  if (!state.hashKey) {
    return {
      success: false,
      jenis,
      message: `Printer ${jenis.toUpperCase()} tidak sedang terhubung.`
    };
  }

  try {
    const hashKey = state.hashKey;

    await plugin.disconnectPrinter({
      hashKey
    });

    await plugin.disposePrinter({
      hashKey
    });

    state.hashKey = null;
    state.address = null;
    state.connected = false;

    console.log(
      `[PRINTER PESANAN] ${jenis.toUpperCase()} berhasil diputuskan.`
    );

    return {
      success: true,
      jenis
    };
  } catch (error) {
    console.error(
      `[PRINTER PESANAN] Gagal memutuskan ${jenis.toUpperCase()}:`,
      error
    );

    return {
      success: false,
      jenis,
      message:
        error?.message ||
        `Gagal memutuskan printer ${jenis.toUpperCase()}.`
    };
  }
}

window.putuskanPrinterPesanan = putuskanPrinterPesanan;

const PRINTER_PESANAN_COUNTER_KEY = "pbms_printer_pesanan_counter";

function ambilNomorPesananHarian(jenis) {
  const sekarang = new Date();
  const bulan =
    `${sekarang.getFullYear()}-${String(sekarang.getMonth() + 1).padStart(2, "0")}`;

  let data = {};

  try {
    const saved = localStorage.getItem(PRINTER_PESANAN_COUNTER_KEY);
    data = saved ? JSON.parse(saved) : {};
  } catch (error) {
    console.warn("[PRINTER PESANAN] Counter gagal dibaca:", error);
  }

  if (data.bulan !== bulan) {
    data = {
      bulan,
      bar: 0,
      dapur: 0
    };
  }

  data[jenis] = Number(data[jenis] || 0) + 1;

  localStorage.setItem(
    PRINTER_PESANAN_COUNTER_KEY,
    JSON.stringify(data)
  );

  return data[jenis];
}


function buatTiketPesanan(data) {
  const jenis = String(data?.jenis || "").trim().toUpperCase();
  const nomorPesanan = Number(data?.nomorPesanan || 0);
  const meja = data?.meja || "-";
  const sessionId = data?.sessionId || "-";
  const pemesan = String(data?.pemesan || "").trim();
  const items = Array.isArray(data?.items) ? data.items : [];

  const garis = "--------------------------------";

  let teks = "";

  teks += "       POLLARD BILLIARD\n";
  teks += garis + "\n";
  teks += `         PESANAN ${jenis || "-"}\n`;
  teks += `PESANAN KE : ${nomorPesanan || "-"}\n`;
  teks += garis + "\n";
  teks += `MEJA     : ${meja}\n`;
  if (pemesan) {
    teks += `PEMESAN  : ${pemesan}\n`;
  }
  teks += `SESSION  : ${sessionId}\n`;
  teks += garis + "\n";

  for (const item of items) {
    teks += `${item?.nama || "-"}\n`;
    teks += `QTY      : ${Number(item?.qty || 0)}\n`;
    teks += "\n";
  }

  teks += garis + "\n";
  teks += "        SEGERA DIPROSES\n";
  teks += "\n\n\n";

  return teks;
}

window.buatTiketPesanan = buatTiketPesanan;

async function cetakTiketPesanan(jenis, data) {
  if (jenis !== "bar" && jenis !== "dapur") {
    throw new Error("Jenis printer tidak valid.");
  }

  const printerApi = window.PBMSBluetoothPrinter;

  if (!printerApi || typeof printerApi.getPrinterPlugin !== "function") {
    throw new Error("API printer Bluetooth belum tersedia.");
  }

  const plugin = printerApi.getPrinterPlugin();
  const state = printerPesananState[jenis];

  if (!state.hashKey) {
    return {
      success: false,
      jenis,
      message: `Printer ${jenis.toUpperCase()} belum terhubung.`
    };
  }

  try {
    const connected = await plugin.isPrinterConnected({
      hashKey: state.hashKey
    });

    if (!connected?.value) {
      state.connected = false;

      return {
        success: false,
        jenis,
        message: `Printer ${jenis.toUpperCase()} tidak terhubung.`
      };
    }

    const nomorPesanan = ambilNomorPesananHarian(jenis);
    const teks = buatTiketPesanan({
      ...data,
      jenis,
      nomorPesanan
    });

    const encoder = new TextEncoder();
    const textBytes = Array.from(encoder.encode(teks));

    const printerData = [
      0x1B, 0x40,
      ...textBytes,
      0x0A,
      0x0A,
      0x0A
    ];

    await plugin.sendToPrinter({
      hashKey: state.hashKey,
      data: printerData,
      waitingTime: 1000
    });

    console.log(
      `[PRINTER PESANAN] Tiket ${jenis.toUpperCase()} berhasil dikirim.`
    );

    return {
      success: true,
      jenis
    };
  } catch (error) {
    console.error(
      `[PRINTER PESANAN] Gagal mencetak tiket ${jenis.toUpperCase()}:`,
      error
    );

    return {
      success: false,
      jenis,
      message:
        error?.message ||
        `Gagal mencetak tiket ${jenis.toUpperCase()}.`
    };
  }
}

window.cetakTiketPesanan = cetakTiketPesanan;

async function cetakPesananBerdasarkanKategori(data) {
  const items = Array.isArray(data?.items) ? data.items : [];

  if (items.length === 0) {
    return {
      success: true,
      message: "Tidak ada pesanan untuk dicetak."
    };
  }

  const kelompok = kelompokkanPesananByKategori(items);

  const hasil = {
    bar: null,
    dapur: null
  };

  if (kelompok.bar.length > 0) {
    hasil.bar = await cetakTiketPesanan("bar", {
      meja: data?.meja || "-",
      sessionId: data?.sessionId || "-",
      pemesan: data?.pemesan || "",
      items: kelompok.bar
    });
  }

  if (kelompok.dapur.length > 0) {
    hasil.dapur = await cetakTiketPesanan("dapur", {
      meja: data?.meja || "-",
      sessionId: data?.sessionId || "-",
      pemesan: data?.pemesan || "",
      items: kelompok.dapur
    });
  }

  console.log("[PRINTER PESANAN] Hasil cetak:", hasil);

  return {
    success: true,
    kelompok,
    hasil
  };
}

window.cetakPesananBerdasarkanKategori = cetakPesananBerdasarkanKategori;

window.ambilStatePrinterPesanan = ambilStatePrinterPesanan;

function ambilConfigPrinterPesanan() {
  try {
    const saved = localStorage.getItem(PRINTER_PESANAN_CONFIG_KEY);

    if (!saved) {
      return structuredClone(printerPesananConfig);
    }

    const data = JSON.parse(saved);

    return {
      bar: {
        name: data?.bar?.name || "",
        address: data?.bar?.address || ""
      },
      dapur: {
        name: data?.dapur?.name || "",
        address: data?.dapur?.address || ""
      }
    };
  } catch (error) {
    console.error("[PRINTER PESANAN] Gagal membaca konfigurasi:", error);

    return structuredClone(printerPesananConfig);
  }
}

function simpanConfigPrinterPesanan(config) {
  try {
    localStorage.setItem(
      PRINTER_PESANAN_CONFIG_KEY,
      JSON.stringify(config)
    );

    return true;
  } catch (error) {
    console.error("[PRINTER PESANAN] Gagal menyimpan konfigurasi:", error);
    return false;
  }
}

window.ambilConfigPrinterPesanan = ambilConfigPrinterPesanan;
window.simpanConfigPrinterPesanan = simpanConfigPrinterPesanan;

const printerPesananTerpilih = {
  bar: null,
  dapur: null
};

async function cariPrinterPesananUI(jenis) {
  if (jenis !== "bar" && jenis !== "dapur") {
    alert("Jenis printer tidak valid.");
    return;
  }

  if (typeof window.cariPrinterBluetooth !== "function") {
    alert("Modul pencarian printer Bluetooth belum tersedia.");
    return;
  }

  try {
    const devices = await window.cariPrinterBluetooth();

    const daftarEl = document.getElementById(
      jenis === "bar" ? "daftarPrinterBar" : "daftarPrinterDapur"
    );

    if (daftarEl) {
      daftarEl.innerHTML = "";
    }

    if (!devices || devices.length === 0) {
      printerPesananTerpilih[jenis] = null;

      if (daftarEl) {
        daftarEl.textContent = "Tidak ada printer Bluetooth yang ditemukan.";
      }

      alert("Tidak ada printer Bluetooth yang ditemukan.");
      return;
    }

    console.log(
      `[PRINTER PESANAN] Hasil pencarian ${jenis.toUpperCase()}:`,
      devices
    );

    devices.forEach((device) => {
      const item = document.createElement("div");

      const nama =
        device.name ||
        device.alias ||
        "Tanpa Nama";

      const address =
        device.address ||
        "-";

      item.style.padding = "10px";
      item.style.marginBottom = "8px";
      item.style.border = "1px solid #d1d5db";
      item.style.borderRadius = "5px";
      item.style.cursor = "pointer";
      item.style.background = "#ffffff";

      item.innerHTML =
        `<strong>${nama}</strong><br>` +
        `<span style="font-family: monospace;">${address}</span>`;

      item.addEventListener("click", () => {
        printerPesananTerpilih[jenis] = device;

        if (daftarEl) {
          Array.from(daftarEl.children).forEach((child) => {
            child.style.border = "1px solid #d1d5db";
            child.style.background = "#ffffff";
          });
        }

        item.style.border = "2px solid #007bff";
        item.style.background = "#e7f1ff";

        const namaEl = document.getElementById(
          jenis === "bar" ? "namaPrinterBar" : "namaPrinterDapur"
        );

        const macEl = document.getElementById(
          jenis === "bar" ? "macPrinterBar" : "macPrinterDapur"
        );

        if (namaEl) {
          namaEl.textContent = nama;
        }

        if (macEl) {
          macEl.textContent = address;
        }

        console.log(
          `[PRINTER PESANAN] Printer ${jenis.toUpperCase()} dipilih:`,
          device
        );
      });

      if (daftarEl) {
        daftarEl.appendChild(item);
      }
    });

    console.log(
      `[PRINTER PESANAN] ${devices.length} printer ditampilkan untuk ${jenis.toUpperCase()}.`
    );
  } catch (error) {
    console.error(
      `[PRINTER PESANAN] Gagal mencari printer ${jenis.toUpperCase()}:`,
      error
    );

    printerPesananTerpilih[jenis] = null;

    const daftarEl = document.getElementById(
      jenis === "bar" ? "daftarPrinterBar" : "daftarPrinterDapur"
    );

    if (daftarEl) {
      daftarEl.textContent = "Gagal mencari printer Bluetooth.";
    }

    alert("Gagal mencari printer Bluetooth.");
  }
}

window.cariPrinterPesananUI = cariPrinterPesananUI;

function simpanPrinterPesananUI(jenis) {
  if (jenis !== "bar" && jenis !== "dapur") {
    alert("Jenis printer tidak valid.");
    return;
  }

  const printer = printerPesananTerpilih[jenis];

  if (!printer || !printer.address) {
    alert(`Pilih printer ${jenis.toUpperCase()} terlebih dahulu.`);
    return;
  }

  const name = printer.name || printer.alias || "";

  const config = ambilConfigPrinterPesanan();

  config[jenis] = {
    name,
    address: printer.address
  };

  const berhasil = simpanConfigPrinterPesanan(config);

  if (!berhasil) {
    alert(`Gagal menyimpan konfigurasi printer ${jenis.toUpperCase()}.`);
    return;
  }

  const namaEl = document.getElementById(
    jenis === "bar" ? "namaPrinterBar" : "namaPrinterDapur"
  );

  const macEl = document.getElementById(
    jenis === "bar" ? "macPrinterBar" : "macPrinterDapur"
  );

  if (namaEl) {
    namaEl.textContent = name || "-";
  }

  if (macEl) {
    macEl.textContent = printer.address || "-";
  }

  console.log(
    `[PRINTER PESANAN] Konfigurasi ${jenis.toUpperCase()} berhasil disimpan:`,
    config[jenis]
  );

  alert(`Printer ${jenis.toUpperCase()} berhasil disimpan.`);
}

window.simpanPrinterPesananUI = simpanPrinterPesananUI;

async function hubungkanPrinterPesananUI(jenis) {
  if (jenis !== "bar" && jenis !== "dapur") {
    alert("Jenis printer tidak valid.");
    return;
  }

  const config = ambilConfigPrinterPesanan();
  const printer = config?.[jenis];

  if (!printer?.address) {
    alert(`Printer ${jenis.toUpperCase()} belum disimpan.`);
    return;
  }

  const statusEl = document.getElementById(
    jenis === "bar" ? "statusPrinterBar" : "statusPrinterDapur"
  );

  if (statusEl) {
    statusEl.textContent = "Menghubungkan...";
    statusEl.style.color = "#f59e0b";
  }

  try {
    const hasil = await window.hubungkanPrinterPesanan(
      jenis,
      printer.address,
      printer.name || ""
    );

    if (hasil?.success === true) {
      if (statusEl) {
        statusEl.textContent = "Terhubung";
        statusEl.style.color = "#16a34a";
      }

      alert(`Printer ${jenis.toUpperCase()} berhasil terhubung.`);
      return;
    }

    if (statusEl) {
      statusEl.textContent = "Tidak Terhubung";
      statusEl.style.color = "red";
    }

    alert(
      `Gagal menghubungkan printer ${jenis.toUpperCase()}:\n` +
      (hasil?.message || "Koneksi gagal.")
    );
  } catch (error) {
    console.error(
      `[PRINTER PESANAN] UI koneksi ${jenis.toUpperCase()} gagal:`,
      error
    );

    if (statusEl) {
      statusEl.textContent = "Tidak Terhubung";
      statusEl.style.color = "red";
    }

    alert(`Gagal menghubungkan printer ${jenis.toUpperCase()}.`);
  }
}

window.hubungkanPrinterPesananUI = hubungkanPrinterPesananUI;

function muatKonfigurasiPrinterPesananUI() {
  const config = ambilConfigPrinterPesanan();

  const data = {
    bar: {
      nama: config?.bar?.name || "-",
      address: config?.bar?.address || "-"
    },
    dapur: {
      nama: config?.dapur?.name || "-",
      address: config?.dapur?.address || "-"
    }
  };

  const namaBarEl = document.getElementById("namaPrinterBar");
  const macBarEl = document.getElementById("macPrinterBar");

  const namaDapurEl = document.getElementById("namaPrinterDapur");
  const macDapurEl = document.getElementById("macPrinterDapur");

  if (namaBarEl) namaBarEl.textContent = data.bar.nama;
  if (macBarEl) macBarEl.textContent = data.bar.address;

  if (namaDapurEl) namaDapurEl.textContent = data.dapur.nama;
  if (macDapurEl) macDapurEl.textContent = data.dapur.address;

  perbaruiStatusPrinterPesananUI("bar");
  perbaruiStatusPrinterPesananUI("dapur");

  console.log("[PRINTER PESANAN] Konfigurasi UI dimuat:", data);
}

window.muatKonfigurasiPrinterPesananUI =
  muatKonfigurasiPrinterPesananUI;

function perbaruiStatusPrinterPesananUI(jenis) {
  if (jenis !== "bar" && jenis !== "dapur") {
    return;
  }

  const state = ambilStatePrinterPesanan(jenis);
  const config = ambilConfigPrinterPesanan();

  const statusEl = document.getElementById(
    jenis === "bar" ? "statusPrinterBar" : "statusPrinterDapur"
  );

  if (!statusEl) {
    return;
  }

  if (state?.connected && state?.hashKey) {
    statusEl.textContent = "Terhubung";
    statusEl.style.color = "#16a34a";
    return;
  }

  if (config?.[jenis]?.address) {
    statusEl.textContent = "Tersimpan";
    statusEl.style.color = "#2563eb";
    return;
  }

  statusEl.textContent = "Belum Diatur";
  statusEl.style.color = "#666";
}

window.perbaruiStatusPrinterPesananUI =
  perbaruiStatusPrinterPesananUI;

function kelompokkanPesananByKategori(items) {
  const hasil = {
    bar: [],
    dapur: [],
    lainnya: []
  };

  if (!Array.isArray(items)) {
    return hasil;
  }

  for (const item of items) {
    if (!item || !item.nama) {
      hasil.lainnya.push(item);
      continue;
    }

    const master = Array.isArray(masterBarang)
      ? masterBarang.find(
          x =>
            String(x.nama || "").trim().toLowerCase() ===
            String(item.nama || "").trim().toLowerCase()
        )
      : null;

    const kategori = String(master?.kategori || "")
      .trim()
      .toUpperCase();

    if (kategori === "BAR") {
      hasil.bar.push(item);
    } else if (kategori === "DAPUR") {
      hasil.dapur.push(item);
    } else {
      hasil.lainnya.push(item);
    }
  }

  return hasil;
}

window.kelompokkanPesananByKategori = kelompokkanPesananByKategori;
