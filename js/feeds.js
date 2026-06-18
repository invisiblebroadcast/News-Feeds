const FeedManager = (() => {
  let feedData = null;
  let loadPromise = null;

  const CUSTOM_FEEDS_KEY = 'newsfeeds_custom_feeds';
  const SELECTED_NATION_KEY = 'newsfeeds_selected_nation';

  const SUBCAT_LABELS = {
    all: 'All', politics: 'Politics & Governance', business: 'Business & Economy',
    technology: 'Technology & Innovation', science: 'Science & Research',
    health: 'Health & Medicine', sports: 'Sports & Athletics',
    entertainment: 'Culture & Entertainment', environment: 'Environment & Climate',
    education: 'Education & Academia'
  };

  const SUBCAT_ICONS = {
    all: '\uD83D\uDCCA', politics: '\uD83C\uDFDB', business: '\uD83D\uDCC8',
    technology: '\uD83D\uDCBB', science: '\uD83D\uDD2C',
    health: '\u2764\uFE0F', sports: '\u26BD',
    entertainment: '\uD83C\uDFAC', environment: '\uD83C\uDF31',
    education: '\uD83C\uDF93'
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

  function getCustomFeeds() {
    try { return JSON.parse(localStorage.getItem(CUSTOM_FEEDS_KEY) || '[]'); }
    catch { return []; }
  }

  function saveCustomFeeds(feeds) {
    localStorage.setItem(CUSTOM_FEEDS_KEY, JSON.stringify(feeds));
  }

  function addCustomFeed(name, url, scope, nation, subcat, lang) {
    const feeds = getCustomFeeds();
    feeds.push({ name, url, scope: scope || 'global', nation: nation || '', subcat: subcat || 'politics', lang: lang || 'en' });
    saveCustomFeeds(feeds);
  }

  function removeCustomFeed(url) {
    saveCustomFeeds(getCustomFeeds().filter(f => f.url !== url));
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
    getCustomFeeds, addCustomFeed, removeCustomFeed, validateFeed,
    getSubscribableFeeds, getSubscribedFeeds, saveSubscribedFeeds, isSubscribed, toggleSubscription,
    getParliamentFeeds, getParliamentItemById, parliamentItemToFeed, getFeedsForSubcat
  };
})();

// Expose on window. Top-level `const` in a script lives in the
// global scope but is NOT a property of `window` in browsers, so
// any code that does `if (window.FeedManager) FeedManager.x()` would
// silently no-op. The bare name `FeedManager` still works (it was
// already in the global scope) — this just makes the `window.`
// form work too. Same pattern as AnalyzeModal.
window.FeedManager = FeedManager;
