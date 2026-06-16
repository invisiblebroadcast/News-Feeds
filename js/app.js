(async () => {
  const $ = (sel, ctx = document) => ctx.querySelector(sel);
  const $$ = (sel, ctx = document) => [...ctx.querySelectorAll(sel)];

  let currentScope = 'nation';
  let currentNation = FeedManager.getSelectedNation();
  let currentSubcat = 'all';
  let currentMode = 'live';
  let currentRankType = 'ai'; // 'ai' or 'keyword' — only relevant when currentMode === 'top'
  let currentView = 'list';
  let scopeCache = {};
  let isFetching = false;
  let currentArticles = [];
  let loadedCount = 0;
  // Monotonically increasing token for in-flight mode switches. Each
  // rAF callback checks against this and bails out if a newer click
  // superseded it, so rapid Top-AI → Top-Keyword → Live clicks don't
  // pile up stale renders.
  let pendingModeSwitch = 0;

  /* ── Modal / "deeper view" history stack ──
   *
   * Goal: when the user presses the browser back button (or the
   * mobile swipe-back gesture) while a modal (settings, article,
   * auth, etc.) or full-screen sub-view (comments page) is open, the
   * modal/view should close — NOT the whole page. Only the *next*
   * back press should leave the app.
   *
   * Mechanism (frame-based with a pushed-state stack):
   *   - Each "frame" is a logical group of modals/views that belong
   *     together. The first member of a frame pushes a history
   *     state; subsequent members of the same frame do not.
   *   - When the user presses back (or we call history.back() to
   *     consume a pushed state), the popstate handler closes the
   *     ENTIRE topmost frame in one go — root + any nested modals.
   *   - When the user closes a non-root modal via its X button, only
   *     that modal closes. The frame (and the pushed state) stay
   *     intact so the next back press still does the right thing.
   *   - When the user closes the ROOT modal of a frame via X, the
   *     entire frame closes and we call history.back() to consume
   *     the pushed state.
   *   - Multiple frames can stack on the history (e.g. user opens
   *     article modal, then opens comments page on top of it). Each
   *     back press pops one frame. We track this with a parallel
   *     stack (pushedFrameStack) so we always know which frame to
   *     close when popstate fires.
   *
   * Why frames + a pushed-state stack? The original code had a
   * subtle bug: when the root modal was closed via X, it called
   * history.back() and the popstate handler then popped the next
   * modal from the stack (a nested one), closing the wrong modal.
   * And when a modal was opened on top of another frame (e.g.
   * reels-view → article modal), the popstate handler would close
   * the wrong frame because it only tracked ONE active frame. The
   * stack fixes both: popstate pops the topmost frame, and a
   * root-modal close only consumes the matching history entry.
   */
  // Stack of currently-open modals. Each entry: { name, el, onClose,
  // frameId, isRoot }. isRoot=true means this modal is the first
  // member of its frame and therefore owns the pushed history state.
  const modalStack = [];
  // Same idea for full-screen sub-views (currently just the comments
  // page). A single frame is all-modals or all-sub-views, but
  // different frames can be of different types and stack on the
  // history independently.
  const subViewStack = [];
  // Monotonically-increasing ID for each new frame. Used to associate
  // modal-stack entries with their pushed history state.
  let nextFrameId = 0;
  // Stack of frameIds whose history state is currently pushed, in
  // push order (oldest first). The TOP of this stack is the
  // most-recently-pushed frame — the one popstate will close next.
  // We use this instead of a single `activePushedFrameId` because
  // frames can stack (reels-view → article modal → comments page) and
  // popstate needs to know the exact topmost frame to close.
  const pushedFrameStack = [];
  // frameId of the currently-active cards/reels view (when the user
  // is in cards view). Lives at the outer scope so the popstate
  // handler can detect "the frame the user just popped was the reels
  // view" and route to exitReelsFromBack() instead of closeFrame().
  let reelsFrameId = -1;

  function currentFrameId() {
    if (modalStack.length > 0) return modalStack[modalStack.length - 1].frameId;
    if (subViewStack.length > 0) return subViewStack[subViewStack.length - 1].frameId;
    return -1;
  }

  // Start a new frame and push a history state. The state object
  // carries a marker so we can ignore popstate events that come from
  // history changes we didn't make (e.g. external scripts).
  function beginNewFrame() {
    const frameId = ++nextFrameId;
    pushedFrameStack.push(frameId);
    try { history.pushState({ ibFrame: frameId }, ''); } catch {}
    return frameId;
  }

  // Drop a frame from the pushed-state stack without touching the
  // browser. Used by the popstate handler (after the browser has
  // already consumed the state) and by the reels-view code when
  // exiting via a button (instead of via popstate).
  function dropPushedFrame(frameId) {
    const idx = pushedFrameStack.lastIndexOf(frameId);
    if (idx >= 0) pushedFrameStack.splice(idx, 1);
  }

  // Close every member (modal OR sub-view) belonging to the given
  // frame, across both stacks. Hides their UI, runs their onClose
  // callbacks, and removes them from their stack. Does NOT touch the
  // pushed-state stack — that's the caller's job (closeModal/
  // closeSubView decide whether to call history.back(); popstate
  // already consumed the state).
  function closeFrame(frameId) {
    for (let i = modalStack.length - 1; i >= 0; i--) {
      if (modalStack[i].frameId === frameId) {
        const m = modalStack[i];
        m.el.classList.remove('open');
        if (m.onClose) try { m.onClose(); } catch {}
        modalStack.splice(i, 1);
      }
    }
    for (let i = subViewStack.length - 1; i >= 0; i--) {
      if (subViewStack[i].frameId === frameId) {
        const m = subViewStack[i];
        if (m.onClose) try { m.onClose(); } catch {}
        subViewStack.splice(i, 1);
      }
    }
  }

  function openModal(name, modalEl, onClose) {
    if (!modalEl) return;
    if (modalStack.length === 0 && subViewStack.length === 0) {
      // Fresh frame — push state so the next back press closes the
      // whole frame (and not the whole page).
      const frameId = beginNewFrame();
      modalStack.push({ name, el: modalEl, onClose, frameId, isRoot: true });
    } else {
      // Nested within the current frame — same pushed state.
      modalStack.push({ name, el: modalEl, onClose, frameId: currentFrameId(), isRoot: false });
    }
    modalEl.classList.add('open');
  }

  function closeModal(name) {
    const idx = modalStack.findIndex(m => m.name === name);
    if (idx === -1) return;
    const m = modalStack[idx];

    if (m.isRoot) {
      // Closing the root of a frame: just call history.back() to
      // consume the pushed state. The popstate handler is the
      // SINGLE source of truth for closing frames — it will run
      // closeFrame(m.frameId) for us. This avoids the previous bug
      // where the popstate handler would pop a different (still-
      // pushed) frame because we'd already removed the popped one
      // from pushedFrameStack ourselves.
      //
      // But only do this when the frame's state is the TOP of the
      // history. If another frame was pushed on top of this one
      // (e.g. user opened article modal, then comments page, then
      // closed the article modal via X), history.back() would
      // pop the comments frame instead. In that case we just
      // close the visual element and let the state stay on the
      // history; a future back press will clean it up.
      if (pushedFrameStack[pushedFrameStack.length - 1] === m.frameId) {
        try { history.back(); } catch {
          // If history.back() isn't available (e.g. file:// in some
          // browsers), just close the visual element.
          closeFrame(m.frameId);
        }
      } else {
        closeFrame(m.frameId);
      }
    } else {
      // Closing a nested modal: just hide it and remove from the
      // stack. The frame and pushed state stay intact so the next
      // back press still closes the root of this frame.
      m.el.classList.remove('open');
      if (m.onClose) try { m.onClose(); } catch {}
      modalStack.splice(idx, 1);
    }
  }

  // options.newFrame: when true, always start a fresh frame (push a
  // new history state) even if another stack already has content.
  // Used by the comments page so it gets its own back-stack entry on
  // top of whatever modal opened it.
  function openSubView(name, onClose, options) {
    options = options || {};
    const forceNewFrame = options.newFrame === true;
    if ((subViewStack.length === 0 && modalStack.length === 0) || forceNewFrame) {
      const frameId = beginNewFrame();
      subViewStack.push({ name, onClose, frameId, isRoot: true });
    } else {
      subViewStack.push({ name, onClose, frameId: currentFrameId(), isRoot: false });
    }
  }

  function closeSubView(name) {
    const idx = subViewStack.findIndex(m => m.name === name);
    if (idx === -1) return;
    const m = subViewStack[idx];

    if (m.isRoot) {
      // Same logic as closeModal root: defer to popstate via
      // history.back(), or close the visual element if the state
      // is buried under another frame.
      if (pushedFrameStack[pushedFrameStack.length - 1] === m.frameId) {
        try { history.back(); } catch {
          closeFrame(m.frameId);
        }
      } else {
        closeFrame(m.frameId);
      }
    } else {
      if (m.onClose) try { m.onClose(); } catch {}
      subViewStack.splice(idx, 1);
    }
  }

  // Single popstate handler: close the entire topmost frame whose
  // state was just popped by the browser. With the pushed-state
  // stack, this works for any combination of root + nested modals
  // across multiple stacked frames (reels-view → article modal →
  // comments page, etc).
  //
  // Trap behaviour: when there are no pushed frames left, the user
  // pressed back from the "main" view. Instead of letting the
  // browser navigate away from the app, we (re)install a sentinel
  // state and swallow the back press. The user can still leave the
  // app by closing the tab or tapping an external link.
  //
  // We use replaceState (not pushState) so the history doesn't grow
  // unboundedly on repeat back presses. Initial install uses
  // pushState so the trap is a NEW entry on top of whatever the
  // browser had before — this is what "intercepts" the first back
  // press on app load.
  let trapInstalled = false;
  function installBackTrap(useReplace) {
    if (history.state && history.state.ibTrap) {
      // Trap is already the current state — nothing to do.
      trapInstalled = true;
      return;
    }
    trapInstalled = true;
    try {
      if (useReplace) history.replaceState({ ibTrap: true }, '');
      else history.pushState({ ibTrap: true }, '');
    } catch {}
  }
  installBackTrap(false);

  // Suppress re-entry while we're already inside a popstate handler
  // (e.g. closeFrame calls history.back() which fires popstate again).
  let popstateBusy = false;

  window.addEventListener('popstate', () => {
    if (popstateBusy) return;
    if (pushedFrameStack.length === 0) {
      // The user pressed back from the main view (no modals/views
      // open). Re-install the trap so the next back press is a
      // no-op too, instead of the browser navigating to whatever
      // page the user was on before this app. Use replaceState so
      // the history doesn't grow on repeat presses.
      installBackTrap(true);
      return;
    }
    popstateBusy = true;
    try {
      const frameId = pushedFrameStack[pushedFrameStack.length - 1];
      dropPushedFrame(frameId);
      // Special case: this frame was the cards/reels view frame. Exit
      // back to list view instead of going through the modal/subView
      // closeFrame path (which is a no-op for the reels view).
      if (frameId === reelsFrameId) {
        exitReelsFromBack();
        return;
      }
      closeFrame(frameId);
    } finally {
      popstateBusy = false;
    }
  });

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
    filterToggle: $('#filter-btn'),
    sortBtn: $('#sort-btn'),
    aiRankBtn: $('#ai-rank-btn'),
    keywordRankBtn: $('#keyword-rank-btn'),
    filterPanel: $('#filter-panel'),
    sortPanel: $('#sort-panel'),
    viewToggle: $('#view-toggle'),
    githubTokenInput: $('#github-token-input'),
    cloudStatus: $('#cloud-status'),
    refreshBtn: $('#refresh-btn'),
    hardRefreshBtn: $('#hard-refresh-btn'),
    hardRefreshModal: $('#hard-refresh-modal'),
    hardRefreshModalClose: $('#hard-refresh-modal-close'),
    hardRefreshCancel: $('#hard-refresh-cancel'),
    hardRefreshConfirm: $('#hard-refresh-confirm'),
    sourcesConfigModal: $('#sources-config-modal'),
    sourcesConfigModalClose: $('#sources-config-modal-close'),
    sourcesConfigSearch: $('#sources-config-search'),
    sourcesConfigDone: $('#sources-config-done'),
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
    deleteCommentCancel: $('#delete-comment-cancel'),
    topDateBtn: $('#top-date-btn'),
    autoDisableFailingSources: $('#auto-disable-failing-sources'),
    feedHealthCount: $('#feed-health-count'),
    reenableAllBtn: $('#reenable-all-btn')
  };

  if (!el.modal) return;

  function formatDate(d) {
    const date = new Date(d);
    if (isNaN(date.getTime())) return d;
    return date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  function formatDateIST(d) {
    const date = new Date(d);
    if (isNaN(date.getTime())) return d;
    const datePart = date.toLocaleDateString('en-IN', {
      day: 'numeric', month: 'short', year: 'numeric',
      timeZone: 'Asia/Kolkata'
    });
    const timePart = date.toLocaleTimeString('en-IN', {
      hour: '2-digit', minute: '2-digit', hour12: false,
      timeZone: 'Asia/Kolkata'
    });
    return datePart + ', ' + timePart + ' IST';
  }

  function formatDateShort(d) {
    const date = new Date(d);
    if (isNaN(date.getTime())) return d;
    const diff = Date.now() - date.getTime();
    // Future-dated articles: this happens when a publisher's CMS clock is
    // skewed or the article is queued with a future timestamp (e.g. Mongabay
    // scheduled post dated 15 Jun 2026 16:17 UTC). We must NOT show "just now"
    // because that lies to the user about the article's recency.
    if (diff < 0) {
      const futureMins = Math.floor(-diff / 60000);
      // Within a day: "in 5m" / "in 2h"
      if (futureMins < 60) return 'in ' + futureMins + 'm';
      const futureHours = Math.floor(futureMins / 60);
      if (futureHours < 24) return 'in ' + futureHours + 'h';
      // Beyond a day in the future: the data is suspect (publisher clock
      // issue). Show the actual date and mark it as scheduled.
      return '~ ' + date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
    }
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

  // Truncate a long description at the nearest sentence end so the summary
  // never cuts off mid-sentence ("...the President said today is"). If no
  // sentence end is found before `maxLen`, falls back to a hard cut at the
  // last word boundary to avoid splitting in the middle of a word.
  function smartTruncate(text, maxLen) {
    if (!text || text.length <= maxLen) return text;
    // Look for sentence-ending punctuation followed by a space
    const slice = text.slice(0, maxLen);
    // Find the last sentence boundary (. ! ?) within the slice
    const sentenceEnd = Math.max(
      slice.lastIndexOf('. '),
      slice.lastIndexOf('! '),
      slice.lastIndexOf('? '),
      slice.lastIndexOf('.\n'),
      slice.lastIndexOf('!\n'),
      slice.lastIndexOf('?\n')
    );
    if (sentenceEnd > 40) {
      // Keep the punctuation, drop trailing space
      return slice.slice(0, sentenceEnd + 1);
    }
    // No sentence end found — fall back to last word boundary
    const lastSpace = slice.lastIndexOf(' ');
    if (lastSpace > 40) {
      return slice.slice(0, lastSpace) + '…';
    }
    // Even worse: no space, hard cut
    return slice + '…';
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
    // Conflicts view is a special scope that lists articles in
    // cross-source conflicting clusters. Compute its count up-front so
    // the tab badge stays in sync with what the user will see.
    let conflictCount = 0;
    for (const key of Object.keys(scopeCache)) {
      const cached = scopeCache[key];
      if (!cached || !cached.groups) continue;
      const all = [].concat(...Object.values(cached.groups));
      if (!all.length) continue;
      const map = AI.detectConflicts(all);
      for (const c of map.values()) if (c.isConflicting) conflictCount++;
    }
    html += '<li class="tab-item conflicts-tab' + (currentScope === 'conflicts' ? ' active' : '') + '" data-scope="conflicts">' +
      '<span class="ct-icon">⚠</span> Conflicts' +
      (conflictCount ? '<span class="ct-count">' + conflictCount + '</span>' : '') +
      '</li>';
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
      hasFreshBackground = false;
      liveAllLoaded = false;
      $$('.tab-item', el.topTabs).forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      if (scope === 'conflicts') {
        renderConflictsView();
      } else {
        renderSubTabs();
        renderContent();
      }
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
    const sortMode = currentSort || (currentMode === 'top' ? 'date-desc' : 'date-desc');
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
    if (currentScope === 'conflicts') {
      el.subTabs.innerHTML = '';
      el.subBar.style.display = 'none';
      return;
    }
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
      hasFreshBackground = false;
      loadedCount = 0;
      liveAllLoaded = false;
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
    if (currentScope === 'conflicts') {
      if (el.sectionTitle) {
        el.sectionTitle.innerHTML = '⚠ Conflicts view' +
          '<span style="font-size:0.8rem;font-weight:400;color:var(--text-tertiary);margin-left:8px;">Cross-source disagreements</span>';
      }
      if (el.sectionMeta) el.sectionMeta.innerHTML = '';
      return;
    }
    const scopeLabel = currentScope === 'global' ? 'Global' : (FeedManager.getNations()[currentNation] || currentNation);
    const subLabel = FeedManager.subcatLabel(currentSubcat, currentScope);
    if (el.sectionTitle) {
      el.sectionTitle.innerHTML = FeedManager.subcatIcon(currentSubcat) + ' ' + subLabel +
        '<span style="font-size:0.8rem;font-weight:400;color:var(--text-tertiary);margin-left:8px;">' + scopeLabel + '</span>';
    }
    if (el.sectionMeta) {
      el.sectionMeta.innerHTML = '';
      const leftHtml = updateViewToggleInline();
      if (leftHtml) el.sectionMeta.innerHTML = leftHtml;
    }
    if (el.modeToggle) {
      updateModeButtonActive();
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

  // Track whether the user has chosen to "load all" in live mode.
  let liveAllLoaded = false;

  // In live mode, show only the most recent article from each source in the
  // default view. The "Load All" button then reveals everything fetched.
  // This keeps the initial view light (1 card per source) while making it
  // clear how many sources actually returned content.
  function pickOnePerSource(articles) {
    const seen = new Set();
    const out = [];
    for (const a of articles) {
      const src = a.source || '__none__';
      if (seen.has(src)) continue;
      seen.add(src);
      out.push(a);
    }
    return out;
  }

  function renderArticles(articles) {
    try {
      if (!articles.length) { showEmpty(); return; }

      currentArticles = articles;

      let display;
      let totalShown;
      if (currentMode === 'live') {
        // Cap the "Load All" view at 500 articles for mobile safety. 500 cards
        // is already a lot to scroll; showing 5,000+ would freeze the page.
        const liveTotalCap = 500;
        if (liveAllLoaded) {
          display = articles.slice(0, liveTotalCap);
        } else {
          // Default live view: exactly ONE article per source, the most recent.
          // This guarantees a manageable initial load no matter how many sources.
          display = pickOnePerSource(articles);
        }
        totalShown = display.length;
      } else {
        display = articles.slice(0, 25);
        display.forEach((a, i) => a._rank = i + 1);
        totalShown = display.length;
      }

      // Build the "Load All" button (live mode only) — placed at the TOP of
      // the content area so the user can opt in to seeing everything.
      let loadAllHtml = '';
      if (currentMode === 'live' && !liveAllLoaded && articles.length > display.length) {
        const remaining = articles.length;
        const showing = totalShown;
        const cap = 500;
        const willShow = Math.min(remaining, cap);
        loadAllHtml = '<div class="load-all-row">' +
          '<div class="load-all-info">' +
            '<strong>Showing ' + showing + ' of ' + remaining + ' articles</strong>' +
          '</div>' +
          '<button class="btn btn-primary" id="load-all-btn">Load All Articles</button>' +
        '</div>';
      }

      updateStickyHeader(totalShown + ' of ' + articles.length);

      // Build the grid using a DocumentFragment so we don't keep reflowing on
      // each append. For very large lists (500+ cards) we chunk the work
      // across multiple animation frames so the UI stays responsive.
      renderArticleGrid(loadAllHtml, display);

      const loadAllBtn = $('#load-all-btn');
      if (loadAllBtn) {
        loadAllBtn.addEventListener('click', () => {
          liveAllLoaded = true;
          renderArticles(currentArticles);
        });
      }
    } catch (e) {
      console.error('renderArticles failed:', e);
      showError('Failed to render list view. Try refreshing.');
    }
  }

  // Render the article grid. For lists up to 50 articles we use a single
  // innerHTML write (fastest). For larger lists (especially "Load All" with
  // 500 cards) we build a DocumentFragment to batch the DOM operations and
  // chunk the rendering across animation frames so the page never freezes.
  function renderArticleGrid(loadAllHtml, display) {
    if (display.length <= 50) {
      el.main.innerHTML =
        loadAllHtml +
        '<div class="article-grid">' +
          display.map((a, i) => renderCard(a, i)).join('') +
        '</div>';
      return;
    }
    // Big list: build the grid scaffold + load banner, then append cards
    // in chunks via requestAnimationFrame.
    el.main.innerHTML = loadAllHtml + '<div class="article-grid" id="article-grid"></div>';
    const grid = $('#article-grid');
    if (!grid) return;
    const CHUNK = 50;
    let i = 0;
    function appendChunk() {
      const frag = document.createDocumentFragment();
      const end = Math.min(i + CHUNK, display.length);
      for (; i < end; i++) {
        const tmp = document.createElement('div');
        tmp.innerHTML = renderCard(display[i], i);
        frag.appendChild(tmp.firstElementChild);
      }
      grid.appendChild(frag);
      if (i < display.length) {
        requestAnimationFrame(appendChunk);
      }
    }
    requestAnimationFrame(appendChunk);
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
    const aiBadgeHtml = article._aiBoost
      ? '<span class="ai-badge" title="AI boosted">AI</span>'
      : '';
    // One ranked kicker per article (mutually exclusive: AI / keyword / live-trending),
    // with its expandable "where it's trending" details immediately after it so the
    // click delegation can toggle the correct sibling.
    const kwText = (article._trendingKeywords && article._trendingKeywords.length) ? article._trendingKeywords.join(', ') : '—';
    const locText = escHtml(scopeLabel(currentScope, currentSubcat));
    let rankedBlock = '';
    if (article._aiRanked) {
      const num = article._rank ? '#' + article._rank : '';
      rankedBlock =
        '<div class="ai-ranked-kicker ranked-kicker" data-toggle-details role="button" tabindex="0" aria-expanded="false">' +
          '<span class="ark-sparkle">✦</span> AI Ranked · <span class="rk-num">' + num + '</span>' +
        '</div>' +
        '<div class="ranked-details" aria-hidden="true">' +
          '<span class="rd-loc">' + locText + '</span>' +
          '<span class="rd-kw">' + escHtml(kwText) + '</span>' +
        '</div>';
    } else if (article._kwRanked) {
      const num = article._rank ? '#' + article._rank : '';
      rankedBlock =
        '<div class="kw-ranked-kicker ranked-kicker" data-toggle-details role="button" tabindex="0" aria-expanded="false">' +
          '<span class="krk-hash">#</span> Trending · <span class="rk-num">' + num + '</span>' +
        '</div>' +
        '<div class="ranked-details" aria-hidden="true">' +
          '<span class="rd-loc">' + locText + '</span>' +
          '<span class="rd-kw">' + escHtml(kwText) + '</span>' +
        '</div>';
    } else if (currentMode === 'live' && article._trendingCount > 0) {
      rankedBlock =
        '<div class="live-trending-kicker ranked-kicker" data-toggle-details role="button" tabindex="0" aria-expanded="false">' +
          '<span class="lrk-arrow">↗</span> Trending · <span class="rk-num">' + article._trendingCount + '</span>' +
        '</div>' +
        '<div class="ranked-details" aria-hidden="true">' +
          '<span class="rd-loc">' + locText + '</span>' +
          '<span class="rd-kw">' + escHtml(kwText) + '</span>' +
        '</div>';
    }

    const ad = getArticleData(article.link);
    const flagHtml = ad.flag ? '<span class="flag-badge" style="background:' + (FLAG_COLORS[ad.flag] || 'var(--text-tertiary)') + '">' + ad.flag + '</span>' : '';
    const likeCount = ad.likeCount || 0;
    const dislikeCount = ad.dislikeCount || 0;
    const commentCount = (ad.comments && ad.comments.length) || 0;

    // Conflict kicker: when this article is part of a cluster with
    // different reported facts (numbers, scores, etc.), show a warning
    // kicker and an expandable "Other sources report" panel.
    let conflictBlock = '';
    if (article._conflicts && article._conflicts.isConflicting) {
      const c = article._conflicts;
      conflictBlock =
        '<div class="conflict-kicker ranked-kicker" data-toggle-details role="button" tabindex="0" aria-expanded="false" title="' + escAttr('Conflicting reports — click for details') + '">' +
          '<span class="ck-warn">⚠</span> Conflicting reports · ' + c.clusterSize + ' sources' +
        '</div>' +
        '<div class="conflict-details ranked-details" aria-hidden="true">' +
          c.conflicts.map(group => {
            // Claim conflicts: show "X verb: source1 vs source2" format.
            if (group.metric === 'claim') {
              const subjectLabel = group.subject ? 'About <em>' + escHtml(group.subject) + '</em>:' : 'Claim:';
              const parts = group.detail.map(g =>
                '<span class="cd-value">' + escHtml(g.value) + '</span>' +
                '<span class="cd-src">(' + g.articles.map(a => escHtml(a.source || 'Unknown')).join(', ') + ')</span>'
              ).join(' vs ');
              return '<div class="cd-row"><span class="cd-metric">' + subjectLabel + '</span> ' + parts + '</div>';
            }
            // Numeric conflicts: keep the original "metric: value (sources)" format.
            const lines = group.detail.map(g =>
              '<span class="cd-value">' + escHtml(group.metric) + ': ' + escHtml(g.value) + '</span>' +
              '<span class="cd-src">(' + g.articles.map(a => escHtml(a.source || 'Unknown')).join(', ') + ')</span>'
            ).join(' ');
            return '<div class="cd-row">' + lines + '</div>';
          }).join('') +
        '</div>';
    }

    return '<article class="article-card" style="animation-delay:' + ((index % 10) * 0.04) + 's">' +
        '<button class="card-share-btn" data-url="' + encodeURIComponent(article.link) + '" data-title="' + escAttr(article.title) + '" data-source="' + escAttr(article.source) + '" title="Share as Image">&#x21AA;</button>' +
        thumbHtml +
        '<div class="article-body">' +
          rankedBlock +
          conflictBlock +
          '<h3 class="article-title"><span class="article-link" data-article="' + encoded + '">' + escHtml(article.title) + '</span></h3>' +
          '<p class="article-summary">' + smartTruncate(cleanSummary(stripHtml(article.summary)), 250) + '</p>' +
          '<div class="article-meta">' +
            '<span class="source">' + escHtml(article.source) + '</span>' +
            '<span class="date">' + formatDateShort(article.pubDate) + '</span>' +
            rankHtml +
            aiBadgeHtml +
            flagHtml +
            (article._conflicts && article._conflicts.isConflicting
              ? '<span class="conflict-pill" title="Conflicting reports across sources">⚠ conflicting</span>'
              : '') +
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

  function updateViewToggleInline() {
    return '<div class="mode-toggle view-toggle section-view-toggle" data-view-toggle-inline>' +
      renderViewToggle() + '</div>';
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
    try {
      if (!articles.length) { showEmpty(); return; }
      if (currentMode === 'top') {
        articles = articles.slice(0, 25);
        articles.forEach((a, i) => a._rank = i + 1);
      }
      currentArticles = articles;
      currentReelIndex = 0;
      showReel();
    } catch (e) {
      console.error('renderReels failed:', e);
      showError('Failed to render cards view. Try refreshing.');
    }
  }

  function cardOverlayHtml(includeToolbar, hasThumb) {
    var html = '';
    if (includeToolbar !== false) {
      const showDesc = Settings.get('showDescription');
      // Standalone toolbar row — sits above image/text, no overlap.
      // Refresh is done via the IB logo in the header; not duplicated here.
      html += '<div class="reels-toolbar-row">' +
        '<div class="reels-toolbar-group reels-toolbar-left">' +
          '<button class="reels-tool-btn reels-share-text" title="Copy Link">&#x1F517;</button>' +
        '</div>' +
        '<div class="reels-toolbar-group reels-toolbar-right">' +
          '<button class="reels-tool-btn reels-toggle-desc' + (showDesc ? ' active' : '') + '" title="Show / Hide Description" data-show-desc="' + (showDesc ? '1' : '0') + '">' +
            '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' +
              (showDesc
                ? '<path d="M2 4h12M2 8h12M2 12h8"/>'
                : '<path d="M2 4h12M2 8h8M2 12h10"/><line x1="2" y1="14" x2="14" y2="2" stroke="var(--accent)"/>') +
            '</svg>' +
          '</button>' +
          '<button class="reels-tool-btn reels-share-text-img" title="Copy as text image">&#x1F4DD;</button>' +
          (hasThumb ? '<button class="reels-tool-btn reels-share-image" title="Copy with source image">&#x1F5BC;</button>' : '') +
        '</div>' +
      '</div>';
      // Vertical action bar — right side, center (like YT Shorts / Reels)
      html += '<div class="reels-actions reels-actions-hidden">' +
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
    html += '<div class="reels-img-wrap"><img class="reels-img" alt="" loading="lazy"></div>';
    html += '<div class="reels-overlay">' +
        '<div class="reels-count-row">' +
          '<span class="reels-count"></span>' +
          '<div class="reels-badges">' +
            '<span class="reels-ai-ranked"><span class="ark-sparkle">✦</span> AI · <span class="rk-num"></span></span>' +
            '<span class="reels-kw-ranked"><span class="krk-hash">#</span> Trending · <span class="rk-num"></span></span>' +
            '<span class="reels-conflict" style="display:none"><span class="rc-warn">⚠</span> Conflict</span>' +
            '<span class="reels-mode-badge"></span>' +
          '</div>' +
        '</div>' +
        '<h2 class="reels-title"></h2>' +
        '<div class="reels-meta">' +
          '<span class="reels-source"></span>' +
          '<span class="reels-date"></span>' +
          '<span class="reels-live-trending" style="display:none"><span class="lrk-arrow">↗</span> <span class="rk-num"></span></span>' +
          '<span class="reels-flag" style="display:none"></span>' +
        '</div>' +
        '<div class="reels-conflict-panel" style="display:none">' +
          '<div class="rcp-header"><span class="rcp-warn">⚠</span> Conflicting reports</div>' +
          '<div class="rcp-body"></div>' +
        '</div>' +
        '<div class="reels-summary-wrap"><p class="reels-summary"></p></div>' +
        '<button class="btn btn-primary reels-read-btn">Read Original Article</button>' +
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
    cardEl.classList.toggle('has-image', !!hasThumb);
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
    const modeBadge = cardEl.querySelector('.reels-mode-badge');
    if (modeBadge) {
      const isTop = currentMode === 'top';
      modeBadge.textContent = isTop ? 'TOP' : 'LIVE';
      modeBadge.classList.toggle('mode-top', isTop);
      modeBadge.classList.toggle('mode-live', !isTop);
    }
    const aiRankedEl = cardEl.querySelector('.reels-ai-ranked');
    if (aiRankedEl) {
      aiRankedEl.classList.toggle('visible', !!article._aiRanked);
      const n = aiRankedEl.querySelector('.rk-num');
      if (n) n.textContent = article._rank ? '#' + article._rank : '';
    }
    const kwRankedEl = cardEl.querySelector('.reels-kw-ranked');
    if (kwRankedEl) {
      kwRankedEl.classList.toggle('visible', !!article._kwRanked);
      const n = kwRankedEl.querySelector('.rk-num');
      if (n) n.textContent = article._rank ? '#' + article._rank : '';
    }
    const liveTrendingEl = cardEl.querySelector('.reels-live-trending');
    if (liveTrendingEl) {
      const show = currentMode === 'live' && article._trendingCount > 0;
      liveTrendingEl.style.display = show ? 'inline-flex' : 'none';
      const n = liveTrendingEl.querySelector('.rk-num');
      if (n) n.textContent = show ? article._trendingCount : '';
    }
    const conflictBadge = cardEl.querySelector('.reels-conflict');
    const conflictPanel = cardEl.querySelector('.reels-conflict-panel');
    const conflictBody = cardEl.querySelector('.rcp-body');
    if (conflictBadge) {
      const has = !!(article._conflicts && article._conflicts.isConflicting);
      conflictBadge.style.display = has ? 'inline-flex' : 'none';
    }
    if (conflictPanel && conflictBody) {
      const c = article._conflicts;
      if (c && c.isConflicting) {
        conflictBody.innerHTML = c.conflicts.map(group => {
          const label = group.metric === 'claim'
            ? (group.subject ? 'About ' + escHtml(group.subject) : 'Claim')
            : escHtml(group.metric);
          return '<div class="rcp-row">' +
            '<span class="rcp-metric">' + label + ':</span> ' +
            group.detail.map(g =>
              '<span class="rcp-value">' + escHtml(g.value) + '</span>' +
              '<span class="rcp-sources">(' + g.articles.map(a => escHtml(a.source || 'Unknown')).join(', ') + ')</span>'
            ).join(' vs ') +
          '</div>';
        }).join('');
        conflictPanel.style.display = 'block';
      } else {
        conflictPanel.style.display = 'none';
      }
    }
    const title = cardEl.querySelector('.reels-title');
    if (title) title.textContent = article.title;
    const source = cardEl.querySelector('.reels-source');
    if (source) source.textContent = article.source;
    const date = cardEl.querySelector('.reels-date');
    if (date) date.textContent = formatDateShort(article.pubDate);
    const summaryText = cleanSummary(stripHtml(article.summary));
    const summary = cardEl.querySelector('.reels-summary');
    const summaryWrap = cardEl.querySelector('.reels-summary-wrap');
    const showDesc = Settings.get('showDescription');
    if (summary) {
      summary.textContent = showDesc ? summaryText : '';
    }
    if (summaryWrap) {
      summaryWrap.style.display = showDesc ? '' : 'none';
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

  function sizeReelsContainer() {
    const container = el.main.querySelector('.reels-container');
    const bottomBar = document.getElementById('bottom-bar');
    const header = document.querySelector('.app-header');
    if (!container) return;
    requestAnimationFrame(() => {
      const headerH = header ? header.getBoundingClientRect().height : 0;
      const bottomH = bottomBar ? bottomBar.getBoundingClientRect().height : 0;
      const available = window.innerHeight - headerH - bottomH;
      const maxH = Math.max(240, available - 4);
      // Only set MAX-height — don't force a fixed height. The card sizes
      // naturally to its content (image + text) and only the summary
      // gets a scrollbar IF the card exceeds max-height. When content is
      // short, the card is short and there's no scrollbar.
      container.style.maxHeight = maxH + 'px';
    });
  }

  function showReel() {
    const articles = currentArticles;
    const idx = currentReelIndex;
    const article = articles[idx];
    const total = articles.length;

    sizeReelsContainer();

    const existing = el.main.querySelector('.reels-container');

    if (!existing) {
      // Build the toolbar with awareness of whether the current article has a
      // source image (so the "share with image" button is conditionally shown).
      const hasThumb = article && article.imageUrl && article.imageUrl.startsWith('http');
      el.main.innerHTML =
        '<div class="reels-container">' +
          '<div class="reels-progress"></div>' +
          '<div class="reels-stack" id="reels-stack">' +
            '<div class="reels-card">' + cardOverlayHtml(true, hasThumb) + '</div>' +
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
        // Text-only share (always available)
        const sti = e.target.closest('.reels-share-text-img');
        if (sti) {
          e.stopPropagation();
          handleShareImage(currentArticle, sti, false);
          return;
        }
        // Share with source image (only button exists if has image)
        const si = e.target.closest('.reels-share-image');
        if (si) {
          e.stopPropagation();
          handleShareImage(currentArticle, si, true);
          return;
        }
        const home = e.target.closest('.reels-home-btn');
        if (home) { e.stopPropagation(); forceExitToHome(); return; }
        const toggleDesc = e.target.closest('.reels-toggle-desc');
        if (toggleDesc) {
          e.stopPropagation();
          const current = Settings.get('showDescription');
          Settings.set('showDescription', !current);
          syncSettingsToCloud();
          // Re-render the current card to apply the setting
          showReel();
          return;
        }
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
        if (e.target.closest('.reels-card') && !e.target.closest('button, a, input, textarea, .reels-comment-box, .reels-overlay button, .reels-home-btn, .reels-toolbar, .reels-toolbar-row')) {
          e.stopPropagation();
          const actions = stack.querySelector('.reels-actions');
          if (actions) {
            const isHidden = actions.classList.contains('reels-actions-hidden');
            if (isHidden) {
              actions.classList.remove('reels-actions-hidden');
            } else {
              actions.classList.add('reels-actions-hidden');
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
      const actions = fg.querySelector('.reels-actions');
      if (actions) actions.classList.add('reels-actions-hidden');
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

  // Exit reels view via the in-app exit button (e.g. the home button
  // on the reels card). Cleans up the back-stack entry that was pushed
  // when the user entered reels, so the next back press doesn't try
  // to close an already-gone reels frame.
  function exitReels() {
    if (currentView !== 'reels') return;
    currentView = 'list';
    document.body.classList.remove('cards-view');
    $$('#view-toggle .mode-btn, [data-view-toggle-inline] .mode-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.view === currentView);
    });
    if (pushedFrameStack[pushedFrameStack.length - 1] === reelsFrameId) {
      dropPushedFrame(reelsFrameId);
      try { history.back(); } catch {}
    }
    reelsFrameId = -1;
    updateStickyHeader();
    displayCurrentSubcat();
  }

  /* ── Conflicts view ──
   * Lists cross-source conflict clusters across all loaded scope caches,
   * sorted by severity. Each cluster is a card showing the involved
   * articles and the conflicting figures / claims.
   */
  function renderConflictsView() {
    // 1) Aggregate all loaded articles across every scope cache.
    const seen = new Set();
    const all = [];
    for (const key of Object.keys(scopeCache)) {
      const cached = scopeCache[key];
      if (!cached || !cached.groups) continue;
      for (const cat of Object.keys(cached.groups)) {
        if (!Array.isArray(cached.groups[cat])) continue;
        for (const a of cached.groups[cat]) {
          const id = a.link || a.guid || a.title;
          if (!id || seen.has(id)) continue;
          seen.add(id);
          all.push(a);
        }
      }
    }
    updateStickyHeader('Conflicts view');

    if (!all.length) {
      el.main.innerHTML = '<div class="conflicts-empty"><div class="ce-icon">⚠️</div>' +
        '<h3>No articles loaded yet</h3>' +
        '<p>Visit Global or your Nation tab first so we can analyze the latest articles for conflicts.</p></div>';
      return;
    }

    // 2) Run conflict detection on the aggregated pool.
    const map = AI.detectConflicts(all);

    // 3) Group by cluster (clusterSize + first metric + first subject
    //    is a good enough identity — articles in the same cluster
    //    share the same `conflicts` array shape).
    const clusters = new Map();
    for (const a of all) {
      const c = map.get(a.link);
      if (!c || !c.isConflicting) continue;
      // Build a stable key from the conflict signatures.
      const key = c.conflicts.map(g => g.metric + ':' + (g.subject || '') + ':' + g.detail.map(d => d.value).sort().join('|')).sort().join('||');
      if (!clusters.has(key)) clusters.set(key, { conflicts: c.conflicts, severity: c.severity || 0, articles: [], clusterSize: c.clusterSize || 0 });
      clusters.get(key).articles.push(a);
    }
    const list = Array.from(clusters.values());
    list.sort((a, b) => (b.severity || 0) - (a.severity || 0));

    if (!list.length) {
      el.main.innerHTML = '<div class="conflicts-empty"><div class="ce-icon">✓</div>' +
        '<h3>No conflicts detected</h3>' +
        '<p>Across ' + all.length + ' articles we didn\'t find any cross-source disagreements on numbers or claims.</p></div>';
      return;
    }

    // 4) Render the cluster cards.
    const html = list.map(cluster => {
      const sev = cluster.severity || 0;
      const bucket = AI.severityBucket ? AI.severityBucket(sev) : (sev >= 70 ? 'high' : sev >= 40 ? 'medium' : 'low');
      const claimRows = (cluster.conflicts || []).map(group => {
        const label = group.metric === 'claim'
          ? (group.subject ? 'About ' + escHtml(group.subject) : 'Claim')
          : escHtml(group.metric);
        return '<div class="cc-claim-row">' +
          '<span class="cc-claim-value">' + escHtml(label) + ':</span> ' +
          group.detail.map(g =>
            '<span class="cc-claim-value">' + escHtml(g.value) + '</span>' +
            '<span class="cc-claim-sources">(' + g.articles.map(a => escHtml(a.source || 'Unknown')).join(', ') + ')</span>'
          ).join(' vs ') +
          '</div>';
      }).join('');
      const articleLinks = (cluster.articles || []).map(a =>
        '<a class="cc-article-link" data-link="' + encodeURIComponent(a.link) + '">' + escHtml(a.title || a.link) + '</a>'
      ).join('');
      return '<div class="conflict-cluster">' +
        '<h4><span class="cc-warn">⚠</span> ' + escHtml(cluster.conflicts[0].subject || (cluster.conflicts[0].metric + ' disagreement')) +
        '<span class="conflict-severity ' + bucket + '">Severity ' + sev + '</span></h4>' +
        '<div class="cc-meta">' + cluster.articles.length + ' of ' + cluster.clusterSize + ' sources disagree · ' +
        cluster.conflicts.length + ' metric' + (cluster.conflicts.length > 1 ? 's' : '') + '</div>' +
        '<div class="cc-claims">' + claimRows + '</div>' +
        '<div class="cc-articles">' + articleLinks + '</div>' +
        '</div>';
    }).join('');

    el.main.innerHTML = '<div class="conflicts-list">' + html + '</div>';

    // Wire article links to open the modal.
    el.main.querySelectorAll('.cc-article-link').forEach(link => {
      link.addEventListener('click', e => {
        e.preventDefault();
        const url = decodeURIComponent(link.dataset.link);
        openArticleDetail(url);
      });
    });
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
    // Filter button → toggle source filter panel
    if (el.filterToggle) {
      el.filterToggle.addEventListener('click', () => {
        const hidden = el.filterPanel.style.display === 'none' || !el.filterPanel.style.display;
        el.filterPanel.style.display = hidden ? 'block' : 'none';
        if (el.sortPanel) el.sortPanel.style.display = 'none';
        el.filterToggle.classList.toggle('active', hidden);
        if (el.sortBtn) el.sortBtn.classList.remove('active');
      });
    }
    // Sort button → toggle sort panel
    if (el.sortBtn) {
      el.sortBtn.addEventListener('click', () => {
        const hidden = el.sortPanel.style.display === 'none' || !el.sortPanel.style.display;
        el.sortPanel.style.display = hidden ? 'block' : 'none';
        if (el.filterPanel) el.filterPanel.style.display = 'none';
        el.sortBtn.classList.toggle('active', hidden);
        if (el.filterToggle) el.filterToggle.classList.remove('active');
      });
    }
  }

  function bindLangSelect() {
    if (!el.langSelect) return;
    el.langSelect.value = Settings.get('language') || 'en';
    el.langSelect.addEventListener('change', () => {
      Settings.save({ language: el.langSelect.value });
      syncSettingsToCloud();
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

  function updateModeButtonActive() {
    if (!el.modeToggle) return;
    $$('.mode-btn', el.modeToggle).forEach(b => {
      const match = b.dataset.mode === currentMode &&
        (currentMode !== 'top' || b.dataset.rankType === currentRankType);
      b.classList.toggle('active', match);
    });
  }

  // Show/hide the IB-block rank action buttons + the date picker.
  // Sparkle (AI) and date picker → only in top-AI.
  // Hashtag (keyword) → only in top-keyword.
  // Live → none of them.
  // Human-readable scope + subcategory label for the "where it's trending" details.
  // e.g. "Global · Technology" / "India · Politics" / "Global · All".
  function scopeLabel(scope, subcat) {
    const scopeName = (scope === 'nation')
      ? (FeedManager.getSelectedNation ? FeedManager.getSelectedNation() : 'Nation')
      : 'Global';
    const subName = (subcat && subcat !== 'all') ? (subcat.charAt(0).toUpperCase() + subcat.slice(1)) : 'All';
    return scopeName + ' · ' + subName;
  }

  // Toggle the Top mode for a given rank type.
  // Click once  → enter Top (AI or Keyword) and load/rank the articles.
  // Click again (when already in that mode) → return to Live.
  // Clicking the other toggle while in one Top mode switches to the other.
  //
  // The mode change is split into two phases:
  //   1. Synchronous UI updates (button states, sticky header, sort
  //      options) and a "Switching to X…" status overlay — these run
  //      immediately so the click feels instant.
  //   2. Heavy work (ranking, conflict detection, render) is deferred
  //      to the next animation frame. By then the browser has painted
  //      the overlay and updated the button states, so the user never
  //      sees a frozen UI.
  function toggleTopMode(rankType) {
    const prevMode = currentMode;
    if (currentMode === 'top' && currentRankType === rankType) {
      currentMode = 'live';
    } else {
      currentMode = 'top';
      currentRankType = rankType;
    }
    switchModeNonBlocking(prevMode);
  }

  function updateRankControls() {
    const inTopAi = currentMode === 'top' && currentRankType === 'ai';
    const inTopKw = currentMode === 'top' && currentRankType === 'keyword';
    // Both IB-row rank toggles are always visible. The active one is
    // highlighted in blue (see .ib-rank-toggle.active in styles.css).
    if (el.aiRankBtn) {
      el.aiRankBtn.classList.toggle('active', inTopAi);
      el.aiRankBtn.setAttribute('aria-pressed', inTopAi ? 'true' : 'false');
    }
    if (el.keywordRankBtn) {
      el.keywordRankBtn.classList.toggle('active', inTopKw);
      el.keywordRankBtn.setAttribute('aria-pressed', inTopKw ? 'true' : 'false');
    }
    if (el.topDateBtn) el.topDateBtn.style.display = inTopAi ? 'inline-flex' : 'none';
  }

  /**
   * Shared helper used by every click handler that switches the top/live
   * mode. Updates the synchronous UI bits (button states, header, sort
   * options) and shows a "Switching to X…" overlay immediately, then
   * defers the actual ranking + render to the next animation frame.
   * A token ensures that if the user clicks multiple toggles in rapid
   * succession, only the latest one runs the heavy work.
   */
  function switchModeNonBlocking(prevMode) {
    const token = ++pendingModeSwitch;

    loadedCount = 0;
    liveAllLoaded = false;
    hasFreshBackground = false;
    updateModeButtonActive();
    updateRankControls();
    updateSortOptions();
    updateStickyHeader();

    // Pick a status message that matches the destination mode.
    let msg;
    if (currentMode === 'live') {
      msg = 'Switching to Live…';
    } else if (currentRankType === 'ai') {
      msg = 'Switching to Top AI…';
    } else {
      msg = 'Switching to Top Keyword…';
    }
    setTopListStatus(msg);

    // Schedule the heavy work for the next animation frame. By then
    // the browser has painted the overlay and the new button states,
    // so the user gets instant visual feedback. displayCurrentSubcat()
    // will further update the status to a more specific message
    // (e.g. "AI ranking…", "Ranking by keywords…") and finally clear it.
    requestAnimationFrame(() => {
      if (token !== pendingModeSwitch) return; // superseded by a newer click
      displayCurrentSubcat();
    });
  }

  function bindModeToggle() {
    const toggle = el.modeToggle;
    if (!toggle) return;
    toggle.addEventListener('click', e => {
      const btn = e.target.closest('.mode-btn');
      if (!btn || btn.classList.contains('active')) return;
      const prevMode = currentMode;
      currentMode = btn.dataset.mode;
      // Both "Top AI" and "Top Keyword" set data-mode="top"; disambiguate
      // with data-rank-type.
      if (currentMode === 'top') {
        currentRankType = btn.dataset.rankType || 'ai';
      }
      switchModeNonBlocking(prevMode);
    });
  }

  // Keyword rank toggle in the IB row. Toggles Top Keyword <-> Live.
  function bindKeywordRankBtn() {
    if (!el.keywordRankBtn) return;
    el.keywordRankBtn.addEventListener('click', () => toggleTopMode('keyword'));
  }

  // Track the cards-view (reels) frame so the browser back button
  // exits back to list view. We can't reuse the modal/subView stacks
  // because reels is a body-level class toggle, not a DOM element.
  // The frameId itself is declared at the outer scope (reelsFrameId)
  // so the popstate handler can read it.

  function bindViewToggle() {
    document.addEventListener('click', e => {
      const btn = e.target.closest('#view-toggle .mode-btn, [data-view-toggle-inline] .mode-btn');
      if (!btn || btn.classList.contains('active')) return;
      const newView = btn.dataset.view;
      const wasReels = currentView === 'reels';
      currentView = newView;
      $$('#view-toggle .mode-btn, [data-view-toggle-inline] .mode-btn').forEach(b => b.classList.remove('active'));
      $$('#view-toggle .mode-btn, [data-view-toggle-inline] .mode-btn').forEach(b => {
        if (b.dataset.view === currentView) b.classList.add('active');
      });
      document.body.classList.toggle('cards-view', currentView === 'reels');
      displayCurrentSubcat();
      sizeReelsContainer();

      // Manage the back-stack entry for reels. Entering reels pushes
      // a fresh frame; leaving it (back to list) consumes the frame.
      if (currentView === 'reels' && !wasReels) {
        reelsFrameId = ++nextFrameId;
        pushedFrameStack.push(reelsFrameId);
        try { history.pushState({ ibFrame: reelsFrameId, ibReels: true }, ''); } catch {}
      } else if (wasReels && currentView !== 'reels' && pushedFrameStack[pushedFrameStack.length - 1] === reelsFrameId) {
        dropPushedFrame(reelsFrameId);
        try { history.back(); } catch {}
      }
    });
    window.addEventListener('resize', () => {
      if (currentView === 'reels') sizeReelsContainer();
    });
  }

  // Exit reels view (e.g. via back button or Escape) without going
  // through the click handler. Updates the back-stack so the next
  // back press doesn't keep trying to close an already-gone reels
  // frame.
  function exitReelsFromBack() {
    if (currentView !== 'reels') return;
    currentView = 'list';
    document.body.classList.remove('cards-view');
    $$('#view-toggle .mode-btn, [data-view-toggle-inline] .mode-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.view === currentView);
    });
    if (pushedFrameStack[pushedFrameStack.length - 1] === reelsFrameId) {
      dropPushedFrame(reelsFrameId);
      try { history.back(); } catch {}
    }
    reelsFrameId = -1;
    updateStickyHeader();
    displayCurrentSubcat();
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
        showError('No feed sources available. Open Settings to add custom feeds.');
        isFetching = false;
        return;
      }

      const groups = {};
      const subs = FeedManager.subcategoriesForScope(currentScope);
      if (!subs.includes(currentSubcat)) currentSubcat = subs[0];

      // Wait for ALL sources to finish fetching before showing any results.
      // This prevents the "auto-refresh every few seconds" problem where
      // articles re-shuffle as each batch completes. The user sees a single
      // stable result once the fetch is done.
      showProgress('Fetching ' + feeds.length + ' sources\u2026');

      // In live mode, cap each source at 100 items to keep "Load All"
      // meaningful (e.g. 100 sources × 100 = up to 10,000 articles). In top
      // mode, we want ALL items from every source for proper concept ranking.
      const perSourceCap = currentMode === 'live' ? 100 : 0;

      const allResults = await Promise.allSettled(feeds.map(f => FeedFetcher.fetchFeed(f, perSourceCap)));

      for (let j = 0; j < allResults.length; j++) {
        const result = allResults[j];
        if (result.status === 'fulfilled') {
          const articles = result.value;
          for (const a of articles) {
            a.subcat = a.feedHint || 'politics';
            const cat = a.subcat;
            if (!groups[cat]) groups[cat] = [];
            groups[cat].push(a);
          }
        } else {
          console.warn('Feed failed: ' + feeds[j]?.name, result.reason?.message);
        }
      }

      let allArticles = [];
      for (const cat of Object.keys(groups)) allArticles.push(...groups[cat]);
      scopeCache[key] = { articles: allArticles, groups };
      renderSubTabs();
      updateStickyHeader();

      isFetching = false;
      // Now display the final result ONCE — no progressive re-rendering.
      displayCurrentSubcat();
    } catch (err) {
      console.error(err);
      showError('Failed to fetch news. Please check your connection.');
      isFetching = false;
    }
  }

  /* ── (no demo helpers) ── */

  async function displayCurrentSubcat() {
    const key = scopeKey();
    const cached = scopeCache[key];
    if (!cached) { renderContent(); return; }

    updateStickyHeader();

    let articles;
    try {
      articles = getFilteredArticles(currentSubcat, cached);
    } catch (e) {
      console.error('Error filtering articles:', e);
      showError('Failed to filter articles. Try refreshing.');
      return;
    }
    updateFilterSourceOptions(articles);
    if (!articles.length) { showEmpty(); return; }

    // For ranking / display, keep all articles in `currentArticles` so the user
    // can see all the available results. The renderer itself paginates to
    // perPage (or 3× perPage in top mode) and offers a Load More button.
    // We do NOT cap here so the user gets the full ranking.

    // AI Top List: load from DB only. Ranking happens at 8 PM IST (scheduled)
    // or on-demand only when even yesterday's ranking is missing for the
    // AI Top List: load from DB only. Ranking happens at 8 PM IST (scheduled)
    // or on-demand only when even yesterday's ranking is missing for the
    // current scope/subcat (so the user always has something to look at).
    // If AI ranking fails for any reason, fall back to live mode.
    if (currentMode === 'top') {
      const scope = currentScope;
      const subcat = currentSubcat;
      resetRateLimitFlag();

      if (currentRankType === 'keyword') {
        // Keyword ranking: compute on-the-fly from cached articles.
        // No Supabase, no API call. Uses the ENTIRE cached pool — no date
        // filter, whatever is in the RSS feeds gets ranked.
        setTopListStatus('Ranking by keywords…');
        // Yield immediately so the "Ranking by keywords…" overlay paints
        // before we start the (synchronous) analyzer work inside
        // AI.rankByKeywords. The function itself also yields internally.
        await new Promise(r => setTimeout(r, 0));
        const t0 = Date.now();
        let rankInput;
        if (subcat === 'all') {
          rankInput = [];
          for (const cat of Object.keys(cached.groups)) rankInput.push(...cached.groups[cat]);
        } else {
          rankInput = cached.groups[subcat] || [];
        }
        rankInput = FeedFetcher.deduplicate(rankInput);
        rankInput = FeedFetcher.sortByDate(rankInput);
        const r = await AI.rankByKeywords(rankInput, scope, subcat);
        if (r && r.length) {
          articles = r;
          // Normalize link from url so cards/buttons work, mark as keyword-ranked.
          articles.forEach(a => { a.link = a.link || a.url; a._kwRanked = true; });
        }
        // Keep the overlay visible long enough to be seen (min 500ms).
        const elapsed = Date.now() - t0;
        if (elapsed < 500) await new Promise(res => setTimeout(res, 500 - elapsed));
        clearTopListStatus();
      } else {
        // AI ranking: load from Supabase, fall back to fresh AI rank.
        const today = AI.todayStr();
        const yesterday = AI.yesterdayStr();
        const settings = Settings.load();
        const viewDate = settings.topDate || today;
        // Show the processing overlay for the entire AI top-mode flow:
        // DB fetch and (if needed) AI ranking.
        setTopListStatus('Loading rankings…');

        const ranked = await AI.loadTopList(viewDate, scope, subcat);
        if (ranked) {
          articles = ranked;
          articles.forEach(a => { a.link = a.link || a.url; a._aiRanked = true; });
          clearTopListStatus();
        } else {
          const hasYesterday = await AI.loadTopList(yesterday, scope, subcat);
          if (viewDate !== today) {
            setTopListStatus('No ranking for ' + viewDate);
            setTimeout(clearTopListStatus, 1500);
          } else if (!hasYesterday) {
            setTopListStatus('AI ranking…');
            // Yield so the overlay paints before the (sync) input-prep
            // steps below run. The actual rankArticles call is a network
            // round-trip, so it's already non-blocking on its own.
            await new Promise(r => setTimeout(r, 0));
            let rankOk = false;
            try {
              const cutoff = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
              let rankInput;
              if (subcat === 'all') {
                rankInput = [];
                for (const cat of Object.keys(cached.groups)) rankInput.push(...cached.groups[cat]);
              } else {
                rankInput = cached.groups[subcat] || [];
              }
              rankInput = FeedFetcher.deduplicate(rankInput);
              rankInput = FeedFetcher.filterByDate(rankInput, cutoff.toISOString().slice(0, 10), null);
              rankInput = FeedFetcher.sortByDate(rankInput);
              const r = await AI.rankArticles(rankInput, scope, subcat);
              if (r) { articles = r; articles.forEach(a => { a.link = a.link || a.url; a._aiRanked = true; }); rankOk = true; }
            } catch (e) {
              console.warn('AI ranking failed:', e);
              if (e.message && e.message.includes('rate limited')) showAiRateLimitModal();
            }
            if (rankOk) {
              clearTopListStatus();
            } else {
              // AI failed (rate limit / network / quota) — keep top mode
              // active and fall back to the deterministic analyzer ranking
              // so the user still gets a meaningful "Top" list. Show a
              // small banner so they know the AI wasn't used.
              console.warn('AI ranking unavailable for', scope, subcat, '— using analyzer fallback');
              try {
                let fbInput;
                if (subcat === 'all') {
                  fbInput = [];
                  for (const cat of Object.keys(cached.groups)) fbInput.push(...cached.groups[cat]);
                } else {
                  fbInput = cached.groups[subcat] || [];
                }
                fbInput = FeedFetcher.deduplicate(fbInput);
                fbInput = FeedFetcher.sortByDate(fbInput);
                const r = await AI.rankByKeywords(fbInput, scope, subcat);
                if (r && r.length) {
                  articles = r;
                  articles.forEach(a => { a.link = a.link || a.url; a._kwRanked = true; });
                  showAiOfflineBanner();
                  clearTopListStatus();
                } else {
                  throw new Error('Analyzer fallback also produced no result');
                }
              } catch (fbErr) {
                console.warn('Analyzer fallback failed:', fbErr);
                setTopListStatus('Ranking failed — switching to Live');
                currentMode = 'live';
                updateModeButtonActive();
                updateRankControls();
                setTimeout(() => { clearTopListStatus(); displayCurrentSubcat(); }, 1500);
                return;
              }
            }
          } else {
            setTopListStatus("Today's ranking will be ready at 8 PM IST");
            setTimeout(clearTopListStatus, 2500);
          }
        }
      }
    }

    // Compute per-article trending info (keywords + count) from the full
    // cached corpus, so every card knows how trending it is and can show
    // the "where" details on click. Used by live mode (trending count) and
    // by all modes (trending keywords in the toggle).
    const fullCorpus = [];
    for (const cat of Object.keys(cached.groups)) {
      if (Array.isArray(cached.groups[cat])) fullCorpus.push(...cached.groups[cat]);
    }
    AI.computeTrendingInfo(articles, fullCorpus);

    // Yield to the event loop so the browser can paint the "AI ranking…"
    // / "Ranking by keywords…" / "Switching to Live…" status overlay
    // (set by the rAF or by the if-block above) before we start the
    // expensive conflict-detection pass. Without this, the user sees
    // the overlay flash for a single frame at the end of the work
    // instead of at the start.
    await new Promise(r => setTimeout(r, 0));

    // Detect conflicting stories (same event, different facts) within the
    // current article pool. The result is attached to each article as
    // `._conflicts` so the card / reels view / article modal can surface a
    // badge and an "Other sources report" panel.
    try {
      const conflictMap = AI.detectConflicts(articles);
      for (const a of articles) {
        const c = conflictMap.get(a.link);
        if (c) a._conflicts = c;
      }
    } catch (e) {
      console.warn('Conflict detection failed:', e);
    }

    // One more yield before the render so the conflict badges have a
    // frame to be visible on their own (in case the user is staring
    // at the list while it re-renders).
    await new Promise(r => setTimeout(r, 0));

    try {
      await renderTranslated(articles);
    } catch (e) {
      console.error('Error rendering articles:', e);
      showError('Failed to render articles. Try refreshing.');
    } finally {
      // Always clear the "Switching to…" / "AI ranking…" / "Ranking by
      // keywords…" overlay when the work is done, no matter which path
      // we took. Some sub-paths clear it explicitly; the finally is the
      // safety net for the others (live, errors, early returns).
      clearTopListStatus();
    }
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
    if (currentMode === 'top') {
      // Top mode: only consider articles from the last 10 days
      const last10d = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
      const to = new Date();
      return FeedFetcher.filterByDate(articles, last10d.toISOString().slice(0, 10), to.toISOString().slice(0, 10));
    }

    return articles;
  }

  async function refreshAll() {
    const key = scopeKey();
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.55);display:flex;align-items:center;justify-content:center;z-index:300';
    overlay.innerHTML = '<div class="loading-spinner"></div>';
    document.body.appendChild(overlay);
    document.querySelectorAll('#refresh-btn').forEach(b => b.classList.add('btn-spin'));

    // Reset sticky state so user has to opt into "Load All" again
    liveAllLoaded = false;
    loadedCount = 0;
    scopeCache[key] = null;
    const feeds = FeedManager.getFeeds(currentScope, currentScope === 'nation' ? currentNation : null);
    if (!feeds.length) {
      overlay.remove();
      document.querySelectorAll('#refresh-btn').forEach(b => b.classList.remove('btn-spin'));
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
    document.querySelectorAll('#refresh-btn').forEach(b => b.classList.remove('btn-spin'));
    overlay.remove();
  }

  /* ── Hard Refresh ── */
  function openHardRefreshModal() {
    openModal('hardRefresh', el.hardRefreshModal);
  }
  function closeHardRefreshModal() {
    closeModal('hardRefresh');
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

  /* ── Top Date Picker ── */

  function bindTopDate() {
    const btn = el.topDateBtn;
    const modal = $('#top-date-modal');
    const close = $('#top-date-modal-close');
    const list = $('#top-date-list');
    if (!btn || !modal || !list) return;

    async function open() {
      const settings = Settings.load();
      const current = settings.topDate || AI.todayStr();
      // Show available dates for the current scope/subcat, newest first.
      let dates = [];
      try { dates = await AI.getAvailableDates(currentScope, currentSubcat); } catch {}
      if (!dates.length) dates = [AI.todayStr(), AI.yesterdayStr()];
      list.innerHTML = '';
      for (const d of dates) {
        const item = document.createElement('button');
        item.className = 'btn';
        item.style.cssText = 'display:flex;justify-content:space-between;align-items:center;width:100%;padding:10px 14px;';
        const isSelected = d === current;
        if (isSelected) item.style.background = 'var(--accent)';
        const label = document.createElement('span');
        label.textContent = formatDateLabel(d);
        const tag = document.createElement('span');
        tag.style.cssText = 'font-size:0.75rem;opacity:0.75;';
        tag.textContent = d;
        item.appendChild(label);
        item.appendChild(tag);
        item.addEventListener('click', () => {
          Settings.save({ topDate: d });
          modal.classList.remove('open');
          if (currentMode === 'top') displayCurrentSubcat();
        });
        list.appendChild(item);
      }
      modal.classList.add('open');
    }

    btn.addEventListener('click', open);
    if (close) close.addEventListener('click', () => modal.classList.remove('open'));
    modal.addEventListener('click', e => { if (e.target === modal) modal.classList.remove('open'); });
  }

  function formatDateLabel(dateStr) {
    try {
      const d = new Date(dateStr + 'T00:00:00');
      const today = new Date(AI.todayStr() + 'T00:00:00');
      const diffDays = Math.round((today - d) / (1000 * 60 * 60 * 24));
      if (diffDays === 0) return 'Today';
      if (diffDays === 1) return 'Yesterday';
      return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    } catch { return dateStr; }
  }

  // IB row: clicking the logo triggers a background refresh (no view re-render,
  // no blinking). While loading, a small spinning icon appears next to the
  // logo. When done, the spinner is replaced with a "show recent" clock icon
  // (pulsing blue) — clicking it switches to live mode and re-renders the
  // articles sorted by most recent.
  let isBackgroundRefreshing = false;
  let hasFreshBackground = false; // true when new data is sitting in cache waiting to be shown

  function showRefreshSpinner() {
    const status = $('#ib-refresh-status');
    const sp = $('#ib-refresh-spinner');
    const rb = $('#ib-recent-btn');
    if (status) status.style.display = 'flex';
    if (sp) sp.style.display = 'inline-flex';
    if (rb) rb.style.display = 'none';
  }
  function showRecentButton() {
    const status = $('#ib-refresh-status');
    const sp = $('#ib-refresh-spinner');
    const rb = $('#ib-recent-btn');
    if (status) status.style.display = 'flex';
    if (sp) sp.style.display = 'none';
    if (rb) rb.style.display = 'inline-flex';
  }
  function hideRefreshStatus() {
    const status = $('#ib-refresh-status');
    if (status) status.style.display = 'none';
  }
  function clearRecentFlag() {
    hasFreshBackground = false;
    hideRefreshStatus();
  }

  // Fetch all sources in the background, update the cache silently. The
  // current view is NOT re-rendered. When done, show the "show recent" button
  // so the user can opt to view the new data.
  async function backgroundRefresh() {
    if (isBackgroundRefreshing) return;
    isBackgroundRefreshing = true;
    showRefreshSpinner();

    try {
      const feeds = FeedManager.getFeeds(currentScope, currentScope === 'nation' ? currentNation : null);
      if (!feeds.length) {
        isBackgroundRefreshing = false;
        hideRefreshStatus();
        return;
      }

      const subs = FeedManager.subcategoriesForScope(currentScope);
      if (!subs.includes(currentSubcat)) currentSubcat = subs[0];

      const perSourceCap = currentMode === 'live' ? 100 : 0;
      const allResults = await Promise.allSettled(feeds.map(f => FeedFetcher.fetchFeed(f, perSourceCap)));

      const groups = {};
      for (let j = 0; j < allResults.length; j++) {
        const result = allResults[j];
        if (result.status === 'fulfilled') {
          for (const a of result.value) {
            a.subcat = a.feedHint || 'politics';
            const cat = a.subcat;
            if (!groups[cat]) groups[cat] = [];
            groups[cat].push(a);
          }
        } else {
          console.warn('Feed failed: ' + feeds[j]?.name, result.reason?.message);
        }
      }

      let allArticles = [];
      for (const cat of Object.keys(groups)) allArticles.push(...groups[cat]);

      const key = scopeKey();
      scopeCache[key] = { articles: allArticles, groups };
      // Reset "Load All" since this is a fresh dataset
      liveAllLoaded = false;
      loadedCount = 0;
      hasFreshBackground = true;
      isBackgroundRefreshing = false;
      showRecentButton();
    } catch (err) {
      console.error('Background refresh failed:', err);
      isBackgroundRefreshing = false;
      hideRefreshStatus();
    }
  }

  // Called when user clicks the "show recent" button. Switches to live mode
  // and re-renders the visible content with the freshly-fetched articles,
  // sorted by most recent first.
  function applyRecentAndShowLive() {
    // Switch to live mode
    currentMode = 'live';
    updateModeButtonActive();
    updateRankControls();
    loadedCount = 0;
    liveAllLoaded = false;
    hasFreshBackground = false;
    hideRefreshStatus();
    // Re-render
    displayCurrentSubcat();
  }

  // Periodic auto-refresh interval (5 minutes). The user can click IB to
  // refresh manually any time. Both manual and auto refresh update the cache
  // silently — the visible page never re-renders. The "show recent" icon
  // appears when fresh data is waiting, and the user clicks it to apply.
  const AUTO_REFRESH_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
  let autoRefreshTimer = null;

  function startAutoRefresh() {
    stopAutoRefresh();
    autoRefreshTimer = setInterval(() => {
      // Don't start another refresh if one is already running, or if the
      // document is hidden (no point refreshing in the background tab).
      if (isBackgroundRefreshing) return;
      if (document.hidden) return;
      backgroundRefresh();
    }, AUTO_REFRESH_INTERVAL_MS);
  }

  function stopAutoRefresh() {
    if (autoRefreshTimer) {
      clearInterval(autoRefreshTimer);
      autoRefreshTimer = null;
    }
  }

  // Reset the auto-refresh timer whenever the user manually clicks IB
  // (so the next auto-refresh is 5 minutes from THEIR click, not from the
  // last auto-refresh).
  function resetAutoRefreshTimer() {
    if (autoRefreshTimer) {
      clearInterval(autoRefreshTimer);
      startAutoRefresh();
    }
  }

  function bindIBRow() {
    const ibBtn = $('#ib-refresh-btn');
    if (ibBtn) {
      ibBtn.addEventListener('click', () => {
        if (isBackgroundRefreshing) return;
        backgroundRefresh();
        resetAutoRefreshTimer();
      });
    }
    const recentBtn = $('#ib-recent-btn');
    if (recentBtn) recentBtn.addEventListener('click', applyRecentAndShowLive);
  }

  function bindSourcesConfig() {
    if (el.sourcesConfigModalClose) el.sourcesConfigModalClose.addEventListener('click', closeSourcesConfigModal);
    if (el.sourcesConfigDone) el.sourcesConfigDone.addEventListener('click', closeSourcesConfigModal);
    if (el.sourcesConfigModal) el.sourcesConfigModal.addEventListener('click', e => { if (e.target === el.sourcesConfigModal) closeSourcesConfigModal(); });
    if (el.sourcesConfigSearch) {
      el.sourcesConfigSearch.addEventListener('input', () => {
        subsConfigFilter = el.sourcesConfigSearch.value;
        renderSourcesConfigTable();
      });
    }
  }

  // AI rank toggle in the IB row. Toggles Top AI <-> Live.
  function bindAiRankBtn() {
    if (el.aiRankBtn) {
      el.aiRankBtn.addEventListener('click', () => toggleTopMode('ai'));
    }
  }

  /* ── Daily AI Rank Scheduler ── */

  let rankSchedulerTimer = null;
  let seedPromise = null;

  function getISTHour() {
    const d = new Date();
    const ist = d.toLocaleString('en-US', { timeZone: 'Asia/Kolkata', hour: 'numeric', hour12: false });
    return parseInt(ist, 10);
  }

  async function rankAllCombos(force = false) {
    if (seedPromise) return seedPromise;
    seedPromise = (async () => {
      const scopes = ['global', 'nation'];
      const subs = FeedManager.subcategories();
      const cutoff = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
      const cutoffStr = cutoff.toISOString().slice(0, 10);
      const today = AI.todayStr();
      const yesterday = AI.yesterdayStr();
      const hour = getISTHour();
      // 8 PM has passed for today → safe to rank today's combos. Otherwise
      // only rank combos where yesterday is ALSO missing (first-time use).
      const pastCutoff = hour >= 20;

      const work = [];
      for (const scope of scopes) {
        const nation = scope === 'nation' ? FeedManager.getSelectedNation() : null;
        const feeds = FeedManager.getFeeds(scope, nation);
        if (!feeds.length) continue;

        const groups = {};
        const results = await Promise.allSettled(feeds.map(f => FeedFetcher.fetchFeed(f, 0)));
        for (const result of results) {
          if (result.status !== 'fulfilled') continue;
          for (const a of result.value) {
            a.subcat = a.feedHint || 'politics';
            const cat = a.subcat;
            if (!groups[cat]) groups[cat] = [];
            groups[cat].push(a);
          }
        }

        for (const subcat of subs) {
          if (!force) {
            const [hasToday, hasYesterday] = await Promise.all([
              AI.loadTopList(today, scope, subcat),
              AI.loadTopList(yesterday, scope, subcat)
            ]);
            if (hasToday) continue;
            if (!pastCutoff && hasYesterday) continue; // wait for 8 PM
          }
          let articles;
          if (subcat === 'all') {
            articles = [];
            for (const cat of Object.keys(groups)) articles.push(...groups[cat]);
          } else {
            articles = groups[subcat] || [];
          }
          articles = FeedFetcher.deduplicate(articles);
          articles = FeedFetcher.filterByDate(articles, cutoffStr, null);
          articles = FeedFetcher.sortByDate(articles);
          if (articles.length < 5) continue;
          work.push({ scope, subcat, articles, date: today });
        }
      }

      if (!work.length) { clearTopListStatus(); return; }

      // Gemini free tier is 15 RPM = 1 call per 4s. Process sequentially with
      // a 4.2s gap so we never hit the rate limit. ~18 combos ≈ 75s total.
      const GAP_MS = 4200;
      for (let i = 0; i < work.length; i++) {
        const { scope, subcat, articles } = work[i];
        setTopListStatus('AI ranking ' + (i + 1) + ' / ' + work.length + ' — ' + scope + '/' + subcat);
        if (i > 0) await new Promise(r => setTimeout(r, GAP_MS));
        try {
          await AI.rankArticles(articles, scope, subcat);
          console.log('[rank] saved', scope + '/' + subcat);
        } catch (e) {
          console.warn('Rank failed for ' + scope + '/' + subcat + ':', e);
          if (e.message && e.message.includes('rate limited')) {
            showAiRateLimitModal();
            // Stop the batch — no point hammering the API while it's limited.
            break;
          }
        }
      }
      clearTopListStatus();
    })();
    try {
      await seedPromise;
    } finally {
      // Keep the resolved promise around so subsequent calls short-circuit.
    }
  }

  function startRankScheduler() {
    if (rankSchedulerTimer) return;
    rankSchedulerTimer = setInterval(() => {
      const hour = getISTHour();
      if (hour === 20) {
        rankAllCombos().catch(e => console.warn('Scheduled ranking failed:', e));
      }
    }, 60000);
  }

  /* ── Settings Modal ── */
  function openSettings() {
    const settings = Settings.load();
    const lang = $('#settings-language');
    if (lang) lang.value = settings.language;
    populateFeedSelects();
    renderCustomFeedList();
    renderSubscriptionList();
    renderFeedHealth();
    openModal('settings', el.modal, () => {
      if (el.feedValidateMsg) el.feedValidateMsg.textContent = '';
    });
  }

  // Render the Feed Health section inside the Settings modal. Shows the
  // current state of the auto-disable toggle, how many sources are
  // currently disabled, and enables the "Re-enable All" button only
  // when there's something to re-enable. Triggered on open AND on
  // every source-health change so the count stays in sync.
  function renderFeedHealth() {
    if (!SourceHealth) return;
    const settings = Settings.load();
    if (el.autoDisableFailingSources) {
      el.autoDisableFailingSources.checked = !!settings.autoDisableFailingSources;
    }
    const tracked = SourceHealth.getTrackedSources();
    const disabled = tracked.filter(s => s.disabled);
    const failing = tracked.filter(s => !s.disabled);
    const count = tracked.length;
    const countEl = el.feedHealthCount;
    const btn = el.reenableAllBtn;
    if (countEl) {
      if (count === 0) {
        countEl.textContent = 'No failing sources tracked yet. Sources are flagged after they fail to load.';
        countEl.className = 'feed-health-count feed-health-count-empty';
      } else {
        const parts = [];
        if (disabled.length) parts.push('<strong>' + disabled.length + '</strong> disabled');
        if (failing.length) parts.push('<strong>' + failing.length + '</strong> with ' + (SourceHealth.WARN_AT || 2) + '+ failures');
        countEl.innerHTML = parts.join(' · ');
        countEl.className = 'feed-health-count';
      }
    }
    if (btn) {
      btn.disabled = disabled.length === 0;
    }
  }

  function closeSettings() {
    closeModal('settings');
  }

  function saveSettings() {
    const lang = $('#settings-language')?.value || 'en';
    Settings.save({ language: lang });
    syncSettingsToCloud();
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
    // Feed Health controls (auto-disable toggle + re-enable-all button)
    if (el.autoDisableFailingSources) {
      el.autoDisableFailingSources.addEventListener('change', () => {
        Settings.save({ autoDisableFailingSources: !!el.autoDisableFailingSources.checked });
        syncSettingsToCloud();
        // Re-evaluate every tracked source's disabled flag against the
        // new setting. Flipping the toggle ON will disable anything
        // already at/above the threshold; flipping OFF leaves existing
        // disables in place (the user must explicitly re-enable).
        if (SourceHealth) SourceHealth.syncDisabledState();
        // Re-render so the count text and re-enable button reflect the
        // new state.
        renderFeedHealth();
        // Also clear scope caches so the next fetch respects the
        // current disabled-state immediately — otherwise the user
        // would have to manually refresh after flipping the toggle.
        for (const k of Object.keys(scopeCache)) scopeCache[k] = null;
      });
    }
    if (el.reenableAllBtn) {
      el.reenableAllBtn.addEventListener('click', () => {
        if (!SourceHealth) return;
        const count = SourceHealth.reEnableAll();
        renderFeedHealth();
        if (count > 0) {
          for (const k of Object.keys(scopeCache)) scopeCache[k] = null;
        }
      });
    }
    // Keep Settings → Feed Health in sync with live fetches. Whenever
    // a source's failure count changes, refresh the count text and
    // re-enable button state — even if the modal is already open.
    if (window.SourceHealth && typeof SourceHealth.onChange === 'function') {
      SourceHealth.onChange(() => {
        if (el.modal && el.modal.classList.contains('open')) renderFeedHealth();
        // If the Activity → Failed sources tab is currently visible,
        // re-render it so the row pills / buttons reflect the change.
        if (el.activityModal && el.activityModal.classList.contains('open')) {
          const activeTab = document.querySelector('.activity-tab.active');
          if (activeTab && activeTab.dataset.actab === 'failed') {
            renderActivityTab('failed');
          }
        }
      });
    }
    bindIBRow();
    const collapseBtn = $('#collapse-btn');
    const bottomBar = $('#bottom-bar');
    if (collapseBtn && bottomBar) {
      collapseBtn.addEventListener('click', () => {
        bottomBar.classList.toggle('collapsed');
        sizeReelsContainer();
      });
    }
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
  }

  /* ── Activity ── */
  function openActivity() {
    openModal('activity', el.activityModal);
    renderActivityTab('history');
  }

  function closeActivity() { closeModal('activity'); }

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
    } else if (tab === 'failed') {
      // Render Failed sources via a dedicated renderer — it pulls from
      // SourceHealth, not from the article activity store, so the logic
      // doesn't fit the generic "items" pipeline below.
      renderActivityFailed(container);
      return;
    }

    if (!filtered.length) {
      container.innerHTML = '<div class="activity-empty">No ' + tab + ' items yet.</div>';
      return;
    }

    // Use currentArticles to find titles/sources for links (in case the
    // article is still in the current feed). Otherwise, fall back to the
    // articleTitle / articleSource that was stored when the user liked/flagged
    // the article — so 1-year-old activity still shows proper titles.
    const articleMap = {};
    if (currentArticles) currentArticles.forEach(a => articleMap[a.link] = a);

    container.innerHTML = filtered.map(([link, data]) => {
      const article = articleMap[link];
      // Prefer the live article, fall back to stored data
      const title = article?.title || data.articleTitle || link;
      const source = article?.source || data.articleSource || '';
      const time = data.viewed ? formatDateShort(data.viewed) : '';
      const badges = [];
      if (data.like) badges.push('<span class="ai-badge" style="background:var(--accent-dim);color:#fff">&#x1F44D;</span>');
      if (data.dislike) badges.push('<span class="ai-badge" style="background:var(--text-tertiary);color:#fff">&#x1F44E;</span>');
      if (data.flag) badges.push('<span class="ai-badge" style="background:' + (FLAG_COLORS[data.flag] || 'var(--text-tertiary)') + ';color:#000">' + data.flag + '</span>');
      // Show a small indicator if this article is no longer in the current feed
      const isArchived = !article;
      return '<div class="activity-item' + (isArchived ? ' activity-archived' : '') + '">' +
        '<div class="ai-title" data-link="' + encodeURIComponent(link) + '">' + escHtml(title) +
          (source ? '<div class="ai-source">' + escHtml(source) + '</div>' : '') +
        '</div>' +
        '<div class="ai-meta">' +
          (time ? '<span>' + time + '</span>' : '') +
          (isArchived ? '<span class="ai-archived-badge" title="No longer in current feed">archived</span>' : '') +
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

  // Failed Sources tab in Activity modal. Lists every RSS source the
  // health tracker has recorded at least one failure for — including
  // currently disabled ones (highlighted) and ones still below the
  // threshold (so the user can see the buildup). Each row has a
  // "Re-enable" button that resets the source's counter.
  function renderActivityFailed(container) {
    if (!SourceHealth) {
      container.innerHTML = '<div class="activity-empty">Source health tracking unavailable.</div>';
      return;
    }
    const tracked = SourceHealth.getVisibleSources();
    if (!tracked.length) {
      container.innerHTML = '<div class="activity-empty">No failed sources right now. ' +
        'Sources appear here after they fail to load several times in a row.</div>';
      return;
    }
    // Try to enrich each row with a friendly feed name + region by
    // looking up the URL in the subscribable list and any custom feeds.
    const subFeeds = FeedManager.getSubscribableFeeds();
    const customFeeds = FeedManager.getCustomFeeds();
    const nameByUrl = {};
    for (const f of subFeeds) if (f.url) nameByUrl[f.url] = { name: f.name, region: f.region, hint: f.hint };
    for (const f of customFeeds) if (f.url) nameByUrl[f.url] = { name: f.name, region: f.scope === 'nation' ? (FeedManager.getNations()[f.nation] || f.nation) : 'Custom', hint: f.subcat };

    container.innerHTML = tracked.map(s => {
      const meta = nameByUrl[s.url] || {};
      const title = meta.name || (() => { try { return new URL(s.url).hostname; } catch { return s.url; } })();
      const region = meta.region || '';
      const isDisabled = !!s.disabled;
      const failures = s.failures || 0;
      const threshold = (SourceHealth.FAILURE_THRESHOLD || 5);
      const lastErr = s.lastError || 'Unknown error';
      const lastFail = s.lastFailureAt ? formatDateShort(s.lastFailureAt) : '';
      return '<div class="failed-item' + (isDisabled ? ' failed-item-disabled' : '') + '">' +
        '<div class="failed-row-main">' +
          '<div class="failed-title">' + escHtml(title) +
            (isDisabled ? '<span class="failed-disabled-pill" title="Skipped on every fetch">disabled</span>' :
              '<span class="failed-count-pill">' + failures + ' / ' + threshold + ' failures</span>') +
          '</div>' +
          (region ? '<div class="failed-source">' + escHtml(region) + '</div>' : '') +
          '<div class="failed-url" title="' + escAttr(s.url) + '">' + escHtml(s.url) + '</div>' +
          '<div class="failed-error">Last error: ' + escHtml(lastErr) + (lastFail ? ' · ' + lastFail : '') + '</div>' +
        '</div>' +
        '<div class="failed-actions">' +
          (isDisabled
            ? '<button class="btn btn-primary failed-reenable-btn" data-url="' + escAttr(s.url) + '">Re-enable</button>'
            : '<button class="btn failed-reenable-btn" data-url="' + escAttr(s.url) + '" title="Reset failure counter">Reset counter</button>') +
        '</div>' +
      '</div>';
    }).join('');

    container.querySelectorAll('.failed-reenable-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const url = btn.dataset.url;
        SourceHealth.reEnable(url);
        // Re-render in place so the row updates immediately and the
        // counter pill changes from "X/5" to (gone, once we filter
        // out fully-reset entries below the WARN_AT threshold).
        renderActivityFailed(container);
        // Also refresh the Settings → Feed Health section if it's open.
        if (el.modal && el.modal.classList.contains('open')) renderFeedHealth();
      });
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
    el.feedCustomList.innerHTML = '<ul class="feed-list">' + feeds.map(f => {
      const isG = f.isGoogleNews || (f.url && f.url.includes('news.google.com'));
      return '<li' + (isG ? ' class="feed-google"' : '') + '><div><span class="feed-source">' + f.name +
        (isG ? ' <span class="sub-google-badge">Google</span>' : '') +
        '</span><span class="feed-cat">' +
        (f.scope === 'nation' ? (FeedManager.getNations()[f.nation] || f.nation) + ' / ' : 'Global / ') +
        FeedManager.subcatLabel(f.subcat, 'global') + '</span></div>' +
        '<span class="feed-remove" data-url="' + f.url + '">Remove</span></li>';
    }).join('') + '</ul>';
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

  // Settings → Subscriptions now shows a single "Configure Sources" button
  // that opens a modal with a search bar and a checkbox table of all sources.
  // This replaces the previous long inline list.
  function renderSubscriptionList() {
    const container = $('#subscription-list');
    if (!container) return;
    const allFeeds = FeedManager.getSubscribableFeeds();
    const subscribed = FeedManager.getSubscribedFeeds();

    if (allFeeds.length === 0) {
      container.innerHTML = '<p style="color:var(--text-tertiary);font-size:0.85rem;padding:12px;background:var(--bg-tertiary);border-radius:var(--radius);">No feeds available yet. Add custom feeds below to get started.</p>';
      return;
    }

    // One-time first-run init
    const hasUserToggled = localStorage.getItem('newsfeeds_subscriptions_initialized') === '1';
    if (!hasUserToggled && subscribed.length === 0) {
      const allUrls = allFeeds.filter(f => f.hasRss && f.url).map(f => f.url);
      FeedManager.saveSubscribedFeeds(allUrls);
    }

    const subscribedCount = FeedManager.getSubscribedFeeds().length;
    const totalCount = allFeeds.filter(f => f.hasRss && f.url).length;

    container.innerHTML =
      '<div class="subs-config-row">' +
        '<div class="subs-config-info">' +
          '<div class="subs-config-title">Source Subscriptions</div>' +
          '<div class="subs-config-meta">' + subscribedCount + ' of ' + totalCount + ' sources enabled</div>' +
        '</div>' +
        '<button class="btn btn-primary" id="open-subs-config">Configure Sources</button>' +
      '</div>' +
      '<p class="subs-config-hint">Subscription changes apply on next fetch. Close settings to refresh.</p>';

    const btn = $('#open-subs-config');
    if (btn) btn.addEventListener('click', openSourcesConfigModal);
  }

  // Modal state for sources config
  let subsConfigFilter = '';
  let subsConfigRegion = 'all';

  function openSourcesConfigModal() {
    if (!$('#sources-config-modal')) return;
    subsConfigFilter = '';
    subsConfigRegion = 'all';
    openModal('sourcesConfig', $('#sources-config-modal'));
    renderSourcesConfigTable();
  }

  function closeSourcesConfigModal() {
    closeModal('sourcesConfig');
  }

  function renderSourcesConfigTable() {
    const body = $('#sources-config-body');
    if (!body) return;
    const allFeeds = FeedManager.getSubscribableFeeds();
    const subscribed = new Set(FeedManager.getSubscribedFeeds());

    // Apply filters
    const q = (subsConfigFilter || '').toLowerCase().trim();
    const grouped = {};
    for (const f of allFeeds) {
      if (!f.hasRss || !f.url) continue;
      if (subsConfigRegion !== 'all' && f.region !== subsConfigRegion) continue;
      if (q) {
        const hay = ((f.name || '') + ' ' + (f.region || '') + ' ' + (f.lang || '')).toLowerCase();
        if (!hay.includes(q)) continue;
      }
      const region = f.region || 'Other';
      if (!grouped[region]) grouped[region] = [];
      grouped[region].push(f);
    }

    // Build region selector
    const regions = [...new Set(allFeeds.filter(f => f.hasRss).map(f => f.region || 'Other'))].sort();
    const regionSelector =
      '<div class="scm-regions">' +
        '<button class="scm-region-btn' + (subsConfigRegion === 'all' ? ' active' : '') + '" data-region="all">All</button>' +
        regions.map(r => '<button class="scm-region-btn' + (subsConfigRegion === r ? ' active' : '') + '" data-region="' + escAttr(r) + '">' + escHtml(r) + '</button>').join('') +
      '</div>';

    // Build source rows
    let rowsHtml = '';
    for (const [region, feeds] of Object.entries(grouped)) {
      rowsHtml += '<tr class="scm-region-header"><td colspan="4">' + escHtml(region) + '</td></tr>';
      for (const f of feeds) {
        const checked = subscribed.has(f.url);
        const isG = f.isGoogleNews || (f.url && f.url.includes('news.google.com'));
        rowsHtml +=
          '<tr class="scm-row' + (checked ? ' scm-active' : '') + (isG ? ' scm-google' : '') + '">' +
            '<td class="scm-check"><input type="checkbox" class="scm-checkbox" data-url="' + escAttr(f.url) + '"' + (checked ? ' checked' : '') + '></td>' +
            '<td class="scm-name">' + escHtml(f.name) + (isG ? ' <span class="sub-google-badge">Google</span>' : '') + '</td>' +
            '<td class="scm-cat">' + escHtml(f.hint || '') + '</td>' +
            '<td class="scm-lang">' + (f.lang || 'en').toUpperCase() + '</td>' +
          '</tr>';
      }
    }

    if (!rowsHtml) {
      rowsHtml = '<tr><td colspan="4" style="text-align:center;padding:24px;color:var(--text-tertiary);">No sources match your search.</td></tr>';
    }

    body.innerHTML =
      regionSelector +
      '<table class="scm-table">' +
        '<thead><tr><th></th><th>Name</th><th>Category</th><th>Lang</th></tr></thead>' +
        '<tbody>' + rowsHtml + '</tbody>' +
      '</table>';

    // Bind region selector
    body.querySelectorAll('.scm-region-btn').forEach(b => {
      b.addEventListener('click', () => {
        subsConfigRegion = b.dataset.region;
        renderSourcesConfigTable();
      });
    });

    // Bind checkboxes
    body.querySelectorAll('.scm-checkbox').forEach(cb => {
      cb.addEventListener('change', () => {
        FeedManager.toggleSubscription(cb.dataset.url);
        localStorage.setItem('newsfeeds_subscriptions_initialized', '1');
        syncSubscriptionsToCloud();
        // Lightweight refresh of just the count in the settings page
        const subscribedCount = FeedManager.getSubscribedFeeds().length;
        const meta = document.querySelector('.subs-config-meta');
        if (meta) {
          const total = document.querySelectorAll('.scm-checkbox').length;
          meta.textContent = subscribedCount + ' of ' + total + ' sources enabled';
        }
      });
    });
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

    // Render the "Other sources report" panel inside the article modal.
    // It's a sibling of #article-modal-summary and is empty unless this
    // article is part of a cluster with conflicting facts (numeric OR
    // claim/narrative).
    const conflictSection = $('#article-modal-conflicts');
    if (conflictSection) {
      const c = article._conflicts;
      if (c && c.isConflicting) {
        const hasClaims = c.conflicts.some(g => g.metric === 'claim');
        const headerText = hasClaims && c.conflicts.every(g => g.metric === 'claim')
          ? 'Other sources report conflicting claims'
          : 'Other sources report different figures or claims';
        conflictSection.innerHTML =
          '<div class="amc-header"><span class="amc-warn">⚠</span> ' + headerText + '</div>' +
          '<div class="amc-body">' +
            c.conflicts.map(group => {
              const metricLabel = group.metric === 'claim'
                ? (group.subject ? 'About ' + escHtml(group.subject) : 'Claim')
                : escHtml(group.metric);
              return '<div class="amc-row">' +
                '<div class="amc-metric">' + metricLabel + '</div>' +
                group.detail.map(g =>
                  '<div class="amc-value-group">' +
                    '<span class="amc-value">' + escHtml(g.value) + '</span>' +
                    '<span class="amc-sources">— ' + g.articles.map(a => escHtml(a.source || 'Unknown')).join(', ') + '</span>' +
                  '</div>'
                ).join('') +
              '</div>';
            }).join('') +
          '</div>';
        conflictSection.style.display = 'block';
      } else {
        conflictSection.style.display = 'none';
        conflictSection.innerHTML = '';
      }
    }

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

    openModal('article', el.articleModal);
  }

  function closeArticleModal() { closeModal('article'); }

  function renderCurrentList() {
    const key = scopeKey();
    const cached = scopeCache[key];
    if (!cached) return;
    const articles = getFilteredArticles(currentSubcat, cached);
    // Re-run conflict detection on the filtered list so cards keep their
    // badges after search / source filter / sort changes.
    try {
      const conflictMap = AI.detectConflicts(articles);
      for (const a of articles) {
        const c = conflictMap.get(a.link);
        if (c) a._conflicts = c;
        else delete a._conflicts;
      }
    } catch (e) { /* keep stale badges silently */ }
    renderTranslated(articles);
  }

  async function openArticleReader(url, title) {
    el.sourceModalTitle.textContent = title || 'Original Article';
    openModal('source', el.sourceModal, () => {
      // Reset the reader view so the next open doesn't show stale content.
      const content = $('#reader-content');
      if (content) { content.innerHTML = ''; content.style.display = 'none'; }
      const loading = $('#reader-loading');
      if (loading) loading.style.display = 'flex';
      const fallback = $('#source-fallback');
      if (fallback) fallback.style.display = 'none';
    });

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
    return new Promise((resolve) => {
      const img = new Image();
      let done = false;
      // 30s timeout: large image bytes can take a while over slow networks.
      const timer = setTimeout(() => { if (!done) { done = true; resolve(null); } }, 30000);
      img.onload = () => { if (!done) { done = true; clearTimeout(timer); resolve(img); } };
      img.onerror = () => { if (!done) { done = true; clearTimeout(timer); resolve(null); } };
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
    // Try several CORS proxies in order. Each one fetches the image bytes
    // server-side and returns them with proper CORS headers, which we convert
    // to a data URL so the Image element can load it without crossOrigin
    // restrictions (and the canvas won't be tainted).
    const proxies = [
      // images.weserv.nl / wsrv.nl are purpose-built image proxies with
      // proper CORS + image transformation. These are the most reliable.
      u => 'https://wsrv.nl/?url=' + encodeURIComponent(u) + '&output=jpg',
      u => 'https://images.weserv.nl/?url=' + encodeURIComponent(u) + '&output=jpg',
      // Fallbacks: generic CORS proxies (may rate-limit or go down)
      u => 'https://corsproxy.io/?url=' + encodeURIComponent(u),
      u => 'https://api.codetabs.com/v1/proxy/?quest=' + encodeURIComponent(u)
    ];
    // Timeout helper: use AbortSignal.timeout when available, else wrap
    // fetch in a manual timeout via Promise.race.
    async function fetchWithTimeout(target, ms) {
      if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) {
        return fetch(target, { signal: AbortSignal.timeout(ms) });
      }
      return Promise.race([
        fetch(target),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))
      ]);
    }
    for (const makeUrl of proxies) {
      try {
        const target = makeUrl(url);
        const resp = await fetchWithTimeout(target, 15000);
        if (!resp.ok) continue;
        const blob = await resp.blob();
        if (!blob || blob.size === 0) continue;
        const dataUrl = await new Promise(r => {
          const fr = new FileReader();
          fr.onload = () => r(fr.result);
          fr.onerror = () => r(null);
          fr.readAsDataURL(blob);
        });
        if (!dataUrl) continue;
        const img = await loadImage(dataUrl);
        if (img) {
          const proxyHost = (target.split('?')[0] || '').replace(/^https?:\/\//, '');
          console.log('[Share] Image loaded via proxy:', proxyHost);
          return img;
        }
      } catch (e) {
        const proxyHost = (target.split('?')[0] || '').replace(/^https?:\/\//, '');
        console.warn('[Share] Proxy failed:', proxyHost, e && e.message);
      }
    }
    return null;
  }

  // Generate a share image. includeImage=true will fetch and embed the
  // source image; includeImage=false will produce a text-only card.
  async function handleShareImage(article, btn, includeImage) {
    btn && btn.classList.add('btn-busy');
    try {
      const hasThumb = article.imageUrl && article.imageUrl.startsWith('http');
      const fullSummary = Settings.get('showDescription') ? cleanSummary(stripHtml(article.summary)) : '';
      const titleColor = TITLE_COLORS[Math.floor(Math.random() * TITLE_COLORS.length)];

      let img = null;
      let imgW = 0, imgH = 0;
      // Only attempt to load the source image when the caller asked for it
      // AND the article actually has an image. We try multiple image sources in
      // order of reliability:
      //   1. The RSS-provided article.imageUrl (most reliable — we know it exists
      //      because the "with image" button is only shown when hasThumb is true)
      //   2. The OG image fetched from the article's HTML (sometimes a higher-res
      //      version or a different image entirely)
      // Each candidate is fed to loadImageWithFallback which tries multiple
      // CORS proxies. If the first one fails, we move to the next.
      if (includeImage && hasThumb) {
        // Build a list of candidate image URLs to try, in priority order.
        const candidates = [];
        // 1. Enhanced version of the RSS image (full-size)
        const enhanced = enhanceImageUrl(article.imageUrl);
        candidates.push(enhanced || article.imageUrl);
        // 2. Raw RSS image (fallback if enhanced URL fails)
        if (enhanced) candidates.push(article.imageUrl);
        // 3. OG image from the article's HTML (sometimes a different image)
        try {
          const og = await fetchOGImage(article.link);
          if (og && !candidates.includes(og)) candidates.push(og);
        } catch {}

        console.log('[Share] Image candidates:', candidates.length, 'hasThumb:', hasThumb);
        for (const candidate of candidates) {
          console.log('[Share] Trying:', candidate);
          const loaded = await loadImageWithFallback(candidate);
          if (loaded) {
            img = loaded;
            imgW = img.naturalWidth;
            imgH = img.naturalHeight;
            console.log('[Share] Image loaded:', imgW, 'x', imgH, 'from', candidate);
            break;
          }
        }
        if (!img) {
          console.warn('[Share] All image candidates failed. Falling back to text-only.');
        }
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

      // Image dimensions — edge-to-edge (full canvas width, no left/right padding).
      // High-res sources are downscaled with high-quality smoothing; low-res sources are
      // upscaled to fill the width (accepting some softness for very small thumbnails).
      let imgDrawW = 0, imgDrawH = 0;
      let imgBlockH = 0;
      // Header area above the image for the IB block (only when image is present)
      const ibHeaderH = hasImg ? Math.round(W * 0.08) : 0;
      if (hasImg) {
        const maxW = W;
        const maxH = imgMaxAreaH - ibHeaderH;
        const scale = Math.min(maxW / imgW, maxH / imgH);
        imgDrawW = Math.round(imgW * scale);
        imgDrawH = Math.round(imgH * scale);
        imgBlockH = ibHeaderH + imgDrawH;
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

      // Image (if any) — edge-to-edge (full width, no left/right padding)
      let imageTopY = 0;
      if (hasImg) {
        const drawX = Math.round((W - imgDrawW) / 2);
        const drawY = cursorY + ibHeaderH;
        imageTopY = drawY;
        const imgRadius = 0;

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

      // Source label (uppercase, red) on the left, published date/time on the right
      if (article.source) {
        ctx.fillStyle = '#ff2929';
        ctx.font = '700 ' + sourceFontSize + 'px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, sans-serif';
        ctx.textBaseline = 'alphabetic';
        ctx.textAlign = 'left';
        ctx.fillText(article.source.toUpperCase(), PAD, cursorY + sourceFontSize);

        // Published date & time on the right side of the same row (in IST)
        if (article.pubDate) {
          const pubDateText = formatDateIST(article.pubDate);
          ctx.fillStyle = 'rgba(230, 237, 243, 0.65)';
          ctx.font = '500 ' + sourceFontSize + 'px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, sans-serif';
          ctx.textAlign = 'right';
          ctx.fillText(pubDateText, W - PAD, cursorY + sourceFontSize);
          ctx.textAlign = 'left';
        }

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
    closeModal('source');
  }

  function bindArticleClicks() {
    el.main.addEventListener('click', e => {
      if (e.target.closest('.reels-container')) return;
      // Ranked-kicker click → toggle "where it's trending" details (smooth).
      const kicker = e.target.closest('.ranked-kicker[data-toggle-details]');
      if (kicker) {
        e.stopPropagation();
        const details = kicker.nextElementSibling;
        if (details && details.classList.contains('ranked-details')) {
          const expanded = details.classList.toggle('expanded');
          details.setAttribute('aria-hidden', expanded ? 'false' : 'true');
          kicker.setAttribute('aria-expanded', expanded ? 'true' : 'false');
        }
        return;
      }
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
        if (e.key === 'Escape') { exitReelsFromBack(); e.preventDefault(); return; }
      }
      if (e.key === 'Escape') {
        // Use the same close path the back button does so Escape and
        // back-press are interchangeable from the user's perspective.
        if (el.hardRefreshModal && el.hardRefreshModal.classList.contains('open')) closeHardRefreshModal();
        else if (el.sourceModal.classList.contains('open')) closeSourceModal();
        else if (el.commentsPage && el.commentsPage.style.display !== 'none') closeSubView('comments');
        else if (el.articleModal.classList.contains('open')) closeArticleModal();
        else if (el.modal.classList.contains('open')) closeSettings();
      }
    });
  }

  function setTopListStatus(text) {
    const ov = $('#processing-overlay');
    const tx = $('#processing-text');
    if (ov) ov.classList.remove('processing-hidden');
    if (tx) tx.textContent = text || 'Loading…';
  }
  function clearTopListStatus() {
    const ov = $('#processing-overlay');
    if (ov) ov.classList.add('processing-hidden');
  }

  // Show the rate-limit modal at most once per "session" (one click or one
  // top-mode entry). The user dismisses it; subsequent 429s during the same
  // run are silent (logged only).
  let rateLimitModalShown = false;
  function showAiRateLimitModal() {
    if (rateLimitModalShown) return;
    rateLimitModalShown = true;
    const m = $('#ai-rate-limit-modal');
    if (m) m.classList.add('open');
  }
  function resetRateLimitFlag() { rateLimitModalShown = false; }

  // Soft inline banner shown when the AI ranking service is unavailable
  // and we fall back to the deterministic analyzer. One per page load.
  let aiOfflineBannerShown = false;
  function showAiOfflineBanner() {
    if (aiOfflineBannerShown) return;
    aiOfflineBannerShown = true;
    if (document.getElementById('ai-offline-banner')) return;
    const bar = document.createElement('div');
    bar.id = 'ai-offline-banner';
    bar.innerHTML =
      '<span>🤖 <strong>AI ranking offline</strong> — showing deterministic keyword ranking (TF-IDF + recency + buzz).</span>' +
      '<button id="ai-offline-dismiss" aria-label="Dismiss">×</button>';
    document.body.appendChild(bar);
    document.getElementById('ai-offline-dismiss').onclick = () => bar.remove();
  }
  function bindAiRateLimitModal() {
    const m = $('#ai-rate-limit-modal');
    if (!m) return;
    const close = $('#ai-rate-limit-modal-close');
    const ok = $('#ai-rate-limit-modal-ok');
    if (close) close.addEventListener('click', () => m.classList.remove('open'));
    if (ok) ok.addEventListener('click', () => m.classList.remove('open'));
    m.addEventListener('click', e => { if (e.target === m) m.classList.remove('open'); });
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
      // Pull any cloud-synced preferences for this user
      pullSettingsFromCloud();
    } else {
      if (btn) btn.style.display = '';
      if (userDiv) userDiv.style.display = 'none';
      if (avatar) avatar.removeAttribute('src');
      // Close dropdown if open
      const dropdown = $('#auth-dropdown');
      if (dropdown) dropdown.style.display = 'none';
    }
  }

  /* ── Cloud Sync of Settings (Supabase user_metadata) ── */
  let cloudSyncTimer = null;

  function pullSettingsFromCloud() {
    if (!currentUser) return;
    const meta = currentUser.user_metadata || {};
    // Pull subscriptions
    if (Array.isArray(meta.subscriptions)) {
      FeedManager.saveSubscribedFeeds(meta.subscriptions);
      localStorage.setItem('newsfeeds_subscriptions_initialized', '1');
    }
    // Pull settings (articlesPerPage, language, showDescription)
    const cloudSettings = meta.app_settings;
    if (cloudSettings && typeof cloudSettings === 'object') {
      Settings.save(cloudSettings);
    }
  }

  function pushSettingsToCloud() {
    if (!currentUser) return;
    // Debounce to avoid hammering the API on every checkbox change
    clearTimeout(cloudSyncTimer);
    cloudSyncTimer = setTimeout(async () => {
      try {
        const client = SupabaseStore.getClient();
        const subs = FeedManager.getSubscribedFeeds();
        const appSettings = Settings.load();
        const { data, error } = await client.auth.updateUser({
          data: {
            subscriptions: subs,
            app_settings: appSettings
          }
        });
        if (error) {
          console.warn('Cloud sync failed:', error.message);
          return;
        }
        // Refresh currentUser so subsequent pulls see the new metadata
        if (data?.user) currentUser = data.user;
        console.log('[CloudSync] Pushed', subs.length, 'subscriptions + settings to Supabase');
      } catch (e) {
        console.warn('Cloud sync failed:', e?.message || e);
      }
    }, 600);
  }

  function syncSubscriptionsToCloud() {
    pushSettingsToCloud();
  }
  function syncSettingsToCloud() {
    pushSettingsToCloud();
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
    openModal('auth', $('#auth-modal'), () => {
      // Reset state when the auth modal closes (whether via X or back).
      setTimeout(() => {
        showAuthMsg('', null);
        clearInputErrors();
      }, 200);
    });
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
    closeModal('auth');
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
    openModal('changeName', $('#change-name-modal'));
    setTimeout(() => input?.focus(), 100);
  }
  function closeChangeNameModal() {
    closeModal('changeName');
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
    openModal('changePassword', $('#change-password-modal'));
    setTimeout(() => document.getElementById('change-password-current')?.focus(), 100);
  }
  function closeChangePasswordModal() {
    closeModal('changePassword');
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
    openModal('changeAvatar', $('#change-avatar-modal'), () => {
      pendingAvatarFile = null;
    });
  }
  function closeChangeAvatarModal() {
    closeModal('changeAvatar');
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
    // Register with the back-button stack as its OWN frame (newFrame:true)
    // so the article modal (which is its own frame from the previous back
    // press) stays open underneath — back closes the comments page first,
    // then back again closes the article modal.
    openSubView('comments', closeCommentsPage, { newFrame: true });
  }

  function closeCommentsPage() {
    if (el.commentsPage) el.commentsPage.style.display = 'none';
    commentsContextArticle = null;
    commentsReplyToId = null;
    hideReplyPreview();
    // With the new frame-based back-button stack, the article modal
    // is in its own frame so it stays visible automatically when the
    // comments page closes. We only need to re-show it explicitly if
    // it was hidden by something OTHER than the subView system (e.g.
    // a previous-version close that toggled .open off).
    if (commentsPreviousWasArticleModal && el.articleModal && !el.articleModal.classList.contains('open')) {
      commentsPreviousWasArticleModal = false;
      el.articleModal.classList.add('open');
    } else {
      commentsPreviousWasArticleModal = false;
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
    openModal('deleteComment', el.deleteCommentModal, () => {
      // If the user closes without confirming, drop the pending id.
      // The actual delete handler resets this to null on success.
    });
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
    closeModal('deleteComment');
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

    // Comments page — route the in-app back button through the same
    // closeSubView path that popstate uses, so a click and a browser
    // back press behave identically (both consume the pushed state).
    if (el.commentsBackBtn) el.commentsBackBtn.addEventListener('click', () => closeSubView('comments'));
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
      closeModal('deleteComment');
    });
    const delClose = $('#delete-comment-modal-close');
    if (delClose) delClose.addEventListener('click', () => {
      commentsPendingDeleteId = null;
      closeModal('deleteComment');
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
    // Resume any article-archive queue from a previous session.
    // This must happen AFTER SupabaseStore is ready (the archive
    // uses SupabaseStore.getClient()) and after FeedManager is
    // loaded (the archive looks up feed lang by URL).
    if (window.ArticleArchive && ArticleArchive.init) ArticleArchive.init();
    bindAuth();

    renderTopTabs();
    bindTopTabs();
    renderSubTabs();
    bindSubTabs();
    bindModeToggle();
    bindKeywordRankBtn();
    bindViewToggle();
    bindLangSelect();
    bindSearch();
    bindFilterSort();
    bindFilterToggles();
    bindSettings();
    bindActivity();
    bindArticleClicks();
    bindFeedControls();
    bindTopDate();
    bindSourcesConfig();
    bindAiRankBtn();
    bindAiRateLimitModal();
    await renderContent();

    // Start periodic auto-refresh — fetches silently in the background
    // every 5 minutes. The page never re-renders automatically; user clicks
    // the "show recent" icon to apply the fresh data.
    startAutoRefresh();
    window.addEventListener('beforeunload', stopAutoRefresh);

    // Init rank controls: top-date picker + IB-block rank buttons.
    // Both start hidden (live mode is the default).
    updateRankControls();

    // Start AI rank scheduler (checks IST time every 60s, fires at 8PM)
    startRankScheduler();
  }

  init();
})();
