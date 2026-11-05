"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { GEMINI_MODELS } = require("../gemini-config");
const { generateWithFallback } = require("../gemini-fallback");
const {
  ApiKeyPool,
  ApiKeyPoolError,
  createUserKeyStorage,
  maskApiKey
} = require("../api-key-pool");

function createMemoryStorage(initial = {}) {
  let value = {
    keys: [],
    activeId: null,
    states: {},
    ...structuredClone(initial)
  };
  return {
    read: () => structuredClone(value),
    write: next => { value = structuredClone(next); },
    snapshot: () => structuredClone(value)
  };
}

test("environment API keys retain single-key compatibility and support numbered keys", () => {
  const pool = new ApiKeyPool({
    env: {
      GEMINI_API_KEY: "primary-secret-key",
      GEMINI_API_KEY_2: "secondary-secret-key",
      GEMINI_API_KEY_4: "fourth-secret-key",
      GEMINI_API_KEY_IGNORED: "not-a-key"
    },
    storage: createMemoryStorage()
  });
  const keys = pool.list();

  assert.equal(keys.length, 3);
  assert.equal(keys[0].id, "env:GEMINI_API_KEY");
  assert.equal(keys[0].status, "ACTIVE");
  assert.equal(keys[1].id, "env:GEMINI_API_KEY_2");
  assert.equal(keys[2].id, "env:GEMINI_API_KEY_4");
  assert.ok(keys.every(key => !JSON.stringify(key).includes("secret")));
});

test("a readable credential store keeps its stored credentials available", () => {
  const storedKey = "stored-credential-secret";
  const storage = createMemoryStorage({
    keys: [{ id: "stored:1", key: storedKey }], activeId: "stored:1"
  });
  const pool = new ApiKeyPool({ env: {}, storage });

  assert.equal(pool.list()[0].id, "stored:1");
  assert.equal(pool.activeId, "stored:1");
  assert.ok(!JSON.stringify(pool.list()).includes(storedKey));
});

test("a failed credential store read falls back to environment credentials without exposing secrets", () => {
  const secret = "environment-fallback-private-secret";
  const storage = { read() { throw new Error(`DPAPI failed for ${secret}`); } };
  const pool = new ApiKeyPool({ env: { GEMINI_API_KEY: secret }, storage });

  assert.equal(pool.list()[0].id, "env:GEMINI_API_KEY");
  assert.equal(pool.activeId, "env:GEMINI_API_KEY");
  assert.ok(!JSON.stringify(pool.list()).includes(secret));
  assert.ok(!pool.redact(`failure ${secret}`).includes(secret));
});

test("a failed credential store read without environment credentials gives actionable secret-free error", () => {
  const secret = "store-secret-must-not-leak";
  const storage = { read() { throw new Error(`DPAPI failed for ${secret}`); } };

  assert.throws(() => new ApiKeyPool({ env: {}, storage }), error => {
    assert.match(error.message, /Set GEMINI_API_KEY/);
    assert.match(error.message, /Windows user credential access/);
    assert.ok(!error.message.includes(secret));
    assert.ok(!error.message.includes("DPAPI failed"));
    return true;
  });
});

test("single environment key continues to supply existing requests without extra setup", async () => {
  const key = "legacy-environment-key";
  const pool = new ApiKeyPool({
    env: { GEMINI_API_KEY: key },
    storage: createMemoryStorage()
  });
  let received;
  const response = await pool.runWithRotation(async candidate => {
    received = candidate;
    return { text: "ok" };
  });

  assert.equal(received, key);
  assert.equal(response.text, "ok");
  assert.equal(pool.list().length, 1);
});

test("masking and redaction never return complete API keys", () => {
  const key = "AIzaSyDUMMY_PRIVATE_KEY_1234567Xk";
  const pool = new ApiKeyPool({
    env: { GEMINI_API_KEY: key },
    storage: createMemoryStorage()
  });
  assert.notEqual(maskApiKey(key), key);
  assert.ok(pool.list()[0].masked.includes("*"));
  assert.ok(!pool.redact(`received ${key}` ).includes(key));
});

test("user keys persist via protected storage and add/remove requires active-key confirmation", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "alva-key-store-"));
  const filePath = path.join(directory, "credentials.json");
  const protector = {
    protect: value => Buffer.from(value).toString("base64"),
    unprotect: value => Buffer.from(value, "base64").toString()
  };
  const storage = createUserKeyStorage({ platform: "win32", env: {}, filePath, protector });
  const pool = new ApiKeyPool({ env: {}, storage });
  const added = pool.add("AIzaSECRET_CUSTOM_KEY_7890");
  const serializedStore = fs.readFileSync(filePath, "utf8");

  assert.equal(pool.list()[0].status, "ACTIVE");
  assert.ok(!serializedStore.includes("AIzaSECRET_CUSTOM_KEY_7890"));
  assert.equal(storage.read().keys[0].key, "AIzaSECRET_CUSTOM_KEY_7890");
  assert.deepEqual(pool.remove(added.id), {
    confirmationRequired: true,
    entry: pool.list()[0]
  });
  assert.equal(pool.remove(added.id, { confirmed: true }).removed, true);
  assert.equal(pool.list().length, 0);
  fs.rmSync(directory, { recursive: true, force: true });
});

