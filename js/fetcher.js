const FeedFetcher = (() => {
  const RSS2JSON_API = 'https://api.rss2json.com/v1/api.json?rss_url=';
  const CORS_PROXY = 'https://corsproxy.io/?url=';
  const FETCH_TIMEOUT = 15000;
  const MAX_RETRIES = 1;

  async function fetchWithTimeout(url, timeout = FETCH_TIMEOUT) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);
    try {
      const res = await fetch(url, { signal: controller.signal });
      return res;
    } finally {
      clearTimeout(id);
    }
  }

  function extractImageFromHtml(html) {
    if (!html) return '';
    const match = html.match(/<img[^>]+src=["']([^"']+)["']/i);
    return match ? match[1] : '';
  }

  function parseRssXml(xmlText, feed) {
    const parser = new DOMParser();
    const xml = parser.parseFromString(xmlText, 'text/xml');
    const items = xml.querySelectorAll('item');
    const articles = [];

    for (const item of items) {
      const title = item.querySelector('title')?.textContent || '';
      const link = item.querySelector('link')?.textContent || '';
      const desc = item.querySelector('description')?.textContent || '';
      const pubDate = item.querySelector('pubDate')?.textContent || '';
      const guid = item.querySelector('guid')?.textContent || link;
      const creator = item.querySelector('dc\\:creator')?.textContent || '';
      const sourceEl = item.querySelector('source');
      const sourceName = sourceEl?.textContent || '';
      const mediaContent = item.querySelector('media\\:content');
      const enclosure = item.querySelector('enclosure');
      const thumbnail = item.querySelector('media\\:thumbnail');

      let imageUrl = '';
      if (thumbnail?.getAttribute('url')) {
        imageUrl = thumbnail.getAttribute('url');
      } else if (mediaContent?.getAttribute('url')) {
        imageUrl = mediaContent.getAttribute('url');
      } else if (enclosure?.getAttribute('url') && enclosure?.getAttribute('type')?.startsWith('image')) {
        imageUrl = enclosure.getAttribute('url');
      }
      if (!imageUrl && desc) {
        imageUrl = extractImageFromHtml(desc);
      }

      const strippedDesc = desc.replace(/<[^>]*>/g, '').trim();
      const summary = strippedDesc.length > 300 ? strippedDesc.slice(0, 300) + '\u2026' : strippedDesc;

      articles.push({
        title: title.trim(),
        link: link.trim(),
        summary,
        pubDate,
        author: creator.trim(),
        imageUrl,
        source: sourceName || feed.name || new URL(feed.url).hostname.replace('www.', ''),
        feedUrl: feed.url,
        feedHint: feed.hint || 'politics',
        guid
      });
    }

    return articles;
  }

  function isGoogleNewsUrl(url) {
    try {
      return new URL(url).hostname.includes('news.google.com');
    } catch {
      return false;
    }
  }

  async function proxyFetch(feed) {
    const proxyUrl = CORS_PROXY + encodeURIComponent(feed.url);
    const res = await fetchWithTimeout(proxyUrl);
    if (!res.ok) throw new Error(`Proxy HTTP ${res.status}`);
    const xmlText = await res.text();
    return parseRssXml(xmlText, feed);
  }

  async function fetchFeed(feed) {
    if (isGoogleNewsUrl(feed.url)) {
      try {
        return await proxyFetch(feed);
      } catch (err) {
        console.warn(`Google News feed failed: ${feed.name}`, err.message);
        return [];
      }
    }

    const encodedUrl = encodeURIComponent(feed.url);
    const rss2jsonUrl = RSS2JSON_API + encodedUrl;

    try {
      const res = await fetchWithTimeout(rss2jsonUrl);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const data = await res.json();

      if (data.status !== 'ok') {
        throw new Error(data.message || 'Unknown RSS2JSON error');
      }

      return (data.items || []).map(item => {
        let imageUrl = item.thumbnail || '';
        if (!imageUrl && item.description) {
          imageUrl = extractImageFromHtml(item.description);
        }
        return {
          title: (item.title || '').trim(),
          link: (item.link || '').trim(),
          summary: (item.description || '')
            .replace(/<[^>]*>/g, '').trim()
            .slice(0, 300),
          pubDate: item.pubDate || '',
          author: item.author || '',
          imageUrl,
          source: feed.name,
          feedUrl: feed.url,
          feedHint: feed.hint || 'politics',
          guid: item.guid || item.link || ''
        };
      });
    } catch (err) {
      try {
        return await proxyFetch(feed);
      } catch (fallbackErr) {
        console.warn(`Feed failed: ${feed.name} (${feed.url})`, err.message, fallbackErr.message);
        return [];
      }
    }
  }

  function filterByDate(articles, dateFrom, dateTo) {
    if (!dateFrom && !dateTo) return articles;

    const from = dateFrom ? new Date(dateFrom) : null;
    const to = dateTo ? new Date(dateTo + 'T23:59:59') : null;

    return articles.filter(a => {
      if (!a.pubDate) return true;
      const d = new Date(a.pubDate);
      if (isNaN(d.getTime())) return true;
      if (from && d < from) return false;
      if (to && d > to) return false;
      return true;
    });
  }

  function deduplicate(articles) {
    const seen = new Set();
    return articles.filter(a => {
      const key = a.link || a.title;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function sortByDate(articles) {
    return [...articles].sort((a, b) => {
      const da = new Date(a.pubDate);
      const db = new Date(b.pubDate);
      if (isNaN(da.getTime()) && isNaN(db.getTime())) return 0;
      if (isNaN(da.getTime())) return 1;
      if (isNaN(db.getTime())) return -1;
      return db - da;
    });
  }

  async function fetchCategory(category, feeds, skipDedup = false) {
    const results = await Promise.allSettled(
      feeds.map(f => fetchFeed(f))
    );

    let articles = [];
    for (const result of results) {
      if (result.status === 'fulfilled') {
        articles = articles.concat(result.value);
      }
    }

    if (!skipDedup) {
      articles = deduplicate(articles);
    }
    articles = sortByDate(articles);
    return articles;
  }

  return { fetchFeed, fetchCategory, filterByDate, deduplicate, sortByDate };
})();
