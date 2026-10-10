const MEMBER_SCHEDULE = require('./member-schedule');
function selectLocalMemberPrice(rows, durationInput, startTimeInput) {
  const duration = Number(durationInput);
  if (!Number.isInteger(duration) || duration < 1 || !startTimeInput) return null;
  const start = new Date(startTimeInput);
  if (Number.isNaN(start.getTime())) return null;
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Makassar", hour: "2-digit", minute: "2-digit", hour12: false
  }).format(start);
  const matches = (rows || []).filter(row => {
    const from = String(row.jam || "").trim();
    const to = String(row.jam_selesai || "").trim();
    if (!from || !to) return false;
    return from < to ? time >= from && time < to : time >= from || time < to;
  }).filter(row => Number(row.durasi_jam || 0) <= duration)
    .sort((a, b) => Number(b.durasi_jam || 0) - Number(a.durasi_jam || 0));
  const rule = matches[0];
  if (!rule) return null;
  const pricePerHour = Number(rule.harga_per_jam);
  if (!Number.isFinite(pricePerHour) || pricePerHour <= 0) return null;
  return { hargaPerJam: pricePerHour, total: pricePerHour * duration, jam: time };
}

module.exports = { selectLocalMemberPrice };

