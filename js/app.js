(async () => {
  const $ = (sel, ctx = document) => ctx.querySelector(sel);
  const $$ = (sel, ctx = document) => [...ctx.querySelectorAll(sel)];

  let currentScope = 'global';
  let currentNation = FeedManager.getSelectedNation();
  let currentSubcat = 'all';
  let currentMode = 'top';
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
    sourceIframe: $('#source-iframe'),
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
    modeToggle: $('#mode-toggle')
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
      currentMode = 'top';
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
    return articles;
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
      currentMode = 'top';
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
    const targetLang = Settings.get('language');
    const encoded = encodeURIComponent(article.link);
    const favicon = getDomain(article.link) ? 'https://www.google.com/s2/favicons?domain=' + getDomain(article.link) + '&sz=64' : '';

    const imgSrc = hasThumb ? article.imageUrl : favicon;
    const thumbHtml = imgSrc
      ? '<div class="article-thumb" style="cursor:pointer" data-article="' + encoded + '">' +
          '<img src="' + imgSrc + '" alt="" loading="lazy" onerror="this.parentElement.style.display=\'none\'">' +
        '</div>'
      : '';

    return '<article class="article-card" style="animation-delay:' + ((index % 10) * 0.04) + 's">' +
        thumbHtml +
        '<div class="article-body">' +
          '<h3 class="article-title"><span class="article-link" data-article="' + encoded + '">' + article.title + '</span></h3>' +
          '<p class="article-summary">' + stripHtml(article.summary).slice(0, 250) + '</p>' +
          '<div class="article-meta">' +
            '<span class="source">' + article.source + '</span>' +
            '<span class="date">' + formatDateShort(article.pubDate) + '</span>' +
            (targetLang !== 'en' ? '<span class="translate-link">Translate</span>' : '') +
          '</div>' +
        '</div>' +
      '</article>';
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
      updateStickyHeader();
      displayCurrentSubcat();
    });
  }

  /* ── Fetch & Refresh ── */
  function scopeKey() {
    return currentScope + '_' + (currentScope === 'nation' ? currentNation : '');
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

      let articles = await FeedFetcher.fetchCategory(key, feeds, true);

      for (const a of articles) a.subcat = a.feedHint || 'politics';

      const groups = {};
      for (const a of articles) {
        const cat = a.subcat;
        if (!groups[cat]) groups[cat] = [];
        groups[cat].push(a);
      }

      scopeCache[key] = { articles, groups };
      const subs = FeedManager.subcategoriesForScope(currentScope);
      if (!subs.includes(currentSubcat)) currentSubcat = subs[0];
      renderSubTabs();
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
    if (!articles.length) { showEmpty(); return; }

    renderArticles(articles);
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

  function bindFeedControls() {
    if (el.feedValidateBtn) el.feedValidateBtn.addEventListener('click', handleValidateFeed);
    if (el.feedAddBtn) el.feedAddBtn.addEventListener('click', handleAddFeed);
    if (el.feedUrlInput) el.feedUrlInput.addEventListener('keydown', e => { if (e.key === 'Enter') handleValidateFeed(); });
  }

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
    el.articleModal.classList.add('open');
  }

  function closeArticleModal() { el.articleModal.classList.remove('open'); }

  function openSourceIframe(url, title) {
    el.sourceModalTitle.textContent = title || 'Original Article';
    el.sourceModal.classList.add('open');
    el.sourceIframe.dataset.originalUrl = url;
    el.sourceIframe.dataset.fallbackTried = 'false';
    tryJina(url);
  }

  function tryJina(url) {
    const jinaUrl = 'https://r.jina.ai/http://' + url.replace(/^https?:\/\//, '');
    el.sourceIframe.src = jinaUrl;
    el.sourceIframe.onload = function() {
      setTimeout(() => {
        try {
          if (el.sourceIframe.contentDocument && !el.sourceIframe.contentDocument.body.textContent.trim()) {
            throw new Error('Empty content');
          }
        } catch(e) { tryFallback(url); }
      }, 8000);
    };
    el.sourceIframe.onerror = function() { tryFallback(url); };
  }

  function tryFallback(url) {
    if (el.sourceIframe.dataset.fallbackTried === 'true') { showSourceFallback(url); return; }
    el.sourceIframe.dataset.fallbackTried = 'true';
    const proxyUrl = 'https://corsproxy.io/?' + encodeURIComponent(url);
    el.sourceIframe.src = proxyUrl;
    el.sourceIframe.onload = function() {
      setTimeout(() => {
        try {
          if (el.sourceIframe.contentDocument && !el.sourceIframe.contentDocument.body.textContent.trim()) {
            showSourceFallback(url);
          }
        } catch(e) { showSourceFallback(url); }
      }, 8000);
    };
    el.sourceIframe.onerror = function() { showSourceFallback(url); };
  }

  function showSourceFallback(url) {
    const fb = $('#source-fallback');
    if (fb) fb.style.display = 'flex';
    const link = $('#source-fallback-link');
    if (link) link.href = url;
  }

  function closeSourceModal() {
    el.sourceModal.classList.remove('open');
    el.sourceIframe.src = '';
    el.sourceIframe.onerror = null;
    el.sourceIframe.onload = null;
    el.sourceIframe.dataset.fallbackTried = 'false';
    const fb = $('#source-fallback');
    if (fb) fb.style.display = 'none';
  }

  function bindArticleClicks() {
    el.main.addEventListener('click', e => {
      const ae = e.target.closest('[data-article]');
      if (!ae) return;
      openArticleDetail(decodeURIComponent(ae.dataset.article));
    });
    el.articleModalClose.addEventListener('click', closeArticleModal);
    el.articleModal.addEventListener('click', e => { if (e.target === el.articleModal) closeArticleModal(); });
    el.articleModalRead.addEventListener('click', () => {
      const url = el.articleModalRead.dataset.url;
      if (url) { closeArticleModal(); openSourceIframe(url, el.articleModalTitle.textContent); }
    });
    el.articleModalExt.addEventListener('click', () => {
      const url = el.articleModalExt.dataset.url;
      if (url) window.open(url, '_blank');
    });
    el.sourceModalClose.addEventListener('click', closeSourceModal);
    el.sourceModal.addEventListener('click', e => { if (e.target === el.sourceModal) closeSourceModal(); });
    document.addEventListener('keydown', e => {
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
    bindSettings();
    bindArticleClicks();
    bindFeedControls();
    bindDateToggle();
    await renderContent();
  }

  init();
})();
