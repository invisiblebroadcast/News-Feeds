// @ts-nocheck
const Embeddings = (() => {
    let model = null;
    let isReady = false;
    let loadPromise = null;
    let loadError = null;
    const cache = new Map();
    async function loadModel() {
        if (model)
            return model;
        if (loadPromise)
            return loadPromise;
        loadPromise = (async () => {
            try {
                const { pipeline } = window.transformers;
                model = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
                isReady = true;
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
