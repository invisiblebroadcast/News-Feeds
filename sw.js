/* Invisible Broadcast — service worker
 *
 * Strategy:
 *   - App shell (HTML, CSS, JS, icons, manifest, feeds.json) is
 *     pre-cached on install and served cache-first. This makes the
 *     install prompt reliable and lets the app launch offline (with
 *     whatever feed list was bundled at install time).
 *   - External requests (RSS, CORS proxies, rss2json, Supabase, Twitter)
 *     are network-only. We don't try to cache feed data because it's
 *     time-sensitive and large. Network failures fall through to the
 *     shell so the user at least sees the UI with the existing cache.
 *
 * Bump CACHE_VERSION whenever the app shell changes (HTML/CSS/JS or
 * feeds.json with new sources) so the activate step can clean up
 * the old cache and re-fetch. feeds.json is included in the shell
 * deliberately — when we add new global sources we want the next
 * app launch to pick them up immediately, not after the user
 * happens to do a hard reload.
 */
const CACHE_VERSION = 'ib-v29';
const SHELL_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './data/feeds.json',
  './css/styles.css',
  './js/settings.js',
  './js/source-health.js',
  './js/supabase-store.js',
  './js/feeds.js',
  './js/article-archive.js',
  './js/fetcher.js',
  './js/translator.js',
  './js/subjects.js',
  './js/analyzer.js',
  './js/ai.js',
  './js/twitter-fetcher.js',
  './js/scoring-engine.js',
  './js/analyze-modal.js',
  './js/filter-modal.js',
  './js/categories-modal.js',
  './js/app.js',
  './js/app-home.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
  './icons/icon.svg',
  './icons/social-3000x3000.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then(cache => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Same-origin requests: cache-first, fall back to network, then cache.
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(req).then(cached => {
        if (cached) return cached;
        return fetch(req).then(res => {
          // Only cache successful basic responses so we don't poison
          // the cache with 404s or opaque responses.
          if (res && res.status === 200 && res.type === 'basic') {
            const copy = res.clone();
            caches.open(CACHE_VERSION).then(c => c.put(req, copy));
          }
          return res;
        }).catch(() => {
          // Offline fallback for navigations: serve the app shell so
          // the PWA launches even with no network.
          if (req.mode === 'navigate') return caches.match('./index.html');
          return cached || Response.error();
        });
      })
    );
    return;
  }

  // Cross-origin: network only. RSS feeds, Supabase, Gemini etc. are
  // time-sensitive and we don't want a stale cached response.
  // (We don't intercept; the default fetch behaviour is fine.)
});
