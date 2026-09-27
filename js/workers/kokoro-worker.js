/**
 * FluentEdge Kokoro Neural TTS Web Worker
 * Runs Kokoro-82M ONNX inference entirely off the main thread.
 * All AI matrix computations execute here, guaranteeing 60 FPS UI.
 *
 * Protocol:
 *   IN  { type: "init" }                                   -> load model
 *   IN  { type: "synthesize", id, text, voiceId, speed }   -> synthesize
 *   IN  { type: "cancel", id }                             -> abort pending
 *
 *   OUT { type: "ready" }                                  -> model loaded
 *   OUT { type: "init_failed", message }                   -> load error
 *   OUT { type: "audio", id, blob, voiceId, text }         -> synthesis done
 *   OUT { type: "error", id, message }                     -> synthesis error
 *   OUT { type: "status", state, message }                 -> status update
 */

"use strict";

let kokoroInstance = null;
let isLoading = false;
let isReady = false;

// LRU in-worker audio blob cache
const audioCache = new Map();
const CACHE_MAX = 120;

// Cancelled request IDs
const cancelledIds = new Set();

// -------------------------------------------------
// Model Initialisation
// -------------------------------------------------
async function initModel() {
  if (isReady || isLoading) return;
  isLoading = true;
  postStatus("initializing", "Loading Kokoro neural model in Worker...");

  try {
    let KokoroTTS;
    try {
      const mod = await import("https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/+esm");
      KokoroTTS = mod.KokoroTTS;
    } catch (e1) {
      try {
        const mod = await import("https://esm.sh/kokoro-js@1.2.1");
        KokoroTTS = mod.KokoroTTS;
      } catch (e2) {
        throw new Error("Could not import KokoroTTS from any CDN: " + e2.message);
      }
    }

    postStatus("initializing", "Fetching ONNX weights...");
    kokoroInstance = await KokoroTTS.from_pretrained("onnx-community/Kokoro-82M-v1.0-ONNX", {
      dtype: "q8",
      device: "wasm"
    });

    isReady = true;
    isLoading = false;
    postStatus("ready", "Kokoro Neural (Worker)");
    self.postMessage({ type: "ready" });
    console.log("[KokoroWorker] Model ready.");
  } catch (err) {
    isLoading = false;
    console.error("[KokoroWorker] Init failed:", err);
    self.postMessage({ type: "init_failed", message: err.message });
  }
}

// -------------------------------------------------
// Synthesis
// -------------------------------------------------
async function synthesize({ id, text, voiceId, speed }) {
  if (!isReady || !kokoroInstance) {
    self.postMessage({ type: "error", id, message: "Model not ready yet." });
    return;
  }

  const cacheKey = `${voiceId}_${speed.toFixed(2)}_${text.toLowerCase().trim()}`;

  if (audioCache.has(cacheKey)) {
    const blob = audioCache.get(cacheKey);
    self.postMessage({ type: "audio", id, blob, voiceId, text });
    return;
  }

  if (cancelledIds.has(id)) {
    cancelledIds.delete(id);
    return;
  }

  try {
    postStatus("synthesizing", "Synthesising...");
    const result = await kokoroInstance.generate(text.toLowerCase().trim(), {
      voice: voiceId,
      speed
    });

    if (cancelledIds.has(id)) {
      cancelledIds.delete(id);
      postStatus("ready", "Kokoro Neural (Worker)");
      return;
    }

    const blob = result.toBlob();

    if (audioCache.size >= CACHE_MAX) {
      const firstKey = audioCache.keys().next().value;
      audioCache.delete(firstKey);
    }
    audioCache.set(cacheKey, blob);

    postStatus("ready", "Kokoro Neural (Worker)");
    self.postMessage({ type: "audio", id, blob, voiceId, text });
  } catch (err) {
    postStatus("ready", "Kokoro Neural (Worker)");
    self.postMessage({ type: "error", id, message: err.message });
  }
}

function postStatus(state, message) {
  self.postMessage({ type: "status", state, message });
}

self.onmessage = async (event) => {
  const msg = event.data;
  if (!msg || !msg.type) return;

  switch (msg.type) {
    case "init":
      await initModel();
      break;
    case "synthesize":
      await synthesize(msg);
      break;
    case "cancel":
      if (msg.id) cancelledIds.add(msg.id);
      break;
    default:
      console.warn("[KokoroWorker] Unknown message:", msg.type);
  }
};
