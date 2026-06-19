// Embeddings — Universal Sentence Encoder wrapper.
//
// On PC we load the full USE model (~25MB, 512-dim embeddings,
// more accurate). On mobile we try the Lite variant first
// (~1MB, 512-dim, quantized, faster on phones); if the Lite
// library didn't load (CDN blocked / package missing), we fall
// back to the full model on a slow path, and if that also fails
// the rest of the app keeps working with plain substring search.
//
// The model loads lazily on first call to `loadModel()` and is
// re-used for every subsequent call to `embed()` / `embedBatch()`.
//
// Embeddings are cached in-memory (Map<url, number[]>) so we
// don't re-compute the same article twice. The cache is wiped
// on page reload — persistence to IndexedDB is a future
// enhancement; the ~6MB footprint of 3,000 cached vectors is
// small enough that re-computing on next session is acceptable.

const Embeddings = (() => {
  let model = null;
  let isReady = false;
  let isMobileDevice = false;
  let loadPromise = null;
  let loadError = null;

  // In-memory cache. Keyed by article URL so the same article
  // loaded from different scopes shares one embedding.
  const cache = new Map();

  function isMobile() {
    try {
      if (typeof navigator !== 'undefined') {
        const ua = navigator.userAgent || '';
        if (/Mobi|Android|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(ua)) return true;
        // Some Android tablets report no "Mobi" in UA. Fall back
        // to screen width + touch capability.
        if (typeof window !== 'undefined' && window.innerWidth < 768) return true;
        if (navigator.maxTouchPoints && navigator.maxTouchPoints > 1 && window.innerWidth < 1024) return true;
      }
    } catch {}
    return false;
  }

  // Try the Lite variant first on mobile, else the full model.
  // Returns the model or null if neither could be loaded.
  async function loadModel() {
    if (model) return model;
    if (loadPromise) return loadPromise;
    isMobileDevice = isMobile();

    loadPromise = (async () => {
      // 1. Mobile + Lite available → use Lite.
      if (isMobileDevice &&
          window.universalSentenceEncoderLite &&
          typeof window.universalSentenceEncoderLite.load === 'function') {
        try {
          console.log('[Embeddings] Loading USE Lite (mobile)…');
          model = await window.universalSentenceEncoderLite.load();
          isReady = true;
          console.log('[Embeddings] USE Lite ready.');
          return model;
        } catch (e) {
          console.warn('[Embeddings] USE Lite load failed, falling back to full:', e && e.message);
          model = null;
        }
      }
      // 2. Full model (PC path, or mobile fallback).
      if (window.universalSentenceEncoder &&
          typeof window.universalSentenceEncoder.load === 'function') {
        try {
          console.log('[Embeddings] Loading USE Full…');
          model = await window.universalSentenceEncoder.load();
          isReady = true;
          console.log('[Embeddings] USE Full ready.');
          return model;
        } catch (e) {
          loadError = e;
          console.warn('[Embeddings] USE Full load failed:', e && e.message);
          return null;
        }
      }
      // 3. Neither library is on the page.
      loadError = new Error('Universal Sentence Encoder library not loaded');
      console.warn('[Embeddings] No USE library found on window.');
      return null;
    })().finally(() => {
      // Allow a future retry if the first attempt failed
      // (e.g. the user enables a blocked CDN mid-session).
      loadPromise = null;
    });
    return loadPromise;
  }

  // Embed a single string. Returns a plain number[] (length 512)
  // or null if USE isn't available.
  async function embed(text) {
    if (!text) return null;
    const m = await loadModel();
    if (!m) return null;
    try {
      const t = await m.embed([String(text)]);
      const data = await t.data();
      const dim = (t.shape && t.shape[1]) || data.length;
      const out = Array.from(data.length === dim ? data : data.slice(0, dim));
      try { t.dispose(); } catch {}
      return out;
    } catch (e) {
      console.warn('[Embeddings] embed failed:', e && e.message);
      return null;
    }
  }

  // Embed a batch of strings. Returns number[][] (each length
  // 512). Faster than calling embed() in a loop because the
  // model runs one forward pass for the whole batch.
  async function embedBatch(texts) {
    if (!texts || !texts.length) return [];
    const m = await loadModel();
    if (!m) return [];
    const safe = texts.map(t => String(t || ''));
    try {
      const t = await m.embed(safe);
      const data = await t.data();
      const dim = (t.shape && t.shape[1]) || 512;
      const out = new Array(safe.length);
      for (let i = 0; i < safe.length; i++) {
        const start = i * dim;
        out[i] = Array.from(data.slice(start, start + dim));
      }
      try { t.dispose(); } catch {}
      return out;
    } catch (e) {
      console.warn('[Embeddings] embedBatch failed:', e && e.message);
      return [];
    }
  }

  // Plain-JS cosine similarity. Returns a value in [-1, 1] but
  // for USE embeddings on text it's effectively [0, 1].
  function cosineSimilarity(a, b) {
    if (!a || !b) return 0;
    let dot = 0, ma = 0, mb = 0;
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
      const av = a[i] || 0, bv = b[i] || 0;
      dot += av * bv;
      ma  += av * av;
      mb  += bv * bv;
    }
    const den = Math.sqrt(ma) * Math.sqrt(mb);
    return den === 0 ? 0 : dot / den;
  }

  // Cache helpers. The cache key is the article URL (stable
  // across re-renders) so the same article reuses its embedding.
  function getCached(url) {
    if (!url) return null;
    return cache.get(url) || null;
  }
  function setCached(url, embedding) {
    if (!url || !embedding) return;
    cache.set(url, embedding);
  }
  function hasCached(url) {
    return url ? cache.has(url) : false;
  }
  function clearCache() {
    cache.clear();
  }
  function cacheSize() {
    return cache.size;
  }

  return {
    loadModel,
    embed,
    embedBatch,
    cosineSimilarity,
    getCached, setCached, hasCached, clearCache, cacheSize,
    isReady: () => isReady,
    isMobile: () => isMobileDevice,
    getError: () => loadError
  };
})();

// Expose on window — top-level `const` isn't a window property
// in browsers (see js/feeds.js for the same fix).
window.Embeddings = Embeddings;
