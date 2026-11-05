"use strict";

const UNICODE_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const ASCII_FRAMES = ["|", "/", "-", "\\"];
const STATUS_MESSAGES = [
  "Mencari model terbaik…",
  "Menghubungi Gemini…",
  "Mencoba model terbaik…",
  "Gemini sedang berpikir…",
  "Menganalisis…"
];

function createGeminiStatus({
  stdout = process.stdout,
  platform = process.platform,
  intervalMs = 100,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval
} = {}) {
  const frames = platform === "win32" ? ASCII_FRAMES : UNICODE_FRAMES;
  let timer;
  let frameIndex = 0;
  let statusIndex = 0;
  let ticks = 0;
  let previousLength = 0;
  let active = false;

  function render() {
    if (!active || !stdout.isTTY) return;
    const line = `${frames[frameIndex]} ${STATUS_MESSAGES[statusIndex]}`;
    stdout.write(`\r${line}${" ".repeat(Math.max(0, previousLength - line.length))}`);
    previousLength = line.length;
    frameIndex = (frameIndex + 1) % frames.length;
    ticks += 1;
    if (ticks % 18 === 0) {
      statusIndex = (statusIndex + 1) % STATUS_MESSAGES.length;
    }
  }

  return {
    start() {
      if (active) return;
      active = true;
      if (!stdout.isTTY) return;
      render();
      timer = setIntervalFn(render, intervalMs);
    },
    stop() {
      if (!active) return;
      active = false;
      if (timer !== undefined) {
        clearIntervalFn(timer);
        timer = undefined;
      }
      if (stdout.isTTY && previousLength > 0) {
        stdout.write(`\r${" ".repeat(previousLength)}\r`);
      }
      previousLength = 0;
    }
  };
}

async function runWithGeminiStatus(operation, status = createGeminiStatus()) {
  status.start();
  try {
    return await operation();
  } finally {
    status.stop();
  }
}

module.exports = { createGeminiStatus, runWithGeminiStatus };
