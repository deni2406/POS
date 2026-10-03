"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { spawn, spawnSync } = require("node:child_process");
const { PassThrough } = require("node:stream");
const { test } = require("node:test");
const {
  createAssistantResponseBuffer,
  createInteractiveWorkspace,
  displayWidth,
  formatAssistantResponse,
  plainTextForClipboard,
  renderWorkspaceScreen,
  writeClipboardText,
  wrapText
} = require("../alva-cli");
const { ApiKeyPool } = require("../api-key-pool");
const { GEMINI_MODELS } = require("../gemini-config");

function removeAnsi(text) {
  return text.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

function makeClipboardChild({
  exitCode = 0,
  closeDelay = 0,
  writeError,
  processError,
  onInput
} = {}) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  const inputChunks = [];
  child.stdin.on("data", chunk => inputChunks.push(chunk));
  child.stdin.on("end", () => onInput?.(Buffer.concat(inputChunks)));
  child.stdin.on("finish", () => {
    setTimeout(() => child.emit("close", exitCode, null), closeDelay);
  });
  child.kill = () => {};
  if (writeError) {
    child.stdin.on("finish", () => child.stdin.emit("error", writeError));
  }
  if (processError) setImmediate(() => child.emit("error", processError));
  return child;
}

function makeClipboardVerifier(value, exitCode = 0) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.kill = () => {};
  setImmediate(() => {
    child.stdout.end(Buffer.from(value, "utf8").toString("base64"));
    child.stdout.once("end", () => child.emit("close", exitCode, null));
  });
  return child;
}

function windowsSystemExecutable(relativePath) {
  const root = process.env.SystemRoot || process.env.SYSTEMROOT || "C:\\Windows";
  return `${root.replace(/[\\/]+$/, "")}\\System32\\${relativePath}`;
}

function readWindowsClipboard() {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$value = Get-Clipboard -Raw",
    "if ($null -eq $value) { [Console]::Out.Write('EMPTY:'); exit 0 }",
    "[Console]::Out.Write('TEXT:' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$value)))"
  ].join("; ");
  const result = spawnSync(windowsSystemExecutable("WindowsPowerShell\\v1.0\\powershell.exe"), [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    script
  ], { encoding: "utf8", timeout: 5000 });
  if (result.error || result.status !== 0) return undefined;
  const output = result.stdout.trim();
  if (output === "EMPTY:") return null;
  if (!output.startsWith("TEXT:")) return undefined;
  return Buffer.from(output.slice("TEXT:".length), "base64").toString("utf8");
}

function writeWindowsClipboard(text) {
  return new Promise(resolve => {
    const child = spawnSync(windowsSystemExecutable("clip.exe"), [], {
      input: Buffer.from(text, "utf16le"),
      timeout: 3000
    });
    resolve(!child.error && child.status === 0);
  });
}

function clearWindowsClipboard() {
  const result = spawnSync(windowsSystemExecutable("WindowsPowerShell\\v1.0\\powershell.exe"), [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "$ErrorActionPreference = 'Stop'; Set-Clipboard -Value $null"
  ], { windowsHide: true, encoding: "utf8", timeout: 5000 });
  return !result.error && result.status === 0;
}

test("response formatter preserves paragraphs and formats headings and emphasis", () => {
  const formatted = formatAssistantResponse(
    "# Summary\nA **clear** answer with `inline code`.\n\nSecond paragraph.",
    44
  );
  const lines = formatted.split("\n");

  assert.ok(lines[0].includes("Summary"));
  assert.match(lines.join(" "), /A clear answer with inline\s+code\./);
  assert.ok(formatted.includes("\n\n"));
  assert.ok(!formatted.includes("###"));
  assert.ok(!formatted.includes("**"));
  assert.ok(!formatted.includes("`"));
});

test("response formatter aligns unordered, ordered, and nested list continuations", () => {
  const formatted = formatAssistantResponse(
    "- First item with enough words to wrap onto a continuation line.\n" +
    "- Second item\n" +
    "  - Nested item\n" +
    "1. Numbered item with enough words to wrap and stay aligned.",
    38
  );
  const lines = formatted.split("\n");

  assert.match(lines[0], /^  - First item/);
  assert.match(lines[1], /^    /);
  assert.match(formatted, /  - Second item/);
  assert.match(formatted, /    - Nested item/);
  assert.match(formatted, /  1\. Numbered item/);
  assert.ok(!formatted.includes("**"));
});

test("response formatter wraps long words and URLs without exceeding narrow width", () => {
  const url = `https://example.test/${"verylongsegment".repeat(8)}`;
  const formatted = formatAssistantResponse(
    `A long paragraph with an unbroken ${"x".repeat(120)} and URL ${url}.`,
    28
  );
  const visibleLines = removeAnsi(formatted).split("\n").filter(Boolean);

  assert.ok(visibleLines.length > 5);
  assert.ok(visibleLines.every(line => Array.from(line).length <= 24));
  assert.ok(formatted.includes("https://"));
});

test("response formatter accounts for wide Unicode characters when wrapping", () => {
  const formatted = formatAssistantResponse("日本語の長い回答を折り返して表示します。", 20);
  assert.ok(formatted.split("\n").every(line => displayWidth(removeAnsi(line)) <= 16));
});

test("response formatter distinguishes fenced code and keeps it wrapped", () => {
  const formatted = formatAssistantResponse(
    "Example:\n```js\nconst message = 'this is a very long line that must wrap in the terminal';\n```",
    36
  );
  const lines = formatted.split("\n");

  assert.ok(lines.some(line => line.includes("const message")));
  assert.ok(!formatted.includes("```"));
  assert.ok(lines.filter(line => line.startsWith("    ")).length > 1);
  assert.ok(lines.every(line => Array.from(removeAnsi(line)).length <= 32));
});

test("assistant response buffer commits 150 chunks once without duplicate content", () => {
  const chunks = [];
  const buffer = createAssistantResponseBuffer(chunk => chunks.push(chunk));
  const expectedChunks = Array.from({ length: 150 }, (_, index) => `chunk-${index}\n`);
  expectedChunks.forEach(chunk => buffer.append(chunk));

  const response = buffer.commit();
  assert.equal(chunks.length, 150);
  assert.equal(response, expectedChunks.join(""));
  assert.throws(() => buffer.append("late chunk"), /already complete/);
  assert.throws(() => buffer.commit(), /already complete/);
});

test("clipboard text is plain text and redacts API keys, secrets, and tokens", () => {
  const secret = "AIza0123456789012345678901234567890123";
  const values = ["api_key=api-secret", "secret=hidden", "token=token-value"];
  const text = plainTextForClipboard(`\x1b[31mResponse ${secret} ${values.join(" ")}\x1b[0m`);
  assert.doesNotMatch(text, /\x1b/);
  assert.doesNotMatch(text, new RegExp(secret));
  for (const value of values) assert.ok(!text.includes(value));
  assert.match(text, /\[REDACTED API KEY\]/);
});

