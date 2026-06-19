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

  // Smallest viable NLI / zero-shot model. ~25MB quantized.
  // Good for our "importance" + "benefit" zero-shot labels and
  // for NLI-based conflict detection.
  const MODEL_ID = 'Xenova/nli-deberta-small';
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
      _classifier = await _pipeline('zero-shot-classification', MODEL_ID, {
        quantized: true,
        // The library calls this for every chunk it downloads.
        // `data.status` is one of: initiate, download, progress,
        // done, ready, etc. `data.progress` is 0–100 for that file.
        progress_callback: (data) => {
          if (data.status === 'progress' && typeof data.progress === 'number') {
            // Map model-file progress (0–100) into 5–99% of the bar.
            const mapped = Math.round(5 + Math.min(100, data.progress) * 0.94);
            _progress = mapped;
            _progressFile = (data.file || MODEL_ID) + '  ' + mapped + '%';
            emit({ type: 'progress', progress: mapped, file: data.file || MODEL_ID });
          } else if (data.status === 'done' && data.file) {
            emit({ type: 'progress', progress: _progress, file: data.file });
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
