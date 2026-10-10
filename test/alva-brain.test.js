"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { PassThrough } = require("node:stream");
const { test } = require("node:test");
const { DatabaseSync } = require("node:sqlite");
const {
  ALVA_BRAIN_SYSTEM_INSTRUCTION,
  classifyRequest,
  createProjectInspector,
  prepareBrainRequest,
  redactSecrets
} = require("../alva-brain");
const { createInteractiveWorkspace } = require("../alva-cli");

async function withProject(callback) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "alva-readonly-brain-"));
  try {
    return await callback(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function createSQLiteFixture(file) {
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE); CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER REFERENCES customers(id), total REAL); INSERT INTO customers VALUES (1, 'Ari', 'ari@example.test'); INSERT INTO orders VALUES (7, 1, 12.5);");
  db.close();
}

test("SQLite inspector detects supported extensions and verifies schema, constraints, indexes, and sample rows read-only", async () => {
  await withProject(root => {
    const file = path.join(root, "shop.sqlite3");
    createSQLiteFixture(file);
    const before = fs.readFileSync(file);
    const inspector = createProjectInspector({ root });
    const evidence = inspector.inspectSQLite("shop.sqlite3");
    assert.match(evidence, /Status: VERIFIED/);
    assert.match(evidence, /TABLE customers/);
    assert.match(evidence, /id INTEGER PRIMARY KEY/);
    assert.match(evidence, /customer_id -> customers\.id/);
    assert.match(evidence, /UNIQUE \(email\)/);
    assert.match(evidence, /Row count: 1/);
    assert.match(evidence, /Ari/);
    assert.deepEqual(fs.readFileSync(file), before);
    assert.throws(() => inspector.inspectSQLite("missing.txt"), /extension/);
  });
});

test("SQLite evidence enters Brain Context for named database and table questions with VERIFIED status", async () => {
  await withProject(root => {
    createSQLiteFixture(path.join(root, "shop.db"));
    const context = prepareBrainRequest("Inspect table customers in shop.db", { inspector: createProjectInspector({ root }) }).projectContext;
    assert.match(context, /SQLITE INSPECTION shop\.db/);
    assert.match(context, /Status: VERIFIED/);
    assert.match(context, /TABLE customers/);
    assert.match(context, /Ari/);
  });
});

test("SQLite reader rejects paths outside root and symlinks, and handles corrupt or inaccessible databases", async t => {
  await withProject(root => {
    const inspector = createProjectInspector({ root });
    const outside = path.join(path.dirname(root), `${path.basename(root)}-outside.db`);
    createSQLiteFixture(outside);
    try {
      assert.throws(() => inspector.inspectSQLite(outside), /inside the project root/);
    } finally { fs.rmSync(outside, { force: true }); }
    const corrupt = path.join(root, "corrupt.sqlite");
    fs.writeFileSync(corrupt, "not a sqlite database");
    assert.throws(() => inspector.inspectSQLite("corrupt.sqlite"));
    assert.throws(() => inspector.inspectSQLite("unavailable.db"), /ENOENT/);
    const directory = path.join(root, "denied.db");
    fs.mkdirSync(directory);
    assert.throws(() => inspector.inspectSQLite("denied.db"), /regular file/);
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "alva-sqlite-outside-"));
    try {
      createSQLiteFixture(path.join(outsideDir, "linked.sqlite"));
      try { fs.symlinkSync(path.join(outsideDir, "linked.sqlite"), path.join(root, "linked.sqlite"), "file"); }
      catch { t.skip("This Windows runtime cannot create a file symlink."); return; }
      assert.throws(() => inspector.inspectSQLite("linked.sqlite"), /symlink/);
    } finally { fs.rmSync(outsideDir, { recursive: true, force: true }); }
  });
});

test("SQLite sample rows and evidence have strict bounds and project context remains truncated to budget", async () => {
  await withProject(root => {
    const file = path.join(root, "large.sqlite");
    const db = new DatabaseSync(file);
    db.exec("CREATE TABLE entries (id INTEGER PRIMARY KEY, payload TEXT)");
    const insert = db.prepare("INSERT INTO entries VALUES (?, ?)");
    for (let index = 0; index < 20; index++) insert.run(index, "z".repeat(5000));
    db.close();
    const inspector = createProjectInspector({ root });
    const evidence = inspector.inspectSQLite("large.sqlite");
    assert.ok(evidence.length <= 9000);
    assert.match(evidence, /sample truncated/);
    assert.ok(evidence.length < 3000);
    const context = prepareBrainRequest(`Inspect large.sqlite. ${"Keep this request. ".repeat(1000)}`, { inspector }).userText;
    assert.ok(context.length <= 24000);
  });
});

