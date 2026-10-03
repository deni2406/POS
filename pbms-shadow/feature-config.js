"use strict";

const SHADOW_CATALOG_ENV = "PBMS_SHADOW_CATALOG_ENABLED";

function isShadowCatalogEnabled(env = process.env) {
  return String(env[SHADOW_CATALOG_ENV] ?? "").trim().toLowerCase() === "true";
}

function selectCatalogRepository({ legacy, shadow, env = process.env } = {}) {
  if (isShadowCatalogEnabled(env)) {
    if (!shadow) throw new Error("Repository katalog shadow belum dikonfigurasi.");
    return shadow;
  }
  if (!legacy) throw new Error("Repository katalog lama belum dikonfigurasi.");
  return legacy;
}

module.exports = { SHADOW_CATALOG_ENV, isShadowCatalogEnabled, selectCatalogRepository };
