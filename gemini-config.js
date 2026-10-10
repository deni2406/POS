"use strict";

module.exports = Object.freeze({
  GEMINI_MODELS: Object.freeze([
    "gemini-3.1-pro-preview",
    "gemini-3.7-flash",
    "gemini-3.6-flash",
    "gemini-flash-latest",
    "gemini-3.5-flash-lite"
  ]),
  MAX_RETRIES_PER_MODEL: 2,
  INITIAL_BACKOFF_MS: 1000,
  MAX_BACKOFF_MS: 8000,
  REQUEST_TIMEOUT_MS: 30000
});
