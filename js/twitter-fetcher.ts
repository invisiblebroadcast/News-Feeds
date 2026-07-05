// @ts-nocheck
/* ── Twitter Fetcher (Nitter-backed) ──
 *
 * Pulls recent tweets for a given handle via a public Nitter
 * instance. Nitter is a free, open-source Twitter frontend that
 * doesn't require a bearer token or any auth. The user said
 * "switch to Nitter" — this trades the official Twitter v2 API
 * (which needed a token and had a 7-day / 1500-req-month cap)
 * for a more pragmatic data source.
 *
 * Architecture:
 *   1. Try one of the public Nitter instances for the user's
 *      RSS feed. Each instance has the same URL pattern
 *      (`/[handle]/rss` and, where supported, `/[handle]/api/tweets`)
 *      but uptime and rate limits vary, so we rotate.
 *   2. The CORS proxy (`corsproxy.io`) is still required because
 *      Nitter instances don't send CORS headers.
 *   3. We parse the RSS XML with DOMParser (same as FeedFetcher
 *      for news feeds) and shape the items into our internal
 *      tweet format.
 *   4. The result is cached in localStorage with a 24-hour
 *      TTL (same as before) so repeated analyses on the same
 *      person within a day don't hit any Nitter instance.
 *
 * Nitter instance list — these are public, well-known mirrors.
 * If one is down the next one is tried. Order matters: we hit
 * the most reliable one first to fail fast.
 */
