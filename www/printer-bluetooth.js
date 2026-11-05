(() => {
  let bluetoothPrinterHashKey = null;
  let bluetoothPrinterAddress = null;
  let bluetoothPrinterName = "RPP02N";
  let printerReconnectPromise = null;

const PRINTER_CONFIG_KEY = "pbms_printer_bluetooth";

function getPrinterConfig() {
  try {
    const saved = localStorage.getItem(PRINTER_CONFIG_KEY);
    return saved ? JSON.parse(saved) : null;
  } catch (error) {
    console.error("Gagal membaca konfigurasi printer:", error);
    return null;
  }
}

function savePrinterConfig(config) {
  try {
    localStorage.setItem(
      PRINTER_CONFIG_KEY,
      JSON.stringify(config)
    );
    return true;
  } catch (error) {
    console.error("Gagal menyimpan konfigurasi printer:", error);
    return false;
  }
}

function clearPrinterConfig() {
  localStorage.removeItem(PRINTER_CONFIG_KEY);
}

  function getPrinterPlugin() {
    const plugins = window.Capacitor && window.Capacitor.Plugins;
    const plugin = plugins && plugins.EscPosPrinter;

    if (!plugin) {
      throw new Error(
        "Plugin EscPosPrinter tidak tersedia. Pastikan aplikasi dijalankan melalui Capacitor Android."
      );
    }

    return plugin;
  }

  async function cariPrinterBluetooth() {
    try {
      const { devices } =
        await getPrinterPlugin().getBluetoothPrinterDevices();

      console.log("Bluetooth printers:", devices);
      return devices || [];
    } catch (error) {
      console.error("Gagal mencari printer Bluetooth:", error);
      return [];
    }
  }

  async function hubungkanPrinterBluetooth(address) {
  if (!address) {
    throw new Error("Alamat printer Bluetooth belum tersedia.");
  }

  const plugin = getPrinterPlugin();
  const previousHashKey = bluetoothPrinterHashKey;

  bluetoothPrinterAddress = address;

  try {
    if (previousHashKey) {
      try {
        await plugin.disconnectPrinter({
          hashKey: previousHashKey
        });
      } catch (error) {
        console.warn("Disconnect printer lama gagal:", error);
      }

      try {
        await plugin.disposePrinter({
          hashKey: previousHashKey
        });
      } catch (error) {
        console.warn("Dispose printer lama gagal:", error);
      }

      bluetoothPrinterHashKey = null;
    }

    const created = await plugin.createPrinter({
      connectionType: "bluetooth",
      address
    });

    const hashKey = created?.value;

    if (!hashKey) {
      throw new Error("HashKey printer tidak ditemukan.");
    }

    try {
      await plugin.connectPrinter({
        hashKey
      });

      const connected = await plugin.isPrinterConnected({
        hashKey
      });

      if (!connected?.value) {
        throw new Error("Printer gagal terhubung.");
      }
    } catch (error) {
      try {
        await plugin.disconnectPrinter({
          hashKey
        });
      } catch (disconnectError) {
        console.warn(
          "Disconnect printer baru gagal:",
          disconnectError
        );
      }

      try {
        await plugin.disposePrinter({
          hashKey
        });
      } catch (disposeError) {
        console.warn(
          "Dispose printer baru gagal:",
          disposeError
        );
      }

      throw error;
    }

    bluetoothPrinterHashKey = hashKey;
    bluetoothPrinterAddress = address;

    savePrinterConfig({
      address,
      name: bluetoothPrinterName
    });

    console.log("Printer Bluetooth terhubung:", {
      address,
      hashKey
    });

    return {
      success: true,
      hashKey,
      address
    };
  } catch (error) {
    console.error("Gagal menghubungkan printer Bluetooth:", error);

    bluetoothPrinterHashKey = null;

    // Address sengaja dipertahankan agar auto-reconnect masih bisa dilakukan.
    bluetoothPrinterAddress = address;

    return {
      success: false,
      message: error?.message || "Gagal menghubungkan printer."
    };
  }
}

  async function reconnectPrinterBluetooth() {
  if (printerReconnectPromise) {
    return printerReconnectPromise;
  }

  const address = bluetoothPrinterAddress;

  if (!address) {
    throw new Error("Alamat printer Bluetooth tidak tersedia.");
  }

  printerReconnectPromise = (async () => {
    const result = await hubungkanPrinterBluetooth(address);

    if (!result?.success) {
      bluetoothPrinterAddress = address;

      throw new Error(
        result?.message ||
        "Gagal melakukan auto-reconnect printer Bluetooth."
      );
    }

    return result;
  })();

  try {
    return await printerReconnectPromise;
  } finally {
    printerReconnectPromise = null;
  }
}

async function ensurePrinterReady() {
  const plugin = getPrinterPlugin();

  if (!bluetoothPrinterAddress) {
    const config = getPrinterConfig();

    if (config?.address) {
      bluetoothPrinterAddress = config.address;
      bluetoothPrinterName = config.name || bluetoothPrinterName;
    }
  }

  if (!bluetoothPrinterAddress) {
    throw new Error("Printer Bluetooth belum dikonfigurasi.");
  }

  if (bluetoothPrinterHashKey) {
    try {
      const connected = await plugin.isPrinterConnected({
        hashKey: bluetoothPrinterHashKey
      });

      if (connected?.value) {
        return bluetoothPrinterHashKey;
      }
    } catch (error) {
      console.warn(
        "Status printer lama tidak dapat diperiksa:",
        error
      );
    }

    const staleHashKey = bluetoothPrinterHashKey;

    bluetoothPrinterHashKey = null;

    try {
      await plugin.disconnectPrinter({
        hashKey: staleHashKey
      });
    } catch (error) {
      console.warn(
        "Disconnect hashKey lama gagal:",
        error
      );
    }

    try {
      await plugin.disposePrinter({
        hashKey: staleHashKey
      });
    } catch (error) {
      console.warn(
        "Dispose hashKey lama gagal:",
        error
      );
    }
  }

  const result = await reconnectPrinterBluetooth();

  if (!result?.hashKey) {
    throw new Error("Printer Bluetooth gagal disiapkan.");
  }

  return result.hashKey;
}

  window.cariPrinterBluetooth = cariPrinterBluetooth;
  window.bukaPrinterBluetooth = cariPrinterBluetooth;
  window.hubungkanPrinterBluetooth = hubungkanPrinterBluetooth;

  async function putuskanPrinterBluetooth() {
  try {
    const plugin = getPrinterPlugin();

    if (!bluetoothPrinterHashKey) {
      return {
        success: false,
        message: "Printer Bluetooth tidak sedang terhubung."
      };
    }

    const hashKey = bluetoothPrinterHashKey;

    await plugin.disconnectPrinter({
    hashKey
  });

    await plugin.disposePrinter({
    hashKey
  });

    bluetoothPrinterHashKey = null;
    bluetoothPrinterAddress = null;

    return {
      success: true
    };
  } catch (error) {
    console.error("Gagal memutuskan printer Bluetooth:", error);

    return {
      success: false,
      message: error?.message || "Gagal memutuskan printer Bluetooth."
    };
  }
}

  window.putuskanPrinterBluetooth = putuskanPrinterBluetooth;


  window.PBMSBluetoothPrinter = {
  getPrinterPlugin,
  getPrinterConfig,
  getState: () => ({
    bluetoothPrinterHashKey,
    bluetoothPrinterAddress,
    bluetoothPrinterName
  }),

  sendToConnectedPrinter: async (data) => {
  const hashKey = await ensurePrinterReady();

  try {
    return await getPrinterPlugin().sendToPrinter({
      hashKey,
      data,
      waitingTime: 1000
    });
  } catch (error) {
    const failedHashKey = bluetoothPrinterHashKey;

    bluetoothPrinterHashKey = null;

    try {
      if (failedHashKey) {
        await getPrinterPlugin().disconnectPrinter({
          hashKey: failedHashKey
        });
      }
    } catch (disconnectError) {
      console.warn(
        "Disconnect setelah gagal print tidak berhasil:",
        disconnectError
      );
    }

    try {
      if (failedHashKey) {
        await getPrinterPlugin().disposePrinter({
          hashKey: failedHashKey
        });
      }
    } catch (disposeError) {
      console.warn(
        "Dispose setelah gagal print tidak berhasil:",
        disposeError
      );
    }

    try {
      await reconnectPrinterBluetooth();
    } catch (reconnectError) {
      console.warn(
        "Reconnect setelah gagal print tidak berhasil:",
        reconnectError
      );
    }

    throw error;
  }
}

};

async function cekStatusPrinterBluetooth() {
  try {
    const hashKey = await ensurePrinterReady();

    const plugin = getPrinterPlugin();

    const connected = await plugin.isPrinterConnected({
      hashKey
    });

    return {
      connected: !!connected?.value,
      hashKey
    };
  } catch (error) {
    console.warn(
      "[PRINTER BLUETOOTH] Health check gagal:",
      error
    );

    return {
      connected: false,
      message: error?.message || String(error)
    };
  }
}

window.cekStatusPrinterBluetooth = cekStatusPrinterBluetooth;

async function cetakStrukBluetooth(teks) {
  try {
    const hashKey = await ensurePrinterReady();
    const plugin = getPrinterPlugin();

    const encoder = new TextEncoder();
    const textBytes = Array.from(encoder.encode(teks));

    const data = [
      0x1B, 0x40,
      ...textBytes,
      0x0A,
      0x0A,
      0x0A
    ];

    await plugin.sendToPrinter({
      hashKey,
      data,
      waitingTime: 1000
    });

    console.log("Struk Bluetooth berhasil dikirim.");

    return {
      success: true
    };
  } catch (error) {
    const failedHashKey = bluetoothPrinterHashKey;

    bluetoothPrinterHashKey = null;

    try {
      if (failedHashKey) {
        await getPrinterPlugin().disconnectPrinter({
          hashKey: failedHashKey
        });
      }
    } catch (disconnectError) {
      console.warn(
        "Disconnect setelah gagal cetak struk tidak berhasil:",
        disconnectError
      );
    }

    try {
      if (failedHashKey) {
        await getPrinterPlugin().disposePrinter({
          hashKey: failedHashKey
        });
      }
    } catch (disposeError) {
      console.warn(
        "Dispose setelah gagal cetak struk tidak berhasil:",
        disposeError
      );
    }

    try {
      if (bluetoothPrinterAddress) {
        await reconnectPrinterBluetooth();
      }
    } catch (reconnectError) {
      console.warn(
        "Reconnect setelah gagal cetak struk tidak berhasil:",
        reconnectError
      );
    }

    console.error("Gagal mencetak struk Bluetooth:", error);

    return {
      success: false,
      message: error?.message || "Gagal mencetak struk."
    };
  }
}

function buatStrukTransaksi(data) {
  const garis = "--------------------------------";

  let struk = "";

  struk += "      POLLARD BILLIARD & CAFE\n";
  struk += garis + "\n";

  struk += `No      : ${data.nomorTransaksi || "-"}\n`;
  struk += `Tanggal : ${data.tanggal || "-"}\n`;
  struk += `Kasir   : ${data.kasir || "-"}\n`;

  struk += garis + "\n";

  // MEJA BILLIARD — hanya jika ada meja
  if (data.meja) {
    struk += "MEJA BILLIARD\n";
    struk += `${data.meja}\n`;
    struk += `${data.durasi || "-"} x ${data.hargaJam || "Rp0"}\n`;
    struk += `Subtotal      ${data.subtotalMeja || "Rp0"}\n`;
    struk += garis + "\n";
  }

  // PRODUK
  struk += "PRODUK\n";

  if (Array.isArray(data.produk) && data.produk.length > 0) {
    data.produk.forEach(item => {
      struk += `${item.nama || "-"}\n`;
      struk += `${item.qty || 0} x ${item.harga || "Rp0"}\n`;
    });
  }

  struk += garis + "\n";

  struk += `TOTAL                  ${data.total || "Rp0"}\n`;
  struk += `Metode Bayar           ${data.metodeBayar || "-"}\n`;
  struk += `Bayar                  ${data.bayar || "Rp0"}\n`;
  struk += `Kembali                 ${data.kembali || "Rp0"}\n`;

  struk += garis + "\n";

  struk += "        TERIMA KASIH\n";
  struk += "   POLLARD BILLIARD & CAFE\n";

  return struk;
}

window.cetakStrukBluetooth = cetakStrukBluetooth;
window.buatStrukTransaksi = buatStrukTransaksi;

})();

