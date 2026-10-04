const sqlite3 = require("sqlite3").verbose();
const path = require("path");

async function debugKategori() {
  const db = new sqlite3.Database(path.join(__dirname, "pos.db"), sqlite3.OPEN_READONLY);
  try {
    const rows = await new Promise((resolve, reject) => db.all(
      "SELECT kategori, COUNT(*) AS jumlah FROM master_barang GROUP BY kategori ORDER BY kategori",
      (error, data) => error ? reject(error) : resolve(data || [])));
    console.log("Katalog lokal:", rows.reduce((sum, row) => sum + Number(row.jumlah), 0), "produk");
    rows.forEach(row => console.log(`${row.kategori || "(tanpa kategori)"}: ${row.jumlah}`));
  } catch (error) {
    console.error("Gagal membaca katalog lokal:", error.message);
  } finally {
    db.close();
  }
}

debugKategori();
