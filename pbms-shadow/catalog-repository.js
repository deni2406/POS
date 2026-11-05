"use strict";

const { ensureSchema } = require("./importer");

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => db.run(sql, params, function (error) {
    if (error) reject(error); else resolve(this);
  }));
}
function all(db, sql, params = []) {
  return new Promise((resolve, reject) => db.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows)));
}
function get(db, sql, params = []) {
  return new Promise((resolve, reject) => db.get(sql, params, (error, row) => error ? reject(error) : resolve(row)));
}

async function reconcile(db, importRunId) {
  const rows = await all(db, `SELECT s.source_id, s.nama AS source_nama, m.nama AS sql_nama,
      s.kategori AS source_kategori, m.kategori AS sql_kategori,
      s.hpp AS source_hpp, m.hpp AS sql_hpp,
      s.harga_jual AS source_harga_jual, m.harga_jual AS sql_harga_jual,
      s.stok_aktual AS source_stok_aktual, m.stok_aktual AS sql_stok_aktual
    FROM master_barang_staging s
    LEFT JOIN master_barang_shadow m ON m.source_id = s.source_id
    WHERE s.import_run_id = ? ORDER BY s.source_id`, [importRunId]);
  return {
    importRunId,
    rowCount: rows.length,
    mappingMatches: rows.filter(row => row.sql_nama !== undefined &&
      row.source_nama === row.sql_nama && row.source_kategori === row.sql_kategori &&
      row.source_hpp === row.sql_hpp && row.source_harga_jual === row.sql_harga_jual).length,
    rows: rows.map(row => ({
      source_id: row.source_id,
      mapping: {
        nama: { source: row.source_nama, sql: row.sql_nama ?? null },
        kategori: { source: row.source_kategori, sql: row.sql_kategori ?? null },
        hpp: { source: row.source_hpp, sql: row.sql_hpp ?? null },
        harga_jual: { source: row.source_harga_jual, sql: row.sql_harga_jual ?? null }
      },
      stock: { source: row.source_stok_aktual, sql: row.sql_stok_aktual ?? null, comparedForInformationOnly: true }
    }))
  };
}

async function publishImport(db, importRunId) {
  await ensureSchema(db);
  await run(db, "BEGIN IMMEDIATE");
  try {
    const runRow = await get(db, "SELECT status, staged_row_count FROM master_barang_import_runs WHERE import_run_id = ?", [importRunId]);
    if (!runRow || runRow.status !== "STAGED") throw new Error("Import harus berstatus STAGED untuk dipublikasikan.");
    const rows = await all(db, `SELECT source_id, nama, kategori, hpp, harga_jual, source_updated_at
      FROM master_barang_staging WHERE import_run_id = ? ORDER BY source_id`, [importRunId]);
    if (rows.length === 0 || rows.length !== runRow.staged_row_count) throw new Error("Jumlah staging tidak valid untuk publish.");
    const before = await reconcile(db, importRunId);
    const now = new Date().toISOString();
    for (const row of rows) {
      await run(db, `INSERT INTO master_barang_shadow
        (source_id, nama, kategori, hpp, harga_jual, source_updated_at, published_at, last_import_run_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(source_id) DO UPDATE SET
          nama=excluded.nama, kategori=excluded.kategori, hpp=excluded.hpp,
          harga_jual=excluded.harga_jual, source_updated_at=excluded.source_updated_at,
          published_at=excluded.published_at, last_import_run_id=excluded.last_import_run_id`,
      [row.source_id, row.nama, row.kategori, row.hpp, row.harga_jual, row.source_updated_at, now, importRunId]);
    }
    // Each get_barang import is a complete catalog snapshot. Retire products
    // absent from this run only inside the same shadow publish transaction.
    await run(db, `DELETE FROM master_barang_shadow
      WHERE source_id NOT IN (SELECT source_id FROM master_barang_staging WHERE import_run_id = ?)`, [importRunId]);
    await run(db, `INSERT INTO master_barang_shadow_publish(import_run_id, published_at, published_row_count)
      VALUES (?, ?, ?) ON CONFLICT(import_run_id) DO UPDATE SET
      published_at=excluded.published_at, published_row_count=excluded.published_row_count`, [importRunId, now, rows.length]);
    const after = await reconcile(db, importRunId);
    if (after.mappingMatches !== after.rowCount) throw new Error("Reconciliation sesudah publish gagal.");
    await run(db, "COMMIT");
    return { importRunId, publishedCount: rows.length, before, after };
  } catch (error) {
    await run(db, "ROLLBACK").catch(() => {});
    throw error;
  }
}

