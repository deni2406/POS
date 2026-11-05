const fs = require("fs");

const file = "C:\\POS\\server.js";
let s = fs.readFileSync(file, "utf8");

const oldLine = 'const { callMemberGas, callMemberGasGet } = require("./gas-member");\r\n';
const oldLineLf = 'const { callMemberGas, callMemberGasGet } = require("./gas-member");\n';

if (s.includes(oldLine)) {
  s = s.replace(oldLine, "");
} else if (s.includes(oldLineLf)) {
  s = s.replace(oldLineLf, "");
} else {
  throw new Error("Import gas-member tidak ditemukan.");
}

fs.writeFileSync(file, s, "utf8");
console.log("IMPORT GAS MEMBER BERHASIL DIHAPUS.");
