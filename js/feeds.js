const FeedManager = (() => {
  let feedData = null;
  let loadPromise = null;

  const CUSTOM_FEEDS_KEY = 'newsfeeds_custom_feeds';
  const SELECTED_NATION_KEY = 'newsfeeds_selected_nation';

  const SUBCAT_LABELS = {
    world: 'World', politics: 'Politics', science: 'Science',
    space: 'Space', education: 'Education', laws: 'Laws',
    sports: 'Sports', agriculture: 'Agriculture', nature: 'Nature'
  };

  const SUBCAT_ICONS = {
    world: '\uD83C\uDF0D', politics: '\uD83C\uDFDB', science: '\uD83D\uDD2C',
    space: '\uD83D\uDE80', education: '\uD83C\uDF93', laws: '\u2696',
    sports: '\u26BD', agriculture: '\uD83C\uDF3E', nature: '\uD83C\uDF33'
  };

  const URL_CATEGORY_PATTERNS = [
    { pattern: /\/politics\//i, cat: 'politics' },
    { pattern: /\/education\//i, cat: 'education' },
    { pattern: /\/sport\//i, cat: 'sports' },
    { pattern: /\/science_and_environment\//i, cat: 'science' },
    { pattern: /sci-tech\/agriculture\//i, cat: 'agriculture' },
    { pattern: /sci-tech\/energy-and-environment\//i, cat: 'nature' },
    { pattern: /\/rss\/politics/i, cat: 'politics' },
    { pattern: /\/rss\/legal/i, cat: 'laws' },
    { pattern: /\/world\/asia\/india\//i, cat: 'world' }
  ];

  const SUBCAT_KEYWORDS = {
    world: [
      'world', 'global', 'international', 'foreign', 'united nations', 'nato',
      'diplomacy', 'treaty', 'ambassador', 'sanctions', 'refugee', 'migrant',
      'border', 'security council', 'european union', 'foreign minister',
      'nuclear', 'terrorism', 'geopolitical', 'china', 'russia', 'america',
      'europe', 'asia', 'africa', 'middle east', 'ukraine', 'gaza', 'israel',
      'palestine', 'iran', 'afghanistan', 'myanmar', 'syria', 'yemen',
      'trade war', 'tariff', 'embassy', 'consulate', 'united states'
    ],
    politics: [
      'election', 'vote', 'parliament', 'congress', 'senate', 'minister',
      'prime minister', 'president', 'government', 'opposition', 'party',
      'legislation', 'cabinet', 'coalition', 'democracy', 'campaign',
      'polling', 'manifesto', 'amendment', 'constitution', 'constitutional',
      'mla', 'mp', 'mps', 'political party', 'ruling party', 'bypoll',
      'by-election', 'defection', 'no-confidence', 'hung parliament',
      'governor', 'chief minister', 'chancellor', 'policy', 'welfare'
    ],
    science: [
      'science', 'scientist', 'research', 'study', 'discovery', 'dna',
      'gene', 'genetic', 'vaccine', 'clinical', 'trial', 'experiment',
      'lab', 'laboratory', 'quantum', 'physics', 'chemistry', 'biology',
      'medicine', 'health', 'telescope', 'species', 'fossil', 'evolution',
      'theory', 'particle', 'researchers found', 'scientists found',
      'study finds', 'research shows', 'clinical trial', 'breakthrough',
      'scientific', 'genome', 'stem cell', 'artificial intelligence',
      'ai', 'robot', 'innovation', 'biotech', 'biotechnology'
    ],
    space: [
      'space', 'nasa', 'isro', 'esa', 'spacex', 'satellite', 'rocket',
      'launch', 'orbit', 'astronaut', 'mars', 'moon', 'solar', 'galaxy',
      'planet', 'star', 'hubble', 'james webb', 'space station', 'lunar',
      'asteroid', 'comet', 'interstellar', 'alien', 'exoplanet',
      'space mission', 'chandrayaan', 'mangalyaan', 'gaganyaan',
      'spacecraft', 'telescope webb', 'cosmos', 'celestial',
      'solar system', 'milky way', 'black hole', 'nebula'
    ],
    education: [
      'school', 'college', 'university', 'student', 'teacher', 'professor',
      'exam', 'curriculum', 'scholarship', 'tuition', 'academic', 'campus',
      'degree', 'diploma', 'vocational', 'literacy', 'learning', 'classroom',
      'homework', 'grading', 'board exam', 'neet', 'jee', 'upsc', 'iit',
      'iim', 'ncert', 'education policy', 'admission', 'enrollment',
      'fellowship', 'research grant', 'PhD', 'postgraduate', 'undergraduate',
      'syllabus', 'textbook', 'online class', 'digital learning'
    ],
    laws: [
      'law', 'legal', 'court', 'judge', 'supreme court', 'high court',
      'trial', 'lawsuit', 'litigation', 'verdict', 'sentence', 'appeal',
      'justice', 'crime', 'criminal', 'police', 'investigation', 'arrest',
      'prosecutor', 'defendant', 'plaintiff', 'judiciary', 'lawyer',
      'attorney', 'legislation', 'regulation', 'tribunal', 'bail',
      'conviction', 'acquittal', 'fir', 'sc', 'order', 'bench',
      'contempt', 'writ', 'petition', 'hearing', 'judgment'
    ],
    sports: [
      'sport', 'sports', 'cricket', 'football', 'soccer', 'tennis',
      'olympics', 'world cup', 'match', 'game', 'tournament',
      'championship', 'league', 'player', 'team', 'coach', 'goal',
      'score', 'final', 'semi-final', 'athlete', 'olympian', 'medal',
      'stadium', 'batsman', 'bowler', 'striker', 'wicket', 'ipl',
      'cricket world cup', 'fifa', 'grand slam', 'champion',
      'title', 'defeat', 'victory', 'hat-trick', 'century',
      'five-wicket', 'playoff', 'qualifier'
    ],
    agriculture: [
      'agriculture', 'farming', 'farmer', 'crop', 'harvest', 'monsoon',
      'irrigation', 'fertilizer', 'pesticide', 'organic', 'farm', 'rural',
      'food security', 'grain', 'rice', 'wheat', 'vegetable', 'fruit',
      'livestock', 'poultry', 'dairy', 'fishery', 'aquaculture', 'soil',
      'drought', 'flood', 'kharif', 'rabi', 'horticulture', 'plantation',
      'agricultural', 'agri', 'farmers protest', 'msp', 'subsidy',
      'cold storage', 'supply chain', 'mandi', 'minimum support price',
      'crop insurance', 'organic farming', 'pesticide free'
    ],
    nature: [
      'nature', 'environment', 'climate', 'climate change', 'global warming',
      'wildlife', 'animal', 'forest', 'ocean', 'sea', 'river', 'pollution',
      'conservation', 'ecosystem', 'biodiversity', 'endangered', 'habitat',
      'green', 'renewable', 'solar energy', 'wind energy', 'carbon',
      'emission', 'sustainable', 'ecology', 'ecological', 'tree', 'plant',
      'flower', 'national park', 'sanctuary', 'zoo', 'deforestation',
      'glacier', 'rainfall', 'temperature', 'greenhouse gas', 'net zero',
      'carbon footprint', 'coral', 'wetland', 'environmental'
    ]
  };

  const SUBCAT_KEYS = Object.keys(SUBCAT_KEYWORDS);

  async function load() {
    if (feedData) return feedData;
    if (loadPromise) return loadPromise;

    loadPromise = fetch('data/feeds.json')
      .then(r => { if (!r.ok) throw new Error('Failed to load feeds'); return r.json(); })
      .then(data => {
        feedData = data;
        mergeCustomFeeds();
        return data;
      })
      .catch(err => { loadPromise = null; throw err; });

    return loadPromise;
  }

  function subcategories() {
    return feedData?.subcategories || [];
  }

  function subcategoriesForScope(scope) {
    const subs = subcategories();
    if (scope === 'global') return subs.filter(s => s !== 'world');
    return subs;
  }

  function subcatLabel(cat, scope) {
    if (cat === 'world' && scope === 'nation') return 'International';
    return SUBCAT_LABELS[cat] || cat;
  }

  function subcatIcon(cat) { return SUBCAT_ICONS[cat] || ''; }

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
    const all = feedData?.feeds || [];
    return all.filter(f => {
      if (f.scope === 'global' && scope === 'global') return true;
      if (f.scope === 'nation' && scope === 'nation' && f.nation === nation) return true;
      return false;
    });
  }

  function getFeedsBySubcat(scope, nation) {
    const feeds = getFeeds(scope, nation);
    const grouped = {};
    for (const f of feeds) {
      const cat = f.hint || 'world';
      if (!grouped[cat]) grouped[cat] = [];
      grouped[cat].push(f);
    }
    return grouped;
  }

  function matchUrlCategory(url) {
    for (const { pattern, cat } of URL_CATEGORY_PATTERNS) {
      if (pattern.test(url)) return cat;
    }
    return null;
  }

  function scoreKeywords(text, keywords) {
    const lower = text.toLowerCase();
    let score = 0;
    for (const kw of keywords) {
      if (lower.includes(kw.toLowerCase())) score++;
    }
    return score;
  }

  function categorizeArticle(article) {
    const text = article.title + ' ' + (article.summary || '');
    const catFromUrl = article.feedUrl ? matchUrlCategory(article.feedUrl) : null;
    if (catFromUrl) {
      article.subcat = catFromUrl;
      return catFromUrl;
    }

    let bestCat = article.feedHint || 'world';
    let bestScore = 0;
    for (const cat of SUBCAT_KEYS) {
      const score = scoreKeywords(text, SUBCAT_KEYWORDS[cat]);
      if (score > bestScore) {
        bestScore = score;
        bestCat = cat;
      }
    }
    article.subcat = bestCat;
    return bestCat;
  }

  function mergeCustomFeeds() {
    if (!feedData) return;
    const custom = getCustomFeeds();
    for (const feed of custom) {
      const exists = feedData.feeds.some(f => f.url === feed.url);
      if (!exists) {
        feedData.feeds.push({
          name: feed.name, url: feed.url, lang: feed.lang || 'en',
          scope: feed.scope || 'global', nation: feed.nation || '',
          hint: feed.subcat || 'world'
        });
      }
    }
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
    feeds.push({ name, url, scope: scope || 'global', nation: nation || '', subcat: subcat || 'world', lang: lang || 'en' });
    saveCustomFeeds(feeds);
    if (!feedData) return;
    const exists = feedData.feeds.some(f => f.url === url);
    if (!exists) {
      feedData.feeds.push({ name, url, lang: lang || 'en', scope: scope || 'global', nation: nation || '', hint: subcat || 'world' });
    }
  }

  function removeCustomFeed(url) {
    const feeds = getCustomFeeds().filter(f => f.url !== url);
    saveCustomFeeds(feeds);
    if (!feedData) return;
    feedData.feeds = feedData.feeds.filter(f => f.url !== url);
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
    categorizeArticle, matchUrlCategory,
    getCustomFeeds, addCustomFeed, removeCustomFeed, validateFeed
  };
})();
