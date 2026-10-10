#!/usr/bin/env node
"use strict";

const readline = require("node:readline");
const { PassThrough, Writable } = require("node:stream");
const { spawn: spawnChild } = require("node:child_process");
const { GoogleGenAI } = require("@google/genai");
const { GEMINI_MODELS, REQUEST_TIMEOUT_MS } = require("./gemini-config");
const { generateWithFallback, GeminiRequestError } = require("./gemini-fallback");
const { ApiKeyPool, ApiKeyPoolError } = require("./api-key-pool");
const {
  ALVA_BRAIN_SYSTEM_INSTRUCTION,
  createProjectInspector,
  prepareBrainRequest,
  redactSecrets
} = require("./alva-brain");

const SPINNER_FRAMES = ["|", "/", "-", "\\"];
const ANSI = {
  reset: "\x1b[0m",
  accent: "\x1b[96m",
  label: "\x1b[36m",
  muted: "\x1b[90m",
  content: "\x1b[37m",
  status: "\x1b[32m",
  heading: "\x1b[1;97m",
  code: "\x1b[90m",
  emphasis: "\x1b[1m"
};
const ALVA_TOOLS = [{
  functionDeclarations: [
    {
      name: "readFile",
      description: "Read a UTF-8 file from the project workspace.",
      parametersJsonSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path relative to C:\\POS." },
          maxChars: { type: "integer", description: "Maximum characters to return." }
        },
        required: ["path"]
      }
    },
    {
      name: "writeFile",
      description: "Create or replace a UTF-8 project file. JavaScript files are syntax-checked before replacement.",
      parametersJsonSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path relative to C:\\POS." },
          content: { type: "string", description: "Complete new file content." }
        },
        required: ["path", "content"]
      }
    },
    {
      name: "editFile",
      description: "Apply an exact text replacement to an existing project file. Fails if the target is ambiguous unless replaceAll is true.",
      parametersJsonSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path relative to C:\\POS." },
          oldText: { type: "string", description: "Exact text to replace." },
          newText: { type: "string", description: "Replacement text." },
          replaceAll: { type: "boolean", description: "Replace every matching occurrence." }
        },
        required: ["path", "oldText", "newText"]
      }
    },
    {
      name: "runShell",
      description: "Run a shell command in C:\\POS and return its exit code and captured output.",
      parametersJsonSchema: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command to run." },
          timeoutMs: { type: "integer", description: "Optional timeout, up to two minutes." }
        },
        required: ["command"]
      }
    }
  ]
}];
const MAX_TOOL_ROUNDS = 12;
const ALVA_CLI_SYSTEM_SUFFIX = [
  "RUNTIME EXECUTION STANDARD:",
  "Act as a Senior AI Software Engineer. Be concise and direct; do not assume root causes or file contents.",
  "Before editing, inspect relevant source with readFile and use runShell when necessary to verify the failure or call path.",
  "Make only surgical changes at verified fault locations. After every JavaScript edit, run `node --check` through runShell for each affected final file and fix any failure before reporting success.",
  "For errors, give the verified cause in one or two sentences, then apply the direct fix.",
  "Trace the verified root cause through data flow, state, async ordering, and callers; do not patch surface symptoms. Defend against null data, connection loss, COM3 serial timeouts, failed I/O, and async race conditions. Make the smallest non-destructive fix that prevents regressions.",
  "Treat this as a live cashier POS: transaction integrity, consistent data, responsive operation, hardware reliability, and security take priority. Never infer code or database values without tool-backed evidence.",
  "POS RULES: Never modify pos.db without first creating and verifying a backup. POS serial hardware uses COM3, 9600 baud, and \\r terminators. After relevant source edits, determine whether www must be synchronized and remind the user to restart PM2; do not restart PM2 unless explicitly requested. Roll back an edit if its syntax check fails."
].join("\n");

function systemInstructionFor(brainRequest) {
  return `${ALVA_BRAIN_SYSTEM_INSTRUCTION}\n\n${ALVA_CLI_SYSTEM_SUFFIX}\n\nCURRENT REQUEST INTENT: ${brainRequest.intent}${brainRequest.executionGuard ? `\n${brainRequest.executionGuard}` : ""}`;
}

function functionCallsFromResponse(response) {
  if (Array.isArray(response?.functionCalls)) return response.functionCalls;
  return (response?.candidates || []).flatMap(candidate =>
    (candidate?.content?.parts || []).map(part => part.functionCall).filter(Boolean)
  );
}

function executeToolCall(inspector, call) {
  const args = call?.args && typeof call.args === "object" ? call.args : {};
  switch (call?.name) {
    case "readFile":
      return { text: inspector.readFile(args.path, { maxChars: args.maxChars }) };
    case "writeFile":
      return inspector.writeFile(args.path, args.content);
    case "editFile":
      return inspector.editFile(args.path, args.oldText, args.newText, { replaceAll: args.replaceAll === true });
    case "runShell":
      return inspector.runShell(args.command, { timeoutMs: args.timeoutMs });
    default:
      throw new Error(`Unknown ALVA tool: ${String(call?.name)}`);
  }
}

function isInteractiveTerminal(input, output, env = process.env) {
  const ci = /^(1|true|yes)$/i.test(String(env.CI || ""));
  const dumbTerminal = String(env.TERM || "").toLowerCase() === "dumb";
  return Boolean(input.isTTY && output.isTTY && !ci && !dumbTerminal);
}

function supportsColor(output, env = process.env, interactive = Boolean(output.isTTY)) {
  return Boolean(
    output.isTTY &&
    interactive &&
    !env.NO_COLOR &&
    !/^(1|true|yes)$/i.test(String(env.CI || "")) &&
    String(env.TERM || "").toLowerCase() !== "dumb"
  );
}

function renderComposerLine({
  width = 80,
  inputText = "",
  secretInput = false,
  placeholder = ">>",
  colors = false
} = {}) {
  const columns = Math.max(20, Math.floor(width) || 80);
  const inputPrefix = "› ";
  const availableInputWidth = Math.max(1, columns - displayWidth(inputPrefix) - 2);
  const visibleInput = secretInput
    ? "*".repeat(Math.min(availableInputWidth, inputText.length))
    : Array.from(cleanText(inputText.slice(-availableInputWidth * 8))).slice(-availableInputWidth).join("");
  const text = inputText
    ? `${colorize(inputPrefix, ANSI.accent, colors)}${visibleInput}`
    : colorize(placeholder, ANSI.muted, colors);
  return {
    text,
    inputColumn: Math.min(columns, displayWidth(inputPrefix) + displayWidth(visibleInput) + 1)
  };
}

function colorize(value, color, enabled) {
  return enabled ? `${color}${value}${ANSI.reset}` : value;
}

function cleanText(value) {
  return String(value)
    .replace(/\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/\t/g, "  ")
    .replace(/\r\n?/g, "\n");
}

