// @ts-nocheck
const FeedManager = (() => {
  let feedData = null;
  let loadPromise = null;

  // In-memory cache for the signed-in user's custom feeds.
  // Populated by loadCustomFeeds() at app start and again on every
  // SIGNED_IN event. When this is null, getCustomFeeds() falls back
  // to the localStorage value (sync) so synchronous callers (e.g.
  // article-archive's lookupLang) keep working.
  let customFeedsCache = null;
  let customFeedsLoadPromise = null;
  let signedInSyncPromise = null;

  const CUSTOM_FEEDS_KEY = 'newsfeeds_custom_feeds';
  const SELECTED_NATION_KEY = 'newsfeeds_selected_nation';
  // Supabase table that mirrors custom_feeds per user.
  // Create with:
  //   create table custom_feeds (
  //     user_id uuid references auth.users(id) on delete cascade,
  //     name text not null,
  //     url text not null,
  //     scope text not null default 'global',
  //     nation text default '',
  //     subcat text default 'politics',
  //     lang text default 'en',
  //     created_at timestamptz default now(),
  //     primary key (user_id, url)
  //   );
  //   alter table custom_feeds enable row level security;
  //   create policy "Users manage their own custom feeds" on custom_feeds
  //     for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
  const CUSTOM_FEEDS_TABLE = 'custom_feeds';

  const SUBCAT_LABELS = {
    all: 'All', politics: 'Politics & Governance', business: 'Business & Economy',
    technology: 'Technology & Innovation', science: 'Science & Research',
    health: 'Health & Medicine', sports: 'Sports & Athletics',
    entertainment: 'Culture & Entertainment', environment: 'Environment & Climate',
    education: 'Education & Academia', quotes: 'Quotes'
  };

  const SUBCAT_ICONS = {
    all: '\uD83D\uDCCA', politics: '\uD83C\uDFDB', business: '\uD83D\uDCC8',
    technology: '\uD83D\uDCBB', science: '\uD83D\uDD2C',
    health: '\u2764\uFE0F', sports: '\u26BD',
    entertainment: '\uD83C\uDFAC', environment: '\uD83C\uDF31',
    education: '\uD83C\uDF93', quotes: '\u201C'
  };

  async function load() {
    if (feedData) return feedData;
    if (loadPromise) return loadPromise;

    loadPromise = fetch('data/feeds.json')
      .then(r => { if (!r.ok) throw new Error('Failed to load feeds'); return r.json(); })
      .then(data => {
        feedData = data;
        feedData.subscribableFeeds = feedData.subscribableFeeds || [];
        return feedData;
      })
      .catch(err => { loadPromise = null; throw err; });

    return loadPromise;
  }

  function subcategories() {
    return feedData?.subcategories || [];
  }

  function subcategoriesForScope(scope) {
    return ['all', ...subcategories()];
  }

  function subcatLabel(cat, scope) {
    if (cat === 'all') return 'All';
    return SUBCAT_LABELS[cat] || cat;
  }

  function subcatIcon(cat) {
    return SUBCAT_ICONS[cat] || '\uD83C\uDFF7';
  }

  function getNations() {
    if (!feedData?.nations) return {};
    const result = {};
    for (const [key, val] of Object.entries(feedData.nations)) {
      result[key] = val.label || key;
    }
    return result;
  }

  function defaultNation() { return 'india'; }

  function getSelectedNation() {
    try { return localStorage.getItem(SELECTED_NATION_KEY) || defaultNation(); }
    catch { return defaultNation(); }
  }

  function setSelectedNation(nation) {
    localStorage.setItem(SELECTED_NATION_KEY, nation);
  }

  function getFeeds(scope, nation) {
    const feeds = [];
    const subscribedUrls = getSubscribedFeeds();

    // Custom feeds are always included (user explicitly added them)
    const custom = getCustomFeeds();
    for (const f of custom) {
      if (f.scope === 'global' && scope === 'global') feeds.push({ name: f.name, url: f.url, hint: f.subcat || 'politics', lang: f.lang || 'en' });
      if (f.scope === 'nation' && scope === 'nation' && f.nation === nation) feeds.push({ name: f.name, url: f.url, hint: f.subcat || 'politics', lang: f.lang || 'en' });
    }

    // Direct RSS feeds from subscribable list — only include subscribed ones
    const allSubs = getSubscribableFeeds();
    for (const f of allSubs) {
      if (!subscribedUrls.includes(f.url)) continue;
      if (!f.hasRss || !f.url) continue;
      if (f.scope === 'global' && scope === 'global') feeds.push({ name: f.name, url: f.url, hint: f.hint || 'politics', lang: f.lang || 'en' });
      if (f.scope === 'nation' && scope === 'nation' && f.nation === nation) feeds.push({ name: f.name, url: f.url, hint: f.hint || 'politics', lang: f.lang || 'en' });
    }

    return feeds;
  }

  function getFeedsBySubcat(scope, nation) {
    const feeds = getFeeds(scope, nation);
    const grouped = {};
    for (const f of feeds) {
      const cat = f.hint || 'politics';
      if (!grouped[cat]) grouped[cat] = [];
      grouped[cat].push(f);
    }
    return grouped;
  }

  // ── Custom feeds — Supabase is the source of truth when signed in.
  //    localStorage is just a local cache (and the only store when
  //    the user is not signed in). The on-disk cache is refreshed
  //    on every load and every add/remove, so it always reflects
  //    what the user sees.

  function _readLocalCustomFeeds() {
    try { return JSON.parse(localStorage.getItem(CUSTOM_FEEDS_KEY) || '[]'); }
    catch { return []; }
  }

  function _writeLocalCustomFeeds(feeds) {
    try { localStorage.setItem(CUSTOM_FEEDS_KEY, JSON.stringify(feeds)); } catch {}
  }

  // Sync getter used everywhere in the app. Returns the in-memory
  // cache if loaded, else the localStorage value. Always synchronous
  // so the fetcher / article-archive hot paths don't have to await.
  function getCustomFeeds() {
    if (customFeedsCache) return customFeedsCache;
    return _readLocalCustomFeeds();
  }

  // Async loader. Called at app start (after SupabaseStore is
  // ready) and again on every SIGNED_IN event. When signed in,
  // Supabase is the source of truth and we cache to localStorage.
  // When signed out, we just use whatever's in localStorage.
  async function loadCustomFeeds() {
    if (customFeedsLoadPromise) return customFeedsLoadPromise;
    customFeedsLoadPromise = (async () => {
      try {
        const local = _readLocalCustomFeeds();
        const client = (typeof SupabaseStore !== 'undefined' && SupabaseStore.getClient)
          ? SupabaseStore.getClient() : null;
        if (!client) {
          customFeedsCache = local.slice();
          return customFeedsCache;
        }
        let session = null;
        try { const r = await client.auth.getSession(); session = r?.data?.session || null; } catch {}
        if (!session) {
          customFeedsCache = local.slice();
          return customFeedsCache;
        }
        const { data, error } = await client
          .from(CUSTOM_FEEDS_TABLE)
          .select('name,url,scope,nation,subcat,lang,created_at')
          .eq('user_id', session.user.id)
          .order('created_at', { ascending: true });
        if (error) {
          console.warn('FeedManager: custom_feeds load error', error.message);
          customFeedsCache = local.slice();
          return customFeedsCache;
        }
        const remote = (data || []).map(r => ({
          name: r.name, url: r.url,
          scope: r.scope || 'global',
          nation: r.nation || '',
          subcat: r.subcat || 'politics',
          lang: r.lang || 'en'
        }));
        customFeedsCache = remote;
        _writeLocalCustomFeeds(remote);
        return customFeedsCache;
      } catch (e) {
        console.warn('FeedManager: loadCustomFeeds failed', e && e.message);
        if (!customFeedsCache) customFeedsCache = _readLocalCustomFeeds();
        return customFeedsCache;
      } finally {
        customFeedsLoadPromise = null;
      }
    })();
    return customFeedsLoadPromise;
  }

  // Add a custom feed. Updates the in-memory cache + localStorage
  // synchronously, then writes through to Supabase if signed in.
  // If Supabase is unavailable, the local copy is still kept — the
  // next SIGNED_IN sync will upload it.
  async function addCustomFeed(name, url, scope, nation, subcat, lang) {
    const feed = {
      name, url,
      scope: scope || 'global',
      nation: nation || '',
      subcat: subcat || 'politics',
      lang: lang || 'en'
    };
    if (!feed.url) return;
    // Update local mirror first (so the UI reflects it immediately).
    if (!customFeedsCache) customFeedsCache = _readLocalCustomFeeds();
    customFeedsCache = customFeedsCache.filter(f => f.url !== feed.url);
    customFeedsCache.push(feed);
    _writeLocalCustomFeeds(customFeedsCache);

    // Write through to Supabase if signed in.
    try {
      const client = (typeof SupabaseStore !== 'undefined' && SupabaseStore.getClient)
        ? SupabaseStore.getClient() : null;
      if (!client) return;
      const r = await client.auth.getSession();
      const session = r?.data?.session || null;
      if (!session) return;
      const { error } = await client
        .from(CUSTOM_FEEDS_TABLE)
        .upsert({
          user_id: session.user.id,
          name: feed.name, url: feed.url,
          scope: feed.scope, nation: feed.nation,
          subcat: feed.subcat, lang: feed.lang
        }, { onConflict: 'user_id,url' });
      if (error) console.warn('FeedManager: addCustomFeed Supabase upsert error', error.message);
    } catch (e) {
      console.warn('FeedManager: addCustomFeed Supabase write failed', e && e.message);
    }
  }

  // Remove a custom feed. Updates the in-memory cache + localStorage
  // synchronously, then deletes from Supabase if signed in.
  async function removeCustomFeed(url) {
    if (!url) return;
    if (!customFeedsCache) customFeedsCache = _readLocalCustomFeeds();
    customFeedsCache = customFeedsCache.filter(f => f.url !== url);
    _writeLocalCustomFeeds(customFeedsCache);

    try {
      const client = (typeof SupabaseStore !== 'undefined' && SupabaseStore.getClient)
        ? SupabaseStore.getClient() : null;
      if (!client) return;
      const r = await client.auth.getSession();
      const session = r?.data?.session || null;
      if (!session) return;
      const { error } = await client
        .from(CUSTOM_FEEDS_TABLE)
        .delete()
        .eq('user_id', session.user.id)
        .eq('url', url);
      if (error) console.warn('FeedManager: removeCustomFeed Supabase delete error', error.message);
    } catch (e) {
      console.warn('FeedManager: removeCustomFeed Supabase delete failed', e && e.message);
    }
  }

  // Sync any localStorage-only custom feeds up to Supabase when the
  // user signs in. We then re-read from Supabase so the in-memory
  // cache is authoritative (Supabase is the source of truth).
  async function syncCustomFeedsOnSignIn() {
    if (signedInSyncPromise) return signedInSyncPromise;
    signedInSyncPromise = (async () => {
      try {
        const client = (typeof SupabaseStore !== 'undefined' && SupabaseStore.getClient)
          ? SupabaseStore.getClient() : null;
        if (!client) return;
        const r = await client.auth.getSession();
        const session = r?.data?.session || null;
        if (!session) return;

        const local = _readLocalCustomFeeds();
        if (!local.length) {
          // Nothing to upload; just refresh the cache from Supabase.
          await loadCustomFeeds();
          return;
        }
        // Find which URLs already exist remotely so we don't fight a
        // race against a fresh upload of the same feed.
        const { data: remote, error: readErr } = await client
          .from(CUSTOM_FEEDS_TABLE)
          .select('url')
          .eq('user_id', session.user.id);
        if (readErr) {
          console.warn('FeedManager: syncCustomFeedsOnSignIn read error', readErr.message);
          return;
        }
        const remoteUrls = new Set((remote || []).map(r => r.url));
        const toUpload = local.filter(f => f.url && !remoteUrls.has(f.url));
        if (toUpload.length) {
          const rows = toUpload.map(f => ({
            user_id: session.user.id,
            name: f.name, url: f.url,
            scope: f.scope || 'global',
            nation: f.nation || '',
            subcat: f.subcat || 'politics',
            lang: f.lang || 'en'
          }));
          const { error: upErr } = await client
            .from(CUSTOM_FEEDS_TABLE)
            .upsert(rows, { onConflict: 'user_id,url' });
          if (upErr) console.warn('FeedManager: syncCustomFeedsOnSignIn upload error', upErr.message);
        }
        // Reload from Supabase so the in-memory cache is the merged
        // authoritative set.
        await loadCustomFeeds();
      } catch (e) {
        console.warn('FeedManager: syncCustomFeedsOnSignIn failed', e && e.message);
      } finally {
        signedInSyncPromise = null;
      }
    })();
    return signedInSyncPromise;
  }

  function getSubscribableFeeds() {
    return feedData?.subscribableFeeds || [];
  }

  function getSubscribedFeeds() {
    try { return JSON.parse(localStorage.getItem('newsfeeds_subscriptions') || '[]'); }
    catch { return []; }
  }

  function saveSubscribedFeeds(urls) {
    localStorage.setItem('newsfeeds_subscriptions', JSON.stringify(urls));
  }

  function isSubscribed(url) {
    return getSubscribedFeeds().includes(url);
  }

  function toggleSubscription(url) {
    const subs = getSubscribedFeeds();
    const idx = subs.indexOf(url);
    if (idx >= 0) subs.splice(idx, 1);
    else subs.push(url);
    saveSubscribedFeeds(subs);
    return subs;
  }

  async function validateFeed(url) {
    try {
      const encoded = encodeURIComponent(url);
      const res = await fetch('https://api.rss2json.com/v1/api.json?rss_url=' + encoded);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      if (data.status === 'ok' && data.items && data.items.length > 0) {
        return { valid: true, title: data.feed?.title || url, count: data.items.length };
      }
      return { valid: false, error: 'No articles found' };
    } catch (err) {
      return { valid: false, error: err.message };
    }
  }

  /* ── Parliament feeds ──
   *
   * The parliamentFeeds section of feeds.json holds RSS feeds for
   * legislative bodies. They are organized by:
   *   - india.central      → Lok Sabha, Rajya Sabha
   *   - india.vidhan-sabha → 28 states + 3 UTs that have legislatures
   *   - india.vidhan-parishad → 6 states with a Legislative Council
   *   - international.{top,all,g7-brics} → curated country lists
   *
   * Every entry has { id, name, url, ... }. The url may be empty
   * when the chamber does not publish an RSS feed; the modal
   * renders those buttons in a disabled state so the user knows
   * the option exists but is not currently fetchable.
   */
  function getParliamentFeeds() {
    return feedData?.parliamentFeeds || null;
  }

  // Resolve a single parliament item by its id. Returns the raw
  // record (with id, name, url, country/state, chamber…) or null
  // when the id is unknown.
  function getParliamentItemById(id) {
    if (!id || !feedData?.parliamentFeeds) return null;
    const pf = feedData.parliamentFeeds;
    const buckets = [
      pf.india?.central,
      pf.india?.['vidhan-sabha'],
      pf.india?.['vidhan-parishad'],
      pf.international?.top,
      pf.international?.all,
      pf.international?.['g7-brics']
    ];
    for (const arr of buckets) {
      if (!Array.isArray(arr)) continue;
      for (const item of arr) {
        if (item && item.id === id) return item;
      }
    }
    return null;
  }

  // Build a feed object compatible with FeedFetcher.fetchFeed()
  // from a raw parliament item. The hint is set to a unique
  // "parliament:<id>" string so each parliament feed is its own
  // subcat group in the article cache and can be filtered
  // independently.
  function parliamentItemToFeed(item) {
    if (!item || !item.url) return null;
    return {
      name: item.name + (item.country ? ' — ' + item.country : (item.state ? ' — ' + item.state : '')),
      url: item.url,
      hint: 'parliament:' + item.id,
      lang: 'en',
      _parliament: true
    };
  }

  // Resolve the active feed list for the current scope + subcat.
  // For ordinary subcats ('all' / 'politics' / …) this is the
  // same as getFeeds(scope, nation). For parliament subcats
  // (subcat starts with 'parliament:') this returns the single
  // matching parliament feed so we don't waste bandwidth on the
  // rest of the scope.
  function getFeedsForSubcat(scope, nation, subcat) {
    if (typeof subcat === 'string' && subcat.indexOf('parliament:') === 0) {
      const id = subcat.slice('parliament:'.length);
      const item = getParliamentItemById(id);
      if (!item) return [];
      const feed = parliamentItemToFeed(item);
      return feed ? [feed] : [];
    }
    return getFeeds(scope, nation);
  }

  return {
    load, subcategories, subcategoriesForScope, subcatLabel, subcatIcon,
    getNations, defaultNation, getSelectedNation, setSelectedNation,
    getFeeds, getFeedsBySubcat,
    getCustomFeeds, addCustomFeed, removeCustomFeed, loadCustomFeeds,
    syncCustomFeedsOnSignIn, validateFeed,
    getSubscribableFeeds, getSubscribedFeeds, saveSubscribedFeeds, isSubscribed, toggleSubscription,
    getParliamentFeeds, getParliamentItemById, parliamentItemToFeed, getFeedsForSubcat
  };
})();