const TwitterFetcher = (() => {
  const CORS_PROXY = 'https://corsproxy.io/?url=';
  const CACHE_PREFIX = 'twitter_cache_';
  const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

  // Public Nitter instances. These are volunteer-run mirrors of
  // the open-source Nitter project. They come and go; the user
  // can update this list as the ecosystem changes. Tried in
  // order — first success wins.
  const NITTER_INSTANCES = [
    'https://nitter.net',
    'https://nitter.poast.org',
    'https://nitter.privacydev.net',
    'https://nitter.lucabased.xyz',
    'https://nitter.1d4.us'
  ];

  // Endpoint patterns to try against each instance, in order.
  // Most instances expose RSS at /[handle]/rss; some have a JSON
  // /api/tweets route. We try the JSON one first (cheaper to
  // parse) and fall back to RSS.
  const ENDPOINT_PATHS = [
    h => `/${h}/api/tweets.json?limit=100`,
    h => `/${h}/rss`
  ];

  // ── Caching (unchanged from the previous bearer-token version) ──
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

  // Build the full ordered list of URLs to try: for every
  // instance, for every endpoint pattern. We try the most-
  // likely-to-work combination first (primary instance + JSON
  // endpoint), then fall back through the rest.
  function buildTryOrder(handle) {
    const h = String(handle || '').replace(/^@/, '').trim();
    if (!h) return [];
    const out = [];
    for (const instance of NITTER_INSTANCES) {
      for (const pathFn of ENDPOINT_PATHS) {
        out.push(instance + pathFn(h));
      }
    }
    return out;
  }

  // Parse a Nitter RSS feed (XML) into our internal tweet shape.
  // The RSS structure for a Nitter user feed is:
  //   <rss>
  //     <channel>
  //       <item>
  //         <title>tweet text</title>
  //         <link>https://nitter.net/user/status/123</link>
  //         <pubDate>Wed, 15 Jan 2025 12:34:56 GMT</pubDate>
  //         <description>HTML with media, mentions, etc.</description>
  //         <guid>https://nitter.net/user/status/123</guid>
  //       </item>
  //     </channel>
  //   </rss>
  function parseRss(xmlText, handle) {
    if (typeof DOMParser === 'undefined') return [];
    const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
    // Bail out on parse errors (DOMParser returns a doc with an
    // <parsererror> element when the XML is malformed).
    if (doc.querySelector('parsererror')) return [];
    const items = doc.querySelectorAll('item');
    const out = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const title = (item.querySelector('title')?.textContent || '').trim();
      const link = (item.querySelector('link')?.textContent || '').trim();
      const pubDate = (item.querySelector('pubDate')?.textContent || '').trim();
      const description = (item.querySelector('description')?.textContent || '').trim();
      if (!title) continue;
      // Strip HTML from the description and use it as additional
      // context (e.g. quoted tweets, media alt-text). The text
      // itself is in <title>.
      const descriptionText = description
        ? description.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
        : '';
      const text = descriptionText && descriptionText !== title
        ? title + ' ' + descriptionText
        : title;
      out.push({
        id: link || (handle + '#' + i),
        text,
        created_at: pubDate ? new Date(pubDate).toISOString() : null,
        lang: 'en',
        // Nitter RSS doesn't expose public metrics. Leave as
        // an empty object so the rest of the scoring engine
        // (which uses metrics for engagement weighting) degrades
        // gracefully.
        metrics: {},
        source_url: link || null
      });
    }
    return out;
  }

  // Parse a Nitter JSON feed (if the instance exposes /api/tweets.json).
  // The shape is loosely:
  //   { "tweets": [{ "id": "...", "text": "...", "date": "...", "likes": N, "retweets": N, "replies": N, "link": "..." }, ...] }
  // but varies by instance/version. We accept any of the common
  // field names.
  function parseNitterJson(json, handle) {
    if (!json || typeof json !== 'object') return [];
    const list = json.tweets || json.data || json || [];
    if (!Array.isArray(list)) return [];
    const out = [];
    for (let i = 0; i < list.length; i++) {
      const t = list[i] || {};
      const text = (t.text || t.content || t.tweet || '').toString().trim();
      if (!text) continue;
      const id = (t.id || t.tweet_id || (handle + '#' + i)).toString();
      const date = t.date || t.created_at || t.time || null;
      const createdAt = date ? new Date(date).toISOString() : null;
      out.push({
        id,
        text,
        created_at: createdAt,
        lang: t.lang || 'en',
        metrics: {
          like_count: Number(t.likes || t.favorite_count || t.like_count) || 0,
          retweet_count: Number(t.retweets || t.retweet_count) || 0,
          reply_count: Number(t.replies || t.reply_count) || 0
        },
        source_url: t.link || t.url || null
      });
    }
    return out;
  }

  // Try a single URL, returning a normalised result object.
  // Returns null on any failure (network, HTTP error, parse
  // error, empty body) so the caller can move to the next URL.
  async function tryUrl(url) {
    const proxied = CORS_PROXY + encodeURIComponent(url);
    let res;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
      res = await fetch(proxied, { signal: controller.signal });
      clearTimeout(timer);
    } catch (e) {
      return null;
    }
    if (!res.ok) return null;
    const text = await res.text().catch(() => '');
    if (!text || text.length < 10) return null;
    // Try JSON first (faster, cheaper to parse). Nitter's
    // /api/tweets.json returns the tweets array directly or
    // wrapped in {tweets: [...]}. Fall back to RSS if the
    // response isn't JSON.
    const trimmed = text.trim();
    if (trimmed[0] === '{' || trimmed[0] === '[') {
      try {
        const json = JSON.parse(trimmed);
        const handle = url.split('/').slice(-2, -1)[0];
        const tweets = parseNitterJson(json, handle);
        if (tweets.length) return tweets;
      } catch (e) { /* not JSON, fall through */ }
    }
    if (trimmed.startsWith('<')) {
      const handle = url.split('/').slice(-2, -1)[0];
      const tweets = parseRss(text, handle);
      if (tweets.length) return tweets;
    }
    return null;
  }

  // The main fetch loop: try every (instance, endpoint)
  // combination in order, return the first one that produces
  // any tweets. Returns null only if every combination fails.
  async function fetchOnce(handle) {
    const urls = buildTryOrder(handle);
    const tried = [];
    for (const url of urls) {
      const tweets = await tryUrl(url);
      tried.push(url);
      if (tweets && tweets.length) {
        return { ok: true, tweets, cached: false, fetchedAt: Date.now(), source: url };
      }
    }
    return {
      ok: false,
      reason: 'all-instances-failed',
      message: 'All Nitter instances failed to return tweets. ' +
        'Tried: ' + tried.slice(0, 4).map(u => new URL(u).host).join(', ') + (tried.length > 4 ? ', ...' : ''),
      triedUrls: tried
    };
  }

  // Public API: fetch tweets for a handle, with caching.
  //   options = { maxResults, startTime, endTime, bypassCache }
  //   - maxResults, startTime, endTime: accepted for API compat
  //     with the previous bearer-token version, but Nitter
  //     doesn't support custom date ranges (it returns whatever
  //     the instance currently has). They're ignored.
  //   - bypassCache: re-fetch even if a fresh cache entry exists.
  // Returns: { ok, tweets, cached, fetchedAt, source?, reason?, message? }
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
    const result = await fetchOnce(handle);
    if (result.ok && Array.isArray(result.tweets)) writeCache(handle, result.tweets);
    return result;
  }

  return {
    fetchTweets,
    clearCache,
    CACHE_PREFIX,
    CACHE_TTL_MS,
    NITTER_INSTANCES
  };
})();

// Expose on window — see js/feeds.js for the rationale.
window.TwitterFetcher = TwitterFetcher;
