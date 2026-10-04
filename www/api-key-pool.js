"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const DEFAULT_KEY_COOLDOWN_MS = 60_000;

function maskApiKey(key) {
  const value = String(key);
  if (value.length <= 7) return `${"*".repeat(Math.max(3, value.length))}`;
  return `${value.slice(0, 4)}${"*".repeat(Math.min(8, value.length - 7))}${value.slice(-3)}`;
}

function getErrorStatus(error) {
  const raw = error?.status ?? error?.response?.status;
  const status = typeof raw === "number" ? raw : Number(raw);
  return Number.isInteger(status) && status > 0 ? status : undefined;
}

function createDpapiProtector(platform = process.platform) {
  if (platform !== "win32") return null;

  function transform(value, protect) {
    const script = protect
      ? "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $raw=[Console]::In.ReadToEnd(); $bytes=[Text.Encoding]::UTF8.GetBytes($raw); $out=[Security.Cryptography.ProtectedData]::Protect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($out))"
      : "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $raw=[Console]::In.ReadToEnd(); $bytes=[Convert]::FromBase64String($raw); $out=[Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Text.Encoding]::UTF8.GetString($out))";
    try {
      return execFileSync("powershell.exe", [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        script
      ], {
        input: protect ? value : value,
        encoding: "utf8",
        windowsHide: true,
        stdio: ["pipe", "pipe", "ignore"]
      }).trim();
    } catch {
      throw new Error("Windows user credential protection failed.");
    }
  }

  return {
    protect: value => transform(value, true),
    unprotect: value => transform(value, false)
  };
}