test("SQLite full table reads batch and paginate; search and aggregation stay read-only and byte-stable", async () => {
  await withProject(root => {
    const file = path.join(root, "batch.db");
    const db = new DatabaseSync(file);
    db.exec("CREATE TABLE records(id INTEGER PRIMARY KEY, label TEXT); CREATE INDEX records_label ON records(label)");
    const insert = db.prepare("INSERT INTO records VALUES (?, ?)");
    for (let i = 0; i < 37; i++) insert.run(i, i % 3 ? `ordinary-${i}` : `target-${i}`);
    db.close();
    const before = fs.readFileSync(file);
    const inspector = createProjectInspector({ root });
    const first = inspector.readSQLiteTable("batch.db", "records", { limit: 10 });
    const second = inspector.readSQLiteTable("batch.db", "records", { limit: 10, offset: 10 });
    assert.equal(first.rows.length, 10);
    assert.equal(first.hasMore, true);
    assert.equal(second.rows[0].id, 10);
    assert.equal(inspector.readSQLiteTable("batch.db", "records", { limit: 100 }).rows.length, 37);
    const found = inspector.searchSQLite("batch.db", "target", { limit: 4 });
    assert.equal(found.rows.length, 4);
    assert.equal(found.rows[0].table, "records");
    assert.equal(found.hasMore, true);
    const aggregate = inspector.querySQLite("batch.db", "SELECT COUNT(*) AS n, SUM(id) AS total FROM records");
    assert.deepEqual(aggregate.rows, [{ n: 37, total: 666 }]);
    for (const sql of ["INSERT INTO records VALUES (99,'x')", "UPDATE records SET label='x'", "DELETE FROM records", "CREATE TABLE x(y)", "DROP TABLE records", "ALTER TABLE records ADD z", "VACUUM", "ATTACH DATABASE 'x' AS y", "DETACH y", "PRAGMA journal_mode=WAL", "SELECT 1; DELETE FROM records"]) {
      assert.throws(() => inspector.querySQLite("batch.db", sql));
    }
    assert.deepEqual(fs.readFileSync(file), before);
  });
});

test("SQLite query and PM2 inspection report bounded verified or unknown evidence safely", async () => {
  await withProject(root => {
    createSQLiteFixture(path.join(root, "shop.db"));
    const inspector = createProjectInspector({ root });
    const evidence = prepareBrainRequest("Inspect customers in shop.db and PM2 process list", { inspector }).projectContext;
    assert.match(evidence, /PM2 INSPECTION/);
    assert.match(evidence, /CROSS-FILE EVIDENCE MAP\nStatus: (?:VERIFIED|UNKNOWN)/);
    const pm2 = inspector.inspectPM2({ timeout: 1000 });
    assert.match(pm2, /Status: (?:VERIFIED|UNKNOWN)/);
    assert.match(redactSecrets("API_KEY=abc123 password: test123 Bearer abc.def"), /\[REDACTED\]/);
  });
});

test("PM2 jlist reader bounds logs, redacts secrets, validates output, and times out safely", async () => {
  await withProject(root => {
    const tools = path.join(root, "fake-bin");
    const script = path.join(tools, "node_modules", "pm2", "bin", "pm2");
    fs.mkdirSync(tools, { recursive: true });
    fs.writeFileSync(path.join(tools, "pm2.cmd"), "test fixture marker");
    const logs = path.join(root, "runtime.log");
    const source = path.join(root, "server.js");
    fs.mkdirSync(path.dirname(script), { recursive: true });
    fs.writeFileSync(source, "module.exports = true;\n");
    fs.writeFileSync(logs, `start token=secret-value\n${"x".repeat(12000)}\n`);
    const env = process.env;
    const previousPath = env.PATH;
    const inspector = createProjectInspector({ root });
    try {
      env.PATH = tools;
      const processInfo = { name: "fixture", pm_id: 3, pid: 44, monit: { cpu: 2, memory: 4096 }, pm2_env: { status: "online", pm_uptime: 100, restart_time: 1, pm_exec_path: source, pm_cwd: root, exec_interpreter: "node", instances: 1, version: "1.2", pm_out_log_path: logs, pm_err_log_path: logs, API_KEY: "secret-value" } };
      fs.writeFileSync(script, `process.stdout.write(JSON.stringify(${JSON.stringify([processInfo])}));\n`);
      const report = inspector.inspectPM2({ logBytes: 1024 });
      assert.match(report, /Status: VERIFIED/);
      assert.match(report, /Process fixture id=3 pid=44/);
      assert.match(report, /PROJECT SOURCE server\.js/);
      assert.match(report, /tail 1024 bytes/);
      assert.doesNotMatch(report, /secret-value/);
      assert.ok(report.length < 12000);
      fs.writeFileSync(script, "process.stdout.write('{malformed');\n");
      assert.match(inspector.inspectPM2(), /Status: UNKNOWN/);
      fs.writeFileSync(script, "while (true) {}\n");
      assert.match(inspector.inspectPM2({ timeout: 20 }), /Status: UNKNOWN/);
    } finally { env.PATH = previousPath; }
  });
});

