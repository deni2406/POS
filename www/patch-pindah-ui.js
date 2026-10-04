const fs = require("fs");

const file = "C:\\POS\\index.html";
const backup = "C:\\POS\\index.html.pre-pindah-ui-20260922";

fs.copyFileSync(file, backup);

let html = fs.readFileSync(file, "utf8");

const marker = '<style id="pindahMejaUiFix">';

if (html.includes(marker)) {
  console.log("PATCH SUDAH ADA. Tidak melakukan perubahan kedua.");
  process.exit(0);
}

const css = `
<style id="pindahMejaUiFix">
/* ==================================================
   FIX UI MODAL PINDAH MEJA
   Hanya berlaku untuk #pindahMejaModal
================================================== */

#pindahMejaModal .popup-card {
  width: min(440px, calc(100vw - 24px)) !important;
  max-width: 440px !important;
  padding: 18px !important;
  border-radius: 16px !important;
  box-sizing: border-box !important;
}

#pindahMejaModal .popup-header {
  margin-bottom: 14px !important;
  padding-bottom: 10px !important;
}

#pindahMejaModal .popup-title {
  margin: 0 !important;
  font-size: 1.05rem !important;
  font-weight: 800 !important;
  line-height: 1.2 !important;
}

#pindahMejaModal .popup-close-btn {
  width: 34px !important;
  height: 34px !important;
  min-width: 34px !important;
  min-height: 34px !important;
  max-width: 34px !important;
  max-height: 34px !important;
  padding: 0 !important;
  display: flex !important;
  align-items: center !important;
  justify-content: center !important;
  font-size: 1.35rem !important;
}

#pindahMejaModal .pindah-info-box {
  background: #f8fafc !important;
  border: 1px solid #e2e8f0 !important;
  border-radius: 10px !important;
  padding: 11px 13px !important;
  margin-bottom: 15px !important;
}

#pindahMejaModal .pindah-info-row {
  display: flex !important;
  align-items: center !important;
  justify-content: space-between !important;
  gap: 12px !important;
  min-height: 26px !important;
}

#pindahMejaModal .pindah-info-label {
  color: #64748b !important;
  font-size: 0.78rem !important;
  font-weight: 700 !important;
}

#pindahMejaModal .pindah-info-value {
  color: #0f172a !important;
  font-size: 0.86rem !important;
  font-weight: 800 !important;
  text-align: right !important;
}

#pindahMejaModal .pindah-customer-value {
  color: #2563eb !important;
}

#pindahMejaModal .pindah-time-value {
  color: #059669 !important;
  font-family: monospace !important;
}

#pindahMejaModal .pindah-label {
  display: block !important;
  margin: 0 0 7px !important;
  color: #374151 !important;
  font-size: 0.78rem !important;
  font-weight: 800 !important;
}

#pindahMejaModal #pindahMejaTujuanSelect {
  width: 100% !important;
  min-height: 46px !important;
  height: 46px !important;
  box-sizing: border-box !important;
  padding: 0 12px !important;
  border: 1px solid #d1d5db !important;
  border-radius: 9px !important;
  background: #ffffff !important;
  color: #111827 !important;
  font-size: 0.9rem !important;
  font-weight: 700 !important;
}

#pindahMejaModal .pindah-actions {
  display: grid !important;
  grid-template-columns: 1fr 1fr !important;
  gap: 9px !important;
  margin-top: 16px !important;
}

#pindahMejaModal .popup-table-btn {
  width: 100% !important;
  min-width: 0 !important;
  max-width: none !important;
  height: 44px !important;
  min-height: 44px !important;
  max-height: 44px !important;
  padding: 0 12px !important;
  margin: 0 !important;
  border-radius: 9px !important;
  display: flex !important;
  align-items: center !important;
  justify-content: center !important;
  box-sizing: border-box !important;
  font-size: 0.78rem !important;
  font-weight: 800 !important;
  line-height: 1 !important;
}

#pindahMejaModal #konfirmasiPindahMejaBtn {
  background: #2563eb !important;
  color: #ffffff !important;
  border: 1px solid #2563eb !important;
}

#pindahMejaModal #konfirmasiPindahMejaBtn:hover {
  background: #1d4ed8 !important;
}

@media (max-width: 520px) {
  #pindahMejaModal .popup-card {
    width: calc(100vw - 20px) !important;
    padding: 16px !important;
  }

  #pindahMejaModal .pindah-info-row {
    gap: 8px !important;
  }
}
</style>
`;

const insertBefore = "</head>";

if (!html.includes(insertBefore)) {
  console.error("PATCH GAGAL: </head> tidak ditemukan.");
  process.exit(1);
}

html = html.replace(insertBefore, css + "\\n" + insertBefore);

fs.writeFileSync(file, html, "utf8");

console.log("PATCH UI PINDAH MEJA BERHASIL.");
console.log("Backup:", backup);
