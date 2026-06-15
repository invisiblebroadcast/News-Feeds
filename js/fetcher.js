const FeedFetcher = (() => {
  const RSS2JSON_API = 'https://api.rss2json.com/v1/api.json?rss_url=';
  const CORS_PROXY = 'https://corsproxy.io/?url=';
  // Generous timeout because some feeds publish thousands of items in 10 days
  // and the proxy has to fetch + transfer the entire XML payload.
  const FETCH_TIMEOUT = 30000;

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
    // Quick parse to count items before we build full article objects.
    try {
      const parser = new DOMParser();
      const xml = parser.parseFromString(xmlText, 'text/xml');
      const itemCount = xml.querySelectorAll('item').length;
      console.log(`[FeedFetcher] ${feed.name}: ${itemCount} items in RSS XML (${(xmlText.length / 1024).toFixed(1)} KB)`);
    } catch {}
    return parseRssXml(xmlText, feed);
  }

  // Some RSS feeds (WordPress-style, BlogEngine, etc.) support pagination via
  // `?p=N` or `?page=N`. When a feed has exactly the typical cap (50-100 items),
  // we try fetching the next page(s) to pull more history. This can multiply
  // the article count significantly for blogs that publish heavily.
  async function proxyFetchPaginated(feed) {
    const baseArticles = await proxyFetch(feed);
    // If the base fetch already returned a lot, skip pagination
    if (baseArticles.length < 50) return baseArticles;

    const maxPages = 3; // cap pages to keep mobile fast
    const collected = [...baseArticles];

    for (let page = 2; page <= maxPages + 1; page++) {
      try {
        const sep = feed.url.includes('?') ? '&' : '?';
        const pagedUrl = `${feed.url}${sep}p=${page}`;
        const articles = await proxyFetch({ ...feed, url: pagedUrl });
        if (!articles.length) break;
        // Only add items we haven't seen (by guid or link)
        const seen = new Set(collected.map(a => a.guid || a.link));
        let added = 0;
        for (const a of articles) {
          const key = a.guid || a.link;
          if (!seen.has(key)) { collected.push(a); seen.add(key); added++; }
        }
        if (added === 0) break; // no new items = we've exhausted history
        console.log(`[FeedFetcher] ${feed.name} page ${page}: +${added} new items (total: ${collected.length})`);
      } catch (e) {
        break; // pagination not supported for this feed
      }
    }
    return collected;
  }

  async function fetchFeed(feed, perSourceCap) {
    // perSourceCap: optionally limit the number of items returned per source
    // (live mode uses a small cap like 25; top mode lets everything through).
    if (isGoogleNewsUrl(feed.url)) {
      try {
        const items = await proxyFetch(feed);
        return perSourceCap && perSourceCap > 0 ? items.slice(0, perSourceCap) : items;
      } catch (err) {
        console.warn(`Google News feed failed: ${feed.name}`, err.message);
        return [];
      }
    }

    // For non-Google feeds, prefer raw RSS XML via the CORS proxy because it
    // returns ALL items the feed publishes (no rss2json-style 100-item cap).
    // We also try paginated fetching (?p=2, ?p=3) to go beyond the publisher's
    // default cap, which is critical for top-mode ranking.
    try {
      const items = await proxyFetchPaginated(feed);
      return perSourceCap && perSourceCap > 0 ? items.slice(0, perSourceCap) : items;
    } catch (proxyErr) {
      // Fall back to rss2json if the proxy fails (network, 503, etc.)
      const encodedUrl = encodeURIComponent(feed.url);
      // rss2json free tier caps at 100 items, but it's a good fallback
      const rss2jsonUrl = RSS2JSON_API + encodedUrl + '&count=100';

      try {
        const res = await fetchWithTimeout(rss2jsonUrl);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const data = await res.json();

        if (data.status !== 'ok') {
          throw new Error(data.message || 'Unknown RSS2JSON error');
        }

        const allItems = (data.items || []).map(item => {
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
        return perSourceCap && perSourceCap > 0 ? allItems.slice(0, perSourceCap) : allItems;
      } catch (rssErr) {
        console.warn(`Feed failed: ${feed.name} (${feed.url})`, proxyErr.message, rssErr.message);
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
      const linkKey = a.link || a.title;
      if (seen.has(linkKey)) return false;
      const titleKey = a.title ? a.title.toLowerCase().replace(/[^a-z0-9]/g, '').trim() : '';
      if (titleKey && seen.has('t:' + titleKey)) return false;
      seen.add(linkKey);
      if (titleKey) seen.add('t:' + titleKey);
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
