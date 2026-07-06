// @ts-nocheck
/* ── Rephrase Engine (off-main-thread text generation) ──
 *
 * Uses Chrome built-in AI (window.ai) when available, otherwise
 * falls back to a Web Worker running Qwen2-0.5B-Instruct via
 * Transformers.js. The worker keeps the UI responsive.
 *
 * Usage:
 *   // Simple text rewriting
 *   const result = await Rephrase.rewrite("Original text");
 *
 *   // Article synthesis from cluster
 *   const article = await Rephrase.buildArticle(cluster);
 *
 *   // Test if generation is available
 *   console.log(await Rephrase.isAvailable());
 */

const Rephrase = (() => {
  let worker = null;
  let workerReady = false;
  let chromeAiAvailable = false;
  let _checkedAvailability = false;
  let _messageId = 0;
  const _pending = new Map();

  // ── Chrome built-in AI (window.ai) ──
  async function _checkChromeAI() {
    try {
      if (typeof window !== 'undefined' && window.ai && window.ai.languageModel) {
        const caps = await window.ai.languageModel.capabilities();
        chromeAiAvailable = caps.available !== 'no';
        return chromeAiAvailable;
      }
    } catch (e) { /* not available */ }
    chromeAiAvailable = false;
    return false;
  }

  async function _generateWithChromeAI(prompt) {
    const session = await window.ai.languageModel.create({
      temperature: 0.9,
      topK: 40,
    });
    try {
      const result = await session.prompt(prompt);
      return result;
    } finally {
      session.destroy();
    }
  }

  // ── Web Worker fallback ──
  function _getWorker() {
    if (worker) return worker;
    worker = new Worker('js/rephrase-worker.js');
    worker.onmessage = (e) => {
      const { id, status, text, error, message } = e.data;
      const p = _pending.get(id);
      if (!p) return;
      if (status === 'loading' || status === 'ready' || status === 'generating' || status === 'download-progress') {
        if (p.onProgress) p.onProgress({ status, message, progress: e.data.progress });
        return;
      }
      _pending.delete(id);
      if (status === 'done') {
        p.resolve(text);
      } else if (status === 'error') {
        p.reject(new Error(error || 'Generation failed'));
      }
    };
    worker.onerror = (err) => {
      console.warn('[Rephrase] Worker error:', err);
    };
    return worker;
  }

  function _sendToWorker(prompt, options = {}) {
    return new Promise((resolve, reject) => {
      const id = ++_messageId;
      const w = _getWorker();
      _pending.set(id, {
        resolve,
        reject,
        onProgress: options.onProgress || null,
      });
      w.postMessage({ id, prompt, options });
    });
  }

  // ── Public API ──

  async function isAvailable() {
    if (!_checkedAvailability) {
      _checkedAvailability = true;
      await _checkChromeAI();
      if (!chromeAiAvailable) {
        // Verify the worker can be created (file exists)
        try {
          const w = new Worker('js/rephrase-worker.js');
          w.terminate();
        } catch (e) {
          return false;
        }
      }
    }
    return true;
  }

  function isChromeAI() {
    return chromeAiAvailable;
  }

  /** Rewrite a single text string with fresh wording. */
  async function rewrite(text, options = {}) {
    // Completion-style prompt works for GPT-2 and instruct models alike
    const prompt = `Original:\n${text}\n\nRewritten version (different words, same meaning):\n`;
    return generate(prompt, { ...options, onProgress: options.onProgress || null });
  }

  /** Generate text from a prompt. */
  async function generate(prompt, options = {}) {
    if (chromeAiAvailable) {
      return _generateWithChromeAI(prompt);
    }
    return _sendToWorker(prompt, options);
  }

  /** Build a synthesised article from a topic cluster. */
  async function buildArticle(cluster, previousHeadline = '', options = {}) {
    const articles = cluster.articles || [];
    const sourceTexts = articles.slice(0, 8).map((a, i) => {
      const t = a.title || 'Untitled';
      const s = (a.summary || a.snippet || '').trim();
      return `SOURCE ${i + 1}: ${t}\n${s ? s.slice(0, 300) : '(no summary)'}`;
    }).join('\n\n');

    const uniquenessHint = previousHeadline
      ? `\n\nPREVIOUS VERSION headline was: "${previousHeadline}". Write a COMPLETELY DIFFERENT version.`
      : '';

    // Completion-style: GPT-2 naturally continues text after "ARTICLE:".
    const prompt = `Synthesize the following news sources into one clear article.\n\n${sourceTexts}${uniquenessHint}\n\nARTICLE:\nHeadline: `;

    return generate(prompt, {
      maxTokens: 400,
      temperature: 0.85 + Math.random() * 0.15,
      onProgress: options.onProgress || null,
    });
  }

  /** Quick test — rewrites a sample sentence and logs result. */
  async function test() {
    console.log('[Rephrase] Testing text generation\u2026');
    const sample = 'The government announced a new climate policy that aims to reduce carbon emissions by 50% by 2035.';
    try {
      const result = await rewrite(sample, { maxTokens: 100 });
      console.log('[Rephrase] Original:', sample);
      console.log('[Rephrase] Rewritten:', result);
      return result;
    } catch (err) {
      console.warn('[Rephrase] Test failed:', err?.message);
      throw err;
    }
  }

  // Clean up worker on page unload
  if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', () => {
      if (worker) { worker.terminate(); worker = null; }
    });
  }

  return {
    isAvailable,
    isChromeAI,
    generate,
    rewrite,
    buildArticle,
    test,
  };
})();

if (typeof window !== 'undefined') {
  window.Rephrase = Rephrase;
}
