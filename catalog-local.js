function readLocalCatalogSummary(db) {
  const get = sql => new Promise((resolve, reject) =>
    db.get(sql, (error, row) => error ? reject(error) : resolve(row || {})));
  return Promise.all([
    get("SELECT COUNT(*) AS jumlah, MAX(updated_at) AS updatedAt FROM master_barang"),
    get("SELECT COUNT(*) AS jumlah FROM harga_member_cache")
  ]).then(([products, prices]) => ({
    success: false,
    localOnly: true,
    message: "Sinkronisasi eksternal dinonaktifkan. Katalog dan harga tetap dikelola lokal.",
    jumlah: Number(products.jumlah || 0),
    hargaTersimpan: Number(prices.jumlah || 0),
    updatedAt: products.updatedAt || null
  }));
}

async function respondLocalCatalogSync(db, response) {
  const result = await readLocalCatalogSummary(db);
  response.writeHead(410, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(result));
}

module.exports = { readLocalCatalogSummary, respondLocalCatalogSync };