test("removing an active environment key confirms and selects the next key", () => {
  const pool = new ApiKeyPool({
    env: { GEMINI_API_KEY: "first-long-environment-key", GEMINI_API_KEY_2: "second-long-environment-key" },
    storage: createMemoryStorage()
  });
  const active = pool.list()[0];

  assert.equal(pool.remove(active.id).confirmationRequired, true);
  const removed = pool.remove(active.id, { confirmed: true });
  assert.equal(removed.source, "environment");
  assert.equal(pool.list()[0].status, "ACTIVE");
  assert.equal(pool.list()[0].id, "env:GEMINI_API_KEY_2");
});

test("active key selection is persisted without exposing its value", () => {
  const storage = createMemoryStorage();
  const pool = new ApiKeyPool({
    env: { GEMINI_API_KEY: "first-long-environment-key", GEMINI_API_KEY_2: "second-long-environment-key" },
    storage
  });
  const second = pool.list()[1];
  pool.setActive(second.id);

  assert.equal(pool.list()[1].status, "ACTIVE");
  assert.equal(storage.snapshot().activeId, second.id);
  assert.ok(!JSON.stringify(storage.snapshot()).includes("environment-key"));
});

test("key testing reports ready, rate-limited, and invalid states using masked identifiers", async () => {
  const pool = new ApiKeyPool({
    env: {
      GEMINI_API_KEY: "first-long-environment-key",
      GEMINI_API_KEY_2: "second-long-environment-key",
      GEMINI_API_KEY_3: "third-long-environment-key"
    },
    storage: createMemoryStorage(),
    cooldownMs: 50
  });
  const results = await pool.testAll(async key => {
    if (key.startsWith("second")) throw { status: 429 };
    if (key.startsWith("third")) throw { status: 403 };
  });

  assert.deepEqual(results.map(result => result.status), ["ACTIVE", "RATE LIMITED", "INVALID"]);
  assert.ok(results.every(result => !JSON.stringify(result).includes("environment-key")));
});

test("429 quota exhaustion rotates to the next key after preserving model fallback", async () => {
  const pool = new ApiKeyPool({
    env: { GEMINI_API_KEY: "first-long-environment-key", GEMINI_API_KEY_2: "second-long-environment-key" },
    storage: createMemoryStorage(),
    cooldownMs: 50
  });
  const attempts = [];
  const response = await pool.runWithRotation(key =>
    generateWithFallback({
      models: GEMINI_MODELS.slice(0, 2),
      maxRetriesPerModel: 0,
      sleep: async () => {},
      async generateContent(model) {
        attempts.push({ key, model });
        if (key.startsWith("first")) throw { status: 429 };
        return { text: "ok" };
      }
    })
  );

  assert.equal(response.text, "ok");
  assert.deepEqual(attempts.map(attempt => attempt.model), [
    GEMINI_MODELS[0], GEMINI_MODELS[1], GEMINI_MODELS[0]
  ]);
  assert.ok(attempts[0].key.startsWith("first"));
  assert.ok(attempts[2].key.startsWith("second"));
  assert.equal(pool.list()[0].status, "COOLDOWN");
});

test("invalid keys are marked unavailable and rotation is finite", async () => {
  const pool = new ApiKeyPool({
    env: { GEMINI_API_KEY: "first-long-environment-key", GEMINI_API_KEY_2: "second-long-environment-key" },
    storage: createMemoryStorage()
  });
  let attempts = 0;
  await assert.rejects(pool.runWithRotation(async () => {
    attempts += 1;
    throw { status: 401 };
  }), ApiKeyPoolError);

  assert.equal(attempts, 2);
  assert.ok(pool.list().every(key => key.status === "INVALID"));
});

test("rate-limited keys cool down and all-exhausted calls fail without retry loops", async () => {
  let now = 1000;
  const pool = new ApiKeyPool({
    env: { GEMINI_API_KEY: "first-long-environment-key", GEMINI_API_KEY_2: "second-long-environment-key" },
    storage: createMemoryStorage(),
    cooldownMs: 100,
    now: () => now
  });
  let attempts = 0;

  await assert.rejects(pool.runWithRotation(async () => {
    attempts += 1;
    throw { status: 429 };
  }), error => error instanceof ApiKeyPoolError && error.code === "all_rate_limited");
  assert.equal(attempts, 2);
  await assert.rejects(pool.runWithRotation(async () => {
    attempts += 1;
  }), error => error instanceof ApiKeyPoolError && error.code === "all_rate_limited");
  assert.equal(attempts, 2);
  assert.ok(pool.list().every(key => key.status === "COOLDOWN"));

  now += 101;
  const result = await pool.runWithRotation(async key => key);
  assert.equal(result, "first-long-environment-key");
});

test("non-quota transient errors do not rotate API keys", async () => {
  const pool = new ApiKeyPool({
    env: { GEMINI_API_KEY: "first-long-environment-key", GEMINI_API_KEY_2: "second-long-environment-key" },
    storage: createMemoryStorage()
  });
  let attempts = 0;
  await assert.rejects(pool.runWithRotation(async () => {
    attempts += 1;
    throw { status: 503 };
  }));
  assert.equal(attempts, 1);
  assert.ok(pool.list().every(key => key.status !== "COOLDOWN"));
});

test("an empty pool fails cleanly and storage creation does not store environment secrets", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "alva-key-empty-"));
  const filePath = path.join(directory, "credentials.json");
  const pool = new ApiKeyPool({
    env: { GEMINI_API_KEY: "env-secret-should-not-persist" },
    storage: createUserKeyStorage({ platform: "linux", env: {}, filePath })
  });

  assert.equal(pool.list().length, 1);
  assert.ok(!fs.existsSync(filePath));
  fs.rmSync(directory, { recursive: true, force: true });
});
