(function (global) {
  function isMorningHour(hour) {
    const h = Number(hour);
    return Number.isFinite(h) && h >= 7 && h < 18;
  }

  function isNightHour(hour) {
    const h = Number(hour);
    return Number.isFinite(h) && (h >= 18 || h < 7);
  }

  global.MEMBER_SCHEDULE = {
    isMorningHour: isMorningHour,
    isNightHour: isNightHour
  };
})(typeof window !== "undefined" ? window : this);
