const Settings = (() => {
  const STORAGE_KEY = 'newsfeeds_settings';
  const DEFAULTS = {
    articlesPerPage: 10,
    language: 'en',
    dateRange: '7',
    showDescription: false,
    aiProvider: 'ollama',
    ollamaAddress: 'http://192.168.1.1:11434',
    ollamaModel: 'qwen2.5:1.5b',
    webllmModel: 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC',
    aiNewsContextCount: 20,
    aiSystemPrompt: '',
    aiCloudKey: '',
    aiCloudEndpoint: 'https://api.openai.com/v1',
    aiCloudModel: 'gpt-4o-mini',
    aiTopList: false
  };

  let cache = null;

  function load() {
    if (cache) return { ...cache };
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const saved = raw ? JSON.parse(raw) : {};
      cache = { ...DEFAULTS, ...saved };
    } catch {
      cache = { ...DEFAULTS };
    }
    return { ...cache };
  }

  function save(settings) {
    cache = { ...load(), ...settings };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cache));
  }

  function get(key) {
    return load()[key] ?? DEFAULTS[key];
  }

  function set(key, value) {
    const s = load();
    s[key] = value;
    save(s);
  }

  function reset() {
    localStorage.removeItem(STORAGE_KEY);
    cache = null;
  }

  const LANGUAGES = {
    en: 'English',
    hi: 'Hindi',
    ta: 'Tamil',
    te: 'Telugu',
    kn: 'Kannada',
    ml: 'Malayalam',
    bn: 'Bengali',
    mr: 'Marathi',
    gu: 'Gujarati',
    pa: 'Punjabi',
    ur: 'Urdu',
    es: 'Spanish',
    fr: 'French',
    ar: 'Arabic',
    zh: 'Chinese',
    ja: 'Japanese',
    de: 'German',
    ru: 'Russian',
    pt: 'Portuguese'
  };

  return { load, save, get, set, reset, LANGUAGES };
})();
