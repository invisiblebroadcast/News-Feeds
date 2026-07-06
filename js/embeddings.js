// @ts-nocheck
const Embeddings = (() => {
    let model = null;
    let isReady = false;
    let loadPromise = null;
    let loadError = null;
    const cache = new Map();
    let _userConsented = null;
    function setConsent(val) {
        _userConsented = val;
        localStorage.setItem('embeddings_consent', val ? '1' : '0');
    }
    function needsConsent() {
        if (_userConsented !== null)
            return false;
        const stored = localStorage.getItem('embeddings_consent');
        if (stored === '1') {
            _userConsented = true;
            return false;
        }
        if (stored === '0') {
            _userConsented = false;
            return false;
        }
        return true;
    }
    function hasConsent() {
        return _userConsented === true;
    }
    async function loadModel() {
        if (model)
            return model;
        if (loadPromise)
            return loadPromise;
        if (!hasConsent())
            return null;
        loadPromise = (async () => {
            try {
                const { pipeline } = await import('https://esm.sh/@huggingface/transformers@3.4.2');
                model = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
                isReady = true;
                console.log('[Embeddings] all-MiniLM-L6-v2 model loaded');
                return model;
            }
            catch (e) {
                loadError = e;
                console.warn('[Embeddings] all-MiniLM-L6-v2 load failed:', e && e.message);
                return null;
            }
        })().finally(() => {
            loadPromise = null;
        });
        return loadPromise;
    }
    async function loadModelWithProgress(onProgress) {
        if (model) {
            if (onProgress)
                onProgress({ status: 'ready', progress: 1 });
            return model;
        }
        if (loadPromise)
            return loadPromise;
        if (!hasConsent())
            return null;
        if (onProgress)
            onProgress({ status: 'download', phase: 'library', progress: 0 });
        loadPromise = (async () => {
            try {
                if (onProgress)
                    onProgress({ status: 'download', phase: 'library', progress: 0.1 });
                const { pipeline } = await import('https://esm.sh/@huggingface/transformers@3.4.2');
                if (onProgress)
                    onProgress({ status: 'download', phase: 'model', progress: 0.15 });
                model = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
                    progress_callback: (p) => {
                        if (!onProgress)
                            return;
                        if (p.status === 'progress') {
                            const base = 0.15;
                            const range = 0.85;
                            onProgress({ status: 'download', phase: 'model', progress: base + p.progress * range, loaded: p.loaded, total: p.total });
                        }
                    }
                });
                isReady = true;
                if (onProgress)
                    onProgress({ status: 'ready', progress: 1 });
                console.log('[Embeddings] all-MiniLM-L6-v2 model loaded');
                return model;
            }
            catch (e) {
                loadError = e;
                if (onProgress)
                    onProgress({ status: 'error', error: e && e.message });
                console.warn('[Embeddings] all-MiniLM-L6-v2 load failed:', e && e.message);
                return null;
            }
        })().finally(() => {
            loadPromise = null;
        });
        return loadPromise;
    }
    async function embed(text) {
        if (!text)
            return null;
        const m = await loadModel();
        if (!m)
            return null;
        try {
            const result = await m(String(text), { pooling: 'mean', normalize: true });
            return Array.from(result.data);
        }
        catch (e) {
            console.warn('[Embeddings] embed failed:', e && e.message);
            return null;
        }
    }
    async function embedBatch(texts) {
        if (!texts || !texts.length)
            return [];
        const m = await loadModel();
        if (!m)
            return [];
        try {
            const result = await m(texts.map(t => String(t || '')), { pooling: 'mean', normalize: true });
            const dim = result.dims && result.dims[result.dims.length - 1] || 384;
            const data = await result.data();
            const out = new Array(texts.length);
            for (let i = 0; i < texts.length; i++) {
                const start = i * dim;
                out[i] = Array.from(data.slice(start, start + dim));
            }
            return out;
        }
        catch (e) {
            console.warn('[Embeddings] embedBatch failed:', e && e.message);
            return [];
        }
    }
    function cosineSimilarity(a, b) {
        if (!a || !b)
            return 0;
        let dot = 0, ma = 0, mb = 0;
        const n = Math.min(a.length, b.length);
        for (let i = 0; i < n; i++) {
            const av = a[i] || 0, bv = b[i] || 0;
            dot += av * bv;
            ma += av * av;
            mb += bv * bv;
        }
        const den = Math.sqrt(ma) * Math.sqrt(mb);
        return den === 0 ? 0 : dot / den;
    }
    function getCached(url) {
        if (!url)
            return null;
        return cache.get(url) || null;
    }
    function setCached(url, embedding) {
        if (!url || !embedding)
            return;
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
        loadModelWithProgress,
        setConsent,
        needsConsent,
        hasConsent,
        embed,
        embedBatch,
        cosineSimilarity,
        getCached, setCached, hasCached, clearCache, cacheSize,
        isReady: () => isReady,
        isMobile: () => false,
        getError: () => loadError
    };
})();
window.Embeddings = Embeddings;