test("PM2 reader bypasses Windows .cmd EINVAL and invokes the inert JS entry point with only jlist", async () => {
  await withProject(root => {
    const prefix = path.join(root, "npm prefix with spaces");
    const script = path.join(prefix, "node_modules", "pm2", "bin", "pm2");
    fs.mkdirSync(path.dirname(script), { recursive: true });
    // Reproduce Node on Windows rejecting a .cmd file passed directly to
    // execFileSync, then prove inspectPM2 invokes the package JS entry point.
    fs.writeFileSync(path.join(prefix, "pm2.cmd"), "@echo off\r\nexit /b 99\r\n");
    if (process.platform === "win32") {
      assert.throws(() => execFileSync(path.join(prefix, "pm2.cmd"), ["jlist"], { stdio: "ignore" }), error => error.code === "EINVAL");
    }
    const previousPath = process.env.PATH;
    const previousPm2Home = process.env.PM2_HOME;
    process.env.PM2_HOME = path.join(root, "pm2-home");
    fs.writeFileSync(script, "if (process.argv.slice(2).join(',') !== 'jlist' || process.cwd() !== process.env.EXPECTED_CWD || process.env.PM2_HOME !== process.env.EXPECTED_PM2_HOME) process.exit(98); process.stdout.write('[]');\n");
    const previousExpectedCwd = process.env.EXPECTED_CWD;
    const previousExpectedPm2Home = process.env.EXPECTED_PM2_HOME;
    process.env.EXPECTED_CWD = root;
    process.env.EXPECTED_PM2_HOME = process.env.PM2_HOME;
    try {
      process.env.PATH = prefix;
      const report = createProjectInspector({ root }).inspectPM2();
      assert.match(report, /Status: VERIFIED/);
      assert.match(report, /Access: read-only \(jlist\)/);
      assert.match(report, /Process count: 0/);
    } finally {
      process.env.PATH = previousPath;
      if (previousPm2Home === undefined) delete process.env.PM2_HOME; else process.env.PM2_HOME = previousPm2Home;
      if (previousExpectedCwd === undefined) delete process.env.EXPECTED_CWD; else process.env.EXPECTED_CWD = previousExpectedCwd;
      if (previousExpectedPm2Home === undefined) delete process.env.EXPECTED_PM2_HOME; else process.env.EXPECTED_PM2_HOME = previousExpectedPm2Home;
    }
  });
});

test("intent classifier distinguishes analysis, diagnosis, planning, review, handoff, execution, and chat", () => {
  assert.equal(classifyRequest("Jelaskan struktur project ini"), "ANALYZE");
  assert.equal(classifyRequest("Kenapa API key rotation gagal?"), "DIAGNOSE");
  assert.equal(classifyRequest("Bagaimana sebaiknya memperbaikinya?"), "PLAN");
  assert.equal(classifyRequest("Review hasil Copilot"), "REVIEW");
  assert.equal(classifyRequest("Siapkan instruksi implementasi untuk Copilot"), "COPILOT_HANDOFF");
  assert.equal(classifyRequest("Perbaiki api-key-pool.js"), "EXECUTION_REQUEST");
  assert.equal(classifyRequest("Hapus file X"), "EXECUTION_REQUEST");
  assert.equal(classifyRequest("Halo ALVA"), "GENERAL_CHAT");
});

