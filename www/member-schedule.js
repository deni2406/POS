(function (root) {
  const schedule = Object.freeze({
    pagiMulai: 7,
    malamMulai: 18,
    isNightHour: hour => hour >= 18 || hour < 7,
    isMorningHour: hour => hour >= 7 && hour < 18
  });
  if (typeof module !== "undefined" && module.exports) module.exports = schedule;
  if (root) root.MEMBER_SCHEDULE = schedule;
})(typeof globalThis !== "undefined" ? globalThis : this);
