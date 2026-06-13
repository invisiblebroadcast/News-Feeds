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
    activityBtn: $('#activity-btn'),
    activityModal: $('#activity-modal'),
    activityModalClose: $('#activity-modal-close'),
    activityContent: $('#activity-content'),
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
    viewToggle: $('#view-toggle'),
    githubTokenInput: $('#github-token-input'),
    cloudStatus: $('#cloud-status'),
    refreshBtn: $('#refresh-btn'),
    hardRefreshBtn: $('#hard-refresh-btn'),
    hardRefreshModal: $('#hard-refresh-modal'),
    hardRefreshModalClose: $('#hard-refresh-modal-close'),
    hardRefreshCancel: $('#hard-refresh-cancel'),
    hardRefreshConfirm: $('#hard-refresh-confirm'),
    authAvatarBtn: $('#auth-avatar-btn'),
    authDropdown: $('#auth-dropdown'),
    authDropdownName: $('#auth-dropdown-name'),
    authDropdownEmail: $('#auth-dropdown-email'),
    authChangeAvatarBtn: $('#auth-change-avatar-btn'),
    authChangeNameBtn: $('#auth-change-name-btn'),
    authChangePasswordBtn: $('#auth-change-password-btn'),
    changeNameModal: $('#change-name-modal'),
    changeNameInput: $('#change-name-input'),
    changeNameForm: $('#change-name-form'),
    changeNameMsg: $('#change-name-msg'),
    changePasswordModal: $('#change-password-modal'),
    changePasswordCurrent: $('#change-password-current'),
    changePasswordNew: $('#change-password-new'),
    changePasswordRepeat: $('#change-password-repeat'),
    changePasswordForm: $('#change-password-form'),
    changePasswordMsg: $('#change-password-msg'),
    changeAvatarModal: $('#change-avatar-modal'),
    changeAvatarInput: $('#change-avatar-input'),
    changeAvatarPreview: $('#change-avatar-preview'),
    changeAvatarFallback: $('#change-avatar-fallback'),
    changeAvatarPickBtn: $('#change-avatar-pick-btn'),
    changeAvatarUploadBtn: $('#change-avatar-upload-btn'),
    changeAvatarMsg: $('#change-avatar-msg'),
    commentsPage: $('#comments-page'),
    commentsBackBtn: $('#comments-back-btn'),
    commentsList: $('#comments-list'),
    commentsInput: $('#comments-input'),
    commentsPostBtn: $('#comments-post-btn'),
    commentsReplyPreview: $('#comments-reply-preview'),
    commentsReplyText: $('#comments-reply-text'),
    commentsReplyCancel: $('#comments-reply-cancel'),
    deleteCommentModal: $('#delete-comment-modal'),
    deleteCommentConfirm: $('#delete-comment-confirm'),
    deleteCommentCancel: $('#delete-comment-cancel')
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

  function cleanSummary(text) {
    return text
      .replace(/\s*\[\.\.\.\]\s*$/, '')
      .replace(/\s*\[\.\.\]\s*$/, '')
      .replace(/\s*\[\.\s*\.\s*\.\s*\]\s*$/, '')
      .replace(/\s*\.{3,}\s*$/, '')
      .replace(/\s*…\s*$/, '')
      .replace(/\s*\[more\]\s*$/i, '')
      .replace(/\s*\[read more\]\s*$/i, '')
      .replace(/\s*\[continue reading\]\s*$/i, '')
      .replace(/\s*\[continued\]\s*$/i, '')
      .replace(/\s*\(more\)\s*$/i, '')
      .replace(/\s*&hellip;\s*$/i, '')
      .replace(/\s*&#8230;\s*$/i, '')
      .trim();
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
    articles = FeedFetcher.deduplicate(articles);
    if (currentMode === 'top') {
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
    // sub-tab-bar stays hidden — user clicks ☰ to show it
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
      // Hide the sub-tab-bar after selection
      el.subBar.style.display = 'none';
      const catToggle = $('#cat-toggle-btn');
      if (catToggle) catToggle.classList.remove('active');
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
    updateViewToggleInNav();
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
          '<img src="' + escAttr(enhanceImageUrl(article.imageUrl) || article.imageUrl) + '" alt="" loading="lazy" onerror="this.parentElement.style.display=\'none\'">' +
        '</div>'
      : '';

    const rankHtml = currentMode === 'top' && article._rank
      ? '<span class="score-badge" style="color:' + (article._rank <= 3 ? 'var(--accent)' : 'var(--text-tertiary)') + '">#' + article._rank + '</span>'
      : '';

    const ad = getArticleData(article.link);
    const flagHtml = ad.flag ? '<span class="flag-badge" style="background:' + (FLAG_COLORS[ad.flag] || 'var(--text-tertiary)') + '">' + ad.flag + '</span>' : '';
    const likeCount = ad.likeCount || 0;
    const dislikeCount = ad.dislikeCount || 0;
    const commentCount = (ad.comments && ad.comments.length) || 0;

    return '<article class="article-card" style="animation-delay:' + ((index % 10) * 0.04) + 's">' +
        '<button class="card-share-btn" data-url="' + encodeURIComponent(article.link) + '" data-title="' + escAttr(article.title) + '" data-source="' + escAttr(article.source) + '" title="Share as Image">&#x21AA;</button>' +
        thumbHtml +
        '<div class="article-body">' +
          '<h3 class="article-title"><span class="article-link" data-article="' + encoded + '">' + escHtml(article.title) + '</span></h3>' +
          '<p class="article-summary">' + cleanSummary(stripHtml(article.summary)).slice(0, 250) + '</p>' +
          '<div class="article-meta">' +
            '<span class="source">' + escHtml(article.source) + '</span>' +
            '<span class="date">' + formatDateShort(article.pubDate) + '</span>' +
            rankHtml +
            flagHtml +
          '</div>' +
          '<div class="card-actions">' +
            '<button class="card-action-btn card-like-btn ' + (ad.like ? 'active' : '') + '" data-article="' + encoded + '" title="Like">' +
              '<span>&#x1F44D;</span><span class="card-action-count">' + likeCount + '</span>' +
            '</button>' +
            '<button class="card-action-btn card-dislike-btn ' + (ad.dislike ? 'active' : '') + '" data-article="' + encoded + '" title="Dislike">' +
              '<span>&#x1F44E;</span><span class="card-action-count">' + dislikeCount + '</span>' +
            '</button>' +
            '<button class="card-action-btn card-comment-btn" data-article="' + encoded + '" title="Comment">' +
              '<span>&#x1F4AC;</span><span class="card-action-count">' + commentCount + '</span>' +
            '</button>' +
          '</div>' +
          '<div class="article-watermark">' +
            '<span class="wm-brand">Invisible Broadcast</span>' +
          '</div>' +
        '</div>' +
      '</article>';
  }

  function renderViewToggle() {
    return '<button class="mode-btn' + (currentView === 'list' ? ' active' : '') + '" data-view="list" title="List View">' +
        '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" style="vertical-align:middle"><rect x="2" y="2" width="5" height="5" rx="1"/><rect x="9" y="2" width="5" height="5" rx="1"/><rect x="2" y="9" width="5" height="5" rx="1"/><rect x="9" y="9" width="5" height="5" rx="1"/></svg>' +
      '</button>' +
      '<button class="mode-btn' + (currentView === 'reels' ? ' active' : '') + '" data-view="reels" title="Cards View">' +
        '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" style="vertical-align:middle"><rect x="1" y="1" width="14" height="9" rx="1.5"/><path d="M4 11v3M12 11v3M8 11v3"/></svg>' +
      '</button>';
  }

  function updateViewToggleInNav() {
    const container = $('#view-toggle');
    if (!container) return;
    container.innerHTML = renderViewToggle();
  }

  /* ── Reels View ── */
  let currentReelIndex = 0;
  // Fullscreen removed — swipe always works in cards view (no fullscreen gate)

  function updateNavArrows(container) {
    if (!container) return;
    container.classList.add('reels-show-arrows');
    container.style.touchAction = 'pan-y';
  }

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

  function cardOverlayHtml(includeToolbar) {
    var html = '<div class="reels-img-wrap"><img class="reels-img" alt="" loading="lazy"></div>';
    if (includeToolbar !== false) {
      // Home button — top-left, inside the card border (separate from toolbar)
      html += '<button class="reels-tool-btn reels-home-btn" title="Back to Home">&#x1F3E0;</button>';
      // Toolbar — top-right, same row as home
      html += '<div class="reels-toolbar">' +
        '<button class="reels-tool-btn reels-refresh-btn" title="Refresh">&#x21BB;</button>' +
        '<button class="reels-tool-btn reels-share-text" title="Share as Text">&#x21AA;</button>' +
        '<button class="reels-tool-btn reels-share-image" title="Share as Image">&#x1F5BC;</button>' +
      '</div>';
      // Vertical action bar — right side, center (like YT Shorts / Reels)
      html += '<div class="reels-actions">' +
        '<button class="reels-action-btn reels-like-btn" title="Like">' +
          '<span class="reels-action-icon">&#x1F44D;</span>' +
          '<span class="reels-action-label">Like</span>' +
        '</button>' +
        '<button class="reels-action-btn reels-dislike-btn" title="Dislike">' +
          '<span class="reels-action-icon">&#x1F44E;</span>' +
          '<span class="reels-action-label">Dislike</span>' +
        '</button>' +
        '<button class="reels-action-btn reels-comment-btn" title="Comment">' +
          '<span class="reels-action-icon">&#x1F4AC;</span>' +
          '<span class="reels-action-label">Comment</span>' +
        '</button>' +
      '</div>';
    }
    html += '<div class="reels-overlay">' +
        '<span class="reels-count"></span>' +
        '<h2 class="reels-title"></h2>' +
        '<div class="reels-meta">' +
          '<span class="reels-source"></span>' +
          '<span class="reels-date"></span>' +
          '<span class="reels-flag" style="display:none"></span>' +
        '</div>' +
        '<p class="reels-summary"></p>' +
        '<button class="reels-readmore-btn" style="background:none;border:none;color:var(--accent);cursor:pointer;font-size:0.82rem;padding:0;text-align:left;display:none">Read more</button>' +
        '<button class="btn btn-primary reels-read-btn">Read Original Article</button>' +
        '<div class="reels-watermark">' +
          '<span class="wm-brand">Invisible Broadcast</span>' +
        '</div>' +
      '</div>';
    return html;
  }

  function readerHtml() {
    return '<div class="reels-reader" style="display:none">' +
      '<div class="reels-reader-header">' +
        '<span></span>' +
        '<button class="reels-reader-close">&times;</button>' +
      '</div>' +
      '<div class="reels-reader-scroll">' +
        '<h3 class="rr-title"></h3>' +
        '<div class="rr-meta">' +
          '<span class="rr-source"></span>' +
          '<span class="rr-date"></span>' +
        '</div>' +
        '<p class="rr-summary"></p>' +
        '<div style="margin-bottom:12px">' +
          '<select class="rr-flag">' +
            '<option value="">No flag</option>' +
            '<option value="save">Save for later</option>' +
            '<option value="investigative">Investigative</option>' +
            '<option value="favorite">Favorite</option>' +
            '<option value="important">Important</option>' +
            '<option value="urgent">Urgent</option>' +
          '</select>' +
        '</div>' +
        '<div style="margin-bottom:16px">' +
          '<textarea class="rr-notes" placeholder="Add a comment\u2026"></textarea>' +
        '</div>' +
        '<div class="rr-actions">' +
          '<button class="btn btn-primary rr-read" style="font-size:0.85rem;padding:8px 16px">Read Article</button>' +
          '<button class="btn btn-danger rr-open" style="font-size:0.85rem;padding:8px 16px">Open in Browser</button>' +
        '</div>' +
      '</div>' +
    '</div>';
  }

  function updateCard(cardEl, article, idx, total) {
    if (!cardEl || !article) return;
    const hasThumb = article.imageUrl && article.imageUrl.startsWith('http');
    const imgWrap = cardEl.querySelector('.reels-img-wrap');
    const imgEl = cardEl.querySelector('.reels-img');
    if (hasThumb && imgEl && imgWrap) {
      imgEl.src = enhanceImageUrl(article.imageUrl) || article.imageUrl;
      imgWrap.classList.remove('no-image');
      imgWrap.style.display = '';
      imgEl.onerror = function() { imgWrap.classList.add('no-image'); };
    } else {
      if (imgWrap) { imgWrap.classList.add('no-image'); imgWrap.style.display = ''; }
      if (imgEl) imgEl.src = '';
    }

    const count = cardEl.querySelector('.reels-count');
    if (count) count.textContent = (idx + 1) + ' / ' + total;
    const title = cardEl.querySelector('.reels-title');
    if (title) title.textContent = article.title;
    const source = cardEl.querySelector('.reels-source');
    if (source) source.textContent = article.source;
    const date = cardEl.querySelector('.reels-date');
    if (date) date.textContent = formatDateShort(article.pubDate);
    const summaryText = cleanSummary(stripHtml(article.summary));
    const summary = cardEl.querySelector('.reels-summary');
    if (summary) {
      summary.textContent = summaryText.slice(0, 350);
      summary.dataset.full = summaryText;
    }
    const readmoreBtn = cardEl.querySelector('.reels-readmore-btn');
    if (readmoreBtn) {
      readmoreBtn.style.display = summaryText.length > 350 ? 'block' : 'none';
      readmoreBtn.textContent = 'Read more';
    }
    const ad = getArticleData(article.link);
    const flagEl = cardEl.querySelector('.reels-flag');
    if (flagEl) {
      if (ad.flag) { flagEl.textContent = ad.flag; flagEl.style.display = 'inline'; flagEl.style.background = FLAG_COLORS[ad.flag] || 'var(--text-tertiary)'; }
      else { flagEl.style.display = 'none'; }
    }
    const readBtn = cardEl.querySelector('.reels-read-btn');
    if (readBtn) readBtn.dataset.article = encodeURIComponent(article.link);
    const st = cardEl.querySelector('.reels-share-text');
    if (st) { st.dataset.url = encodeURIComponent(article.link); st.dataset.title = article.title; st.dataset.source = article.source; }
    const si = cardEl.querySelector('.reels-share-image');
    if (si) { si.dataset.url = encodeURIComponent(article.link); si.dataset.title = article.title; si.dataset.source = article.source; }
    const likeBtn = cardEl.querySelector('.reels-like-btn');
    if (likeBtn) likeBtn.classList.toggle('active', !!ad.like);
    const dislikeBtn = cardEl.querySelector('.reels-dislike-btn');
    if (dislikeBtn) dislikeBtn.classList.toggle('active', !!ad.dislike);
  }

  function showReel() {
    const articles = currentArticles;
    const idx = currentReelIndex;
    const article = articles[idx];
    const total = articles.length;

    const existing = el.main.querySelector('.reels-container');

    if (!existing) {
      el.main.innerHTML =
        '<div class="reels-container">' +
          '<div class="reels-progress"></div>' +
          '<div class="reels-stack" id="reels-stack">' +
            '<div class="reels-card">' + cardOverlayHtml() + '</div>' +
            readerHtml() +
          '</div>' +
        '</div>';

      const container = el.main.querySelector('.reels-container');
      const stack = container.querySelector('.reels-stack');

      // Event delegation on stack for card button actions (using closest)
      stack.addEventListener('click', e => {
        const currentArticle = currentArticles[currentReelIndex];

        const readBtn = e.target.closest('.reels-read-btn');
        if (readBtn) {
          e.stopPropagation();
          const link = decodeURIComponent(readBtn.dataset.article);
          openArticleDetail(link);
          return;
        }
        const st = e.target.closest('.reels-share-text');
        if (st) {
          e.stopPropagation();
          handleShare(decodeURIComponent(st.dataset.url), st.dataset.title, st.dataset.source);
          return;
        }
        const si = e.target.closest('.reels-share-image');
        if (si) {
          e.stopPropagation();
          handleShareImage(currentArticle, si);
          return;
        }
        const home = e.target.closest('.reels-home-btn');
        if (home) { e.stopPropagation(); forceExitToHome(); return; }
        const refresh = e.target.closest('.reels-refresh-btn');
        if (refresh) { e.stopPropagation(); refreshAll(); return; }
        if (e.target.closest('.reels-reader-close')) {
          e.stopPropagation();
          closeReelsReader();
          return;
        }
        const rr = e.target.closest('.rr-read');
        if (rr) {
          const url = rr.dataset.url;
          if (!url) return;
          const scroll = stack.querySelector('.reels-reader-scroll');
          const existingContent = scroll.querySelector('.rr-fetched');
          if (existingContent) { existingContent.remove(); return; }
          const wrapper = document.createElement('div');
          wrapper.className = 'rr-fetched';
          wrapper.style.cssText = 'margin-top:16px;border-top:1px solid var(--border-primary);padding-top:16px';
          wrapper.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-tertiary)">Loading\u2026</div>';
          scroll.appendChild(wrapper);
          (async () => {
            try {
              const html = await fetchArticleHtml(url);
              if (html) wrapper.innerHTML = html;
              else wrapper.innerHTML = '<div style="text-align:center;padding:20px"><p style="color:var(--text-tertiary);margin-bottom:12px">Could not load article directly.</p><a href="' + escAttr(url) + '" target="_blank" class="btn btn-danger" style="font-size:0.85rem;padding:8px 16px;display:inline-block">Open in Browser</a></div>';
            } catch { wrapper.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-tertiary)">Failed to load.</div>'; }
          })();
          return;
        }
        if (e.target.closest('.rr-open')) {
          const btn = e.target.closest('.rr-open');
          if (btn.href) window.open(btn.href, '_blank');
          return;
        }
        const rmBtn = e.target.closest('.reels-readmore-btn');
        if (rmBtn) {
          const card = stack.querySelector('.reels-card');
          const summary = card.querySelector('.reels-summary');
          if (!summary) return;
          if (summary.textContent === summary.dataset.full) {
            summary.textContent = summary.dataset.full.slice(0, 350);
            rmBtn.textContent = 'Read more';
          } else {
            summary.textContent = summary.dataset.full;
            rmBtn.textContent = 'Show less';
          }
          return;
        }
        const likeBtn = e.target.closest('.reels-like-btn');
        if (likeBtn) {
          if (!requireAuth()) return;
          if (!currentArticle) return;
          const ad = getArticleData(currentArticle.link);
          if (ad.like) { ad.like = false; } else { ad.like = true; ad.dislike = false; }
          saveArticleData(currentArticle.link, ad);
          const lBtn = stack.querySelector('.reels-like-btn');
          const dBtn = stack.querySelector('.reels-dislike-btn');
          if (lBtn) lBtn.classList.toggle('active', !!ad.like);
          if (dBtn) dBtn.classList.toggle('active', !!ad.dislike);
          return;
        }
        const dislikeBtn = e.target.closest('.reels-dislike-btn');
        if (dislikeBtn) {
          if (!requireAuth()) return;
          if (!currentArticle) return;
          const ad = getArticleData(currentArticle.link);
          if (ad.dislike) { ad.dislike = false; } else { ad.dislike = true; ad.like = false; }
          saveArticleData(currentArticle.link, ad);
          const lBtn = stack.querySelector('.reels-like-btn');
          const dBtn = stack.querySelector('.reels-dislike-btn');
          if (dBtn) dBtn.classList.toggle('active', !!ad.dislike);
          if (lBtn) lBtn.classList.toggle('active', !!ad.like);
          return;
        }
        const commentBtn = e.target.closest('.reels-comment-btn');
        if (commentBtn) {
          if (!requireAuth()) return;
          if (currentArticle) openCommentsPage(currentArticle);
          return;
        }
        // Card background click → toggle action bar visibility (soft fade)
        if (e.target.closest('.reels-card') && !e.target.closest('button, a, input, textarea, .reels-comment-box, .reels-overlay button, .reels-home-btn, .reels-toolbar')) {
          e.stopPropagation();
          const actions = stack.querySelector('.reels-actions');
          if (actions) {
            const isVisible = actions.style.opacity !== '0' && actions.style.display !== 'none';
            if (isVisible) {
              actions.style.transition = 'opacity 0.25s ease';
              actions.style.opacity = '0';
              setTimeout(() => { actions.style.display = 'none'; }, 250);
            } else {
              actions.style.display = 'flex';
              actions.style.transition = 'opacity 0.25s ease';
              actions.style.opacity = '0';
              requestAnimationFrame(() => { actions.style.opacity = '1'; });
            }
          }
          return;
        }
      });
      updateNavArrows(container);
      let swipeStartX = 0, swipeDx = 0, isSwiping = false, swipeDir = 0; // -1 = right, 1 = left
      container.addEventListener('touchstart', e => {
        if (e.touches.length !== 1) return;
        swipeStartX = e.touches[0].clientX;
        swipeDx = 0;
        isSwiping = false;
        swipeDir = 0;
      }, { passive: true });
      container.addEventListener('touchmove', e => {
        if (!swipeStartX) return;
        const card = stack.querySelector('.reels-card');
        if (!card) return;
        const dx = e.touches[0].clientX - swipeStartX;
        const dy = e.touches[0].clientY - (e.touches[0].clientY - (swipeStartX ? 0 : 0)); // not needed

        // Determine direction: horizontal swipe if |dx| > |dy| and > threshold
        if (!isSwiping && Math.abs(dx) > 15 && Math.abs(dx) > Math.abs(dy)) {
          isSwiping = true;
          swipeDir = dx > 0 ? 1 : -1; // 1 = right, -1 = left
        }
        if (!isSwiping) return;

        swipeDx = dx;
        const resistance = 0.6;
        const translateX = Math.max(-180, Math.min(180, dx * resistance));
        const scale = 1 - Math.min(Math.abs(dx) / 2000, 0.04);
        const opacity = 1 - Math.min(Math.abs(dx) / 600, 0.25);
        card.style.transition = 'none';
        card.style.transform = `translateX(${translateX}px) scale(${scale})`;
        card.style.opacity = opacity;
      }, { passive: false });
      container.addEventListener('touchend', e => {
        if (!swipeStartX) return;
        const card = stack.querySelector('.reels-card');
        const dx = e.changedTouches[0].clientX - swipeStartX;
        const wasSwiping = isSwiping;
        const wasDir = swipeDir;
        swipeStartX = 0;
        swipeDx = 0;
        isSwiping = false;
        swipeDir = 0;
        if (!card) return;
        const threshold = 70;
        if (wasSwiping && wasDir === -1 && dx < -threshold) {
          // Swipe left — next article
          card.style.transition = 'transform 0.2s ease-out, opacity 0.2s ease-out';
          card.style.transform = 'translateX(-110%) scale(0.95)';
          card.style.opacity = '0';
          setTimeout(() => {
            nextReel();
            if (card) {
              card.style.transition = 'none';
              card.style.transform = 'translateX(0) scale(1)';
              card.style.opacity = '1';
              requestAnimationFrame(() => { if (card) card.style.transition = ''; });
            }
          }, 200);
        } else if (wasSwiping && wasDir === 1 && dx > threshold) {
          // Swipe right — previous article
          card.style.transition = 'transform 0.2s ease-out, opacity 0.2s ease-out';
          card.style.transform = 'translateX(110%) scale(0.95)';
          card.style.opacity = '0';
          setTimeout(() => {
            prevReel();
            if (card) {
              card.style.transition = 'none';
              card.style.transform = 'translateX(0) scale(1)';
              card.style.opacity = '1';
              requestAnimationFrame(() => { if (card) card.style.transition = ''; });
            }
          }, 200);
        } else {
          // Snap back
          card.style.transition = 'transform 0.2s ease-out, opacity 0.2s ease-out';
          card.style.transform = '';
          card.style.opacity = '';
          setTimeout(() => { if (card) card.style.transition = ''; }, 200);
        }
      }, { passive: true });
    }

    // In-place DOM updates
    const container = existing || el.main.querySelector('.reels-container');
    if (!container) return;
    const stack = container.querySelector('.reels-stack');
    if (!stack) return;

    const dots = container.querySelector('.reels-progress');
    if (dots) dots.innerHTML = articles.map((a, i) => '<span class="reels-dot' + (i === idx ? ' active' : '') + '"></span>').join('');

    const fg = stack.querySelector('.reels-card');
    if (fg) {
      updateCard(fg, article, idx, total);
      fg.style.transition = 'none';
      fg.style.transform = 'translateX(0)';
      requestAnimationFrame(() => { fg.style.transition = ''; });
    }
  }

  function prevReel() {
    if (currentReelIndex < 1) return;
    currentReelIndex--;
    const a = currentArticles[currentReelIndex];
    if (a) trackView(a.link);
    showReel();
  }

  function nextReel() {
    if (currentReelIndex >= currentArticles.length - 1) return;
    currentReelIndex++;
    const a = currentArticles[currentReelIndex];
    if (a) trackView(a.link);
    showReel();
  }

  async function fetchArticleHtml(url) {
    if (isGoogleNewsRedirect(url)) return null;
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
        return doc.body.innerHTML;
      } catch (err) {
        console.warn('Reader proxy ' + proxy.url + ' failed:', err.message);
      }
    }
    return null;
  }

  function bindReelsReader() {}

  function openReelsReader(link) {
    const article = findArticleByLink(link);
    if (!article) return;
    const container = document.querySelector('.reels-container');
    if (!container) return;
    const reader = container.querySelector('.reels-reader');
    if (!reader) return;
    reader.querySelector('.rr-title').textContent = article.title;
    reader.querySelector('.rr-source').textContent = article.source;
    reader.querySelector('.rr-date').textContent = formatDateShort(article.pubDate);
    reader.querySelector('.rr-summary').textContent = cleanSummary(stripHtml(article.summary));
    reader.querySelector('.rr-read').dataset.url = article.link;
    reader.querySelector('.rr-read').dataset.title = article.title;
    reader.querySelector('.rr-open').href = article.link;
    const ad = getArticleData(article.link);
    const flagEl = reader.querySelector('.rr-flag');
    if (flagEl) {
      flagEl.value = ad.flag || '';
      flagEl.disabled = !currentUser;
      flagEl.onchange = function() {
        if (!requireAuth()) { flagEl.value = ad.flag || ''; return; }
        const newData = getArticleData(article.link);
        newData.flag = this.value || '';
        saveArticleData(article.link, newData);
      };
    }
    const notesEl = reader.querySelector('.rr-notes');
    if (notesEl) {
      notesEl.value = ad.note || '';
      notesEl.disabled = !currentUser;
      notesEl.oninput = function() {
        if (!requireAuth()) { notesEl.value = ad.note || ''; return; }
        const newData = getArticleData(article.link);
        newData.note = this.value || '';
        saveArticleData(article.link, newData);
      };
    }
    reader.style.display = 'flex';
    reader.querySelector('.rr-fetched')?.remove();
  }

  function closeReelsReader() {
    const container = document.querySelector('.reels-container');
    if (!container) return;
    const reader = container.querySelector('.reels-reader');
    if (reader) reader.style.display = 'none';
    const scroll = container.querySelector('.reels-reader-scroll');
    if (scroll) { const f = scroll.querySelector('.rr-fetched'); if (f) f.remove(); }
    if (el.articleModal.classList.contains('open')) closeArticleModal();
  }

  function requestReelFullscreen() {
    const c = document.querySelector('.reels-container');
    if (!c) return;
    if (c.requestFullscreen) {
      c.requestFullscreen().catch(err => console.warn('Fullscreen request failed:', err.message));
    } else if (c.webkitRequestFullscreen) {
      c.webkitRequestFullscreen();
    }
  }

  function exitReels() {
    currentView = 'list';
    updateStickyHeader();
    displayCurrentSubcat();
  }

  function forceExitToHome() {
    if (document.fullscreenElement || document.webkitFullscreenElement) {
      if (document.exitFullscreen) document.exitFullscreen().catch(() => {});
      else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
    }
    exitReels();
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
    document.addEventListener('click', e => {
      const btn = e.target.closest('#view-toggle .mode-btn');
      if (!btn || btn.classList.contains('active')) return;
      currentView = btn.dataset.view;
      $$('#view-toggle .mode-btn').forEach(b => b.classList.remove('active'));
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
    const key = scopeKey();
    if (scopeCache[key]) {
      displayCurrentSubcat();
      return;
    }
    isFetching = true;
    showLoading();

    try {

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

  async function displayCurrentSubcat() {
    const key = scopeKey();
    const cached = scopeCache[key];
    if (!cached) { renderContent(); return; }

    updateStickyHeader();

    const articles = getFilteredArticles(currentSubcat, cached);
    updateFilterSourceOptions(articles);
    if (!articles.length) { showEmpty(); return; }

    await renderTranslated(articles);
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
    const key = scopeKey();
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.55);display:flex;align-items:center;justify-content:center;z-index:300';
    overlay.innerHTML = '<div class="loading-spinner"></div>';
    document.body.appendChild(overlay);
    document.querySelectorAll('#reels-refresh, .reels-refresh-btn, #refresh-btn').forEach(b => b.classList.add('btn-spin'));

    scopeCache[key] = null;
    const feeds = FeedManager.getFeeds(currentScope, currentScope === 'nation' ? currentNation : null);
    if (!feeds.length) {
      overlay.remove();
      document.querySelectorAll('#reels-refresh, .reels-refresh-btn, #refresh-btn').forEach(b => b.classList.remove('btn-spin'));
      return;
    }
    const groups = {};
    const batchSize = 3;
    for (let i = 0; i < feeds.length; i += batchSize) {
      const batch = feeds.slice(i, i + batchSize);
      const results = await Promise.allSettled(batch.map(f => FeedFetcher.fetchFeed(f)));
      for (const result of results) {
        if (result.status === 'fulfilled') {
          for (const a of result.value) {
            a.subcat = a.feedHint || 'politics';
            const cat = a.subcat;
            if (!groups[cat]) groups[cat] = [];
            groups[cat].push(a);
          }
        }
      }
    }
    let allArticles = [];
    for (const cat of Object.keys(groups)) allArticles.push(...groups[cat]);
    scopeCache[key] = { articles: allArticles, groups };
    renderSubTabs();
    updateStickyHeader();
    await displayCurrentSubcat();
    document.querySelectorAll('#reels-refresh, .reels-refresh-btn, #refresh-btn').forEach(b => b.classList.remove('btn-spin'));
    overlay.remove();
  }

  /* ── Hard Refresh ── */
  function openHardRefreshModal() {
    if (el.hardRefreshModal) el.hardRefreshModal.classList.add('open');
  }
  function closeHardRefreshModal() {
    if (el.hardRefreshModal) el.hardRefreshModal.classList.remove('open');
  }
  function performHardRefresh() {
    // Clear all app caches from localStorage, but preserve the Supabase auth session
    const PRESERVE_KEYS = ['supabase.auth.token'];
    const CLEAR_PREFIXES = [
      'newsfeeds_', // settings, article data, custom feeds, subscriptions, selected nation
      'github_token' // legacy GitHub PAT
    ];
    const toRemove = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key) continue;
      if (PRESERVE_KEYS.includes(key)) continue;
      if (CLEAR_PREFIXES.some(prefix => key.startsWith(prefix))) {
        toRemove.push(key);
      }
    }
    toRemove.forEach(k => localStorage.removeItem(k));
    // Clear sessionStorage too (in case anything is stored there)
    try { sessionStorage.clear(); } catch {}
    // Force reload from server (bypass cache)
    window.location.reload();
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
    displayCurrentSubcat();
  }

  function bindSettings() {
    el.settingsBtn.addEventListener('click', e => { e.stopPropagation(); openSettings(); });
    el.modalClose.addEventListener('click', closeSettings);
    el.modalCancel.addEventListener('click', closeSettings);
    el.modalSave.addEventListener('click', saveSettings);
    el.modal.addEventListener('click', e => { if (e.target === el.modal) closeSettings(); });
    if (el.refreshBtn) el.refreshBtn.addEventListener('click', refreshAll);
    if (el.hardRefreshBtn) el.hardRefreshBtn.addEventListener('click', openHardRefreshModal);
    if (el.hardRefreshModalClose) el.hardRefreshModalClose.addEventListener('click', closeHardRefreshModal);
    if (el.hardRefreshCancel) el.hardRefreshCancel.addEventListener('click', closeHardRefreshModal);
    if (el.hardRefreshConfirm) el.hardRefreshConfirm.addEventListener('click', performHardRefresh);
    if (el.hardRefreshModal) el.hardRefreshModal.addEventListener('click', e => { if (e.target === el.hardRefreshModal) closeHardRefreshModal(); });
    // Options button toggles the extras row (date, refresh, hard refresh, activity)
    const optionsBtn = $('#options-btn');
    const headerExtras = $('#header-extras');
    let optionsTimeout = null;
    if (optionsBtn && headerExtras) {
      optionsBtn.addEventListener('click', () => {
        const hidden = headerExtras.style.display === 'none' || !headerExtras.style.display;
        headerExtras.style.display = hidden ? 'flex' : 'none';
        optionsBtn.classList.toggle('active', hidden);
        // Auto-hide after 5 seconds
        clearTimeout(optionsTimeout);
        if (hidden) {
          optionsTimeout = setTimeout(() => {
            headerExtras.style.display = 'none';
            optionsBtn.classList.remove('active');
          }, 5000);
        }
      });
    }
    // Category toggle button shows/hides the sub-tab-bar
    const catToggleBtn = $('#cat-toggle-btn');
    const subTabBar = $('#sub-tab-bar');
    if (catToggleBtn && subTabBar) {
      catToggleBtn.addEventListener('click', () => {
        const hidden = subTabBar.style.display === 'none' || !subTabBar.style.display;
        subTabBar.style.display = hidden ? 'block' : 'none';
        catToggleBtn.classList.toggle('active', hidden);
      });
    }
    // Tools toggle button — show/hide filter row and filters panel
    const toolsToggleBtn = $('#tools-toggle-btn');
    const toolsRow = $('#bottom-tools-row');
    if (toolsToggleBtn && toolsRow) {
      toolsToggleBtn.addEventListener('click', () => {
        const hidden = toolsRow.style.display === 'none' || !toolsRow.style.display;
        toolsRow.style.display = hidden ? 'flex' : 'none';
        if (el.filtersPanel) {
          el.filtersPanel.style.display = hidden ? 'block' : 'none';
        }
        toolsToggleBtn.classList.toggle('active', hidden);
      });
    }
  }

  /* ── Activity ── */
  function openActivity() {
    el.activityModal.classList.add('open');
    renderActivityTab('history');
  }

  function closeActivity() { el.activityModal.classList.remove('open'); }

  function renderActivityTab(tab) {
    const container = el.activityContent;
    if (!container) return;
    $$('.activity-tab').forEach(b => b.classList.toggle('active', b.dataset.actab === tab));
    const allData = SupabaseStore.getAll ? SupabaseStore.getAll() : {};
    const items = Object.entries(allData);

    let filtered = [];
    if (tab === 'history') {
      filtered = items.filter(([, d]) => d.viewed).sort((a, b) => (b[1].viewed || 0) - (a[1].viewed || 0));
    } else if (tab === 'liked') {
      filtered = items.filter(([, d]) => d.like);
    } else if (tab === 'disliked') {
      filtered = items.filter(([, d]) => d.dislike);
    } else if (tab === 'flagged') {
      filtered = items.filter(([, d]) => d.flag);
    }

    if (!filtered.length) {
      container.innerHTML = '<div class="activity-empty">No ' + tab + ' items yet.</div>';
      return;
    }

    // Use currentArticles to find titles/sources for links
    const articleMap = {};
    if (currentArticles) currentArticles.forEach(a => articleMap[a.link] = a);

    container.innerHTML = filtered.map(([link, data]) => {
      const article = articleMap[link];
      const title = article ? article.title : link;
      const source = article ? article.source : '';
      const time = data.viewed ? formatDateShort(data.viewed) : '';
      const badges = [];
      if (data.like) badges.push('<span class="ai-badge" style="background:var(--accent-dim);color:#fff">&#x1F44D;</span>');
      if (data.dislike) badges.push('<span class="ai-badge" style="background:var(--text-tertiary);color:#fff">&#x1F44E;</span>');
      if (data.flag) badges.push('<span class="ai-badge" style="background:' + (FLAG_COLORS[data.flag] || 'var(--text-tertiary)') + ';color:#000">' + data.flag + '</span>');
      return '<div class="activity-item">' +
        '<div class="ai-title" data-link="' + encodeURIComponent(link) + '">' + escHtml(title) +
          (source ? '<div class="ai-source">' + escHtml(source) + '</div>' : '') +
        '</div>' +
        '<div class="ai-meta">' +
          (time ? '<span>' + time + '</span>' : '') +
          (badges.length ? '<span>' + badges.join(' ') + '</span>' : '') +
          (data.note ? '<span style="color:var(--text-secondary);font-size:0.7rem">&#x1F4DD;</span>' : '') +
        '</div>' +
      '</div>';
    }).join('');

    // Click on title to open article
    container.querySelectorAll('.ai-title').forEach(el2 => {
      el2.addEventListener('click', () => {
        const link = decodeURIComponent(el2.dataset.link);
        closeActivity();
        openArticleDetail(link);
      });
    });
  }

  function bindActivity() {
    if (el.activityBtn) el.activityBtn.addEventListener('click', openActivity);
    if (el.activityModalClose) el.activityModalClose.addEventListener('click', closeActivity);
    if (el.activityModal) el.activityModal.addEventListener('click', e => { if (e.target === el.activityModal) closeActivity(); });
    // Tab switching via delegation
    document.addEventListener('click', e => {
      const tab = e.target.closest('.activity-tab');
      if (tab && el.activityModal && el.activityModal.classList.contains('open')) {
        renderActivityTab(tab.dataset.actab);
      }
    });
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

  const FLAGS = ['', 'save', 'investigative', 'favorite', 'important', 'urgent'];
  const FLAG_LABELS = { save: 'Save for later', investigative: 'Investigative', favorite: 'Favorite', important: 'Important', urgent: 'Urgent' };
  const FLAG_COLORS = { save: '#3fb950', investigative: '#d29922', favorite: '#ff2929', important: '#58a6ff', urgent: '#f0883e' };

  function getArticleData(link) { return SupabaseStore.get(link); }
  function saveArticleData(link, data) { SupabaseStore.set(link, data); }

  function trackView(link) {
    const ad = getArticleData(link);
    ad.viewed = Date.now();
    saveArticleData(link, ad);
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
    trackView(link);
    el.articleModalTitle.textContent = article.title;
    el.articleModalSource.textContent = article.source;
    el.articleModalDate.textContent = formatDate(article.pubDate);
    el.articleModalSummary.textContent = cleanSummary(stripHtml(article.summary));
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
    // Like / Dislike buttons in article modal
    const articleLikeBtn = $('#article-modal-like');
    const articleDislikeBtn = $('#article-modal-dislike');
    if (articleLikeBtn) {
      articleLikeBtn.classList.toggle('active', !!ad.like);
      articleLikeBtn.classList.toggle('like', true);
      articleLikeBtn.onclick = function(e) {
        e.stopPropagation();
        if (!requireAuth()) return;
        const newData = getArticleData(article.link);
        if (newData.like) { newData.like = false; } else { newData.like = true; newData.dislike = false; }
        saveArticleData(article.link, newData);
        articleLikeBtn.classList.toggle('active', !!newData.like);
        if (articleDislikeBtn) articleDislikeBtn.classList.toggle('active', !!newData.dislike);
        renderCurrentList();
      };
    }
    if (articleDislikeBtn) {
      articleDislikeBtn.classList.toggle('active', !!ad.dislike);
      articleDislikeBtn.classList.toggle('dislike', true);
      articleDislikeBtn.onclick = function(e) {
        e.stopPropagation();
        if (!requireAuth()) return;
        const newData = getArticleData(article.link);
        if (newData.dislike) { newData.dislike = false; } else { newData.dislike = true; newData.like = false; }
        saveArticleData(article.link, newData);
        articleDislikeBtn.classList.toggle('active', !!newData.dislike);
        if (articleLikeBtn) articleLikeBtn.classList.toggle('active', !!newData.like);
        renderCurrentList();
      };
    }
    // Comments button in article modal
    const articleCommentsBtn = $('#article-modal-comments-btn');
    const articleCommentsCount = $('#article-modal-comments-count');
    if (articleCommentsBtn) {
      const commentCount = (ad.comments && ad.comments.length) || 0;
      if (articleCommentsCount) articleCommentsCount.textContent = commentCount;
      articleCommentsBtn.onclick = function(e) {
        e.stopPropagation();
        if (!requireAuth()) return;
        closeArticleModal();
        openCommentsPage(article);
      };
    }
    if (flagEl) {
      flagEl.value = ad.flag || '';
      flagEl.disabled = !currentUser;
      const flagHandler = function() {
        if (!requireAuth()) { flagEl.value = ad.flag || ''; return; }
        const newData = getArticleData(article.link);
        newData.flag = flagEl.value || '';
        saveArticleData(article.link, newData);
        renderCurrentList();
      };
      flagEl.onchange = flagHandler;
      flagEl.oninput = flagHandler;
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

  function enhanceImageUrl(url) {
    let u = url;
    u = u.replace(/[?&](w|width|size|h|height)=\d+/gi, '');
    u = u.replace(/[-_](\d+)x(\d+)(\.\w+)$/i, '$3');
    u = u.replace(/\?&$/, '').replace(/\?$/, '');
    return u !== url ? u : null;
  }

  async function fetchOGImage(articleUrl) {
    try {
      const proxy = 'https://api.allorigins.win/raw?url=';
      const resp = await fetch(proxy + encodeURIComponent(articleUrl));
      if (!resp.ok) return null;
      const html = await resp.text();
      const m = html.match(/<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/i)
            || html.match(/<meta\s+content=["']([^"']+)["']\s+property=["']og:image["']/i);
      return m ? m[1] : null;
    } catch { return null; }
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.crossOrigin = 'anonymous';
      img.src = src;
    });
  }

  function wrapText(ctx, text, x, y, maxWidth, lineHeight) {
    const lines = [];
    const words = text.split(' ');
    let line = '';
    for (const word of words) {
      const test = line ? line + ' ' + word : word;
      if (ctx.measureText(test).width > maxWidth && line) {
        lines.push(line);
        line = word;
      } else {
        line = test;
      }
    }
    if (line) lines.push(line);
    for (let i = 0; i < lines.length; i++) {
      ctx.fillText(lines[i], x, y + i * lineHeight);
    }
    return lines.length;
  }

  async function imageToDataUrl(url) {
    try {
      const resp = await fetch(url, { mode: 'cors' });
      if (!resp.ok) return null;
      const blob = await resp.blob();
      return new Promise(r => {
        const fr = new FileReader();
        fr.onload = () => r(fr.result);
        fr.onerror = () => r(null);
        fr.readAsDataURL(blob);
      });
    } catch { return null; }
  }

  async function loadImageWithFallback(url) {
    try {
      const resp = await fetch(url, { mode: 'cors' });
      if (resp.ok) {
        const blob = await resp.blob();
        const dataUrl = await new Promise(r => {
          const fr = new FileReader();
          fr.onload = () => r(fr.result);
          fr.readAsDataURL(blob);
        });
        const img = await loadImage(dataUrl);
        if (img) return img;
      }
    } catch {}
    try {
      const proxyUrl = 'https://corsproxy.io/?url=' + encodeURIComponent(url);
      const resp = await fetch(proxyUrl);
      if (resp.ok) {
        const blob = await resp.blob();
        const dataUrl = await new Promise(r => {
          const fr = new FileReader();
          fr.onload = () => r(fr.result);
          fr.readAsDataURL(blob);
        });
        const img = await loadImage(dataUrl);
        if (img) return img;
      }
    } catch {}
    return null;
  }

  async function handleShareImage(article, btn) {
    btn && btn.classList.add('btn-busy');
    try {
      const hasThumb = article.imageUrl && article.imageUrl.startsWith('http');
      const fullSummary = stripHtml(article.summary);
      const titleColor = TITLE_COLORS[Math.floor(Math.random() * TITLE_COLORS.length)];

      let img = null;
      let imgW = 0, imgH = 0;
      if (hasThumb) {
        try {
          let finalUrl = await fetchOGImage(article.link);
          if (!finalUrl) {
            const enhanced = enhanceImageUrl(article.imageUrl);
            finalUrl = enhanced || article.imageUrl;
          }
          const loaded = await loadImageWithFallback(finalUrl);
          if (loaded) { img = loaded; imgW = img.naturalWidth; imgH = img.naturalHeight; }
        } catch { img = null; }
      }

      const hasImg = img && imgW > 0;
      // Cap DPR at 2 so the PNG doesn't get too large for mobile share sheets (3× devices
      // would otherwise produce a 3240px+ file that many share targets reject)
      const dpr = Math.min(Math.max(window.devicePixelRatio || 1, 1), 2);

      // Canvas: 4:5 portrait, 1080 wide. Height grows to fit content but is at least 1350.
      const W = 1080;
      const PAD = Math.round(W * 0.05);
      const gap = Math.round(W * 0.04);
      const titleFontSize = Math.round(W * 0.052);
      const bodyFontSize = Math.round(W * 0.028);
      const sourceFontSize = Math.round(W * 0.022);
      const smallFontSize = Math.round(W * 0.02);
      const titleLineH = Math.round(titleFontSize * 1.28);
      const bodyLineH = Math.round(bodyFontSize * 1.5);
      const textW = W - PAD * 2;

      // Image area: max 55% of the minimum canvas height
      const imgMaxAreaH = Math.round(1350 * 0.55);
      const imgPad = Math.round(W * 0.04);
      const imgBorder = 2;

      const c = document.createElement('canvas');
      c.width = W * dpr;
      const ctx = c.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.scale(dpr, dpr);

      // Measure title and full summary
      ctx.font = 'bold ' + titleFontSize + 'px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, sans-serif';
      const titleLines = wrapText(ctx, article.title || '', 0, 0, textW, titleLineH);
      ctx.font = bodyFontSize + 'px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, sans-serif';
      const summaryLines = fullSummary ? wrapText(ctx, fullSummary, 0, 0, textW, bodyLineH) : 0;

      // Text block height: source + gap + title + gap + summary + gap + divider + gap + watermark
      const titleH = titleLines * titleLineH;
      const summaryH = summaryLines * bodyLineH;
      const sourceH = article.source ? sourceFontSize : 0;
      const dividerH = Math.max(1, Math.round(W * 0.002));
      const smallGap = Math.round(W * 0.02);
      const medGap = Math.round(W * 0.03);

      const textBlockH = sourceH
        + (sourceH ? medGap : 0)
        + titleH
        + medGap
        + (summaryH > 0 ? summaryH + medGap : 0)
        + dividerH
        + smallGap
        + smallFontSize;

      // Image dimensions — always scale to fill the canvas width (constrained by maxH).
      // This ensures the image is prominent in the share regardless of source resolution.
      // High-res sources are downscaled with high-quality smoothing; low-res sources are
      // upscaled to fill the width (accepting some softness for very small thumbnails).
      let imgDrawW = 0, imgDrawH = 0;
      let imgBlockH = 0;
      // Header area above the image for the IB block (only when image is present)
      const ibHeaderH = hasImg ? Math.round(W * 0.08) : 0;
      if (hasImg) {
        const maxW = W - PAD * 2;
        const maxH = imgMaxAreaH - imgPad - ibHeaderH;
        const scale = Math.min(maxW / imgW, maxH / imgH);
        imgDrawW = Math.round(imgW * scale);
        imgDrawH = Math.round(imgH * scale);
        imgBlockH = ibHeaderH + imgDrawH + imgPad;
      }

      // Total content height
      const totalContentH = hasImg ? (imgBlockH + gap + textBlockH) : textBlockH;
      // Canvas height: at least 1350 (4:5), more if content is taller
      const H = Math.max(1350, totalContentH + Math.round(W * 0.08));
      c.height = H * dpr;
      ctx.scale(dpr, dpr);
      ctx.imageSmoothingQuality = 'high';
      // Vertical centering offset
      const topOffset = Math.round((H - totalContentH) / 2);

      // Draw background — pure black
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, W, H);

      let cursorY = topOffset;

      // Image (if any) — top/bottom/left/right gradient fade to black, like card view
      let imageTopY = 0;
      if (hasImg) {
        const drawX = Math.round((W - imgDrawW) / 2);
        const drawY = cursorY + ibHeaderH;
        imageTopY = drawY;
        const imgRadius = Math.round(W * 0.025);

        // Clip to rounded rect so the image has soft corners
        ctx.save();
        roundRect(ctx, drawX, drawY, imgDrawW, imgDrawH, imgRadius);
        ctx.clip();

        // Multi-pass downscale for sharper output when source is much larger than target.
        if (imgW > imgDrawW * 2) {
          let curW = imgW, curH = imgH;
          let curSrc = img;
          while (curW > imgDrawW * 2) {
            const nextW = Math.max(imgDrawW, Math.floor(curW / 2));
            const nextH = Math.max(Math.round(curH * nextW / curW), 1);
            const off = document.createElement('canvas');
            off.width = nextW; off.height = nextH;
            const octx = off.getContext('2d');
            octx.imageSmoothingEnabled = true;
            octx.imageSmoothingQuality = 'high';
            octx.drawImage(curSrc, 0, 0, nextW, nextH);
            curSrc = off;
            curW = nextW; curH = nextH;
          }
          ctx.drawImage(curSrc, drawX, drawY, imgDrawW, imgDrawH);
        } else {
          ctx.drawImage(img, drawX, drawY, imgDrawW, imgDrawH);
        }

        // Top fade: black → transparent
        const fadeH = Math.round(imgDrawH * 0.2);
        const topGrad = ctx.createLinearGradient(0, drawY, 0, drawY + fadeH);
        topGrad.addColorStop(0, 'rgba(0,0,0,0.85)');
        topGrad.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = topGrad;
        ctx.fillRect(drawX, drawY, imgDrawW, fadeH);
        // Bottom fade: transparent → black
        const botGrad = ctx.createLinearGradient(0, drawY + imgDrawH - fadeH, 0, drawY + imgDrawH);
        botGrad.addColorStop(0, 'rgba(0,0,0,0)');
        botGrad.addColorStop(1, 'rgba(0,0,0,0.85)');
        ctx.fillStyle = botGrad;
        ctx.fillRect(drawX, drawY + imgDrawH - fadeH, imgDrawW, fadeH);
        // Left fade: black → transparent (increased to 18% width, 0.85 alpha)
        const fadeW = Math.round(imgDrawW * 0.18);
        const leftGrad = ctx.createLinearGradient(drawX, 0, drawX + fadeW, 0);
        leftGrad.addColorStop(0, 'rgba(0,0,0,0.85)');
        leftGrad.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = leftGrad;
        ctx.fillRect(drawX, drawY, fadeW, imgDrawH);
        // Right fade: transparent → black
        const rightGrad = ctx.createLinearGradient(drawX + imgDrawW - fadeW, 0, drawX + imgDrawW, 0);
        rightGrad.addColorStop(0, 'rgba(0,0,0,0)');
        rightGrad.addColorStop(1, 'rgba(0,0,0,0.85)');
        ctx.fillStyle = rightGrad;
        ctx.fillRect(drawX + imgDrawW - fadeW, drawY, fadeW, imgDrawH);

        // IB logo block — inside the image, top-right, equal gap from top and right edges
        const logoS = Math.round(W * 0.07);
        const logoR = Math.round(W * 0.014);
        const ibGap = Math.round(W * 0.025);
        const logoX = drawX + imgDrawW - ibGap - logoS;
        const logoY = drawY + ibGap;
        ctx.fillStyle = '#ff2929';
        roundRect(ctx, logoX, logoY, logoS, logoS, logoR);
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.font = 'bold ' + Math.round(W * 0.032) + 'px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('IB', logoX + logoS / 2, logoY + logoS / 2);
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';

        ctx.restore(); // remove rounded clip
        cursorY += imgBlockH + gap;
      }

      // Source label (no date, no ranking) — uppercase, red
      if (article.source) {
        ctx.fillStyle = '#ff2929';
        ctx.font = '700 ' + sourceFontSize + 'px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, sans-serif';
        ctx.textBaseline = 'alphabetic';
        ctx.fillText(article.source.toUpperCase(), PAD, cursorY + sourceFontSize);
        cursorY += sourceFontSize + medGap;
      }

      // Title
      ctx.fillStyle = titleColor;
      ctx.font = 'bold ' + titleFontSize + 'px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, sans-serif';
      ctx.textBaseline = 'alphabetic';
      wrapText(ctx, article.title || '', PAD, cursorY + titleLineH, textW, titleLineH);
      cursorY += titleH + medGap;

      // Full summary
      if (fullSummary) {
        ctx.fillStyle = 'rgba(255,255,255,0.78)';
        ctx.font = bodyFontSize + 'px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, sans-serif';
        ctx.textBaseline = 'alphabetic';
        wrapText(ctx, fullSummary, PAD, cursorY + bodyLineH, textW, bodyLineH);
        cursorY += summaryH + medGap;
      }

      // Thin divider line above the watermark
      ctx.fillStyle = 'rgba(255,255,255,0.1)';
      ctx.fillRect(PAD, cursorY, textW, dividerH);
      cursorY += dividerH + smallGap;

      // Footer: INVISIBLE BROADCAST watermark
      ctx.fillStyle = 'rgba(255,255,255,0.32)';
      ctx.font = '700 ' + smallFontSize + 'px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText('INVISIBLE BROADCAST', PAD, cursorY + smallFontSize);

      const blob = await new Promise(r => c.toBlob(r, 'image/png'));
      if (!blob) { btn && btn.classList.remove('btn-busy'); handleShare(article.link, article.title, article.source); return; }

      const file = new File([blob], 'invisible-broadcast.png', { type: 'image/png' });
      // Always try native share first if available (don't gate on canShare — some mobile browsers
      // report canShare=false for files even though share() works fine)
      if (navigator.share) {
        try {
          await navigator.share({ files: [file], title: article.title });
          btn && btn.classList.remove('btn-busy');
          return;
        } catch (err) {
          if (err && err.name === 'AbortError') { btn && btn.classList.remove('btn-busy'); return; }
          // Any other error (NotAllowedError, etc.) — fall through to clipboard
        }
      }
      try {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      } catch {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'invisible-broadcast.png';
        a.click();
        URL.revokeObjectURL(a.href);
      }
      btn && btn.classList.remove('btn-busy');
    } catch (err) {
      btn && btn.classList.remove('btn-busy');
      console.warn('Image share failed:', err.message);
      handleShare(article.link, article.title, article.source);
    }
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  function exitFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else if (document.webkitFullscreenElement) document.webkitExitFullscreen();
  }

  function toggleFullscreen() {
    if (document.fullscreenElement || document.webkitFullscreenElement) {
      if (document.exitFullscreen) document.exitFullscreen().catch(err => console.warn('Exit fullscreen failed:', err.message));
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
      if (e.target.closest('.reels-container')) return;
      const se = e.target.closest('.card-share-btn');
      if (se) {
        e.stopPropagation();
        const url = decodeURIComponent(se.dataset.url);
        const article = findArticleByLink(url);
        if (article && article.imageUrl && article.imageUrl.startsWith('http')) {
          handleShareImage(article, se);
        } else {
          handleShare(url, se.dataset.title, se.dataset.source);
        }
        return;
      }
      // Card like button
      const likeBtn = e.target.closest('.card-like-btn');
      if (likeBtn) {
        e.stopPropagation();
        if (!requireAuth()) return;
        const url = decodeURIComponent(likeBtn.dataset.article);
        const article = findArticleByLink(url);
        if (!article) return;
        const ad = getArticleData(url);
        if (ad.like) { ad.like = false; ad.likeCount = Math.max(0, (ad.likeCount || 1) - 1); }
        else { ad.like = true; ad.dislike = false; ad.dislikeCount = Math.max(0, (ad.dislikeCount || 0)); ad.likeCount = (ad.likeCount || 0) + 1; }
        saveArticleData(url, ad);
        likeBtn.classList.toggle('active', !!ad.like);
        likeBtn.classList.toggle('like', true);
        const countEl = likeBtn.querySelector('.card-action-count');
        if (countEl) countEl.textContent = ad.likeCount || 0;
        // Update dislike button if it was active
        const dislikeBtn = likeBtn.parentElement.querySelector('.card-dislike-btn');
        if (dislikeBtn) { dislikeBtn.classList.toggle('active', !!ad.dislike); const dc = dislikeBtn.querySelector('.card-action-count'); if (dc) dc.textContent = ad.dislikeCount || 0; }
        renderCurrentList();
        return;
      }
      // Card dislike button
      const dislikeBtn = e.target.closest('.card-dislike-btn');
      if (dislikeBtn) {
        e.stopPropagation();
        if (!requireAuth()) return;
        const url = decodeURIComponent(dislikeBtn.dataset.article);
        const article = findArticleByLink(url);
        if (!article) return;
        const ad = getArticleData(url);
        if (ad.dislike) { ad.dislike = false; ad.dislikeCount = Math.max(0, (ad.dislikeCount || 1) - 1); }
        else { ad.dislike = true; ad.like = false; ad.likeCount = Math.max(0, (ad.likeCount || 0)); ad.dislikeCount = (ad.dislikeCount || 0) + 1; }
        saveArticleData(url, ad);
        dislikeBtn.classList.toggle('active', !!ad.dislike);
        dislikeBtn.classList.toggle('dislike', true);
        const countEl = dislikeBtn.querySelector('.card-action-count');
        if (countEl) countEl.textContent = ad.dislikeCount || 0;
        // Update like button if it was active
        const likeBtn = dislikeBtn.parentElement.querySelector('.card-like-btn');
        if (likeBtn) { likeBtn.classList.toggle('active', !!ad.like); const lc = likeBtn.querySelector('.card-action-count'); if (lc) lc.textContent = ad.likeCount || 0; }
        renderCurrentList();
        return;
      }
      // Card comment button — open comments page
      const commentBtn = e.target.closest('.card-comment-btn');
      if (commentBtn) {
        e.stopPropagation();
        if (!requireAuth()) return;
        const url = decodeURIComponent(commentBtn.dataset.article);
        const article = findArticleByLink(url);
        if (article) openCommentsPage(article);
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
        if (el.hardRefreshModal && el.hardRefreshModal.classList.contains('open')) closeHardRefreshModal();
        else if (el.sourceModal.classList.contains('open')) closeSourceModal();
        else if (el.articleModal.classList.contains('open')) closeArticleModal();
        else if (el.modal.classList.contains('open')) closeSettings();
      }
    });
  }

  /* ── Auth ── */
  let currentUser = null;
  let authMode = 'signin'; // 'signin' or 'signup'
  let authBusy = false;

  function requireAuth() {
    if (currentUser) return true;
    // Exit fullscreen so auth modal is visible
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    openAuthModal();
    return false;
  }

  function setAuthMode(mode) {
    authMode = mode;
    const title = $('#auth-modal-title');
    if (title) title.textContent = mode === 'signin' ? 'Sign In' : 'Sign Up';
    const submitText = document.querySelector('.auth-submit-text');
    if (submitText) submitText.textContent = mode === 'signin' ? 'Sign In' : 'Sign Up';
    const nameField = $('#auth-name-field');
    if (nameField) nameField.style.display = mode === 'signup' ? 'block' : 'none';
    const repeatField = $('#auth-repeat-field');
    if (repeatField) repeatField.style.display = mode === 'signup' ? 'block' : 'none';
    $$('.auth-mode-tab').forEach(t => t.classList.toggle('active', t.dataset.authtab === mode));
    // Clear name, password, and repeat password fields when switching tabs (keep email)
    const nameInput = $('#auth-name');
    if (nameInput) nameInput.value = '';
    const pwdInput = $('#auth-password');
    if (pwdInput) pwdInput.value = '';
    const pwdRepeatInput = $('#auth-password-repeat');
    if (pwdRepeatInput) pwdRepeatInput.value = '';
    showAuthMsg('');
    clearInputErrors();
  }

  function updateAuthUI(user) {
    currentUser = user;
    const btn = $('#auth-btn');
    const userDiv = $('#auth-user');
    const avatar = $('#auth-avatar');
    const dropdownName = $('#auth-dropdown-name');
    const dropdownEmail = $('#auth-dropdown-email');
    if (user) {
      if (btn) btn.style.display = 'none';
      if (userDiv) userDiv.style.display = 'inline-flex';
      if (avatar) {
        if (user.user_metadata?.avatar_url) {
          avatar.src = user.user_metadata.avatar_url;
        } else {
          avatar.removeAttribute('src');
        }
      }
      if (dropdownName) dropdownName.textContent = user.user_metadata?.full_name || 'User';
      if (dropdownEmail) dropdownEmail.textContent = user.email || '';
    } else {
      if (btn) btn.style.display = '';
      if (userDiv) userDiv.style.display = 'none';
      if (avatar) avatar.removeAttribute('src');
      // Close dropdown if open
      const dropdown = $('#auth-dropdown');
      if (dropdown) dropdown.style.display = 'none';
    }
  }

  async function handleAuthChange(event, session) {
    if (session) {
      updateAuthUI(session.user);
      await SupabaseStore.load();
    } else {
      updateAuthUI(null);
    }
  }

  function setAuthBusy(busy) {
    authBusy = busy;
    const submitBtn = $('#auth-submit-btn');
    const text = document.querySelector('.auth-submit-text');
    const spinner = document.querySelector('.auth-submit-spinner');
    if (submitBtn) submitBtn.disabled = busy;
    if (text) text.style.opacity = busy ? '0' : '1';
    if (spinner) spinner.style.display = busy ? 'inline-block' : 'none';
  }

  function clearInputErrors() {
    $$('#auth-form-fields input').forEach(i => i.classList.remove('auth-form-input-error'));
  }

  function markInputError(id) {
    const el = document.getElementById(id);
    if (el) el.classList.add('auth-form-input-error');
  }

  function isValidEmail(email) {
    // Pragmatic email regex — covers common cases without being overly strict
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  }

  function showAuthMsg(msg, type) {
    const el2 = $('#auth-msg');
    if (!el2) return;
    el2.textContent = msg;
    el2.classList.remove('error', 'success');
    if (type) el2.classList.add(type);
  }

  function withTimeout(promise, ms, label) {
    return Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s. Please check your connection and try again.`)), ms))
    ]);
  }

  async function signInWithEmail(email, password) {
    setAuthBusy(true);
    showAuthMsg('', null);
    clearInputErrors();
    try {
      const { data, error } = await withTimeout(
        SupabaseStore.getClient().auth.signInWithPassword({ email, password }),
        20000,
        'Sign-in'
      );
      if (error) {
        showAuthMsg(error.message, 'error');
        markInputError('auth-password');
        console.warn('Auth sign-in error:', error);
        return;
      }
      // Success — show confirmation, then close
      showAuthMsg('Signed in successfully!', 'success');
      setTimeout(() => {
        closeAuthModal();
        showAuthMsg('', null);
      }, 600);
    } catch (err) {
      console.error('Sign-in failed:', err);
      showAuthMsg(err.message || 'Sign-in failed. Please try again.', 'error');
      markInputError('auth-password');
    } finally {
      setAuthBusy(false);
    }
  }

  async function signUpWithEmail(name, email, password) {
    console.log('[Auth] signUpWithEmail started for:', email);
    setAuthBusy(true);
    showAuthMsg('Connecting to server...', null);
    clearInputErrors();
    try {
      // Verify Supabase client is available
      const client = SupabaseStore.getClient();
      if (!client) {
        throw new Error('Auth service is not available. Please refresh the page and try again.');
      }
      console.log('[Auth] Supabase client available, calling signUp...');
      const { data, error } = await withTimeout(
        client.auth.signUp({
          email, password,
          options: {
            data: { full_name: name },
            emailRedirectTo: window.location.origin
          }
        }),
        20000,
        'Sign-up'
      );
      console.log('[Auth] signUp response:', { hasSession: !!data?.session, hasUser: !!data?.user, error });
      if (error) {
        showAuthMsg(error.message, 'error');
        console.warn('[Auth] sign-up error:', error);
        return;
      }
      // Check if email confirmation is required (no session means confirmation needed)
      if (data?.session) {
        showAuthMsg('Account created and signed in!', 'success');
        setTimeout(() => {
          closeAuthModal();
          showAuthMsg('', null);
        }, 600);
      } else {
        showAuthMsg('Account created! Check your email (including spam) for a confirmation link, then sign in.', 'success');
        // Keep the modal open longer so the user can read the message
        setTimeout(() => {
          setAuthMode('signin');
          $('#auth-email').value = email;
          showAuthMsg('Account created. Please check your email and sign in.', 'success');
        }, 4000);
      }
    } catch (err) {
      console.error('[Auth] Sign-up failed:', err);
      showAuthMsg(err.message || 'Sign-up failed. Please try again.', 'error');
    } finally {
      setAuthBusy(false);
    }
  }

  async function signOut() {
    try {
      await SupabaseStore.getClient().auth.signOut();
    } catch (err) {
      console.warn('Sign-out failed:', err.message);
    }
  }

  function openAuthModal() {
    showAuthMsg('', null);
    setAuthMode('signin');
    $$('#auth-form-fields input').forEach(i => i.value = '');
    clearInputErrors();
    const modal = $('#auth-modal');
    if (modal) modal.classList.add('open');
    // Focus first field after a short delay so the modal animation completes
    setTimeout(() => { $('#auth-email')?.focus(); }, 100);
    // Verify auth service is available
    try {
      const client = SupabaseStore.getClient();
      if (!client) {
        showAuthMsg('Auth service unavailable. Please refresh the page.', 'error');
      }
    } catch (err) {
      console.error('[Auth] Failed to get Supabase client:', err);
      showAuthMsg('Auth service error. Please refresh the page.', 'error');
    }
  }

  function closeAuthModal() {
    const modal = $('#auth-modal');
    if (modal) modal.classList.remove('open');
    setTimeout(() => {
      showAuthMsg('', null);
      clearInputErrors();
    }, 200);
  }

  function handleAuthSubmit() {
    console.log('[Auth] handleAuthSubmit called, authMode =', authMode, 'authBusy =', authBusy);
    if (authBusy) return;
    clearInputErrors();

    if (authMode === 'signin') {
      const email = $('#auth-email')?.value?.trim() || '';
      const pwd = $('#auth-password')?.value || '';
      if (!email) { showAuthMsg('Please enter your email.', 'error'); markInputError('auth-email'); console.warn('[Auth] Sign-in: missing email'); return; }
      if (!pwd) { showAuthMsg('Please enter your password.', 'error'); markInputError('auth-password'); console.warn('[Auth] Sign-in: missing password'); return; }
      if (!isValidEmail(email)) { showAuthMsg('Please enter a valid email address.', 'error'); markInputError('auth-email'); console.warn('[Auth] Sign-in: invalid email format:', email); return; }
      console.log('[Auth] Sign-in: calling signInWithEmail');
      signInWithEmail(email, pwd);
    } else {
      const name = $('#auth-name')?.value?.trim() || '';
      const email = $('#auth-email')?.value?.trim() || '';
      const pwd = $('#auth-password')?.value || '';
      const pwd2 = $('#auth-password-repeat')?.value || '';
      console.log('[Auth] Sign-up attempt:', { name, email, pwdLength: pwd?.length, hasRepeat: !!pwd2 });
      if (!name || name.length < 2) { showAuthMsg('Please enter your name (at least 2 characters).', 'error'); markInputError('auth-name'); return; }
      if (!email) { showAuthMsg('Please enter your email.', 'error'); markInputError('auth-email'); return; }
      if (!isValidEmail(email)) { showAuthMsg('Please enter a valid email address.', 'error'); markInputError('auth-email'); return; }
      if (!pwd) { showAuthMsg('Please enter a password.', 'error'); markInputError('auth-password'); return; }
      if (pwd.length < 6) { showAuthMsg('Password must be at least 6 characters.', 'error'); markInputError('auth-password'); return; }
      if (!pwd2) { showAuthMsg('Please repeat your password.', 'error'); markInputError('auth-password-repeat'); return; }
      if (pwd !== pwd2) { showAuthMsg('Passwords do not match.', 'error'); markInputError('auth-password-repeat'); return; }
      console.log('[Auth] Sign-up: calling signUpWithEmail');
      signUpWithEmail(name, email, pwd);
    }
  }

  // Dropdown toggle
  function toggleAuthDropdown(force) {
    const dropdown = $('#auth-dropdown');
    if (!dropdown) return;
    const isOpen = dropdown.style.display !== 'none';
    const shouldOpen = force === undefined ? !isOpen : force;
    dropdown.style.display = shouldOpen ? 'block' : 'none';
  }
  function closeAuthDropdown() {
    const dropdown = $('#auth-dropdown');
    if (dropdown) dropdown.style.display = 'none';
  }

  // Change Name
  function openChangeNameModal() {
    closeAuthDropdown();
    const input = $('#change-name-input');
    if (input && currentUser) {
      input.value = currentUser.user_metadata?.full_name || '';
    }
    const msg = $('#change-name-msg');
    if (msg) { msg.textContent = ''; msg.classList.remove('error', 'success'); }
    const modal = $('#change-name-modal');
    if (modal) modal.classList.add('open');
    setTimeout(() => input?.focus(), 100);
  }
  function closeChangeNameModal() {
    const modal = $('#change-name-modal');
    if (modal) modal.classList.remove('open');
  }

  async function handleChangeName() {
    const input = $('#change-name-input');
    const msg = $('#change-name-msg');
    const name = input?.value?.trim() || '';
    if (!name || name.length < 2) {
      if (msg) { msg.textContent = 'Please enter a name (at least 2 characters).'; msg.classList.add('error'); msg.classList.remove('success'); }
      return;
    }
    if (msg) { msg.textContent = 'Updating...'; msg.classList.remove('error', 'success'); }
    try {
      const { data, error } = await withTimeout(
        SupabaseStore.getClient().auth.updateUser({ data: { full_name: name } }),
        15000,
        'Update name'
      );
      if (error) {
        if (msg) { msg.textContent = error.message; msg.classList.add('error'); msg.classList.remove('success'); }
        console.warn('[Auth] update name error:', error);
        return;
      }
      if (msg) { msg.textContent = 'Name updated!'; msg.classList.add('success'); msg.classList.remove('error'); }
      // Refresh current user
      const { data: fresh } = await SupabaseStore.getClient().auth.getUser();
      if (fresh?.user) currentUser = fresh.user;
      updateAuthUI(currentUser);
      setTimeout(() => closeChangeNameModal(), 800);
    } catch (err) {
      console.error('[Auth] Update name failed:', err);
      if (msg) { msg.textContent = err.message || 'Update failed.'; msg.classList.add('error'); msg.classList.remove('success'); }
    }
  }

  // Change Password
  function openChangePasswordModal() {
    closeAuthDropdown();
    const ids = ['change-password-current', 'change-password-new', 'change-password-repeat'];
    ids.forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
    const msg = $('#change-password-msg');
    if (msg) { msg.textContent = ''; msg.classList.remove('error', 'success'); }
    const modal = $('#change-password-modal');
    if (modal) modal.classList.add('open');
    setTimeout(() => document.getElementById('change-password-current')?.focus(), 100);
  }
  function closeChangePasswordModal() {
    const modal = $('#change-password-modal');
    if (modal) modal.classList.remove('open');
  }

  async function handleChangePassword() {
    const current = document.getElementById('change-password-current')?.value || '';
    const newPwd = document.getElementById('change-password-new')?.value || '';
    const repeatPwd = document.getElementById('change-password-repeat')?.value || '';
    const msg = $('#change-password-msg');

    if (!current) { if (msg) { msg.textContent = 'Please enter your current password.'; msg.classList.add('error'); msg.classList.remove('success'); } return; }
    if (!newPwd) { if (msg) { msg.textContent = 'Please enter a new password.'; msg.classList.add('error'); msg.classList.remove('success'); } return; }
    if (newPwd.length < 6) { if (msg) { msg.textContent = 'New password must be at least 6 characters.'; msg.classList.add('error'); msg.classList.remove('success'); } return; }
    if (newPwd !== repeatPwd) { if (msg) { msg.textContent = 'New passwords do not match.'; msg.classList.add('error'); msg.classList.remove('success'); } return; }

    if (msg) { msg.textContent = 'Updating...'; msg.classList.remove('error', 'success'); }
    try {
      const { data, error } = await withTimeout(
        SupabaseStore.getClient().auth.updateUser({ password: newPwd }),
        15000,
        'Update password'
      );
      if (error) {
        if (msg) { msg.textContent = error.message; msg.classList.add('error'); msg.classList.remove('success'); }
        console.warn('[Auth] update password error:', error);
        return;
      }
      if (msg) { msg.textContent = 'Password updated!'; msg.classList.add('success'); msg.classList.remove('error'); }
      setTimeout(() => closeChangePasswordModal(), 800);
    } catch (err) {
      console.error('[Auth] Update password failed:', err);
      if (msg) { msg.textContent = err.message || 'Update failed.'; msg.classList.add('error'); msg.classList.remove('success'); }
    }
  }

  // Change Avatar
  let pendingAvatarFile = null;
  function openChangeAvatarModal() {
    closeAuthDropdown();
    pendingAvatarFile = null;
    const uploadBtn = $('#change-avatar-upload-btn');
    if (uploadBtn) uploadBtn.disabled = true;
    const msg = $('#change-avatar-msg');
    if (msg) { msg.textContent = ''; msg.classList.remove('error', 'success'); }
    // Show current avatar
    const preview = $('#change-avatar-preview');
    const fallback = $('#change-avatar-fallback');
    if (currentUser?.user_metadata?.avatar_url) {
      if (preview) { preview.src = currentUser.user_metadata.avatar_url; preview.style.display = 'block'; }
      if (fallback) fallback.style.display = 'none';
    } else {
      if (preview) { preview.removeAttribute('src'); preview.style.display = 'none'; }
      if (fallback) fallback.style.display = 'flex';
    }
    const modal = $('#change-avatar-modal');
    if (modal) modal.classList.add('open');
  }
  function closeChangeAvatarModal() {
    const modal = $('#change-avatar-modal');
    if (modal) modal.classList.remove('open');
    pendingAvatarFile = null;
  }

  function handleAvatarFileSelect(file) {
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      const msg = $('#change-avatar-msg');
      if (msg) { msg.textContent = 'Please choose an image file.'; msg.classList.add('error'); msg.classList.remove('success'); }
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      const msg = $('#change-avatar-msg');
      if (msg) { msg.textContent = 'Image must be under 5 MB.'; msg.classList.add('error'); msg.classList.remove('success'); }
      return;
    }
    pendingAvatarFile = file;
    // Show preview
    const reader = new FileReader();
    reader.onload = e => {
      const preview = $('#change-avatar-preview');
      const fallback = $('#change-avatar-fallback');
      if (preview) { preview.src = e.target.result; preview.style.display = 'block'; }
      if (fallback) fallback.style.display = 'none';
    };
    reader.readAsDataURL(file);
    const uploadBtn = $('#change-avatar-upload-btn');
    if (uploadBtn) uploadBtn.disabled = false;
  }

  async function handleAvatarUpload() {
    if (!pendingAvatarFile) return;
    const msg = $('#change-avatar-msg');
    if (msg) { msg.textContent = 'Uploading...'; msg.classList.remove('error', 'success'); }
    try {
      const client = SupabaseStore.getClient();
      const { data: userData } = await client.auth.getUser();
      const user = userData?.user;
      if (!user) throw new Error('Not signed in');
      const ext = pendingAvatarFile.name.split('.').pop() || 'png';
      const path = `${user.id}/avatar.${ext}`;
      // Upload to 'avatars' bucket (must exist in Supabase Storage)
      const { error: upErr } = await client.storage.from('avatars').upload(path, pendingAvatarFile, { upsert: true, contentType: pendingAvatarFile.type });
      if (upErr) {
        if (msg) { msg.textContent = 'Upload failed: ' + upErr.message; msg.classList.add('error'); msg.classList.remove('success'); }
        console.warn('[Auth] avatar upload error:', upErr);
        return;
      }
      // Get public URL
      const { data: pub } = client.storage.from('avatars').getPublicUrl(path);
      const publicUrl = pub?.publicUrl || '';
      if (!publicUrl) throw new Error('Could not get public URL');
      // Update user metadata
      const { error: metaErr } = await withTimeout(
        client.auth.updateUser({ data: { avatar_url: publicUrl } }),
        15000,
        'Update avatar'
      );
      if (metaErr) {
        if (msg) { msg.textContent = metaErr.message; msg.classList.add('error'); msg.classList.remove('success'); }
        return;
      }
      // Refresh current user
      const { data: fresh } = await client.auth.getUser();
      if (fresh?.user) currentUser = fresh.user;
      updateAuthUI(currentUser);
      if (msg) { msg.textContent = 'Avatar updated!'; msg.classList.add('success'); msg.classList.remove('error'); }
      setTimeout(() => closeChangeAvatarModal(), 800);
    } catch (err) {
      console.error('[Auth] Avatar upload failed:', err);
      if (msg) { msg.textContent = err.message || 'Upload failed.'; msg.classList.add('error'); msg.classList.remove('success'); }
    }
  }

  /* ── Comments Page ── */
  let commentsContextArticle = null; // article being viewed
  let commentsReplyToId = null; // comment id being replied to
  let commentsPendingDeleteId = null; // comment id pending deletion
  let commentsPreviousWasArticleModal = false; // was article modal open before comments?

  function openCommentsPage(article) {
    if (!article) return;
    commentsPreviousWasArticleModal = el.articleModal.classList.contains('open');
    commentsContextArticle = article;
    commentsReplyToId = null;
    // Comments page uses position:fixed with high z-index, so it works in fullscreen too
    if (el.commentsPage) el.commentsPage.style.display = 'flex';
    if (el.commentsInput) { el.commentsInput.value = ''; el.commentsInput.placeholder = 'Add a comment…'; }
    if (el.commentsPostBtn) el.commentsPostBtn.disabled = true;
    hideReplyPreview();
    renderCommentsList();
    setTimeout(() => el.commentsInput?.focus(), 200);
  }

  function closeCommentsPage() {
    if (el.commentsPage) el.commentsPage.style.display = 'none';
    commentsContextArticle = null;
    commentsReplyToId = null;
    hideReplyPreview();
    // Restore the article modal if it was open before comments
    if (commentsPreviousWasArticleModal) {
      commentsPreviousWasArticleModal = false;
      setTimeout(() => el.articleModal.classList.add('open'), 100);
    }
  }

  function showReplyPreview(commentText) {
    if (!el.commentsReplyPreview) return;
    const txt = commentText.length > 60 ? commentText.slice(0, 60) + '…' : commentText;
    if (el.commentsReplyText) el.commentsReplyText.textContent = 'Replying to: ' + txt;
    el.commentsReplyPreview.style.display = 'flex';
    if (el.commentsInput) el.commentsInput.placeholder = 'Write a reply…';
  }
  function hideReplyPreview() {
    if (el.commentsReplyPreview) el.commentsReplyPreview.style.display = 'none';
    if (el.commentsInput) el.commentsInput.placeholder = 'Add a comment…';
  }

  function renderCommentsList() {
    if (!commentsContextArticle || !el.commentsList) return;
    const ad = getArticleData(commentsContextArticle.link);
    const comments = (ad.comments && Array.isArray(ad.comments)) ? ad.comments : [];
    if (comments.length === 0) {
      el.commentsList.innerHTML = '<div class="comments-empty">No comments yet. Be the first!</div>';
      return;
    }
    // Build threads: top-level comments with nested replies
    const topLevel = comments.filter(c => !c.parentId);
    let html = '';
    topLevel.forEach(c => {
      html += renderCommentItem(c, comments);
    });
    el.commentsList.innerHTML = html;
  }

  function renderCommentItem(comment, allComments) {
    const replies = allComments.filter(c => c.parentId === comment.id);
    const isMine = currentUser && comment.userId === currentUser.id;
    const timeAgo = formatTimeAgo(comment.timestamp);
    const initial = (comment.author || '?').charAt(0).toUpperCase();
    let html = '<div class="comment-item" data-comment-id="' + comment.id + '">' +
      '<div class="comment-avatar">' + escHtml(initial) + '</div>' +
      '<div class="comment-body">' +
        '<div class="comment-author">' + escHtml(comment.author || 'Anonymous') + '</div>' +
        '<div class="comment-text">' + escHtml(comment.text) + '</div>' +
        '<div class="comment-meta">' +
          '<span class="comment-time">' + timeAgo + '</span>' +
          '<button class="comment-action-btn comment-reply-btn" data-comment-id="' + comment.id + '">Reply</button>' +
          (isMine ? '<button class="comment-action-btn danger comment-delete-btn" data-comment-id="' + comment.id + '">Delete</button>' : '') +
        '</div>' +
      '</div>' +
    '</div>';
    if (replies.length > 0) {
      html += '<div class="comment-replies">';
      replies.forEach(r => {
        const rInitial = (r.author || '?').charAt(0).toUpperCase();
        const rMine = currentUser && r.userId === currentUser.id;
        const rTime = formatTimeAgo(r.timestamp);
        html += '<div class="comment-reply" data-comment-id="' + r.id + '">' +
          '<div class="comment-avatar">' + escHtml(rInitial) + '</div>' +
          '<div class="comment-body">' +
            '<div class="comment-author">' + escHtml(r.author || 'Anonymous') + '</div>' +
            '<div class="comment-text">' + escHtml(r.text) + '</div>' +
            '<div class="comment-meta">' +
              '<span class="comment-time">' + rTime + '</span>' +
              '<button class="comment-action-btn comment-reply-btn" data-comment-id="' + r.id + '">Reply</button>' +
              (rMine ? '<button class="comment-action-btn danger comment-delete-btn" data-comment-id="' + r.id + '">Delete</button>' : '') +
            '</div>' +
          '</div>' +
        '</div>';
      });
      html += '</div>';
    }
    return html;
  }

  function formatTimeAgo(ts) {
    if (!ts) return '';
    const now = Date.now();
    const diff = now - ts;
    if (diff < 60000) return 'Just now';
    if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
    if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
    if (diff < 604800000) return Math.floor(diff / 86400000) + 'd ago';
    return new Date(ts).toLocaleDateString();
  }

  function postComment() {
    if (!commentsContextArticle) return;
    const text = el.commentsInput?.value?.trim();
    if (!text) return;
    if (!requireAuth()) return;
    const ad = getArticleData(commentsContextArticle.link);
    if (!ad.comments) ad.comments = [];
    const comment = {
      id: 'c_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
      text: text,
      author: currentUser?.user_metadata?.full_name || currentUser?.email?.split('@')[0] || 'User',
      userId: currentUser?.id || '',
      timestamp: Date.now(),
      parentId: commentsReplyToId || null
    };
    ad.comments.push(comment);
    saveArticleData(commentsContextArticle.link, ad);
    if (el.commentsInput) el.commentsInput.value = '';
    if (el.commentsPostBtn) el.commentsPostBtn.disabled = true;
    commentsReplyToId = null;
    hideReplyPreview();
    renderCommentsList();
    // Update article modal comment count
    const countEl = $('#article-modal-comments-count');
    if (countEl) countEl.textContent = (ad.comments && ad.comments.length) || 0;
    // Update card comment count
    updateCardCommentCount(commentsContextArticle.link, (ad.comments && ad.comments.length) || 0);
    // Scroll to bottom
    if (el.commentsList) el.commentsList.scrollTop = el.commentsList.scrollHeight;
  }

  function updateCardCommentCount(link, count) {
    const card = el.main.querySelector(`.card-comment-btn[data-article="${encodeURIComponent(link)}"] .card-action-count`);
    if (card) card.textContent = count;
  }

  function setReplyTo(commentId) {
    if (!commentsContextArticle) return;
    const ad = getArticleData(commentsContextArticle.link);
    const comments = ad.comments || [];
    const c = comments.find(x => x.id === commentId);
    if (!c) return;
    commentsReplyToId = commentId;
    showReplyPreview(c.text);
    el.commentsInput?.focus();
  }

  function confirmDeleteComment(commentId) {
    commentsPendingDeleteId = commentId;
    if (el.deleteCommentModal) el.deleteCommentModal.classList.add('open');
  }

  function doDeleteComment() {
    if (!commentsPendingDeleteId || !commentsContextArticle) return;
    const ad = getArticleData(commentsContextArticle.link);
    if (ad.comments) {
      // Remove the comment and all its replies
      ad.comments = ad.comments.filter(c => c.id !== commentsPendingDeleteId && c.parentId !== commentsPendingDeleteId);
      saveArticleData(commentsContextArticle.link, ad);
    }
    commentsPendingDeleteId = null;
    if (el.deleteCommentModal) el.deleteCommentModal.classList.remove('open');
    renderCommentsList();
    // Update counts
    const newCount = (ad.comments && ad.comments.length) || 0;
    const countEl = $('#article-modal-comments-count');
    if (countEl) countEl.textContent = newCount;
    updateCardCommentCount(commentsContextArticle.link, newCount);
  }

  function bindAuth() {
    const client = SupabaseStore.getClient();

    client.auth.getSession().then(({ data }) => {
      handleAuthChange(null, data.session);
    });

    client.auth.onAuthStateChange((event, session) => {
      handleAuthChange(event, session);
    });

    const authBtn = $('#auth-btn');
    if (authBtn) authBtn.addEventListener('click', openAuthModal);
    const authClose = $('#auth-modal-close');
    if (authClose) authClose.addEventListener('click', closeAuthModal);
    const authModal = $('#auth-modal');
    if (authModal) authModal.addEventListener('click', e => { if (e.target === authModal) closeAuthModal(); });

    // Tab switching via delegation
    document.addEventListener('click', e => {
      const tab = e.target.closest('.auth-mode-tab');
      if (tab && authModal?.classList.contains('open')) setAuthMode(tab.dataset.authtab);
    });

    // Form submit (Enter key or button click)
    const authForm = $('#auth-form-fields');
    if (authForm) {
      authForm.addEventListener('submit', e => {
        e.preventDefault();
        handleAuthSubmit();
      });
    }

    // Direct click on submit button (fallback in case form submit doesn't fire)
    const submitBtn = $('#auth-submit-btn');
    if (submitBtn) {
      submitBtn.addEventListener('click', e => {
        e.preventDefault();
        handleAuthSubmit();
      });
    }

    // Clear error styling when user starts typing
    $$('#auth-form-fields input').forEach(input => {
      input.addEventListener('input', () => {
        input.classList.remove('auth-form-input-error');
      });
    });

    // Avatar button toggle dropdown
    const avatarBtn = $('#auth-avatar-btn');
    if (avatarBtn) avatarBtn.addEventListener('click', e => { e.stopPropagation(); toggleAuthDropdown(); });
    // Close dropdown when clicking outside
    document.addEventListener('click', e => {
      const dropdown = $('#auth-dropdown');
      if (dropdown && dropdown.style.display !== 'none' && !e.target.closest('.auth-user')) {
        closeAuthDropdown();
      }
    });

    // Dropdown items
    const changeAvatarBtn = $('#auth-change-avatar-btn');
    if (changeAvatarBtn) changeAvatarBtn.addEventListener('click', openChangeAvatarModal);
    const changeNameBtn = $('#auth-change-name-btn');
    if (changeNameBtn) changeNameBtn.addEventListener('click', openChangeNameModal);
    const changePasswordBtn = $('#auth-change-password-btn');
    if (changePasswordBtn) changePasswordBtn.addEventListener('click', openChangePasswordModal);
    const signoutBtn = $('#auth-signout-btn');
    if (signoutBtn) signoutBtn.addEventListener('click', signOut);

    // Change name modal
    const changeNameClose = $('#change-name-modal-close');
    if (changeNameClose) changeNameClose.addEventListener('click', closeChangeNameModal);
    const changeNameModal = $('#change-name-modal');
    if (changeNameModal) changeNameModal.addEventListener('click', e => { if (e.target === changeNameModal) closeChangeNameModal(); });
    const changeNameForm = $('#change-name-form');
    if (changeNameForm) changeNameForm.addEventListener('submit', e => { e.preventDefault(); handleChangeName(); });

    // Change password modal
    const changePwdClose = $('#change-password-modal-close');
    if (changePwdClose) changePwdClose.addEventListener('click', closeChangePasswordModal);
    const changePwdModal = $('#change-password-modal');
    if (changePwdModal) changePwdModal.addEventListener('click', e => { if (e.target === changePwdModal) closeChangePasswordModal(); });
    const changePwdForm = $('#change-password-form');
    if (changePwdForm) changePwdForm.addEventListener('submit', e => { e.preventDefault(); handleChangePassword(); });

    // Change avatar modal
    const changeAvatarClose = $('#change-avatar-modal-close');
    if (changeAvatarClose) changeAvatarClose.addEventListener('click', closeChangeAvatarModal);
    const changeAvatarModalEl = $('#change-avatar-modal');
    if (changeAvatarModalEl) changeAvatarModalEl.addEventListener('click', e => { if (e.target === changeAvatarModalEl) closeChangeAvatarModal(); });
    const changeAvatarPick = $('#change-avatar-pick-btn');
    const changeAvatarInput = $('#change-avatar-input');
    if (changeAvatarPick && changeAvatarInput) {
      changeAvatarPick.addEventListener('click', () => changeAvatarInput.click());
      changeAvatarInput.addEventListener('change', e => handleAvatarFileSelect(e.target.files[0]));
    }
    const changeAvatarUpload = $('#change-avatar-upload-btn');
    if (changeAvatarUpload) changeAvatarUpload.addEventListener('click', handleAvatarUpload);

    // Comments page
    if (el.commentsBackBtn) el.commentsBackBtn.addEventListener('click', closeCommentsPage);
    // Draggable resize for comments page — larger drag area, smoother interaction
    const dragHandle = $('#comments-drag-handle');
    if (dragHandle && el.commentsPage) {
      let dragStartY = 0, dragStartH = 0, dragging = false;
      const onDragStart = (clientY) => {
        dragging = true;
        dragStartY = clientY;
        dragStartH = el.commentsPage.offsetHeight;
        el.commentsPage.style.transition = 'none';
      };
      const onDragMove = (clientY) => {
        if (!dragging) return;
        const dy = dragStartY - clientY;
        const newH = Math.min(window.innerHeight * 0.92, Math.max(250, dragStartH + dy));
        el.commentsPage.style.height = newH + 'px';
      };
      const onDragEnd = () => { dragging = false; };
      dragHandle.addEventListener('mousedown', e => { e.preventDefault(); onDragStart(e.clientY); });
      dragHandle.addEventListener('touchstart', e => { onDragStart(e.touches[0].clientY); }, { passive: true });
      document.addEventListener('mousemove', e => onDragMove(e.clientY));
      document.addEventListener('touchmove', e => onDragMove(e.touches[0].clientY), { passive: true });
      document.addEventListener('mouseup', onDragEnd);
      document.addEventListener('touchend', onDragEnd);
    }
    if (el.commentsPostBtn) el.commentsPostBtn.addEventListener('click', postComment);
    if (el.commentsInput) {
      el.commentsInput.addEventListener('input', () => {
        if (el.commentsPostBtn) el.commentsPostBtn.disabled = !el.commentsInput.value.trim();
        // Auto-resize
        el.commentsInput.style.height = 'auto';
        el.commentsInput.style.height = Math.min(el.commentsInput.scrollHeight, 120) + 'px';
      });
      el.commentsInput.addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          postComment();
        }
      });
    }
    if (el.commentsReplyCancel) el.commentsReplyCancel.addEventListener('click', () => { commentsReplyToId = null; hideReplyPreview(); });
    if (el.commentsList) {
      el.commentsList.addEventListener('click', e => {
        const replyBtn = e.target.closest('.comment-reply-btn');
        if (replyBtn) { setReplyTo(replyBtn.dataset.commentId); return; }
        const deleteBtn = e.target.closest('.comment-delete-btn');
        if (deleteBtn) { confirmDeleteComment(deleteBtn.dataset.commentId); return; }
      });
    }
    if (el.deleteCommentConfirm) el.deleteCommentConfirm.addEventListener('click', doDeleteComment);
    if (el.deleteCommentCancel) el.deleteCommentCancel.addEventListener('click', () => {
      commentsPendingDeleteId = null;
      if (el.deleteCommentModal) el.deleteCommentModal.classList.remove('open');
    });
    const delClose = $('#delete-comment-modal-close');
    if (delClose) delClose.addEventListener('click', () => {
      commentsPendingDeleteId = null;
      if (el.deleteCommentModal) el.deleteCommentModal.classList.remove('open');
    });
    const delModal = $('#delete-comment-modal');
    if (delModal) delModal.addEventListener('click', e => { if (e.target === delModal) {
      commentsPendingDeleteId = null;
      delModal.classList.remove('open');
    } });
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
    await SupabaseStore.load();
    bindAuth();

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
    bindActivity();
    bindArticleClicks();
    bindFeedControls();
    bindDateToggle();
    await renderContent();
  }

  init();
})();