async function findBySourceId(db, sourceId) {
  return (await get(db, `SELECT m.source_id, m.nama, m.kategori, m.hpp, m.harga_jual, m.stok_aktual,
      m.source_updated_at, m.published_at, m.last_import_run_id
    FROM master_barang_shadow m
    INNER JOIN master_barang_shadow_publish p ON p.import_run_id = m.last_import_run_id
    INNER JOIN master_barang_import_runs r ON r.import_run_id = p.import_run_id
    WHERE m.source_id = ? AND r.status = 'STAGED'`, [sourceId])) || null;
}

async function queryCatalogRows(db, { q = "", kategori, sourceId, activeOnly = false } = {}) {
  const columns = await all(db, "PRAGMA table_info(master_barang_shadow)");
  const columnNames = new Set(columns.map(column => column.name));
  const optionalId = columnNames.has("id") ? "m.id" : "NULL";
  const activeColumn = columnNames.has("is_active") ? "m.is_active"
    : columnNames.has("status") ? "m.status" : null;
  const conditions = ["p.import_run_id IS NOT NULL", "r.status = 'STAGED'"];
  const params = [];
  if (sourceId !== undefined) { conditions.push("m.source_id = ?"); params.push(sourceId); }
  if (q) { conditions.push("(LOWER(m.nama) LIKE ? OR LOWER(m.source_id) LIKE ?)"); params.push(`%${String(q).trim().toLowerCase()}%`, `%${String(q).trim().toLowerCase()}%`); }
  if (kategori) { conditions.push("LOWER(m.kategori) = ?"); params.push(String(kategori).trim().toLowerCase()); }
  if (activeOnly && activeColumn) {
    conditions.push(columnNames.has("is_active") ? `${activeColumn} = 1` : `UPPER(${activeColumn}) IN ('AKTIF', 'ACTIVE', '1', 'TRUE')`);
  }
  const rows = await all(db, `SELECT ${optionalId} AS id, m.source_id, m.nama, m.kategori,
      m.hpp, m.harga_jual, m.stok_aktual, m.source_updated_at, m.published_at,
      m.last_import_run_id${activeColumn ? `, ${activeColumn} AS source_active_status` : ""}
    FROM master_barang_shadow m
    INNER JOIN master_barang_shadow_publish p ON p.import_run_id = m.last_import_run_id
    INNER JOIN master_barang_import_runs r ON r.import_run_id = p.import_run_id
    WHERE ${conditions.join(" AND ")} ORDER BY m.nama, m.source_id`, params);
  return rows.map(row => ({
    ...(row.id == null ? {} : { id: row.id }),
    nama: row.nama,
    kategori: row.kategori,
    hpp: row.hpp,
    hargaJual: row.harga_jual,
    stokAktual: row.stok_aktual,
    source_id: row.source_id,
    sourceId: row.source_id,
    source_updated_at: row.source_updated_at,
    published_at: row.published_at,
    last_import_run_id: row.last_import_run_id,
    ...(row.source_active_status === undefined ? {} : { status: row.source_active_status })
  }));
}

async function listCatalog(db, options = {}) {
  const rows = await queryCatalogRows(db, options);
  return rows.map(row => ({
    ...(row.id == null ? {} : { id: row.id }),
    source_id: row.source_id, nama: row.nama, kategori: row.kategori, hpp: row.hpp,
    harga_jual: row.hargaJual, stok_aktual: row.stokAktual,
    source_updated_at: row.source_updated_at, published_at: row.published_at,
    last_import_run_id: row.last_import_run_id,
    ...(row.status === undefined ? {} : { source_active_status: row.status })
  }));
}

async function listBarang(db, options = {}) {
  return queryCatalogRows(db, options);
}

async function listCategories(db) {
  const rows = await all(db, `SELECT DISTINCT m.kategori FROM master_barang_shadow m
    INNER JOIN master_barang_shadow_publish p ON p.import_run_id = m.last_import_run_id
    INNER JOIN master_barang_import_runs r ON r.import_run_id = p.import_run_id
    WHERE p.import_run_id IS NOT NULL AND r.status = 'STAGED' ORDER BY m.kategori`);
  return rows.map(row => row.kategori);
}

async function getCatalogResponse(db, options = {}) {
  const data = await listBarang(db, options);
  const metadata = await get(db, `SELECT MAX(p.published_at) AS updated_at
    FROM master_barang_shadow_publish p INNER JOIN master_barang_import_runs r
      ON r.import_run_id = p.import_run_id WHERE r.status = 'STAGED'`);
  return { success: true, total: data.length, updatedAt: metadata?.updated_at ?? null, data };
}

module.exports = { findBySourceId, getCatalogResponse, listBarang, listCatalog, listCategories, publishImport, reconcile };
