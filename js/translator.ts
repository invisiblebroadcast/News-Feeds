// @ts-nocheck
const Translator = (() => {
  const GOOGLE_TRANSLATE_URL = 'https://translate.googleapis.com/translate_a/single?client=gtx&dt=t&sl=auto&tl=';
  const cache = new Map();
  const pendingRequests = new Map();

  function getLangName(code) {
    return Settings.LANGUAGES[code] || code;
  }

  async function translate(text, targetLang) {
    if (!text || !targetLang || targetLang === 'en') return text;

    const cacheKey = text + '|' + targetLang;
    if (cache.has(cacheKey)) return cache.get(cacheKey);

    if (pendingRequests.has(cacheKey)) {
      return pendingRequests.get(cacheKey);
    }

    const promise = (async () => {
      try {
        const url = GOOGLE_TRANSLATE_URL + targetLang + '&q=' + encodeURIComponent(text.slice(0, 2000));
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const data = await res.json();
        let translated = '';
        if (data && data[0]) {
          for (const segment of data[0]) {
            if (segment[0]) translated += segment[0];
          }
        }

        const result = translated || text;
        cache.set(cacheKey, result);
        return result;
      } catch (err) {
        console.warn('Translation failed:', err.message);
        return text;
      } finally {
        pendingRequests.delete(cacheKey);
      }
    })();

    pendingRequests.set(cacheKey, promise);
    return promise;
  }

  async function translateArticle(article, targetLang) {
    if (!targetLang || targetLang === 'en') return article;

    const [translatedTitle, translatedSummary] = await Promise.all([
      translate(article.title, targetLang),
      translate(article.summary, targetLang)
    ]);

    return {
      ...article,
      title: translatedTitle,
      summary: translatedSummary,
      translated: true,
      translationLang: targetLang
    };
  }

  async function translateArticles(articles, targetLang) {
    if (!targetLang || targetLang === 'en') return articles;

    const results = await Promise.allSettled(
      articles.map(a => translateArticle(a, targetLang))
    );

    return results.map((r, i) =>
      r.status === 'fulfilled' ? r.value : articles[i]
    );
  }

  return { translate, translateArticle, translateArticles, getLangName };
})();

// Expose on window — see js/feeds.js for the rationale.
window.Translator = Translator;
