"use strict";

function disabled() {
  const error = new Error("Import katalog eksternal dinonaktifkan. Tetapkan sumber lokal dan formatnya sebelum mengaktifkan impor.");
  error.code = "PBMS_CATALOG_IMPORT_DISABLED";
  throw error;
}

async function fetchGetBarang() { return disabled(); }
async function importGetBarangToStaging() { return disabled(); }

module.exports = { fetchGetBarang, importGetBarangToStaging };
