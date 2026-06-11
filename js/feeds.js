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
        return data;
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
    const gnews = feedData?.googleNews;
    if (!gnews) return feeds;

    let locale;
    if (scope === 'global') {
      locale = gnews.locales.global;
    } else {
      locale = gnews.locales.nations?.[nation] || gnews.locales.global;
    }

    const subs = subcategories();
    for (const cat of subs) {
      const topic = gnews.topicMapping?.[cat];
      if (topic) {
        const url = 'https://news.google.com/rss/headlines/section/topic/' + topic + '?hl=' + locale.hl + '&gl=' + locale.gl + '&ceid=' + locale.ceid;
        feeds.push({ name: 'Google News - ' + (SUBCAT_LABELS[cat] || cat), url, hint: cat, lang: 'en', isGoogleNews: true });
      }
    }

    const extras = gnews.extraFeeds || [];
    for (const f of extras) {
      if (f.scope === 'global' && scope === 'global') feeds.push({ ...f });
      if (f.scope === 'nation' && scope === 'nation' && f.nation === nation) feeds.push({ ...f });
    }

    const custom = getCustomFeeds();
    for (const f of custom) {
      if (f.scope === 'global' && scope === 'global') feeds.push({ name: f.name, url: f.url, hint: f.subcat || 'politics', lang: f.lang || 'en' });
      if (f.scope === 'nation' && scope === 'nation' && f.nation === nation) feeds.push({ name: f.name, url: f.url, hint: f.subcat || 'politics', lang: f.lang || 'en' });
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

  return {
    load, subcategories, subcategoriesForScope, subcatLabel, subcatIcon,
    getNations, defaultNation, getSelectedNation, setSelectedNation,
    getFeeds, getFeedsBySubcat,
    getCustomFeeds, addCustomFeed, removeCustomFeed, validateFeed
  };
})();
