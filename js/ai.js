/* ── AI module (deterministic helpers only) ──
 *
 * The app used to call Google's Gemini API for ranking, but the
 * whole module has been gutted. Only the deterministic, rule-based
 * helpers below remain:
 *
 *   - detectConflicts(articles)
 *       Finds articles that report conflicting numbers/claims and
 *       clusters them. Delegates to Analyzer.
 *
 *   - computeTrendingInfo(articles, fullCorpus)
 *       Annotates each article with `_trendingKeywords` (top shared
 *       terms) and `_trendingCount` (number of other articles in the
 *       same scope that share those terms). Used to surface
 *       "Trending · N" badges in the live feed.
 *
 *   - tokenize(text)
 *       Lowercase, strip punctuation, drop stopwords. Used by the
 *       trending computation and available to other modules.
 *
 *   - formatDateShort(d) / todayStr() / yesterdayStr()
 *       Date helpers. todayStr/yesterdayStr are still used elsewhere
 *       in the app.
 *
 *   - stripHtml(html)
 *       Strips HTML tags. (Many callers re-implement this; we keep
 *       it exported for the Analyzer and any future uses.)
 *
 * No external services, no network calls, no LLMs.
 */
const AI = (() => {
  const STOPWORDS = new Set((
    'a an and or the of in to for on with at by from as is are was were be been ' +
    'being have has had do does did this that these those it its their there here ' +
    'i me my we us our you your he him his she her they them what which who whom ' +
    'about into over under between after before also one two three would could should ' +
    'will can may might must shall not no nor so if than then but because while when ' +
    'where how why out up off down just only very more most some such any all each ' +
    'new said says say tell told now today yesterday tomorrow amid amid per via'
  ).split(/\s+/));

  function tokenize(text) {
    if (!text) return [];
    return String(text)
      .toLowerCase()
      .replace(/https?:\/\/\S+/g, ' ')
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(t => t && t.length > 2 && !STOPWORDS.has(t) && !/^\d+$/.test(t));
  }

  function stripHtml(html) {
    const div = document.createElement('div');
    div.innerHTML = html == null ? '' : String(html);
    return (div.textContent || div.innerText || '').trim();
  }

  function formatDateShort(d) {
    const date = new Date(d);
    if (isNaN(date.getTime())) return d;
    const diff = Date.now() - date.getTime();
    if (diff < 0) {
      const futureMins = Math.floor(-diff / 60000);
      if (futureMins < 60) return 'in ' + futureMins + 'm';
      const futureHours = Math.floor(futureMins / 60);
      if (futureHours < 24) return 'in ' + futureHours + 'h';
      return '~ ' + date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
    }
    const mins = Math.floor(diff / 60000);
    if (mins < 60) return mins + 'm ago';
    const hours = Math.floor(mins / 60);
    if (hours < 24) return hours + 'h ago';
    const days = Math.floor(hours / 24);
    if (days < 7) return days + 'd ago';
    return date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
  }

  function todayStr() {
    const d = new Date();
    const ist = new Date(d.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const y = ist.getFullYear();
    const m = String(ist.getMonth() + 1).padStart(2, '0');
    const dd = String(ist.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + dd;
  }

  function yesterdayStr() {
    const d = new Date();
    const ist = new Date(d.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    ist.setDate(ist.getDate() - 1);
    const y = ist.getFullYear();
    const m = String(ist.getMonth() + 1).padStart(2, '0');
    const dd = String(ist.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + dd;
  }

  function detectConflicts(articles) {
    if (window.Analyzer && typeof Analyzer.detectConflicts === 'function') {
      return Analyzer.detectConflicts(articles);
    }
    return new Map();
  }

  function computeTrendingInfo(articles, fullCorpus) {
    if (!Array.isArray(articles) || !Array.isArray(fullCorpus)) return;
    const counts = new Map();
    for (const a of fullCorpus) {
      const tokens = new Set(tokenize((a.title || '') + ' ' + (a.summary || '')));
      for (const t of tokens) counts.set(t, (counts.get(t) || 0) + 1);
    }
    // "Trending" = word that appears in 2+ articles in the corpus.
    const trending = new Set();
    for (const [t, c] of counts) if (c >= 2) trending.add(t);

    for (const a of articles) {
      const tokens = tokenize((a.title || '') + ' ' + (a.summary || ''));
      const matches = new Set();
      for (const t of tokens) if (trending.has(t)) matches.add(t);
      a._trendingKeywords = [...matches].slice(0, 4);
      // Count of OTHER articles in the corpus that share any of these
      // trending keywords (used as a "trending in N other articles" badge).
      let c = 0;
      const seen = new Set();
      for (const b of fullCorpus) {
        if (b === a) continue;
        if (seen.has(b.link)) continue;
        const btoks = tokenize((b.title || '') + ' ' + (b.summary || ''));
        let shared = false;
        for (const t of btoks) {
          if (matches.has(t)) { shared = true; break; }
        }
        if (shared) { c++; seen.add(b.link); }
      }
      a._trendingCount = c;
    }
  }

  return {
    tokenize,
    stripHtml,
    formatDateShort,
    todayStr,
    yesterdayStr,
    detectConflicts,
    computeTrendingInfo
  };
})();

// Expose on window — see js/feeds.js for the rationale.
window.AI = AI;