function characterWidth(character) {
  const codePoint = character.codePointAt(0);
  if (/[\p{Mark}\u200D\uFE00-\uFE0F]/u.test(character)) return 0;
  if (
    codePoint >= 0x1100 &&
    (codePoint <= 0x115F ||
      codePoint === 0x2329 ||
      codePoint === 0x232A ||
      (codePoint >= 0x2E80 && codePoint <= 0xA4CF) ||
      (codePoint >= 0xAC00 && codePoint <= 0xD7A3) ||
      (codePoint >= 0xF900 && codePoint <= 0xFAFF) ||
      (codePoint >= 0xFE10 && codePoint <= 0xFE19) ||
      (codePoint >= 0xFE30 && codePoint <= 0xFE6F) ||
      (codePoint >= 0xFF00 && codePoint <= 0xFF60) ||
      (codePoint >= 0xFFE0 && codePoint <= 0xFFE6) ||
      (codePoint >= 0x1F300 && codePoint <= 0x1FAFF))
  ) return 2;
  return 1;
}

function displayWidth(value) {
  return Array.from(value).reduce((width, character) => width + characterWidth(character), 0);
}

function splitLongWord(word, width) {
  const chunks = [];
  let chunk = "";
  for (const character of Array.from(word)) {
    if (chunk && displayWidth(chunk) + characterWidth(character) > width) {
      chunks.push(chunk);
      chunk = "";
    }
    chunk += character;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

function wrapText(text, width, firstPrefix = "", continuationPrefix = firstPrefix) {
  const maxWidth = Math.max(1, Math.floor(width));
  const lines = [];
  for (const paragraph of cleanText(text).split("\n")) {
    if (!paragraph) {
      lines.push("");
      continue;
    }

    let line = "";
    let prefix = firstPrefix;
    const available = () => Math.max(1, maxWidth - displayWidth(prefix));
    for (const rawWord of paragraph.split(/\s+/)) {
      for (const word of splitLongWord(rawWord, available())) {
        if (line && displayWidth(line) + 1 + displayWidth(word) > available()) {
          lines.push(`${prefix}${line}`);
          line = "";
          prefix = continuationPrefix;
        }
        if (line) line += " ";
        line += word;
      }
    }
    lines.push(`${prefix}${line}`);
  }
  return lines;
}

function formatInline(text, { colors = false } = {}) {
  let result = text
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, "$1 ($2)")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
    .replace(/`([^`]+)`/g, (_, code) => colorize(code, ANSI.code, colors))
    .replace(/\*\*(.+?)\*\*|__(.+?)__/g, (_, a, b) => colorize(a ?? b, ANSI.emphasis, colors))
    .replace(/(^|[^\w])\*([^*\n]+)\*|(^|[^\w])_([^_\n]+)_/g, (match, leadA, a, leadB, b) => {
      const lead = leadA ?? leadB ?? "";
      return `${lead}${colorize(a ?? b, ANSI.emphasis, colors)}`;
    });
  result = result.replace(/\\([\\`*_{}\[\]()#+.!>~-])/g, "$1");
  return result;
}

