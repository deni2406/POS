console.log("[WAITINGLIST-API] Module loaded (stubbed).");
window.WaitingListAPI = window.WaitingListAPI || {
  init: () => {},
  fetchData: () => Promise.resolve([])
};
