/**
 * FluentEdge Pre-rendered Audio Asset Generator
 * -----------------------------------------------
 * Generates lightweight WebM/Opus audio clips for all 2,136 C1/C2 vocabulary
 * words using Kokoro-82M ONNX, and writes them to audio/vocab/{voiceId}/*.webm
 *
 * Usage:
 *   node scripts/generate_audio.mjs [--voice bf_isabella] [--speed 0.85] [--resume]
 *
 * Options:
 *   --voice   Voice ID to generate (default: bf_isabella)
 *   --speed   Synthesis speed multiplier (default: 0.85)
 *   --resume  Skip words whose .webm file already exists
 *   --limit N Only generate the first N words (for testing)
 *
 * Requirements:
 *   npm install kokoro-js @xenova/transformers
 *   Node.js >= 18 (for fetch, fs/promises)
 *
 * Estimated runtime: 40-90 min for all 2,136 words at bf_isabella speed 0.85
 */

import { KokoroTTS } from "kokoro-js";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { createInterface } from "readline";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

// ─────────────────────────────────────────
// CLI Argument Parsing
// ─────────────────────────────────────────
const args = process.argv.slice(2);
const getArg = (flag, def) => {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : def;
};
const hasFlag = (flag) => args.includes(flag);

const VOICE_ID = getArg("--voice", "bf_isabella");
const SPEED = parseFloat(getArg("--speed", "0.85"));
const RESUME = hasFlag("--resume");
const LIMIT = parseInt(getArg("--limit", "0"), 10);

const OUT_DIR = join(ROOT, "audio", "vocab", VOICE_ID);

// ─────────────────────────────────────────
// Load Vocabulary Lexicon
// ─────────────────────────────────────────
function loadVocabulary() {
  const vocabPath = join(ROOT, "data", "vocabulary.csv");
  const csvText = readFileSync(vocabPath, "utf8");
  const lines = csvText.trim().split(/\r?\n/).slice(1); // skip header
  const words = [];

  for (const line of lines) {
    const cols = line.split(",");
    if (cols[0]) {
      words.push(cols[0].trim().toLowerCase());
    }
  }

  // Deduplicate
  return [...new Set(words)];
}

// ─────────────────────────────────────────
// Progress Bar Renderer
// ─────────────────────────────────────────
function renderProgress(done, total, word, skipped, errors) {
  const pct = Math.floor((done / total) * 100);
  const barLen = 40;
  const filled = Math.floor((done / total) * barLen);
  const bar = "█".repeat(filled) + "░".repeat(barLen - filled);
  const eta = done > 0 ? Math.round(((Date.now() - startTime) / done) * (total - done) / 1000) : "?";

  process.stdout.write(
    `\r[${bar}] ${pct}% | ${done}/${total} | "${word.padEnd(24)}" | skip:${skipped} err:${errors} | ETA: ${eta}s  `
  );
}

// ─────────────────────────────────────────
// Main
// ─────────────────────────────────────────
let startTime = Date.now();

async function main() {
  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log("║    FluentEdge Audio Asset Pre-generation Pipeline        ║");
  console.log("╚══════════════════════════════════════════════════════════╝\n");
  console.log(`  Voice:   ${VOICE_ID}`);
  console.log(`  Speed:   ${SPEED}x`);
  console.log(`  Output:  audio/vocab/${VOICE_ID}/`);
  console.log(`  Resume:  ${RESUME ? "Yes (skip existing)" : "No (regenerate all)"}`);
  console.log();

  // Load vocabulary
  let words = loadVocabulary();
  if (LIMIT > 0) {
    words = words.slice(0, LIMIT);
    console.log(`  Limit:   First ${LIMIT} words only`);
  }
  console.log(`  Words:   ${words.length} total\n`);

  // Ensure output directory
  mkdirSync(OUT_DIR, { recursive: true });

  // Initialize Kokoro
  console.log("  Loading Kokoro-82M ONNX model (q8 quantized)...");
  startTime = Date.now();

  const kokoro = await KokoroTTS.from_pretrained("onnx-community/Kokoro-82M-v1.0-ONNX", {
    dtype: "q8",
    device: "cpu" // Node.js uses CPU; no WebGPU/WASM in this context
  });

  const loadTime = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`  Model loaded in ${loadTime}s\n`);
  console.log("  Generating audio...\n");

  startTime = Date.now();
  let done = 0;
  let skipped = 0;
  let errors = 0;

  for (const word of words) {
    const outPath = join(OUT_DIR, `${word}.webm`);

    if (RESUME && existsSync(outPath)) {
      done++;
      skipped++;
      renderProgress(done, words.length, word, skipped, errors);
      continue;
    }

    try {
      const result = await kokoro.generate(word, {
        voice: VOICE_ID,
        speed: SPEED
      });

      // result.toBlob() returns a Blob — in Node we need ArrayBuffer
      const arrayBuffer = await result.toBlob().arrayBuffer();
      writeFileSync(outPath, Buffer.from(arrayBuffer));
    } catch (err) {
      errors++;
      // Write empty sentinel to avoid retrying broken words
      console.error(`\n  [ERROR] "${word}": ${err.message}`);
    }

    done++;
    renderProgress(done, words.length, word, skipped, errors);
  }

  const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  const generated = done - skipped - errors;

  console.log("\n\n  ✓ Done!\n");
  console.log(`  Generated:  ${generated} new files`);
  console.log(`  Skipped:    ${skipped} (already existed)`);
  console.log(`  Errors:     ${errors}`);
  console.log(`  Total time: ${elapsed} min`);
  console.log(`  Output dir: ${OUT_DIR}\n`);
}

main().catch(err => {
  console.error("\n[FATAL]", err);
  process.exit(1);
});
