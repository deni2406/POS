"use strict";

// Historical CLI entry point retained to fail safely for old deployment commands.
const { fetchGetBarang } = require("./source-adapter");
fetchGetBarang().catch(error => {
  console.error(`${error.code || "PBMS_IMPORT_DISABLED"}: ${error.message}`);
  process.exitCode = 1;
});
