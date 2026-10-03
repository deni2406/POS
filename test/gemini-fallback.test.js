"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { GEMINI_MODELS } = require("../gemini-config");
const {
  GeminiRequestError,
  generateWithFallback
} = require("../gemini-fallback");
const { createGeminiStatus, runWithGeminiStatus } = require("../gemini-status");
const { validateRows } = require("../pbms-validator");

function createTestStatus() {
  let output = "";
  let tick;
  let cleared = false;
  const status = createGeminiStatus({
    stdout: {
      isTTY: true,
      write: value => { output += value; }
    },
    platform: "win32",
    setIntervalFn: callback => {
      tick = callback;
      return 1;
    },
    clearIntervalFn: () => { cleared = true; }
  });
  return {
    status,
    tick: () => tick(),
    output: () => output,
    wasCleared: () => cleared
  };
}

test("status spinner dibersihkan setelah berhasil, fallback, dan semua model gagal", async () => {
  for (const scenario of ["success", "fallback", "failure"]) {
    const spinner = createTestStatus();
    const operation = async () => {
      spinner.tick();
      return generateWithFallback({
        models: GEMINI_MODELS.slice(0, 2),
        maxRetriesPerModel: 0,
        sleep: async () => {},
        async generateContent(model) {
          if (scenario === "success" || (scenario === "fallback" && model === GEMINI_MODELS[1])) {
            return { text: "ok" };
          }
      throw { status: 500 };
        }
      });
    };

    if (scenario === "failure") {
      await assert.rejects(runWithGeminiStatus(operation, spinner.status), GeminiRequestError);
    } else {
      const response = await runWithGeminiStatus(operation, spinner.status);
      assert.equal(response.text, "ok");
    }

    assert.equal(spinner.wasCleared(), true, `${scenario}: timer spinner harus dihentikan`);
    assert.match(spinner.output(), /\r\s+\r$/, `${scenario}: baris spinner harus dihapus`);
  }
});

test("fallback mencoba model berurutan dan retry sementara dengan backoff eksponensial", async () => {
  const calls = [];
  const delays = [];
  const logs = [];

  const response = await generateWithFallback({
    models: GEMINI_MODELS.slice(0, 3),
    maxRetriesPerModel: 2,
    initialBackoffMs: 10,
    maxBackoffMs: 100,
    sleep: async delay => delays.push(delay),
    log: message => logs.push(message),
    async generateContent(model) {
      calls.push(model);
      if (calls.length <= 3) throw { status: 500 };
      return { text: "ok" };
    }
  });

  assert.deepEqual(calls, [
    "gemini-3.1-pro-preview",
    "gemini-3.1-pro-preview",
    "gemini-3.1-pro-preview",
    "gemini-3.7-flash"
  ]);
  assert.deepEqual(delays, [10, 20]);
  assert.equal(response.text, "ok");
  assert.ok(logs.some(message => message.includes("Fallback") && message.includes("gemini-3.7-flash")));
  assert.ok(logs.some(message => message.includes("Berhasil") && message.includes("gemini-3.7-flash")));
});

test("HTTP 429, 503, dan 504 langsung fallback tanpa retry pada model yang gagal", async () => {
  for (const status of [429, 503, 504]) {
    const calls = [];
    const logs = [];
    const response = await generateWithFallback({
      models: GEMINI_MODELS.slice(0, 2),
      maxRetriesPerModel: 3,
      sleep: async () => assert.fail(`HTTP ${status} tidak boleh menunggu retry.`),
      log: message => logs.push(message),
      async generateContent(model) {
        calls.push(model);
        if (model === GEMINI_MODELS[0]) throw { status };
        return { text: `ok-${status}` };
      }
    });

    assert.deepEqual(calls, [GEMINI_MODELS[0], GEMINI_MODELS[1]], `HTTP ${status}`);
    assert.equal(response.text, `ok-${status}`);
    assert.ok(logs.some(message => message.includes("Fallback langsung") && message.includes(`HTTP ${status}`)));
    assert.ok(logs.some(message => message.includes("tanpa retry")));
  }
});

test("error permanen tidak memicu retry atau fallback", async () => {
  const calls = [];

  await assert.rejects(
    generateWithFallback({
      models: GEMINI_MODELS,
      sleep: async () => assert.fail("Error permanen tidak boleh di-retry."),
      log() {},
      async generateContent(model) {
        calls.push(model);
        throw { status: 403, message: "Permission denied" };
      }
    }),
    error => error instanceof GeminiRequestError && error.status === 403
  );

  assert.deepEqual(calls, ["gemini-3.1-pro-preview"]);
});

test("fallback dibatasi dan error terakhir tidak mengungkapkan detail mentah", async () => {
  let calls = 0;

  await assert.rejects(
    generateWithFallback({
      models: GEMINI_MODELS.slice(0, 2),
      maxRetriesPerModel: 1,
      initialBackoffMs: 0,
      sleep: async () => {},
      log() {},
      async generateContent() {
        calls += 1;
        throw { status: 500, message: "secret-looking response" };
      }
    }),
    error => error instanceof GeminiRequestError && !error.message.includes("secret-looking")
  );

  assert.equal(calls, 4);
});

test("validator PBMS generik melaporkan field kosong, duplikat, format, inkonsistensi dan anomali", () => {
  const result = validateRows([
    { id: "A1", amount: "1500", status: "paid", date: "bad" },
    { id: "A1", amount: "-2", status: "paid", date: "" }
  ], {
    requiredFields: ["id", "date"],
    uniqueBy: ["id"],
    fieldRules: [{
      field: "date",
      validate: value => /^\d{4}-\d{2}-\d{2}$/.test(value),
      message: "Format tanggal harus YYYY-MM-DD."
    }],
    rowRules: [
      {
        code: "inconsistent",
        field: "status",
        validate: row => row.status !== "paid" || Number(row.amount) > 0,
        message: "Status paid harus memiliki amount positif."
      },
      {
        code: "implausible",
        field: "amount",
        validate: row => Number(row.amount) >= 0,
        message: "Amount tidak boleh negatif."
      },
      {
        code: "anomaly",
        field: "amount",
        validate: row => Number(row.amount) <= 1000,
        message: "Amount di luar rentang umum."
      }
    ]
  });

  assert.equal(result.valid, false);
  assert.deepEqual(
    [...new Set(result.issues.map(issue => issue.code))].sort(),
    ["anomaly", "duplicate", "implausible", "inconsistent", "invalid_format", "missing"]
  );
});
