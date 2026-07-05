// @ts-nocheck
const Settings = (() => {
  const STORAGE_KEY = 'newsfeeds_settings';
  const DEFAULTS = {
    articlesPerPage: 10,
    language: 'en',
    showDescription: false,
    topDate: '',
    // When ON, a source that fails 5 times in a row is automatically
    // disabled and skipped on subsequent fetches. The user can see +
    // re-enable failed sources from Settings → Feed Health and
    // Activity → Failed sources. Default OFF so we don't surprise the
    // user by silently dropping sources on first install.
    autoDisableFailingSources: false
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

// Expose on window — see js/feeds.js for the rationale.
window.Settings = Settings;
