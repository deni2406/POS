const fs = require("fs");

const file = "C:\\POS\\server.js";
const backup = file + ".pre-member-scheduler-fix-20260922";

fs.copyFileSync(file, backup);

let s = fs.readFileSync(file, "utf8");

const start = s.indexOf("function scheduleMemberDailyCheck() {");
const endMarker = "\n}\n";
const end = s.indexOf(endMarker, start);

if (start === -1 || end === -1) {
  console.error("PATCH GAGAL: fungsi scheduleMemberDailyCheck tidak ditemukan.");
  process.exit(1);
}

const newFunction = `function scheduleMemberDailyCheck() {
  const now = new Date();

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Makassar",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).formatToParts(now);

  const getPart = type =>
    Number(parts.find(p => p.type === type)?.value || 0);

  const currentWita = new Date(Date.UTC(
    getPart("year"),
    getPart("month") - 1,
    getPart("day"),
    getPart("hour"),
    getPart("minute"),
    getPart("second")
  ));

  const nextMidnightWita = new Date(Date.UTC(
    getPart("year"),
    getPart("month") - 1,
    getPart("day") + 1,
    0,
    0,
    0
  ));

  const delayMs = Math.max(
    1000,
    nextMidnightWita.getTime() - currentWita.getTime()
  );

  setTimeout(async () => {
    try {
      await cekStatusMemberHarian();
    } catch (error) {
      writeLog(
        "ERROR",
        "MEMBER_CHECK",
        "[MEMBER] Pemeriksaan status harian gagal",
        { error: error.message }
      );
    } finally {
      scheduleMemberDailyCheck();
    }
  }, delayMs);
}

cekStatusMemberHarian().catch(error => {
  writeLog(
    "ERROR",
    "MEMBER_CHECK",
    "[MEMBER] Pemeriksaan status member saat startup gagal",
    { error: error.message }
  );
});

scheduleMemberDailyCheck();`;

s = s.slice(0, start) + newFunction + s.slice(end + endMarker.length);

fs.writeFileSync(file, s, "utf8");

console.log("PATCH MEMBER SCHEDULER BERHASIL.");
console.log("Backup:", backup);
