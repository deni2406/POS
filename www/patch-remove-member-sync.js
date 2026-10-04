const fs = require("fs");

const file = "C:\\POS\\server.js";
let s = fs.readFileSync(file, "utf8");

const start = s.indexOf('let memberSyncInProgress = null;');
const endMarker = 'async function getMemberListCached() {';

if (start === -1) {
  throw new Error("Blok memberSyncInProgress tidak ditemukan.");
}

const end = s.indexOf(endMarker, start);
if (end === -1) {
  throw new Error("Fungsi getMemberListCached tidak ditemukan setelah blok sync.");
}

s = s.slice(0, start) + s.slice(end);

fs.writeFileSync(file, s, "utf8");
console.log("FUNGSI SYNC MEMBER DARI GAS BERHASIL DIHAPUS.");
