const AI = (() => {
  const HISTORY_KEY = 'newsfeeds_ai_history';
  const MAX_HISTORY_MESSAGES = 40;
  const MAX_CONTEXT_CHARS = 180;
  const MAX_TITLE_CHARS = 140;
  const REQUEST_TIMEOUT_MS = 5 * 60 * 1000;
  const WEBLLM_LIB_URL = 'https://esm.run/@mlc-ai/web-llm@0.2.79';

  const WEBLLM_MODELS = {
    'Qwen2.5-1.5B-Instruct-q4f16_1-MLC': { label: 'Qwen 2.5 1.5B', size: '~1.1 GB', vram: 2 },
    'Llama-3.2-1B-Instruct-q4f16_1-MLC': { label: 'Llama 3.2 1B', size: '~0.8 GB', vram: 1.5 },
    'Qwen2.5-3B-Instruct-q4f16_1-MLC': { label: 'Qwen 2.5 3B', size: '~1.9 GB', vram: 3.5 },
    'Phi-3.5-mini-instruct-q4f16_1-MLC': { label: 'Phi-3.5 Mini', size: '~2.3 GB', vram: 4 }
  };

  let currentAbort = null;
  let webllmLib = null;
  let webllmEngine = null;
  let webllmLoadedModel = null;
  let webllmLoadState = 'idle';
  let webllmLoadError = null;
  let webllmLoadProgress = null;
  let webllmLoadPromise = null;
  let webllmAbortFlag = false;

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  function loadHistory() {
    try {
      const raw = localStorage.getItem(HISTORY_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  }

  function saveHistory(messages) {
    try {
      const trimmed = messages.slice(-MAX_HISTORY_MESSAGES);
      localStorage.setItem(HISTORY_KEY, JSON.stringify(trimmed));
    } catch {}
  }

  function clearHistory() {
    try { localStorage.removeItem(HISTORY_KEY); } catch {}
  }

  function stripHtml(html) {
    if (!html) return '';
    const div = document.createElement('div');
    div.innerHTML = html;
    return div.textContent || div.innerText || '';
  }

  function truncate(str, max) {
    if (!str) return '';
    if (str.length <= max) return str;
    const slice = str.slice(0, max);
    const lastSpace = slice.lastIndexOf(' ');
    if (lastSpace > max * 0.6) return slice.slice(0, lastSpace) + '…';
    return slice + '…';
  }

  function formatDateShort(d) {
    try {
      const date = new Date(d);
      if (isNaN(date.getTime())) return '';
      return date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
    } catch {
      return '';
    }
  }

  function buildNewsContext(articles, maxCount) {
    if (!Array.isArray(articles) || !articles.length) return '';
    const limit = Math.max(0, Math.min(200, maxCount | 0 || 60));
    if (limit === 0) return '';
    const sorted = articles
      .filter(a => a && (a.title || a.summary))
      .slice()
      .sort((a, b) => {
        const ta = a.pubDate ? new Date(a.pubDate).getTime() : 0;
        const tb = b.pubDate ? new Date(b.pubDate).getTime() : 0;
        return tb - ta;
      })
      .slice(0, limit);
    if (!sorted.length) return '';

    const seen = new Set();
    const lines = [];
    let idx = 1;
    for (const a of sorted) {
      const title = (a.title || '').replace(/\s+/g, ' ').trim();
      if (!title) continue;
      const dedupKey = title.toLowerCase();
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);

      const source = a.source || '';
      const date = formatDateShort(a.pubDate);
      const summary = stripHtml(a.summary || '').replace(/\s+/g, ' ').trim();
      const titleTrunc = truncate(title, MAX_TITLE_CHARS);
      const summaryTrunc = truncate(summary, MAX_CONTEXT_CHARS);

      const parts = [idx + '.'];
      if (source) parts.push('[' + source + ']');
      if (date) parts.push('(' + date + ')');
      parts.push(titleTrunc);
      if (summaryTrunc) parts.push('— ' + summaryTrunc);
      lines.push(parts.join(' '));
      idx++;
    }
    return lines.join('\n');
  }

  function buildSystemPrompt(newsContext, customPrompt) {
    const base = customPrompt && customPrompt.trim()
      ? customPrompt.trim()
      : 'You are a helpful assistant in a news reader app. Answer the user clearly and concisely.';
    if (!newsContext) {
      return base + '\n\nNo news articles are currently available as context. Answer using general knowledge if asked about current events, and mention when you are not certain.';
    }
    return base +
      '\n\nYou have access to recent news articles from the user\'s feeds. When a question relates to these articles, reference them by title and source. If the user asks something the articles do not cover, say so. Do not invent article titles or facts not present in the context.\n\n' +
      'Recent news articles (most recent first):\n' + newsContext;
  }

  function getProviderConfig() {
    const s = Settings.load();
    return {
      provider: s.aiProvider || 'ollama',
      address: (s.ollamaAddress || '').trim().replace(/\/+$/, ''),
      model: (s.ollamaModel || 'qwen2.5:1.5b').trim(),
      webllmModel: s.webllmModel || 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC',
      contextCount: s.aiNewsContextCount ?? 20,
      cloudKey: (s.aiCloudKey || '').trim(),
      cloudEndpoint: (s.aiCloudEndpoint || 'https://api.openai.com/v1').trim().replace(/\/+$/, ''),
      cloudModel: (s.aiCloudModel || 'gpt-4o-mini').trim()
    };
  }

  function normalizeBase(address) {
    let base = (address || '').trim().replace(/\/+$/, '');
    if (!base) return '';
    if (!/^https?:\/\//i.test(base)) base = 'http://' + base;
    return base;
  }

  async function testOllamaConnectionAt(rawAddress, rawModel) {
    const base = normalizeBase(rawAddress);
    if (!base) throw new Error('Ollama address is empty');

    const isHttpsPage = typeof location !== 'undefined' && location.protocol === 'https:';
    const isHttpTarget = /^http:\/\//i.test(base);
    const mixedContent = isHttpsPage && isHttpTarget;
    const model = (rawModel || '').trim() || 'qwen2.5:1.5b';

    // First, light ping to root — fast, returns "Ollama is running" page
    const rootUrl = base + '/';
    const rootController = new AbortController();
    const rootTimer = setTimeout(() => rootController.abort(), 8000);
    try {
      await fetch(rootUrl, { signal: rootController.signal, cache: 'no-store' });
    } catch (e) {
      clearTimeout(rootTimer);
      if (e.name === 'AbortError') {
        throw new Error('Connection timed out (8s) reaching ' + rootUrl + '. The server is not responding. ' +
          'Check: (1) Ollama is running, (2) OLLAMA_HOST=0.0.0.0 is set so it accepts external connections, ' +
          '(3) no firewall blocks port 11434, (4) the phone is on the same network as the PC.');
      }
      if (e instanceof TypeError) {
        throw new Error('Network error reaching ' + rootUrl + '. ' +
          'Likely mixed content (HTTPS page → HTTP Ollama) or CORS. ' +
          'If the site is served over HTTPS, you must either serve the site over HTTP too, or put Ollama behind an HTTPS reverse proxy. ' +
          'Original: ' + (e.message || e));
      }
      throw new Error('Could not reach ' + rootUrl + ' — ' + (e.message || e));
    }
    clearTimeout(rootTimer);

    // Root worked, now check the API
    const url = base + '/api/tags';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      const models = Array.isArray(data.models) ? data.models.map(m => m.name).filter(Boolean) : [];
      return {
        ok: true,
        address: base,
        models,
        currentModel: model,
        modelAvailable: models.includes(model),
        warning: mixedContent
          ? 'Connected, but this page is HTTPS and Ollama is HTTP — chat will be blocked by the browser. Serve the site over HTTP or put Ollama behind an HTTPS proxy.'
          : null
      };
    } catch (e) {
      if (e.name === 'AbortError') {
        throw new Error('Root reachable, but /api/tags timed out after 15s. Ollama API may be slow or stuck.');
      }
      throw new Error('Root reachable, but /api/tags failed: ' + (e.message || e));
    } finally {
      clearTimeout(timer);
    }
  }

  async function testOllamaConnection() {
    const cfg = getProviderConfig();
    return testOllamaConnectionAt(cfg.address, cfg.model);
  }

  async function testConnection() {
    const cfg = getProviderConfig();
    if (cfg.provider === 'ollama') return testOllamaConnection();
    if (cfg.provider === 'webllm') return checkWebGPUSupport();
    throw new Error('Unsupported provider: ' + cfg.provider);
  }

  async function checkWebGPUSupport() {
    const result = {
      supported: false,
      webgpu: false,
      gpu: null,
      memory: null,
      cores: null,
      platform: navigator.platform || 'unknown',
      warnings: [],
      recommendation: 'no',
      reason: ''
    };

    if (!navigator.gpu) {
      result.reason = 'WebGPU is not supported on this browser. Try Chrome/Edge 113+ or Safari 18+.';
      return result;
    }

    let adapter = null;
    try {
      adapter = await navigator.gpu.requestAdapter();
    } catch (e) {
      result.reason = 'WebGPU adapter request failed: ' + (e?.message || e);
      return result;
    }
    if (!adapter) {
      result.reason = 'No WebGPU adapter found. Your device may not have a compatible GPU.';
      return result;
    }

    result.webgpu = true;
    result.supported = true;

    try {
      if (typeof adapter.requestAdapterInfo === 'function') {
        const info = await adapter.requestAdapterInfo();
        result.gpu = {
          vendor: info.vendor || 'unknown',
          architecture: info.architecture || 'unknown',
          device: info.device || 'unknown',
          description: info.description || ''
        };
      }
    } catch {}

    if (typeof navigator.deviceMemory === 'number') {
      result.memory = navigator.deviceMemory;
    }
    if (typeof navigator.hardwareConcurrency === 'number') {
      result.cores = navigator.hardwareConcurrency;
    }

    if (result.memory === null) {
      result.warnings.push('Could not detect device RAM. Browser may not expose this info.');
    } else if (result.memory < 3) {
      result.warnings.push('Only ' + result.memory + ' GB RAM detected. On-device AI may be unstable or fail to load.');
      result.recommendation = 'cautious';
    } else if (result.memory < 6) {
      result.recommendation = 'yes';
    } else {
      result.recommendation = 'yes';
    }

    if (result.cores !== null && result.cores < 4) {
      result.warnings.push('Only ' + result.cores + ' CPU cores. Generation speed may be slow.');
    }

    return result;
  }

  async function ensureWebLLMLoaded() {
    if (webllmLib) return webllmLib;
    try {
      webllmLib = await import(/* @vite-ignore */ WEBLLM_LIB_URL);
    } catch (e) {
      throw new Error('Could not load WebLLM library: ' + (e?.message || e));
    }
    return webllmLib;
  }

  function getWebLLMStatus() {
    return {
      state: webllmLoadState,
      loadedModel: webllmLoadedModel,
      progress: webllmLoadProgress,
      error: webllmLoadError ? (webllmLoadError.message || String(webllmLoadError)) : null
    };
  }

  async function loadWebLLMModel(modelId, onProgress) {
    if (webllmEngine && webllmLoadedModel === modelId && webllmLoadState === 'loaded') {
      return webllmEngine;
    }
    if (webllmLoadPromise && webllmLoadState === 'loading' && !webllmAbortFlag) {
      return webllmLoadPromise;
    }

    webllmAbortFlag = false;
    webllmLoadState = 'loading';
    webllmLoadError = null;
    webllmLoadProgress = { text: 'Preparing…', progress: 0 };
    if (onProgress) onProgress({ text: 'Preparing…', progress: 0 });

    webllmLoadPromise = (async () => {
      try {
        if (onProgress) onProgress({ text: 'Loading AI library…', progress: null });
        const lib = await ensureWebLLMLoaded();
        if (webllmAbortFlag) throw new Error('__aborted__');
        if (webllmEngine && webllmLoadedModel === modelId) {
          webllmLoadState = 'loaded';
          return webllmEngine;
        }
        const engine = await lib.CreateMLCEngine(modelId, {
          initProgressCallback: (report) => {
            webllmLoadProgress = { text: report.text || '', progress: typeof report.progress === 'number' ? report.progress : null };
            if (onProgress) onProgress(report);
          }
        });
        if (webllmAbortFlag) {
          webllmLoadState = 'idle';
          throw new Error('__aborted__');
        }
        webllmEngine = engine;
        webllmLoadedModel = modelId;
        webllmLoadState = 'loaded';
        webllmLoadProgress = { text: 'Ready', progress: 1 };
        return engine;
      } catch (e) {
        if (e?.message === '__aborted__') {
          webllmLoadState = 'idle';
        } else {
          webllmLoadState = 'error';
          webllmLoadError = e;
        }
        throw e;
      }
    })();

    return webllmLoadPromise;
  }

  async function downloadWebLLMModel(modelId, onProgress) {
    return loadWebLLMModel(modelId, onProgress);
  }

  function isWebLLMModelCached(modelId) {
    if (!webllmLib || !webllmLib.hasModelInCache) return null;
    try {
      return webllmLib.hasModelInCache(modelId);
    } catch {
      return null;
    }
  }

  async function chat({ messages, newsArticles, signal, onChunk, onDone, onError, onLoadProgress }) {
    const cfg = getProviderConfig();
    if (cfg.provider === 'ollama') {
      return chatOllama({ messages, newsArticles, signal, onChunk, onDone, onError });
    }
    if (cfg.provider === 'webllm') {
      return chatWebLLM({ messages, newsArticles, signal, onChunk, onDone, onError, onLoadProgress });
    }
    if (cfg.provider === 'cloud') {
      return chatCloud({ messages, newsArticles, signal, onChunk, onDone, onError });
    }
    const err = new Error('Unsupported provider: ' + cfg.provider);
    if (onError) onError(err);
    throw err;
  }

  async function chatOllama({ messages, newsArticles, signal, onChunk, onDone, onError }) {
    const cfg = getProviderConfig();
    const base = normalizeBase(cfg.address);
    if (!base) {
      const err = new Error('Ollama address is not set. Open Settings → AI Chat to configure it.');
      if (onError) onError(err);
      throw err;
    }
    if (!cfg.model) {
      const err = new Error('Ollama model is not set. Open Settings → AI Chat to choose a model.');
      if (onError) onError(err);
      throw err;
    }
    const url = base + '/api/chat';

    const context = buildNewsContext(newsArticles, cfg.contextCount);
    const systemPrompt = buildSystemPrompt(context);
    const fullMessages = [
      { role: 'system', content: systemPrompt },
      ...messages
    ];

    const controller = new AbortController();
    currentAbort = controller;
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    if (signal) {
      if (signal.aborted) controller.abort();
      signal.addEventListener('abort', () => controller.abort());
    }

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: cfg.model,
          messages: fullMessages,
          stream: true,
          options: { temperature: 0.7, num_ctx: 4096 }
        }),
        signal: controller.signal
      });
      clearTimeout(timeoutId);
      if (!res.ok) {
        let detail = '';
        try { detail = (await res.text()).slice(0, 200); } catch {}
        throw new Error('Ollama returned HTTP ' + res.status + (detail ? ' — ' + detail : ''));
      }
      if (!res.body) throw new Error('Ollama response has no body');

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let assembled = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newlineIdx;
        while ((newlineIdx = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newlineIdx).trim();
          buffer = buffer.slice(newlineIdx + 1);
          if (!line) continue;
          try {
            const obj = JSON.parse(line);
            const piece = obj?.message?.content;
            if (piece) {
              assembled += piece;
              if (onChunk) onChunk(piece, assembled);
            }
            if (obj?.done) {
              if (onDone) onDone(assembled, obj);
              currentAbort = null;
              return assembled;
            }
            if (obj?.error) {
              throw new Error(obj.error);
            }
          } catch (parseErr) {
            if (parseErr instanceof Error && parseErr.message && parseErr.message !== 'Unexpected end of JSON input') {
              throw parseErr;
            }
          }
        }
      }
      if (onDone) onDone(assembled, null);
      currentAbort = null;
      return assembled;
    } catch (e) {
      clearTimeout(timeoutId);
      currentAbort = null;
      if (e.name === 'AbortError') {
        const err = new Error('__aborted__');
        if (onError) onError(err);
        throw err;
      }
      if (onError) onError(e);
      throw e;
    }
  }

  async function chatWebLLM({ messages, newsArticles, signal, onChunk, onDone, onError, onLoadProgress }) {
    const cfg = getProviderConfig();
    const modelId = cfg.webllmModel;
    if (!modelId || !WEBLLM_MODELS[modelId]) {
      const err = new Error('Unknown WebLLM model: ' + modelId);
      if (onError) onError(err);
      throw err;
    }

    let engine;
    try {
      engine = await loadWebLLMModel(modelId, (report) => {
        if (onLoadProgress) onLoadProgress({ text: report.text || '', progress: typeof report.progress === 'number' ? report.progress : null });
      });
    } catch (e) {
      if (e?.message === '__aborted__') {
        const err = new Error('__aborted__');
        if (onError) onError(err);
        throw err;
      }
      if (onError) onError(e);
      throw e;
    }

    // On-device models are slow on mobile — use less context to reduce prefill cost
    const ctxCount = Math.min(cfg.contextCount, 10);
    const context = buildNewsContext(newsArticles, ctxCount);
    const systemPrompt = buildSystemPrompt(context);
    const fullMessages = [
      { role: 'system', content: systemPrompt },
      ...messages
    ];

    currentAbort = { aborted: false };
    if (signal) {
      if (signal.aborted) currentAbort.aborted = true;
      signal.addEventListener('abort', () => { currentAbort.aborted = true; });
    }

    // Yield to the UI thread before the prefill blocks the GPU pipeline
    await sleep(10);

    try {
      const asyncGenerator = await engine.chat.completions.create({
        messages: fullMessages,
        stream: true,
        temperature: 0.7,
        max_tokens: 512
      });
      let assembled = '';
      let yieldCounter = 0;
      for await (const chunk of asyncGenerator) {
        if (currentAbort.aborted) break;
        const delta = chunk?.choices?.[0]?.delta?.content;
        if (delta) {
          assembled += delta;
          if (onChunk) onChunk(delta, assembled);
        }
        // Yield to the UI thread every few tokens so animations and scrolling stay smooth
        if (++yieldCounter % 4 === 0) await sleep(0);
      }
      if (currentAbort.aborted) {
        const err = new Error('__aborted__');
        if (onError) onError(err);
        throw err;
      }
      if (onDone) onDone(assembled, null);
      currentAbort = null;
      return assembled;
    } catch (e) {
      currentAbort = null;
      if (e?.message === '__aborted__') {
        const err = new Error('__aborted__');
        if (onError) onError(err);
        throw err;
      }
      if (onError) onError(e);
      throw e;
    }
  }

  async function chatCloud({ messages, newsArticles, signal, onChunk, onDone, onError }) {
    const cfg = getProviderConfig();
    const base = cfg.cloudEndpoint;
    const key = cfg.cloudKey;
    const model = cfg.cloudModel;
    if (!key) {
      const err = new Error('API key is not set. Open Settings → AI Chat to configure it.');
      if (onError) onError(err);
      throw err;
    }
    const url = base + '/chat/completions';

    const context = buildNewsContext(newsArticles, cfg.contextCount);
    const systemPrompt = buildSystemPrompt(context);
    const fullMessages = [
      { role: 'system', content: systemPrompt },
      ...messages
    ];

    const controller = new AbortController();
    currentAbort = controller;
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    if (signal) {
      if (signal.aborted) controller.abort();
      signal.addEventListener('abort', () => controller.abort());
    }

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + key
        },
        body: JSON.stringify({
          model,
          messages: fullMessages,
          stream: true,
          temperature: 0.7,
          max_tokens: 2048
        }),
        signal: controller.signal
      });
      clearTimeout(timeoutId);
      if (!res.ok) {
        let detail = '';
        try { detail = (await res.text()).slice(0, 300); } catch {}
        throw new Error('API returned HTTP ' + res.status + (detail ? ' — ' + detail : ''));
      }
      if (!res.body) throw new Error('API response has no body');

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let assembled = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let lineIdx;
        while ((lineIdx = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, lineIdx).trim();
          buffer = buffer.slice(lineIdx + 1);
          if (!line || line.startsWith(':')) continue;
          if (line === 'data: [DONE]') {
            if (onDone) onDone(assembled, null);
            currentAbort = null;
            return assembled;
          }
          if (line.startsWith('data: ')) {
            const jsonStr = line.slice(6);
            try {
              const obj = JSON.parse(jsonStr);
              const delta = obj?.choices?.[0]?.delta?.content;
              if (delta) {
                assembled += delta;
                if (onChunk) onChunk(delta, assembled);
              }
              if (obj?.choices?.[0]?.finish_reason) {
                if (onDone) onDone(assembled, obj);
                currentAbort = null;
                return assembled;
              }
            } catch (parseErr) {
              if (parseErr instanceof SyntaxError) continue;
              throw parseErr;
            }
          }
        }
      }
      if (onDone) onDone(assembled, null);
      currentAbort = null;
      return assembled;
    } catch (e) {
      clearTimeout(timeoutId);
      currentAbort = null;
      if (e.name === 'AbortError') {
        const err = new Error('__aborted__');
        if (onError) onError(err);
        throw err;
      }
      if (onError) onError(e);
      throw e;
    }
  }

  function abort() {
    if (webllmLoadState === 'loading') {
      webllmAbortFlag = true;
    }
    if (currentAbort) {
      if (typeof currentAbort.abort === 'function') {
        try { currentAbort.abort(); } catch {}
      } else {
        currentAbort.aborted = true;
      }
      currentAbort = null;
    }
  }

  function isAbortedError(e) {
    return e && e.message === '__aborted__';
  }

  return {
    buildNewsContext,
    buildSystemPrompt,
    testConnection,
    testOllamaConnectionAt,
    checkWebGPUSupport,
    loadWebLLMModel,
    downloadWebLLMModel,
    isWebLLMModelCached,
    getWebLLMStatus,
    webllmModels: WEBLLM_MODELS,
    chat,
    abort,
    isAbortedError,
    loadHistory,
    saveHistory,
    clearHistory,
    getProviderConfig
  };
})();
