(async () => {
  const $ = (sel, ctx = document) => ctx.querySelector(sel);
  const $$ = (sel, ctx = document) => [...ctx.querySelectorAll(sel)];

  let currentScope = 'global';
  let currentNation = FeedManager.getSelectedNation();
  let currentSubcat = 'all';
  let currentMode = 'live';
  let currentView = 'list';
  let scopeCache = {};
  let isFetching = false;
  let currentArticles = [];
  let loadedCount = 0;

  const el = {
    topTabs: $('#top-tab-list'),
    subTabs: $('#sub-tab-list'),
    subBar: $('#sub-tab-bar'),
    main: $('#main-content'),
    settingsBtn: $('#settings-btn'),
    modal: $('#settings-modal'),
    modalClose: $('#modal-close'),
    modalCancel: $('#modal-cancel'),
    modalSave: $('#modal-save'),
    dateFrom: $('#date-from'),
    dateTo: $('#date-to'),
    dateToggle: $('#date-toggle-btn'),
    dateRange: $('#date-range'),
    articleModal: $('#article-modal'),
    articleModalClose: $('#article-modal-close'),
    articleModalTitle: $('#article-modal-title'),
    articleModalSource: $('#article-modal-source'),
    articleModalDate: $('#article-modal-date'),
    articleModalSummary: $('#article-modal-summary'),
    articleModalImg: $('#article-modal-img'),
    articleModalImgWrap: $('#article-modal-img-wrap'),
    articleModalRead: $('#article-modal-read'),
    articleModalExt: $('#article-modal-ext-link'),
    sourceModal: $('#source-modal'),
    sourceModalClose: $('#source-modal-close'),
    sourceModalTitle: $('#source-modal-title'),
    feedUrlInput: $('#feed-url-input'),
    feedNameInput: $('#feed-name-input'),
    feedScopeSelect: $('#feed-scope-select'),
    feedNationSelect: $('#feed-nation-select'),
    feedSubcatSelect: $('#feed-subcat-select'),
    feedValidateBtn: $('#feed-validate-btn'),
    feedAddBtn: $('#feed-add-btn'),
    feedValidateMsg: $('#feed-validate-msg'),
    feedCustomList: $('#feed-custom-list'),
    sectionTitle: $('#section-title'),
    sectionMeta: $('#section-meta'),
    modeToggle: $('#mode-toggle'),
    searchInput: $('#search-input'),
    langSelect: $('#lang-select'),
    filterSource: $('#filter-source'),
    sortBy: $('#sort-by'),
    searchToggle: $('#search-toggle'),
    filterToggle: $('#filter-toggle'),
    sortToggle: $('#sort-toggle'),
    filtersPanel: $('#filters-panel'),
    viewToggle: $('#view-toggle')
  };

  if (!el.modal) return;

  function formatDate(d) {
    const date = new Date(d);
    if (isNaN(date.getTime())) return d;
    return date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  function formatDateShort(d) {
    const date = new Date(d);
    if (isNaN(date.getTime())) return d;
    const diff = Date.now() - date.getTime();
    if (diff < 0) return 'just now';
    const mins = Math.floor(diff / 60000);
    if (mins < 60) return mins + 'm ago';
    const hours = Math.floor(mins / 60);
    if (hours < 24) return hours + 'h ago';
    const days = Math.floor(hours / 24);
    if (days < 7) return days + 'd ago';
    return date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
  }

  function stripHtml(html) {
    const div = document.createElement('div');
    div.innerHTML = html;
    return div.textContent || div.innerText || '';
  }

  function getDomain(url) {
    try { return new URL(url).hostname.replace('www.', ''); }
    catch { return ''; }
  }

  /* ── Top-Level Tabs (Global / Nation) ── */
  function renderTopTabs() {
    const nations = FeedManager.getNations();
    const current = currentNation;
    let html = '<li class="tab-item' + (currentScope === 'global' ? ' active' : '') + '" data-scope="global">Global</li>';
    for (const [key, label] of Object.entries(nations)) {
      html += '<li class="tab-item' + (currentScope === 'nation' && current === key ? ' active' : '') + '" data-scope="nation" data-nation="' + key + '">' + label + '</li>';
    }
    el.topTabs.innerHTML = html;
  }

  function bindTopTabs() {
    el.topTabs.addEventListener('click', e => {
      const tab = e.target.closest('.tab-item');
      if (!tab) return;
      const scope = tab.dataset.scope;
      const nation = tab.dataset.nation || currentNation;
      if (scope === currentScope && (scope !== 'nation' || nation === currentNation)) return;
      currentScope = scope;
      currentNation = nation;
      FeedManager.setSelectedNation(nation);
      loadedCount = 0;
      $$('.tab-item', el.topTabs).forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      renderSubTabs();
      renderContent();
    });
  }

  /* ── Subcategory Tabs ── */
  function getFilteredArticles(subcat, cached) {
    if (!cached) return [];
    let articles;
    if (subcat === 'all') {
      articles = [];
      for (const cat of Object.keys(cached.groups)) {
        articles.push(...cached.groups[cat]);
      }
    } else {
      articles = cached.groups[subcat] || [];
    }
    if (!articles.length) return [];
    if (currentMode === 'top') {
      articles = FeedFetcher.deduplicate(articles);
      articles = FeedFetcher.sortByDate(articles);
      articles = applyDateFilter(articles);
    } else {
      articles = FeedFetcher.sortByDate(articles);
    }
    articles = applySearch(articles);
    articles = applyFilters(articles);
    if (currentMode === 'top') {
      for (const a of articles) a._score = scoreArticle(a);
    }
    const sortMode = currentSort || (currentMode === 'top' ? 'score' : 'date-desc');
    articles = applySort(articles, sortMode);
    return articles;
  }

  function updateFilterSourceOptions(articles) {
    if (!el.filterSource) return;
    const current = el.filterSource.value;
    const sources = [...new Set(articles.map(a => a.source).filter(Boolean))].sort();
    el.filterSource.innerHTML = '<option value="">All Sources</option>' +
      sources.map(s => '<option value="' + s.replace(/"/g, '&quot;') + '">' + s + '</option>').join('');
    if (current && sources.includes(current)) el.filterSource.value = current;
  }

  function renderSubTabs() {
    const subs = FeedManager.subcategoriesForScope(currentScope);
    const cacheKey = scopeKey();
    const cached = scopeCache[cacheKey];
    el.subTabs.innerHTML = subs.map(s =>
      '<li class="tab-item' + (s === currentSubcat ? ' active' : '') + '" data-subcat="' + s + '">' +
      FeedManager.subcatIcon(s) + ' ' + FeedManager.subcatLabel(s, currentScope) +
      (cached ? '<span class="tab-count">' + getFilteredArticles(s, cached).length + '</span>' : '') +
      '</li>'
    ).join('');
    el.subBar.style.display = 'block';
  }

  function bindSubTabs() {
    el.subTabs.addEventListener('click', e => {
      const tab = e.target.closest('.tab-item');
      if (!tab) return;
      const sub = tab.dataset.subcat;
      if (sub === currentSubcat) return;
      currentSubcat = sub;
      loadedCount = 0;
      $$('.tab-item', el.subTabs).forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      displayCurrentSubcat();
    });
  }

  function updateStickyHeader(metaText) {
    const scopeLabel = currentScope === 'global' ? 'Global' : (FeedManager.getNations()[currentNation] || currentNation);
    const subLabel = FeedManager.subcatLabel(currentSubcat, currentScope);
    if (el.sectionTitle) {
      el.sectionTitle.innerHTML = FeedManager.subcatIcon(currentSubcat) + ' ' + subLabel +
        '<span style="font-size:0.8rem;font-weight:400;color:var(--text-tertiary);margin-left:8px;">' + scopeLabel + '</span>';
    }
    if (el.sectionMeta) {
      el.sectionMeta.textContent = metaText || '';
    }
    if (el.modeToggle) {
      $$('.mode-btn', el.modeToggle).forEach(b => b.classList.toggle('active', b.dataset.mode === currentMode));
    }
    if (el.viewToggle) {
      $$('.mode-btn', el.viewToggle).forEach(b => b.classList.toggle('active', b.dataset.view === currentView));
    }
  }

  /* ── Render Content ── */
  function showLoading() {
    el.main.innerHTML = '<div class="loading-state"><div class="loading-spinner"></div><p>Fetching latest news\u2026</p></div>';
    updateStickyHeader();
  }

  function showError(msg) {
    el.main.innerHTML = '<div class="error-state"><div class="error-icon">\u26A0\uFE0F</div><p>' + msg + '</p></div>';
    updateStickyHeader();
  }

  function showEmpty() {
    el.main.innerHTML = '<div class="empty-state"><div class="empty-icon">\uD83D\uDCED</div><p>No articles found for this period.</p></div>';
    updateStickyHeader('0 articles');
  }

  function renderArticles(articles) {
    if (!articles.length) { showEmpty(); return; }

    currentArticles = articles;
    const settings = Settings.load();
    const perPage = settings.articlesPerPage || 10;

    let display;
    let totalShown;
    if (currentMode === 'live') {
      if (!loadedCount) loadedCount = perPage;
      display = articles.slice(0, Math.min(loadedCount, articles.length));
      totalShown = display.length;
    } else {
      display = articles.slice(0, perPage);
      display.forEach((a, i) => a._rank = i + 1);
      totalShown = display.length;
    }

    updateStickyHeader(totalShown + ' of ' + articles.length);

    el.main.innerHTML =
      '<div class="article-grid">' +
        display.map((a, i) => renderCard(a, i)).join('') +
      '</div>' +
      (currentMode === 'live' && totalShown < articles.length
        ? '<div style="text-align:center;padding:20px;"><button class="btn" id="load-more-btn">Load More (' + (articles.length - totalShown) + ' remaining)</button></div>'
        : '') +
      (currentMode === 'top' && articles.length > perPage
        ? '<div style="text-align:center;padding:20px;color:var(--text-secondary);font-size:0.85rem;">Showing top ' + perPage + ' of ' + articles.length + ' articles</div>'
        : '');

    const loadMore = $('#load-more-btn');
    if (loadMore) loadMore.addEventListener('click', () => { loadedCount += perPage; renderArticles(currentArticles); });
  }

  function renderCard(article, index) {
    const hasThumb = article.imageUrl && article.imageUrl.startsWith('http');
    const encoded = encodeURIComponent(article.link);

    const thumbHtml = hasThumb
      ? '<div class="article-thumb" style="cursor:pointer" data-article="' + encoded + '">' +
          '<img src="' + article.imageUrl + '" alt="" loading="lazy" onerror="this.parentElement.style.display=\'none\'">' +
        '</div>'
      : '';

    const rankHtml = currentMode === 'top' && article._rank
      ? '<span class="score-badge" style="color:' + (article._rank <= 3 ? 'var(--accent)' : 'var(--text-tertiary)') + '">#' + article._rank + '</span>'
      : '';

    const ad = getArticleData(article.link);
    const flagHtml = ad.flag ? '<span class="flag-badge" style="background:' + (FLAG_COLORS[ad.flag] || 'var(--text-tertiary)') + '">' + ad.flag + '</span>' : '';

    return '<article class="article-card" style="animation-delay:' + ((index % 10) * 0.04) + 's">' +
        '<button class="card-share-btn" data-url="' + encodeURIComponent(article.link) + '" data-title="' + escAttr(article.title) + '" data-source="' + escAttr(article.source) + '" title="Share">&#x21AA;</button>' +
        thumbHtml +
        '<div class="article-body">' +
          '<h3 class="article-title"><span class="article-link" data-article="' + encoded + '">' + escHtml(article.title) + '</span></h3>' +
          '<p class="article-summary">' + stripHtml(article.summary).slice(0, 250) + '</p>' +
          '<div class="article-meta">' +
            '<span class="source">' + escHtml(article.source) + '</span>' +
            '<span class="date">' + formatDateShort(article.pubDate) + '</span>' +
            rankHtml +
            flagHtml +
          '</div>' +
          '<div class="article-watermark">' +
            '<span class="wm-brand">Invisible Broadcast</span>' +
          '</div>' +
        '</div>' +
      '</article>';
  }

  /* ── Reels View ── */
  let currentReelIndex = 0;

  function renderReels(articles) {
    if (!articles.length) { showEmpty(); return; }
    const settings = Settings.load();
    const perPage = settings.articlesPerPage || 10;
    if (currentMode === 'top') {
      articles = articles.slice(0, perPage);
      articles.forEach((a, i) => a._rank = i + 1);
    }
    currentArticles = articles;
    currentReelIndex = 0;
    showReel();
  }

  function showReel() {
    const articles = currentArticles;
    const idx = currentReelIndex;
    const article = articles[idx];
    const total = articles.length;

    const hasThumb = article.imageUrl && article.imageUrl.startsWith('http');
    const bgStyle = hasThumb ? article.imageUrl : '';

    const existing = el.main.querySelector('.reels-container');

    if (!existing) {
      // First render — build the full DOM
      const bgHtml = bgStyle ? ' style="background-image:url(\'' + bgStyle.replace(/'/g, '%27') + '\')"' : '';
      el.main.innerHTML =
        '<div class="reels-container">' +
          '<div class="reels-progress"></div>' +
          '<div class="reels-card"' + bgHtml + '>' +
            '<div class="reels-overlay">' +
              '<div class="reels-toolbar">' +
                '<button class="reels-tool-btn" id="reels-share-text" title="Share as Text">&#x21AA;</button>' +
                '<button class="reels-tool-btn" id="reels-share-image" title="Share as Image">&#x1F5BC;</button>' +
                '<button class="reels-tool-btn" id="reels-fullscreen" title="Full Screen">&#x26F6;</button>' +
              '</div>' +
              '<span class="reels-count"></span>' +
              '<h2 class="reels-title"></h2>' +
              '<div class="reels-meta">' +
                '<span class="reels-source"></span>' +
                '<span class="reels-date"></span>' +
                '<span class="reels-flag" style="display:none"></span>' +
              '</div>' +
              '<p class="reels-summary"></p>' +
              '<button class="btn btn-primary reels-read-btn">Read Original Article</button>' +
              '<div class="reels-watermark">' +
                '<span class="wm-brand">Invisible Broadcast</span>' +
              '</div>' +
            '</div>' +
          '</div>' +
          '<button class="reels-nav reels-prev" id="reels-prev">\u2039</button>' +
          '<button class="reels-nav reels-next" id="reels-next">\u203A</button>' +
        '</div>';

      $('#reels-prev').addEventListener('click', prevReel);
      $('#reels-next').addEventListener('click', nextReel);
      el.main.querySelector('.reels-read-btn').addEventListener('click', e => {
        const link = decodeURIComponent(e.currentTarget.dataset.article);
        openArticleDetail(link);
      });
      const st = $('#reels-share-text');
      if (st) st.addEventListener('click', e => {
        e.stopPropagation();
        handleShare(decodeURIComponent(st.dataset.url), st.dataset.title, st.dataset.source);
      });
      const si = $('#reels-share-image');
      if (si) si.addEventListener('click', e => {
        e.stopPropagation();
        handleShareImage(currentArticles[currentReelIndex]);
      });
      const fs = $('#reels-fullscreen');
      if (fs) fs.addEventListener('click', e => { e.stopPropagation(); toggleFullscreen(); });
    }

    // Update content in-place (no innerHTML replacement — preserves fullscreen DOM)
    const container = existing || el.main.querySelector('.reels-container');
    if (!container) return;

    const dots = container.querySelector('.reels-progress');
    if (dots) dots.innerHTML = articles.map((a, i) => '<span class="reels-dot' + (i === idx ? ' active' : '') + '"></span>').join('');

    const card = container.querySelector('.reels-card');
    if (card) {
      if (hasThumb) { card.style.backgroundImage = 'url(\'' + bgStyle.replace(/'/g, '%27') + '\')'; card.style.backgroundSize = 'cover'; card.style.backgroundPosition = 'center'; }
      else { card.style.backgroundImage = ''; }
    }

    const count = container.querySelector('.reels-count');
    if (count) count.textContent = (idx + 1) + ' / ' + total;
    const title = container.querySelector('.reels-title');
    if (title) title.textContent = article.title;
    const source = container.querySelector('.reels-source');
    if (source) source.textContent = article.source;
    const date = container.querySelector('.reels-date');
    if (date) date.textContent = formatDateShort(article.pubDate);
    const summary = container.querySelector('.reels-summary');
    if (summary) summary.textContent = stripHtml(article.summary).slice(0, 350);

    const ad = getArticleData(article.link);
    const flagEl = container.querySelector('.reels-flag');
    if (flagEl) {
      if (ad.flag) { flagEl.textContent = ad.flag; flagEl.style.display = 'inline'; flagEl.style.background = FLAG_COLORS[ad.flag] || 'var(--text-tertiary)'; }
      else { flagEl.style.display = 'none'; }
    }

    const readBtn = container.querySelector('.reels-read-btn');
    if (readBtn) readBtn.dataset.article = encodeURIComponent(article.link);
    const st2 = container.querySelector('#reels-share-text');
    if (st2) { st2.dataset.url = encodeURIComponent(article.link); st2.dataset.title = article.title; st2.dataset.source = article.source; }
    const si2 = container.querySelector('#reels-share-image');
    if (si2) { si2.dataset.url = encodeURIComponent(article.link); si2.dataset.title = article.title; si2.dataset.source = article.source; }
  }

  function prevReel() {
    if (currentReelIndex < 1) return;
    currentReelIndex--;
    showReel();
  }

  function nextReel() {
    if (currentReelIndex >= currentArticles.length - 1) return;
    currentReelIndex++;
    showReel();
  }

  function requestReelFullscreen() {
    const c = document.querySelector('.reels-container');
    if (!c) return;
    if (c.requestFullscreen) c.requestFullscreen().catch(() => {});
    else if (c.webkitRequestFullscreen) c.webkitRequestFullscreen();
  }

  function exitReels() {
    currentView = 'list';
    updateStickyHeader();
    displayCurrentSubcat();
  }

  /* ── Toggle Filters Panel ── */
  function bindFilterToggles() {
    function togglePanel(btnId, panelId) {
      const btn = document.getElementById(btnId);
      if (!btn) return;
      btn.addEventListener('click', () => {
        const open = el.filtersPanel.classList.contains('open');
        el.filtersPanel.classList.toggle('open');
        $$('.filter-icon-btn').forEach(b => b.classList.remove('active'));
        if (!open) btn.classList.add('active');
      });
    }
    togglePanel('search-toggle', 'filters-panel');
    togglePanel('filter-toggle', 'filters-panel');
    togglePanel('sort-toggle', 'filters-panel');
  }

  function bindLangSelect() {
    if (!el.langSelect) return;
    el.langSelect.value = Settings.get('language') || 'en';
    el.langSelect.addEventListener('change', () => {
      Settings.save({ language: el.langSelect.value });
      const key = scopeKey();
      const cached = scopeCache[key];
      if (!cached) return;
      const articles = getFilteredArticles(currentSubcat, cached);
      renderTranslated(articles);
    });
  }

  function isGoogleNewsRedirect(url) {
    try { return new URL(url).hostname === 'news.google.com' && url.includes('/rss/articles/'); }
    catch { return false; }
  }

  function updateSortOptions() {
    if (!el.sortBy) return;
    const current = el.sortBy.value;
    const isTop = currentMode === 'top';
    el.sortBy.innerHTML = (isTop ? '<option value="score">Score ↓</option><option value="score-asc">Score ↑</option>' : '') +
      '<option value="date-desc">Date ↓</option>' +
      '<option value="date-asc">Date ↑</option>' +
      '<option value="source">Source A–Z</option>';
    if ([...el.sortBy.options].some(o => o.value === current)) el.sortBy.value = current;
    else el.sortBy.value = isTop ? 'score' : 'date-desc';
    currentSort = el.sortBy.value;
  }

  function bindModeToggle() {
    const toggle = el.modeToggle;
    if (!toggle) return;
    toggle.addEventListener('click', e => {
      const btn = e.target.closest('.mode-btn');
      if (!btn || btn.classList.contains('active')) return;
      currentMode = btn.dataset.mode;
      loadedCount = 0;
      $$('.mode-btn', toggle).forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      updateSortOptions();
      updateStickyHeader();
      displayCurrentSubcat();
    });
  }

  function bindViewToggle() {
    const toggle = el.viewToggle;
    if (!toggle) return;
    toggle.addEventListener('click', e => {
      const btn = e.target.closest('.mode-btn');
      if (!btn || btn.classList.contains('active')) return;
      currentView = btn.dataset.view;
      $$('.mode-btn', toggle).forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      displayCurrentSubcat();
    });
  }

  /* ── Fetch & Refresh ── */
  function scopeKey() {
    return currentScope + '_' + (currentScope === 'nation' ? currentNation : '');
  }

  function showProgress(msg) {
    el.main.innerHTML = '<div class="loading-state"><div class="loading-spinner"></div><p>' + msg + '</p></div>';
  }

  async function renderContent() {
    if (isFetching) return;
    isFetching = true;
    showLoading();

    try {
      const key = scopeKey();
      const isLive = currentMode === 'live';

      if (!isLive && scopeCache[key]) {
        isFetching = false;
        displayCurrentSubcat();
        return;
      }

      const feeds = FeedManager.getFeeds(currentScope, currentScope === 'nation' ? currentNation : null);
      if (!feeds.length) {
        showError('No feed sources for this scope.');
        isFetching = false;
        return;
      }

      const groups = {};
      const subs = FeedManager.subcategoriesForScope(currentScope);
      if (!subs.includes(currentSubcat)) currentSubcat = subs[0];

      const batchSize = 3;
      let hasRendered = false;

      for (let i = 0; i < feeds.length; i += batchSize) {
        const batch = feeds.slice(i, i + batchSize);
        const results = await Promise.allSettled(batch.map(f => FeedFetcher.fetchFeed(f)));

        for (let j = 0; j < results.length; j++) {
          const result = results[j];
          if (result.status === 'fulfilled') {
            const articles = result.value;
            for (const a of articles) {
              a.subcat = a.feedHint || 'politics';
              const cat = a.subcat;
              if (!groups[cat]) groups[cat] = [];
              groups[cat].push(a);
            }
          } else {
            console.warn('Feed failed: ' + batch[j]?.name, result.reason?.message);
          }
        }

        let allArticles = [];
        for (const cat of Object.keys(groups)) allArticles.push(...groups[cat]);
        scopeCache[key] = { articles: allArticles, groups };
        renderSubTabs();
        updateStickyHeader();

        const remaining = feeds.length - (i + batchSize);
        if (remaining > 0) {
          const articles = getFilteredArticles(currentSubcat, scopeCache[key]);
          updateFilterSourceOptions(articles);
          if (articles.length) {
            hasRendered = true;
            el.main.innerHTML = '';
            if (currentView === 'reels') renderReels(articles);
            else renderArticles(articles);
            const prog = document.createElement('div');
            prog.id = 'loading-progress';
            prog.style.cssText = 'text-align:center;padding:12px;font-size:0.82rem;color:var(--text-tertiary);border-top:1px solid var(--border-secondary);';
            prog.textContent = 'Loading ' + Math.min(remaining, feeds.length > 1 ? batchSize : 0) + ' more sources\u2026';
            el.main.appendChild(prog);
          } else if (!hasRendered) {
            showProgress('Fetching sources\u2026 (' + Math.min(i + batchSize, feeds.length) + '/' + feeds.length + ')');
          }
        }
      }

      $('#loading-progress')?.remove();
      isFetching = false;
      displayCurrentSubcat();
    } catch (err) {
      console.error(err);
      showError('Failed to fetch news. Please check your connection.');
      isFetching = false;
    }
  }

  function displayCurrentSubcat() {
    const key = scopeKey();
    const cached = scopeCache[key];
    if (!cached) { renderContent(); return; }

    updateStickyHeader();

    const articles = getFilteredArticles(currentSubcat, cached);
    updateFilterSourceOptions(articles);
    if (!articles.length) { showEmpty(); return; }

    renderTranslated(articles);
  }

  function bindFilterSort() {
    if (el.filterSource) {
      el.filterSource.addEventListener('change', () => {
        currentSourceFilter = el.filterSource.value;
        const key = scopeKey();
        const cached = scopeCache[key];
        if (!cached) return;
        const articles = getFilteredArticles(currentSubcat, cached);
        renderTranslated(articles);
      });
    }
    if (el.sortBy) {
      updateSortOptions();
      el.sortBy.addEventListener('change', () => {
        currentSort = el.sortBy.value;
        const key = scopeKey();
        const cached = scopeCache[key];
        if (!cached) return;
        const articles = getFilteredArticles(currentSubcat, cached);
        renderTranslated(articles);
      });
    }
  }

  async function renderTranslated(articles) {
    const targetLang = Settings.get('language');
    const translated = targetLang !== 'en'
      ? await Translator.translateArticles(articles, targetLang)
      : articles;
    if (currentView === 'reels') {
      renderReels(translated);
    } else {
      renderArticles(translated);
    }
  }

  let currentSearch = '';

  function bindSearch() {
    if (!el.searchInput) return;
    el.searchInput.addEventListener('input', () => {
      currentSearch = el.searchInput.value.trim().toLowerCase();
      const key = scopeKey();
      const cached = scopeCache[key];
      if (!cached) return;
      const articles = getFilteredArticles(currentSubcat, cached);
      renderTranslated(articles);
    });
  }

  function applySearch(articles) {
    if (!currentSearch) return articles;
    return articles.filter(a =>
      (a.title || '').toLowerCase().includes(currentSearch) ||
      (a.source || '').toLowerCase().includes(currentSearch) ||
      (a.summary || '').toLowerCase().includes(currentSearch) ||
      (a.pubDate || '').toLowerCase().includes(currentSearch)
    );
  }

  const TOP_SOURCES = ['BBC', 'CNN', 'Reuters', 'The Hindu', 'NYT', 'Guardian', 'Times of India', 'NDTV', 'Al Jazeera', 'Washington Post', 'NPR', 'DW'];

  function scoreArticle(article) {
    let score = 0;
    if (article.pubDate) {
      const age = Date.now() - new Date(article.pubDate).getTime();
      const hours = age / 3600000;
      score += Math.max(0, 100 - hours);
    }
    if (article.imageUrl && article.imageUrl.startsWith('http')) score += 20;
    const summaryLen = (article.summary || '').length;
    score += Math.min(15, summaryLen / 20);
    if (TOP_SOURCES.some(s => (article.source || '').includes(s))) score += 20;
    if (article.author) score += 10;
    return Math.round(score);
  }

  let currentSourceFilter = '';
  let currentSort = '';

  function applyFilters(articles) {
    let result = articles;
    if (currentSourceFilter) {
      result = result.filter(a => (a.source || '') === currentSourceFilter);
    }
    return result;
  }

  function applySort(articles, sortMode) {
    const sorted = [...articles];
    switch (sortMode) {
      case 'date-asc':
        sorted.sort((a, b) => new Date(a.pubDate || 0) - new Date(b.pubDate || 0));
        break;
      case 'score':
        sorted.sort((a, b) => (b._score || 0) - (a._score || 0));
        break;
      case 'score-asc':
        sorted.sort((a, b) => (a._score || 0) - (b._score || 0));
        break;
      case 'source':
        sorted.sort((a, b) => (a.source || '').localeCompare(b.source || ''));
        break;
      default:
        sorted.sort((a, b) => new Date(b.pubDate || 0) - new Date(a.pubDate || 0));
    }
    return sorted;
  }

  function applyDateFilter(articles) {
    const dateFrom = el.dateFrom.value || null;
    const dateTo = el.dateTo.value || null;

    if (dateFrom && dateTo) {
      return FeedFetcher.filterByDate(articles, dateFrom, dateTo);
    }

    if (currentMode === 'top') {
      const last24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const to = new Date();
      return FeedFetcher.filterByDate(articles, last24h.toISOString().slice(0, 10), to.toISOString().slice(0, 10));
    }

    return articles;
  }

  async function refreshAll() {
    scopeCache = {};
    await renderContent();
  }

  /* ── Date Toggle ── */
  function bindDateToggle() {
    el.dateToggle.addEventListener('click', () => {
      const hidden = el.dateRange.style.display === 'none' || !el.dateRange.style.display;
      el.dateRange.style.display = hidden ? 'flex' : 'none';
      if (hidden) {
        const today = new Date().toISOString().slice(0, 10);
        if (!el.dateFrom.value) el.dateFrom.value = today;
        if (!el.dateTo.value) el.dateTo.value = today;
      }
    });
    el.dateFrom.addEventListener('change', refreshAll);
    el.dateTo.addEventListener('change', refreshAll);
  }

  /* ── Settings Modal ── */
  function openSettings() {
    const settings = Settings.load();
    const pp = $('input[name="articlesPerPage"][value="' + settings.articlesPerPage + '"]');
    if (pp) pp.checked = true;
    const lang = $('#settings-language');
    if (lang) lang.value = settings.language;
    populateFeedSelects();
    renderCustomFeedList();
    renderSubscriptionList();
    el.modal.classList.add('open');
  }

  function closeSettings() {
    el.modal.classList.remove('open');
    if (el.feedValidateMsg) el.feedValidateMsg.textContent = '';
  }

  function saveSettings() {
    const perPage = parseInt($('input[name="articlesPerPage"]:checked')?.value || '10', 10);
    const lang = $('#settings-language')?.value || 'en';
    Settings.save({ articlesPerPage: perPage, language: lang });
    closeSettings();
    refreshAll();
  }

  function bindSettings() {
    el.settingsBtn.addEventListener('click', openSettings);
    el.modalClose.addEventListener('click', closeSettings);
    el.modalCancel.addEventListener('click', closeSettings);
    el.modalSave.addEventListener('click', saveSettings);
    el.modal.addEventListener('click', e => { if (e.target === el.modal) closeSettings(); });
  }

  /* ── Custom Feeds ── */
  let validatedFeed = null;

  function populateFeedSelects() {
    const scopeSel = el.feedScopeSelect;
    const nationSel = el.feedNationSelect;
    const subSel = el.feedSubcatSelect;
    if (!scopeSel || !subSel) return;

    subSel.innerHTML = FeedManager.subcategories().map(s =>
      '<option value="' + s + '">' + FeedManager.subcatLabel(s, 'global') + '</option>'
    ).join('');

    if (nationSel) {
      const nations = FeedManager.getNations();
      nationSel.innerHTML = Object.keys(nations).map(k =>
        '<option value="' + k + '">' + nations[k] + '</option>'
      ).join('');
      const wrapper = nationSel.closest('.select-wrapper');
      if (wrapper) wrapper.style.display = scopeSel.value === 'nation' ? 'inline-block' : 'none';
    }

    scopeSel.addEventListener('change', () => {
      if (nationSel) {
        const wrapper = nationSel.closest('.select-wrapper');
        if (wrapper) wrapper.style.display = scopeSel.value === 'nation' ? 'inline-block' : 'none';
      }
    });
  }

  async function handleValidateFeed() {
    const url = el.feedUrlInput?.value?.trim();
    if (!url) return;
    if (el.feedValidateMsg) {
      el.feedValidateMsg.textContent = 'Validating\u2026';
      el.feedValidateMsg.className = 'feed-validate-msg';
    }
    try {
      const result = await FeedManager.validateFeed(url);
      if (el.feedValidateMsg) {
        if (result.valid) {
          validatedFeed = { url, title: result.title };
          el.feedValidateMsg.textContent = 'Valid: ' + result.title + ' (' + result.count + ' articles)';
          el.feedValidateMsg.className = 'feed-validate-msg success';
          if (!el.feedNameInput.value) el.feedNameInput.value = result.title;
        } else {
          validatedFeed = null;
          el.feedValidateMsg.textContent = 'Invalid: ' + (result.error || 'Unknown');
          el.feedValidateMsg.className = 'feed-validate-msg error';
        }
      }
    } catch {
      validatedFeed = null;
      if (el.feedValidateMsg) { el.feedValidateMsg.textContent = 'Validation failed'; el.feedValidateMsg.className = 'feed-validate-msg error'; }
    }
  }

  function handleAddFeed() {
    const name = el.feedNameInput?.value?.trim();
    const url = validatedFeed?.url || el.feedUrlInput?.value?.trim();
    const scope = el.feedScopeSelect?.value || 'global';
    const nation = el.feedNationSelect?.value || 'india';
    const subcat = el.feedSubcatSelect?.value || 'politics';
    if (!name || !url) {
      if (el.feedValidateMsg) { el.feedValidateMsg.textContent = 'Enter a name and validate a URL first.'; el.feedValidateMsg.className = 'feed-validate-msg error'; }
      return;
    }
    FeedManager.addCustomFeed(name, url, scope, nation, subcat, 'en');
    validatedFeed = null;
    if (el.feedUrlInput) el.feedUrlInput.value = '';
    if (el.feedNameInput) el.feedNameInput.value = '';
    if (el.feedValidateMsg) el.feedValidateMsg.textContent = '';
    renderCustomFeedList();
  }

  function renderCustomFeedList() {
    if (!el.feedCustomList) return;
    const feeds = FeedManager.getCustomFeeds();
    if (!feeds.length) {
      el.feedCustomList.innerHTML = '<p style="color:var(--text-tertiary);font-size:0.82rem;">No custom feeds added.</p>';
      return;
    }
    el.feedCustomList.innerHTML = '<ul class="feed-list">' + feeds.map(f =>
      '<li><div><span class="feed-source">' + f.name + '</span><span class="feed-cat">' +
      (f.scope === 'nation' ? (FeedManager.getNations()[f.nation] || f.nation) + ' / ' : 'Global / ') +
      FeedManager.subcatLabel(f.subcat, 'global') + '</span></div>' +
      '<span class="feed-remove" data-url="' + f.url + '">Remove</span></li>'
    ).join('') + '</ul>';
    el.feedCustomList.querySelectorAll('.feed-remove').forEach(btn => {
      btn.addEventListener('click', () => { FeedManager.removeCustomFeed(btn.dataset.url); renderCustomFeedList(); });
    });
  }

  const ARTICLE_DATA_KEY = 'newsfeeds_article_data';
  const FLAGS = ['', 'save', 'investigative', 'favorite', 'important', 'urgent'];
  const FLAG_LABELS = { save: 'Save for later', investigative: 'Investigative', favorite: 'Favorite', important: 'Important', urgent: 'Urgent' };
  const FLAG_COLORS = { save: '#3fb950', investigative: '#d29922', favorite: '#ff2929', important: '#58a6ff', urgent: '#f0883e' };

  function getArticleData(link) {
    try { return JSON.parse(localStorage.getItem(ARTICLE_DATA_KEY) || '{}')[link] || {}; }
    catch { return {}; }
  }

  function saveArticleData(link, data) {
    try {
      const all = JSON.parse(localStorage.getItem(ARTICLE_DATA_KEY) || '{}');
      if (data.flag || data.note) { all[link] = data; }
      else { delete all[link]; }
      localStorage.setItem(ARTICLE_DATA_KEY, JSON.stringify(all));
    } catch {}
  }

  function renderSubscriptionList() {
    const container = $('#subscription-list');
    if (!container) return;
    const allFeeds = FeedManager.getSubscribableFeeds();
    let subscribed = FeedManager.getSubscribedFeeds();
    if (subscribed.length === 0 && allFeeds.length > 0) {
      const allUrls = allFeeds.filter(f => f.hasRss && f.url).map(f => f.url);
      FeedManager.saveSubscribedFeeds(allUrls);
      subscribed = allUrls;
    }
    const grouped = {};
    for (const f of allFeeds) {
      const region = f.region || 'Other';
      if (!grouped[region]) grouped[region] = [];
      grouped[region].push(f);
    }
    let html = '';
    for (const [region, feeds] of Object.entries(grouped)) {
      const hasRssFeeds = feeds.some(f => f.hasRss);
      html += '<div class="sub-region"><h4 class="sub-region-title">' + region + '</h4>';
      if (!hasRssFeeds) {
        html += '<div class="sub-no-rss">';
        for (const f of feeds) {
          html += '<div class="sub-item"><span class="sub-name sub-no">' + f.name + '</span><span class="sub-no-badge">No RSS</span>' +
            (f.note ? '<span class="sub-note">' + f.note + '</span>' : '') + '</div>';
        }
        html += '</div></div>';
        continue;
      }
      for (const f of feeds) {
        if (!f.hasRss) continue;
        const checked = subscribed.includes(f.url) ? ' checked' : '';
        html += '<label class="sub-item' + (checked ? ' sub-active' : '') + '">' +
          '<input type="checkbox" class="sub-checkbox" data-url="' + f.url + '"' + checked + '>' +
          '<span class="sub-name">' + f.name + '</span>' +
          '<span class="sub-lang">' + (f.lang || 'en').toUpperCase() + '</span>' +
          '</label>';
      }
      html += '</div>';
    }
    container.innerHTML = html;
    container.querySelectorAll('.sub-checkbox').forEach(cb => {
      cb.addEventListener('change', () => {
        FeedManager.toggleSubscription(cb.dataset.url);
        cb.closest('.sub-item').classList.toggle('sub-active', cb.checked);
      });
    });
    const msg = $('#sub-refresh-note');
    if (!msg) {
      const note = document.createElement('p');
      note.id = 'sub-refresh-note';
      note.style.cssText = 'font-size:0.78rem;color:var(--text-tertiary);margin-top:8px;font-style:italic;';
      note.textContent = 'Subscription changes apply on next fetch. Close settings to refresh.';
      container.parentElement.appendChild(note);
    }
  }

  function bindFeedControls() {
    if (el.feedValidateBtn) el.feedValidateBtn.addEventListener('click', handleValidateFeed);
    if (el.feedAddBtn) el.feedAddBtn.addEventListener('click', handleAddFeed);
    if (el.feedUrlInput) el.feedUrlInput.addEventListener('keydown', e => { if (e.key === 'Enter') handleValidateFeed(); });
  }

  function escAttr(s) { return (s == null ? '' : String(s)).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function escHtml(s) { return (s == null ? '' : String(s)).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

  /* ── Article & Source Modals ── */
  function findArticleByLink(link) {
    return currentArticles.find(a => a.link === link);
  }

  function openArticleDetail(link) {
    const article = findArticleByLink(link);
    if (!article) return;
    el.articleModalTitle.textContent = article.title;
    el.articleModalSource.textContent = article.source;
    el.articleModalDate.textContent = formatDate(article.pubDate);
    el.articleModalSummary.textContent = stripHtml(article.summary).slice(0, 1500);
    if (article.imageUrl && article.imageUrl.startsWith('http')) {
      el.articleModalImg.src = article.imageUrl;
      el.articleModalImgWrap.style.display = 'block';
    } else {
      el.articleModalImgWrap.style.display = 'none';
    }
    el.articleModalRead.dataset.url = article.link;
    el.articleModalExt.dataset.url = article.link;

    const ad = getArticleData(article.link);
    const flagEl = $('#article-modal-flag');
    const notesEl = $('#article-modal-notes');
    if (flagEl) {
      flagEl.value = ad.flag || '';
      flagEl.onchange = function() {
        const newData = getArticleData(article.link);
        newData.flag = flagEl.value || '';
        saveArticleData(article.link, newData);
        renderCurrentList();
      };
    }
    if (notesEl) {
      notesEl.value = ad.note || '';
      notesEl.oninput = function() {
        const newData = getArticleData(article.link);
        newData.note = notesEl.value || '';
        saveArticleData(article.link, newData);
      };
    }

    el.articleModal.classList.add('open');
  }

  function closeArticleModal() { el.articleModal.classList.remove('open'); }

  function renderCurrentList() {
    const key = scopeKey();
    const cached = scopeCache[key];
    if (!cached) return;
    const articles = getFilteredArticles(currentSubcat, cached);
    renderTranslated(articles);
  }

  async function openArticleReader(url, title) {
    el.sourceModalTitle.textContent = title || 'Original Article';
    el.sourceModal.classList.add('open');

    const loading = $('#reader-loading');
    const content = $('#reader-content');
    const fallback = $('#source-fallback');
    const link = $('#source-fallback-link');

    if (loading) loading.style.display = 'flex';
    if (content) { content.innerHTML = ''; content.style.display = 'none'; }
    if (fallback) fallback.style.display = 'none';
    if (link) link.href = url;

    if (isGoogleNewsRedirect(url)) {
      if (loading) loading.style.display = 'none';
      if (fallback) fallback.style.display = 'flex';
      return;
    }

    const fetchProxies = [
      { url: 'https://corsproxy.io/?url=', encode: true },
      { url: 'https://api.allorigins.win/raw?url=', encode: true },
      { url: 'https://r.jina.ai/', encode: true }
    ];

    for (const proxy of fetchProxies) {
      try {
        const proxyUrl = proxy.url + (proxy.encode ? encodeURIComponent(url) : url);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 10000);
        const res = await fetch(proxyUrl, { signal: controller.signal });
        clearTimeout(timer);

        if (!res.ok) throw new Error('HTTP ' + res.status);

        const html = await res.text();
        if (!html || html.length < 100) throw new Error('Empty response');

        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');
        doc.querySelectorAll('script, style, nav, header, footer, aside').forEach(s => s.remove());

        if (content) {
          content.innerHTML = doc.body.innerHTML;
          content.style.display = 'block';
        }
        if (loading) loading.style.display = 'none';
        return;
      } catch (err) {
        console.warn('Reader proxy ' + proxy.url + ' failed:', err.message);
      }
    }

    // Iframe fallback — proxies don't support CORS, load via iframe
    if (content) {
      content.innerHTML = '<iframe style="width:100%;height:100%;border:none;background:#fff;" src="https://corsproxy.io/?url=' + encodeURIComponent(url) + '" sandbox="allow-scripts allow-same-origin" loading="lazy"></iframe>';
      content.style.display = 'block';
      const iframe = content.querySelector('iframe');
      iframe.onload = function() {
        if (loading) loading.style.display = 'none';
        try {
          const doc = iframe.contentDocument;
          if (doc && doc.body && (!doc.body.textContent.trim() || doc.body.textContent.trim().length < 50)) {
            if (fallback) fallback.style.display = 'flex';
          }
        } catch(e) {
          if (fallback) fallback.style.display = 'flex';
        }
      };
    }
  }

  function handleShare(url, title, source) {
    const text = title + ' — ' + (source || 'News') + '\n\nPresented by Invisible Broadcast\n' + url;
    if (navigator.share) {
      navigator.share({ title: title, text: text, url: url }).catch(() => {});
    } else {
      navigator.clipboard.writeText(url).then(() => {
        const btn = $('#article-modal-share');
        if (btn) {
          const orig = btn.innerHTML;
          btn.innerHTML = 'Copied!';
          setTimeout(() => { btn.innerHTML = orig; }, 2000);
        }
      }).catch(() => {});
    }
  }

  const TITLE_COLORS = ['#e6edf3', '#f5e6d3', '#d3e8f5', '#e6d3f5', '#d3f5e0', '#f5e0d3', '#f0dbe8', '#dbe8f0', '#d4f0db', '#f0ecd4', '#e0dbf0', '#dbf0ec'];

  async function handleShareImage(article) {
    try {
      const hasThumb = article.imageUrl && article.imageUrl.startsWith('http');
      const bgStyle = hasThumb ? article.imageUrl : '';
      const fullSummary = stripHtml(article.summary);
      const titleColor = TITLE_COLORS[Math.floor(Math.random() * TITLE_COLORS.length)];

      const el = document.createElement('div');
      el.style.cssText = 'position:fixed;left:-9999px;top:0;width:400px;z-index:-1;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,Oxygen,Ubuntu,Cantarell,sans-serif;';
      el.innerHTML =
        '<div style="width:100%;min-height:500px;border-radius:12px;overflow:hidden;position:relative;background:' + (bgStyle ? 'transparent' : '#0d1117') + ';' + (bgStyle ? 'background-image:url(' + bgStyle.replace(/'/g, '%27') + ');background-size:cover;background-position:center;' : '') + '">' +
          '<div style="position:absolute;top:20px;right:20px;width:36px;height:36px;background:#ff2929;border-radius:4px;display:flex;align-items:center;justify-content:center;font-size:0.95rem;font-weight:700;color:#fff;z-index:1;">IB</div>' +
          '<div style="background:linear-gradient(0deg,rgba(0,0,0,0.92) 0%,rgba(0,0,0,0.5) 50%,rgba(0,0,0,0.2) 100%);padding:48px 36px 36px;display:flex;flex-direction:column;justify-content:flex-end;min-height:500px;">' +
            '<div style="font-size:0.9rem;color:#ff2929;font-weight:700;margin-bottom:8px;">' + escHtml(article.source) + ' &middot; ' + formatDateShort(article.pubDate) + '</div>' +
            '<h2 style="font-size:1.5rem;font-weight:700;line-height:1.35;margin:0 0 12px;color:' + titleColor + ';">' + escHtml(article.title) + '</h2>' +
            '<p style="font-size:0.9rem;line-height:1.7;color:rgba(255,255,255,0.8);margin:0 0 24px;">' + escHtml(fullSummary || '') + '</p>' +
            '<div style="font-size:0.7rem;color:rgba(255,255,255,0.25);padding-top:12px;border-top:1px solid rgba(255,255,255,0.08);font-weight:600;letter-spacing:0.04em;">Invisible Broadcast</div>' +
          '</div>' +
        '</div>';
      document.body.appendChild(el);

      const canvas = await html2canvas(el, { useCORS: true, scale: 2, backgroundColor: '#000000', allowTaint: false, logging: false });
      el.remove();

      const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
      if (!blob) { handleShare(article.link, article.title, article.source); return; }

      const file = new File([blob], 'invisible-broadcast.png', { type: 'image/png' });
      if (navigator.share && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: article.title });
      } else {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'invisible-broadcast.png';
        a.click();
        URL.revokeObjectURL(a.href);
      }
    } catch (err) {
      console.warn('Image share failed:', err.message);
      handleShare(article.link, article.title, article.source);
    }
  }

  function toggleFullscreen() {
    if (document.fullscreenElement || document.webkitFullscreenElement) {
      if (document.exitFullscreen) document.exitFullscreen();
      else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
    } else {
      requestReelFullscreen();
    }
  }

  function closeSourceModal() {
    el.sourceModal.classList.remove('open');
    const content = $('#reader-content');
    if (content) { content.innerHTML = ''; content.style.display = 'none'; }
    const loading = $('#reader-loading');
    if (loading) loading.style.display = 'flex';
    const fallback = $('#source-fallback');
    if (fallback) fallback.style.display = 'none';
  }

  function bindArticleClicks() {
    el.main.addEventListener('click', e => {
      const se = e.target.closest('.card-share-btn');
      if (se) {
        e.stopPropagation();
        const url = decodeURIComponent(se.dataset.url);
        handleShare(url, se.dataset.title, se.dataset.source);
        return;
      }
      const ae = e.target.closest('[data-article]');
      if (!ae) return;
      openArticleDetail(decodeURIComponent(ae.dataset.article));
    });
    el.articleModalClose.addEventListener('click', closeArticleModal);
    el.articleModal.addEventListener('click', e => { if (e.target === el.articleModal) closeArticleModal(); });
    el.articleModalRead.addEventListener('click', () => {
      const url = el.articleModalRead.dataset.url;
      if (url) { closeArticleModal(); openArticleReader(url, el.articleModalTitle.textContent); }
    });
    el.articleModalExt.addEventListener('click', () => {
      const url = el.articleModalExt.dataset.url;
      if (url) window.open(url, '_blank');
    });
    el.sourceModalClose.addEventListener('click', closeSourceModal);
    el.sourceModal.addEventListener('click', e => { if (e.target === el.sourceModal) closeSourceModal(); });
    document.addEventListener('keydown', e => {
      if (currentView === 'reels') {
        if (e.key === 'ArrowLeft') { prevReel(); e.preventDefault(); return; }
        if (e.key === 'ArrowRight') { nextReel(); e.preventDefault(); return; }
        if (e.key === 'Escape') { exitReels(); e.preventDefault(); return; }
      }
      if (e.key === 'Escape') {
        if (el.sourceModal.classList.contains('open')) closeSourceModal();
        else if (el.articleModal.classList.contains('open')) closeArticleModal();
        else if (el.modal.classList.contains('open')) closeSettings();
      }
    });
  }

  /* ── Init ── */
  async function init() {
    try {
      await FeedManager.load();
    } catch (err) {
      el.main.innerHTML = '<div class="error-state"><div class="error-icon">\u26A0\uFE0F</div><p>Could not load feed configuration.</p></div>';
      console.error(err);
      return;
    }

    currentNation = FeedManager.getSelectedNation();

    renderTopTabs();
    bindTopTabs();
    renderSubTabs();
    bindSubTabs();
    bindModeToggle();
    bindViewToggle();
    bindLangSelect();
    bindSearch();
    bindFilterSort();
    bindFilterToggles();
    bindSettings();
    bindArticleClicks();
    bindFeedControls();
    bindDateToggle();
    await renderContent();
  }

  init();
})();
