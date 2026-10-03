const fs = require("fs");

const file = "C:/POS/server.js";
const src = fs.readFileSync(file, "utf8");

const start = src.indexOf("async function getMemberListCached() {");
const end = src.indexOf("\nsetInterval(() => {", start);

if (start === -1 || end === -1) {
  console.error("FUNGSI getMemberListCached TIDAK DITEMUKAN. TIDAK ADA PERUBAHAN.");
  process.exit(1);
}

const newBlock = `async function getMemberListCached() {
  return await getMemberCacheFromDb();
}
`;

const out = src.slice(0, start) + newBlock + src.slice(end);
fs.writeFileSync(file, out, "utf8");

console.log("PATCH READ MEMBER LOKAL BERHASIL.");
