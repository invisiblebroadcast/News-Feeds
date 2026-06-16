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

    // Retry on 429 (rate limit) with exponential backoff.
    let attempt = 0;
    const maxAttempts = 3;
    while (attempt < maxAttempts) {
      attempt++;
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
        if (res.status === 429 && attempt < maxAttempts) {
          const wait = 4000 * attempt; // 4s, 8s
          console.warn('[AI] 429 rate limited, retrying in', wait, 'ms (attempt', attempt + ')');
          await sleep(wait);
          continue;
        }
        if (res.status === 429) {
          // Exhausted retries — surface as a clean, detectable error.
          throw new Error('AI rate limited — please try later');
        }
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
        if (attempt >= maxAttempts) throw e;
      }
    }
    throw new Error('AI API: max retries exceeded');
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
      // Rethrow rate limit errors so the caller can show a modal.
      if (e.message && e.message.includes('rate limited')) throw e;
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

    // Keep only top 25. If the ranked list is shorter than 25 (truncated
    // response or too few candidates), backfill with the most recent articles
    // from the full input that weren't already ranked.
    let final = result.slice(0, 25);
    if (final.length < 25) {
      const usedUrls = new Set(final.map(a => a.url));
      const remaining = articles.filter(a => !usedUrls.has(a.link || a._url || ''));
      remaining.sort((a, b) => new Date(b.pubDate || 0) - new Date(a.pubDate || 0));
      for (let i = 0; final.length < 25 && i < remaining.length; i++) {
        const a = remaining[i];
        final.push({
          rank: final.length + 1,
          title: (a.title || '').trim(),
          url: a.link || a._url || '',
          source: a.source || '',
          pubDate: a.pubDate || null,
          summary: stripHtml(a.summary || '').replace(/\s+/g, ' ').trim().slice(0, 300),
          score: 0
        });
      }
    }

    const saved = await upsertTopList(date, scope, subcat, final);
    if (!saved) {
      if (onProgress) onProgress({ step: 'error', text: 'Failed to save ranking to cloud' });
      console.warn('AI rankArticles: Supabase save failed for', scope, subcat, date);
      return null;
    }

    if (onProgress) onProgress({ step: 'done', text: saved ? 'Ranking complete' : 'Ranking saved locally' });

    return final;
  }

  /* ── Keyword-based ranking (no LLM, no Supabase) ── */

  // Weighted "alarming buzz" keywords. Higher = more urgent/breaking.
  // Matched case-insensitively as substrings against title + summary.
  const ALARMING_KEYWORDS = {
    'breaking': 10, 'just in': 10, 'urgent': 9, 'developing': 8, 'alert': 8, 'emergency': 9, 'evolving': 6,
    'earthquake': 9, 'explosion': 9, 'explodes': 9, 'wildfire': 8, 'flood': 7, 'flooding': 7,
    'typhoon': 8, 'hurricane': 8, 'tornado': 8, 'tsunami': 9, 'landslide': 8, 'avalanche': 8,
    'attack': 8, 'attacks': 8, 'killed': 9, 'kills': 8, 'dies': 7, 'death': 7, 'dead': 7, 'dying': 8,
    'shooting': 9, 'shot': 7, 'missile': 9, 'missiles': 9, 'bomb': 8, 'bombing': 9, 'war': 8, 'invasion': 9,
    'strike': 6, 'strikes': 7, 'casualties': 8, 'wounded': 7, 'injured': 6, 'massacre': 9,
    'terror': 9, 'terrorist': 8, 'terrorist attack': 10,
    'crisis': 7, 'protest': 6, 'protests': 6, 'riot': 7, 'riots': 7,
    'resign': 6, 'resigns': 6, 'resigned': 6, 'coup': 9, 'overthrow': 8,
    'evacuate': 8, 'evacuation': 8, 'hostage': 8, 'hostages': 8, 'siege': 8,
    'rescue': 6, 'trapped': 6, 'collapse': 7, 'collapsed': 7,
    'outbreak': 7, 'pandemic': 7, 'epidemic': 7, 'recall': 5,
    'scandal': 6, 'indicted': 7, 'indictment': 7, 'convicted': 7, 'arrested': 7, 'arrest': 6,
    'crash': 7, 'plunge': 6, 'plunges': 6, 'default': 6, 'sanctions': 5,
    'tragedy': 6, 'catastrophe': 8, 'catastrophic': 8, 'mayhem': 6, 'chaos': 5,
    'threat': 5, 'threatens': 6, 'warns': 5, 'warning': 5, 'leak': 5, 'spill': 4,
    'ban': 5, 'banned': 5, 'suspended': 5, 'outage': 5, 'blackout': 6,
    'supreme court': 5, 'overturned': 6, 'verdict': 5
  };

  const STOPWORDS = new Set([
    'the','a','an','and','or','but','in','on','at','to','for','of','with','by','from','as','is','was','are','were','be','been','being',
    'has','have','had','do','does','did','will','would','could','should','may','might','must','can','this','that','these','those',
    'it','its','he','she','they','them','his','her','their','we','our','you','your','i','my','me',
    'not','no','if','than','then','so','what','when','where','who','how','why','which','about','after','before','over','under','up','down','out','off',
    'new','old','first','last','next','just','also','more','most','some','any','all','each','every','other','such','only','own','same',
    'into','through','during','between','against','around','near','far','here','there','now','still','already','yet',
    'amid','says','said','say','told','tell','tells','report','reports','reported','according','claim','claims','claimed',
    'live','updates','update','news','top','watch','video','read','full','story','photos','photo','video','watch',
    'one','two','three','four','five','six','seven','eight','nine','ten','vs','per'
  ]);

  function tokenize(text) {
    if (!text) return [];
    return text.toLowerCase()
      .replace(/https?:\/\/\S+/g, ' ')
      .replace(/[^a-z0-9\s'-]/g, ' ')
      .split(/\s+/)
      .filter(w => w && w.length > 2 && !STOPWORDS.has(w) && !/^\d+$/.test(w));
  }

  /**
   * Rank articles using the deterministic Analyzer (TF-IDF + recency + buzz
   * + source authority). No LLM, no Supabase, no API calls — runs entirely
   * in the browser and adapts to the current corpus each time.
   *
   * @param {Array} articles  Pool of articles to rank.
   * @param {string} scope
   * @param {string} subcat
   * @param {Function} [onProgress]
   * @returns {Array} Top 25 ranked articles in the same shape as AI rankings
   *   ({rank, title, url, source, pubDate, summary, score}).
   */
  async function rankByKeywords(articles, scope, subcat, onProgress) {
    if (!articles || !articles.length) return null;
    if (onProgress) onProgress({ step: 'preparing', text: 'Analysing corpus…' });

    // Deduplicate by normalized title
    const seen = new Set();
    const candidates = [];
    for (const a of articles) {
      const key = (a.title || '').toLowerCase().replace(/\s+/g, ' ').trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      candidates.push(a);
    }
    if (!candidates.length) return null;

    // Hand off to the Analyzer: TF-IDF × recency × buzz × source authority,
    // plus a small additive bonus for alarming keywords.
    const ranked = Analyzer.rankByAnalyzer(candidates);

    // Map top 25 into the same shape AI rankings use.
    let final = ranked.slice(0, 25).map((entry, i) => ({
      rank: i + 1,
      title: (entry.article.title || '').trim(),
      url: entry.article.link || entry.article._url || '',
      source: entry.article.source || '',
      pubDate: entry.article.pubDate || null,
      summary: stripHtml(entry.article.summary || '').replace(/\s+/g, ' ').trim().slice(0, 300),
      score: Math.round(entry.score * 10) / 10
    }));

    // Backfill up to 25 with most-recent unranked articles.
    if (final.length < 25) {
      const usedUrls = new Set(final.map(a => a.url));
      const remaining = candidates.filter(a => !usedUrls.has(a.link || a._url || ''));
      remaining.sort((a, b) => new Date(b.pubDate || 0) - new Date(a.pubDate || 0));
      for (let i = 0; final.length < 25 && i < remaining.length; i++) {
        const a = remaining[i];
        final.push({
          rank: final.length + 1,
          title: (a.title || '').trim(),
          url: a.link || a._url || '',
          source: a.source || '',
          pubDate: a.pubDate || null,
          summary: stripHtml(a.summary || '').replace(/\s+/g, ' ').trim().slice(0, 300),
          score: 0
        });
      }
    }

    if (onProgress) onProgress({ step: 'done', text: 'Ranking complete' });
    return final;
  }

  /**
   * Detect conflicts among the given articles. Delegates to Analyzer.
   * Returns a Map<link, {isConflicting, clusterSize, conflicts:[{metric, detail}]}>.
   */
  function detectConflicts(articles) {
    return Analyzer.detectConflicts(articles);
  }

  /* ── Check if today's ranking exists ── */

  /**
   * Lightweight per-article trending info (keywords + count) computed from a
   * full corpus. Used by live mode to surface a "trending number" and by all
   * modes to populate the "where it's trending" details.
   *
   * Mutates each article in `articles`:
   *   _trendingKeywords: string[]   top 4 trending words in the article's title
   *   _trendingCount:    number     count of title words that appear in >1 article
   *
   * @param {Array} articles    Articles to annotate (e.g. the displayed list).
   * @param {Array} fullCorpus  All articles in the pool (e.g. flattened cached.groups).
   */
  function computeTrendingInfo(articles, fullCorpus) {
    if (!articles || !articles.length) return;
    const corpus = fullCorpus && fullCorpus.length ? fullCorpus : articles;
    const wordFreq = new Map();
    for (const a of corpus) {
      for (const w of tokenize(a.title || '')) {
        wordFreq.set(w, (wordFreq.get(w) || 0) + 1);
      }
    }
    for (const a of articles) {
      const titleWords = tokenize(a.title || '');
      const seen = new Set();
      const trending = [];
      let count = 0;
      for (const w of titleWords) {
        if (seen.has(w)) continue;
        seen.add(w);
        const f = wordFreq.get(w) || 0;
        if (f > 1) {
          count++;
          trending.push({ word: w, freq: f });
        }
      }
      trending.sort((x, y) => y.freq - x.freq);
      a._trendingKeywords = trending.slice(0, 4).map(t => t.word);
      a._trendingCount = count;
    }
  }

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
    rankArticles,
    rankByKeywords,
    detectConflicts,
    computeTrendingInfo,
    tokenize
  };
})();
