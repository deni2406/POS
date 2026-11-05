const fs = require("fs");

const path = "C:\\POS\\printer-pesanan.js";
const backup = "C:\\POS\\printer-pesanan-before-recovery-node.js";

fs.copyFileSync(path, backup);

let source = fs.readFileSync(path, "utf8");

if (source.includes("const printerPesananReconnectPromise")) {
  throw new Error("ABORT: recovery patch sudah ada.");
}

function findFunctionStart(text, functionName) {
  const marker = `async function ${functionName}(`;
  const index = text.indexOf(marker);

  if (index === -1) {
    throw new Error(`ABORT: ${functionName} tidak ditemukan.`);
  }

  if (text.indexOf(marker, index + marker.length) !== -1) {
    throw new Error(`ABORT: ${functionName} ditemukan lebih dari satu.`);
  }

  return index;
}

function findFunctionEnd(text, start) {
  const openBrace = text.indexOf("{", start);

  if (openBrace === -1) {
    throw new Error("ABORT: pembuka function tidak ditemukan.");
  }

  let depth = 0;
  let inString = null;
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = openBrace; i < text.length; i++) {
    const char = text[i];
    const next = text[i + 1];

    if (inLineComment) {
      if (char === "\n") {
        inLineComment = false;
      }
      continue;
    }

    if (inBlockComment) {
      if (char === "*" && next === "/") {
        inBlockComment = false;
        i++;
      }
      continue;
    }

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }

      if (char === "\\") {
        escaped = true;
        continue;
      }

      if (char === inString) {
        inString = null;
      }

      continue;
    }

    if (char === "/" && next === "/") {
      inLineComment = true;
      i++;
      continue;
    }

    if (char === "/" && next === "*") {
      inBlockComment = true;
      i++;
      continue;
    }

    if (char === "'" || char === '"' || char === "`") {
      inString = char;
      continue;
    }

    if (char === "{") {
      depth++;
      continue;
    }

    if (char === "}") {
      depth--;

      if (depth === 0) {
        return i + 1;
      }
    }
  }

  throw new Error("ABORT: akhir function tidak ditemukan.");
}

function replaceFunction(text, functionName, replacement) {
  const start = findFunctionStart(text, functionName);
  const end = findFunctionEnd(text, start);

  return text.slice(0, start) + replacement + text.slice(end);
}

const connectFunction = `async function hubungkanPrinterPesanan(jenis, address, name = "") {
  if (jenis !== "bar" && jenis !== "dapur") {
    throw new Error("Jenis printer tidak valid.");
  }

  if (!address) {
    throw new Error(\`MAC Address printer \${jenis.toUpperCase()} belum diisi.\`);
  }

  const printerApi = window.PBMSBluetoothPrinter;

  if (!printerApi || typeof printerApi.getPrinterPlugin !== "function") {
    throw new Error("API printer Bluetooth belum tersedia.");
  }

  const plugin = printerApi.getPrinterPlugin();
  const state = printerPesananState[jenis];
  const previousHashKey = state.hashKey;

  state.address = address;

  try {
    if (previousHashKey) {
      try {
        await plugin.disconnectPrinter({
          hashKey: previousHashKey
        });
      } catch (error) {
        console.warn(
          \`[PRINTER PESANAN] Disconnect \${jenis.toUpperCase()} sebelumnya gagal:\`,
          error
        );
      }

      try {
        await plugin.disposePrinter({
          hashKey: previousHashKey
        });
      } catch (error) {
        console.warn(
          \`[PRINTER PESANAN] Dispose \${jenis.toUpperCase()} sebelumnya gagal:\`,
          error
        );
      }

      state.hashKey = null;
      state.connected = false;
    }

    const created = await plugin.createPrinter({
      connectionType: "bluetooth",
      address
    });

    const hashKey = created?.value;

    if (!hashKey) {
      throw new Error(
        \`HashKey printer \${jenis.toUpperCase()} tidak ditemukan.\`
      );
    }

    try {
      await plugin.connectPrinter({
        hashKey
      });

      const connected = await plugin.isPrinterConnected({
        hashKey
      });

      if (!connected?.value) {
        throw new Error(
          \`Printer \${jenis.toUpperCase()} gagal terhubung.\`
        );
      }
    } catch (error) {
      try {
        await plugin.disconnectPrinter({
          hashKey
        });
      } catch (disconnectError) {
        console.warn(
          \`[PRINTER PESANAN] Disconnect \${jenis.toUpperCase()} baru gagal:\`,
          disconnectError
        );
      }

      try {
        await plugin.disposePrinter({
          hashKey
        });
      } catch (disposeError) {
        console.warn(
          \`[PRINTER PESANAN] Dispose \${jenis.toUpperCase()} baru gagal:\`,
          disposeError
        );
      }

      throw error;
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

    console.log(
      \`[PRINTER PESANAN] \${jenis.toUpperCase()} terhubung:\`,
      {
        name,
        address,
        hashKey
      }
    );

    return {
      success: true,
      jenis,
      name,
      address,
      hashKey
    };
  } catch (error) {
    state.hashKey = null;
    state.address = address;
    state.connected = false;

    console.error(
      \`[PRINTER PESANAN] Gagal menghubungkan \${jenis.toUpperCase()}:\`,
      error
    );

    return {
      success: false,
      jenis,
      name,
      address,
      message:
        error?.message ||
        \`Gagal menghubungkan printer \${jenis.toUpperCase()}.\`
    };
  }
}`;

