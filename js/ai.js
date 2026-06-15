const AI = (() => {
  const REQUEST_TIMEOUT_MS = 60000;
  const XAI_ENDPOINT = 'https://api.x.ai/v1';
  const XAI_MODEL = 'grok-3';

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

  /* ── Config ── */

  function getConfig() {
    return {
      key: XAI_KEY,
      endpoint: XAI_ENDPOINT.replace(/\/+$/, ''),
      model: XAI_MODEL
    };
  }

  /* ── xAI / OpenAI-compatible API call (non-streaming) ── */

  async function complete({ system, user, signal }) {
    const cfg = getConfig();
    console.log('[AI] complete() called, endpoint:', cfg.endpoint, 'model:', cfg.model, 'key length:', cfg.key ? cfg.key.length : 0);
    if (!cfg.key) throw new Error('AI API key not configured. Add it in Settings → AI Top List.');
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
        if (res.status === 401) throw new Error('Invalid API key. Check your key in Settings → AI Top List.');
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
      console.log('[AI] upsertTopList: saving', date, scope, subcat, '— articles count:', articles.length);
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
      console.log('[AI] upsertTopList: success, returned rows:', data ? data.length : 0);
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
    if (!articles || !articles.length) {
      console.log('[AI] rankArticles: no articles input for', scope, subcat);
      return null;
    }
    const date = todayStr();
    console.log('[AI] rankArticles:', scope, subcat, '— input articles:', articles.length);

    if (onProgress) onProgress({ step: 'preparing', text: 'Preparing articles…' });

    // Deduplicate by normalized title, take up to 100 candidates
    const seen = new Set();
    const candidates = [];
    for (const a of articles) {
      const key = (a.title || '').toLowerCase().replace(/\s+/g, ' ').trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      candidates.push(a);
      if (candidates.length >= 100) break;
    }

    if (candidates.length < 5) {
      console.log('[AI] rankArticles:', scope, subcat, '— too few candidates:', candidates.length, '(need 5+)');
      if (onProgress) onProgress({ step: 'error', text: 'Not enough articles to rank' });
      return null;
    }

    console.log('[AI] rankArticles:', scope, subcat, '— sending', candidates.length, 'candidates to xAI');
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
    } catch (e) {
      if (onProgress) onProgress({ step: 'error', text: e.message || 'Ranking failed' });
      return null;
    }

    let scores;
    try {
      scores = JSON.parse(text.trim());
      if (!Array.isArray(scores)) throw new Error('not an array');
    } catch {
      const m = text.match(/\[[\s\S]*?\]/);
      if (m) { try { scores = JSON.parse(m[0]); } catch { scores = null; } }
      else { scores = null; }
    }
    if (!Array.isArray(scores)) {
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
    console.log('[AI] rankArticles:', scope, subcat, '— saved to Supabase:', saved, 'date:', date);

    if (onProgress) onProgress({ step: 'done', text: saved ? 'Ranking complete' : 'Ranking saved locally' });

    return result;
  }

  /* ── Check if today's ranking exists ── */

  async function needsRanking(date, scope, subcat) {
    const existing = await loadTopList(date, scope, subcat);
    const needs = !existing;
    console.log('[AI] needsRanking:', date, scope, subcat, '— existing:', !!existing, '— needs:', needs);
    return needs;
  }

  return {
    stripHtml,
    formatDateShort,
    todayStr,
    getConfig,
    complete,
    upsertTopList,
    loadTopList,
    getAvailableDates,
    rankArticles,
    needsRanking
  };
})();
