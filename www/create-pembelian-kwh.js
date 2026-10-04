const path = require("path");
const sqlite3 = require("sqlite3").verbose();

const DATABASE_PATH = path.join(__dirname, "pos.db");
const TABLE_NAME = "pembelian_kwh";

const CREATE_TABLE_SQL = `
  CREATE TABLE pembelian_kwh (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    shift_id INTEGER NOT NULL,
    kasir_id INTEGER NOT NULL,
    waktu TEXT NOT NULL,
    jenis_kwh TEXT NOT NULL CHECK (jenis_kwh IN ('DALAM', 'LUAR')),
    nominal_pembelian INTEGER NOT NULL
      CHECK (typeof(nominal_pembelian) = 'integer' AND nominal_pembelian >= 0),
    kwh_didapat INTEGER NOT NULL
      CHECK (typeof(kwh_didapat) = 'integer' AND kwh_didapat > 0),
    harga_per_kwh INTEGER NOT NULL
      CHECK (typeof(harga_per_kwh) = 'integer' AND harga_per_kwh >= 0),
    sisa_kwh INTEGER NOT NULL DEFAULT 0,
    keterangan TEXT NOT NULL DEFAULT '',
    FOREIGN KEY (shift_id) REFERENCES shift_kasir(id),
    FOREIGN KEY (kasir_id) REFERENCES kasir(id)
  )
`;

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

function run(db, sql) {
  return new Promise((resolve, reject) => {
    db.run(sql, error => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function get(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (error, row) => {
      if (error) reject(error);
      else resolve(row);
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

async function findExistingObject(db) {
  return get(
    db,
    "SELECT type, name, sql FROM sqlite_master WHERE name = ?",
    [TABLE_NAME]
  );
}

function printPlan(existingObject, apply) {
  console.log(`Mode: ${apply ? "APPLY" : "DRY-RUN"}`);
  console.log(`Database: ${DATABASE_PATH}`);
  if (existingObject && existingObject.type === "table") {
    console.log(`Tabel ${TABLE_NAME} sudah ada; schema dan data yang ada tidak akan diubah.`);
    console.log(`Schema saat ini: ${existingObject.sql}`);
  } else if (existingObject) {
    console.log(
      `Nama ${TABLE_NAME} sudah dipakai oleh objek SQLite bertipe ${existingObject.type}; tidak akan ditimpa.`
    );
  } else {
    console.log(`Tabel ${TABLE_NAME} belum ada.`);
  }
  console.log("Rencana schema: satu baris untuk setiap LOT pembelian token, dengan jenis DALAM/LUAR terpisah.");
  console.log("kwh_didapat disimpan sebagai integer skala x100 (contoh 1,23 kWh disimpan sebagai 123).");
  console.log("harga_per_kwh disimpan sebagai integer skala x100.");
  console.log("sisa_kwh bertipe INTEGER NOT NULL dengan default 0.");
  console.log("Tidak ada penulisan ke kas_masuk, kas_keluar, shift_kasir, atau data historis.");
  if (!apply) {
    console.log("Dry-run hanya membaca database; gunakan --apply untuk membuat schema.");
  }
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

    const existingObject = await findExistingObject(db);
    printPlan(existingObject, apply);

    if (!apply) return;

    if (existingObject) {
      if (existingObject.type !== "table") {
        throw new Error(
          `Objek ${TABLE_NAME} bertipe ${existingObject.type}; schema tidak dibuat atau diubah.`
        );
      }
      await run(db, "COMMIT");
      transactionStarted = false;
      console.log("Tidak ada perubahan yang dilakukan.");
      return;
    }

    await run(db, CREATE_TABLE_SQL);

    const createdTable = await findExistingObject(db);
    if (!createdTable || createdTable.type !== "table") {
      throw new Error("Validasi schema pembelian_kwh gagal.");
    }

    await run(db, "COMMIT");
    transactionStarted = false;
    console.log("Tabel pembelian_kwh berhasil dibuat.");
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
  console.error(`Migration pembelian KWh gagal: ${error.message}`);
  process.exitCode = 1;
});
