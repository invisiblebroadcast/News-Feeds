// Background archive: every successfully-parsed article is upserted
// into the Supabase `seen_articles` table for later analysis (cross-
// source conflict detection, trend analysis, dedup ratios, etc).
//
// Design choices:
//   - Fire-and-forget: the fetcher calls ingest() per article but
//     never awaits — UI render is not blocked by the archive.
//   - Batched flushes: items are pushed to an in-memory queue and
//     flushed in batches of BATCH_SIZE every FLUSH_INTERVAL ms. With
//     ~2,400 articles/day across 122 sources, this is one batch
//     every few seconds during peak fetch windows.
//   - Persisted queue: if the tab is closed mid-flush, the queue is
//     saved to localStorage and resumed on next init. Caps at
//     MAX_QUEUE_SIZE items (oldest dropped) so a long offline period
//     can't blow past the 5 MB localStorage budget.
//   - Server-side dedup: the table's UNIQUE(url) constraint +
//     ignoreDuplicates:true means re-archiving the same article is a
//     no-op. We also dedup within the in-memory queue so we don't
//     waste a network round-trip on dupes that just arrived.
//   - Light metadata only: title, source, pub_date, category, lang.
//     No body, no summary — the table is for indexing + analysis,
//     not for re-reading articles. ~316 B/row.
//   - Failure handling: any Supabase error (network, RLS, rate
//     limit) re-queues the batch and tries again next flush. If
//     the user is signed out the upsert just fails every time —
//     that's fine, items queue up locally and drain the moment
//     they sign in.
//
// The table schema (run in Supabase SQL editor):
//   create table seen_articles (
//     id          bigserial primary key,
//     url         text unique not null,
//     title       text,
//     source      text,
//     pub_date    timestamptz,
//     category    text,
//     lang        text,
//     first_seen  timestamptz default now()
//   );
//   create index seen_articles_pub_date_idx on seen_articles (pub_date desc);
//   create index seen_articles_source_idx   on seen_articles (source);
//   create index seen_articles_category_idx on seen_articles (category);

