/* ── Transformers.js integration ──
 *
 * Loads ONNX models from Hugging Face Hub via the
 * @huggingface/transformers library (loaded dynamically from a
 * CDN). Runs entirely in the browser — no server, no data leaves
 * the device. The model is cached in IndexedDB after the first
 * download so subsequent visits are instant.
 *
 * State machine:
 *   idle    → not yet asked to load
 *   loading → model is being downloaded
 *   ready   → classifier is loaded and ready for inference
 *   failed  → load failed (network, CORS, unsupported browser, …)
 *
 * Callers subscribe to progress via onProgress(fn) and get events:
 *   { type: 'start',     progress: 0   }
 *   { type: 'progress',  progress: 0–100, file: 'model-file' }
 *   { type: 'ready',     progress: 100 }
 *   { type: 'failed',    error: 'message' }
 *
 * The library itself creates a Web Worker internally for inference,
 * so the main thread stays responsive even while scoring batches
 * of articles.
 */
const Transformers = (() => {
  let _pipeline = null;
  let _state = 'idle';
  let _progress = 0;
  let _progressFile = '';
  let _listeners = new Set();
  let _classifier = null;

  // NLI / zero-shot model. We use distilbert-base-uncased-mnli
  // because it's the canonical, guaranteed-available Xenova model
  // (the original NLI checkpoint that Transformers.js was built
  // around). Earlier we tried `Xenova/nli-deberta-small` which
  // turned out not to be on the Xenova org — Hugging Face was
  // returning 401 for every model file. distilbert-base-uncased-mnli
  // is ~67MB quantized — bigger than the previous target but the
  // trade-off is "works" vs "doesn't work".
  const MODEL_ID = 'Xenova/distilbert-base-uncased-mnli';
  // Library is served from the same origin (committed to the
  // repo under js/lib/) so GitHub Pages users don't need a
  // separate CDN round-trip just to load the JavaScript. The
  // model weights themselves still come from Hugging Face at
  // runtime — those are ~25MB and not checked into git.
  const LIB_URL = './lib/transformers.min.js';

  function onProgress(callback) {
    _listeners.add(callback);
    return () => _listeners.delete(callback);
  }

  function emit(event) {
    for (const cb of _listeners) {
      try { cb(event); } catch {}
    }
  }

  function getState() {
    return { state: _state, progress: _progress, file: _progressFile };
  }

  function isReady() { return _state === 'ready'; }
  function isLoading() { return _state === 'loading'; }

  // Idempotent load. Safe to call multiple times — concurrent
  // callers all resolve to the same promise.
  let _loadPromise = null;
  async function load() {
    if (_state === 'ready') return true;
    if (_loadPromise) return _loadPromise;
    _loadPromise = _doLoad();
    return _loadPromise;
  }

  async function _doLoad() {
    _state = 'loading';
    _progress = 0;
    _progressFile = '';
    emit({ type: 'start', progress: 0, file: '' });

    try {
      // Dynamic import of the ES module from CDN. Works in any
      // script context (we're not using type="module" anywhere).
      const mod = await import(/* @vite-ignore */ LIB_URL);
      // v3 exports `pipeline` as a named export. Some builds
      // wrap the whole module in a default export; handle both.
      const pipeline = mod.pipeline || (mod.default && mod.default.pipeline);
      if (typeof pipeline !== 'function') {
        throw new Error('Transformers.js loaded but `pipeline` export not found');
      }
      _pipeline = pipeline;
      // Reserve 0–5% for the library load itself, the rest for
      // the model files.
      emit({ type: 'progress', progress: 5, file: 'library' });

      // Load the zero-shot classification pipeline. `quantized: true`
      // picks the int8-quantized ONNX weights (~25MB vs ~95MB).
      // The library does three phases, each of which calls our
      // progress_callback with a different `status`:
      //   1. 'initiate' / 'download' / 'progress' — fetching each
      //      model file. `data.progress` is 0–100 for that file.
      //   2. 'done' — that file finished downloading. No progress
      //      number, but the next file's progress starts at 0.
      //   3. (silent) — once all files are downloaded, the library
      //      INITIALIZES THE ONNX RUNTIME SESSION. This phase has
      //      no progress events and can take 10–30s on a phone.
      //      The bar would otherwise look stuck at 99% during this.
      //   4. (pipeline resolves) — emit our own 'ready' event
      //      from the code below, which jumps the bar to 100%
      //      and dismisses it.
      //
      // To make phase 3 visible we switch the label to "Initializing
      // model…" the moment the LAST file finishes downloading.
      // The largest file in a Transformers.js model is almost
      // always the ONNX weights, so we treat the file matching
      // `*.onnx` or `*.onnx_data` as the last one. (For models
      // that only have a single .onnx file, this fires correctly
      // when it reaches 100%.)
      let lastFileWasWeights = false;
      let initializingEmitted = false;
      _classifier = await _pipeline('zero-shot-classification', MODEL_ID, {
        quantized: true,
        progress_callback: (data) => {
          if (data.status === 'progress' && typeof data.progress === 'number') {
            // Map model-file progress (0–100) into 5–99% of the bar.
            // We deliberately cap at 99% so the 'ready' handler
            // (which jumps to 100%) always shows a visible bump.
            const mapped = Math.round(5 + Math.min(100, data.progress) * 0.94);
            _progress = mapped;
            const f = data.file || MODEL_ID;
            _progressFile = f + '  ' + Math.round(data.progress) + '%';
            // If this is the weights file and it's fully done,
            // remember it — the next 'done' event will trigger
            // the "Initializing" label.
            if (data.progress >= 100 && /\.(onnx)(\.data)?$/.test(f)) {
              lastFileWasWeights = true;
            }
            emit({ type: 'progress', progress: mapped, file: f });
          } else if (data.status === 'done' && data.file) {
            // The previous file hit 100% and the library moved
            // on. If that was the weights file, all downloads
            // are done — switch to "Initializing" so the user
            // doesn't think the download is stuck.
            if (lastFileWasWeights && !initializingEmitted) {
              initializingEmitted = true;
              _progressFile = 'Initializing model…';
              emit({ type: 'progress', progress: 99, file: 'Initializing model… (can take 10–30 s)' });
            } else {
              emit({ type: 'progress', progress: _progress, file: data.file });
            }
          }
        }
      });

      _state = 'ready';
      _progress = 100;
      _progressFile = 'ready';
      emit({ type: 'ready', progress: 100, file: 'ready' });
      return true;
    } catch (err) {
      _state = 'failed';
      // Surface the real error message so the user can debug
      // (most common: CORS, offline, blocked CDN).
      emit({ type: 'failed', error: err && err.message ? err.message : String(err) });
      _loadPromise = null; // allow retry
      return false;
    }
  }

  // Run zero-shot classification on a batch of texts.
  // Returns: [{ labels: [...], scores: [...] }, ...]
  // The Transformers.js pipeline natively supports array input.
  async function classifyBatch(texts, candidateLabels) {
    if (!isReady() || !_classifier) {
      throw new Error('Transformers classifier not ready');
    }
    // Truncate to 512 chars per text — DeBERTa has a 512-token
    // context window, and the zero-shot NLI prepends "hypothesis:
    // This text is about <label>." which eats into the budget.
    const trimmed = texts.map(t => (t || '').slice(0, 512));
    return await _classifier(trimmed, candidateLabels);
  }

  return {
    load,
    isReady,
    isLoading,
    getState,
    onProgress,
    classifyBatch,
    MODEL_ID
  };
})();

// Expose on window — same pattern as the other modules in this
// project (see js/feeds.js, js/filter-modal.js, etc.). app.js
// gates its call sites on `window.Transformers`.
window.Transformers = Transformers;