test("project inspector lists, reads, writes, edits, validates JavaScript, and runs shell commands", async () => {
  await withProject(root => {
    fs.mkdirSync(path.join(root, "src"));
    fs.mkdirSync(path.join(root, "node_modules"));
    fs.writeFileSync(path.join(root, "src", "waitinglist.js"), "const status = 'ready';\n");
    fs.writeFileSync(path.join(root, "package.json"), "{\"name\":\"sample\"}\n");
    fs.writeFileSync(path.join(root, "node_modules", "ignored.js"), "ignored\n");
    const inspector = createProjectInspector({ root });

    assert.deepEqual(inspector.searchFiles("waitinglist"), ["src/waitinglist.js"]);
    assert.equal(inspector.readFile("src/waitinglist.js"), "const status = 'ready';\n");
    assert.equal(inspector.searchContent("ready")[0].file, "src/waitinglist.js");
    assert.equal(inspector.stat("src/waitinglist.js").type, "file");
    assert.ok(inspector.listFiles().includes("src\\waitinglist.js") || inspector.listFiles().includes("src/waitinglist.js"));
    assert.ok(!inspector.listFiles().some(file => file.includes("node_modules")));
    assert.equal(inspector.writeFile("src/new.js", "const answer = 42;\n").syntax.valid, true);
    assert.equal(inspector.editFile("src/new.js", "42", "43").replacements, 1);
    assert.equal(inspector.readFile("src/new.js"), "const answer = 43;\n");
    assert.throws(() => inspector.writeFile("src/new.js", "const = ;\n"), /syntax validation failed/);
    assert.equal(inspector.readFile("src/new.js"), "const answer = 43;\n");
    assert.equal(inspector.runShell("node --version").exitCode, 0);
  });
});

test("recursive index discovers actual nested directories and files with filesystem metadata", async () => {
  await withProject(root => {
    fs.mkdirSync(path.join(root, "www", "src"), { recursive: true });
    fs.mkdirSync(path.join(root, "android", "app"), { recursive: true });
    fs.mkdirSync(path.join(root, "test"), { recursive: true });
    fs.mkdirSync(path.join(root, "node_modules", "generated"), { recursive: true });
    fs.writeFileSync(path.join(root, "www", "src", "waitinglist.js"), "export const waiting = true;\n");
    fs.writeFileSync(path.join(root, "android", "app", "build.gradle"), "plugins {}\n");
    fs.writeFileSync(path.join(root, "node_modules", "generated", "ignored.js"), "generated");
    const inspector = createProjectInspector({ root });
    const index = inspector.getIndex();
    const byPath = new Map(index.entries.map(entry => [entry.path, entry]));

    assert.equal(byPath.get("www").type, "directory");
    assert.equal(byPath.get("android").type, "directory");
    assert.equal(byPath.get("test").type, "directory");
    assert.equal(byPath.get("www/src").type, "directory");
    assert.equal(byPath.get("www/src/waitinglist.js").type, "file");
    assert.equal(byPath.get("www/src/waitinglist.js").extension, ".js");
    assert.equal(byPath.get("www/src/waitinglist.js").size, Buffer.byteLength("export const waiting = true;\n"));
    assert.ok(byPath.get("www/src/waitinglist.js").modified);
    assert.equal(byPath.get("node_modules").excludedContents, true);
    assert.equal(byPath.has("node_modules/generated/ignored.js"), false);
    assert.deepEqual(inspector.searchFiles("waiting list"), ["www/src/waitinglist.js"]);
    assert.match(inspector.buildContext("Jelaskan struktur project", "ANALYZE"), /Root directories actually present:.*android.*node_modules.*test.*www/);
  });
});

test("filesystem index refresh discovers changes made after startup", async () => {
  await withProject(root => {
    fs.mkdirSync(path.join(root, "src"));
    const inspector = createProjectInspector({ root });
    assert.equal(inspector.getIndex().entries.some(entry => entry.path === "src/new.js"), false);
    fs.writeFileSync(path.join(root, "src", "new.js"), "const fresh = true;\n");

    const refreshed = inspector.refresh();
    assert.equal(refreshed.entries.some(entry => entry.path === "src/new.js"), true);
    assert.deepEqual(inspector.searchFiles("new.js"), ["src/new.js"]);
    assert.match(inspector.buildContext("Inspect new.js", "ANALYZE"), /FILE src\/new\.js/);
  });
});

