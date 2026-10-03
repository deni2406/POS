"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { fetchGetBarang, importGetBarangToStaging } = require("../pbms-shadow/source-adapter");
const { getShadowDatabasePath, PRODUCTION_DATABASE } = require("../pbms-shadow/database-config");

test("shadow catalog external import remains disabled and never invokes fetch", async () => {
  let requests = 0;
  const fetchImpl = async () => { requests += 1; };
  await assert.rejects(fetchGetBarang({ fetchImpl }), error => error.code === "PBMS_CATALOG_IMPORT_DISABLED");
  await assert.rejects(importGetBarangToStaging({}, { fetchImpl }), error => error.code === "PBMS_CATALOG_IMPORT_DISABLED");
  assert.equal(requests, 0);
});

test("shadow database guard still rejects production pos.db", () => {
  assert.throws(() => getShadowDatabasePath(PRODUCTION_DATABASE), /pos\.db tidak diizinkan/);
  assert.throws(() => getShadowDatabasePath(path.join(path.dirname(PRODUCTION_DATABASE), "POS.DB")), /pos\.db tidak diizinkan/);
});
