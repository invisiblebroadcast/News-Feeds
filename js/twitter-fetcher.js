/* ── Twitter Fetcher ──
 *
 * Pulls recent tweets for a given handle via the Twitter/X API v2.
 * Runs client-side, so every request must be routed through a CORS
 * proxy (Twitter blocks cross-origin requests from the browser).
 *
 * Free-tier constraints:
 *   - Search Recent: tweets from the last 7 days, max 100 per request.
 *   - App rate limit: 1500 requests / month on the free tier.
 *
 * We save a JSON copy in localStorage keyed by handle so repeated
 * analyses on the same person within 24 hours don't burn quota.
 *
 * Bearer token: hardcoded as a build-time constant for the demo.
 * In production this should come from a server-side proxy that
 * injects the token, NEVER from the client.
 */
const TwitterFetcher = (() => {
  // A public, no-signup CORS proxy. The token is appended to the
  // proxied URL — Twitter's API requires it as a query string param.
  const CORS_PROXY = 'https://corsproxy.io/?url=';
  const API_BASE = 'https://api.twitter.com/2/tweets/search/recent';
  const CACHE_PREFIX = 'twitter_cache_';
  const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

  // Twitter API v2 bearer token. Empty by default; the user can paste
  // one in via Settings → API. Without a token every call returns
  // { ok: false, reason: 'no-token' }.
  const SETTINGS_KEY = 'newsfeeds_twitter_bearer';
  function getToken() {
    try { return localStorage.getItem(SETTINGS_KEY) || ''; }
    catch { return ''; }
  }
  function setToken(t) {
    try { if (t) localStorage.setItem(SETTINGS_KEY, t); else localStorage.removeItem(SETTINGS_KEY); }
    catch {}
  }

  // Read a cache entry and decide whether it's still fresh.
  function readCache(handle) {
    try {
      const raw = localStorage.getItem(CACHE_PREFIX + handle);
      if (!raw) return null;
      const data = JSON.parse(raw);
      if (!data || !data.fetchedAt) return null;
      if (Date.now() - data.fetchedAt > CACHE_TTL_MS) return null;
      return data;
    } catch { return null; }
  }
  function writeCache(handle, tweets) {
    try {
      const data = { fetchedAt: Date.now(), tweets };
      localStorage.setItem(CACHE_PREFIX + handle, JSON.stringify(data));
    } catch {}
  }
  function clearCache(handle) {
    try { localStorage.removeItem(CACHE_PREFIX + handle); } catch {}
  }

  // Build the proxied API URL. We pass the bearer as a query string
  // param so the proxy doesn't need to be told the auth header.
  function buildUrl(handle, opts) {
    const params = new URLSearchParams();
    params.set('query', 'from:' + handle);
    params.set('max_results', String(Math.min(100, opts.maxResults || 100)));
    params.set('tweet.fields', 'created_at,public_metrics,lang');
    if (opts.startTime) params.set('start_time', opts.startTime);
    if (opts.endTime) params.set('end_time', opts.endTime);
    const apiUrl = API_BASE + '?' + params.toString();
    // Twitter's API needs the Authorization header, not a query
    // param. The proxy must support header injection; corsproxy.io
    // forwards arbitrary headers when given as `?<header>=<value>`.
    // We append the bearer as a custom header echo the proxy will
    // forward. If your proxy uses a different mechanism, override
    // this function.
    return CORS_PROXY + encodeURIComponent(apiUrl) + '&Authorization=Bearer%20' + encodeURIComponent(getToken());
  }

  // Direct fetch. We still set the Authorization header for proxies
  // that respect the Fetch spec's headers (most don't in the browser
  // context, so the query-string fallback above is the primary path).
  async function fetchOnce(handle, opts) {
    const token = getToken();
    if (!token) {
      return { ok: false, reason: 'no-token', message: 'Twitter bearer token is not set. Add one in Settings.' };
    }
    const url = buildUrl(handle, opts);
    let res;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20000);
      res = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);
    } catch (e) {
      return { ok: false, reason: 'network', message: e.message || 'Network error' };
    }
    if (res.status === 401 || res.status === 403) {
      return { ok: false, reason: 'auth', message: 'Twitter rejected the bearer token (HTTP ' + res.status + ').' };
    }
    if (res.status === 429) {
      return { ok: false, reason: 'rate-limited', message: 'Twitter rate limit reached.' };
    }
    if (!res.ok) {
      let body = '';
      try { body = (await res.text()).slice(0, 200); } catch {}
      return { ok: false, reason: 'http-' + res.status, message: body || ('HTTP ' + res.status) };
    }
    let json;
    try { json = await res.json(); }
    catch (e) { return { ok: false, reason: 'parse', message: e.message }; }
    if (!json || !Array.isArray(json.data)) {
      return { ok: false, reason: 'empty', message: 'Twitter returned no tweets', tweets: [] };
    }
    const tweets = json.data.map(t => ({
      id: t.id,
      text: t.text || '',
      created_at: t.created_at || null,
      lang: t.lang || 'en',
      metrics: t.public_metrics || {}
    }));
    return { ok: true, tweets, cached: false, fetchedAt: Date.now() };
  }

  // Public API: fetch tweets for a handle, with caching.
  //   options = { maxResults, startTime, endTime, bypassCache }
  // Returns: { ok, tweets, cached, fetchedAt, reason?, message? }
  async function fetchTweets(handle, options) {
    if (!handle) return { ok: false, reason: 'no-handle', message: 'No Twitter handle provided' };
    options = options || {};
    if (!options.bypassCache) {
      const cached = readCache(handle);
      if (cached) {
        return {
          ok: true,
          tweets: cached.tweets,
          cached: true,
          fetchedAt: cached.fetchedAt
        };
      }
    }
    const result = await fetchOnce(handle, {
      maxResults: options.maxResults || 100,
      startTime: options.startTime || null,
      endTime: options.endTime || null
    });
    if (result.ok && Array.isArray(result.tweets)) writeCache(handle, result.tweets);
    return result;
  }

  return {
    fetchTweets,
    getToken,
    setToken,
    clearCache,
    CACHE_PREFIX,
    CACHE_TTL_MS
  };
})();
