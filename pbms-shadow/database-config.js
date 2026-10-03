"use strict";

const path = require("node:path");

const DEFAULT_SHADOW_DATABASE = path.resolve(__dirname, "data", "pbms-shadow.sqlite");
const PRODUCTION_DATABASE = path.resolve(__dirname, "..", "pos.db");

function getShadowDatabasePath(candidate = DEFAULT_SHADOW_DATABASE) {
  const resolved = path.resolve(candidate);
  if (resolved.toLowerCase() === PRODUCTION_DATABASE.toLowerCase() || path.basename(resolved).toLowerCase() === "pos.db") {
    throw new Error("Database PBMS shadow wajib terpisah; pos.db tidak diizinkan.");
  }
  return resolved;
}

module.exports = { DEFAULT_SHADOW_DATABASE, PRODUCTION_DATABASE, getShadowDatabasePath };
