function normalizedMarker(value) {
  return String(value ?? "").trim().toUpperCase();
}

function hasLocalIdentityFields(value) {
  return value && (value.localMasterBarangId != null || value.local_master_barang_id != null ||
    value.localIdentity != null || value.local_identity != null);
}

function localPayloadReason(data) {
  const soId = normalizedMarker(data?.soId ?? data?.so_id);
  if (/^SO-LOCAL-/.test(soId)) return "LOCAL_SO_ID";
  if (normalizedMarker(data?.source) === "LOCAL" || hasLocalIdentityFields(data)) return "LOCAL_IDENTITY";
  if (Array.isArray(data?.items) && data.items.some(item => item &&
      (normalizedMarker(item.source) === "LOCAL" || hasLocalIdentityFields(item)))) return "LOCAL_IDENTITY";
  return null;
}

async function callLegacyStockOpnameGas(data) {
  const reason = localPayloadReason(data);
  const error = new Error(reason
    ? "Payload Stock Opname lokal tidak didukung oleh endpoint legacy."
    : "Pemrosesan Stock Opname legacy dinonaktifkan; rumus dan audit trail belum tervalidasi untuk migrasi lokal.");
  error.statusCode = 503;
  error.code = reason ? "LOCAL_SO_NOT_ALLOWED" : "SO_LEGACY_DISABLED";
  throw error;
}

function localConflictResponse(error) {
  const activeCategoryConstraint = String(error?.code || "").startsWith("SQLITE_CONSTRAINT") &&
    /UNIQUE constraint failed:\s*stock_opname\.kategori/i.test(String(error?.message || ""));
  if (error?.code === "SO_STILL_ACTIVE" || activeCategoryConstraint) {
    return { status: 409, body: { success: false, code: "SO_STILL_ACTIVE", message: error.message } };
  }
  return null;
}

module.exports = { localPayloadReason, callLegacyStockOpnameGas, localConflictResponse };
