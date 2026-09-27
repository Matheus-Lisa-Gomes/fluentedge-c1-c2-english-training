# FluentEdge Pre-rendered Vocabulary Audio Assets

This directory contains lightweight **WebM/Opus** audio clips pre-generated from the
Kokoro-82M ONNX neural TTS model for instant 0ms playback of all 2,136 C1/C2 vocabulary words.

## Directory Structure

```
audio/
  vocab/
    bf_isabella/   <- UK Female (default, pre-generated)
      abandon.webm
      aberration.webm
      ...
    bm_fable/      <- UK Male (synthesized on-demand via Worker, cached in IndexedDB)
    af_heart/      <- US Female (synthesized on-demand via Worker, cached in IndexedDB)
    am_michael/    <- US Male (synthesized on-demand via Worker, cached in IndexedDB)
```

## Generating the Audio

Run the pre-generation script with Node.js >= 18:

```powershell
# Install dependencies (one-time)
npm install kokoro-js

# Generate bf_isabella (default voice) — ~150MB, 40-90 min runtime
node scripts/generate_audio.mjs --voice bf_isabella --speed 0.85

# Resume an interrupted generation (skips already-generated files)
node scripts/generate_audio.mjs --voice bf_isabella --resume

# Test with first 10 words only
node scripts/generate_audio.mjs --voice bf_isabella --limit 10
```

## Playback Strategy

1. **Click** -> instant tactile feedback (Web Audio API click, ~5ms)
2. **Static fetch** `audio/vocab/bf_isabella/{word}.webm` (0ms from HTTP cache on repeat)
3. **Fallback** -> Kokoro Worker synthesizes on-demand for non-Isabella voices, caches in IndexedDB
