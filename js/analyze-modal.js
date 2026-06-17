/* ── Analyze Modal + Subject Dashboard ──
 *
 * Implements Milestones 2, 5 and 6:
 *
 *   2. Scoring Configuration Modal
 *        - Opens from a card's ⚖️ button or the global 📊 button.
 *        - Auto-fills the subject name from the article (if any).
 *        - Collects source scope, optional date range, optional
 *          focus topic.
 *        - On "Run Analysis" closes the modal and opens the
 *          Subject Dashboard.
 *
 *   5. Analysis Dashboard UI
 *        - Full-screen overlay (`#subject-dashboard`).
 *        - Left sidebar: avatar + four metric cards.
 *        - Right main panel: news articles on top, tweets on
 *          the bottom, each colour-coded by sentiment.
 *
 *   6. Analysis Orchestration
 *        - Parallel fetch: Twitter + cached news articles.
 *        - Progress overlay with deterministic messages
 *          ("Analyzing Lexicon…", "Fetching Tweets…", etc.).
 *        - Persist the final result in localStorage under
 *          `analysis_results_[handle]`.
 */
const AnalyzeModal = (() => {
  // Local helpers so this module doesn't depend on the `$` defined
  // inside the app.js IIFE.
  function $(sel, ctx) { return (ctx || document).querySelector(sel); }
  // Modal helpers from app.js (exposed on window.appState).
  function openModal(name, el, onClose) {
    return window.appState ? window.appState.openModal(name, el, onClose) : null;
  }
  function closeModal(name) {
    return window.appState ? window.appState.closeModal(name) : null;
  }
  let currentConfig = null; // last submitted config (for re-run)
  let dashboardOpen = false;

  // ── Config modal ─────────────────────────────────────────────
  function openConfig(opts) {
    opts = opts || {};
    const modal = $('#analyze-config-modal');
    if (!modal) return;
    const subjectInput = $('#acf-subject-input');
    const subject = opts.subject || null;
    if (subjectInput) {
      subjectInput.value = subject ? subject.display_name : '';
    }
    // Reset radios to default (Both)
    const both = $('#acf-source-both');
    if (both) both.checked = true;
    // Default date range to the last 7 days (the Twitter free-tier
    // window). The user can still clear it for "all time" feeds-only
    // analysis.
    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const ds = $('#acf-date-start');
    if (ds) ds.value = isoDateForInput(sevenDaysAgo);
    const de = $('#acf-date-end');
    if (de) de.value = isoDateForInput(now);
    // Reset focus
    const focus = $('#acf-focus-input'); if (focus) focus.value = '';
    openModal('analyzeConfig', modal);
    setTimeout(() => subjectInput?.focus(), 100);
    // Render the suggest list (empty until they type).
    renderSubjectSuggest('');
  }
  function closeConfig() { closeModal('analyzeConfig'); }

  // Convert a Date to the YYYY-MM-DD string used by <input type="date">.
  function isoDateForInput(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + dd;
  }

  // Render the subject-suggest dropdown. When the input is empty
  // we show the full SUBJECT_REGISTRY; as the user types, we
  // filter to entries whose name OR any alias contains the query.
  function renderSubjectSuggest(query) {
    const box = $('#acf-subject-suggest');
    if (!box) return;
    const q = (query || '').toLowerCase().trim();
    let entries = Object.entries(SUBJECT_REGISTRY);
    if (q) {
      entries = entries.filter(([_, s]) => {
        if ((s.display_name || '').toLowerCase().includes(q)) return true;
        if ((s.aliases || []).some(a => (a || '').toLowerCase().includes(q))) return true;
        if ((s.twitter_handle || '').toLowerCase().includes(q)) return true;
        return false;
      });
    }
    if (!entries.length) {
      box.innerHTML = '<div class="acf-suggest-empty">No matches. You can still type a custom name to analyse any Twitter handle.</div>';
      return;
    }
    box.innerHTML = entries.map(([_, s]) => {
      return '<button type="button" class="acf-suggest-row" data-name="' + escapeAttr(s.display_name) + '">' +
        '<span class="acf-suggest-name">' + escapeHtml(s.display_name) + '</span>' +
        '<span class="acf-suggest-handle">@' + escapeHtml(s.twitter_handle || '\u2014') + '</span>' +
      '</button>';
    }).join('');
    // Bind clicks: each row fills the input.
    box.querySelectorAll('.acf-suggest-row').forEach(btn => {
      btn.addEventListener('click', () => {
        const input = $('#acf-subject-input');
        if (input) input.value = btn.dataset.name;
        box.innerHTML = '';
      });
    });
  }

  function readConfig() {
    const subjectInput = $('#acf-subject-input');
    const name = (subjectInput?.value || '').trim();
    if (!name) {
      // Inline-error state. We also show a tooltip on the input so
      // the user gets a clear "why did nothing happen" signal.
      if (subjectInput) {
        subjectInput.classList.add('acf-input-error');
        subjectInput.title = 'Enter a person\u2019s name to analyse';
        subjectInput.focus();
        setTimeout(() => {
          subjectInput.classList.remove('acf-input-error');
          subjectInput.title = '';
        }, 1800);
      }
      return null;
    }
    const sourceEl = document.querySelector('input[name="acf-source"]:checked');
    const source_scope = sourceEl ? sourceEl.value : 'both';
    const date_start = $('#acf-date-start')?.value || '';
    const date_end = $('#acf-date-end')?.value || '';
    const focus = $('#acf-focus-input')?.value?.trim() || '';
    // Resolve to a registry entry by exact name match first, then alias
    let subject = null;
    for (const key of Object.keys(SUBJECT_REGISTRY)) {
      const s = SUBJECT_REGISTRY[key];
      if (s.display_name.toLowerCase() === name.toLowerCase()) { subject = s; break; }
    }
    if (!subject) {
      for (const key of Object.keys(SUBJECT_REGISTRY)) {
        const s = SUBJECT_REGISTRY[key];
        if ((s.aliases || []).some(a => a.toLowerCase() === name.toLowerCase())) { subject = s; break; }
      }
    }
    if (!subject) {
      // Synthesise a subject object so the dashboard still works
      // (the user may have typed a name we don't have a Twitter
      // handle for). Tweets will be skipped if the handle is empty.
      const handle = name.toLowerCase().replace(/[^a-z0-9_]/g, '');
      subject = {
        display_name: name,
        twitter_handle: handle,
        aliases: [name.toLowerCase()],
        _unregistered: true
      };
    }
    return {
      subject,
      source_scope,
      date_start,
      date_end,
      focus_topic: focus
    };
  }

  // ── Dashboard ────────────────────────────────────────────────
  function openDashboard(report) {
    const dash = $('#subject-dashboard');
    if (!dash) return;
    dashboardOpen = true;
    const name = $('#sd-name');
    const handle = $('#sd-handle');
    if (name) name.textContent = report.subject.display_name;
    if (handle) handle.textContent = report.subject.twitter_handle ? '@' + report.subject.twitter_handle : 'No Twitter handle';
    const avatar = $('#sd-avatar-circle');
    if (avatar) {
      avatar.textContent = (report.subject.display_name || '?')
        .split(/\s+/).map(p => p[0] || '').slice(0, 2).join('').toUpperCase();
    }
    // Metrics
    setMetric('hypocrisy', report.hypocrisy.score, report.hypocrisy);
    setMetric('relevance', report.relevance.score, report.relevance);
    setMetric('clarity', report.clarity.score, report.clarity);
    const biasEl = $('#sd-metric-bias');
    if (biasEl) biasEl.textContent = report.bias.bias;
    // Justification text — render to a hidden panel. The user opens
    // it with the "Read Justification" button in the header.
    renderJustification(report);
    // Word cloud
    renderWordCloud(report.topWords);
    // Articles + Tweets
    renderNewsList(report.articles || [], report.focusTopic);
    renderTweetsList(report.tweets || []);
    // Status line
    const status = $('#sd-status');
    if (status) status.textContent = 'Generated ' + new Date(report.generatedAt).toLocaleTimeString();
    dash.style.display = 'flex';
    requestAnimationFrame(() => dash.classList.add('sd-open'));

    // Push a history entry so the browser back button closes the
    // dashboard. We use a fresh frame (not nested under the
    // analyze-config modal which has already been closed by the
    // time we get here) so a single back press returns to the
    // main feed. The app's popstate handler will detect the
    // dashboard marker and call closeDashboard() for us.
    try {
      const state = { ibDashboard: true };
      const url = new URL(window.location.href);
      url.searchParams.set('subject', encodeURIComponent(report.subject.display_name || ''));
      window.history.pushState(state, '', url.toString());
      if (window.appState) {
        // Read the new frame id via the getter (which increments
        // the underlying counter as a side effect).
        dashboardFrameId = window.appState.nextFrameId;
        if (typeof window.appState.pushFrame === 'function') {
          window.appState.pushFrame(dashboardFrameId);
        }
      }
    } catch {}
    document.body.classList.add('modal-open');
  }
  function closeDashboard() {
    const dash = $('#subject-dashboard');
    if (!dash) return;
    dashboardOpen = false;
    dash.classList.remove('sd-open');
    setTimeout(() => { dash.style.display = 'none'; }, 200);
    // If we pushed a history entry when the dashboard opened, the
    // back button already consumed it via the popstate handler.
    // We only need to pop our own frame stack if we left a frame
    // on the pushedFrameStack (i.e. user used the X button rather
    // than the browser back). If the stack still has a dashboard
    // frame at the top, drop it.
    if (window.appState && typeof window.appState.dropPushedFrame === 'function') {
      window.appState.dropPushedFrame(dashboardFrameId);
    }
    dashboardFrameId = -1;
    document.body.classList.remove('modal-open');
  }

  // Frame id for the dashboard. Pushed onto the app's history
  // stack when the dashboard opens so the back button pops it
  // cleanly. The app exposes dropPushedFrame() so we can clean up
  // when the user closes via the X button.
  let dashboardFrameId = -1;
  function setMetric(key, value, meta) {
    const el = $('#sd-metric-' + key);
    if (!el) return;
    el.textContent = value == null ? '—' : (typeof value === 'number' ? Math.round(value) : value);
    // Color tinting by metric
    const card = el.closest('.sd-metric');
    if (card) {
      card.classList.remove('sd-metric-low', 'sd-metric-mid', 'sd-metric-high');
      let bucket = 'sd-metric-mid';
      if (key === 'hypocrisy') {
        // High hypocrisy is bad
        if (value < 25) bucket = 'sd-metric-low';
        else if (value > 60) bucket = 'sd-metric-high';
      } else {
        if (value >= 70) bucket = 'sd-metric-high';
        else if (value < 30) bucket = 'sd-metric-low';
      }
      card.classList.add(bucket);
    }
  }
  function renderWordCloud(words) {
    const el = $('#sd-wordcloud');
    if (!el) return;
    if (!words || !words.length) {
      el.innerHTML = '<span class="sd-empty">No focus words extracted.</span>';
      return;
    }
    const max = words[0].count || 1;
    el.innerHTML = words.map(w => {
      const size = 0.8 + (w.count / max) * 1.4; // 0.8rem - 2.2rem
      return '<span class="sd-word" style="font-size:' + size.toFixed(2) + 'rem">' + escapeHtml(w.word) + '</span>';
    }).join('');
  }

  // Render the "Read Justification" panel. We go score-by-score and
  // collect specific evidence (the most positive/negative tweets,
  // top sources, top trending words) so the user sees *why* the
  // numbers are what they are — not just a generic description of
  // the formula.
  function renderJustification(report) {
    const el = $('#sd-justification');
    if (!el) return;
    // Build the Hypocrisy evidence: list the top opposing-pair
    // tweets (when available) and the article sentiment.
    const hypPos = [];
    const hypNeg = [];
    const articleText = (report.articles || []).map(a => (a.title || '') + '. ' + (a.summary || '')).join(' ');
    const articleSent = report.hypocrisy.articleSentiment != null
      ? report.hypocrisy.articleSentiment
      : (window.ScoringEngine ? ScoringEngine.corpusSentiment(articleText) : 0);
    // For each tweet, classify by sentiment polarity.
    for (const t of (report.tweets || [])) {
      const s = ScoringEngine.sentenceSentiment(t.text || '');
      if (s > 1) hypPos.push({ text: t.text, score: s });
      else if (s < -1) hypNeg.push({ text: t.text, score: s });
    }
    hypPos.sort((a, b) => b.score - a.score);
    hypNeg.sort((a, b) => a.score - b.score);
    // Relevance evidence: top 3 tweets that share the most words
    // with the article corpus.
    const relTop = (report.tweets || []).slice(0, 3);
    // Bias evidence: list the most-frequent left/right words.
    const bias = report.bias;
    // Clarity evidence: top 3 sources by authority weight.
    const clarityTop = (report.clarity.sources || []).slice(0, 5);

    el.innerHTML =
      '<div class="sd-justification-header">' +
        '<h3>Score Justification</h3>' +
        '<button type="button" class="btn btn-ghost btn-icon sd-justification-close" id="sd-justification-close">&times;</button>' +
      '</div>' +
      // Hypocrisy
      '<div class="sd-just-card sd-just-hypocrisy">' +
        '<div class="sd-just-title">Hypocrisy — ' + report.hypocrisy.score + ' / 100</div>' +
        '<div class="sd-just-formula">Opposing sentiment pairs ÷ total comparative pairs × 100</div>' +
        (articleSent !== undefined && articleSent !== 0
          ? '<div class="sd-just-pair"><span class="sd-just-pair-label">Article sentiment:</span> ' + (articleSent > 0 ? '+' : '') + articleSent.toFixed(2) + ' (' + (articleSent > 0.5 ? 'overall positive' : articleSent < -0.5 ? 'overall negative' : 'mixed') + ')</div>'
          : '') +
        (report.hypocrisy.opposingPairs > 0
          ? '<div class="sd-just-pair"><span class="sd-just-pair-label">Opposing pairs found:</span> ' + report.hypocrisy.opposingPairs + ' of ' + report.hypocrisy.totalPairs + ' tweet/article pairs</div>'
          : '<div class="sd-just-pair"><span class="sd-just-pair-label">No opposing pairs:</span> tweets and articles mostly agree in sentiment.</div>') +
        (hypPos.length
          ? '<div class="sd-just-list-label">Most positive tweet (likely the subject\'s voice):</div>' +
            '<div class="sd-just-quote sd-quote-pos">"' + escapeHtml(hypPos[0].text) + '"</div>'
          : '') +
        (hypNeg.length
          ? '<div class="sd-just-list-label">Most negative tweet (or critical coverage):</div>' +
            '<div class="sd-just-quote sd-quote-neg">"' + escapeHtml(hypNeg[0].text) + '"</div>'
          : '') +
      '</div>' +
      // Relevance
      '<div class="sd-just-card sd-just-relevance">' +
        '<div class="sd-just-title">Relevance — ' + report.relevance.score + ' / 100</div>' +
        '<div class="sd-just-formula">TF-IDF cosine similarity between tweet corpus and article corpus × 100</div>' +
        (relTop.length
          ? '<div class="sd-just-list-label">Sample tweets used:</div>' +
            relTop.slice(0, 2).map(t => '<div class="sd-just-quote">"' + escapeHtml((t.text || '').slice(0, 140)) + (t.text && t.text.length > 140 ? '…' : '') + '"</div>').join('')
          : '<div class="sd-just-pair">No tweets available to compute relevance.</div>') +
        (report.relevance.similarity != null
          ? '<div class="sd-just-pair"><span class="sd-just-pair-label">Raw similarity:</span> ' + report.relevance.similarity.toFixed(4) + '</div>'
          : '') +
      '</div>' +
      // Bias
      '<div class="sd-just-card sd-just-bias">' +
        '<div class="sd-just-title">Bias — ' + escapeHtml(bias.bias) + '</div>' +
        '<div class="sd-just-formula">Left-word count vs right-word count in last ' + (bias.totalTweets || 0) + ' tweets. Lean is the side with ≥ 1.5× the other.</div>' +
        '<div class="sd-just-pair"><span class="sd-just-pair-label">Left-leaning words:</span> ' + bias.left + ' &nbsp;·&nbsp; <span class="sd-just-pair-label">Right-leaning words:</span> ' + bias.right + '</div>' +
      '</div>' +
      // Clarity
      '<div class="sd-just-card sd-just-clarity">' +
        '<div class="sd-just-title">Factual Clarity — ' + report.clarity.score + ' / 100</div>' +
        '<div class="sd-just-formula">Average source authority across unique sources. Top-tier (1.2) ≈ 90, default (1.0) ≈ 50, low-tier (0.9) ≈ 30.</div>' +
        (clarityTop.length
          ? '<div class="sd-just-list-label">Top sources by authority:</div>' +
            '<ul class="sd-just-sources">' +
              clarityTop.map(s => '<li><span class="sd-just-src-name">' + escapeHtml(s.source) + '</span><span class="sd-just-src-weight"> weight ' + s.weight.toFixed(2) + (s.type === 'potential' ? ' (potential)' : '') + '</span></li>').join('') +
            '</ul>'
          : '<div class="sd-just-pair">No source data available.</div>') +
        (report.clarity.actualCount != null
          ? '<div class="sd-just-pair"><span class="sd-just-pair-label">Source pool:</span> ' + report.clarity.actualCount + ' actual + ' + (report.clarity.potentialCount || 0) + ' potential from full database</div>'
          : '') +
      '</div>' +
      '<div class="sd-just-footnote">' +
        'These scores are rule-based, not AI-generated. They are deterministic given the same inputs and the same algorithm — see <code>js/scoring-engine.js</code>.' +
      '</div>';
  }
  function renderNewsList(articles, focusTopic) {
    const list = $('#sd-news-list');
    const count = $('#sd-news-count');
    if (count) count.textContent = articles.length;
    if (!list) return;
    if (!articles.length) {
      list.innerHTML = '<div class="sd-empty">No articles matched this subject in the current cache.</div>';
      return;
    }
    list.innerHTML = articles.slice(0, 30).map(a => {
      const text = ((a.title || '') + ' ' + (a.summary || '')).replace(/<[^>]+>/g, '');
      const snippet = text.length > 220 ? text.slice(0, 220) + '…' : text;
      const sent = ScoringEngine.corpusSentiment(snippet);
      const sentClass = sent > 0.5 ? 'sd-pos' : (sent < -0.5 ? 'sd-neg' : 'sd-neu');
      const sentLabel = sent > 0.5 ? '+' + sent.toFixed(1) : sent.toFixed(1);
      const isFocused = focusTopic && text.toLowerCase().includes(focusTopic.toLowerCase());
      return '<div class="sd-news-row ' + sentClass + (isFocused ? ' sd-focused' : '') + '">' +
        '<div class="sd-news-snippet">' + escapeHtml(snippet) + '</div>' +
        '<div class="sd-news-meta">' +
          '<span class="sd-news-source">' + escapeHtml(a.source || 'Unknown') + '</span>' +
          '<span class="sd-news-date">' + escapeHtml(formatDate(a.pubDate)) + '</span>' +
          '<span class="sd-news-sent" title="Sentiment">&#x1F4AC; ' + sentLabel + '</span>' +
        '</div>' +
      '</div>';
    }).join('');
  }
  function renderTweetsList(tweets) {
    const list = $('#sd-tweets-list');
    const count = $('#sd-tweets-count');
    if (count) count.textContent = tweets.length;
    if (!list) return;
    if (!tweets.length) {
      list.innerHTML = '<div class="sd-empty">' +
        'No tweets fetched.' +
        '<br>' +
        '<button type="button" class="btn btn-primary" id="sd-open-settings" style="margin-top:12px;">' +
        'Open Settings → Twitter API' +
        '</button>' +
        '<p class="sd-empty-hint">Add a free-tier Bearer token from <code>developer.twitter.com</code> and re-run the analysis. Twitter\'s free API only returns tweets from the last 7 days.</p>' +
        '</div>';
      const openSettingsBtn = $('#sd-open-settings');
      if (openSettingsBtn) {
        openSettingsBtn.addEventListener('click', () => {
          closeDashboard();
          // Find the Settings button and open it.
          const settingsBtn = $('#settings-btn');
          if (settingsBtn) settingsBtn.click();
        });
      }
      return;
    }
    list.innerHTML = tweets.map(t => {
      const sent = ScoringEngine.sentenceSentiment(t.text || '');
      const sentClass = sent > 0.5 ? 'sd-pos' : (sent < -0.5 ? 'sd-neg' : 'sd-neu');
      const sentLabel = sent > 0.5 ? '+' + sent.toFixed(1) : sent.toFixed(1);
      return '<div class="sd-tweet-row ' + sentClass + '">' +
        '<div class="sd-tweet-text">' + escapeHtml(t.text || '') + '</div>' +
        '<div class="sd-tweet-meta">' +
          '<span class="sd-tweet-date">' + escapeHtml(formatDate(t.created_at)) + '</span>' +
          '<span class="sd-tweet-sent" title="Sentiment">&#x1F4AC; ' + sentLabel + '</span>' +
          (t.metrics && (t.metrics.like_count || t.metrics.retweet_count)
            ? '<span class="sd-tweet-stats">&#x1F44D; ' + (t.metrics.like_count || 0) + ' · \u21BB; ' + (t.metrics.retweet_count || 0) + '</span>'
            : '') +
        '</div>' +
      '</div>';
    }).join('');
  }

  // ── Orchestration: run the analysis ──────────────────────────
  async function runAnalysis(config) {
    if (!config) return;
    console.log('[Analyze] runAnalysis called with', config);
    currentConfig = config;
    // Show progress overlay BEFORE closing the config modal so the
    // user always sees it appear (not a flash of nothing).
    setProcessingText('Loading cached articles…');
    showProcessing();
    try {
      // 1. Filter cached articles to this subject
      const articlePool = collectSubjectArticles(config.subject);
      setProcessingText('Filtering ' + articlePool.length + ' articles…');
      await tick();

      // 2. Date-range filter
      const filtered = filterArticlesByDate(articlePool, config.date_start, config.date_end);
      setProcessingText('Analyzing ' + filtered.length + ' articles for claims…');
      await tick();

      // 3. Twitter fetch
      let tweets = [];
      let twitterError = null;
      if (config.source_scope === 'twitter' || config.source_scope === 'both') {
        if (!config.subject.twitter_handle) {
          twitterError = 'No Twitter handle registered for this subject.';
        } else {
          setProcessingText('Fetching tweets for @' + config.subject.twitter_handle + '…');
          await tick();
          const opts = { maxResults: 100 };
          // Enforce Twitter's free-tier limit of 7 days. If the
          // user asked for a wider range, clamp the start time to
          // 7 days back and surface a warning so they understand
          // why older tweets aren't included. The free tier of the
          // Twitter API v2 search endpoint only returns tweets from
          // the last 7 days. For longer ranges, the user would need
          // a paid academic-research or premium API key.
          let clamped = false;
          if (config.date_start) {
            const wanted = new Date(config.date_start + 'T00:00:00').getTime();
            const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
            if (!isNaN(wanted) && wanted < sevenDaysAgo) {
              opts.startTime = new Date(sevenDaysAgo).toISOString();
              clamped = true;
            } else {
              opts.startTime = toIsoDate(config.date_start, false);
            }
          }
          if (config.date_end) opts.endTime = toIsoDate(config.date_end, true);
          if (clamped) {
            twitterError = 'Twitter free API only covers the last 7 days. Older tweets were skipped — see Settings → Twitter API to learn about paid access.';
          }
          const t = await TwitterFetcher.fetchTweets(config.subject.twitter_handle, opts);
          if (t.ok) {
            tweets = t.tweets;
            setProcessingText('Analyzing lexicon on ' + tweets.length + ' tweets…');
            await tick();
          } else {
            twitterError = t.message || t.reason || 'Twitter fetch failed';
            setProcessingText('Twitter fetch failed: ' + twitterError);
            await tick(800);
          }
        }
      }
      // 4. Feeds only? Just use the filtered articles. Otherwise use
      // both. The score is computed over what we have.
      if (config.source_scope === 'twitter') {
        setProcessingText('Computing scores from tweets only…');
        await tick();
        const report = ScoringEngine.analyze({
          subject: config.subject,
          articles: [],
          tweets,
          opts: { focusTopic: config.focus_topic }
        });
        report.twitterError = twitterError;
        report.config = config;
        cacheReport(config.subject.twitter_handle || config.subject.display_name, report);
        openDashboard(report);
        return;
      }

      // 5. Compute the four scores
      setProcessingText('Computing Hypocrisy, Relevance, Bias, Clarity…');
      await tick();
      // Pull the full feeds database so the clarity score can
      // consider sources the user hasn't subscribed to.
      const allFeeds = (window.FeedManager && typeof FeedManager.getSubscribableFeeds === 'function')
        ? FeedManager.getSubscribableFeeds()
        : null;
      const report = ScoringEngine.analyze({
        subject: config.subject,
        articles: filtered,
        tweets,
        opts: { focusTopic: config.focus_topic, allFeeds }
      });
      report.articles = filtered.slice(0, 50);
      report.tweets = tweets;
      report.twitterError = twitterError;
      report.config = config;
      cacheReport(config.subject.twitter_handle || config.subject.display_name, report);
      console.log('[Analyze] report ready, opening dashboard');
      openDashboard(report);
    } catch (e) {
      console.error('Analysis failed:', e);
      setProcessingText('Analysis failed: ' + (e.message || e));
      await tick(1500);
    } finally {
      // Keep the overlay up if the dashboard is about to take over,
      // otherwise the user sees a flash. The dashboard opens the
      // moment we call openDashboard, so the overlay fade is
      // imperceptible.
      hideProcessing();
    }
  }

  // Walk every scope cache and pull out articles that mention the
  // subject. This is intentionally cross-scope: a person may have
  // more coverage in Global while the user is looking at India.
  function collectSubjectArticles(subject) {
    const out = [];
    if (!window.appState) return out;
    const caches = window.appState.scopeCache || {};
    const seen = new Set();
    for (const key of Object.keys(caches)) {
      const cached = caches[key];
      if (!cached || !cached.groups) continue;
      for (const cat of Object.keys(cached.groups)) {
        for (const a of cached.groups[cat] || []) {
          if (seen.has(a.link)) continue;
          if (!a.subject) continue;
          if (a.subject.display_name !== subject.display_name) continue;
          seen.add(a.link);
          out.push(a);
        }
      }
    }
    return out;
  }
  function filterArticlesByDate(articles, startStr, endStr) {
    if (!startStr && !endStr) return articles;
    const start = startStr ? new Date(startStr + 'T00:00:00').getTime() : -Infinity;
    const end = endStr ? new Date(endStr + 'T23:59:59').getTime() : Infinity;
    return articles.filter(a => {
      const t = new Date(a.pubDate || 0).getTime();
      if (isNaN(t)) return false;
      return t >= start && t <= end;
    });
  }
  function toIsoDate(yyyyMmDd, endOfDay) {
    if (!yyyyMmDd) return null;
    const suffix = endOfDay ? 'T23:59:59Z' : 'T00:00:00Z';
    return yyyyMmDd + suffix;
  }
  function tick(ms) {
    return new Promise(r => setTimeout(r, ms || 0));
  }

  // ── Caching ──────────────────────────────────────────────────
  function cacheReport(key, report) {
    if (!key) return;
    try {
      const stripped = {
        ...report,
        // Articles are large; trim for cache
        articles: (report.articles || []).map(a => ({
          link: a.link, title: a.title, source: a.source, pubDate: a.pubDate, summary: a.summary
        }))
      };
      localStorage.setItem('analysis_results_' + key, JSON.stringify(stripped));
    } catch (e) {
      console.warn('Failed to cache analysis:', e);
    }
  }
  function readReport(key) {
    try {
      const raw = localStorage.getItem('analysis_results_' + key);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }

  // ── Processing overlay helpers (shared with the legacy
  // setTopListStatus but routed through our own helpers so the
  // dashboard flow is independent) ──
  function setProcessingText(text) {
    const tx = $('#processing-text');
    if (tx) tx.textContent = text || 'Loading…';
  }
  function showProcessing() {
    const ov = $('#processing-overlay');
    if (ov) ov.classList.remove('processing-hidden');
  }
  function hideProcessing() {
    const ov = $('#processing-overlay');
    if (ov) ov.classList.add('processing-hidden');
  }

  // ── Bindings ────────────────────────────────────────────────
  function bindAll() {
    // Header analyze button (the scale icon in the IB row)
    const headerBtn = $('#analyze-btn');
    if (headerBtn) {
      headerBtn.addEventListener('click', () => openConfig({}));
    }
    // Config modal close + run
    const closeBtn = $('#analyze-config-close');
    if (closeBtn) closeBtn.addEventListener('click', closeConfig);
    const cancelBtn = $('#analyze-config-cancel');
    if (cancelBtn) cancelBtn.addEventListener('click', closeConfig);
    const runBtn = $('#analyze-config-run');
    if (runBtn) {
      runBtn.addEventListener('click', () => {
        const config = readConfig();
        if (!config) return;
        closeConfig();
        runAnalysis(config);
      });
    }
    // Live-filter the suggest list as the user types.
    const subjectInput = $('#acf-subject-input');
    if (subjectInput) {
      subjectInput.addEventListener('input', () => renderSubjectSuggest(subjectInput.value));
    }
    // Click outside the modal box closes it
    const modal = $('#analyze-config-modal');
    if (modal) modal.addEventListener('click', e => { if (e.target === modal) closeConfig(); });
    // Dashboard back button
    const back = $('#sd-back');
    if (back) back.addEventListener('click', closeDashboard);
    // Read Justification toggle
    const justifyBtn = $('#sd-justify-btn');
    const justifyPanel = $('#sd-justification');
    const justifyClose = $('#sd-justification-close');
    if (justifyBtn && justifyPanel) {
      justifyBtn.addEventListener('click', () => {
        const open = justifyPanel.style.display !== 'none';
        justifyPanel.style.display = open ? 'none' : 'block';
        justifyBtn.classList.toggle('active', !open);
      });
    }
    if (justifyClose && justifyPanel) {
      justifyClose.addEventListener('click', () => {
        justifyPanel.style.display = 'none';
        if (justifyBtn) justifyBtn.classList.remove('active');
      });
    }
    // Esc closes the dashboard
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && dashboardOpen) {
        e.stopPropagation();
        closeDashboard();
      }
    });
  }

  // Helpers — duplicated to keep this module standalone.
  function escapeHtml(s) { return (s == null ? '' : String(s)).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function formatDate(d) {
    const date = new Date(d);
    if (isNaN(date.getTime())) return d || '';
    return date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  return {
    openConfig,
    closeConfig,
    runAnalysis,
    openDashboard,
    closeDashboard,
    bindAll,
    readReport,
    cacheReport
  };
})();

// Expose on window so app.js (which loads after us and inside an
// IIFE) can reach the module through `window.AnalyzeModal`. Without
// this line the per-card ⚖️ button and the header scale icon both
// silently no-op because the click handler's `if (window.AnalyzeModal)`
// guard returns false.
window.AnalyzeModal = AnalyzeModal;