const printFunction = `async function cetakTiketPesanan(jenis, data) {
  if (jenis !== "bar" && jenis !== "dapur") {
    throw new Error("Jenis printer tidak valid.");
  }

  const printerApi = window.PBMSBluetoothPrinter;

  if (!printerApi || typeof printerApi.getPrinterPlugin !== "function") {
    throw new Error("API printer Bluetooth belum tersedia.");
  }

  const plugin = printerApi.getPrinterPlugin();
  const state = printerPesananState[jenis];

  try {
    const hashKey = await ensurePrinterPesananReady(jenis);

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

    try {
      await plugin.sendToPrinter({
        hashKey,
        data: printerData,
        waitingTime: 1000
      });
    } catch (error) {
      const failedHashKey = state.hashKey;

      state.hashKey = null;
      state.connected = false;

      await disposePrinterPesananHash(
        jenis,
        failedHashKey
      );

      try {
        await reconnectPrinterPesanan(jenis);
      } catch (reconnectError) {
        console.warn(
          \`[PRINTER PESANAN] Reconnect \${jenis.toUpperCase()} setelah gagal print tidak berhasil:\`,
          reconnectError
        );
      }

      throw error;
    }

    console.log(
      \`[PRINTER PESANAN] Tiket \${jenis.toUpperCase()} berhasil dikirim.\`
    );

    return {
      success: true,
      jenis,
      nomorPesanan
    };
  } catch (error) {
    console.error(
      \`[PRINTER PESANAN] Gagal mencetak tiket \${jenis.toUpperCase()}:\`,
      error
    );

    return {
      success: false,
      jenis,
      message:
        error?.message ||
        \`Gagal mencetak tiket \${jenis.toUpperCase()}.\`
    };
  }
}`;

