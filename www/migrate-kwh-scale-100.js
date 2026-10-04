const path = require("path");
const sqlite3 = require("sqlite3").verbose();

const DATABASE_PATH = path.join(__dirname, "pos.db");
const FIELDS = [
  "saldo_kwh_dalam_awal",
  "saldo_kwh_luar_awal",
  "saldo_kwh_dalam_akhir",
  "saldo_kwh_luar_akhir"
];
const SQLITE_MAX_INTEGER = 9223372036854775807n;
const MAX_SOURCE_VALUE = SQLITE_MAX_INTEGER / 100n;

function parseArguments(args) {
  if (args.length === 0 || (args.length === 1 && args[0] === "--dry-run")) {
    return false;
  }
  if (args.length === 1 && args[0] === "--apply") {
    return true;
  }
  throw new Error("Gunakan tanpa argumen/--dry-run (default) atau --apply.");
}

function openDatabase(readOnly) {
  const mode = readOnly ? sqlite3.OPEN_READONLY : sqlite3.OPEN_READWRITE;
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(DATABASE_PATH, mode, error => {
      if (error) reject(error);
      else resolve(db);
    });
  });
}

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (error) {
      if (error) reject(error);
      else resolve(this);
    });
  });
}

function all(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (error, rows) => {
      if (error) reject(error);
      else resolve(rows);
    });
  });
}

function closeDatabase(db) {
  return new Promise((resolve, reject) => {
    db.close(error => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function readAndValidateRows(db) {
  const selections = [
    "CAST(rowid AS TEXT) AS row_id",
    ...FIELDS.map(field => `CAST("${field}" AS TEXT) AS "${field}"`)
  ];
  const rows = await all(db, `SELECT ${selections.join(", ")} FROM shift_kasir ORDER BY rowid`);
  return rows.map(row => {
    if (!/^[1-9]\d*$/.test(row.row_id)) {
      throw new Error(`rowid tidak valid: ${row.row_id}`);
    }
    const migrated = {};
    for (const field of FIELDS) {
      const rawValue = row[field];
      if (typeof rawValue !== "string" || !/^(0|[1-9]\d*)$/.test(rawValue)) {
        throw new Error(`Nilai ${field} tidak berupa integer non-negatif pada rowid ${row.row_id}.`);
      }
      const value = BigInt(rawValue);
      if (value > MAX_SOURCE_VALUE) {
        throw new Error(`Nilai ${field} melampaui batas integer SQLite setelah dikali 100 pada rowid ${row.row_id}.`);
      }
      migrated[field] = (value * 100n).toString();
    }
    return { rowId: row.row_id, before: row, after: migrated };
  });
}

async function applyMigration(db, plannedRows) {
  const assignments = FIELDS.map(field => `"${field}" = ?`).join(", ");
  const updateSql = `UPDATE shift_kasir SET ${assignments} WHERE rowid = CAST(? AS INTEGER)`;
  const verificationRows = await all(
    db,
    `SELECT CAST(rowid AS TEXT) AS row_id, ${FIELDS.map(field => `CAST("${field}" AS TEXT) AS "${field}"`).join(", ")} FROM shift_kasir ORDER BY rowid`
  );

  if (verificationRows.length !== plannedRows.length) {
    throw new Error(`Jumlah row berubah sebelum migrasi: rencana ${plannedRows.length}, aktual ${verificationRows.length}.`);
  }

  const stmt = db.prepare(updateSql);
  try {
    for (const row of plannedRows) {
      const result = await new Promise((resolve, reject) => {
        stmt.run([...FIELDS.map(field => row.after[field]), row.rowId], function (error) {
          if (error) reject(error);
          else resolve(this);
        });
      });
      if (result.changes !== 1) {
        throw new Error(`UPDATE tidak mengubah tepat satu row untuk rowid ${row.rowId}.`);
      }
    }
  } finally {
    await new Promise((resolve, reject) => {
      stmt.finalize(error => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  const migratedRows = await all(
    db,
    `SELECT CAST(rowid AS TEXT) AS row_id, ${FIELDS.map(field => `CAST("${field}" AS TEXT) AS "${field}"`).join(", ")} FROM shift_kasir ORDER BY rowid`
  );
  if (migratedRows.length !== plannedRows.length) {
    throw new Error(`Validasi jumlah row gagal: rencana ${plannedRows.length}, hasil ${migratedRows.length}.`);
  }

  const expectedByRowId = new Map(plannedRows.map(row => [row.rowId, row.after]));
  for (const row of migratedRows) {
    const expected = expectedByRowId.get(row.row_id);
    if (!expected || FIELDS.some(field => row[field] !== expected[field])) {
      throw new Error(`Validasi hasil migrasi gagal pada rowid ${row.row_id}.`);
    }
  }
  return migratedRows;
}

async function main() {
  const apply = parseArguments(process.argv.slice(2));
  const db = await openDatabase(!apply);
  let transactionStarted = false;

  try {
    if (apply) {
      await run(db, "BEGIN IMMEDIATE");
      transactionStarted = true;
    }

    const plannedRows = await readAndValidateRows(db);
    console.log(`Mode: ${apply ? "APPLY" : "DRY-RUN"}`);
    console.log(`Database: ${DATABASE_PATH}`);
    console.log(`Rows tervalidasi: ${plannedRows.length}`);
    console.log("Rencana konversi: nilai setiap field dikalikan 100.");
    for (const row of plannedRows.slice(0, 10)) {
      const changes = FIELDS.map(field => `${field} ${row.before[field]} -> ${row.after[field]}`).join("; ");
      console.log(`rowid ${row.rowId}: ${changes}`);
    }
    if (plannedRows.length > 10) {
      console.log(`... ${plannedRows.length - 10} row lainnya tidak ditampilkan.`);
    }

    if (!apply) {
      console.log("Dry-run selesai; database tidak diubah. Gunakan --apply untuk menjalankan migrasi secara manual.");
      return;
    }

    const migratedRows = await applyMigration(db, plannedRows);
    await run(db, "COMMIT");
    transactionStarted = false;
    console.log(`Migrasi berhasil dan tervalidasi untuk ${migratedRows.length} row.`);
    for (const row of migratedRows.slice(0, 10)) {
      console.log(`rowid ${row.row_id}: ${FIELDS.map(field => `${field}=${row[field]}`).join("; ")}`);
    }
  } catch (error) {
    if (transactionStarted) {
      try {
        await run(db, "ROLLBACK");
        transactionStarted = false;
      } catch (rollbackError) {
        error.message = `${error.message}; ROLLBACK gagal: ${rollbackError.message}`;
      }
    }
    throw error;
  } finally {
    await closeDatabase(db);
  }
}

main().catch(error => {
  console.error(`Migrasi KWh gagal: ${error.message}`);
  process.exitCode = 1;
});
