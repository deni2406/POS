/**
 * ==================================================
 * FILE: gas-harga.js
 * DESKRIPSI: Connector Node.js ke Google Apps Script khusus Harga Paket
 * ==================================================
 */

const config = require("./config");

/**
 * Melakukan request GET ke Google Apps Script Harga dengan parameter query
 * 
 * @param {Object} params - Object parameter query (action, jam, durasiJam, dll)
 * @returns {Promise<Object>} JSON response dari GAS
 */
async function callHargaGasGet(params) {
  const url = new URL(config.GAS_HARGA_URL);
  
  if (params && typeof params === "object") {
    Object.keys(params).forEach(key => {
      url.searchParams.append(key, params[key]);
    });
  }

  console.log("[GAS_HARGA] GET", url.toString());

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch(url.toString(), {
      method: "GET",
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`Harga GAS Error: ${response.status}`);
    }

    return await response.json();
  } catch (error) {
    clearTimeout(timeoutId);
    if (error.name === "AbortError") {
      throw new Error("GAS Harga timeout");
    }
    throw error;
  }
}

/**
 * Melakukan request POST JSON ke Google Apps Script Harga
 * 
 * @param {Object} data - Object data payload untuk dikirimkan
 * @returns {Promise<Object>} JSON response dari GAS
 */
async function callHargaGas(data) {
  console.log("[GAS_HARGA] POST");

  const payload = {
    apiKey: config.API_KEY,
    ...(data || {})
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch(config.GAS_HARGA_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`Harga GAS Error: ${response.status}`);
    }

    return await response.json();
  } catch (error) {
    clearTimeout(timeoutId);
    if (error.name === "AbortError") {
      throw new Error("GAS Harga timeout");
    }
    throw error;
  }
}

module.exports = {
  callHargaGasGet,
  callHargaGas
};