test("Windows clip.exe is used before OSC 52 and receives plain response text", async () => {
  const response = "const name = '東京';\n\n**Done**";
  let terminalOutput = "";
  const copiedChunks = [];
  let clipboardValue = "";
  const result = await writeClipboardText(response, {
    platform: "win32",
    spawn(command, args, options) {
      assert.equal(options.windowsHide, true);
      if (command === windowsSystemExecutable("clip.exe")) {
        assert.deepEqual(args, []);
        assert.deepEqual(options.stdio, ["pipe", "ignore", "ignore"]);
        return makeClipboardChild({
          closeDelay: 5,
          onInput(data) {
            copiedChunks.push(data);
            clipboardValue = data.toString("utf16le");
          }
        });
      }
      assert.equal(command, windowsSystemExecutable("WindowsPowerShell\\v1.0\\powershell.exe"));
      assert.equal(options.stdio[1], "pipe");
      return makeClipboardVerifier(clipboardValue);
    }
  });

  assert.equal(result, true);
  assert.equal(Buffer.concat(copiedChunks).toString("utf16le"), response);
  assert.equal(terminalOutput, "");
  assert.doesNotMatch(terminalOutput, /[\x1b][\]P]/);
});

test("OSC 52 disabled never writes a payload or control sequence", async () => {
  let terminalOutput = "";
  const result = await writeClipboardText("secret clipboard response", {
    output: { write(value) { terminalOutput += value; } },
    terminal: true,
    platform: "linux",
    env: {}
  });

  assert.equal(result, false);
  assert.equal(terminalOutput, "");
});

test("OSC 52 is never emitted to the terminal, even when explicitly enabled", async () => {
  const response = "const name = '東京';\n\n**Done**";
  let terminalOutput = "";
  const result = await writeClipboardText(response, {
    output: { write(value) { terminalOutput += value; } },
    terminal: true,
    platform: "linux",
    env: { ALVA_OSC52: "1" }
  });

  assert.equal(result, false);
  assert.equal(terminalOutput, "");
  assert.ok(!terminalOutput.includes(Buffer.from(response, "utf8").toString("base64")));
});

test("Windows does not fall back to OSC 52 when clip.exe is missing", async () => {
  let terminalOutput = "";
  const result = await writeClipboardText("Only this response", {
    output: { write(value) { terminalOutput += value; } },
    terminal: true,
    platform: "win32",
    env: { ALVA_OSC52: "1" },
    spawn() {
      throw Object.assign(new Error("clip.exe not found"), { code: "ENOENT" });
    }
  });

  assert.equal(result, false);
  assert.equal(terminalOutput, "");
});

test("OSC 52 is never used without a clipboard provider", async () => {
  let terminalOutput = "";
  const result = await writeClipboardText("response", {
    output: { write(value) { terminalOutput += value; } },
    terminal: false,
    platform: "linux",
    env: { ALVA_OSC52: "1" }
  });

  assert.equal(result, false);
  assert.equal(terminalOutput, "");
});

test("clipboard adapter preserves JavaScript, JSON, multiline, Markdown, and Unicode", async () => {
  const responses = [
    "const value = { ok: true };",
    '{\n  "ok": true\n}',
    "line one\nline two",
    "# Heading\n\n- **item** with `code`",
    "Halo, 世界 👋"
  ];
  for (const response of responses) {
    let clipboardValue = "";
    const result = await writeClipboardText(response, {
      platform: "win32",
      spawn(command) {
        if (command === windowsSystemExecutable("clip.exe")) {
          return makeClipboardChild({
            onInput(data) {
              clipboardValue = data.toString("utf16le");
            }
          });
        }
        return makeClipboardVerifier(clipboardValue);
      }
    });
    assert.equal(result, true);
    assert.equal(clipboardValue, response);
  }
});

test("OSC 52 is not used if clip.exe exists but fails", async () => {
  let terminalOutput = "";
  const result = await writeClipboardText("response", {
    platform: "win32",
    spawn() {
      return makeClipboardChild({ exitCode: 1 });
    }
  });
  assert.equal(result, false);
  assert.equal(terminalOutput, "");
});

test("Windows clipboard reports success only after successful child close", async () => {
  const response = "Response\nwith Unicode ✓";
  let terminalOutput = "";
  let clipboardValue = "";
  const pending = writeClipboardText(response, {
    platform: "win32",
    spawn(command) {
      if (command === windowsSystemExecutable("clip.exe")) {
        return makeClipboardChild({
          closeDelay: 30,
          onInput() {
            clipboardValue = response;
          }
        });
      }
      return makeClipboardVerifier(clipboardValue);
    }
  });
  let settled = false;
  pending.then(() => { settled = true; });
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(settled, false);
  assert.equal(await pending, true);
  assert.equal(terminalOutput, "");

  assert.equal(await writeClipboardText("write failure", {
    platform: "win32",
    spawn(command) {
      return command === windowsSystemExecutable("clip.exe")
        ? makeClipboardChild({ writeError: new Error("stdin failed") })
        : makeClipboardVerifier("");
    }
  }), false);
  assert.equal(await writeClipboardText("process failure", {
    platform: "win32",
    spawn(command) {
      return command === windowsSystemExecutable("clip.exe")
        ? makeClipboardChild({ exitCode: 1 })
        : makeClipboardVerifier("");
    }
  }), false);
  assert.equal(await writeClipboardText("spawn failure", {
    platform: "win32",
    spawn() {
      throw new Error("spawn failed");
    }
  }), false);
  assert.equal(await writeClipboardText("child error", {
    platform: "win32",
    spawn(command) {
      return command === windowsSystemExecutable("clip.exe")
        ? makeClipboardChild({ processError: new Error("child error") })
        : makeClipboardVerifier("");
    }
  }), false);
  assert.equal(await writeClipboardText("invalid child", {
    platform: "win32",
    spawn() {
      return {};
    }
  }), false);

  assert.equal(await writeClipboardText("clipboard mismatch", {
  platform: "win32",
  spawn(command) {
    return command === windowsSystemExecutable("clip.exe")
      ? makeClipboardChild()
      : makeClipboardVerifier("old clipboard value");
  }
  }), false);

  assert.equal(await writeClipboardText("verification failure", {
  platform: "win32",
  spawn(command) {
    return command === windowsSystemExecutable("clip.exe")
      ? makeClipboardChild()
      : makeClipboardVerifier("", 1);
  }
  }), false);
});