// Hook into Supabase auth state changes. When the user signs in,
// sync any locally-saved custom feeds up to Supabase and reload
// the in-memory cache from there. Supabase is the source of truth
// for signed-in users; localStorage is just a local cache.
try {
  const _client = (typeof SupabaseStore !== 'undefined' && SupabaseStore.getClient)
    ? SupabaseStore.getClient() : null;
  if (_client && _client.auth && _client.auth.onAuthStateChange) {
    _client.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_IN') {
        try { FeedManager.syncCustomFeedsOnSignIn(); } catch (e) {
          console.warn('FeedManager: SIGNED_IN sync threw', e && e.message);
        }
      } else if (event === 'SIGNED_OUT') {
        // Keep the cache as-is (it still reflects what the user had
        // while signed in). Subsequent add/remove calls will only
        // touch localStorage until they sign in again.
      }
    });
  }
} catch (e) {
  // Supabase not yet loaded — the listener will be re-attached on
  // the next page load once SupabaseStore is available.
}

// Expose on window. Top-level `const` in a script lives in the
// global scope but is NOT a property of `window` in browsers, so
// any code that does `if (window.FeedManager) FeedManager.x()` would
// silently no-op. The bare name `FeedManager` still works (it was
// already in the global scope) — this just makes the `window.`
// form work too. Same pattern as AnalyzeModal.
window.FeedManager = FeedManager;
