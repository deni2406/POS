PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS master_barang_import_runs (
  import_run_id TEXT PRIMARY KEY,
  source_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('VALIDATING', 'REJECTED', 'STAGED')),
  checksum_sha256 TEXT NOT NULL,
  source_row_count INTEGER NOT NULL CHECK (source_row_count >= 0),
  staged_row_count INTEGER NOT NULL DEFAULT 0 CHECK (staged_row_count >= 0),
  rejected_row_count INTEGER NOT NULL DEFAULT 0 CHECK (rejected_row_count >= 0),
  started_at TEXT NOT NULL,
  completed_at TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  validation_errors_json TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS master_barang_staging (
  import_run_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  nama TEXT NOT NULL,
  kategori TEXT NOT NULL DEFAULT 'Lainnya',
  hpp INTEGER NOT NULL CHECK (hpp >= 0),
  harga_jual INTEGER NOT NULL CHECK (harga_jual >= 0),
  stok_aktual INTEGER NOT NULL CHECK (stok_aktual >= 0),
  source_updated_at TEXT,
  imported_at TEXT NOT NULL,
  PRIMARY KEY (import_run_id, source_id),
  FOREIGN KEY (import_run_id) REFERENCES master_barang_import_runs(import_run_id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_master_barang_staging_nama
  ON master_barang_staging(nama);
CREATE INDEX IF NOT EXISTS idx_master_barang_staging_kategori
  ON master_barang_staging(kategori);

-- Shadow catalog owns descriptive/pricing fields. Stock is maintained separately
-- and deliberately has no import mapping from source stock.
CREATE TABLE IF NOT EXISTS master_barang_shadow (
  source_id TEXT PRIMARY KEY,
  nama TEXT NOT NULL,
  kategori TEXT NOT NULL,
  hpp INTEGER NOT NULL CHECK (hpp >= 0),
  harga_jual INTEGER NOT NULL CHECK (harga_jual >= 0),
  stok_aktual INTEGER NOT NULL DEFAULT 0 CHECK (stok_aktual >= 0),
  source_updated_at TEXT,
  published_at TEXT NOT NULL,
  last_import_run_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS master_barang_shadow_publish (
  import_run_id TEXT PRIMARY KEY,
  published_at TEXT NOT NULL,
  published_row_count INTEGER NOT NULL CHECK (published_row_count > 0),
  FOREIGN KEY (import_run_id) REFERENCES master_barang_import_runs(import_run_id)
);
