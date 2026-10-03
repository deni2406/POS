"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const schemaSql = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
const expectedColumns = {
  master_barang_staging: ["import_run_id", "source_id", "nama", "kategori", "hpp", "harga_jual", "stok_aktual", "source_updated_at", "imported_at"],
  master_barang_import_runs: ["import_run_id", "source_name", "status", "checksum_sha256", "source_row_count", "staged_row_count", "rejected_row_count", "started_at", "completed_at", "metadata_json", "validation_errors_json"],
  master_barang_shadow: ["source_id", "nama", "kategori", "hpp", "harga_jual", "stok_aktual", "source_updated_at", "published_at", "last_import_run_id"]
};

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => db.run(sql, params, function (error) {
    if (error) reject(error); else resolve(this);
  }));
}

function all(db, sql, params = []) {
  return new Promise((resolve, reject) => db.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows)));
}

async function ensureSchema(db) {
  await run(db, "PRAGMA foreign_keys = ON");
  // Detect incompatible pre-existing shadow tables before indexes in the SQL
  // migration reference columns that may be missing.
  const existing = await all(db, "SELECT name FROM sqlite_master WHERE type='table'");
  const existingNames = new Set(existing.map(row => row.name));
  for (const table of Object.keys(expectedColumns).filter(name => name !== "master_barang_shadow")) {
    if (existingNames.has(table)) await assertTableColumns(db, table);
  }
  await run(db, "BEGIN IMMEDIATE");
  try {
    await new Promise((resolve, reject) => db.exec(schemaSql, error => error ? reject(error) : resolve()));
    await assertSchema(db);
    await run(db, "COMMIT");
  } catch (error) {
    await run(db, "ROLLBACK").catch(() => {});
    throw error;
  }
}

async function assertSchema(db) {
  for (const [table, expected] of Object.entries(expectedColumns)) {
    const rows = await all(db, `PRAGMA table_info(${table})`);
    const found = rows.map(row => row.name);
    assertColumns(table, expected, found);
  }
}

async function assertTableColumns(db, table) {
  const rows = await all(db, `PRAGMA table_info(${table})`);
  assertColumns(table, expectedColumns[table], rows.map(row => row.name));
}

function assertColumns(table, expected, found) {
  const missing = expected.filter(column => !found.includes(column));
  if (missing.length) throw new Error(`Skema tidak valid: ${table} harus memiliki kolom ${missing.join(", ")}.`);
}

function validateDataset(rows) {
  const issues = [];
  if (!Array.isArray(rows)) return [{ row: 0, field: "data", code: "invalid_dataset", message: "Dataset harus berupa array." }];
  if (rows.length === 0) issues.push({ row: 0, field: "data", code: "empty_dataset", message: "Dataset kosong ditolak." });
  const ids = new Map();
  rows.forEach((row, index) => {
    const n = index + 1;
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      issues.push({ row: n, field: "record", code: "invalid_record", message: "Baris harus berupa object." });
      return;
    }
    for (const field of ["source_id", "nama"]) {
      if (typeof row[field] !== "string" || row[field].trim() === "") {
        issues.push({ row: n, field, code: "required", message: `${field} wajib berupa teks tidak kosong.` });
      }
    }
    if (typeof row.source_id === "string" && row.source_id.trim()) {
      const id = row.source_id.trim();
      if (ids.has(id)) issues.push({ row: n, field: "source_id", code: "duplicate", message: `source_id duplikat dari baris ${ids.get(id)}.` });
      else ids.set(id, n);
    }
    for (const field of ["hpp", "harga_jual", "stok_aktual"]) {
      if (!Number.isSafeInteger(row[field]) || row[field] < 0) {
        issues.push({ row: n, field, code: "invalid_numeric", message: `${field} harus integer aman bernilai nol atau lebih.` });
      }
    }
    if (row.kategori !== undefined && typeof row.kategori !== "string") {
      issues.push({ row: n, field: "kategori", code: "invalid_field", message: "kategori harus berupa teks." });
    }
    if (row.source_updated_at !== undefined && row.source_updated_at !== null && typeof row.source_updated_at !== "string") {
      issues.push({ row: n, field: "source_updated_at", code: "invalid_field", message: "source_updated_at harus berupa teks atau null." });
    }
  });
  return issues;
}

async function importToStaging(db, rows, { sourceName = "mock", metadata = {} } = {}) {
  await ensureSchema(db);
  await assertSchema(db);
  const issues = validateDataset(rows);
  const normalized = Array.isArray(rows) ? rows.map(row => row && ({
    source_id: typeof row.source_id === "string" ? row.source_id.trim() : row.source_id,
    nama: typeof row.nama === "string" ? row.nama.trim() : row.nama,
    kategori: row.kategori === undefined || row.kategori === "" ? "Lainnya" : row.kategori,
    hpp: row.hpp, harga_jual: row.harga_jual, stok_aktual: row.stok_aktual,
    source_updated_at: row.source_updated_at ?? null
  })) : rows;
  const checksum = crypto.createHash("sha256").update(JSON.stringify(rows)).digest("hex");
  const runId = crypto.randomUUID();
  const now = new Date().toISOString();
  await run(db, "BEGIN IMMEDIATE");
  try {
    await run(db, `INSERT INTO master_barang_import_runs
      (import_run_id, source_name, status, checksum_sha256, source_row_count, rejected_row_count, started_at, completed_at, metadata_json, validation_errors_json)
      VALUES (?, ?, 'VALIDATING', ?, ?, ?, ?, NULL, ?, '[]')`,
    [runId, sourceName, checksum, Array.isArray(rows) ? rows.length : 0, issues.length, now, JSON.stringify(metadata)]);
    if (issues.length) {
      await run(db, `UPDATE master_barang_import_runs SET status='REJECTED', completed_at=?, validation_errors_json=? WHERE import_run_id=?`, [new Date().toISOString(), JSON.stringify(issues), runId]);
      await run(db, "COMMIT");
      return { importRunId: runId, status: "REJECTED", issues, checksum };
    }
    for (const row of normalized) {
      await run(db, `INSERT INTO master_barang_staging
        (import_run_id, source_id, nama, kategori, hpp, harga_jual, stok_aktual, source_updated_at, imported_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [runId, row.source_id, row.nama, row.kategori, row.hpp, row.harga_jual, row.stok_aktual, row.source_updated_at, now]);
    }
    await run(db, `UPDATE master_barang_import_runs SET status='STAGED', staged_row_count=?, completed_at=? WHERE import_run_id=?`, [normalized.length, new Date().toISOString(), runId]);
    await run(db, "COMMIT");
    return { importRunId: runId, status: "STAGED", stagedCount: normalized.length, checksum };
  } catch (error) {
    await run(db, "ROLLBACK").catch(() => {});
    throw error;
  }
}

module.exports = { assertSchema, ensureSchema, importToStaging, validateDataset };
