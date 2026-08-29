const { callGas } = require("./gas");

async function debugKategori() {
  console.log("================================");
  console.log(" DEBUG KATEGORI MASTER BARANG");
  console.log("================================");

  try {
    const result = await callGas({
      action: "get_barang"
    });

    console.log("SUCCESS:", result.success);
    console.log("TOTAL  :", result.total);

    if (!result.success) {
      console.log("ERROR  :", result.error);
      return;
    }

    console.log("\n10 DATA PERTAMA:");

    result.data.slice(0, 10).forEach((item, index) => {
      console.log(
        `${index + 1}.`,
        "Nama:",
        item.nama,
        "| Area/Kategori:",
        item.kategori,
        "| HPP:",
        item.hpp,
        "| Harga:",
        item.hargaJual
      );
    });

    const kategori = [
      ...new Set(
        result.data
          .map(item => item.kategori)
          .filter(Boolean)
      )
    ];

    console.log("\n================================");
    console.log("DAFTAR KATEGORI");
    console.log("================================");

    kategori.forEach((item, index) => {
      console.log(`${index + 1}. ${item}`);
    });

    console.log("\nJumlah kategori:", kategori.length);

    console.log("\n================================");
    console.log("DEBUG SELESAI");
    console.log("================================");

  } catch (error) {
    console.error("\nDEBUG ERROR:");
    console.error(error.message);

    if (error.stack) {
      console.error("\nSTACK:");
      console.error(error.stack);
    }
  }
}

debugKategori();