test("prepared request includes verified cross-file definitions, exports, callers, dependencies, and tests", async () => {
  await withProject(root => {
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.mkdirSync(path.join(root, "test"), { recursive: true });
    fs.writeFileSync(path.join(root, "src", "service.js"), "const helper = require('./helper');\nfunction processOrder() { return helper.run(); }\nmodule.exports = { processOrder };\n");
    fs.writeFileSync(path.join(root, "src", "helper.js"), "exports.run = function run() { return true; };\n");
    fs.writeFileSync(path.join(root, "src", "consumer.js"), "const { processOrder } = require('./service');\nprocessOrder();\n");
    fs.writeFileSync(path.join(root, "test", "service.test.js"), "const { processOrder } = require('../src/service');\nprocessOrder();\n");
    const prepared = prepareBrainRequest("Explain processOrder in src/service.js and its callers and tests", {
      inspector: createProjectInspector({ root })
    });

    assert.match(prepared.projectContext, /CROSS-FILE EVIDENCE MAP[\s\S]*Status: VERIFIED/);
    assert.match(prepared.projectContext, /src\/service\.js:\d+ \[definition processOrder\]/);
    assert.match(prepared.projectContext, /src\/service\.js:\d+ \[depends on -> src\/helper\.js\]/);
    assert.match(prepared.projectContext, /src\/consumer\.js:\d+ \[imports -> src\/service\.js\]/);
    assert.match(prepared.projectContext, /test\/service\.test\.js:\d+ \[imports -> src\/service\.js\]/);
    assert.match(prepared.projectContext, /FILE src\/helper\.js:/);
    assert.match(prepared.projectContext, /FILE test\/service\.test\.js:/);
  });
});

test("smart context budget preserves the user request and verified evidence before file contents", async () => {
  await withProject(root => {
    const filler = `const unrelatedPayload = '${"x".repeat(3900)}';\n`;
    fs.writeFileSync(path.join(root, "worker.js"), `${filler.repeat(4)}function runJob() { return true; }\nmodule.exports = { runJob };\n`);
    fs.mkdirSync(path.join(root, "test"), { recursive: true });
    fs.writeFileSync(path.join(root, "test", "worker.test.js"), `const { runJob } = require('../worker');\nrunJob();\n${filler.repeat(3)}`);
    for (let index = 0; index < 8; index += 1) {
      fs.writeFileSync(path.join(root, `caller-${index}.js`), `const { runJob } = require('./worker');\nrunJob();\n${filler.repeat(4)}`);
    }
    const request = `Inspect runJob in worker.js and its callers. ${"Keep this user request intact. ".repeat(20)}`;
    const prepared = prepareBrainRequest(request, { inspector: createProjectInspector({ root }) });

    assert.ok(prepared.userText.length <= 24000);
    assert.ok(prepared.userText.startsWith(request));
    assert.match(prepared.userText, /CROSS-FILE EVIDENCE MAP[\s\S]*Status: VERIFIED/);
    const contents = prepared.userText.split("INSPECTED FILE CONTENTS:\n")[1];
    assert.match(contents, /\[inspection output truncated\]/);
    assert.match(prepared.userText, /Project structure[\s\S]*Scan access issues:/);
  });
});

test("interactive Brain request forwards cross-file evidence to generateWithFallback", async () => {
  await withProject(async root => {
    fs.mkdirSync(path.join(root, "test"), { recursive: true });
    fs.writeFileSync(path.join(root, "worker.js"), "function runJob() { return true; }\nmodule.exports = { runJob };\n");
    fs.writeFileSync(path.join(root, "test", "worker.test.js"), "const { runJob } = require('../worker');\nrunJob();\n");
    const input = new PassThrough();
    const output = new PassThrough();
    let modelRequest;
    const workspace = createInteractiveWorkspace({
      ai: { models: { async generateContent(request) { modelRequest = request; return { text: "Evidence received." }; } } },
      input,
      output,
      projectInspector: createProjectInspector({ root })
    });
    input.end(["Inspect runJob in worker.js", "/exit", ""].join("\n"));
    await workspace;
    assert.ok(modelRequest);
    const sentText = modelRequest.contents.at(-1).parts[0].text;
    assert.match(sentText, /CROSS-FILE EVIDENCE MAP[\s\S]*Status: VERIFIED/);
    assert.match(sentText, /test\/worker\.test\.js:\d+ \[imports -> worker\.js\]/);
  });
});

