/**
 * FluentEdge Whisper Speech Recognition Web Worker
 * Runs Whisper ONNX inference entirely off the main thread using @huggingface/transformers.
 * Provides ground-truth speech transcription with word-level timestamps and millisecond precision.
 *
 * Protocol:
 *   IN  { type: "init" }                                -> load model
 *   IN  { type: "transcribe", id, audioData }           -> transcribe Float32Array (16kHz)
 *   IN  { type: "cancel", id }                          -> cancel pending transcription
 *
 *   OUT { type: "ready", device }                       -> model ready
 *   OUT { type: "init_failed", message }                -> load error
 *   OUT { type: "progress", data }                      -> download progress
 *   OUT { type: "result", id, text, chunks }            -> transcription complete
 *   OUT { type: "error", id, message }                  -> transcription error
 *   OUT { type: "status", state, message }              -> status update
 */

"use strict";

let transcriber = null;
let isLoading = false;
let isReady = false;
let executionDevice = "wasm";

const cancelledIds = new Set();

function postStatus(state, message) {
  self.postMessage({ type: "status", state, message });
}

async function initModel() {
  if (isReady || isLoading) return;
  isLoading = true;
  postStatus("initializing", "Loading Whisper ASR model...");

  try {
    let pipeline, env;
    try {
      const mod = await import("https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.3.3/+esm");
      pipeline = mod.pipeline;
      env = mod.env;
    } catch (e1) {
      try {
        const mod = await import("https://esm.sh/@huggingface/transformers@3.3.3");
        pipeline = mod.pipeline;
        env = mod.env;
      } catch (e2) {
        throw new Error("Could not import Transformers.js from any CDN: " + e2.message);
      }
    }

    if (env) {
      env.allowLocalModels = false;
      env.useBrowserCache = true;
    }

    // Determine device (WebGPU if available, fallback to wasm)
    try {
      if (typeof navigator !== "undefined" && navigator.gpu) {
        const adapter = await navigator.gpu.requestAdapter();
        if (adapter) {
          executionDevice = "webgpu";
        }
      }
    } catch (gpuErr) {
      executionDevice = "wasm";
    }

    postStatus("initializing", "Fetching Whisper ONNX weights...");

    transcriber = await pipeline("automatic-speech-recognition", "onnx-community/whisper-tiny.en", {
      dtype: "q8",
      device: executionDevice,
      progress_callback: (progressData) => {
        self.postMessage({ type: "progress", data: progressData });
      }
    });

    isReady = true;
    isLoading = false;
    postStatus("ready", `Whisper AI Ready (${executionDevice.toUpperCase()})`);
    self.postMessage({ type: "ready", device: executionDevice });
    console.log(`[WhisperWorker] Whisper model ready on ${executionDevice}.`);
  } catch (err) {
    isLoading = false;
    console.error("[WhisperWorker] Init failed:", err);
    self.postMessage({ type: "init_failed", message: err.message });
  }
}

async function transcribe({ id, audioData }) {
  if (!isReady || !transcriber) {
    self.postMessage({ type: "error", id, message: "Whisper model not initialized yet." });
    return;
  }

  if (cancelledIds.has(id)) {
    cancelledIds.delete(id);
    return;
  }

  try {
    postStatus("transcribing", "Whisper analyzing speech cadence...");
    const output = await transcriber(audioData, {
      return_timestamps: "word",
      chunk_length_s: 30,
      stride_length_s: 5
    });

    if (cancelledIds.has(id)) {
      cancelledIds.delete(id);
      return;
    }

    self.postMessage({
      type: "result",
      id,
      text: output.text || "",
      chunks: Array.isArray(output.chunks) ? output.chunks : []
    });
  } catch (err) {
    console.error("[WhisperWorker] Transcription error:", err);
    self.postMessage({ type: "error", id, message: err.message });
  } finally {
    postStatus("ready", "Whisper AI Ready");
  }
}

self.onmessage = async (event) => {
  const msg = event.data;
  if (!msg) return;

  switch (msg.type) {
    case "init":
      await initModel();
      break;

    case "transcribe":
      await transcribe(msg);
      break;

    case "cancel":
      if (msg.id) cancelledIds.add(msg.id);
      break;

    default:
      break;
  }
};
