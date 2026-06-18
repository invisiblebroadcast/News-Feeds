const FeedFetcher = (() => {
  const RSS2JSON_API = 'https://api.rss2json.com/v1/api.json?rss_url=';
  // Primary CORS proxy (raw XML passthrough, no item cap, no
  // API key required). Tries in order; first one that returns a
  // non-error response wins. We keep several because:
  //   - corsproxy.io started rejecting free-tier users with
  //     "Server-side requests are not allowed on your plan"
  //     for ALL URLs, which broke every fetch.
  //   - Some proxies are geo-blocked or rate-limited
  //     intermittently, so a single hard dependency is fragile.
  //   - Parliament feeds in particular seem to be blocked by
  //     some proxies' abuse filters, so a fallback chain
  //     dramatically increases the chance of getting a response.
  const CORS_PROXIES = [
    'https://news-feeds-cors-proxy.invisiblebroadcast.workers.dev/?url=',
    'https://api.allorigins.win/raw?url=',
    'https://corsproxy.io/?url=',
    'https://api.codetabs.com/v1/proxy?quest='
  ];
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

  // Truncate a long description at the nearest sentence end so the summary
  // never cuts off mid-sentence ("...the President said today is"). Falls
  // back to a word boundary if no sentence end is found.
  function smartTruncate(text, maxLen) {
    if (!text || text.length <= maxLen) return text;
    const slice = text.slice(0, maxLen);
    const sentenceEnd = Math.max(
      slice.lastIndexOf('. '),
      slice.lastIndexOf('! '),
      slice.lastIndexOf('? '),
      slice.lastIndexOf('.\n'),
      slice.lastIndexOf('!\n'),
      slice.lastIndexOf('?\n')
    );
    if (sentenceEnd > 40) return slice.slice(0, sentenceEnd + 1);
    const lastSpace = slice.lastIndexOf(' ');
    if (lastSpace > 40) return slice.slice(0, lastSpace) + '…';
    return slice + '…';
  }

  // Detect the publisher's local timezone from the feed URL / name.
  // Many regional publishers (especially in India) emit times in their LOCAL
  // timezone but tag them as +0000 (UTC), which pushes the article into the
  // future. We detect this and apply the correct offset on the fly.
  // Returns offset in minutes (positive = east of UTC) or 0 for UTC.
  function detectFeedTimezoneOffset(feed) {
    if (!feed) return 0;
    const url = (feed.url || '').toLowerCase();
    const name = (feed.name || '').toLowerCase();
    const region = (feed.region || '').toLowerCase();
    // India: +5:30 (330 min)
    if (/\.in\b/.test(url) || name.includes('india') || region.includes('india')) return 330;
    // UK: +0:00 in winter, +1:00 in summer — skip for now, use 0
    // US East: -5:00 (-300 min)
    if (region.includes('us east') || region.includes('usa')) return -300;
    return 0;
  }

  // If the pubDate ends with +0000 (a common pattern when publishers tag their
  // LOCAL time as UTC), rewrite the offset to the detected timezone so the
  // parsed date reflects the actual local time of publication.
  function correctPubDateTimezone(pubDateStr, feed) {
    if (!pubDateStr) return pubDateStr;
    const offsetMinutes = detectFeedTimezoneOffset(feed);
    if (offsetMinutes === 0) return pubDateStr;
    // Only rewrite if it actually has +0000 (or -0000)
    if (!/[+\-]0000\s*$/.test(pubDateStr)) return pubDateStr;
    // Convert offset minutes to +HHMM
    const sign = offsetMinutes >= 0 ? '+' : '-';
    const abs = Math.abs(offsetMinutes);
    const hh = String(Math.floor(abs / 60)).padStart(2, '0');
    const mm = String(abs % 60).padStart(2, '0');
    return pubDateStr.replace(/[+\-]0000\s*$/, sign + hh + mm);
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
      // Many regional publishers tag their local time as +0000 (UTC), which
      // pushes the article into the future. Detect the feed's home timezone
      // and rewrite the offset so the parsed date is correct.
      const pubDate = correctPubDateTimezone(
        item.querySelector('pubDate')?.textContent || '',
        feed
      );
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
      const summary = smartTruncate(strippedDesc, 300);

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
    // Try each CORS proxy in order. A proxy "fails" if it returns
    // a non-OK status, returns what looks like a JSON error payload
    // (corsproxy.io used to return {"error":"..."} with 200 OK),
    // or the response body doesn't parse as XML. We move on to
    // the next proxy in the chain instead of giving up — this
    // is what made every feed silently fail when corsproxy.io
    // started rejecting free-tier users.
    const encoded = encodeURIComponent(feed.url);
    let lastErr = null;
    for (const proxyBase of CORS_PROXIES) {
      const proxyUrl = proxyBase + encoded;
      try {
        const res = await fetchWithTimeout(proxyUrl);
        if (!res.ok) { lastErr = new Error(`Proxy HTTP ${res.status} (${proxyBase})`); continue; }
        const xmlText = await res.text();
        // Reject JSON error payloads (corsproxy.io's free-tier
        // rejection comes back as `{"error":"..."}` with 200 OK).
        const trimmed = xmlText.trimStart();
        if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
          lastErr = new Error('Proxy returned JSON, not XML: ' + trimmed.slice(0, 120));
          continue;
        }
        // Reject anything that doesn't look like XML. A real RSS
        // feed starts with `<?xml` or `<rss` (RSS 2.0) or
        // `<feed` (Atom). HTML 404 pages from broken CDNs will
        // fail this check and fall through to the next proxy.
        if (!/^\s*(<\?xml|<rss|<feed)/i.test(trimmed)) {
          lastErr = new Error('Proxy returned non-XML payload: ' + trimmed.slice(0, 120));
          continue;
        }
        // Quick parse to count items before we build full article objects.
        try {
          const parser = new DOMParser();
          const xml = parser.parseFromString(xmlText, 'text/xml');
          const itemCount = xml.querySelectorAll('item').length;
          console.log(`[FeedFetcher] ${feed.name}: ${itemCount} items in RSS XML via ${proxyBase} (${(xmlText.length / 1024).toFixed(1)} KB)`);
        } catch {}
        return parseRssXml(xmlText, feed);
      } catch (err) {
        lastErr = err;
        // Try the next proxy
      }
    }
    throw lastErr || new Error('All CORS proxies failed for ' + feed.url);
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
    // Skip sources the user has disabled via the failed-sources flow —
    // they get tracked but never hit the network until re-enabled.
    if (window.SourceHealth && SourceHealth.isDisabled(feed.url)) {
      return [];
    }

    if (isGoogleNewsUrl(feed.url)) {
      try {
        const items = await proxyFetch(feed);
        afterFetch(feed, items);
        return perSourceCap && perSourceCap > 0 ? items.slice(0, perSourceCap) : items;
      } catch (err) {
        console.warn(`Google News feed failed: ${feed.name}`, err.message);
        afterFetch(feed, [], err);
        return [];
      }
    }

    // For non-Google feeds, prefer raw RSS XML via the CORS proxy because it
    // returns ALL items the feed publishes (no rss2json-style 100-item cap).
    // We also try paginated fetching (?p=2, ?p=3) to go beyond the publisher's
    // default cap, which is critical for top-mode ranking.
    try {
      const items = await proxyFetchPaginated(feed);
      afterFetch(feed, items);
      return perSourceCap && perSourceCap > 0 ? items.slice(0, perSourceCap) : items;
    } catch (proxyErr) {
      // Fall back to rss2json if all CORS proxies fail (network,
      // 503, free-tier rejection, etc.). Note: rss2json's free tier
      // caps at ~10 items by default; passing `count=100` requires
      // a paid API key and silently fails the whole request for
      // free users, so we deliberately leave it off. The
      // perSourceCap below is the only cap we need anyway — the
      // calling code already slices the result down to what it
      // actually wants.
      const encodedUrl = encodeURIComponent(feed.url);
      const rss2jsonUrl = RSS2JSON_API + encodedUrl;

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
            summary: smartTruncate(
              (item.description || '').replace(/<[^>]*>/g, '').trim(),
              300
            ),
            pubDate: correctPubDateTimezone(item.pubDate || '', feed),
            author: item.author || '',
            imageUrl,
            source: feed.name,
            feedUrl: feed.url,
            feedHint: feed.hint || 'politics',
            guid: item.guid || item.link || ''
          };
        });
        afterFetch(feed, allItems);
        return perSourceCap && perSourceCap > 0 ? allItems.slice(0, perSourceCap) : allItems;
      } catch (rssErr) {
        console.warn(`Feed failed: ${feed.name} (${feed.url})`, proxyErr.message, rssErr.message);
        afterFetch(feed, [], rssErr);
        return [];
      }
    }
  }

  // Report a per-source fetch outcome to the health tracker. We treat
  // an empty result array the same as an exception — a publisher that
  // returned a valid 200 OK but a feed with zero items is just as
  // broken for the user as a network error, and the threshold is
  // designed to silence such feeds. We do NOT count "pagination
  // page 2 returned no new items" as a failure — that's normal feed
  // exhaustion, not a problem with the source. proxyFetchPaginated
  // therefore returns its first page's count for the result, and
  // anything with at least one item is a success.
  //
  // On success, also hand every parsed article to ArticleArchive so
  // it ends up in the Supabase `seen_articles` table for analysis
  // (cross-source conflict detection, dedup ratios, per-source
  // volume, etc). The archive is fire-and-forget — we don't await
  // the Supabase write so the UI render is never blocked by it.
  function afterFetch(feed, items, err) {
    if (!window.SourceHealth || !feed || !feed.url) return;
    const ok = Array.isArray(items) && items.length > 0;
    if (ok) {
      SourceHealth.recordSuccess(feed.url);
      if (window.ArticleArchive) {
        for (const a of items) ArticleArchive.ingest(a, feed.lang);
      }
    } else {
      SourceHealth.recordFailure(feed.url, err || new Error('No items returned'));
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

// Expose on window — see js/feeds.js for the rationale.
window.FeedFetcher = FeedFetcher;