test("missing cross-file symbols and files stay UNKNOWN and never become VERIFIED", async () => {
  await withProject(root => {
    fs.writeFileSync(path.join(root, "existing.js"), "function unrelated() {}\n");
    const inspector = createProjectInspector({ root });
    const missingSymbol = inspector.buildContext("Inspect definitelyMissingSymbol", "ANALYZE");
    const missingFile = inspector.buildContext("Inspect absent-module.js", "ANALYZE");
    assert.match(missingSymbol, /CROSS-FILE EVIDENCE MAP\nStatus: UNKNOWN/);
    assert.match(missingFile, /CROSS-FILE EVIDENCE MAP\nStatus: UNKNOWN/);
    assert.doesNotMatch(missingSymbol, /Status: VERIFIED/);
    assert.doesNotMatch(missingFile, /Status: VERIFIED/);
  });
});

test("cross-file resolver verifies only definitions that bind the requested symbol", async () => {
  await withProject(root => {
    fs.writeFileSync(path.join(root, "unrelated-export.js"), "module.exports = { other: true };\nexports.other = true;\n");
    const inspector = createProjectInspector({ root });

    const falsePositive = inspector.buildContext("Inspect generateWithFallback", "ANALYZE");
    assert.doesNotMatch(falsePositive, /Status: VERIFIED/);
    assert.doesNotMatch(falsePositive, /\[definition generateWithFallback\]/);

    fs.writeFileSync(path.join(root, "valid-definition.js"), "function generateWithFallback() { return true; }\n");
    const validDefinition = inspector.buildContext("Inspect generateWithFallback", "ANALYZE");
    assert.match(validDefinition, /Status: VERIFIED/);
    assert.match(validDefinition, /valid-definition\.js:\d+ \[definition generateWithFallback\]/);
  });
});

test("/project scan forces a fresh filesystem index inside the existing ALVA workspace", async () => {
  await withProject(async root => {
    const inspector = createProjectInspector({ root });
    fs.writeFileSync(path.join(root, "after-startup.txt"), "fresh");
    const input = new PassThrough();
    const output = new PassThrough();
    let transcript = "";
    output.on("data", chunk => { transcript += chunk.toString(); });
    const workspace = createInteractiveWorkspace({ input, output, projectInspector: inspector });
    input.end(["/project scan", "/exit", ""].join("\n"));
    await workspace;

    assert.match(transcript, /Project filesystem index refreshed/);
    assert.match(transcript, /1 files discovered/);
    assert.ok(inspector.getIndex().entries.some(entry => entry.path === "after-startup.txt"));
  });
});

test("missing directory checks are based on a completed scan and distinguish unavailable scans", async () => {
  await withProject(root => {
    const inspector = createProjectInspector({ root });
    const context = inspector.buildContext("Apakah folder missing ada di C:\\POS?", "ANALYZE");
    assert.match(context, /No matching directory was found by the completed recursive scan/);
    assert.throws(() => createProjectInspector({ root: path.join(root, "absent") }), /ENOENT/);
  });
});

test("project inspector constrains reads to root and rejects destructive git commands", async () => {
  await withProject(root => {
    const outside = path.join(path.dirname(root), `${path.basename(root)}-outside.js`);
    fs.writeFileSync(outside, "outside");
    try {
      const inspector = createProjectInspector({ root });
      assert.throws(() => inspector.readFile(outside), /inside the project root/);
      assert.throws(() => inspector.runGitReadOnly(["reset", "--hard"]), /blocked/);
      assert.throws(() => inspector.runGitReadOnly(["clean", "-fd"]), /blocked/);
      assert.throws(() => inspector.runGitReadOnly(["checkout", "--", "."]), /blocked/);
      assert.throws(() => inspector.runGitReadOnly(["restore", "."]), /blocked/);
      assert.throws(() => inspector.runGitReadOnly(["diff", "--output=outside.txt"]), /allow-list/);
    } finally {
      fs.rmSync(outside, { force: true });
    }
  });
});