test("Windows /copy updates clipboard through the real clip.exe process", {
  skip: process.platform !== "win32"
}, async t => {
  const previousClipboard = readWindowsClipboard();
  if (previousClipboard === undefined) {
    t.skip("Cannot safely snapshot the clipboard before the integration test.");
    return;
  }
  const response = "CLIP-TEST-123";
  const modulePath = require.resolve("../alva-cli");
  const childScript = `
    const { createInteractiveWorkspace } = require(${JSON.stringify(modulePath)});
    createInteractiveWorkspace({
      input: process.stdin,
      output: process.stdout,
      ai: { models: { async generateContent() { return { text: ${JSON.stringify(response)} }; } } }
    }).catch(error => {
      console.error(error);
      process.exitCode = 1;
    });
  `;
  let child;
  let transcript = "";
  let childError = "";
  const waitForOutput = (expression, description) => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${description}.`));
    }, 10000);
    const onData = chunk => {
      transcript += chunk.toString();
      if (expression.test(transcript)) {
        cleanup();
        resolve();
      }
    };
    const onError = chunk => { childError += chunk.toString(); };
    const onClose = code => {
      cleanup();
      reject(new Error(`ALVA child exited (${code}) before ${description}: ${childError}`));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout.off("data", onData);
      child.stderr.off("data", onError);
      child.off("close", onClose);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onError);
    child.once("close", onClose);
    onData(Buffer.alloc(0));
  });

  try {
    child = spawn(process.execPath, ["-e", childScript], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    child.stdin.write("request response\r\n");
    await waitForOutput(/CLIP-TEST-123/, "the assistant response");
    child.stdin.write("/copy 1\r\n");
    await waitForOutput(/✓ Response copied to clipboard\./, "the clipboard success message");
    await new Promise(resolve => setTimeout(resolve, 250));
    child.stdin.end("/exit\r\n");
    const exit = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("ALVA child did not exit.")), 10000);
      child.once("close", (code, signal) => {
        clearTimeout(timeout);
        resolve({ code, signal });
      });
    });
    assert.equal(exit.code, 0, childError);

    const actualClipboard = readWindowsClipboard();
    assert.equal(actualClipboard, response);
    assert.match(transcript, /✓ Response copied to clipboard\./);
    assert.doesNotMatch(transcript, /Copy unavailable in this terminal\./);
    t.diagnostic("Verified exact clipboard text using external PowerShell after the ALVA process exited.");
  } finally {
    if (child && child.exitCode === null) child.kill();
    if (previousClipboard === null) clearWindowsClipboard();
    else await writeWindowsClipboard(previousClipboard);
  }
});

test("wrapText preserves paragraphs and supports narrow columns", () => {
  const lines = wrapText("alpha beta\n\n" + "z".repeat(33), 10);
  assert.deepEqual(lines.slice(0, 3), ["alpha beta", "", "zzzzzzzzzz"]);
  assert.ok(lines.every(line => Array.from(line).length <= 10));
});

test("full-screen workspace reserves stable header, conversation, and composer rows", () => {
  for (const width of [120, 80, 28]) {
    const screen = renderWorkspaceScreen({
      width,
      height: 24,
      inputText: "draft input",
      entries: [
        { role: "user", text: "A question" },
        { role: "assistant", text: "A long answer ".repeat(24) }
      ]
    });
    const plainLines = removeAnsi(screen.text).split("\n");

    assert.equal(plainLines.length, 24);
    assert.ok(plainLines.every(line => displayWidth(line) <= width));
    assert.match(plainLines[0], /ALVA/);
    assert.match(plainLines[1], /by Deni Hasyim/);
    assert.ok(plainLines.some(line => line.includes("› draft input")));
    assert.ok(!plainLines.some(line => line.includes("/help")));
    assert.equal(screen.inputRow, plainLines.findIndex(line => line.includes("› draft input")) + 1);
  }
  const thinkingScreen = renderWorkspaceScreen({
    width: 80,
    height: 24,
    thinking: true
  });
  assert.ok(thinkingScreen.thinkingRow > 3);
  assert.ok(thinkingScreen.thinkingRow < thinkingScreen.inputRow - 1);
});

test("secret input is masked and the empty composer uses the requested placeholder", () => {
  const secret = "AIzaPRIVATE_TEST_KEY_987654321";
  const secretFrame = removeAnsi(renderWorkspaceScreen({
    width: 80,
    height: 16,
    inputText: secret,
    secretInput: true,
    placeholder: "Paste API key..."
  }).text);
  const emptyFrame = removeAnsi(renderWorkspaceScreen({ width: 80, height: 16 }).text);

  assert.ok(!secretFrame.includes(secret));
  assert.ok(secretFrame.includes("*".repeat(secret.length)));
  assert.ok(emptyFrame.includes(">>"));
  assert.doesNotMatch(emptyFrame, /Ketik sesuatu\.\.\./);
  assert.ok(!emptyFrame.includes("/help"));
});

test("conversation viewport scrolls independently while header and composer stay fixed", () => {
  const entries = Array.from({ length: 16 }, (_, index) => ({
    role: index % 2 ? "assistant" : "user",
    text: `Message ${index + 1}`
  }));
  const latest = removeAnsi(renderWorkspaceScreen({
    width: 60,
    height: 16,
    entries,
    inputText: "draft"
  }).text).split("\n");
  const earlier = removeAnsi(renderWorkspaceScreen({
    width: 60,
    height: 16,
    entries,
    inputText: "draft",
    scrollFromBottom: 4
  }).text).split("\n");

  assert.equal(latest.length, earlier.length);
  assert.equal(latest[0], earlier[0]);
  assert.equal(latest[1], earlier[1]);
  assert.equal(latest.at(-2), earlier.at(-2));
  assert.equal(latest.at(-1), earlier.at(-1));
  assert.notDeepEqual(latest.slice(3, -3), earlier.slice(3, -3));
});

test("workspace keeps provider context and supports all interactive commands", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let terminalOutput = "";
  output.on("data", chunk => { terminalOutput += chunk.toString(); });

  const requests = [];
  const ai = {
    models: {
      async generateContent(request) {
        requests.push({
          model: request.model,
          contents: structuredClone(request.contents)
        });
        return { text: `Reply ${requests.length}.\n\nA second paragraph.` };
      }
    }
  };

  const workspace = createInteractiveWorkspace({ ai, input, output });
  input.end([
    "first question",
    "second question",
    "/history",
    "/model gemini-3.7-flash",
    "third question",
    "/model",
    "/verbose",
    "fourth question",
    "/clear",
    "/history",
    "/help",
    "/exit",
    ""
  ].join("\n"));
  await workspace;

  assert.equal(requests.length, 4);
  assert.equal(requests[1].contents.length, 3);
  assert.deepEqual(requests[1].contents.map(content => content.role), ["user", "model", "user"]);
  assert.equal(requests[2].model, "gemini-3.7-flash");
  assert.match(terminalOutput, /ALVA\s+● ONLINE/);
  assert.match(terminalOutput, /by Deni Hasyim/);
  assert.doesNotMatch(terminalOutput, /AI WORKSPACE/);
  assert.match(terminalOutput, /ONLINE/);
  assert.match(terminalOutput, /YOU\n  > first question/);
  assert.match(terminalOutput, /ALVA\n  Reply 1\.\n\n  A second paragraph\./);
  assert.match(terminalOutput, /Model aktif: 3\.7-flash/);
  assert.match(terminalOutput, /Mencoba model 3\.7-flash/);
  assert.match(terminalOutput, /Percakapan dibersihkan/);
  assert.match(terminalOutput, /Belum ada riwayat percakapan/);
  assert.match(terminalOutput, /ALVA COMMANDS/);
  assert.match(terminalOutput, /\/setting\s+Manage API keys/);
  assert.doesNotMatch(terminalOutput, /Thinking\.\.\./);
  assert.match(terminalOutput, />>/);
  assert.doesNotMatch(terminalOutput, /\/help\s+\/clear\s+\/history\s+\/model/);
  assert.doesNotMatch(terminalOutput, /Gemini/);
  assert.doesNotMatch(terminalOutput, /gemini-/i);
  assert.match(terminalOutput, /YOU\n  > first question/);
});

test("automatic fallback locks its successful model and relocks after a transient failure", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const requests = [];
  const ai = { models: { async generateContent(request) {
    requests.push(request.model);
    if (request.model === GEMINI_MODELS[0] && requests.length <= 3) {
      throw Object.assign(new Error("temporarily unavailable"), { status: 500 });
    }
    if (request.model === GEMINI_MODELS[1] && requests.length > 5) {
      throw Object.assign(new Error("temporarily unavailable"), { status: 500 });
    }
    return { text: "OK" };
  } } };
  const workspace = createInteractiveWorkspace({ ai, input, output });
  input.end(["first", "second", "third", "fourth", "/exit", ""].join("\n"));
  await workspace;

  assert.deepEqual(requests.slice(0, 4), [
    GEMINI_MODELS[0], GEMINI_MODELS[0], GEMINI_MODELS[0],
    GEMINI_MODELS[1]
  ]);
  assert.equal(requests[4], GEMINI_MODELS[1]);
  assert.deepEqual(requests.slice(5, 8), Array(3).fill(GEMINI_MODELS[1]));
  assert.equal(requests[8], GEMINI_MODELS[0]);
  assert.equal(requests[9], GEMINI_MODELS[0]);
});

test("transient failure clears locked model and next request locks fallback success", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const requests = [];
  let call = 0;
  const ai = { models: { async generateContent(request) {
    requests.push(request.model);
    call += 1;
    if (call === 2) throw Object.assign(new Error("temporary lock failure"), { status: 500 });
    if (request.model === GEMINI_MODELS[0] && call > 2) {
      throw Object.assign(new Error("primary unavailable"), { status: 500 });
    }
    return { text: "OK" };
  } } };
  const workspace = createInteractiveWorkspace({ ai, input, output });
  input.end(["first", "second", "third", "/exit", ""].join("\n"));
  await workspace;

  assert.deepEqual(requests.slice(0, 8), [
    GEMINI_MODELS[0], GEMINI_MODELS[0], GEMINI_MODELS[0], GEMINI_MODELS[0], GEMINI_MODELS[0], GEMINI_MODELS[0], GEMINI_MODELS[0], GEMINI_MODELS[1]
  ]);
  assert.equal(requests[8], GEMINI_MODELS[1]);
});

test("all-model transient failure leaves lock cleared and propagates request error", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let transcript = "";
  output.on("data", chunk => { transcript += chunk.toString(); });
  const requests = [];
  let invocation = 0;
  const ai = { models: { async generateContent(request) {
    requests.push(request.model);
    invocation += 1;
    if (invocation === 1) {
      return { text: "Initial success" };
    }
    if (invocation <= 4 + (3 * GEMINI_MODELS.length)) {
      throw Object.assign(new Error("temporary outage"), { status: 500 });
    }
    return { text: "Recovered" };
  } } };
  const workspace = createInteractiveWorkspace({ ai, input, output });
  input.end(["first", "second", "third", "/exit", ""].join("\n"));
  await workspace;

  assert.match(transcript, /Permintaan ALVA gagal: semua model gagal setelah retry\./);
  assert.equal(requests[0], GEMINI_MODELS[0]);
  assert.equal(requests[1], GEMINI_MODELS[0]);
  assert.deepEqual(requests.slice(2, 5), Array(3).fill(GEMINI_MODELS[0]));
});

test("permanent failure keeps locked model for the following request", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const requests = [];
  let shouldFail = false;
  const ai = { models: { async generateContent(request) {
    requests.push(request.model);
    if (shouldFail) {
      shouldFail = false;
      throw Object.assign(new Error("permission denied"), { status: 403 });
    }
    return { text: "OK" };
  } } };
  const workspace = createInteractiveWorkspace({ ai, input, output });
  input.write("first\n");
  await new Promise(resolve => setTimeout(resolve, 20));
  shouldFail = true;
  input.write("second\n");
  await new Promise(resolve => setTimeout(resolve, 20));
  input.end("third\n/exit\n");
  await workspace;

  assert.deepEqual(requests, [GEMINI_MODELS[0], GEMINI_MODELS[0], GEMINI_MODELS[0]]);
});

test("selected model takes precedence over an active lock", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const requests = [];
  const ai = { models: { async generateContent(request) {
    requests.push(request.model);
    return { text: "OK" };
  } } };
  const workspace = createInteractiveWorkspace({ ai, input, output });
  input.end(["first", `/model ${GEMINI_MODELS[1]}`, "second", "/exit", ""].join("\n"));
  await workspace;

  assert.deepEqual(requests, [GEMINI_MODELS[0], GEMINI_MODELS[1]]);
});

test("five responses, long output, history, and clear share persistent session history", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let transcript = "";
  output.on("data", chunk => { transcript += chunk.toString(); });
  const longResponse = `LONG-START\n${"long response line\n".repeat(6000)}LONG-END`;
  const answers = ["SHORT-ONE", "MULTILINE\nSECOND-LINE", longResponse, "FOURTH-ANSWER", "FIFTH-ANSWER", "AFTER-CLEAR"];
  const requests = [];
  const ai = {
    models: {
      async generateContent(request) {
        requests.push(structuredClone(request.contents));
        return { text: answers[requests.length - 1] };
      }
    }
  };
  const workspace = createInteractiveWorkspace({ ai, input, output });
  input.end([
    "question one",
    "question two",
    "question three",
    "question four",
    "question five",
    "/history",
    "/clear",
    "/history",
    "after clear",
    "/exit",
    ""
  ].join("\n"));
  await workspace;

  assert.equal(requests.length, 6);
  assert.equal(requests[4].length, 9);
  assert.equal(requests[4][5].parts[0].text, answers[2]);
  assert.match(transcript, /SHORT-ONE/);
  assert.match(transcript, /MULTILINE/);
  assert.match(transcript, /SECOND-LINE/);
  assert.match(transcript, /LONG-START/);
  assert.match(transcript, /LONG-END/);
  assert.match(transcript, /FOURTH-ANSWER/);
  assert.match(transcript, /FIFTH-ANSWER/);
  assert.match(transcript, /Belum ada riwayat percakapan/);
  assert.equal(requests[5].length, 1);
  assert.equal(requests[5][0].parts[0].text, "after clear");
});

test("help and settings stay in-workspace; API-key management never echoes a secret", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const storage = {
    value: { keys: [], activeId: null, states: {} },
    read() { return structuredClone(this.value); },
    write(value) { this.value = structuredClone(value); }
  };
  const pool = new ApiKeyPool({ env: {}, storage });
  const secret = "AIzaPRIVATE_TEST_KEY_987654321";
  let keyWasUsedForChat = false;
  let keyWasTested = false;
  let systemInstruction;
  let transcript = "";
  output.on("data", chunk => { transcript += chunk.toString(); });

  const workspace = createInteractiveWorkspace({
    apiKeyPool: pool,
    input,
    output,
    createAI(key) {
      assert.equal(key, secret);
      return {
        models: {
          async generateContent(request) {
            if (request.contents === "Reply with OK.") {
              keyWasTested = true;
              return { text: "OK" };
            }
            keyWasUsedForChat = true;
            systemInstruction = request.config.systemInstruction;
            return { text: "I am ALVA, your assistant in this workspace." };
          }
        }
      };
    }
  });
  input.end([
    "/help",
    "/back",
    "/setting",
    "1",
    secret,
    "4",
    "1",
    "3",
    "2",
    "1",
    "N",
    "5",
    "Siapa kamu?",
    "/history",
    "/exit",
    ""
  ].join("\n"));
  await workspace;

  assert.match(transcript, /ALVA COMMANDS/);
  assert.match(transcript, /ALVA SETTINGS/);
  assert.match(transcript, /API KEY MANAGEMENT/);
  assert.match(transcript, /API key added successfully/);
  assert.match(transcript, /Tested 1 API key/);
  assert.match(transcript, /Removal cancelled/);
  assert.match(transcript, /AIza\*+\d{3}/);
  assert.ok(!transcript.includes(secret));
  assert.ok(keyWasTested);
  assert.ok(keyWasUsedForChat);
  assert.match(systemInstruction, /Identify yourself as ALVA/);
  assert.match(transcript, /I am ALVA/);
});

test("settings routes every option through the shared input loop and preserves chat context", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const secrets = [
    "first-environment-key-123456",
    "second-environment-key-234567",
    "AIzaPRIVATE_ADDED_KEY_987654321"
  ];
  const storage = {
    value: { keys: [], activeId: null, states: {} },
    read() { return structuredClone(this.value); },
    write(value) { this.value = structuredClone(value); }
  };
  const pool = new ApiKeyPool({
    env: { GEMINI_API_KEY: secrets[0], GEMINI_API_KEY_2: secrets[1] },
    storage
  });
  let transcript = "";
  const testCalls = [];
  const chatRequests = [];
  output.on("data", chunk => { transcript += chunk.toString(); });

  const workspace = createInteractiveWorkspace({
    apiKeyPool: pool,
    input,
    output,
    createAI(key) {
      return {
        models: {
          async generateContent(request) {
            if (request.contents === "Reply with OK.") {
              testCalls.push(key);
              return { text: "OK" };
            }
            chatRequests.push(structuredClone(request.contents));
            return { text: "ALVA reply" };
          }
        }
      };
    }
  });
  input.end([
    "first chat message",
    "/setting",
    "9",
    "1",
    secrets[2],
    "2",
    "3",
    "Y",
    "4",
    "2",
    "3",
    "2",
    "2",
    "Y",
    "5",
    "second chat message",
    "/exit",
    ""
  ].join("\n"));
  await workspace;

  assert.match(transcript, /Invalid option/);
  assert.match(transcript, /API key added successfully/);
  assert.match(transcript, /REMOVE API KEY/);
  assert.match(transcript, /SET ACTIVE KEY/);
  assert.match(transcript, /TEST API KEYS/);
  assert.match(transcript, /Tested 2 API keys/);
  assert.match(transcript, /Active API key set to/);
  assert.match(transcript, /API key removed:/);
  assert.match(transcript, />>/);
  assert.ok(secrets.every(secret => !transcript.includes(secret)));
  assert.equal(pool.list().length, 1);
  assert.equal(pool.activeId, "env:GEMINI_API_KEY");
  assert.equal(storage.value.activeId, "env:GEMINI_API_KEY");
  assert.deepEqual(testCalls.sort(), [secrets[0], secrets[1]].sort());
  assert.equal(chatRequests.length, 2);
  assert.deepEqual(chatRequests[1].map(item => item.role), ["user", "model", "user"]);
});

test("/copy selects an assistant response and sends only redacted ANSI-free text", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const clipboardWrites = [];
  const secret = "AIza0123456789012345678901234567890123";
  const ai = {
    models: {
      async generateContent() {
        return { text: `\x1b[32mCopied answer\x1b[0m\x1b]0;ALVA status\x07\x1b[2K ${secret}` };
      }
    }
  };
  const workspace = createInteractiveWorkspace({
    ai,
    input,
    output,
    clipboardWriter(text) {
      clipboardWrites.push(text);
      return true;
    }
  });
  input.end(["copy this", "/copy", "/exit", ""].join("\n"));
  await workspace;

  assert.equal(clipboardWrites.length, 1);
  assert.equal(clipboardWrites[0], "Copied answer [REDACTED API KEY]");
  assert.doesNotMatch(clipboardWrites[0], /\x1b/);
  assert.doesNotMatch(clipboardWrites[0], new RegExp(secret));
});

test("/copy numbering follows actual assistant responses and is unchanged by /history", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const responses = ["Response A", "Response B", "Response C", "Response D"];
  const copied = [];
  const requests = [];
  const ai = {
    models: {
      async generateContent(request) {
        requests.push(structuredClone(request.contents));
        return { text: responses[requests.length - 1] ?? "Response E" };
      }
    }
  };
  const workspace = createInteractiveWorkspace({
    ai,
    input,
    output,
    clipboardWriter(text) {
      copied.push(text);
      return true;
    }
  });
  input.end([
    "question 1",
    "question 2",
    "question 3",
    "question 4",
    "/history",
    "/copy 1",
    "/copy 2",
    "/copy 3",
    "/copy 4",
    "/copy",
    "question 5",
    "/exit",
    ""
  ].join("\n"));
  await workspace;

  assert.deepEqual(copied, [...responses, "Response D"]);
  assert.equal(requests.length, 5);
  assert.deepEqual(requests[4].map(entry => entry.role), [
    "user", "model", "user", "model", "user",
    "model", "user", "model", "user"
  ]);
  assert.deepEqual(
    requests[4].filter(entry => entry.role === "model").map(entry => entry.parts[0].text),
    responses
  );
  assert.ok(requests[4].every(entry =>
    !JSON.stringify(entry).includes("Response copied to clipboard") &&
    !JSON.stringify(entry).includes("ALVA\n")
  ));
});

test("/copy failure shows only the safe unavailable message", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let transcript = "";
  output.on("data", chunk => { transcript += chunk.toString(); });
  let requests = 0;
  const ai = {
    models: {
      async generateContent() {
        requests += 1;
        return { text: `FALLBACK-COPY-RESPONSE-${requests}` };
      }
    }
  };
  const workspace = createInteractiveWorkspace({
    ai,
    input,
    output,
    clipboardWriter() {
      throw new Error("clipboard denied");
    }
  });
  input.end(["first", "/copy", "second", "/exit", ""].join("\n"));
  await workspace;

  assert.equal(requests, 2);
  assert.equal((transcript.match(/Copy unavailable in this terminal\./g) || []).length, 1);
  assert.equal((transcript.match(/✓ Response copied to clipboard\./g) || []).length, 0);
  assert.equal((transcript.match(/FALLBACK-COPY-RESPONSE-1/g) || []).length, 1);
  assert.equal((transcript.match(/FALLBACK-COPY-RESPONSE-2/g) || []).length, 1);
});

test("/copy does not confirm success when Windows clipboard verification mismatches", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let transcript = "";
  output.on("data", chunk => { transcript += chunk.toString(); });
  const workspace = createInteractiveWorkspace({
    input,
    output,
    ai: { models: { async generateContent() { return { text: "Selected response" }; } } },
    clipboardWriter(text) {
      return writeClipboardText(text, {
        platform: "win32",
        spawn(command) {
          return command === windowsSystemExecutable("clip.exe")
            ? makeClipboardChild()
            : makeClipboardVerifier("previous clipboard contents");
        }
      });
    }
  });
  input.end(["question", "/copy", "/exit", ""].join("\n"));
  await workspace;

  assert.match(transcript, /Copy unavailable in this terminal\./);
  assert.doesNotMatch(transcript, /✓ Response copied to clipboard\./);
  assert.doesNotMatch(transcript, /previous clipboard contents|Selected response.*clipboard/);
});

test("/copy confirmation stays out of history and repeated copies do not expose response or secrets", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let transcript = "";
  output.on("data", chunk => { transcript += chunk.toString(); });
  const clipboardWrites = [];
  const secret = "AIza0123456789012345678901234567890123";
  const requests = [];
  const ai = {
    models: {
      async generateContent(request) {
        requests.push(structuredClone(request.contents));
        return { text: `Safe response ${secret} api_key=api-secret secret=hidden token=token-value` };
      }
    }
  };
  const workspace = createInteractiveWorkspace({
    ai,
    input,
    output,
    clipboardWriter(text) {
      clipboardWrites.push(text);
      return true;
    }
  });
  input.end([
    "first",
    "/copy 1",
    "/copy 1",
    "/copy 1",
    "/history",
    "second",
    "/exit",
    ""
  ].join("\n"));
  await workspace;

  assert.equal(clipboardWrites.length, 3);
  assert.ok(clipboardWrites.every(text => text.startsWith("Safe response ")));
  for (const value of [secret, "api-secret", "hidden", "token-value"]) {
    assert.ok(clipboardWrites.every(text => !text.includes(value)));
    assert.ok(!transcript.includes(value));
  }
  assert.ok(!transcript.includes(secret));
  assert.equal((transcript.match(/✓ Response copied to clipboard\./g) || []).length, 3);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1].map(item => item.role), ["user", "model", "user"]);
  assert.ok(requests[1].every(item => !JSON.stringify(item).includes("Response copied to clipboard")));
  assert.ok(requests[1].every(item => !JSON.stringify(item).includes(secret)));
});

test("captured stdout uses append-only plain text for multiple responses and copy", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let transcript = "";
  output.on("data", chunk => { transcript += chunk.toString(); });
  const responses = [
    "Response one: JavaScript",
    '{\n  "response": "two"\n}',
    "# Response three\n\n東京 ✓\n\n```js\n  const answer = 42;\n```"
  ];
  const requests = [];
  const copied = [];
  const ai = {
    models: {
      async generateContent(request) {
        requests.push(structuredClone(request.contents));
        return { text: responses[requests.length - 1] };
      }
    }
  };
  const workspace = createInteractiveWorkspace({
    ai,
    input,
    output,
    clipboardWriter(text) {
      copied.push(text);
      return true;
    }
  });
  input.end(["first", "second", "third", "/copy 2", "/exit", ""].join("\n"));
  await workspace;

  assert.equal(requests.length, 3);
  assert.equal((transcript.match(/ALVA\s+● ONLINE/g) || []).length, 1);
  assert.equal(transcript.split("Response one: JavaScript").length - 1, 1);
  assert.equal(transcript.split('"two"').length - 1, 1);
  assert.equal(transcript.split("Response three").length - 1, 1);
  assert.equal(transcript.split("東京 ✓").length - 1, 1);
  assert.equal(transcript.split("const answer = 42;").length - 1, 1);
  assert.equal(copied.length, 1);
  assert.equal(copied[0], responses[1]);
  assert.equal((transcript.match(/✓ Response copied to clipboard\./g) || []).length, 1);
  assert.doesNotMatch(transcript, /\x1b/);
  assert.doesNotMatch(transcript, /Thinking\.\.\./);
  assert.ok(!transcript.includes(Buffer.from(responses[1], "utf8").toString("base64")));
});

test("captured stdout history and clear preserve logical conversation boundaries", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let transcript = "";
  output.on("data", chunk => { transcript += chunk.toString(); });
  const requests = [];
  const ai = {
    models: {
      async generateContent(request) {
        requests.push(structuredClone(request.contents));
        return { text: `History response ${requests.length}` };
      }
    }
  };
  const workspace = createInteractiveWorkspace({ ai, input, output });
  input.end(["first", "/history", "second", "/clear", "third", "/exit", ""].join("\n"));
  await workspace;

  assert.equal(requests.length, 3);
  assert.deepEqual(requests[1].map(item => item.role), ["user", "model", "user"]);
  assert.equal(requests[1].filter(item => item.role === "model" && item.parts[0].text === "History response 1").length, 1);
  assert.deepEqual(requests[2].map(item => item.role), ["user"]);
  assert.match(transcript, /Percakapan dibersihkan/);
  assert.doesNotMatch(transcript, /\x1b/);
});

test("interactive TTY resize does not repaint logical conversation messages", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  input.isTTY = true;
  output.isTTY = true;
  input.columns = output.columns = 80;
  input.rows = output.rows = 24;
  input.setRawMode = mode => { input.rawMode = mode; };
  let terminalOutput = "";
  output.on("data", chunk => { terminalOutput += chunk.toString(); });
  const requests = [];
  const copied = [];
  const ai = {
    models: {
      async generateContent(request) {
        requests.push(structuredClone(request.contents));
        return { text: `Interactive response ${requests.length}` };
      }
    }
  };
  const workspace = createInteractiveWorkspace({
    ai,
    input,
    output,
    clipboardWriter(text) {
      copied.push(text);
      return true;
    }
  });
  const enter = async line => {
    input.write(`${line}\r`);
    await new Promise(resolve => setTimeout(resolve, 80));
  };

  await new Promise(resolve => setTimeout(resolve, 0));
  await enter("first");
  for (const [columns, rows] of [[72, 22], [65, 20], [80, 24]]) {
    input.columns = output.columns = columns;
    input.rows = output.rows = rows;
    output.emit("resize");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  await enter("/history");
  await enter("/copy 1");
  await enter("second");
  await enter("/exit");
  await workspace;

  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1].map(item => item.role), ["user", "model", "user"]);
  assert.equal(requests[1].filter(item => item.role === "model" && item.parts[0].text === "Interactive response 1").length, 1);
  assert.equal(copied.length, 1);
  assert.equal(copied[0], "Interactive response 1");
  assert.equal((terminalOutput.match(/\x1b\[2J\x1b\[H/g) || []).length, 0);
  assert.equal((terminalOutput.match(/Interactive response 1/g) || []).length, 2);
  assert.equal((terminalOutput.match(/Interactive response 2/g) || []).length, 1);
  assert.doesNotMatch(terminalOutput, /\x1b\[\?1049[hl]/);
  assert.match(terminalOutput, /✓ Response copied to clipboard\./);
});

test("TTY redraw preserves append-only responses and wraps multiline Markdown", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  input.isTTY = true;
  output.isTTY = true;
  input.columns = output.columns = 48;
  input.rows = output.rows = 24;
  input.setRawMode = mode => { input.rawMode = mode; };
  let terminalOutput = "";
  output.on("data", chunk => { terminalOutput += chunk.toString(); });
  const answers = [
    "Response A stays visible.",
    "# Response B\n\n- Bullet item with enough words to wrap across the available terminal width.\n\n```js\nconst wrappedCode = 'a very long code line that should wrap rather than disappear';\n```"
  ];
  let requestCount = 0;
  const workspace = createInteractiveWorkspace({
    input,
    output,
    ai: {
      models: {
        async generateContent() {
          return { text: answers[requestCount++] };
        }
      }
    }
  });
  const enter = async line => {
    input.write(`${line}\r`);
    await new Promise(resolve => setTimeout(resolve, 80));
  };

  await new Promise(resolve => setTimeout(resolve, 0));
  await enter("first question");
  await enter("second question");
  await enter("/exit");
  await workspace;

  const plainOutput = removeAnsi(terminalOutput);
  const firstResponseIndex = plainOutput.indexOf("Response A stays visible.");
  const secondResponseIndex = plainOutput.indexOf("Response B");
  assert.ok(firstResponseIndex !== -1);
  assert.ok(secondResponseIndex > firstResponseIndex);
  assert.ok(plainOutput.includes("Bullet item"));
  assert.ok(plainOutput.includes("wrappedCode"));
  assert.ok(plainOutput.includes(">>"));
  assert.doesNotMatch(terminalOutput, /\x1B\[[0-?]*J/);
  assert.doesNotMatch(terminalOutput, /\x1B\[\?1049[hl]/);
});

test("CI or dumb terminal disables full-screen controls even when streams claim TTY", async () => {
  for (const env of [{ CI: "true" }, { TERM: "dumb" }]) {
    const input = new PassThrough();
    const output = new PassThrough();
    input.isTTY = true;
    output.isTTY = true;
    input.setRawMode = () => {};
    let transcript = "";
    output.on("data", chunk => { transcript += chunk.toString(); });
    const ai = { models: { async generateContent() { return { text: "Plain terminal response" }; } } };
    const workspace = createInteractiveWorkspace({ ai, input, output, env });
    input.end(["question", "/exit", ""].join("\n"));
    await workspace;

    assert.match(transcript, /Plain terminal response/);
    assert.doesNotMatch(transcript, /\x1b/);
    assert.equal((transcript.match(/ALVA\s+● ONLINE/g) || []).length, 1);
  }
});

test("TTY stdout with piped stdin stays plain and append-only", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  input.isTTY = false;
  output.isTTY = true;
  let transcript = "";
  output.on("data", chunk => { transcript += chunk.toString(); });
  const ai = { models: { async generateContent() { return { text: "Piped-input response" }; } } };
  const workspace = createInteractiveWorkspace({ ai, input, output });
  input.end(["question", "/exit", ""].join("\n"));
  await workspace;

  assert.match(transcript, /Piped-input response/);
  assert.doesNotMatch(transcript, /\x1b/);
  assert.equal((transcript.match(/ALVA\s+● ONLINE/g) || []).length, 1);
});

test("TTY resize leaves append-only conversation output intact", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  input.isTTY = true;
  input.columns = output.columns = 80;
  input.rows = output.rows = 24;
  input.setRawMode = mode => { input.rawMode = mode; };
  output.isTTY = true;
  let terminalOutput = "";
  output.on("data", chunk => { terminalOutput += chunk.toString(); });
  const ai = {
    models: {
      async generateContent() {
        return { text: "TTY-RESPONSE-PERSISTS" };
      }
    }
  };
  const workspace = createInteractiveWorkspace({ ai, input, output });
  const wait = () => new Promise(resolve => setTimeout(resolve, 80));

  await new Promise(resolve => setTimeout(resolve, 0));
  input.write("question\r");
  await wait();
  assert.equal(removeAnsi(terminalOutput).split("● ONLINE").length - 1, 1);

  output.columns = 45;
  output.rows = 18;
  output.emit("resize");
  input.write("/history\r");
  await wait();
  assert.match(removeAnsi(terminalOutput), /TTY-RESPONSE-PERSISTS/);
  assert.equal(removeAnsi(terminalOutput).split("● ONLINE").length - 1, 1);
  assert.doesNotMatch(terminalOutput, /\x1b\[\?1049[hl]|\x1b\[2J\x1b\[H/);

  input.end();
  await workspace;
});

test("terminal width is read dynamically for each response and Ctrl+C closes cleanly", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  input.isTTY = true;
  input.columns = 50;
  input.rows = 24;
  output.isTTY = true;
  output.columns = 50;
  output.rows = 24;
  let terminalOutput = "";
  output.on("data", chunk => { terminalOutput += chunk.toString(); });

  const ai = {
    models: {
      async generateContent() {
        return { text: "A long response " + "wrapped content ".repeat(20) };
      }
    }
  };
  const workspace = createInteractiveWorkspace({ ai, input, output });
  const enter = async value => {
    input.write(`${value}\n`);
    await new Promise(resolve => setTimeout(resolve, 10));
  };

  await new Promise(resolve => setTimeout(resolve, 0));
  await enter("first");
  output.columns = 28;
  output.emit("resize");
  await enter("second");
  input.write("\x03");
  input.end();
  await workspace;

  const plainOutput = removeAnsi(terminalOutput);
  assert.match(plainOutput, /ALVA\n  A long response/);
  assert.match(plainOutput, /wrapped content/);
  assert.doesNotMatch(plainOutput, /Gemini/);
  const narrowResponse = plainOutput.split("second\r\n")[1].split("\n\n>>")[0];
  const responseLines = narrowResponse.split("\n").filter(line => line.startsWith("  "));
  assert.ok(responseLines.length > 5);
  assert.ok(responseLines.every(line => Array.from(line).length <= 24));
  assert.match(plainOutput, /Workspace closed\./);
});

test("interactive TTY stays append-only across chat and settings transitions", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  input.isTTY = true;
  input.columns = 80;
  input.rows = 24;
  input.setRawMode = mode => { input.rawMode = mode; };
  output.isTTY = true;
  output.columns = 80;
  output.rows = 24;
  let terminalOutput = "";
  output.on("data", chunk => { terminalOutput += chunk.toString(); });
  const ai = {
    models: {
      async generateContent() {
        return { text: "# Summary\nFirst paragraph.\n\nSecond paragraph.\n\n- One\n- Two" };
      }
    }
  };

  const workspace = createInteractiveWorkspace({ ai, input, output });
  const type = text => input.write(text);
  const enter = async text => {
    type(text);
    input.write("\r");
    await new Promise(resolve => setTimeout(resolve, 60));
  };

  await new Promise(resolve => setTimeout(resolve, 0));
  assert.doesNotMatch(terminalOutput, /\x1b\[\?1049h/);
  type("draft");
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.match(removeAnsi(terminalOutput), /draft/);
  input.write("\x15");
  output.columns = 36;
  output.rows = 18;
  output.emit("resize");
  assert.match(terminalOutput, />>/);
  await enter("Explain this");
  assert.match(terminalOutput, /First paragraph/);
  assert.match(terminalOutput, /Second paragraph/);
  await enter("/help");
  await enter("/history");
  await enter("/model");
  await enter("/verbose");
  await enter("/clear");
  await enter("/history");
  await enter("/exit");
  await workspace;

  assert.equal(input.rawMode, false);
  assert.doesNotMatch(terminalOutput, /\x1b\[\?25h|\x1b\[\?1049l/);
  assert.equal((removeAnsi(terminalOutput).match(/Summary/g) || []).length, 2);
  assert.match(terminalOutput, /by Deni Hasyim/);
  assert.match(terminalOutput, /ALVA COMMANDS/);
  assert.match(terminalOutput, /Percakapan dibersihkan/);
  assert.match(terminalOutput, /Belum ada riwayat percakapan/);
  assert.doesNotMatch(terminalOutput, /Gemini|gemini-/i);
});

test("interactive Ctrl+C exits without entering an alternate screen", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  input.isTTY = true;
  input.columns = 80;
  input.rows = 24;
  input.setRawMode = mode => { input.rawMode = mode; };
  output.isTTY = true;
  output.columns = 80;
  output.rows = 24;
  let terminalOutput = "";
  output.on("data", chunk => { terminalOutput += chunk.toString(); });

  const workspace = createInteractiveWorkspace({ input, output });
  await new Promise(resolve => setTimeout(resolve, 0));
  input.write("\x03");
  await workspace;

  assert.equal(input.rawMode, false);
  assert.doesNotMatch(terminalOutput, /\x1b\[\?1049[hl]|\x1b\[\?25[hl]/);
  assert.match(terminalOutput, /Workspace closed\./);
  assert.match(terminalOutput, /\x1b\[\?2004l/);
});

test("bracketed large multiline paste remains one exact chat message and slash text is not a command", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  input.isTTY = true;
  input.columns = output.columns = 80;
  input.rows = output.rows = 24;
  input.setRawMode = mode => { input.rawMode = mode; };
  output.isTTY = true;
  let terminalOutput = "";
  output.on("data", chunk => { terminalOutput += chunk.toString(); });
  const requests = [];
  const ai = {
    models: {
      async generateContent(request) {
        requests.push(structuredClone(request.contents));
        return { text: "Received as one message." };
      }
    }
  };
  const workspace = createInteractiveWorkspace({ ai, input, output });
  const waitForInput = () => new Promise(resolve => setTimeout(resolve, 70));
  const typeAndSubmit = async text => {
    input.write(text);
    input.write("\r");
    await waitForInput();
  };
  const pasted = [
    "Project instructions:",
    "",
    "Markdown **bold**, `code`, quotes: 'single' and \"double\".",
    "const example = { hello: 'world' };",
    "Windows path: C:\\Users\\POLLARD\\Documents\\project",
    "/setting",
    "/help",
    "/exit",
    "End of document."
  ].join("\n") + "\n" + "large content line\n".repeat(12000);

  await new Promise(resolve => setTimeout(resolve, 0));
  assert.match(terminalOutput, /\x1b\[\?2004h/);
  input.write("\x1b[20");
  input.write("0~");
  input.write(pasted.slice(0, 23));
  output.columns = 42;
  output.rows = 18;
  output.emit("resize");
  input.write(pasted.slice(23));
  input.write("\x1b[20");
  input.write("1~");
  input.write("\r");
  await waitForInput();
  const requestDeadline = Date.now() + 5000;
  while (requests.length < 1 && Date.now() < requestDeadline) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }

  assert.equal(requests.length, 1);
  assert.equal(requests[0].length, 1);
  assert.equal(requests[0][0].parts[0].text, pasted);

  await typeAndSubmit("/help");
  assert.equal(requests.length, 1);
  assert.match(terminalOutput, /ALVA COMMANDS/);
  await typeAndSubmit("/back");
  await typeAndSubmit("/setting");
  assert.match(terminalOutput, /ALVA SETTINGS/);
  await typeAndSubmit("5");
  assert.match(terminalOutput, />>/);
  await typeAndSubmit("normal single-line message");
  assert.equal(requests.length, 2);
  assert.equal(requests[1].at(-1).parts[0].text, "normal single-line message");

  input.write("\x03");
  await workspace;
  assert.match(terminalOutput, /\x1b\[\?2004l/);
  assert.equal(input.rawMode, false);
});

test("unmarked multiline paste fallback preserves newlines and slash text", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  input.isTTY = true;
  input.columns = output.columns = 80;
  input.rows = output.rows = 24;
  input.setRawMode = mode => { input.rawMode = mode; };
  output.isTTY = true;
  const requests = [];
  const ai = {
    models: {
      async generateContent(request) {
        requests.push(structuredClone(request.contents));
        return { text: "OK" };
      }
    }
  };
  const workspace = createInteractiveWorkspace({ ai, input, output });
  const pasted = "first line\r\n/setting\r\n/help\r\n/exit\r\nconst x = 1;";

  await new Promise(resolve => setTimeout(resolve, 0));
  input.write(pasted);
  await new Promise(resolve => setTimeout(resolve, 300));
  input.write("\r");
  await new Promise(resolve => setTimeout(resolve, 70));

  assert.equal(requests.length, 1);
  assert.equal(requests[0].length, 1);
  assert.equal(requests[0][0].parts[0].text, "first line\n/setting\n/help\n/exit\nconst x = 1;");
  input.write("\x03");
  await workspace;
});

test("incomplete bracketed paste is retained and Ctrl+C still exits", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  input.isTTY = true;
  input.columns = output.columns = 80;
  input.rows = output.rows = 24;
  input.setRawMode = mode => { input.rawMode = mode; };
  output.isTTY = true;
  let terminalOutput = "";
  output.on("data", chunk => { terminalOutput += chunk.toString(); });
  const workspace = createInteractiveWorkspace({ input, output });

  await new Promise(resolve => setTimeout(resolve, 0));
  input.write("\x1b[200~/exit\n/setting\n");
  input.write("\x03");
  await workspace;

  assert.doesNotMatch(terminalOutput, /ALVA SETTINGS/);
  assert.match(terminalOutput, /\x1b\[\?2004l/);
  assert.equal(input.rawMode, false);
});

test("interactive API key entry masks typed characters and persists only through the pool", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  input.isTTY = true;
  input.columns = output.columns = 80;
  input.rows = output.rows = 24;
  input.setRawMode = mode => { input.rawMode = mode; };
  output.isTTY = true;
  let terminalOutput = "";
  output.on("data", chunk => { terminalOutput += chunk.toString(); });
  const storage = {
    value: { keys: [], activeId: null, states: {} },
    read() { return structuredClone(this.value); },
    write(value) { this.value = structuredClone(value); }
  };
  const pool = new ApiKeyPool({ env: {}, storage });
  const secret = "AIzaPRIVATE_TEST_KEY_987654321";
  const workspace = createInteractiveWorkspace({ apiKeyPool: pool, input, output });
  const type = text => input.write(text);
  const enter = async text => {
    type(text);
    input.write("\r");
    await new Promise(resolve => setTimeout(resolve, 60));
  };

  await new Promise(resolve => setTimeout(resolve, 0));
  await enter("/setting");
  await enter("1");
  type(secret);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(!terminalOutput.includes(secret));
  assert.ok(terminalOutput.includes("*".repeat(secret.length)));
  await enter("");
  assert.ok(!terminalOutput.includes(secret));
  assert.equal(pool.list().length, 1);
  assert.ok(!JSON.stringify(pool.list()).includes(secret));
  input.write("\x03");
  await workspace;
  assert.equal(input.rawMode, false);
  assert.doesNotMatch(terminalOutput, /\x1b\[\?1049l/);
});
