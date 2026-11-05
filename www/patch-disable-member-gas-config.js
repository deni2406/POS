const fs = require("fs");

const file = "C:\\POS\\config.js";
let s = fs.readFileSync(file, "utf8");

const oldValue = 'GAS_MEMBER_URL: "https://script.google.com/macros/s/AKfycbzEDWxLvxXAYmVpP3dO8531HWgk_qi6dNT66zoOeO0P_-WNHQlGO_8u7w6-XBVBAzGp/exec",';
const newValue = 'GAS_MEMBER_URL: null,';

if (!s.includes(oldValue)) {
  throw new Error("Nilai GAS_MEMBER_URL yang diharapkan tidak ditemukan. Tidak ada perubahan.");
}

s = s.replace(oldValue, newValue);
fs.writeFileSync(file, s, "utf8");

console.log("GAS_MEMBER_URL BERHASIL DINONAKTIFKAN.");