const ArticleArchive = (() => {
  const TABLE = 'seen_articles';
  const QUEUE_KEY = 'newsfeeds_article_archive_queue';
  const BATCH_SIZE = 100;
  const FLUSH_INTERVAL = 5000;             // 5s between flushes
  const IMMEDIATE_FLUSH_THRESHOLD = 200;   // flush NOW if queue gets this big
  const MAX_QUEUE_SIZE = 10000;            // localStorage cap (~3 MB of JSON)

  let queue = [];
  let flushTimer = null;
  let isFlushing = false;
  let pendingFlush = false;
  let lastErrorLoggedAt = 0;
  // When Supabase rejects our upserts with a row-level-security
  // (RLS) violation, the table either has no INSERT policy for our
  // JWT role (typically 'anon' for signed-out users) or the policy
  // is too strict. Retrying won't help — the next upsert will fail
  // the exact same way — and the queue would grow unbounded until
  // the localStorage cap kicks in. Detect RLS once, log one clear
  // message, then drop the queue and stop retrying until the
  // user signs in. Re-enabled on successful flush (see flush()).
  let disabledUntilAuth = false;
  let rlsMessageLogged = false;

  function loadQueue() {
    try {
      const raw = JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]');
      return Array.isArray(raw) ? raw : [];
    } catch {
      return [];
    }
  }

  function saveQueue() {
    try {
      if (queue.length > MAX_QUEUE_SIZE) {
        // Drop oldest items first. The newest are the most useful
        // for the user's "what's fresh" analysis anyway.
        queue = queue.slice(-MAX_QUEUE_SIZE);
      }
      localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
    } catch (e) {
      // localStorage might be full or disabled (private browsing).
      // In that case the queue is in-memory only — items will be
      // lost on reload but the archive keeps working for the
      // current session.
      console.warn('[ArticleArchive] saveQueue failed:', e?.message || e);
    }
  }

  // Look up a feed's lang by matching its feedUrl. The feed object
  // passed to fetchFeed already carries lang, but we keep this
  // fallback in case ingest is called from a code path that
  // doesn't have it (e.g. custom feeds added at runtime).
  function lookupLang(feedUrl) {
    if (!feedUrl) return 'en';
    try {
      const all = FeedManager.getSubscribableFeeds();
      for (const f of all) if (f.url === feedUrl) return f.lang || 'en';
      const custom = FeedManager.getCustomFeeds();
      for (const f of custom) if (f.url === feedUrl) return f.lang || 'en';
    } catch {}
    return 'en';
  }

  // Public API: called by the fetcher for every successfully parsed
  // article. Returns immediately; the actual Supabase write is
  // batched in the background.
  function ingest(article, feedLang) {
    if (!article || !article.link) return;

    const url = article.link;
    // Within-queue dedup: same URL within the current pending batch
    // is a no-op. Supabase's UNIQUE constraint catches everything
    // else server-side.
    if (queue.some(item => item.url === url)) return;

    let pubDateIso = null;
    if (article.pubDate) {
      const d = new Date(article.pubDate);
      if (!isNaN(d.getTime())) pubDateIso = d.toISOString();
    }

    queue.push({
      url: url.slice(0, 2000),
      title: (article.title || '').slice(0, 500),
      source: (article.source || '').slice(0, 200),
      pub_date: pubDateIso,
      category: (article.feedHint || '').slice(0, 50),
      lang: (feedLang || lookupLang(article.feedUrl) || 'en').slice(0, 10),
      first_seen: new Date().toISOString()
    });

    if (queue.length >= IMMEDIATE_FLUSH_THRESHOLD) {
      // Big surge — flush right away rather than waiting.
      flush();
    } else {
      scheduleFlush();
    }
  }

  function scheduleFlush() {
    if (flushTimer || isFlushing) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flush();
    }, FLUSH_INTERVAL);
  }

  async function flush() {
    if (isFlushing) {
      // Another flush is already running. Mark that we need
      // another one as soon as it finishes.
      pendingFlush = true;
      return;
    }
    if (queue.length === 0) return;
    // RLS disabled us last time around — don't bother trying again
    // until the user signs in. The flag is cleared on the next
    // successful flush (see end of this function).
    if (disabledUntilAuth) return;

    const batch = queue.splice(0, BATCH_SIZE);
    isFlushing = true;

    try {
      const client = SupabaseStore.getClient ? SupabaseStore.getClient() : null;
      if (!client) {
        // Not signed in / Supabase not configured — keep items and
        // try again on the next flush. They'll drain the moment the
        // user signs in.
        queue.unshift(...batch);
        saveQueue();
        return;
      }

      const { error } = await client
        .from(TABLE)
        .upsert(batch, { onConflict: 'url', ignoreDuplicates: true });

      if (error) {
        const msg = (error && error.message) || String(error);
        // RLS rejection: Supabase returns 401 / "new row violates
        // row-level security policy" when the JWT role lacks INSERT
        // permission on the table. Detect this and back off so we
        // don't burn the localStorage budget on permanent failures.
        const isRls = /row-level security|violates|401|forbidden|not authorized/i.test(msg);
        if (isRls) {
          if (!rlsMessageLogged) {
            console.warn(
              '[ArticleArchive] Supabase RLS rejected the upsert (' + msg + '). ' +
              'The seen_articles table is blocking inserts for this JWT role. ' +
              'Archiving is disabled until the next successful flush (usually after signing in). ' +
              'To re-enable: add an INSERT policy on seen_articles for your role, or run:\n' +
              '  alter table seen_articles disable row level security;'
            );
            rlsMessageLogged = true;
          }
          // Drop the batch (don't re-queue — it will just fail again
          // on the next flush). Disable further attempts so we don't
          // keep reading from localStorage and spamming the network.
          disabledUntilAuth = true;
          // Re-queue the batch anyway — when the user signs in and
          // the next flush succeeds, these items will be re-tried.
          // (Cheap to keep; the queue cap bounds it.)
          queue.unshift(...batch);
          saveQueue();
          return;
        }
        // Generic non-RLS failure: throttle the log + re-queue.
        const now = Date.now();
        if (now - lastErrorLoggedAt > 30000) {
          console.warn('[ArticleArchive] flush failed:', msg);
          lastErrorLoggedAt = now;
        }
        queue.unshift(...batch);
        saveQueue();
        return;
      }

      // Success — the table accepts our inserts. If we were previously
      // disabled by an RLS rejection, clear the flags and re-enable.
      if (disabledUntilAuth) {
        console.log('[ArticleArchive] RLS issue resolved — archiving re-enabled.');
        disabledUntilAuth = false;
        rlsMessageLogged = false;
      }
      // Persist the (now smaller) queue.
      saveQueue();
    } catch (err) {
      const msg = (err && err.message) || String(err);
      // Network error / fetch failed. Retry — these are transient.
      const now = Date.now();
      if (now - lastErrorLoggedAt > 30000) {
        console.warn('[ArticleArchive] flush threw:', msg);
        lastErrorLoggedAt = now;
      }
      queue.unshift(...batch);
      saveQueue();
    } finally {
      isFlushing = false;
      // If more items piled up while we were flushing, run again.
      if (pendingFlush || queue.length >= BATCH_SIZE) {
        pendingFlush = false;
        scheduleFlush();
      } else if (queue.length > 0) {
        scheduleFlush();
      }
    }
  }

  // Load any persisted queue from a previous session and resume
  // flushing. Called once at app boot.
  function init() {
    queue = loadQueue();
    if (queue.length > 0) {
      console.log('[ArticleArchive] resuming with', queue.length, 'queued items from last session');
      scheduleFlush();
    }

    // Flush on network reconnect — items that piled up while
    // offline should drain as soon as the user is back.
    window.addEventListener('online', () => {
      if (queue.length > 0) flush();
    });

    // Drain the queue the moment the user signs in. If they
    // collected items while signed out, the upserts would have
    // failed (RLS) and re-queued; the next SIGNED_IN event gives
    // us a clean moment to push them through.
    try {
      const client = SupabaseStore.getClient ? SupabaseStore.getClient() : null;
      if (client && client.auth && client.auth.onAuthStateChange) {
        client.auth.onAuthStateChange((event, session) => {
          if (event === 'SIGNED_IN' && session && queue.length > 0) {
            flush();
          }
        });
      }
    } catch {}
  }

  // Diagnostic: how many items are waiting + last error
  function stats() {
    return {
      queueSize: queue.length,
      isFlushing: isFlushing,
      pendingFlush: pendingFlush,
      maxQueue: MAX_QUEUE_SIZE,
      batchSize: BATCH_SIZE
    };
  }

  // Expose a manual flush for tests / debugging.
  function flushNow() { return flush(); }

  return { ingest, flush, flushNow, init, stats };
})();

// Expose on window — see js/feeds.js for the rationale.
window.ArticleArchive = ArticleArchive;