const helperFunctions = `async function disposePrinterPesananHash(jenis, hashKey) {
  if (!hashKey) {
    return;
  }

  const printerApi = window.PBMSBluetoothPrinter;

  if (!printerApi || typeof printerApi.getPrinterPlugin !== "function") {
    return;
  }

  const plugin = printerApi.getPrinterPlugin();

  try {
    await plugin.disconnectPrinter({
      hashKey
    });
  } catch (error) {
    console.warn(
      \`[PRINTER PESANAN] Disconnect \${jenis.toUpperCase()} setelah gagal print tidak berhasil:\`,
      error
    );
  }

  try {
    await plugin.disposePrinter({
      hashKey
    });
  } catch (error) {
    console.warn(
      \`[PRINTER PESANAN] Dispose \${jenis.toUpperCase()} setelah gagal print tidak berhasil:\`,
      error
    );
  }
}

async function reconnectPrinterPesanan(jenis) {
  if (jenis !== "bar" && jenis !== "dapur") {
    throw new Error("Jenis printer tidak valid.");
  }

  if (printerPesananReconnectPromise[jenis]) {
    return printerPesananReconnectPromise[jenis];
  }

  const state = printerPesananState[jenis];
  const config = ambilConfigPrinterPesanan();
  const savedConfig = config?.[jenis] || {};

  const address = state.address || savedConfig.address || "";
  const name = savedConfig.name || "";

  if (!address) {
    throw new Error(
      \`Alamat printer \${jenis.toUpperCase()} tidak tersedia.\`
    );
  }

  state.address = address;

  printerPesananReconnectPromise[jenis] = (async () => {
    const result = await hubungkanPrinterPesanan(
      jenis,
      address,
      name
    );

    if (!result?.success) {
      state.address = address;

      throw new Error(
        result?.message ||
        \`Gagal melakukan auto-reconnect printer \${jenis.toUpperCase()}.\`
      );
    }

    return result;
  })();

  try {
    return await printerPesananReconnectPromise[jenis];
  } finally {
    printerPesananReconnectPromise[jenis] = null;
  }
}

async function ensurePrinterPesananReady(jenis) {
  if (jenis !== "bar" && jenis !== "dapur") {
    throw new Error("Jenis printer tidak valid.");
  }

  const printerApi = window.PBMSBluetoothPrinter;

  if (!printerApi || typeof printerApi.getPrinterPlugin !== "function") {
    throw new Error("API printer Bluetooth belum tersedia.");
  }

  const plugin = printerApi.getPrinterPlugin();
  const state = printerPesananState[jenis];
  const config = ambilConfigPrinterPesanan();
  const savedConfig = config?.[jenis] || {};

  if (!state.address && savedConfig.address) {
    state.address = savedConfig.address;
  }

  if (!state.address) {
    throw new Error(
      \`Printer \${jenis.toUpperCase()} belum dikonfigurasi.\`
    );
  }

  if (state.hashKey) {
    try {
      const connected = await plugin.isPrinterConnected({
        hashKey: state.hashKey
      });

      if (connected?.value) {
        state.connected = true;
        return state.hashKey;
      }
    } catch (error) {
      console.warn(
        \`[PRINTER PESANAN] Status \${jenis.toUpperCase()} tidak dapat diperiksa:\`,
        error
      );
    }

    const staleHashKey = state.hashKey;

    state.hashKey = null;
    state.connected = false;

    await disposePrinterPesananHash(
      jenis,
      staleHashKey
    );
  }

  const result = await reconnectPrinterPesanan(jenis);

  if (!result?.hashKey) {
    throw new Error(
      \`Printer \${jenis.toUpperCase()} gagal disiapkan.\`
    );
  }

  return result.hashKey;
}`;

source = replaceFunction(
  source,
  "hubungkanPrinterPesanan",
  connectFunction
);

source = replaceFunction(
  source,
  "cetakTiketPesanan",
  printFunction
);

const stateMarker = "const printerPesananState = {";
const stateStart = source.indexOf(stateMarker);

if (stateStart === -1) {
  throw new Error("ABORT: printerPesananState tidak ditemukan.");
}

const stateEnd = source.indexOf("};", stateStart);

if (stateEnd === -1) {
  throw new Error("ABORT: akhir printerPesananState tidak ditemukan.");
}

const reconnectDeclaration = `

const printerPesananReconnectPromise = {
  bar: null,
  dapur: null
};`;

source =
  source.slice(0, stateEnd + 2) +
  reconnectDeclaration +
  source.slice(stateEnd + 2);

const stateFunctionMarker =
  "function ambilStatePrinterPesanan(jenis) {";

if (source.indexOf(stateFunctionMarker) === -1) {
  throw new Error(
    "ABORT: ambilStatePrinterPesanan tidak ditemukan."
  );
}

source =
  source.replace(
    stateFunctionMarker,
    helperFunctions + "\n\n" + stateFunctionMarker
  );

fs.writeFileSync(path, source, "utf8");

console.log("PATCH SUCCESS");
console.log(`Backup: ${backup}`);
