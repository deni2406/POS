"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { SHADOW_CATALOG_ENV, isShadowCatalogEnabled, selectCatalogRepository } = require("../pbms-shadow/feature-config");

test("catalog feature flag defaults OFF and selects the legacy repository", () => {
  const legacy = { name: "legacy" };
  const shadow = { name: "shadow" };
  assert.equal(isShadowCatalogEnabled({}), false);
  assert.equal(selectCatalogRepository({ legacy, shadow, env: {} }), legacy);
  assert.equal(selectCatalogRepository({ legacy, shadow, env: { [SHADOW_CATALOG_ENV]: "false" } }), legacy);
});

test("catalog feature flag ON selects shadow only in the supplied isolated environment", () => {
  const legacy = { name: "legacy" };
  const shadow = { name: "shadow" };
  const isolatedEnv = { [SHADOW_CATALOG_ENV]: "true" };
  assert.equal(isShadowCatalogEnabled(isolatedEnv), true);
  assert.equal(selectCatalogRepository({ legacy, shadow, env: isolatedEnv }), shadow);
  assert.throws(() => selectCatalogRepository({ legacy, env: isolatedEnv }), /belum dikonfigurasi/);
});
