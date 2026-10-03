"use strict";

const {
  GEMINI_MODELS,
  MAX_RETRIES_PER_MODEL,
  INITIAL_BACKOFF_MS,
  MAX_BACKOFF_MS
} = require("./gemini-config");

const TRANSIENT_HTTP_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const IMMEDIATE_FALLBACK_HTTP_STATUSES = new Set([429, 503, 504]);
const PERMANENT_ERROR_TERMS = [
  "api key not valid",
  "invalid api key",
  "permission denied",
  "unauthorized",
  "forbidden",
  "invalid argument",
  "invalid request",
  "bad request",
  "malformed",
  "prompt is empty",
  "request contains an invalid"
];
const TRANSIENT_ERROR_TERMS = [
  "timeout",
  "timed out",
  "temporarily unavailable",
  "temporary unavailable",
  "service unavailable",
  "server is busy",
  "overloaded",
  "rate limit",
  "resource exhausted",
  "connection reset",
  "connection refused",
  "network error"
];
const TRANSIENT_NETWORK_CODES = new Set([
  "ABORT_ERR",
  "ECONNREFUSED",
  "ECONNRESET",
  "EAI_AGAIN",
  "ENETDOWN",
  "ENETUNREACH",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT"
]);

class GeminiRequestError extends Error {
  constructor(message, { model, status, transient = false } = {}) {
    super(message);
    this.name = "GeminiRequestError";
    this.model = model;
    this.status = status;
    this.transient = transient;
  }
}

function getStatus(error) {
  const status = error?.status ?? error?.response?.status;
  const parsed = typeof status === "number" ? status : Number(status);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function getErrorCode(error) {
  const code = error?.code ?? error?.cause?.code;
  return typeof code === "string" ? code.toUpperCase() : "";
}

function classifyTemporaryError(error) {
  const status = getStatus(error);
  if (status !== undefined) {
    if (TRANSIENT_HTTP_STATUSES.has(status)) {
      return { status, reason: `HTTP ${status} (kesalahan sementara)` };
    }
    return null;
  }

  const code = getErrorCode(error);
  if (TRANSIENT_NETWORK_CODES.has(code)) {
    const reason = code.includes("TIMEOUT") || code === "ETIMEDOUT"
      ? "timeout jaringan"
      : `gangguan jaringan (${code})`;
    return { reason };
  }

  const message = typeof error?.message === "string" ? error.message.toLowerCase() : "";
  if (PERMANENT_ERROR_TERMS.some(term => message.includes(term))) return null;
  if (TRANSIENT_ERROR_TERMS.some(term => message.includes(term))) {
    return { reason: "layanan atau jaringan sementara tidak tersedia" };
  }
  return null;
}

function wait(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function generateWithFallback({
  generateContent,
  models = GEMINI_MODELS,
  maxRetriesPerModel = MAX_RETRIES_PER_MODEL,
  initialBackoffMs = INITIAL_BACKOFF_MS,
  maxBackoffMs = MAX_BACKOFF_MS,
  sleep = wait,
  log = () => {}
}) {
  if (typeof generateContent !== "function") {
    throw new TypeError("generateContent harus berupa fungsi.");
  }
  if (!Array.isArray(models) || models.length === 0 || models.some(model => typeof model !== "string" || !model)) {
    throw new TypeError("Daftar model Gemini tidak valid.");
  }
  if (!Number.isInteger(maxRetriesPerModel) || maxRetriesPerModel < 0) {
    throw new TypeError("maxRetriesPerModel harus bilangan bulat >= 0.");
  }
  if (!Number.isFinite(initialBackoffMs) || initialBackoffMs < 0 ||
      !Number.isFinite(maxBackoffMs) || maxBackoffMs < 0) {
    throw new TypeError("Nilai backoff harus berupa angka >= 0.");
  }

  for (let modelIndex = 0; modelIndex < models.length; modelIndex += 1) {
    const model = models[modelIndex];

    for (let retry = 0; retry <= maxRetriesPerModel; retry += 1) {
      log(`Mencoba model ${model} (${retry + 1}/${maxRetriesPerModel + 1}).`);

      try {
        const response = await generateContent(model);
        log(`Berhasil menggunakan model ${model}.`);
        return response;
      } catch (error) {
        const temporaryError = classifyTemporaryError(error);
        const status = temporaryError?.status ?? getStatus(error);
        if (!temporaryError) {
          throw new GeminiRequestError(
            status === undefined
              ? `kesalahan permanen atau tidak dapat dipulihkan pada model ${model}`
              : `HTTP ${status} pada model ${model}`,
            { model, status }
          );
        }

        const retriesRemain = retry < maxRetriesPerModel;
        const immediateFallback = IMMEDIATE_FALLBACK_HTTP_STATUSES.has(status);
        if (retriesRemain && !immediateFallback) {
          const delay = Math.min(initialBackoffMs * (2 ** retry), maxBackoffMs);
          log(`Model ${model} gagal sementara (${temporaryError.reason}); retry ${retry + 1}/${maxRetriesPerModel} dalam ${delay} ms.`);
          await sleep(delay);
          continue;
        }

        const nextModel = models[modelIndex + 1];
        if (nextModel) {
          log(immediateFallback
            ? `Fallback langsung dari ${model} ke ${nextModel}: ${temporaryError.reason}; tanpa retry pada model ini.`
            : `Fallback dari ${model} ke ${nextModel}: ${temporaryError.reason}; retry model sudah habis.`);
          break;
        }

        throw new GeminiRequestError(
          `semua model gagal setelah error sementara terakhir (${temporaryError.reason})`,
          { model, status, transient: true }
        );
      }
    }
  }
}

module.exports = {
  GeminiRequestError,
  classifyTemporaryError,
  generateWithFallback
};
