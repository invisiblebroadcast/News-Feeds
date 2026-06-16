const AI = (() => {
  const REQUEST_TIMEOUT_MS = 60000;
  const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/openai';
  const GEMINI_MODEL = 'gemini-2.5-flash';

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  function stripHtml(html) {
    if (!html) return '';
    const div = document.createElement('div');
    div.innerHTML = html;
    return div.textContent || div.innerText || '';
  }

  function formatDateShort(d) {
    try {
      const date = new Date(d);
      if (isNaN(date.getTime())) return '';
      return date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
    } catch { return ''; }
  }

  function todayStr() {
    const d = new Date();
    d.setHours(d.getHours() + 5.5); // IST offset
    return d.toISOString().slice(0, 10);
  }

  function yesterdayStr() {
    const d = new Date();
    d.setHours(d.getHours() + 5.5 - 24); // IST - 1 day
    return d.toISOString().slice(0, 10);
  }

  /* ── Config ── */

  function getConfig() {
    return {
      key: GEMINI_KEY,
      endpoint: GEMINI_ENDPOINT.replace(/\/+$/, ''),
      model: GEMINI_MODEL
    };
  }

  /* ── Gemini / OpenAI-compatible API call (non-streaming) ── */

  async function complete({ system, user, signal }) {
    const cfg = getConfig();
    if (!cfg.key) throw new Error('AI API key not configured.');
    console.log('[AI] POST', cfg.endpoint + '/chat/completions', 'model:', cfg.model);
    const messages = [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ];
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const combined = signal
      ? { signal: AbortSignal.any?.([signal, controller.signal]) || signal }
      : { signal: controller.signal };
    try {
      const res = await fetch(cfg.endpoint + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cfg.key },
        body: JSON.stringify({ model: cfg.model, messages, temperature: 0.3, max_tokens: 2048 }),
        ...combined
      });
      clearTimeout(timeoutId);
      if (!res.ok) {
        let detail = '';
        try { detail = (await res.text()).slice(0, 300); } catch {}
        if (res.status === 401 || res.status === 403) throw new Error('Invalid API key or quota exhausted.');
        throw new Error('AI API returned HTTP ' + res.status + (detail ? ' — ' + detail : ''));
      }
      const data = await res.json();
      return data?.choices?.[0]?.message?.content || '';
    } catch (e) {
      clearTimeout(timeoutId);
      if (e.name === 'AbortError') throw new Error('Request timed out after 60s');
      throw e;
    }
  }

  /* ── Supabase storage for top-100 lists ── */

  const TABLE = 'top_lists';

  async function upsertTopList(date, scope, subcat, articles) {
    try {
      const client = SupabaseStore.getClient();
      const { data, error } = await client
        .from(TABLE)
        .upsert({
          date,
          scope,
          subcat,
          articles,
          updated_at: new Date().toISOString()
        }, { onConflict: 'date,scope,subcat' })
        .select();
      if (error) {
        console.warn('Supabase: upsert top_list error', error.message, '— code:', error.code, '— details:', error.details);
        return false;
      }
      return true;
    } catch (e) {
      console.warn('Supabase: upsert top_list exception', e);
      return false;
    }
  }

  async function loadTopList(date, scope, subcat) {
    try {
      const client = SupabaseStore.getClient();
      const { data, error } = await client
        .from(TABLE)
        .select('articles')
        .eq('date', date)
        .eq('scope', scope)
        .eq('subcat', subcat)
        .single();
      if (error) {
        if (error.code === 'PGRST116') return null; // not found
        console.warn('Supabase: load top_list error', error.message);
        return null;
      }
      return data?.articles || null;
    } catch (e) {
      console.warn('Supabase: load top_list exception', e);
      return null;
    }
  }

  async function getAvailableDates(scope, subcat) {
    try {
      const client = SupabaseStore.getClient();
      const { data, error } = await client
        .from(TABLE)
        .select('date')
        .eq('scope', scope)
        .eq('subcat', subcat)
        .order('date', { ascending: false })
        .limit(90);
      if (error) { console.warn('Supabase: get dates error', error.message); return []; }
      return data ? data.map(r => r.date).filter(Boolean) : [];
    } catch (e) {
      console.warn('Supabase: get dates exception', e);
      return [];
    }
  }

  /* ── AI ranking engine ── */

  async function rankArticles(articles, scope, subcat, onProgress) {
    if (!articles || !articles.length) return null;
    const date = todayStr();

    if (onProgress) onProgress({ step: 'preparing', text: 'Preparing articles…' });

    // Deduplicate by normalized title, take up to 30 candidates. Smaller batches
    // get complete responses more reliably from the model.
    const seen = new Set();
    const candidates = [];
    for (const a of articles) {
      const key = (a.title || '').toLowerCase().replace(/\s+/g, ' ').trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      candidates.push(a);
      if (candidates.length >= 30) break;
    }

    if (candidates.length < 5) {
      if (onProgress) onProgress({ step: 'error', text: 'Not enough articles to rank' });
      return null;
    }

    if (onProgress) onProgress({ step: 'ranking', text: 'AI ranking ' + candidates.length + ' articles…' });

    const items = candidates.map((a, i) => `${i}:${(a.title || '').replace(/\s+/g, ' ').trim().slice(0, 100)}`).join('\n');

    const system = 'You are a news ranking AI. Score each article 0–100 by importance:\n' +
      '90-100 = Breaking news, emergencies, war, disasters, alarming events\n' +
      '60-89  = Important stories covered by multiple sources\n' +
      '30-59  = Notable but not critical\n' +
      '0-29   = Routine or trivial\n\n' +
      'Return ONLY a JSON array of scores in the same order as the input, e.g. [85, 42, 73, …].\n' +
      'No explanations, no markdown, just the array. Exactly ' + candidates.length + ' numbers.';

    let text;
    try {
      text = await complete({ system, user: items });
      console.log('[AI] response received, length:', text.length, 'preview:', text.slice(0, 80));
    } catch (e) {
      console.warn('[AI] complete() failed:', e.message);
      if (onProgress) onProgress({ step: 'error', text: e.message || 'Ranking failed' });
      return null;
    }

    let scores;
    // Try strict parse first.
    try {
      scores = JSON.parse(text.trim());
    } catch {
      // Try to find a complete array in the text.
      const m = text.match(/\[[\s\S]*?\]/);
      if (m) { try { scores = JSON.parse(m[0]); } catch { /* fall through */ } }
    }
    // If we still don't have an array, try extracting individual numbers from a
    // truncated or malformed response like "[35, 20, 15, 95, 45, ...".
    if (!Array.isArray(scores)) {
      const nums = text.match(/-?\d+(?:\.\d+)?/g);
      if (nums && nums.length) {
        scores = nums.map(n => Number(n)).filter(n => !isNaN(n) && n >= 0 && n <= 100);
        if (scores.length) console.warn('[AI] parsed', scores.length, 'numbers from truncated response');
      }
    }
    if (!Array.isArray(scores) || !scores.length) {
      console.warn('AI rankArticles: invalid response — text:', text.slice(0, 200));
      if (onProgress) onProgress({ step: 'error', text: 'AI returned invalid format' });
      return null;
    }

    if (onProgress) onProgress({ step: 'saving', text: 'Saving to cloud…' });

    const result = candidates.map((a, i) => {
      const aiScore = typeof scores[i] === 'number' ? Math.max(0, Math.min(100, scores[i])) : 0;
      return {
        rank: 0,
        title: (a.title || '').trim(),
        url: a.link || a._url || '',
        source: a.source || '',
        pubDate: a.pubDate || null,
        summary: stripHtml(a.summary || '').replace(/\s+/g, ' ').trim().slice(0, 300),
        score: Math.round(aiScore)
      };
    });

    result.sort((a, b) => b.score - a.score);
    result.forEach((r, i) => r.rank = i + 1);

    // Keep only top 25
    result.splice(25);

    const saved = await upsertTopList(date, scope, subcat, result);
    if (!saved) {
      if (onProgress) onProgress({ step: 'error', text: 'Failed to save ranking to cloud' });
      console.warn('AI rankArticles: Supabase save failed for', scope, subcat, date);
      return null;
    }

    if (onProgress) onProgress({ step: 'done', text: saved ? 'Ranking complete' : 'Ranking saved locally' });

    return result;
  }

  /* ── Check if today's ranking exists ── */

  return {
    stripHtml,
    formatDateShort,
    todayStr,
    yesterdayStr,
    getConfig,
    complete,
    upsertTopList,
    loadTopList,
    getAvailableDates,
    rankArticles
  };
})();