function formatAssistantResponse(value, width = 80, { colors = false } = {}) {
  const availableWidth = Math.max(10, Math.floor(width) - 4);
  const sourceLines = cleanText(value).split("\n");
  const output = [];
  let paragraph = [];
  let codeLines = [];
  let inCodeBlock = false;
  let listContinuation = null;

  const flushParagraph = () => {
    if (!paragraph.length) return;
    const text = formatInline(paragraph.join(" ").trim(), { colors: false });
    output.push(...wrapText(text, availableWidth, "  ", "  ")
      .map(line => colorize(`  ${formatInline(line.slice(2), { colors })}`, ANSI.content, colors)));
    output.push("");
    paragraph = [];
    listContinuation = null;
  };

  const flushCode = () => {
    for (const codeLine of codeLines) {
      const wrapped = wrapText(codeLine, availableWidth - 4, "    ", "    ");
      output.push(...wrapped.map(line => colorize(line, ANSI.code, colors)));
    }
    codeLines = [];
    output.push("");
  };

  for (const sourceLine of sourceLines) {
    const fence = sourceLine.match(/^\s*(```+|~~~+)\s*(.*)$/);
    if (fence) {
      if (inCodeBlock) {
        flushCode();
        inCodeBlock = false;
      } else {
        flushParagraph();
        inCodeBlock = true;
      }
      continue;
    }
    if (inCodeBlock) {
      codeLines.push(sourceLine);
      continue;
    }

    if (!sourceLine.trim()) {
      flushParagraph();
      if (output.length && output[output.length - 1] !== "") output.push("");
      listContinuation = null;
      continue;
    }

    const heading = sourceLine.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
    if (heading) {
      flushParagraph();
      const headingText = formatInline(heading[1], { colors: false });
      output.push(...wrapText(headingText, availableWidth, "  ", "  ")
        .map(line => colorize(`  ${formatInline(line.slice(2), { colors })}`, ANSI.heading, colors)));
      output.push("");
      listContinuation = null;
      continue;
    }

    if (/^\s{0,3}([-*_]\s*){3,}$/.test(sourceLine)) {
      flushParagraph();
      output.push(colorize(`  ${"-".repeat(Math.min(availableWidth - 2, 24))}`, ANSI.muted, colors));
      output.push("");
      listContinuation = null;
      continue;
    }

    const listItem = sourceLine.match(/^(\s*)([-+*]|\d+[.)])\s+(.+)$/);
    if (listItem) {
      flushParagraph();
      const marker = /^\d/.test(listItem[2]) ? `${listItem[2]} ` : "- ";
      const indent = " ".repeat(Math.min(6, Math.floor(listItem[1].length / 2) * 2));
      const firstPrefix = `  ${indent}${marker}`;
      const continuationPrefix = `  ${indent}${" ".repeat(Array.from(marker).length)}`;
      const text = formatInline(listItem[3], { colors: false });
      output.push(...wrapText(text, availableWidth, firstPrefix, continuationPrefix)
        .map(line => colorize(formatInline(line, { colors }), ANSI.content, colors)));
      listContinuation = continuationPrefix;
      continue;
    }

    const quote = sourceLine.match(/^\s{0,3}>\s?(.*)$/);
    if (quote) {
      flushParagraph();
      const text = formatInline(quote[1], { colors: false });
      output.push(...wrapText(text, availableWidth, "  | ", "  | ")
        .map(line => colorize(`  | ${formatInline(line.slice(4), { colors })}`, ANSI.content, colors)));
      listContinuation = null;
      continue;
    }

    if (listContinuation && /^\s{2,}\S/.test(sourceLine)) {
      const text = formatInline(sourceLine.trim(), { colors: false });
      output.push(...wrapText(text, availableWidth, listContinuation, listContinuation)
        .map(line => colorize(formatInline(line.slice(listContinuation.length), { colors }), ANSI.content, colors)));
      continue;
    }
    listContinuation = null;
    paragraph.push(sourceLine.trim());
  }

  if (inCodeBlock) flushCode();
  flushParagraph();
  while (output.length && output[output.length - 1] === "") output.pop();
  return output.join("\n");
}

function formatHistory(contents, width, options) {
  return contents.map(({ role, parts }) => {
    const label = role === "user" ? "YOU" : "ALVA";
    const text = parts.map(part => part.text ?? "").join("");
    const styledLabel = colorize(label, role === "user" ? ANSI.label : ANSI.accent, options.colors);
    return `${styledLabel}\n${role === "user"
      ? wrapText(text, Math.max(10, width - 4), "  > ", "    ").join("\n")
      : formatAssistantResponse(text, width, options)}`;
  }).join("\n\n");
}

function displayModelName(model) {
  return model.replace(/^gemini-/i, "");
}

function formatTrace(message) {
  return GEMINI_MODELS.reduce(
    (formatted, model) => formatted.replaceAll(model, displayModelName(model)),
    message
  );
}

function redactCliSecrets(value) {
  return redactSecrets(value)
    .replace(/\b((?:token|auth[_-]?token|id[_-]?token)\s*[:=]\s*['"]?)[^\s'",;}\]]+/gi, "$1[REDACTED]");
}

function plainTextForClipboard(value, redact = redactCliSecrets) {
  return redact(String(value)
    .replace(/\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\)|[PX^_][\s\S]*?(?:\x07|\x1B\\))/g, "")
    .replace(/\u009B[0-?]*[ -/]*[@-~]|\u009D[^\u0007\u009C]*(?:\u0007|\u009C)/g, "")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\u009F]/g, ""));
}

function createAssistantResponseBuffer(onChunk = () => {}) {
  let chunks = [];
  let committed = false;
  return Object.freeze({
    append(chunk) {
      if (committed) throw new Error("Assistant response is already complete.");
      const text = String(chunk);
      chunks.push(text);
      onChunk(text);
    },
    commit() {
      if (committed) throw new Error("Assistant response is already complete.");
      committed = true;
      const text = chunks.join("");
      chunks = [];
      return text;
    }
  });
}

function writeClipboardText(text, {
  platform = process.platform,
  spawn = spawnChild
} = {}) {
  if (platform !== "win32") return Promise.resolve(false);

  return new Promise(resolve => {
    const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT || "C:\\Windows";
    const systemDirectory = `${systemRoot.replace(/[\\/]+$/, "")}\\System32`;
    const clipPath = `${systemDirectory}\\clip.exe`;
    const powershellPath = `${systemDirectory}\\WindowsPowerShell\\v1.0\\powershell.exe`;
    let child;
    let verifier;
    let settled = false;
    let writeFailed = false;
    let writeFinished = false;
    const stopProcess = process => {
      try {
        process?.kill();
      } catch {
        return;
      }
    };
    const timeout = setTimeout(() => {
      stopProcess(child);
      stopProcess(verifier);
      finish(false);
    }, 3000);
    const finish = success => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(success);
    };

    try {
      child = spawn(clipPath, [], {
        windowsHide: true,
        stdio: ["pipe", "ignore", "ignore"]
      });
    } catch {
      finish(false);
      return;
    }

    try {
      if (!child || typeof child.once !== "function" ||
          !child.stdin || typeof child.stdin.once !== "function" ||
          typeof child.stdin.end !== "function") {
        finish(false);
        return;
      }
      child.once("error", () => finish(false));
      child.stdin.once("error", () => {
        writeFailed = true;
        stopProcess(child);
        finish(false);
      });
      child.once("close", code => {
        if (!writeFinished || writeFailed || code !== 0) {
          finish(false);
          return;
        }
        verifyClipboard(String(text));
      });
      child.stdin.end(Buffer.from(String(text), "utf16le"), () => {
        writeFinished = true;
      });
    } catch {
      writeFailed = true;
      stopProcess(child);
      finish(false);
    }

    function verifyClipboard(expectedText) {
      const script = [
        "$value = Get-Clipboard -Raw",
        "if ($null -eq $value) { exit 2 }",
        "[Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$value)))"
      ].join("; ");
      let output = [];
      let outputLength = 0;
      try {
        verifier = spawn(powershellPath, [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          script
        ], {
          windowsHide: true,
          stdio: ["ignore", "pipe", "ignore"]
        });
        if (!verifier || typeof verifier.once !== "function" ||
            !verifier.stdout || typeof verifier.stdout.on !== "function") {
          finish(false);
          return;
        }
        verifier.once("error", () => finish(false));
        verifier.stdout.on("data", chunk => {
          if (settled) return;
          const data = Buffer.from(chunk);
          outputLength += data.length;
          if (outputLength > 1024 * 1024) {
            output = [];
            stopProcess(verifier);
            finish(false);
            return;
          }
          output.push(data);
        });
        verifier.once("close", code => {
          if (code !== 0) {
            finish(false);
            return;
          }
          const encoded = Buffer.concat(output).toString("ascii").trim();
          if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
            finish(false);
            return;
          }
          finish(Buffer.from(encoded, "base64").toString("utf8") === expectedText);
        });
      } catch {
        finish(false);
      }
    }
  });
}

function isQuotaExhaustion(error) {
  if (Number(error?.status ?? error?.response?.status) === 429) return true;
  const message = typeof error?.message === "string" ? error.message.toLowerCase() : "";
  return /quota|resource[_ ]exhausted|rate[_ ]limit/.test(message);
}

function createTerminalStatus(output, isTerminal, colors) {
  let interval;
  let frameIndex = 0;
  const render = () => {
    const frame = SPINNER_FRAMES[frameIndex % SPINNER_FRAMES.length];
    frameIndex += 1;
    const narrow = Math.max(10, output.columns || 80) < 16;
    const label = narrow ? "..." : "Thinking...";
    output.write(`\r${narrow ? "" : "  "}${colorize(frame, ANSI.muted, colors)} ${colorize(label, ANSI.muted, colors)}`);
  };
  return {
    start() {
      if (!isTerminal) return;
      render();
      interval = setInterval(render, 180);
      if (typeof interval.unref === "function") interval.unref();
    },
    stop() {
      if (interval) clearInterval(interval);
      interval = undefined;
      if (isTerminal) output.write("\r\x1b[2K");
    }
  };
}

function renderWorkspaceScreen({
  width = 80,
  height = 24,
  entries = [],
  inputText = "",
  thinking = false,
  spinner = SPINNER_FRAMES[0],
  notice = "",
  colors = false,
  scrollFromBottom = 0,
  view = "chat",
  panelEntries = [],
  secretInput = false,
  placeholder = ">>"
} = {}) {
  const columns = Math.max(20, Math.floor(width) || 80);
  const rows = Math.max(10, Math.floor(height) || 24);
  const contentWidth = Math.max(10, Math.min(100, columns - 4));
  const viewportHeight = Math.max(2, rows - 5);
  const body = [];

  for (const entry of view === "chat" ? entries : panelEntries) {
    if (entry.role === "panel") {
      for (const line of cleanText(entry.text).split("\n")) {
        if (/^(ALVA SETTINGS|ALVA COMMANDS|API KEYS|API KEY MANAGEMENT|Add API Key|Remove API Key|Test API Keys|Set Active Key)$/.test(line)) {
          body.push(colorize(line, ANSI.heading, colors));
        } else {
          body.push(...wrapText(line, contentWidth, "  ", "  "));
        }
      }
      body.push("");
      continue;
    }
    if (entry.role === "user") {
      body.push(colorize("YOU", ANSI.label, colors));
      const preview = entry.text.length > 8000
        ? `${entry.text.slice(0, 4000)}\n[Long message preview; full message sent]\n${entry.text.slice(-4000)}`
        : entry.text;
      body.push(...wrapText(preview, contentWidth, "  > ", "    "));
      body.push("");
      continue;
    }

    if (entry.role === "assistant") {
      body.push(colorize("ALVA  /  now", ANSI.accent, colors));
      const formatted = formatAssistantResponse(entry.text, contentWidth + 4, { colors });
      if (formatted) body.push(...formatted.split("\n"));
      body.push("");
      continue;
    }

    body.push(...wrapText(entry.text, contentWidth, "  ", "  ")
      .map(line => colorize(line, ANSI.muted, colors)));
  }

  if (thinking) {
    body.push(colorize(`  ${spinner} Thinking...`, ANSI.muted, colors));
  }
  if (notice) {
    body.push(colorize(notice, ANSI.status, colors));
  }

  const maxScroll = Math.max(0, body.length - viewportHeight);
  const fromBottom = Math.min(maxScroll, Math.max(0, scrollFromBottom));
  const start = Math.max(0, body.length - viewportHeight - fromBottom);
  const conversation = body.slice(start, start + viewportHeight);
  while (conversation.length < viewportHeight) conversation.push("");

  const status = " ONLINE";
  const top = `${colorize("ALVA", ANSI.accent, colors)}${" ".repeat(Math.max(1, columns - displayWidth("ALVA") - displayWidth(status)))}${colorize(status, ANSI.status, colors)}`;
  const subheader = colorize("by Deni Hasyim", ANSI.muted, colors);
  const separator = colorize("-".repeat(columns), ANSI.muted, colors);
  const composer = renderComposerLine({ width: columns, inputText, secretInput, placeholder, colors });
  const screen = [
    top,
    subheader,
    separator,
    ...conversation,
    separator,
    composer
  ].slice(0, rows);
  while (screen.length < rows) screen.push("");

  return {
    text: [...screen.slice(0, -1), composer.text].join("\n"),
    width: columns,
    height: rows,
    viewportHeight,
    inputRow: rows,
    inputColumn: composer.inputColumn,
    thinkingRow: thinking ? 4 + body.length - 1 - start : undefined,
    maxScroll
  };
}

async function createInteractiveWorkspace({
  ai,
  apiKeyPool,
  projectInspector = createProjectInspector(),
  clipboardWriter,
  createAI,
  input = process.stdin,
  output = process.stdout,
  env = process.env,
  args = []
}) {
  const isTerminal = isInteractiveTerminal(input, output, env);
  const colors = supportsColor(output, env, isTerminal);
  const contents = [];
  let uiState = "CHAT";
  let settingsKeys = [];
  let pendingRemoval = null;
  let settingsNotice = "";
  let testedStatuses = new Map();
  const initialArgs = args.filter(argument => argument !== "--verbose");
  let verbose = args.includes("--verbose");
  let selectedModel;
  let lockedModel;
  let closed = false;
  let secretInput = false;
  const getWidth = () => Math.max(10, output.columns || 80);
  const activeModelLabel = () => displayModelName(selectedModel || lockedModel || GEMINI_MODELS[0]);

  function getRepositoryStatus() {
    try {
      const output = projectInspector.runGitReadOnly(["status", "--short"]);
      if (output.startsWith("Git inspection unavailable:")) return "repository status unavailable";
      const changes = output.split(/\r?\n/).filter(Boolean).length;
      return changes ? `${changes} uncommitted change${changes === 1 ? "" : "s"}` : "working tree clean";
    } catch {
      return "repository status unavailable";
    }
  }

  function writeWelcomeBanner() {
    const width = Math.max(32, Math.min(88, getWidth()));
    const line = "-".repeat(width);
    output.write(`${colorize(line, ANSI.muted, colors)}\n`);
    output.write(`${colorize("ALVA", ANSI.heading, colors)} ${colorize(" ONLINE", ANSI.status, colors)}  ${colorize("software engineering agent", ANSI.muted, colors)}\n`);
    output.write(`${colorize("by Deni Hasyim", ANSI.muted, colors)}\n`);
    output.write(`${colorize("model", ANSI.label, colors)} ${activeModelLabel()}  ${colorize("repo", ANSI.label, colors)} ${getRepositoryStatus()}\n`);
    output.write(`${colorize("Tip:", ANSI.muted, colors)} Describe a change, or type /help for commands.\n`);
    output.write(`${colorize(line, ANSI.muted, colors)}\n\n`);
  }

  function writeWorkspaceStatus() {
    const index = projectInspector.getIndex();
    const fileCount = index.entries.filter(entry => entry.type === "file").length;
    const sessionMessages = contents.filter(entry => entry.role === "user").length;
    writeAssistant([
      `Model: ${activeModelLabel()}`,
      `Repository: ${getRepositoryStatus()}`,
      `Workspace: ${projectInspector.root} (${fileCount} indexed files)`,
      `Session: ${sessionMessages} prompt${sessionMessages === 1 ? "" : "s"}`
    ].join("\n"));
  }

  async function testConfiguredKeys() {
    if (!apiKeyPool) {
      settingsNotice = "API key management is unavailable.";
      showSettings();
      return;
    }
    uiState = "TEST_API_KEYS";
    panel("TEST API KEYS\n\nTesting configured API keys...");
    try {
      const results = await apiKeyPool.testAll(async key => {
        const client = makeAI(key);
        await client.models.generateContent({
          model: GEMINI_MODELS[GEMINI_MODELS.length - 1],
          contents: "Reply with OK."
        });
      });
      testedStatuses = new Map(results.map(result => [result.id, result.status]));
      const resultText = [
        "TEST API KEYS",
        "",
        ...results.map(result => {
          const marker = result.status === "INVALID" || result.status === "RATE LIMITED" ||
            result.status === "UNAVAILABLE" ? "!" : "✓";
          return `${marker} ${result.label}   ${result.masked}   ${result.status}`;
        }),
        "",
        "Returning to settings..."
      ].join("\n");
      output.write(`${resultText}\n\n`);
      settingsNotice = results.length
        ? `Tested ${results.length} API key${results.length === 1 ? "" : "s"}.`
        : "No API keys configured.";
    } catch {
      settingsNotice = "Unable to test API keys.";
    }
    showSettings();
  }

  function getModels() {
    return selectedModel
      ? [selectedModel, ...GEMINI_MODELS.filter(model => model !== selectedModel)]
      : GEMINI_MODELS;
  }

  const makeAI = createAI || (key => new GoogleGenAI({
    apiKey: key,
    httpOptions: {
      timeout: REQUEST_TIMEOUT_MS,
      retryOptions: { attempts: 1 }
    }
  }));

  function panel(text) {
    const safeText = redactCliSecrets(apiKeyPool ? apiKeyPool.redact(text) : text);
    output.write(`${safeText}\n\n`);
  }

  function showChat() {
    uiState = "CHAT";
    secretInput = false;
  }

  function showHelp() {
    uiState = "HELP";
    secretInput = false;
    panel([
      "ALVA COMMANDS",
      "",
      "/setting    Manage API keys and ALVA settings",
      "/clear      Clear conversation",
      "/status     Show model, repository, workspace, and session status",
      "/history    View conversation history",
      "/copy [n]   Copy an assistant response (latest by default)",
      "/model      View or choose a model",
      "/project scan  Refresh project filesystem index",
      "/verbose    Toggle technical details",
      "/exit       Exit ALVA",
      "",
      "/back       Return to chat"
    ].join("\n"));
  }

  function showSettings() {
    uiState = "SETTINGS";
    settingsKeys = apiKeyPool ? apiKeyPool.list() : [];
    pendingRemoval = null;
    secretInput = false;
    const lines = [
      "ALVA SETTINGS",
      "",
      "API KEYS",
      ...(settingsKeys.length
        ? settingsKeys.map((key, index) => {
          const testedStatus = testedStatuses.get(key.id);
          const status = key.status === "COOLDOWN" || key.status === "INVALID"
            ? key.status
            : testedStatus === "ACTIVE" ? "READY" : testedStatus || key.status;
          return `${key.id === apiKeyPool.activeId ? "*" : "o"} Key ${index + 1}  ${key.masked}  ${status}`;
        })
        : ["No API keys configured."]),
      "",
      "API KEY MANAGEMENT",
      "[1] Add API Key",
      "[2] Remove API Key",
      "[3] Test API Keys",
      "[4] Set Active Key",
      "[5] Back",
      ...(settingsNotice ? ["", settingsNotice] : [])
    ];
    panel(lines.join("\n"));
  }

  function showKeySelection(action) {
    settingsKeys = apiKeyPool?.list() ?? [];
    if (!settingsKeys.length) {
      settingsNotice = "No API keys configured.";
      showSettings();
      return;
    }
    uiState = action;
    secretInput = false;
    panel([
      action === "REMOVE_API_KEY" ? "REMOVE API KEY" : "SET ACTIVE KEY",
      "",
      ...settingsKeys.map((key, index) => `[${index + 1}] ${key.masked}  ${key.status}`),
      "",
      "Type a number, or /back to return to settings."
    ].join("\n"));
  }

  function showRemovalConfirmation() {
    uiState = "REMOVE_CONFIRMATION";
    panel([
      "REMOVE API KEY",
      "",
      `Remove ${pendingRemoval.masked}?`,
      "",
      "Type Y to confirm or N to cancel."
    ].join("\n"));
  }

  async function handleSettingsInput(line) {
    const choice = line.trim();
    switch (uiState) {
      case "SETTINGS":
        switch (choice) {
          case "1":
            uiState = "ADD_API_KEY";
            secretInput = true;
            panel("ADD API KEY\n\nPaste the API key. It will be masked while you type.");
            return;
          case "2":
            showKeySelection("REMOVE_API_KEY");
            return;
          case "3":
            await testConfiguredKeys();
            return;
          case "4":
            showKeySelection("SET_ACTIVE_KEY");
            return;
          case "5":
            showChat();
            return;
          default:
            settingsNotice = "Invalid option. Choose 1, 2, 3, 4, or 5.";
            showSettings();
            return;
        }

      case "ADD_API_KEY":
        if (!apiKeyPool) {
          settingsNotice = "API key management is unavailable.";
        } else {
          try {
            const added = apiKeyPool.add(line);
            settingsNotice = `API key added successfully: ${added.masked}`;
          } catch (error) {
            settingsNotice = error instanceof Error ? error.message : "Unable to add API key.";
          }
        }
        showSettings();
        return;

      case "REMOVE_API_KEY": {
        const index = /^\d+$/.test(choice) ? Number(choice) - 1 : -1;
        if (index < 0 || index >= settingsKeys.length) {
          settingsNotice = "Invalid key selection.";
          showKeySelection("REMOVE_API_KEY");
          return;
        }
        pendingRemoval = settingsKeys[index];
        showRemovalConfirmation();
        return;
      }

      case "REMOVE_CONFIRMATION":
        if (/^y(es)?$/i.test(choice)) {
          try {
            apiKeyPool.remove(pendingRemoval.id, { confirmed: true });
            settingsNotice = `API key removed: ${pendingRemoval.masked}`;
          } catch (error) {
            settingsNotice = error instanceof Error ? error.message : "Unable to remove API key.";
          }
          pendingRemoval = null;
          showSettings();
        } else if (/^n(o)?$/i.test(choice)) {
          pendingRemoval = null;
          settingsNotice = "Removal cancelled.";
          showSettings();
        } else {
          showRemovalConfirmation();
        }
        return;

      case "SET_ACTIVE_KEY": {
        const index = /^\d+$/.test(choice) ? Number(choice) - 1 : -1;
        if (index < 0 || index >= settingsKeys.length) {
          settingsNotice = "Invalid key selection.";
          showKeySelection("SET_ACTIVE_KEY");
          return;
        }
        try {
          const selected = apiKeyPool.setActive(settingsKeys[index].id);
          settingsNotice = `Active API key set to ${selected.masked}.`;
        } catch (error) {
          settingsNotice = error instanceof Error ? error.message : "Unable to set active API key.";
        }
        showSettings();
        return;
      }

      case "TEST_API_KEYS":
        return;

      default:
        showSettings();
    }
  }

  function writeDivider() {
    output.write(`${colorize(`  ${"-".repeat(Math.max(1, Math.min(40, getWidth() - 4)))}`, ANSI.muted, colors)}\n`);
  }

  function writeAssistant(text) {
    const safeText = redactCliSecrets(apiKeyPool ? apiKeyPool.redact(text) : text);
    output.write(`${colorize("ALVA", ANSI.accent, colors)}\n`);
    const formatted = formatAssistantResponse(safeText, getWidth(), { colors });
    if (formatted) output.write(`${formatted}\n`);
    output.write("\n");
  }

  function toolSummary(call, result) {
    const args = call?.args || {};
    if (call?.name === "readFile") return args.path || "(unknown path)";
    if (call?.name === "writeFile") {
      return `${args.path || "(unknown path)"}${result?.bytes != null ? ` · ${result.bytes} bytes` : ""}`;
    }
    if (call?.name === "editFile") {
      return `${args.path || "(unknown path)"}${result?.replacements != null ? ` · ${result.replacements} replacement${result.replacements === 1 ? "" : "s"}` : ""}`;
    }
    if (call?.name === "runShell") return args.command || "(empty command)";
    return call?.name || "unknown tool";
  }

  function writeToolStatus(call, phase, result, durationMs) {
    const label = {
      readFile: "Read",
      writeFile: "Write",
      editFile: "Edit",
      runShell: "Shell"
    }[call?.name] || "Tool";
    const summary = toolSummary(call, result);
    if (phase === "start") {
      output.write(`${colorize(`  [${label}]`, ANSI.label, colors)} ${colorize(summary, ANSI.muted, colors)}\n`);
      return;
    }
    const success = result?.ok === true;
    const marker = success ? "✓" : "×";
    const detail = success
      ? `${summary} · ${durationMs}ms${call?.name === "runShell" ? ` · exit ${result.result.exitCode ?? "?"}` : ""}`
      : `${summary} · ${result?.error || "failed"}`;
    output.write(`${colorize(`  ${marker} [${label}]`, success ? ANSI.status : ANSI.label, colors)} ${detail}\n`);
  }

  function copyToClipboard(text) {
    return writeClipboardText(text, { output });
  }

  async function sendPrompt(prompt) {
    const poolRedactedPrompt = apiKeyPool ? apiKeyPool.redact(prompt) : prompt;
    const safePrompt = redactCliSecrets(poolRedactedPrompt);
    output.write(`${colorize("YOU", ANSI.label, colors)}\n`);
    output.write(`${wrapText(safePrompt, Math.max(10, getWidth() - 4), "  > ", "    ").join("\n")}\n\n`);
    if (!apiKeyPool && !ai) {
      writeAssistant("Kunci API belum tersedia untuk ALVA.");
      return;
    }
    if (apiKeyPool && !apiKeyPool.list().length) {
      writeAssistant("No API keys are configured. Type /setting to add one.");
      return;
    }

    contents.push({ role: "user", parts: [{ text: safePrompt }] });
    const brainRequest = prepareBrainRequest(safePrompt, { inspector: projectInspector });
    let providerContents = [
      ...contents.slice(0, -1),
      { role: "user", parts: [{ text: brainRequest.userText }] }
    ];
    const status = createTerminalStatus(output, isTerminal, colors);
    status.start();
    try {
      const generateForKey = async key => {
        const client = apiKeyPool ? makeAI(key) : ai;
        let successfulModel;
        const generateContent = async model => {
          try {
            const response = await client.models.generateContent({
              model,
              contents: providerContents,
              config: {
                systemInstruction: systemInstructionFor(brainRequest),
                tools: ALVA_TOOLS
              }
            });
            successfulModel = model;
            return response;
          } catch (error) {
            if (isQuotaExhaustion(error) && Number(error?.status ?? error?.response?.status) !== 429) {
              throw Object.assign(new Error("API quota exhausted."), { status: 429 });
            }
            throw error;
          }
        };
        const options = {
          log: verbose
            ? message => output.write(`  ${colorize("[trace]", ANSI.muted, colors)} ${formatTrace(message)}\n`)
            : undefined
        };
        if (lockedModel && !selectedModel) {
          try {
            const response = await generateWithFallback({
              ...options,
              models: [lockedModel],
              generateContent
            });
            return { response, model: successfulModel, client };
          } catch (error) {
            if (!(error instanceof GeminiRequestError) || !error.transient) throw error;
            lockedModel = undefined;
          }
        }
        const response = await generateWithFallback({
          ...options,
          models: getModels(),
          generateContent
        });
        return { response, model: successfulModel, client };
      };
      const result = apiKeyPool
        ? await apiKeyPool.runWithRotation(generateForKey, {
          log: verbose ? message => output.write(`  ${colorize("[key pool]", ANSI.muted, colors)} ${message}\n`) : undefined
        })
        : await generateForKey(undefined);
      lockedModel = result.model;
      let client = result.client;
      let response = result.response;
      for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
        const calls = functionCallsFromResponse(response);
        if (!calls.length) break;
        const responseParts = [];
        for (const call of calls) {
          let toolResult;
          status.stop();
          writeToolStatus(call, "start");
          const startedAt = Date.now();
          try {
            toolResult = { ok: true, result: executeToolCall(projectInspector, call) };
          } catch (error) {
            toolResult = { ok: false, error: error instanceof Error ? error.message : String(error) };
          }
          writeToolStatus(call, "complete", toolResult, Date.now() - startedAt);
          status.start();
          responseParts.push({
              functionResponse: {
                id: call.id,
                name: call.name,
                response: toolResult
              }
            });
        }
        const modelContent = response?.candidates?.[0]?.content ?? { role: "model", parts: calls.map((call) => ({ functionCall: call })) };

          if (!modelContent) {
            throw new Error("Gemini tool response content is missing.");
          }

          providerContents = [
            ...providerContents,
            modelContent,
            { role: "user", parts: responseParts }
          ];
                const runToolFollowUp = async currentClient => {
          return generateWithFallback({
            models: [result.model],
            log: verbose
              ? message => output.write(`  ${colorize("[trace]", ANSI.muted, colors)} ${formatTrace(message)}\n`)
              : undefined,
            generateContent: model => currentClient.models.generateContent({
              model,
              contents: providerContents,
              config: {
                systemInstruction: systemInstructionFor(brainRequest),
                tools: ALVA_TOOLS
              }
            })
          });
        };

        const followUpResult = apiKeyPool
          ? await apiKeyPool.runWithRotation(async key => {
              const rotatedClient = makeAI(key);
              const followUpResponse = await runToolFollowUp(rotatedClient);
              return { response: followUpResponse, client: rotatedClient };
            }, {
              log: verbose
                ? message => output.write(`  ${colorize("[key pool]", ANSI.muted, colors)} ${message}\n`)
                : undefined
            })
          : {
              response: await runToolFollowUp(client),
              client
            };

        response = followUpResult.response;
        client = followUpResult.client;
      }
      if (functionCallsFromResponse(response).length) {
        throw new Error(`ALVA stopped after ${MAX_TOOL_ROUNDS} tool-execution rounds.`);
      }
      let answer = redactCliSecrets(apiKeyPool ? apiKeyPool.redact(response.text ?? "") : response.text ?? "");
      status.stop();
      writeAssistant(answer);
      contents.push({ role: "model", parts: [{ text: answer }] });
    } catch (error) {
      status.stop();
      try {
        require("node:fs").appendFileSync(
          "C:\\Users\\POLLARD\\AppData\\Local\\Temp\\opencode\\alva-internal-debug.log",
          `\n===== ${new Date().toISOString()} =====\nNAME: ${error?.name}\nMESSAGE: ${error?.message}\nSTACK: ${error?.stack}\nCONSTRUCTOR: ${error?.constructor?.name}\nSTATUS: ${error?.status} RESPONSE_STATUS: ${error?.response?.status} CODE: ${error?.code}\n`
        );
      } catch {}
      const reason = error instanceof GeminiRequestError
        ? error.transient
          ? "semua model gagal setelah retry"
          : error.status
            ? `kesalahan permanen (HTTP ${error.status})`
            : "kesalahan permanen atau tidak dapat dipulihkan"
        : error instanceof ApiKeyPoolError
          ? error.code === "all_rate_limited"
            ? "all API keys are temporarily unavailable"
            : error.code === "no_valid_keys"
              ? "no valid API keys are available"
              : "no API key is configured"
        : "kesalahan internal";
      contents.pop();
      writeAssistant(`Permintaan ALVA gagal: ${reason}.`);
    }
  }

  async function handleCommand(line) {
    const [command = "", ...parameters] = line.trim().split(/\s+/);
    switch (command.toLowerCase()) {
      case "/help":
        showHelp();
        return true;
      case "/setting":
        showSettings();
        return true;
      case "/back":
        showChat();
        return true;
      case "/clear":
        contents.length = 0;
        writeDivider();
        writeAssistant("Percakapan dibersihkan.");
        return true;
      case "/status":
        writeWorkspaceStatus();
        return true;
      case "/history":
        {
          const history = contents.length
            ? formatHistory(contents, getWidth(), { colors })
            : "Belum ada riwayat percakapan.";
          writeAssistant(history);
        }
        return true;
      case "/copy":
        {
          const responses = contents.filter(entry => entry.role === "model");
          const requested = parameters.length && /^\d+$/.test(parameters[0])
            ? Number(parameters[0])
            : responses.length;
          const selected = requested > 0 ? responses[requested - 1] : undefined;
          if (!selected) {
            writeAssistant("No assistant response is available to copy.");
            return true;
          }
          const clipboardText = plainTextForClipboard(selected.parts.map(part => part.text ?? "").join(""), text =>
            redactCliSecrets(apiKeyPool ? apiKeyPool.redact(text) : text)
          );
          let copyResult;
          try {
            copyResult = clipboardWriter
              ? await clipboardWriter(clipboardText)
              : await copyToClipboard(clipboardText);
          } catch {
            copyResult = false;
          }
          if (copyResult === true || copyResult?.copied) {
            const status = "✓ Response copied to clipboard.";
            output.write(`${status}\n`);
          } else {
            const status = "Copy unavailable in this terminal.";
            output.write(`${status}\n`);
          }
        }
        return true;
      case "/model":
        if (parameters.length === 0) {
          const activeModel = selectedModel ? displayModelName(selectedModel) : "otomatis";
          const availableModels = GEMINI_MODELS.map(displayModelName).join(", ");
          writeAssistant(`Model aktif: ${activeModel}\nModel tersedia: ${availableModels}`);
        } else if (GEMINI_MODELS.includes(parameters[0])) {
          selectedModel = parameters[0];
          writeAssistant(`Model utama diatur ke ${displayModelName(selectedModel)}; fallback otomatis tetap aktif.`);
        } else {
          writeAssistant(`Model tidak dikenal. Pilihan: ${GEMINI_MODELS.map(displayModelName).join(", ")}`);
        }
        return true;
      case "/project":
        if (parameters[0]?.toLowerCase() !== "scan") {
          writeAssistant("Gunakan /project scan untuk memindai ulang filesystem C:\\POS.");
          return true;
        }
        {
          const index = projectInspector.refresh();
          const directoryCount = index.entries.filter(entry => entry.type === "directory").length;
          const fileCount = index.entries.filter(entry => entry.type === "file").length;
          writeAssistant(`Project filesystem index refreshed from ${projectInspector.root}.\n${directoryCount} directories and ${fileCount} files discovered.\nScanned: ${index.scannedAt}`);
        }
        return true;
      case "/verbose":
        verbose = !verbose;
        writeAssistant(`Mode verbose ${verbose ? "aktif" : "nonaktif"}.`);
        return true;
      case "/exit":
        return false;
      default:
        writeAssistant("Perintah tidak dikenal. Ketik /help untuk daftar perintah.");
        return true;
    }
  }

  async function processLine(line, { pasted = false } = {}) {
    const trimmed = line.trim();
    if (!pasted && trimmed === "/exit") return handleCommand(trimmed);
    if (!trimmed && uiState !== "ADD_API_KEY") return true;

    if (uiState === "CHAT") {
      if (!pasted && trimmed.startsWith("/")) return handleCommand(trimmed);
      await sendPrompt(pasted ? line : trimmed);
      return true;
    }

    if (uiState === "HELP") {
      if (!pasted && trimmed === "/back") showChat();
      else if (!pasted && trimmed === "/setting") showSettings();
      else if (!pasted && trimmed === "/help") showHelp();
      else if (!pasted && trimmed.startsWith("/")) {
        showChat();
        return handleCommand(trimmed);
      } else showHelp();
      return true;
    }

    if (!pasted && trimmed === "/setting") {
      showSettings();
      return true;
    }
    if (!pasted && trimmed === "/help") {
      showHelp();
      return true;
    }
    if (!pasted && trimmed === "/back") {
      if (uiState === "SETTINGS") showChat();
      else showSettings();
      return true;
    }

    if (uiState === "ADD_API_KEY" && !trimmed) {
      settingsNotice = "API key cannot be empty.";
      uiState = "SETTINGS";
      showSettings();
      return true;
    }
    await handleSettingsInput(line);
    return true;
  }

  writeWelcomeBanner();

  if (initialArgs.length) await sendPrompt(initialArgs.join(" "));

  const lineInput = isTerminal ? new PassThrough() : input;
  if (isTerminal) {
    lineInput.isTTY = true;
    Object.defineProperties(lineInput, {
      columns: { get: () => input.columns },
      rows: { get: () => input.rows }
    });
    lineInput.setRawMode = mode => input.setRawMode?.(mode);
  }
  const readlineOutput = isTerminal
    ? new Writable({
      write(chunk, encoding, callback) {
        const text = chunk.toString().replace(/\x1B\[0J/g, "\x1B[0K");
        if (output.write(text)) callback();
        else output.once("drain", callback);
      }
    })
    : output;
  if (isTerminal) {
    readlineOutput.isTTY = true;
    Object.defineProperties(readlineOutput, {
      columns: { get: () => output.columns },
      rows: { get: () => output.rows }
    });
  }
  const rl = readline.createInterface({
    input: lineInput,
    output: readlineOutput,
    terminal: isTerminal
  });
  const setInputPrompt = () => {
    const promptText = uiState === "ADD_API_KEY"
      ? "Paste API key..."
      : uiState === "SETTINGS"
        ? "Choose an option..."
        : uiState === "HELP"
          ? "Type /back to return..."
          : uiState === "REMOVE_CONFIRMATION"
            ? "Confirm removal? (Y/N)"
            : uiState === "REMOVE_API_KEY" || uiState === "SET_ACTIVE_KEY"
              ? "Choose a key..."
          : ">>";
    if (uiState === "CHAT") {
      rl.setPrompt(colorize("alva >> ", ANSI.accent, colors));
      return;
    }
    const prompt = getWidth() < 18 ? "" : `${promptText} `;
    rl.setPrompt(`${colorize("› ", ANSI.accent, colors)}${prompt}`);
  };
  setInputPrompt();
  let pendingLines = Promise.resolve();
  const enqueueLine = (line, pasted = false) => {
    pendingLines = pendingLines.then(async () => {
      if (closed) return;
      if (!await processLine(line, { pasted })) {
        closed = true;
        rl.close();
        return;
      }
      if (!closed && !rl.closed) {
        setInputPrompt();
        rl.prompt();
      }
    }).catch(error => {
      rl.close();
      throw error;
    });
  };
  const complete = new Promise((resolve, reject) => {
    rl.on("close", () => pendingLines.then(resolve, reject));
  });
  rl.on("line", line => enqueueLine(line));
  rl.on("SIGINT", () => {
    output.write("\n");
    closed = true;
    output.write(`${colorize("Workspace closed.", ANSI.muted, colors)}\n`);
    rl.close();
  });
  if (isTerminal) {
    const pasteStart = "\x1b[200~";
    const pasteEnd = "\x1b[201~";
    let sourceBuffer = "";
    let pasteBuffer = "";
    let inBracketedPaste = false;
    const markerPrefixLength = (value, marker) => {
      for (let length = Math.min(value.length, marker.length - 1); length > 0; length -= 1) {
        if (value.endsWith(marker.slice(0, length))) return length;
      }
      return 0;
    };
    const consumeInput = chunk => {
      sourceBuffer += chunk.toString();
      while (sourceBuffer) {
        if (inBracketedPaste) {
          const end = sourceBuffer.indexOf(pasteEnd);
          const interrupt = sourceBuffer.indexOf("\x03");
          if (interrupt !== -1 && (end === -1 || interrupt < end)) {
            closed = true;
            rl.close();
            return;
          }
          if (end === -1) {
            const held = markerPrefixLength(sourceBuffer, pasteEnd);
            const readyLength = sourceBuffer.length - held;
            pasteBuffer += sourceBuffer.slice(0, readyLength);
            sourceBuffer = sourceBuffer.slice(readyLength);
            return;
          }
          pasteBuffer += sourceBuffer.slice(0, end);
          sourceBuffer = sourceBuffer.slice(end + pasteEnd.length);
          inBracketedPaste = false;
          enqueueLine(pasteBuffer, true);
          pasteBuffer = "";
          continue;
        }

        const start = sourceBuffer.indexOf(pasteStart);
        if (start !== -1) {
          if (start) lineInput.write(sourceBuffer.slice(0, start));
          sourceBuffer = sourceBuffer.slice(start + pasteStart.length);
          inBracketedPaste = true;
          continue;
        }

        const held = markerPrefixLength(sourceBuffer, pasteStart);
        const readyLength = sourceBuffer.length - held;
        if (!readyLength) return;
        const plainInput = sourceBuffer.slice(0, readyLength);
        sourceBuffer = sourceBuffer.slice(readyLength);
        if ((plainInput.match(/\r\n|\r|\n/g) || []).length > 1) {
          enqueueLine(plainInput.replace(/\r\n?/g, "\n"), true);
        } else {
          lineInput.write(plainInput);
        }
      }
    };
    const inputDataHandler = chunk => consumeInput(chunk);
    const inputEndHandler = () => {
      if (inBracketedPaste) {
        enqueueLine(pasteBuffer + sourceBuffer, true);
        sourceBuffer = "";
        pasteBuffer = "";
        inBracketedPaste = false;
      } else if (sourceBuffer) {
        lineInput.write(sourceBuffer);
        sourceBuffer = "";
      }
      lineInput.end();
    };
    input.on("data", inputDataHandler);
    input.once("end", inputEndHandler);
    const resizeHandler = () => readlineOutput.emit("resize");
    output.on("resize", resizeHandler);
    output.write("\x1b[?2004h");
    rl.once("close", () => {
      input.off("data", inputDataHandler);
      input.off("end", inputEndHandler);
      output.off("resize", resizeHandler);
      output.write("\x1b[?2004l");
    });
    rl._writeToOutput = value => {
      const text = String(value).replace(/\x1B\[1G\x1B\[0J/g, "\r\x1B[0K");
      let safeText = text;
      if (secretInput) {
        const prompt = rl.getPrompt();
        const placeholder = "\u0000ALVA_SECRET_PROMPT\u0000";
        safeText = text.replace(prompt, placeholder)
          .replace(/\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))|[^\x00-\x1F\x7F]/g, sequence =>
            sequence.startsWith("\x1B") ? sequence : "*")
          .replace(placeholder, prompt);
      }
      readlineOutput.write(safeText);
    };
  }
  rl.prompt();
  await complete;
}

async function main(args = process.argv.slice(2)) {
  const apiKeyPool = new ApiKeyPool();
  const createAI = key => new GoogleGenAI({
    apiKey: key,
    httpOptions: {
      timeout: REQUEST_TIMEOUT_MS,
      retryOptions: { attempts: 1 }
    }
  });
  await createInteractiveWorkspace({ apiKeyPool, createAI, args });
}

if (require.main === module) {
  main().catch(() => {
    console.error("ALVA gagal memulai workspace terminal.");
    process.exitCode = 1;
  });
}

module.exports = {
  main,
  createInteractiveWorkspace,
  createAssistantResponseBuffer,
  formatAssistantResponse,
  plainTextForClipboard,
  writeClipboardText,
  renderWorkspaceScreen,
  renderComposerLine,
  displayWidth,
  wrapText,
  ALVA_TOOLS,
  ALVA_CLI_SYSTEM_SUFFIX,
  systemInstructionFor,
  functionCallsFromResponse,
  executeToolCall
};

