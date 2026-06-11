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

    loadPromise = Promise.all([
      fetch('data/feeds.json').then(r => { if (!r.ok) throw new Error('Failed to load feeds'); return r.json(); }),
      fetch('data/deepseek_json_20260611_0bffae.json').then(r => { if (!r.ok) throw new Error('Failed to load subscribable feeds'); return r.json(); })
    ]).then(([feedsData, dsData]) => {
      feedData = feedsData;
      feedData.subscribableFeeds = flattenDeepSeek(dsData);
      return feedData;
    }).catch(err => { loadPromise = null; throw err; });

    return loadPromise;
  }

  function flattenDeepSeek(data) {
    const result = [];
    const cats = data.categories || {};
    function add(items, region, hint) {
      for (const item of (items || [])) {
        result.push({
          region: region || 'Global',
          name: item.name || '',
          url: item.url || '',
          scope: (region === 'Global' || region === 'By Country') ? 'global' : 'nation',
          nation: (region === 'Global' || region === 'By Country') ? null : 'india',
          hint: hint || 'politics',
          lang: item.lang || 'en',
          hasRss: true
        });
      }
    }
    add(cats.world?.international_agencies, 'Global');
    add(cats.world?.by_country, 'By Country');
    add(cats.india_national?.english_newspapers, 'India (English)');
    add(cats.india_national?.news_agencies, 'India (English)');
    add(cats.india_national?.hindi, 'Hindi');
    add(cats.india_national?.tamil, 'Tamil');
    for (const key of Object.keys(cats.tv_channels || {})) {
      add(cats.tv_channels[key], 'TV Channels');
    }
    for (const [region, items] of Object.entries(cats.regional || {})) {
      add(items, region.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()));
    }
    add(cats.science_technology?.science, 'Science', 'science');
    add(cats.science_technology?.space, 'Science', 'science');
    add(cats.science_technology?.technology, 'Technology', 'technology');
    add(cats.business_finance, 'Business & Finance', 'business');
    add(cats.sports, 'Sports', 'sports');
    add(cats.education, 'Education', 'education');
    add(cats.legal, 'Legal');
    for (const key of Object.keys(cats.agriculture_environment || {})) {
      add(cats.agriculture_environment[key], 'Environment', 'environment');
    }
    for (const key of Object.keys(cats.entertainment_lifestyle || {})) {
      add(cats.entertainment_lifestyle[key], 'Entertainment', 'entertainment');
    }
    return result;
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

    const subscribedUrls = getSubscribedFeeds();
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

  return {
    load, subcategories, subcategoriesForScope, subcatLabel, subcatIcon,
    getNations, defaultNation, getSelectedNation, setSelectedNation,
    getFeeds, getFeedsBySubcat,
    getCustomFeeds, addCustomFeed, removeCustomFeed, validateFeed,
    getSubscribableFeeds, getSubscribedFeeds, isSubscribed, toggleSubscription
  };
})();
