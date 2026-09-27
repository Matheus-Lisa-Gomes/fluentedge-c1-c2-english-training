/**
 * FluentEdge Speaking & Pronunciation Evaluation Engine
 * Uses Web Speech Recognition for live spoken analysis,
 * Web Speech Synthesis for native British English model pronunciation,
 * Web Audio API for real-time waveform visualization,
 * and a dedicated Kokoro ONNX Web Worker (off-main-thread neural TTS)
 * with a static pre-rendered audio asset fast-path for 0ms vocab playback.
 */

export class SpeechEngine {
  constructor() {
    this.recognition = null;
    this.synth = window.speechSynthesis || null;
    this.audioContext = null;
    this.analyser = null;
    this.mediaStream = null;
    this.visualizerAnimationId = null;

    this.isListening = false;
    this.isSpeakingModel = false;
    this.startTime = null;
    this.elapsedSeconds = 0;
    this.durationInterval = null;

    this.targetTokens = []; // Array of word objects { text, clean, status: 'pending'|'matched'|'deviation'|'omitted' }
    this.spokenTranscripts = [];
    this.currentWordIndex = 0;
    this.confirmedWordIndex = 0;
    this.beaconIndex = 0;

    // Kokoro Neural TTS & Multi-Voice Engine State
    this.currentVoiceId = 'af_heart'; // Default: US English Female (Heart: Feminine & Mellow)
    this.currentAccent = 'us';       // 'uk' | 'us'
    this.currentGender = 'female';   // 'female' | 'male'
    this.engineMode = 'neural';      // 'neural' | 'native'
    try {
      this.engineMode = localStorage.getItem('fluentedge_engine_mode') || 'neural';
    } catch(e) {}
    this.kokoro = null;
    this.kokoroLoading = false;
    this.isKokoroReady = false;
    this.currentAudio = null;
    this.effectsAudioContext = null;
    this.audioCache = new Map();
    this.warmedVoices = new Set();
    this.isPrecaching = false;
    this.vocabPrecacheList = [];

    // ── Phase 1: Web Worker Offload ────────────────────────────────
    // kokoro-worker.js runs all ONNX inference off the main thread.
    // Messages follow the { type, id, ... } protocol defined in the worker.
    this.worker = null;
    this.workerReady = false;
    this.workerLoading = false;
    this._workerPending = new Map(); // requestId → { resolve, reject, onStart }
    this._workerReqId = 0;

    // ── Phase 1: Static Pre-rendered Audio Asset Fast-Path ──────────
    // Try fetching audio/vocab/{voiceId}/{word}.webm before synthesis.
    // Resolve the base URL relative to the current page origin.
    this.staticAudioBase = (() => {
      try {
        // Works for both http://localhost and file://
        const base = window.location.href.replace(/\/[^/]*$/, '');
        return `${base}/audio/vocab`;
      } catch (e) {
        return './audio/vocab';
      }
    })();

    // ── Phase 1: IndexedDB Audio Cache ─────────────────────────────
    // Persists Worker-synthesized blobs so non-Isabella voices are
    // instant on the second click (cleared only by user clearing site data).
    this._idb = null;
    this._idbReady = false;
    this.initIndexedDB();

    // ── Phase 1: Tactile Click Sound ───────────────────────────────
    // Tiny synthesized 'tap' played at t=0 so the button feels instant.
    this._clickBuffer = null; // Lazy-created on first use

    // Callbacks
    this.onWordUpdate = null;
    this.onStateChange = null;
    this.onMetricsUpdate = null;
    this.onError = null;
    this.onEngineStatusChange = null;
    this.onVoiceChange = null;

    this.initRecognition();
  }

  isSpeechSupported() {
    return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
  }

