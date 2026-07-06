// Web Worker for text generation — runs off the main thread so the UI
// never freezes. Loads Qwen2-0.5B-Instruct via Transformers.js on first
// call (one-time ~500MB download, cached by the browser).
//
// Message format (main → worker):
//   { id, prompt, options: { maxTokens, temperature } }
//
// Message format (worker → main):
//   { id, status: 'loading'|'ready'|'generating'|'done'|'error', text?, error?, message? }

(async () => {
  let generator = null;
  let modelLoading = false;

  self.onmessage = async function (e) {
    const { id, prompt, options } = e.data;
    if (!prompt) { self.postMessage({ id, status: 'error', error: 'No prompt provided' }); return; }

    try {
      // ── Lazy-load the model on first invocation ──
      if (!generator && !modelLoading) {
        modelLoading = true;
        self.postMessage({ id, status: 'loading', message: 'Downloading AI model (~500MB, one-time\u2026)' });

        const { pipeline } = await import('https://esm.sh/@huggingface/transformers@3.4.2');
        generator = await pipeline('text-generation', 'Xenova/Qwen2-0.5B-Instruct', {
          max_new_tokens: options?.maxTokens || 300,
          do_sample: true,
        });
        modelLoading = false;
        self.postMessage({ id, status: 'ready', message: 'AI model ready' });
      }

      if (!generator) { self.postMessage({ id, status: 'error', error: 'Model failed to load' }); return; }

      self.postMessage({ id, status: 'generating', message: 'Generating article\u2026' });

      const result = await generator(prompt, {
        max_new_tokens: options?.maxTokens || 300,
        temperature: options?.temperature ?? 0.9,
        top_p: 0.95,
        do_sample: true,
        repetition_penalty: 1.1,
      });

      const text = Array.isArray(result) ? (result[0]?.generated_text || '') : (result?.generated_text || '');
      self.postMessage({ id, status: 'done', text });
    } catch (err) {
      self.postMessage({ id, status: 'error', error: err?.message || 'Generation failed' });
    }
  };
})();