test("recursive scanner records symlinks without traversing outside the project", async t => {
  await withProject(root => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "alva-outside-"));
    const outsideSecret = path.join(outside, "outside.js");
    fs.writeFileSync(outsideSecret, "must not be indexed");
    const linkPath = path.join(root, "external-link");
    try {
      fs.symlinkSync(outside, linkPath, "junction");
    } catch {
      fs.rmSync(outside, { recursive: true, force: true });
      t.skip("This Windows runtime cannot create a directory symlink/junction.");
      return;
    }
    try {
      const inspector = createProjectInspector({ root });
      const index = inspector.getIndex();
      assert.equal(index.entries.find(entry => entry.path === "external-link").type, "symlink");
      assert.equal(index.entries.some(entry => entry.path.includes("outside.js")), false);
      assert.throws(() => inspector.readFile(path.join(linkPath, "outside.js")), /symlink|inside the project root/i);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

test("review inspection reads current Git status and untracked source without changing it", async () => {
  await withProject(root => {
    execFileSync("git", ["init", root], { stdio: "ignore", windowsHide: true });
    const source = path.join(root, "changed.js");
    fs.writeFileSync(source, "const changed = true;\n");
    const inspector = createProjectInspector({ root });
    const before = fs.readFileSync(source, "utf8");
    const review = inspector.reviewContext();

    assert.match(review, /GIT STATUS --short/);
    assert.match(review, /changed\.js/);
    assert.match(review, /const changed = true/);
    assert.equal(fs.readFileSync(source, "utf8"), before);
  });
});

test("execution requests invoke editFile and return a validated final response", async () => {
  await withProject(async root => {
    const source = path.join(root, "waitinglist.js");
    const original = "const original = true;\n";
    fs.writeFileSync(source, original);
    const input = new PassThrough();
    const output = new PassThrough();
    const modelRequests = [];
    let transcript = "";
    output.on("data", chunk => { transcript += chunk.toString(); });
    const ai = {
      models: {
        async generateContent(request) {
          modelRequests.push(request);
          if (modelRequests.length === 1) {
            return {
              functionCalls: [{
                name: "editFile",
                args: { path: "waitinglist.js", oldText: "true", newText: "false" }
              }]
            };
          }
          return { text: "Fixed waitinglist.js and validated its syntax." };
        }
      }
    };
    const workspace = createInteractiveWorkspace({
      ai,
      input,
      output,
      projectInspector: createProjectInspector({ root })
    });
    input.end(["Perbaiki waitinglist.js", "/exit", ""].join("\n"));
    await workspace;

    assert.equal(fs.readFileSync(source, "utf8"), "const original = false;\n");
    assert.equal(modelRequests.length, 2);
    assert.match(modelRequests[0].config.systemInstruction, /full software engineering agent/);
    assert.match(modelRequests[0].config.systemInstruction, /EXECUTION REQUEST/);
    assert.match(modelRequests[0].contents.at(-1).parts[0].text, /INTENT: EXECUTION_REQUEST/);
    assert.match(modelRequests[0].contents.at(-1).parts[0].text, /FILE waitinglist\.js:/);
    assert.equal(modelRequests[1].contents.at(-1).parts[0].functionResponse.response.ok, true);
    assert.match(transcript, /Fixed waitinglist\.js and validated its syntax/);
  });
});

test("read-only analysis is grounded in file contents and leaves project files unchanged", async () => {
  await withProject(async root => {
    const source = path.join(root, "waitinglist.js");
    const original = "function renderWaitinglist() { return 'unchanged'; }\n";
    fs.writeFileSync(source, original);
    const input = new PassThrough();
    const output = new PassThrough();
    const requests = [];
    const ai = {
      models: {
        async generateContent(request) {
          requests.push(request);
          return { text: "Inspected the supplied source evidence." };
        }
      }
    };
    const workspace = createInteractiveWorkspace({
      ai,
      input,
      output,
      projectInspector: createProjectInspector({ root })
    });
    input.end(["Inspect waitinglist.js", "/exit", ""].join("\n"));
    await workspace;

    assert.equal(requests.length, 1);
    assert.match(requests[0].contents.at(-1).parts[0].text, /function renderWaitinglist/);
    assert.match(requests[0].config.systemInstruction, /software engineering agent/);
    assert.equal(fs.readFileSync(source, "utf8"), original);
  });
});

test("brain inspection masks credentials before they enter model context", () => {
  withProject(root => {
    const secret = "AIza0123456789012345678901234567890123";
    fs.writeFileSync(path.join(root, "config.js"), `const key = "${secret}";\n`);
    const context = prepareBrainRequest("Inspect config.js", {
      inspector: createProjectInspector({ root })
    });

    assert.doesNotMatch(context.userText, new RegExp(secret));
    assert.match(context.userText, /\[REDACTED API KEY\]/);
    assert.doesNotMatch(redactSecrets("password=top-secret-value"), /top-secret-value/);
  });
});