  initRecognition() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      console.warn("SpeechRecognition API not available in this browser.");
      return;
    }

    this.recognition = new SpeechRecognition();
    this.recognition.continuous = true;
    this.recognition.interimResults = true;
    this.recognition.maxAlternatives = 1;
    this.recognition.lang = this.currentAccent === 'uk' ? 'en-GB' : 'en-US';

    this.recognition.onstart = () => {
      this.isListening = true;
      this.startTime = Date.now();
      this.startDurationTracker();
      if (this.onStateChange) this.onStateChange({ status: 'recording' });
    };

    this.recognition.onresult = (event) => {
      let finalChunk = '';
      let interimChunk = '';

      for (let i = event.resultIndex; i < event.results.length; ++i) {
        const transcript = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          finalChunk += transcript + ' ';
        } else {
          interimChunk += transcript;
        }
      }

      if (finalChunk.trim()) {
        this.processSpokenSpeech(finalChunk.trim(), true);
      }
      if (interimChunk.trim()) {
        this.processSpokenSpeech(interimChunk.trim(), false);
      }
    };

    this.recognition.onerror = (event) => {
      console.error("Speech recognition error:", event.error);
      if (event.error === 'no-speech') {
        // Natural pause in speech while reading; do not terminate session
        return;
      }
      if (event.error === 'not-allowed') {
        if (this.onError) this.onError("Microphone permission denied. Please allow microphone access in your browser settings.");
      } else if (event.error === 'network') {
        if (this.onError) this.onError("Speech recognition network error. Note: Brave and Firefox block cloud speech recognition; please use Google Chrome or Microsoft Edge.");
      } else if (event.error === 'audio-capture') {
        if (this.onError) this.onError("Microphone capture failed. Ensure your microphone is connected and not locked by another application.");
      }
      this.stopListening();
    };

    this.recognition.onend = () => {
      // If recognition paused automatically (e.g., brief silence) while session is active, restart it
      if (this.isListening) {
        try {
          this.recognition.start();
          return;
        } catch (e) {
          // If restart fails, proceed to clean teardown
        }
      }
      this.isListening = false;
      this.stopDurationTracker();
      this.stopAudioVisualizer();
      if (this.onStateChange) this.onStateChange({ status: 'idle' });
    };
  }

  // ================================================================
  // PHASE 1: WEB WORKER OFFLOAD
  // ================================================================

  /**
   * Initialise the Kokoro ONNX Web Worker.
   * Called once when neural mode is activated for the first time.
   * The Worker loads the model in its own thread — zero main-thread CPU.
   */
  initWorker() {
    if (this.worker || this.workerLoading) return;
    this.workerLoading = true;

    try {
      this.worker = new Worker('./js/workers/kokoro-worker.js');
    } catch (e) {
      // Worker constructor can fail on some file:// environments;
      // gracefully degrade to legacy main-thread Kokoro path.
      console.warn('[SpeechEngine] Could not create Worker:', e);
      this.workerLoading = false;
      return;
    }

    this.worker.onmessage = (event) => {
      const msg = event.data;
      if (!msg) return;

      switch (msg.type) {
        case 'ready':
          this.workerReady = true;
          this.workerLoading = false;
          this.isKokoroReady = true;
          this.updateEngineStatus(
            this.engineMode === 'neural' ? 'ready' : 'fallback',
            this.engineMode === 'neural' ? 'Kokoro Neural (Worker)' : 'Fast Native (0ms)'
          );
          break;

        case 'init_failed':
          this.workerLoading = false;
          this.workerReady = false;
          console.warn('[SpeechEngine] Worker init failed:', msg.message);
          // Fall back to legacy main-thread Kokoro
          this.initKokoroLegacy();
          break;

        case 'audio': {
          // Resolve the pending synthesis promise with the returned blob
          const pending = this._workerPending.get(msg.id);
          if (pending) {
            this._workerPending.delete(msg.id);
            pending.resolve(msg.blob);
          }
          break;
        }

        case 'error': {
          const pending = this._workerPending.get(msg.id);
          if (pending) {
            this._workerPending.delete(msg.id);
            pending.reject(new Error(msg.message));
          }
          break;
        }

        case 'status':
          // Propagate Worker status messages to the UI engine indicator
          if (msg.state !== 'synthesizing' || !this.workerReady) {
            this.updateEngineStatus(msg.state, msg.message);
          }
          break;

        default:
          break;
      }
    };

    this.worker.onerror = (err) => {
      console.error('[SpeechEngine] Worker error:', err);
      this.workerLoading = false;
      this.workerReady = false;
    };

    // Tell the Worker to start loading the model
    this.worker.postMessage({ type: 'init' });
  }

  /**
   * Synthesise text via the off-thread Worker.
   * Returns a Promise<Blob> that resolves when the Worker is done.
   */
  _workerSynthesize(text, voiceId, speed) {
    return new Promise((resolve, reject) => {
      if (!this.worker || !this.workerReady) {
        reject(new Error('Worker not ready'));
        return;
      }
      const id = ++this._workerReqId;
      this._workerPending.set(id, { resolve, reject });
      this.worker.postMessage({ type: 'synthesize', id, text, voiceId, speed });
    });
  }

  // ================================================================
  // PHASE 1: INDEXEDDB AUDIO CACHE
  // ================================================================

  /**
   * Open (or create) the IndexedDB database for persisting synthesized audio blobs.
   * Non-Isabella voices are expensive to synthesize; IDB ensures instant repeat clicks.
   */
  initIndexedDB() {
    if (!window.indexedDB) return;
    try {
      const req = indexedDB.open('fluentedge-audio', 1);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('vocab-audio')) {
          db.createObjectStore('vocab-audio');
        }
      };
      req.onsuccess = (e) => {
        this._idb = e.target.result;
        this._idbReady = true;
      };
      req.onerror = () => {
        // IDB unavailable (e.g. private mode Firefox); silently skip caching
        this._idbReady = false;
      };
    } catch (e) {
      this._idbReady = false;
    }
  }

  /** Read a Blob from IndexedDB by key. Returns Promise<Blob|null>. */
  _idbGet(key) {
    return new Promise((resolve) => {
      if (!this._idbReady || !this._idb) { resolve(null); return; }
      try {
        const tx = this._idb.transaction('vocab-audio', 'readonly');
        const req = tx.objectStore('vocab-audio').get(key);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
      } catch (e) { resolve(null); }
    });
  }

  /** Write a Blob to IndexedDB. Fire-and-forget. */
  _idbSet(key, blob) {
    if (!this._idbReady || !this._idb) return;
    try {
      const tx = this._idb.transaction('vocab-audio', 'readwrite');
      tx.objectStore('vocab-audio').put(blob, key);
    } catch (e) { /* silent */ }
  }

  // ================================================================
  // PHASE 1: STATIC ASSET FAST-PATH
  // ================================================================

  /**
   * Attempt to fetch a pre-rendered static .webm from audio/vocab/{voiceId}/{word}.webm
   * Returns a Blob on success, null on 404 or network error.
   */
  async _fetchStaticAudio(word, voiceId) {
    const safe = word.toLowerCase().replace(/[^a-z0-9-]/g, '');
    if (!safe) return null;
    const url = `${this.staticAudioBase}/${voiceId}/${safe}.webm`;
    try {
      const resp = await fetch(url, { method: 'GET', cache: 'force-cache' });
      if (resp.ok) {
        return await resp.blob();
      }
      return null;
    } catch (e) {
      return null;
    }
  }

  // ================================================================
  // PHASE 1: TACTILE CLICK SOUND
  // ================================================================

  /**
   * Play a soft, instantaneous 'tap' click sound so the button feels
   * responsive before the neural audio arrives.
   * Uses Web Audio API so latency is sub-5ms regardless of OS audio stack.
   */
  playTactileClick() {
    try {
      // Lazily create (or reuse) a shared AudioContext for UI sounds
      if (!this.effectsAudioContext || this.effectsAudioContext.state === 'closed') {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtx) return;
        this.effectsAudioContext = new AudioCtx();
      }
      const ctx = this.effectsAudioContext;
      if (ctx.state === 'suspended') ctx.resume();

      // Synthesise a short, gentle click envelope in-band (no file fetch)
      // Decays from 0.18 to 0 over 45ms — sounds like a soft mechanical key press
      const bufLen = Math.floor(ctx.sampleRate * 0.045);
      if (!this._clickBuffer || this._clickBuffer.length !== bufLen) {
        this._clickBuffer = ctx.createBuffer(1, bufLen, ctx.sampleRate);
        const data = this._clickBuffer.getChannelData(0);
        for (let i = 0; i < bufLen; i++) {
          const t = i / bufLen;
          // White noise × exponential decay
          data[i] = (Math.random() * 2 - 1) * 0.18 * Math.exp(-t * 28);
        }
      }

      const src = ctx.createBufferSource();
      src.buffer = this._clickBuffer;

      // Apply gentle high-pass to keep it crisp, not boomy
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 800;

      const gain = ctx.createGain();
      gain.gain.value = 0.55;

      src.connect(hp);
      hp.connect(gain);
      gain.connect(ctx.destination);
      src.start();
    } catch (e) {
      // Non-critical — silently skip if Web Audio unavailable
    }
  }

  // ================================================================
  // PHASE 1: HYBRID VOCAB PLAYBACK  (speakVocabWord)
  // ================================================================

  /**
   * Play pronunciation audio for a vocabulary word using the 3-tier hybrid pipeline:
   *
   *   Tier 1 (0ms)      – Tactile click feedback via Web Audio API
   *   Tier 2 (instant)  – Pre-rendered static .webm asset (HTTP cache)
   *   Tier 3 (fallback) – Kokoro Worker synthesis → IndexedDB cache → play
   *
   * @param {string}   word           - The vocabulary headword to pronounce
   * @param {number}   [speed=0.85]   - Synthesis speed for Worker fallback
   * @param {Function} [onStart]      - Called when audio actually starts playing
   * @param {Function} [onEnd]        - Called when audio finishes
   */
  async speakVocabWord(word, speed = 0.85, onStart = null, onEnd = null) {
    if (!word) return;
    const cleanWord = word.trim();
    const voiceId = this.currentVoiceId;
    const isMale = this.currentGender === 'male';
    const effectiveSpeed = isMale ? speed * 0.94 : speed * 0.96;
    const idbKey = `${voiceId}_${cleanWord.toLowerCase()}`;

    // ── Tier 1: Instant tactile feedback ───────────────────────────
    this.playTactileClick();

    // ── Tier 2: Static pre-rendered asset (bf_isabella only) ────────
    // For non-Isabella voices, jump straight to Tier 3 (Worker)
    let blob = null;

    if (voiceId === 'bf_isabella') {
      blob = await this._fetchStaticAudio(cleanWord, voiceId);
    }

    // ── Check IndexedDB cache for any voice ─────────────────────────
    if (!blob) {
      blob = await this._idbGet(idbKey);
    }

    // ── Tier 3: Worker synthesis → IDB cache ───────────────────────
    if (!blob) {
      if (this.workerReady) {
        try {
          blob = await this._workerSynthesize(cleanWord, voiceId, effectiveSpeed);
          if (blob) this._idbSet(idbKey, blob); // persist for next time
        } catch (workerErr) {
          console.warn('[SpeechEngine] Worker synthesis failed, falling back to legacy:', workerErr);
        }
      } else if (this.isKokoroReady && this.kokoro) {
        // Legacy main-thread Kokoro fallback (when Worker unavailable)
        try {
          const result = await this.kokoro.generate(cleanWord.toLowerCase(), {
            voice: voiceId,
            speed: effectiveSpeed
          });
          blob = result.toBlob();
          if (blob) this._idbSet(idbKey, blob);
        } catch (e) { /* fall through to SpeechSynthesis */ }
      }
    }

    // ── Play the resolved blob ─────────────────────────────────────
    if (blob) {
      this._playBlob(blob, isMale, onStart, onEnd);
    } else {
      // Ultimate fallback: browser native SpeechSynthesis
      this.speakTextBrowserFallback(cleanWord, speed, onEnd, onStart);
    }
  }

  /**
   * Internal helper: play a Blob as audio with acoustic filter applied.
   */
  _playBlob(blob, isMale, onStart, onEnd) {
    this.stopSpeakingModel();
    this.isSpeakingModel = true;

    const audioUrl = URL.createObjectURL(blob);
    const audio = new Audio(audioUrl);
    this.currentAudio = audio;
    this.applyAcousticFilter(audio, isMale);

    audio.oncanplaythrough = () => {
      if (onStart) onStart();
      if (this.onStateChange) this.onStateChange({ status: 'model_speaking' });
    };

    audio.onended = () => {
      this.isSpeakingModel = false;
      URL.revokeObjectURL(audioUrl);
      this.currentAudio = null;
      if (onEnd) onEnd();
      if (this.onStateChange) this.onStateChange({ status: 'idle' });
    };

    audio.onerror = () => {
      URL.revokeObjectURL(audioUrl);
      this.currentAudio = null;
      this.isSpeakingModel = false;
      if (onEnd) onEnd();
    };

    audio.play().catch(() => {
      URL.revokeObjectURL(audioUrl);
      this.currentAudio = null;
      this.isSpeakingModel = false;
      if (onEnd) onEnd();
    });
  }

  /**
   * Set target essay text to be read aloud
   */
  setTargetText(text) {
    // Break into tokens while preserving original casing and punctuation for display
    const rawWords = text.trim().split(/\s+/);
    this.targetTokens = rawWords.map((word, idx) => ({
      index: idx,
      text: word,
      clean: word.toLowerCase().replace(/[^a-z0-9]/g, ''),
      status: 'pending' // 'pending' | 'matched' | 'deviation' | 'omitted'
    })).filter(w => w.clean.length > 0);

    this.currentWordIndex = 0;
    this.confirmedWordIndex = 0;
    this.beaconIndex = 0;
    this.spokenTranscripts = [];
    this.elapsedSeconds = 0;

    // Phase 2: JSGF Grammar Biasing (SpeechGrammarList)
    // Biases cloud ASR acoustic decoder beam search with the essay's exact vocabulary,
    // dramatically accelerating confidence convergence on polysyllabic C1/C2 terms.
    const SpeechGrammarList = window.SpeechGrammarList || window.webkitSpeechGrammarList;
    if (SpeechGrammarList) {
      try {
        if (!this.recognition) this.initRecognition();
        const uniqueWords = Array.from(new Set(this.targetTokens.map(t => t.clean))).filter(w => w.length > 1);
        if (uniqueWords.length > 0 && this.recognition) {
          const grammar = `#JSGF V1.0 UTF-8; grammar essayWords; public <word> = ${uniqueWords.join(' | ')} ;`;
          const speechRecognitionList = new SpeechGrammarList();
          speechRecognitionList.addFromString(grammar, 1.0);
          this.recognition.grammars = speechRecognitionList;
        }
      } catch (e) {
        // SpeechGrammarList is optional across some browser configurations; gracefully continue
      }
    }
  }

  /**
   * Align spoken stream with target tokens
   */
  /**
   * Align spoken stream with target tokens with fast-speech lookahead and interim stability
   * @param {string} spokenText - raw transcript text
   * @param {boolean} isFinal - whether this chunk has been finalized by ASR
   */
  processSpokenSpeech(spokenText, isFinal = false) {
    const spokenWords = spokenText.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim().split(/\s+/);
    if (!spokenWords.length) return;

    // Fast-speech contraction / variant normalization
    const expandWord = (w) => {
      const map = {
        'cant': 'cannot',
        'wont': 'will not',
        'dont': 'do not',
        'didnt': 'did not',
        'isnt': 'is not',
        'arent': 'are not',
        'wasnt': 'was not',
        'werent': 'were not',
        'gonna': 'going to',
        'wanna': 'want to',
        'ive': 'i have',
        'youve': 'you have',
        'weve': 'we have',
        'theyve': 'they have',
        'im': 'i am',
        'youre': 'you are',
        'theyre': 'they are',
        'heres': 'here is',
        'theres': 'there is',
        'whats': 'what is',
        'couldnt': 'could not',
        'shouldnt': 'should not',
        'wouldnt': 'would not'
      };
      return map[w] || w;
    };

    // For interim evaluation: reset tokens from confirmedWordIndex back to pending
    // so provisional updates don't falsely lock tokens or trigger phantom omissions
    if (!isFinal) {
      for (let i = this.confirmedWordIndex; i < this.targetTokens.length; i++) {
        if (this.targetTokens[i].status !== 'pending') {
          this.targetTokens[i].status = 'pending';
        }
      }
    }

    let targetIdx = this.confirmedWordIndex;

    // Common stopwords that must NEVER trigger forward leaps
    const STOP_WORDS = new Set([
      'the', 'a', 'an', 'and', 'or', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by',
      'is', 'it', 'as', 'be', 'are', 'was', 'were', 'that', 'this', 'from', 'but', 'not', 'its'
    ]);
    const isStopWord = (w) => STOP_WORDS.has(w) || w.length <= 2;

    for (let sIdx = 0; sIdx < spokenWords.length; sIdx++) {
      if (targetIdx >= this.targetTokens.length) break;

      const rawSpoken = spokenWords[sIdx];
      const spokenWord = expandWord(rawSpoken);
      const targetWord = this.targetTokens[targetIdx];
      const similarity = calculateWordSimilarity(spokenWord, targetWord.clean);

      const isDirectMatch = similarity >= 0.82;
      const isPrefixMatch = (spokenWord.length >= 3 && targetWord.clean.startsWith(spokenWord)) ||
                            (targetWord.clean.length >= 4 && spokenWord.startsWith(targetWord.clean.slice(0, 3)));

      // Direct match or fast-speech word-onset prefix snap
      if (isDirectMatch || isPrefixMatch) {
        targetWord.status = 'matched';
        targetIdx++;
      } else if (similarity >= 0.55 && !isStopWord(spokenWord)) {
        // Minor phoneme / accent inflection deviation on content words
        targetWord.status = 'deviation';
        targetIdx++;
      } else {
        // Beacon Milestone Jump with Precision Guard:
        // Stopwords (the, a, in, is...) can only leap 1 word ahead.
        // Distinctive content words (length >= 4) can leap up to 6 words (one clause).
        let foundAhead = false;
        const allowedHorizon = isStopWord(spokenWord) ? 1 : 6;
        const maxLookahead = Math.min(allowedHorizon, this.targetTokens.length - targetIdx - 1);

        for (let lookahead = 1; lookahead <= maxLookahead; lookahead++) {
          const aheadWord = this.targetTokens[targetIdx + lookahead];
          const aheadSim = calculateWordSimilarity(spokenWord, aheadWord.clean);
          const isAheadPrefix = (spokenWord.length >= 4 && aheadWord.clean.startsWith(spokenWord));

          // Distinctive match threshold
          const threshold = lookahead === 1 ? 0.80 : 0.84;

          if (aheadSim >= threshold || isAheadPrefix) {
            // Valid milestone match found up front!
            if (isFinal) {
              for (let k = 0; k < lookahead; k++) {
                if (this.targetTokens[targetIdx + k].status === 'pending') {
                  this.targetTokens[targetIdx + k].status = 'omitted';
                }
              }
            }
            aheadWord.status = (aheadSim >= 0.82 || isAheadPrefix) ? 'matched' : 'deviation';
            targetIdx = targetIdx + lookahead + 1;
            foundAhead = true;
            break;
          }
        }

        // If not found ahead, check if this is an accidental repetition/stumble of the immediately previous token
        if (!foundAhead && targetIdx > 0) {
          const prevToken = this.targetTokens[targetIdx - 1];
          if (calculateWordSimilarity(spokenWord, prevToken.clean) >= 0.82) {
            // User repeated previous word (natural fast-speech stumble) - ignore without advancing or penalizing
            continue;
          }
        }
      }
    }

    this.currentWordIndex = Math.min(targetIdx, this.targetTokens.length);
    if (isFinal) {
      this.confirmedWordIndex = this.currentWordIndex;
    }
    // Beacon tracks the furthest forward milestone reached in the discourse
    this.beaconIndex = Math.max(this.beaconIndex || 0, this.currentWordIndex);

    // Calculate real-time metrics
    const matchedCount = this.targetTokens.filter(t => t.status === 'matched').length;
    const deviationCount = this.targetTokens.filter(t => t.status === 'deviation').length;
    const totalAttempted = Math.max(1, this.currentWordIndex);
    const accuracy = Math.round(((matchedCount + deviationCount * 0.7) / totalAttempted) * 100);

    // Speed (WPM) is measured by the beacon's forward progress through the discourse
    const minutes = Math.max(0.05, this.elapsedSeconds / 60);
    const discourseWords = Math.max(this.beaconIndex || 0, matchedCount + deviationCount);
    const wpm = Math.round(discourseWords / minutes);

    if (this.onWordUpdate) {
      this.onWordUpdate({
        tokens: this.targetTokens,
        currentIndex: this.currentWordIndex,
        matchedCount,
        deviationCount,
        accuracy,
        wpm,
        elapsedSeconds: this.elapsedSeconds
      });
    }
  }

  async startListening(canvasElement) {
    if (!this.isSpeechSupported()) {
      if (this.onError) this.onError("Your browser does not support Speech Recognition. Try Chrome, Edge, or Safari.");
      return;
    }

    if (this.isListening) return;

    try {
      if (!this.recognition) {
        this.initRecognition();
      }
      this.recognition.start();
      // Start visualizer non-blockingly with micro-delay so speech recognition grabs audio driver first
      if (canvasElement) {
        setTimeout(() => {
          if (this.isListening) {
            this.startAudioVisualizer(canvasElement).catch(err => {
              console.warn("Visualizer optional mic stream error:", err);
            });
          }
        }, 60);
      }
    } catch (err) {
      if (err.name !== 'InvalidStateError') {
        console.error("Failed to start speech recognition:", err);
        if (this.onError) this.onError("Could not start microphone: " + err.message);
      }
    }
  }

  stopListening() {
    if (this.recognition && this.isListening) {
      try {
        this.recognition.stop();
      } catch (e) {
        // ignore
      }
    }
    this.isListening = false;
    this.stopDurationTracker();
    this.stopAudioVisualizer();
  }

  startDurationTracker() {
    this.stopDurationTracker();
    this.durationInterval = setInterval(() => {
      this.elapsedSeconds++;
      if (this.onMetricsUpdate) {
        const minutes = Math.max(0.05, this.elapsedSeconds / 60);
        const matchedCount = this.targetTokens.filter(t => t.status === 'matched').length;
        const deviationCount = this.targetTokens.filter(t => t.status === 'deviation').length;
        const discourseWords = Math.max(this.beaconIndex || 0, matchedCount + deviationCount);
        const wpm = Math.round(discourseWords / minutes);
        this.onMetricsUpdate({ elapsedSeconds: this.elapsedSeconds, wpm });
      }
    }, 1000);
  }

  stopDurationTracker() {
    if (this.durationInterval) {
      clearInterval(this.durationInterval);
      this.durationInterval = null;
    }
  }

  /**
   * Final C1/C2 Speaking Assessment based on recorded performance
   */
  getFinalSpeakingAssessment() {
    const totalWords = this.targetTokens.length;
    const matchedCount = this.targetTokens.filter(t => t.status === 'matched').length;
    const deviationCount = this.targetTokens.filter(t => t.status === 'deviation').length;
    const omittedCount = this.targetTokens.filter(t => t.status === 'omitted').length;
    const readRatio = totalWords > 0 ? (Math.max((matchedCount + deviationCount), (this.beaconIndex || 0)) / totalWords) : 0;

    const minutes = Math.max(0.1, this.elapsedSeconds / 60);
    const discourseWords = Math.max(this.beaconIndex || 0, matchedCount + deviationCount);
    const wpm = Math.round(discourseWords / minutes);

    // Accuracy %
    const pronunciationAccuracy = totalWords > 0 
      ? Math.min(100, Math.round(((matchedCount + (deviationCount * 0.65)) / totalWords) * 100))
      : 0;

    // CEFR Speaking Scales (0-5)
    // 1. Pronunciation (Individual sounds, stress, intelligibility)
    let pronunciationScore = 5.0;
    const pronunciationFeedback = [];
    if (pronunciationAccuracy >= 90) {
      pronunciationScore = 5.0;
      pronunciationFeedback.push("Exceptional phonological precision and phonemic clarity across polysyllabic vocabulary.");
    } else if (pronunciationAccuracy >= 78) {
      pronunciationScore = 4.2;
      pronunciationFeedback.push("Clear intelligibility with natural intonation. Minor phoneme deviations did not impede comprehension.");
    } else if (pronunciationAccuracy >= 65) {
      pronunciationScore = 3.2;
      pronunciationFeedback.push("Noticeable accent interference or slurred word endings on complex C1 terms. Requires stress pattern practice.");
    } else {
      pronunciationScore = 2.0;
      pronunciationFeedback.push("Frequent mispronunciations or omitted clauses requiring deliberate articulation practice.");
    }

    // 2. Fluency & Discourse Speed (C1/C2 Target: 130 - 160 WPM)
    let fluencyScore = 5.0;
    const fluencyFeedback = [];
    if (wpm >= 130 && wpm <= 165) {
      fluencyScore = 5.0;
      fluencyFeedback.push(`Optimal native-speed pacing at ${wpm} WPM with confident, uninterrupted delivery.`);
    } else if ((wpm >= 110 && wpm < 130) || (wpm > 165 && wpm <= 185)) {
      fluencyScore = 4.0;
      fluencyFeedback.push(`Acceptable speaking rate (${wpm} WPM). Aim for consistent 135-150 WPM cadence with natural thought-group pauses.`);
    } else if (wpm < 110) {
      fluencyScore = 3.0;
      fluencyFeedback.push(`Hesitant pace (${wpm} WPM). Work on smooth transitional phrasing to minimize unnatural pauses.`);
    } else {
      fluencyScore = 3.5;
      fluencyFeedback.push(`Rushed pace (${wpm} WPM). Slow down slightly to emphasize rhetorical stress on key academic vocabulary.`);
    }

    // 3. Completion & Discourse Management
    let discourseScore = 5.0;
    const discourseFeedback = [];
    if (readRatio >= 0.90) {
      discourseScore = 5.0;
      discourseFeedback.push("Completed reading full text with coherent rhythm, thought-group boundaries, and steady lung-power control.");
    } else if (readRatio >= 0.70) {
      discourseScore = 3.8;
      discourseFeedback.push(`Read ${Math.round(readRatio * 100)}% of the essay. Strive to complete entire stretch of discourse without fatigue.`);
    } else {
      discourseScore = 2.5;
      discourseFeedback.push(`Incomplete presentation (${Math.round(readRatio * 100)}% completed).`);
    }

    const overallSpeakingTotal = (pronunciationScore + fluencyScore + discourseScore) / 3;
    const overallPercentage = Math.round((overallSpeakingTotal / 5) * 100);

    let speakingBand = "B2 (Vantage)";
    let meetsC1Speaking = false;

    if (overallPercentage >= 85 && pronunciationAccuracy >= 82) {
      speakingBand = "Band 5 (C2 - Exceptional Fluency & Native Cadence)";
      meetsC1Speaking = true;
    } else if (overallPercentage >= 70 && pronunciationAccuracy >= 75) {
      speakingBand = "Band 4 (Estimated C1 - Advanced Level)";
      meetsC1Speaking = true;
    } else if (overallPercentage >= 50) {
      speakingBand = "Band 2-3 (B2 - Competent but Needs Fluidity Practice)";
      meetsC1Speaking = false;
    } else {
      speakingBand = "Band 1 (B1 - Substantial Phonetic Revision Needed)";
      meetsC1Speaking = false;
    }

    return {
      pronunciationAccuracy,
      wpm,
      elapsedSeconds: this.elapsedSeconds,
      matchedCount,
      deviationCount,
      omittedCount,
      totalWords,
      readRatio: Math.round(readRatio * 100),
      speakingBand,
      overallPercentage,
      meetsC1Speaking,
      scores: {
        pronunciation: { score: Number(pronunciationScore.toFixed(1)), max: 5, feedback: pronunciationFeedback },
        fluency: { score: Number(fluencyScore.toFixed(1)), max: 5, feedback: fluencyFeedback },
        discourse: { score: Number(discourseScore.toFixed(1)), max: 5, feedback: discourseFeedback }
      }
    };
  }

  /**
   * Set voice selection and adapt recognition language and accent/gender profile
   * Supported: 'bf_emma' (UK Female), 'bm_george' (UK Male), 'af_sarah' (US Female), 'am_adam' (US Male)
   */
  setVoice(voiceId) {
    if (!voiceId) return;
    // Map legacy voice IDs to the tuned mellow & deep models
    if (voiceId === 'bf_emma') voiceId = 'bf_isabella';
    if (voiceId === 'af_sarah' || voiceId === 'af_bella') voiceId = 'af_heart';
    if (voiceId === 'bm_george') voiceId = 'bm_fable';
    if (voiceId === 'am_adam') voiceId = 'am_michael';

    this.currentVoiceId = voiceId;

    if (voiceId.startsWith('bf_')) {
      this.currentAccent = 'uk';
      this.currentGender = 'female';
      if (this.recognition) this.recognition.lang = 'en-GB';
    } else if (voiceId.startsWith('bm_')) {
      this.currentAccent = 'uk';
      this.currentGender = 'male';
      if (this.recognition) this.recognition.lang = 'en-GB';
    } else if (voiceId.startsWith('af_')) {
      this.currentAccent = 'us';
      this.currentGender = 'female';
      if (this.recognition) this.recognition.lang = 'en-US';
    } else if (voiceId.startsWith('am_')) {
      this.currentAccent = 'us';
      this.currentGender = 'male';
      if (this.recognition) this.recognition.lang = 'en-US';
    }

    if (this.onVoiceChange) {
      this.onVoiceChange({
        voiceId: this.currentVoiceId,
        accent: this.currentAccent,
        gender: this.currentGender
      });
    }

    // Prefetch voice binary asynchronously in background network thread (0% CPU)
    this.prefetchVoice(this.currentVoiceId);
  }

  updateEngineStatus(state, message) {
    if (this.onEngineStatusChange) {
      this.onEngineStatusChange({ state, message });
    }
  }

  /**
   * Toggle between Kokoro Neural and Fast Native Speech
   */
  toggleEngineMode() {
    this.engineMode = this.engineMode === 'neural' ? 'native' : 'neural';
    try {
      localStorage.setItem('fluentedge_engine_mode', this.engineMode);
    } catch(e) {}

    const isNeural = this.engineMode === 'neural';
    this.updateEngineStatus(
      isNeural ? (this.isKokoroReady ? 'ready' : 'fallback') : 'fallback',
      isNeural ? (this.isKokoroReady ? 'Kokoro Neural' : 'Loading Neural...') : 'Fast Native (0ms)'
    );
    return this.engineMode;
  }

  /**
   * Pre-fetch voice embedding binary in the background via HTTP cache.
   * Uses browser native fetch to download the 522 KB embedding file into browser HTTP cache
   * with 0% main-thread CPU usage, ensuring zero UI lag.
   */
  prefetchVoice(voiceId) {
    if (!voiceId || this.warmedVoices.has(voiceId)) return;
    this.warmedVoices.add(voiceId);
    const url = `https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/voices/${voiceId}.bin`;
    fetch(url, { mode: 'cors', cache: 'force-cache' }).catch(() => {});
  }

  /**
   * Vocabulary precache stub - background WASM inference disabled to prevent UI lag.
   * Words are synthesized on-demand with 0ms in-memory cache upon first listen.
   */
  async precacheVocabulary(words, voiceId = null) {
    return Promise.resolve();
  }

  /**
   * Initialize Kokoro TTS: prefers off-thread Web Worker (Phase 1);
   * falls back to legacy main-thread model when Worker is unavailable.
   */
  async initKokoro() {
    // ── Primary path: Kokoro ONNX Web Worker (off main thread) ──────
    if (typeof Worker !== 'undefined') {
      this.initWorker();
      // Background HTTP prefetch of voice binaries into browser HTTP cache
      const allVoices = ['bf_isabella', 'bm_fable', 'af_heart', 'am_michael'];
      for (const v of allVoices) {
        this.prefetchVoice(v);
      }
      return; // Worker will call updateEngineStatus when ready
    }

    // ── Legacy fallback: main-thread model (file:// or no Worker support) ──
    await this.initKokoroLegacy();
  }

  /**
   * Legacy main-thread Kokoro initialisation (used as Worker fallback).
   * Preserved for file:// environments and Worker-unavailable scenarios.
   */
  async initKokoroLegacy() {
    if (this.kokoroLoading || this.kokoro) return;
    this.kokoroLoading = true;
    this.updateEngineStatus('initializing', 'Kokoro: Loading...');

    try {
      let KokoroTTS = window.KokoroTTS;
      if (!KokoroTTS) {
        try {
          const mod = await import('https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/+esm');
          KokoroTTS = mod.KokoroTTS;
          window.KokoroTTS = KokoroTTS;
        } catch (e1) {
          try {
            const mod = await import('https://esm.sh/kokoro-js@1.2.1');
            KokoroTTS = mod.KokoroTTS;
            window.KokoroTTS = KokoroTTS;
          } catch (e2) {
            console.warn('Could not import KokoroTTS module from CDNs:', e2);
          }
        }
      }

      if (KokoroTTS) {
        this.updateEngineStatus('initializing', 'Fetching weights...');
        this.kokoro = await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', {
          dtype: 'q8',
          device: 'wasm'
        });
        this.isKokoroReady = true;

        const isNeural = this.engineMode === 'neural';
        this.updateEngineStatus(
          isNeural ? 'ready' : 'fallback',
          isNeural ? 'Kokoro Neural' : 'Fast Native (0ms)'
        );
        console.log('Kokoro TTS (legacy main-thread) initialized: UK (Isabella, Fable) & USA (Heart, Michael).');

        const allVoices = ['bf_isabella', 'bm_fable', 'af_heart', 'am_michael'];
        for (const v of allVoices) {
          this.prefetchVoice(v);
        }
      } else {
        throw new Error('KokoroTTS module could not be retrieved.');
      }
    } catch (err) {
      console.warn('Kokoro neural model unavailable. Falling back to browser speech synthesis:', err);
      this.isKokoroReady = false;
      this.kokoro = null;
      this.updateEngineStatus('fallback', 'Native Speech');
    } finally {
      this.kokoroLoading = false;
    }
  }

  /**
   * Apply cadence adjustment:
   * - Female: Mellow, relaxed cadence (0.97x)
   * - Male: Calm, grounded cadence (0.94x)
   */
  applyAcousticFilter(audioElement, isMale) {
    if (!audioElement) return;
    try {
      audioElement.playbackRate = isMale ? 0.94 : 0.97;
    } catch (e) {}
  }

  /**
   * Play Model Audio using Kokoro Neural TTS (with SpeechSynthesis fallback and instant audioCache)
   */
  async speakText(text, rate = 0.95, onEndCallback = null, onStartCallback = null) {
    this.stopSpeakingModel();

    if (!text || !text.trim()) return;
    const cleanText = text.toLowerCase().trim();
    const isMale = this.currentGender === 'male';
    const effectiveRate = isMale ? rate * 0.94 : rate * 0.96;
    const cacheKey = `${this.currentVoiceId}_${effectiveRate.toFixed(2)}_${cleanText}`;

    // Fast-path: Check in-memory audio cache for 0ms instant playback
    const cachedBlob = this.audioCache.get(cacheKey);
    if (cachedBlob) {
      this.isSpeakingModel = true;
      if (onStartCallback) onStartCallback();
      if (this.onStateChange) this.onStateChange({ status: 'model_speaking' });

      const audioUrl = URL.createObjectURL(cachedBlob);
      const audio = new Audio(audioUrl);
      this.currentAudio = audio;
      this.applyAcousticFilter(audio, isMale);

      audio.onended = () => {
        this.isSpeakingModel = false;
        URL.revokeObjectURL(audioUrl);
        this.currentAudio = null;
        if (onEndCallback) onEndCallback();
        if (this.onStateChange) this.onStateChange({ status: 'idle' });
      };

      audio.onerror = () => {
        URL.revokeObjectURL(audioUrl);
        this.currentAudio = null;
        this.speakTextBrowserFallback(text, rate, onEndCallback, onStartCallback);
      };

      await audio.play().catch(e => {
        console.warn("Audio play error, using fallback:", e);
        this.speakTextBrowserFallback(text, rate, onEndCallback, onStartCallback);
      });
      return;
    }

    // If candidate opted for Fast Native, skip Kokoro synthesis
    if (this.engineMode === 'native') {
      this.speakTextBrowserFallback(text, rate, onEndCallback, onStartCallback);
      return;
    }

    // 1. Attempt Kokoro Neural TTS if ready
    if (this.isKokoroReady && this.kokoro) {
      try {
        this.isSpeakingModel = true;
        if (onStartCallback) onStartCallback();
        if (this.onStateChange) this.onStateChange({ status: 'model_speaking' });
        this.updateEngineStatus('synthesizing', 'Synthesizing...');

        const result = await this.kokoro.generate(cleanText, {
          voice: this.currentVoiceId,
          speed: rate
        });
        const audioBlob = result.toBlob();

        // Maintain LRU cache
        if (this.audioCache.size > 80) {
          const firstKey = this.audioCache.keys().next().value;
          this.audioCache.delete(firstKey);
        }
        this.audioCache.set(cacheKey, audioBlob);

        // If stopped during generation, do not play
        if (!this.isSpeakingModel) {
          this.updateEngineStatus('ready', 'Kokoro Neural');
          return;
        }

        const audioUrl = URL.createObjectURL(audioBlob);
        const audio = new Audio(audioUrl);
        this.currentAudio = audio;
        this.applyAcousticFilter(audio, isMale);

        audio.onended = () => {
          this.isSpeakingModel = false;
          URL.revokeObjectURL(audioUrl);
          this.currentAudio = null;
          this.updateEngineStatus('ready', 'Kokoro Neural');
          if (onEndCallback) onEndCallback();
          if (this.onStateChange) this.onStateChange({ status: 'idle' });
        };

        audio.onerror = (e) => {
          console.warn("Kokoro audio playback failed, falling back to speech synthesis:", e);
          URL.revokeObjectURL(audioUrl);
          this.currentAudio = null;
          this.updateEngineStatus('ready', 'Kokoro Neural');
          this.speakTextBrowserFallback(text, rate, onEndCallback, onStartCallback);
        };

        await audio.play();
        return;
      } catch (err) {
        console.warn("Kokoro generation error, falling back to browser synthesis:", err);
        this.updateEngineStatus('ready', 'Kokoro Neural');
      }
    }

    // 2. Fallback to SpeechSynthesis
    this.speakTextBrowserFallback(text, rate, onEndCallback, onStartCallback);
  }

  /**
   * Native Browser SpeechSynthesis Fallback matching Accent and Gender
   */
  speakTextBrowserFallback(text, rate = 0.95, onEndCallback = null, onStartCallback = null) {
    if (!this.synth) {
      if (this.onError) this.onError("Speech synthesis is not supported in this browser.");
      return;
    }

    this.stopSpeakingModel();

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = rate;
    utterance.pitch = 1.0;

    const voices = this.synth.getVoices();
    const isUK = this.currentAccent === 'uk';
    const isMale = this.currentGender === 'male';

    let selectedVoice = null;

    if (isUK) {
      const ukVoices = voices.filter(v => v.lang === 'en-GB' || v.lang === 'en_GB' || v.lang.startsWith('en-GB'));
      if (isMale) {
        selectedVoice = ukVoices.find(v => /fable|george|daniel|oliver|ryan|arthur|guy|natural.*male/i.test(v.name)) || ukVoices[1] || ukVoices[0];
      } else {
        selectedVoice = ukVoices.find(v => /isabella|victoria|alice|hazel|susan|libby|sonia|natural.*female/i.test(v.name)) || ukVoices[0];
      }
      if (!selectedVoice) selectedVoice = ukVoices[0];
    } else {
      const usVoices = voices.filter(v => v.lang === 'en-US' || v.lang === 'en_US' || v.lang.startsWith('en-US'));
      if (isMale) {
        selectedVoice = usVoices.find(v => /michael|fenrir|guy|christopher|mark|eric|alex|natural.*male/i.test(v.name)) || usVoices[1] || usVoices[0];
      } else {
        selectedVoice = usVoices.find(v => /heart|bella|jenny|aria|samantha|zira|ava|sara|natural.*female/i.test(v.name)) || usVoices[0];
      }
      if (!selectedVoice) selectedVoice = usVoices[0];
    }

    if (!selectedVoice) {
      selectedVoice = voices.find(v => v.lang && v.lang.startsWith('en'));
    }

    if (selectedVoice) {
      utterance.voice = selectedVoice;
    }

    if (isMale) {
      utterance.pitch = 0.88; // Calm & deep
      utterance.rate = rate * 0.94; // Calm, grounded cadence
    } else {
      utterance.pitch = 1.10; // Feminine, warm
      utterance.rate = rate * 0.96; // Mellow, relaxed cadence
    }

    utterance.onstart = () => {
      this.isSpeakingModel = true;
      if (onStartCallback) onStartCallback();
      if (this.onStateChange) this.onStateChange({ status: 'model_speaking' });
    };

    utterance.onend = () => {
      this.isSpeakingModel = false;
      if (onEndCallback) onEndCallback();
      if (this.onStateChange) this.onStateChange({ status: 'idle' });
    };

    utterance.onerror = (e) => {
      console.error("SpeechSynthesis error:", e);
      this.isSpeakingModel = false;
      if (this.onStateChange) this.onStateChange({ status: 'idle' });
    };

    this.synth.speak(utterance);
  }

  stopSpeakingModel() {
    if (this.currentAudio) {
      try {
        this.currentAudio.pause();
        this.currentAudio.currentTime = 0;
      } catch (e) {}
      this.currentAudio = null;
    }
    if (this.synth && (this.synth.speaking || this.synth.pending)) {
      try {
        this.synth.cancel();
      } catch (e) {}
    }
    this.isSpeakingModel = false;
  }

  /**
   * Real-time Audio Visualizer with HTML5 Canvas & Web Audio API
   */
  async startAudioVisualizer(canvas) {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;

      if (!this.audioContext || this.audioContext.state === 'closed') {
        this.audioContext = new AudioCtx();
      } else if (this.audioContext.state === 'suspended') {
        await this.audioContext.resume();
      }

      // Reuse active media stream if already acquired in this page session
      if (this.mediaStream && this.mediaStream.active) {
        this.mediaStream.getAudioTracks().forEach(track => { track.enabled = true; });
      } else {
        this.mediaStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: false, // Don't run heavy software filter on visualizer tap
            noiseSuppression: false, // Don't gate or buffer audio
            autoGainControl: false,  // Don't fight speech recognition AGC
            channelCount: 1,
            latency: 0
          },
          video: false
        });
        const source = this.audioContext.createMediaStreamSource(this.mediaStream);
        this.analyser = this.audioContext.createAnalyser();
        this.analyser.fftSize = 256;
        source.connect(this.analyser);
      }

      const ctx = canvas.getContext('2d');
      const bufferLength = this.analyser.frequencyBinCount;
      const dataArray = new Uint8Array(bufferLength);

      if (this.visualizerAnimationId) {
        cancelAnimationFrame(this.visualizerAnimationId);
      }

      const draw = () => {
        if (!this.isListening) return;

        this.visualizerAnimationId = requestAnimationFrame(draw);
        this.analyser.getByteFrequencyData(dataArray);

        ctx.clearRect(0, 0, canvas.width, canvas.height);

        const barWidth = (canvas.width / bufferLength) * 2.5;
        let barHeight;
        let x = 0;

        for (let i = 0; i < bufferLength; i++) {
          barHeight = (dataArray[i] / 255) * (canvas.height * 0.85);

          // Elegant Gold-to-Cyan gradient
          const gradient = ctx.createLinearGradient(0, canvas.height, 0, 0);
          gradient.addColorStop(0, 'rgba(223, 177, 91, 0.2)');
          gradient.addColorStop(0.6, 'rgba(223, 177, 91, 0.8)');
          gradient.addColorStop(1, 'rgba(78, 205, 196, 1)');

          ctx.fillStyle = gradient;
          ctx.beginPath();
          ctx.roundRect(x, canvas.height - barHeight, barWidth - 1, barHeight, [3, 3, 0, 0]);
          ctx.fill();

          x += barWidth + 1;
        }
      };

      draw();
    } catch (err) {
      console.warn("Could not start visualizer audio context:", err);
    }
  }

  stopAudioVisualizer() {
    if (this.visualizerAnimationId) {
      cancelAnimationFrame(this.visualizerAnimationId);
      this.visualizerAnimationId = null;
    }
    // Mute tracks while idle so the indicator goes off without destroying the permission handle
    if (this.mediaStream && this.mediaStream.active) {
      this.mediaStream.getAudioTracks().forEach(track => {
        track.enabled = false;
      });
    }
    if (this.audioContext && this.audioContext.state === 'running') {
      try {
        this.audioContext.suspend();
      } catch (e) {
        // ignore
      }
    }
  }
}

/**
 * Word similarity calculation using normalized Levenshtein distance
 */
function calculateWordSimilarity(s1, s2) {
  if (s1 === s2) return 1.0;
  if (!s1 || !s2) return 0.0;

  // Suffix strip & morphological matching (e.g., "mitigating" vs "mitigate", "paradigms" vs "paradigm")
  if (s1.startsWith(s2) || s2.startsWith(s1)) {
    const diff = Math.abs(s1.length - s2.length);
    if (diff <= 3) return 0.88;
    if (diff <= 5 && Math.min(s1.length, s2.length) >= 4) return 0.82;
  }

  const distance = levenshteinDistance(s1, s2);
  const maxLength = Math.max(s1.length, s2.length);
  return 1 - (distance / maxLength);
}

function levenshteinDistance(a, b) {
  const matrix = [];
  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1, // substitution
          matrix[i][j - 1] + 1,     // insertion
          matrix[i - 1][j] + 1      // deletion
        );
      }
    }
  }
  return matrix[b.length][a.length];
}
