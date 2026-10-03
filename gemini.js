#!/usr/bin/env node
"use strict";

const { GoogleGenAI } = require("@google/genai");
const { GEMINI_MODELS, REQUEST_TIMEOUT_MS } = require("./gemini-config");
const { generateWithFallback, GeminiRequestError } = require("./gemini-fallback");
const { createGeminiStatus, runWithGeminiStatus } = require("./gemini-status");

async function main(args = process.argv.slice(2)) {
  const verbose = args.includes("--verbose");
  const prompt = args.filter(argument => argument !== "--verbose").join(" ").trim();
  if (!prompt) {
    console.error('Gunakan: node gemini.js [--verbose] "pertanyaan atau prompt Anda"');
    process.exitCode = 1;
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    console.error("Error: kunci API Gemini belum tersedia.");
    process.exitCode = 1;
    return;
  }

  const ai = new GoogleGenAI({
    apiKey,
    httpOptions: {
      timeout: REQUEST_TIMEOUT_MS,
      retryOptions: { attempts: 1 }
    }
  });

  try {
    const response = await runWithGeminiStatus(
      () => generateWithFallback({
        models: GEMINI_MODELS,
        generateContent: model => ai.models.generateContent({ model, contents: prompt }),
        log: verbose ? message => console.info(message) : undefined
      }),
      verbose ? { start() {}, stop() {} } : createGeminiStatus()
    );
    console.log("✓ Gemini siap — analisis dimulai");
    console.log(response.text ?? "");
  } catch (error) {
    if (error instanceof GeminiRequestError) {
      const reason = error.transient
        ? "semua model gagal setelah retry"
        : error.status
          ? `kesalahan permanen (HTTP ${error.status})`
          : "kesalahan permanen atau tidak dapat dipulihkan";
      console.error(`Permintaan Gemini gagal: ${reason}.`);
    } else {
      console.error("Permintaan Gemini gagal karena kesalahan internal.");
    }
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch(() => {
    console.error("Permintaan Gemini gagal karena kesalahan internal.");
    process.exitCode = 1;
  });
}

module.exports = { main };