function createUserKeyStorage({
  platform = process.platform,
  env = process.env,
  filePath = path.join(env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "ALVA", "api-keys.json"),
  protector = createDpapiProtector(platform)
} = {}) {
  function read() {
    if (!fs.existsSync(filePath)) return { keys: [], activeId: null, states: {} };
    try {
      const record = JSON.parse(fs.readFileSync(filePath, "utf8"));
      const serialized = record.protected
        ? protector?.unprotect(record.data)
        : record.data;
      if (typeof serialized !== "string") throw new Error("Stored credential format is invalid.");
      const value = JSON.parse(serialized);
      return {
        keys: Array.isArray(value.keys) ? value.keys : [],
        activeId: typeof value.activeId === "string" ? value.activeId : null,
        states: value.states && typeof value.states === "object" ? value.states : {}
      };
    } catch {
      throw new Error("Unable to read ALVA's local credential store.");
    }
  }

  function write(value) {
    let record;
    const serialized = JSON.stringify(value);
    if (protector) {
      record = { version: 1, protected: true, data: protector.protect(serialized) };
    } else {
      record = { version: 1, protected: false, data: serialized };
    }

    const directory = path.dirname(filePath);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (platform !== "win32") {
      try { fs.chmodSync(directory, 0o700); } catch {}
    }
    const temporaryPath = `${filePath}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temporaryPath, JSON.stringify(record), { mode: 0o600 });
      if (platform !== "win32") fs.chmodSync(temporaryPath, 0o600);
      fs.renameSync(temporaryPath, filePath);
      if (platform !== "win32") fs.chmodSync(filePath, 0o600);
    } catch {
      try { fs.rmSync(temporaryPath, { force: true }); } catch {}
      throw new Error("Unable to save ALVA's local credential store.");
    }
  }

  return { read, write, filePath };
}

class ApiKeyPoolError extends Error {
  constructor(code) {
    super(code === "all_rate_limited"
      ? "All configured API keys are temporarily unavailable."
      : code === "no_valid_keys"
        ? "No valid API keys are available."
        : "No API key is configured.");
    this.name = "ApiKeyPoolError";
    this.code = code;
  }
}

class ApiKeyPool {
  constructor({
    env = process.env,
    storage = createUserKeyStorage({ env }),
    cooldownMs = DEFAULT_KEY_COOLDOWN_MS,
    now = Date.now
  } = {}) {
    this.storage = storage;
    this.cooldownMs = Math.max(1, Number(cooldownMs) || DEFAULT_KEY_COOLDOWN_MS);
    this.now = now;
    const seenKeys = new Set();
    this.environmentEntries = Object.entries(env)
      .filter(([name, key]) => (name === "GEMINI_API_KEY" || /^GEMINI_API_KEY_\d+$/.test(name)) &&
        typeof key === "string" && key.trim())
      .sort(([left], [right]) => {
        if (left === "GEMINI_API_KEY") return -1;
        if (right === "GEMINI_API_KEY") return 1;
        return Number(left.slice("GEMINI_API_KEY_".length)) - Number(right.slice("GEMINI_API_KEY_".length));
      })
      .map(([name, key], index) => ({
        id: `env:${name}`,
        label: `Key ${index + 1}`,
        key: key.trim(),
        source: "environment"
      }))
      .filter(entry => {
        if (seenKeys.has(entry.key)) return false;
        seenKeys.add(entry.key);
        return true;
      });
    try {
      this.state = storage.read();
    } catch {
      // A broken local store must not prevent environment credentials from
      // starting the workspace. Keep the store untouched; its read error is
      // still actionable when it is the only configured provider.
      if (this.environmentEntries.length === 0) {
        throw new Error("Unable to read ALVA's local credential store. Set GEMINI_API_KEY or repair the Windows user credential access to continue.");
      }
      this.state = { keys: [], activeId: null, states: {} };
    }
    this.disabledIds = new Set();
    this.normalizeStoredKeys();
    if (!this.state.activeId || !this.find(this.state.activeId)) {
      this.state.activeId = this.allEntries()[0]?.id ?? null;
    }
  }

  normalizeStoredKeys() {
    if (!Array.isArray(this.state.keys)) this.state.keys = [];
    this.state.keys = this.state.keys.filter(entry =>
      entry && typeof entry.id === "string" &&
      typeof entry.key === "string" && entry.key.trim()
    );
    if (!this.state.states || typeof this.state.states !== "object") this.state.states = {};
  }

  allEntries() {
    const entries = [...this.environmentEntries];
    for (const stored of this.state.keys) {
      if (!entries.some(entry => entry.key === stored.key)) {
        entries.push({
          id: stored.id,
          label: `Key ${entries.length + 1}`,
          key: stored.key,
          source: "stored"
        });
      }
    }
    return entries;
  }

  find(id) {
    return this.allEntries().find(entry => entry.id === id);
  }

  persist() {
    this.storage.write({
      keys: this.state.keys,
      activeId: this.state.activeId,
      states: this.state.states
    });
  }

  publicEntry(entry) {
    const state = this.state.states[entry.id] || {};
    let status = entry.id === this.state.activeId ? "ACTIVE" : "READY";
    if (state.invalid) status = "INVALID";
    else if (state.cooldownUntil > this.now()) status = "COOLDOWN";
    return {
      id: entry.id,
      label: entry.label,
      masked: maskApiKey(entry.key),
      status,
      cooldownUntil: state.cooldownUntil || null,
      source: entry.source
    };
  }

  list() {
    return this.allEntries()
      .filter(entry => !this.disabledIds.has(entry.id))
      .map(entry => this.publicEntry(entry));
  }

  redact(value) {
    let output = String(value);
    for (const entry of this.allEntries()) {
      if (entry.key) output = output.split(entry.key).join(maskApiKey(entry.key));
    }
    return output;
  }

  get activeId() {
    return this.state.activeId;
  }

  add(key) {
    const value = typeof key === "string" ? key.trim() : "";
    if (!value) throw new Error("API key cannot be empty.");
    if (this.allEntries().some(entry => entry.key === value)) {
      throw new Error("This API key is already configured.");
    }
    const entry = {
      id: `stored:${require("node:crypto").randomUUID()}`,
      key: value
    };
    this.state.keys.push(entry);
    this.state.states[entry.id] = {};
    if (!this.state.activeId) this.state.activeId = entry.id;
    this.persist();
    return this.publicEntry({ ...entry, label: `Key ${this.allEntries().length}` });
  }

  setActive(id) {
    const entry = this.find(id);
    if (!entry || this.disabledIds.has(id)) throw new Error("The selected API key is unavailable.");
    const state = this.state.states[id] || {};
    if (state.invalid) throw new Error("The selected API key is invalid.");
    this.state.activeId = id;
    this.persist();
    return this.publicEntry(entry);
  }

  remove(id, { confirmed = false } = {}) {
    const entry = this.find(id);
    if (!entry) throw new Error("The selected API key was not found.");
    if (id === this.state.activeId && !confirmed) {
      return { confirmationRequired: true, entry: this.publicEntry(entry) };
    }
    if (entry.source === "stored") {
      this.state.keys = this.state.keys.filter(item => item.id !== id);
      delete this.state.states[id];
    } else {
      this.disabledIds.add(id);
      delete this.state.states[id];
    }
    if (this.state.activeId === id) {
      const replacement = this.allEntries().find(item => !this.disabledIds.has(item.id));
      this.state.activeId = replacement?.id ?? null;
    }
    this.persist();
    return { confirmationRequired: false, removed: true, source: entry.source };
  }

  markRateLimited(id) {
    this.state.states[id] = {
      ...(this.state.states[id] || {}),
      invalid: false,
      cooldownUntil: this.now() + this.cooldownMs
    };
    this.persist();
  }

  markInvalid(id) {
    this.state.states[id] = {
      ...(this.state.states[id] || {}),
      invalid: true,
      cooldownUntil: null
    };
    this.persist();
  }

  markReady(id) {
    const state = this.state.states[id] || {};
    if (!state.invalid && !state.cooldownUntil) return;
    this.state.states[id] = {};
    this.persist();
  }

  availableEntries() {
    const usable = this.allEntries().filter(entry => {
      if (this.disabledIds.has(entry.id)) return false;
      const state = this.state.states[entry.id] || {};
      return !state.invalid && !(state.cooldownUntil > this.now());
    });
    usable.sort((left, right) => Number(right.id === this.state.activeId) - Number(left.id === this.state.activeId));
    return usable;
  }

  async runWithRotation(operation, { log = () => {} } = {}) {
    const candidates = this.availableEntries();
    if (!candidates.length) {
      const statuses = this.allEntries().map(entry => this.state.states[entry.id] || {});
      const onlyCooling = statuses.length > 0 && statuses.every(state =>
        state.invalid || state.cooldownUntil > this.now()
      ) && statuses.some(state => state.cooldownUntil > this.now());
      throw new ApiKeyPoolError(onlyCooling ? "all_rate_limited" : "no_valid_keys");
    }

    let lastRateLimited = false;
    for (const entry of candidates) {
      try {
        const result = await operation(entry.key, this.publicEntry(entry));
        this.markReady(entry.id);
        return result;
      } catch (error) {
        const status = getErrorStatus(error);
        if (status === 429) {
          this.markRateLimited(entry.id);
          lastRateLimited = true;
          log(`API key ${this.publicEntry(entry).label} is rate limited; trying another key.`);
          continue;
        }
        if ([400, 401, 403].includes(status)) {
          this.markInvalid(entry.id);
          log(`API key ${this.publicEntry(entry).label} is invalid or unauthorized; trying another key.`);
          continue;
        }
        throw error;
      }
    }
    throw new ApiKeyPoolError(lastRateLimited ? "all_rate_limited" : "no_valid_keys");
  }

  async testAll(testKey) {
    const results = [];
    for (const entry of this.allEntries().filter(item => !this.disabledIds.has(item.id))) {
      try {
        await testKey(entry.key);
        this.markReady(entry.id);
        results.push({ ...this.publicEntry(entry), status: entry.id === this.state.activeId ? "ACTIVE" : "READY" });
      } catch (error) {
        const status = getErrorStatus(error);
        if (status === 429) {
          this.markRateLimited(entry.id);
          results.push({ ...this.publicEntry(entry), status: "RATE LIMITED" });
        } else if ([400, 401, 403].includes(status)) {
          this.markInvalid(entry.id);
          results.push({ ...this.publicEntry(entry), status: "INVALID" });
        } else {
          results.push({ ...this.publicEntry(entry), status: "UNAVAILABLE" });
        }
      }
    }
    return results;
  }
}

module.exports = {
  ApiKeyPool,
  ApiKeyPoolError,
  DEFAULT_KEY_COOLDOWN_MS,
  createUserKeyStorage,
  maskApiKey
};
