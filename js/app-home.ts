// @ts-nocheck
const APP_VERSION = 30;

(async () => {
  const $ = (sel, ctx = document) => ctx.querySelector(sel);
  const $$ = (sel, ctx = document) => [...ctx.querySelectorAll(sel)];
  console.log('[NewsFeeds] App version: ' + APP_VERSION);

  let currentScope = 'global';
  let currentNation = FeedManager.getSelectedNation();
  let currentSection = 'feeds';
  let currentSubcat = 'all';
  let currentMode = 'live';
  let currentRankType = 'ai'; // legacy — kept for compatibility; always ignored
  let currentView = 'list';
  let sourceFilter = 'all';
  let scopeCache = {};
  let isFetching = false;
  let currentArticles = [];
  let loadedCount = 0;
  // Monotonically increasing token reserved for future race protection
  // (kept for compatibility — Live is the only mode now).
  let pendingModeSwitch = 0;
  // Token used by bindViewToggle to guard against rapid double-clicks
  // on the cards/list toggle. The first click increments the token
  // and schedules a setTimeout; if a second click fires before that
  // timer resolves, the second click increments the token again and
  // the first click's render is dropped (its finally-block sees the
  // mismatched token and skips clearTopListStatus). This keeps the
  // processing overlay from getting "stuck" when the user mashes
  // the toggle.
  let pendingViewSwitch = 0;

  /* Expose a small slice of state to the analyze-modal module without
   * un-IIFE-ing the rest of the app. The dashboard needs to walk
   * every scope cache to collect articles about a subject, and
   * keeping the cache inside the closure is otherwise unreachable.
   *
   * `openModal` / `closeModal` are also exposed so analyze-modal.js
   * (loaded earlier in the script tag chain) can push its own modals
   * onto the same back-stack as the rest of the app.
   */
  window.appState = {
    get scopeCache() { return scopeCache; },
    get currentMode() { return currentMode; },
    get currentScope() { return currentScope; },
    get currentNation() { return currentNation; },
    get currentSection() { return currentSection; },
    get currentSubcat() { return currentSubcat; },
    get currentUser() { return currentUser; },
    openModal,
    closeModal,
    pushFrame(id) { pushedFrameStack.push(id); },
    pushState(state) { pushedStateStack.push(state); },
    dropPushedFrame(id) {
      const idx = pushedFrameStack.lastIndexOf(id);
      if (idx >= 0) {
        pushedFrameStack.splice(idx, 1);
        for (let i = pushedStateStack.length - 1; i >= 0; i--) {
          if (pushedStateStack[i] && pushedStateStack[i].ibFrame === id) {
            pushedStateStack.splice(i, 1);
            break;
          }
        }
      }
    },
    // True while we are inside the popstate handler. The dashboard
    // close path uses this to decide whether to call history.back()
    // (it shouldn't — the popstate is already consuming the state).
    popIsInFlight() { return popstateBusy; },
    get nextFrameId() { return ++nextFrameId; }
  };

  /* Persist state variables to AppState so the next page load
   * (or the dashboard page, or any other page that imports
   * shared-state.js) can restore them. Called automatically
   * after every state mutation. */
  function _persist() {
    AppState.set('currentScope', currentScope);
    AppState.set('currentNation', currentNation);
    AppState.set('currentSection', currentSection);
    AppState.set('currentSubcat', currentSubcat);
    AppState.set('currentMode', currentMode);
    AppState.set('currentView', currentView);
    AppState.set('currentSort', currentSort);
    AppState.set('sourceFilter', sourceFilter);
  }

  /* ── Modal / "deeper view" history stack ──
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
  // Parallel stack of the state objects we pushed via history.pushState.
  // The popstate handler needs to know what state we just LEFT (so it
  // can dispatch correctly — e.g. close the dashboard when the user
  // backs out of an ibDashboard state), which is the top of THIS stack.
  // It is independent of pushedFrameStack because the dashboard
  // pushes a state without going through beginNewFrame.
  const pushedStateStack = [];
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
  // history changes we didn't make (e.g. external scripts). We also
  // record the state object in pushedStateStack so the popstate
  // handler can read what state we just LEFT.
  function beginNewFrame() {
    const frameId = ++nextFrameId;
    const state = { ibFrame: frameId };
    pushedFrameStack.push(frameId);
    pushedStateStack.push(state);
    try { history.pushState(state, ''); } catch {}
    return frameId;
  }

  // Drop a frame from the pushed-state stack without touching the
  // browser. Used by the popstate handler (after the browser has
  // already consumed the state) and by the reels-view code when
  // exiting via a button (instead of via popstate). Also drops the
  // most-recently-pushed state object so the two stacks stay in
  // sync — without this, the popstate handler would think the
  // user is navigating out of the wrong view.
  function dropPushedFrame(frameId) {
    const idx = pushedFrameStack.lastIndexOf(frameId);
    if (idx >= 0) {
      pushedFrameStack.splice(idx, 1);
      // Also drop the corresponding state entry (if any). We match
      // by frameId so that dropping an unrelated frame doesn't
      // accidentally clear a state record we still need.
      for (let i = pushedStateStack.length - 1; i >= 0; i--) {
        if (pushedStateStack[i] && pushedStateStack[i].ibFrame === frameId) {
          pushedStateStack.splice(i, 1);
          break;
        }
      }
    }
  }

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
    if (modalStack.length === 0) {
      document.body.classList.remove('modal-open');
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
    // Apply background blur to the rest of the page so the user
    // can tell a modal is open and the focus is on it. The blur
    // is removed by closeModal when the stack empties.
    if (modalStack.length === 1) {
      document.body.classList.add('modal-open');
    }
  }

  function closeModal(name) {
    const idx = modalStack.findIndex(m => m.name === name);
    if (idx === -1) return;
    const m = modalStack[idx];

    if (m.isRoot) {
      if (pushedFrameStack[pushedFrameStack.length - 1] === m.frameId) {
        try { history.back(); } catch {
          closeFrame(m.frameId);
        }
      } else {
        closeFrame(m.frameId);
      }
    } else {
      m.el.classList.remove('open');
      if (m.onClose) try { m.onClose(); } catch {}
      modalStack.splice(idx, 1);
    }
    // Remove the body-level blur when no modals are left.
    if (modalStack.length === 0) {
      document.body.classList.remove('modal-open');
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
    // The popstate event tells us "you have just navigated". To
    // figure out WHAT we navigated away from, we keep a parallel
    // stack of the state objects we pushed. The TOP of that stack
    // is the state we just left, and `event.state` is the state
    // we just popped TO.
    const leavingState = pushedStateStack.length
      ? pushedStateStack[pushedStateStack.length - 1]
      : null;
    pushedStateStack.pop();
    if (leavingState && leavingState.ibDashboard) {
      // The user backed out of the dashboard. Close it without
      // touching any other frame; the URL/state marker is consumed
      // by this popstate and we don't want to chain more history
      // operations.
      if (window.AnalyzeModal && typeof window.AnalyzeModal.closeDashboard === 'function') {
        window.AnalyzeModal.closeDashboard();
      }
      return;
    }
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
    // The old sub-tab-list / sub-tab-bar elements have been removed
    // from the DOM (replaced by the Categories modal). Older
    // cached copies of this script can still call into them, so
    // we always set them to null and null-guard every read.
    subTabs: null,
    subBar: null,
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
    filterSource: $('#filter-source'),
    sortBy: $('#sort-by'),
    searchToggle: $('#search-toggle'),
    filterToggle: $('#filter-btn'),
    sortBtn: $('#sort-btn'),
    sortByExtras: $('#sort-by-extras'),
    filterSourceExtras: $('#filter-source-extras'),
    analyzeBtn: $('#analyze-btn'),
    trendingBtn: $('#trending-btn'),
    translateBtn: $('#translate-btn'),
    translateModal: $('#translate-modal'),
    translateModalBody: $('#translate-modal-body'),
    filterPanel: $('#filter-panel'),
    sortPanel: $('#sort-panel'),
    viewToggle: $('#view-toggle'),
    githubTokenInput: $('#github-token-input'),
    cloudStatus: $('#cloud-status'),
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
    autoDisableFailingSources: $('#auto-disable-failing-sources'),
    quotePreserveSpacing: $('#quote-preserve-spacing'),
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

  function formatDateActual(d) {
    const date = new Date(d);
    if (isNaN(date.getTime())) return d;
    return date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
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

  // ── AI scoring (placeholder) ──
  // We previously had a Transformers.js integration that downloaded
  // a ~25MB NLI model and ran zero-shot classification in the
  // browser for importance/benefit scores. It was removed because
  // the ONNX WASM runtime's per-function execution timeout made it
  // unreliable on phones, and the z-index:10000 download bar was
  // occasionally blocking clicks after the model loaded.
  //
  // For now, articles get the existing TF-IDF trending + Jaccard
  // conflict detection from ai.js / analyzer.js, which is plenty
  // for the current view. The scorePillsHtml() call in the article
  // card is now a no-op (returns '') — no DOM, no click-blocking.
  // To re-enable AI scoring later, replace this stub with a TF.js
  // pipeline (window.tf is already loaded) or a backend API.
  function scorePillsHtml(article) {
    return '';
  }

  // scoreArticles is kept as a no-op so callers in
  // displayCurrentSubcat() and startTransformersDownload() don't
  // need to be touched. It returns 0 (nothing scored), and any
  // fire-and-forget callers ignore the return.
  async function scoreArticles(articles) {
    return 0;
  }


  /* ── Primary Tabs (Global / India) ── */
  function renderTopTabs() {
    let html = '<li class="tab-item' + (currentScope === 'global' ? ' active' : '') + '" data-scope="global">Global</li>';
    html += '<li class="tab-item' + (currentScope === 'nation' && currentNation === 'india' ? ' active' : '') + '" data-scope="nation" data-nation="india">India</li>';
    el.topTabs.innerHTML = html;
    renderSectionTabs();
  }

  function renderSectionTabs() {
    const list = document.getElementById('section-tab-list');
    if (!list) return;
    const tabs = [
      { key: 'feeds', label: 'Feeds', icon: '📰' },
      { key: 'topics', label: 'Topics', icon: '📡' },
      { key: 'conflicts', label: 'Conflicts', icon: '⚠' }
    ];
    list.querySelectorAll('.section-tab').forEach(btn => {
      const active = currentSection === btn.dataset.section;
      btn.classList.toggle('active', active);
    });
  }

  // Cheap pre-bucketing for the Topics tab badge. We bucket
  // articles by the first "significant" title token (length ≥5,
  // not a stopword). Two articles in the same bucket with
  // different sources = a potential topic. Not the same as a
  // real cluster, but it's O(n) and gives a good-enough badge.
  function bucketBySharedTitleToken(articles) {
    const STOP = new Set((
      'the and for are but not you all can her was one our had has his how man new now old see two way who boy did its let put say she too use from with this that have will your what when make like long look many some them then than been call come could does each find first from have like make more only over part people said take than them there these they time used want water which word work would write about after again also around another away back because before'
    ).split(/\s+/));
    const map = new Map();
    for (const a of articles) {
      const title = (a.title || '').toLowerCase();
      const tokens = (title.match(/\b[a-z]{5,}\b/g) || []).filter(t => !STOP.has(t));
      if (!tokens.length) continue;
      const key = tokens.slice(0, 3).sort().join('|');
      if (!map.has(key)) map.set(key, { sources: new Set(), count: 0 });
      const b = map.get(key);
      if (a.source) b.sources.add(a.source);
      b.count++;
    }
    const out = [];
    for (const b of map.values()) out.push({ sources: b.sources.size, count: b.count });
    return out;
  }

  // Flatten all articles across all scopes+subcats into a
  // single deduped array (most recent first). Used by the
  // Topics view and a few other places.
  function collectScopeArticles() {
    const seen = new Set();
    const out = [];
    for (const key of Object.keys(scopeCache)) {
      const cached = scopeCache[key];
      if (!cached || !cached.groups) continue;
      for (const cat of Object.keys(cached.groups)) {
        for (const a of cached.groups[cat]) {
          if (!a || !a.link) continue;
          if (seen.has(a.link)) continue;
          seen.add(a.link);
          out.push(a);
        }
      }
    }
    out.sort((a, b) => {
      const ta = a.pubDate ? new Date(a.pubDate).getTime() : 0;
      const tb = b.pubDate ? new Date(b.pubDate).getTime() : 0;
      return tb - ta;
    });
    return out;
  }

  function renderExploreView() {
    const container = el.main;
    if (!container) return;

    const EXPLORE_TABS = [
      { key: 'categories', label: 'Categories', icon: '🗂' },
      { key: 'topics', label: 'Topics', icon: '📡' },
      { key: 'conflicts', label: 'Conflicts', icon: '⚠' }
    ];

    const tabsHtml = EXPLORE_TABS.map(t =>
      '<button class="explore-inner-tab' + (t.key === currentExploreTab ? ' active' : '') + '" data-explore-tab="' + t.key + '">' +
        '<span class="sub-tab-icon">' + t.icon + '</span>' +
        '<span class="sub-tab-label">' + t.label + '</span>' +
      '</button>'
    ).join('');

    const tabsWrap = document.getElementById('explore-inner-tabs');
    const tabsContainer = document.getElementById('explore-inner-tabs-container');
    if (tabsWrap && tabsContainer) {
      tabsWrap.hidden = false;
      tabsContainer.innerHTML = tabsHtml;
      tabsContainer.querySelectorAll('.explore-inner-tab').forEach(btn => {
        btn.addEventListener('click', () => {
          const tab = btn.dataset.exploreTab;
          if (tab === currentExploreTab) return;
          currentExploreTab = tab;
          renderExploreTabContent();
          tabsContainer.querySelectorAll('.explore-inner-tab').forEach(b => b.classList.toggle('active', b.dataset.exploreTab === tab));
          updateStickyHeader();
        });
      });
    }

    container.innerHTML = '<div class="explore-view">' +
      '<div class="explore-inner-content" id="explore-inner-content"></div>' +
    '</div>';

    renderExploreTabContent();
    updateStickyHeader();
  }

  function renderExploreTabContent() {
    const content = document.getElementById('explore-inner-content');
    if (!content) return;
    if (currentExploreTab === 'categories') {
      renderExploreCategories(content);
    } else if (currentExploreTab === 'topics') {
      renderTopicsView(content);
    } else if (currentExploreTab === 'conflicts') {
      renderConflictsView(content);
    }
  }

  function renderExploreCategories(container) {
    if (isParliamentSubcat(currentSubcat)) { currentSubcat = 'all'; }
    const CATEGORIES = [
      { id: 'all', label: 'All', icon: '📊' },
      { id: 'politics', label: 'Politics', icon: '🏛' },
      { id: 'business', label: 'Business', icon: '📈' },
      { id: 'technology', label: 'Technology', icon: '💻' },
      { id: 'science', label: 'Science', icon: '🔬' },
      { id: 'health', label: 'Health', icon: '❤' },
      { id: 'sports', label: 'Sports', icon: '⚽' },
      { id: 'entertainment', label: 'Entertainment', icon: '🎬' },
      { id: 'environment', label: 'Environment', icon: '🌱' },
      { id: 'education', label: 'Education', icon: '📚' }
    ];
    const scopeParam = currentScope === 'global' ? '' : '&scope=nation&nation=' + currentNation;
    container.innerHTML = '<div class="explore-cat-grid">' +
      CATEGORIES.map(c =>
        '<a href="index.html?subcat=' + c.id + scopeParam + '" class="category-card explore-cat-card">' +
          '<span class="cat-icon">' + c.icon + '</span>' +
          '<span class="cat-name">' + c.label + '</span>' +
        '</a>'
      ).join('') +
    '</div>';
  }

  function openSectionSelection(scope, nation, section, subcat) {
    const targetScope = scope || currentScope;
    const targetNation = targetScope === 'nation'
      ? (nation || currentNation || FeedManager.getSelectedNation())
      : 'india';
    const prevKey = scopeKey();
    const isScopeChange = targetScope !== currentScope || targetNation !== currentNation;
    if (typeof abortBackgroundFetch === 'function') abortBackgroundFetch(prevKey);
    currentScope = targetScope;
    currentNation = targetNation;
    FeedManager.setSelectedNation(currentNation);
    if (subcat != null) {
      currentSubcat = subcat;
    }
    if (isParliamentSubcat(currentSubcat)) { currentSubcat = 'all'; }
    currentSearch = '';
    if (el.searchInput) el.searchInput.value = '';
    _persist();
    showLoading();
    loadedCount = 0;
    hasFreshBackground = false;
    liveAllLoaded = false;
    loadAllState = 'idle';
    liveAllArticles = null;
    lastRenderedCount = 0;
    $$('.tab-item', el.topTabs).forEach(t => t.classList.remove('active'));
    const activeTab = el.topTabs && el.topTabs.querySelector('.tab-item[data-scope="' + currentScope + '"]' + (currentScope === 'nation' ? '[data-nation="' + currentNation + '"]' : ''));
    if (activeTab) activeTab.classList.add('active');
    renderSectionTabs();
    renderCurrentSection();
    if (isScopeChange && currentSection === 'feeds' && window.CategoriesModal) {
      CategoriesModal.openModal();
    }
  }

  function bindSectionTabs() {
    const list = document.getElementById('section-tab-list');
    if (!list) return;
    list.addEventListener('click', e => {
      const btn = e.target.closest('.section-tab');
      if (!btn) return;
      const section = btn.dataset.section;
      if (!section || section === currentSection) return;
      currentSection = section;
      currentSearch = '';
      if (el.searchInput) el.searchInput.value = '';
      renderSectionTabs();
      updateStickyHeader();
      renderCurrentSection();
    });
  }

  async function renderCurrentSection() {
    const msg = 'Loading ' + currentSection + '…';
    console.log('[renderCurrentSection] section=' + currentSection + ', sourceFilter=' + sourceFilter);
    setTopListStatus(msg);
    showLoadingInline(msg);
    await new Promise(r => setTimeout(r, 0));
    const t0 = performance ? performance.now() : Date.now();
    try {
      if (currentSection === 'topics') {
        console.log('[renderCurrentSection] showing topics overlay');
        showLoadingOverlay('Loading topics\u2026');
        console.log('[renderCurrentSection] overlay shown, calling renderTopicsView');
        await renderTopicsView();
        console.log('[renderCurrentSection] renderTopicsView done, hiding overlay');
        hideLoadingOverlay();
      } else if (currentSection === 'conflicts') {
        await renderConflictsView();
      } else {
        const key = scopeKey();
        const cached = scopeCache[key];
        if (cached) {
          await displayCurrentSubcat();
        } else {
          await renderContent();
        }
      }
    } finally {
      hideLoadingOverlay();
      const elapsed = (performance ? performance.now() : Date.now()) - t0;
      const remaining = Math.max(0, 300 - elapsed);
      if (remaining > 0) await new Promise(r => setTimeout(r, remaining));
      clearTopListStatus();
    }
  }

  function bindTopTabs() {
    el.topTabs.addEventListener('click', e => {
      const tab = e.target.closest('.tab-item');
      if (!tab) return;
      const scope = tab.dataset.scope;
      const nation = tab.dataset.nation || 'india';
      const prevKey = scopeKey();
      if (typeof abortBackgroundFetch === 'function') abortBackgroundFetch(prevKey);
      currentScope = scope;
      currentNation = nation;
      FeedManager.setSelectedNation(currentNation);
      if (isParliamentSubcat(currentSubcat)) { currentSubcat = 'all'; }
      currentSearch = '';
      if (el.searchInput) el.searchInput.value = '';
      _persist();
      loadedCount = 0;
      hasFreshBackground = false;
      liveAllLoaded = false;
      loadAllState = 'idle';
      liveAllArticles = null;
      lastRenderedCount = 0;
      $$('.tab-item', el.topTabs).forEach(t => t.classList.remove('active'));
      const activeTab = el.topTabs && el.topTabs.querySelector('.tab-item[data-scope="' + currentScope + '"]' + (currentScope === 'nation' ? '[data-nation="' + currentNation + '"]' : ''));
      if (activeTab) activeTab.classList.add('active');
      renderSectionTabs();
      if (window.CategoriesModal) {
        CategoriesModal.openModal();
      }
    });
  }

  /* ── Subcategory Tabs ── */
  function getFilteredArticles(subcat, cached) {
    if (!cached) return [];
    console.log('[getFilteredArticles] subcat=' + subcat + ', sourceFilter=' + sourceFilter + ', groups keys=' + Object.keys(cached.groups).join(','));
    let articles;
    if (subcat === 'all') {
      articles = [];
      for (const cat of Object.keys(cached.groups)) {
        articles.push(...cached.groups[cat]);
      }
    } else {
      const subcatArticles = cached.groups[subcat] || [];
      const allArticles = cached.groups['all'] || [];
      articles = subcatArticles.concat(allArticles);
    }
    if (!articles.length) return [];
    // Apply source filter
    if (sourceFilter === 'ib') {
      articles = articles.filter(a => a._isPublished);
    } else if (sourceFilter === 'feeds') {
      articles = articles.filter(a => !a._isPublished);
    }
    articles = FeedFetcher.deduplicate(articles);
    articles = FeedFetcher.sortByDate(articles);
    articles = applySearch(articles);
    articles = applyFilters(articles);
    const sortMode = currentSort || 'date-desc';
    articles = applySort(articles, sortMode);
    console.log('[getFilteredArticles] returning ' + articles.length + ' articles');
    return articles;
  }

  // Keep the legacy #filterSource select in sync with the
  // articles currently visible. The user-facing filter is now
  // the FilterModal (with checkboxes), but we still populate
  // this select for any code path that reads from it.
  function updateFilterSourceOptions(articles) {
    if (!el.filterSource) return;
    const sources = [...new Set(articles.map(a => a.source).filter(Boolean))].sort();
    const html = '<option value="">All Sources</option>' +
      sources.map(s => '<option value="' + s.replace(/"/g, '&quot;') + '">' + s + '</option>').join('');
    el.filterSource.innerHTML = html;
  }

  function renderSubTabs() {
    // The old horizontal category tab strip has been replaced by
    // the Categories modal (see js/categories-modal.js). The DOM
    // element is gone, so this is a no-op kept for callers that
    // haven't been updated yet.
  }

  function bindSubTabs() {
    // The old horizontal category tab strip has been replaced by
    // the Categories modal (see js/categories-modal.js). The element
    // is no longer in the DOM, but this function is still called
    // from init() — so it's a safe no-op.
  }

  // Switch the active subcat and refresh the view. Called by the
  // CategoriesModal when the user picks a category (or a
  // parliament item). Aborts any in-flight fetch for the old
  // subcat and starts a fresh render.
  let _lastSelectScopeKey = '';
  function selectCategory(sub) {
    const curKey = scopeKey();
    if (sub == null || (sub === currentSubcat && curKey === _lastSelectScopeKey)) {
      if (sub != null && sub === currentSubcat) {
        updateStickyHeader();
      }
      return;
    }
    if (currentSection !== 'feeds') {
      currentSection = 'feeds';
      renderSectionTabs();
    }
    const prevKey = scopeKey();
    if (typeof abortBackgroundFetch === 'function') abortBackgroundFetch(prevKey);
    currentSubcat = sub;
    _lastSelectScopeKey = scopeKey();
    currentSearch = '';
    if (el.searchInput) el.searchInput.value = '';
    // Reset trending mode
    if (currentMode === 'top' && currentRankType === 'keyword') {
      currentMode = 'live';
      currentRankType = 'ai';
    }
    updateRankControls();
    _persist();
    hasFreshBackground = false;
    loadedCount = 0;
    liveAllLoaded = false;
    loadAllState = 'idle';
    liveAllArticles = null;
    lastRenderedCount = 0;
    updateStickyHeader();
    // Show a loading state right away so the user doesn't see a
    // frozen/empty list while displayCurrentSubcat re-renders.
    // (Trending + conflict detection can take a few seconds on
    // a large cache.) The loading screen is replaced by the
    // real render when displayCurrentSubcat resolves.
    showLoadingInline(isParliamentSubcat(sub)
      ? 'Loading parliament feed…'
      : 'Loading articles…');
    // Yield to the event loop so the spinner paints before the
    // (potentially long) render kicks off.
    requestAnimationFrame(() => {
      displayCurrentSubcat().catch(err => {
        console.warn('displayCurrentSubcat failed:', err);
      });
    });
  }

  function updateStickyHeader(metaText) {
    if (currentSection === 'topics') {
      if (el.sectionTitle) {
        el.sectionTitle.innerHTML = (currentScope === 'global' ? '🌍' : '🇮🇳') + ' ' + (currentScope === 'global' ? 'Global' : 'India') +
          '<span style="font-size:0.8rem;font-weight:400;color:var(--text-tertiary);margin-left:8px;">Topics</span>';
      }
      if (el.sectionMeta) el.sectionMeta.innerHTML = '';
      syncViewToggleBtn();
      return;
    }
    if (currentSection === 'conflicts') {
      if (el.sectionTitle) {
        el.sectionTitle.innerHTML = (currentScope === 'global' ? '🌍' : '🇮🇳') + ' ' + (currentScope === 'global' ? 'Global' : 'India') +
          '<span style="font-size:0.8rem;font-weight:400;color:var(--text-tertiary);margin-left:8px;">Conflicts</span>';
      }
      if (el.sectionMeta) el.sectionMeta.innerHTML = '';
      syncViewToggleBtn();
      return;
    }
    const disp = categoryDisplay(currentSubcat, currentScope, currentNation);
    if (el.sectionTitle) {
      el.sectionTitle.innerHTML = disp.icon + ' ' + disp.label +
        '<span style="font-size:0.8rem;font-weight:400;color:var(--text-tertiary);margin-left:8px;">' + disp.scopeLabel + '</span>';
    }
    if (el.sectionMeta) el.sectionMeta.innerHTML = '';
    syncViewToggleBtn();
  }

  function syncViewToggleBtn() {
    const btn = document.getElementById('view-toggle-btn');
    if (!btn) return;
    if (currentView === 'reels') {
      btn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>';
      btn.title = 'List View';
    } else {
      btn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>';
      btn.title = 'Cards View';
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

  // Set to true after the user clicks "Load All Articles" and
  // the background fetch completes. The view then auto-expands
  // to show all articles; the button disappears. There's no
  // separate "show all" affordance.
  let liveAllLoaded = false;

  // In live mode, show only the most recent article from each source in the
  // default view. The "Load All" button then reveals everything fetched.
  // This keeps the initial view light (1 card per source) while making it
  // clear how many sources actually returned content.
  function pickOnePerSource(articles) {
    const seen = new Set();
    const out = [];
    for (const a of articles) {
      if (a._isPublished) { out.push(a); continue; }
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
        if (liveAllLoaded && liveAllArticles) {
          display = liveAllArticles.slice(0, liveTotalCap);
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

      // Build the "Load All" button (live mode only). Behaviour:
      //   - State 1 (initial): button reads "Load All Articles" and is
      //     enabled. Clicking kicks off a background re-fetch with a
      //     larger cap and flips the button to the loading state.
      //   - State 2 (loading): button reads "Loading all articles…",
      //     shows a spinner, and is disabled. The user can still
      //     scroll the 1-per-source view while the fetch runs.
      //   - State 3 (loaded): button reads "Show all (N articles)" and
      //     is enabled. Clicking reveals the full set without a
      //     second fetch.
      // "Loading more sources…" indicator. Visible only while a
      // background fetch is in flight for the current scope (the
      // phased-load backgroundFetchRest or the explicit Load All).
      // It's a slim strip at the top of the article list so the
      // user can see progress without their scroll position being
      // shoved around.
      let bgHtml = '';
      const _curKey = scopeKey();
      const bgAbort = backgroundFetchAbort[_curKey];
      if (bgAbort && !bgAbort.aborted && articles.length > lastRenderedCount) {
        const remaining = totalFeedsForKey(_curKey);
        const loaded = lastRenderedCount;
        // The .bg-fetch-text span is the only part the background
        // fetch updates in place (via updateBgFetchIndicator). The
        // rest of the indicator stays static so the rest of the
        // article list never has to repaint while the count ticks up.
        bgHtml = '<div class="bg-fetch-indicator">' +
          '<span class="btn-spinner"></span>' +
          '<span class="bg-fetch-text">Loading more sources in the background… (' + loaded + ' / ' + remaining + ' articles loaded)</span>' +
        '</div>';
      }

      let loadAllHtml = bgHtml;
      // Load-All button (live mode only). Two states: idle (says
      // "Load All Articles") and loading (disabled with a
      // spinner + "Loading all articles…"). When the background
      // fetch finishes, the view auto-expands to show all
      // articles — the button disappears entirely, so the user
      // never sees a "Show all (N articles)" follow-up state.
      if (currentMode === 'live' && articles.length > display.length && !liveAllLoaded) {
        const remaining = articles.length;
        const showing = totalShown;
        let btnLabel, btnDisabled = '', btnSpinner = '';
        if (loadAllState === 'loading') {
          btnLabel = 'Loading all articles…';
          btnDisabled = ' disabled';
          btnSpinner = '<span class="btn-spinner"></span>';
        } else {
          btnLabel = 'Load All Articles';
        }
        loadAllHtml = (loadAllHtml || '') + '<div class="load-all-row">' +
          '<div class="load-all-info">' +
            '<strong>Showing ' + showing + ' of ' + remaining + ' articles</strong>' +
            '<span class="load-all-hint">Newest from each source. Click below to fetch the full list in the background.</span>' +
          '</div>' +
          '<button class="btn btn-primary" id="load-all-btn"' + btnDisabled + '>' +
            btnSpinner + ' ' + btnLabel +
          '</button>' +
        '</div>';
      }

      updateStickyHeader(totalShown + ' of ' + articles.length);

      // Build the grid using a DocumentFragment so we don't keep reflowing on
      // each append. For very large lists (500+ cards) we chunk the work
      // across multiple animation frames so the UI stays responsive.
      renderArticleGrid(loadAllHtml, display);

      const loadAllBtn = $('#load-all-btn');
      if (loadAllBtn) {
        loadAllBtn.addEventListener('click', () => handleLoadAllClick());
      }
    } catch (e) {
      console.error('renderArticles failed:', e);
      showError('Failed to render list view. Try refreshing.');
    }
  }

  // Load-All state machine. Two values:
  //   'idle'    → button says "Load All Articles", enabled.
  //   'loading' → background re-fetch in progress, button disabled
  //               with spinner + "Loading all articles…". When the
  //               fetch finishes, the view auto-expands to show
  //               every article and the button disappears.
  // There is no 'loaded' state — clicking the button is a
  // single-action transition. The user never sees a "Show all
  // (N articles)" follow-up button.
  let loadAllState = 'idle';
  // Holds the larger article set once the background fetch finishes.
  // null until then. Read by renderArticles to decide what to display.
  let liveAllArticles = null;

  // Click handler for the Load All button. Two states:
  //   - idle:    start the background fetch
  //   - loading: no-op (button is disabled)
  async function handleLoadAllClick() {
    if (loadAllState === 'loading') return;
    // State is 'idle'. Kick off a background re-fetch with a high
    // per-source cap (100 per source, up to ~10,000 articles total
    // across all sources). The work is split across animation
    // frames so the user-visible 1-per-source view never freezes.
    loadAllState = 'loading';
    renderArticles(currentArticles);
    // Run in the next tick so the disabled button paints first.
    requestAnimationFrame(async () => {
      try {
        const key = scopeKey();
        const feeds = FeedManager.getFeedsForSubcat(currentScope, currentScope === 'nation' ? currentNation : null, currentSubcat);
        if (!feeds.length) {
          loadAllState = 'idle';
          renderArticles(currentArticles);
          return;
        }
        // Use a per-source cap of 100, batch 4 at a time.
        const BATCH = 4;
        const PER_SOURCE = 100;
        const allResults = [];
        for (let i = 0; i < feeds.length; i += BATCH) {
          const batch = feeds.slice(i, i + BATCH);
          const settled = await Promise.allSettled(batch.map(f => FeedFetcher.fetchFeed(f, PER_SOURCE)));
          for (const s of settled) {
            if (s.status === 'fulfilled') allResults.push(...s.value);
          }
          // Yield to the browser so the disabled button can repaint.
          await new Promise(r => setTimeout(r, 0));
        }
        // Build the new full corpus and store it.
        const groups = {};
        for (const a of allResults) {
          a.subcat = a.feedHint || 'politics';
          if (!groups[a.subcat]) groups[a.subcat] = [];
          groups[a.subcat].push(a);
        }
        let allArticles = [];
        for (const cat of Object.keys(groups)) allArticles.push(...groups[cat]);
        liveAllArticles = allArticles;
        scopeCache[key] = { articles: allArticles, groups };
        // Auto-expand to the full set. The user clicked "Load
        // All Articles" once; they don't need to click again to
        // see them. The button disappears (because of the
        // !liveAllLoaded guard in the renderArticles row
        // builder) so there's no "Show all (500 articles)"
        // follow-up state anywhere.
        liveAllLoaded = true;
        loadAllState = 'idle';
      } catch (e) {
        console.warn('Load-all background fetch failed:', e);
        loadAllState = 'idle';
      }
      if (currentSection !== 'feeds') return;
      renderArticles(currentArticles);
    });
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

  /** Convert newlines in quote text to <br> tags when setting is ON */
  function formatQuoteText(text) {
    const escaped = escHtml(text || '');
    if (!Settings.get('quotePreserveSpacing')) return escaped;
    return escaped.replace(/\n/g, '<br>');
  }

  function renderCard(article, index) {
    const imgUrl = article.imageUrl ? article.imageUrl.replace(/^\/\//, 'https://') : '';
    const hasThumb = imgUrl && imgUrl.startsWith('http');
    const encoded = encodeURIComponent(article.link);

    const thumbHtml = hasThumb
      ? '<div class="article-thumb" style="cursor:pointer" data-article="' + encoded + '">' +
          '<img src="' + escAttr(enhanceImageUrl(imgUrl) || imgUrl) + '" alt="" loading="lazy" onerror="var fb=this.dataset.fb;if(fb){this.src=fb;this.dataset.fb=\'\'}else{this.style.display=\'none\'}" data-fb="' + escAttr('https://wsrv.nl/?url=' + encodeURIComponent(imgUrl) + '&output=jpg') + '">' +
        '</div>'
      : '';

    const kwText = (article._trendingKeywords && article._trendingKeywords.length) ? article._trendingKeywords.join(', ') : '—';
    const locText = escHtml(scopeLabel(currentScope, currentSubcat));
    // Trending-mode rank badge (#1, #2, ...). Coloured accent for the
    // top 3, tertiary grey for the rest.
    const rankHtml = article._rank
      ? '<span class="score-badge" style="color:' + (article._rank <= 3 ? 'var(--accent)' : 'var(--text-tertiary)') + '">#' + article._rank + '</span>'
      : '';
    // Live-trending kicker is kept (purely derived from article text; not
    // a ranking signal). Click expands "where it's trending" details.
    let rankedBlock = '';
    if (article._trendingCount > 0) {
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

    // Subject chip + Analyze button (Milestone 1). Only rendered when
    // the article was tagged with a registered subject by
    // `tagArticleWithSubject` in displayCurrentSubcat.
    const subject = article.subject;
    const subjectHtml = subject
      ? '<div class="subject-chip-wrap">' +
          '<span class="subject-chip" title="About ' + escAttr(subject.display_name) + '">' +
            '<span class="subject-chip-dot"></span>' +
            escHtml(subject.display_name) +
          '</span>' +
          '<button class="card-analyze-btn" data-article="' + encoded + '" title="Analyze this subject" aria-label="Analyze ' + escAttr(subject.display_name) + '">&#x2696;&#xFE0F;</button>' +
        '</div>'
      : '';

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

    // Quote type: different card layout
    if (article._pubType === 'quote') {
      const quoteFrom = article._pubQuoteFrom || '';
      const quoteOccupation = article._pubQuoteOccupation || '';
      const bgUrl = article.imageUrl || '';
      const bgStyle = bgUrl ? 'background-image:url(' + escAttr(bgUrl) + ');background-size:cover;background-position:center;' : '';
      return '<article class="article-card quote-card' + (bgUrl ? ' quote-card-bg' : '') + '" style="animation-delay:' + ((index % 10) * 0.04) + 's;' + bgStyle + '">' +
        (bgUrl ? '<div class="quote-card-bg-overlay"></div>' : '') +
        '<button class="card-share-btn" data-url="' + encodeURIComponent(article.link) + '" data-title="' + escAttr(article.title) + '" data-source="' + escAttr(article.source) + '" data-quote-from="' + escAttr(quoteFrom) + '" title="Share as Image">&#x21AA;</button>' +
        '<div class="article-body">' +
          '<div class="quote-block">' +
            '<span class="quote-open">&ldquo;</span>' +
            '<p class="article-summary quote-text">' + formatQuoteText(article.summary) + '</p>' +
          '</div>' +
          (quoteFrom ? '<div class="quote-from"><span class="quote-from-label">&mdash;</span> ' + escHtml(quoteFrom) + '</div>' : '') +
          (quoteOccupation ? '<div class="quote-occupation">' + escHtml(quoteOccupation).replace(/\n/g, '<br>') + '</div>' : '') +
          '<div class="quote-watermark">Invisible Broadcast</div>' +
          '<div class="article-meta">' +
            '<span class="date">' + formatDateActual(article._pubQuoteDate || article.pubDate) + '</span>' +
          '</div>' +
          '<div class="card-actions">' +
            '<button class="card-action-btn card-cards-btn" data-cards-article="' + encoded + '" title="Cards View">' +
              '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="1" y="1" width="14" height="9" rx="1.5"/><path d="M4 11v3M12 11v3M8 11v3"/></svg>' +
            '</button>' +
            (currentUser && article._isPublished && article._pubUserEmail === currentUser.email ? '<button class="card-action-btn card-edit-btn" data-publish-article="' + encoded + '" title="Edit quote">' +
              '<span>&#x270F;</span>' +
            '</button>' : '') +
            (currentUser && article._isPublished && article._pubUserEmail === currentUser.email ? '<button class="card-action-btn card-delete-btn" data-publish-article="' + encoded + '" title="Delete quote">' +
              '<span>&#x1F5D1;</span>' +
            '</button>' : '') +
          '</div>' +
        '</div>' +
      '</article>';
    }

    return '<article class="article-card" style="animation-delay:' + ((index % 10) * 0.04) + 's">' +
        '<button class="card-share-btn" data-url="' + encodeURIComponent(article.link) + '" data-title="' + escAttr(article.title) + '" data-source="' + escAttr(article.source) + '" title="Share as Image">&#x21AA;</button>' +
        thumbHtml +
        '<div class="article-body">' +
          rankedBlock +
          conflictBlock +
          '<div class="article-title-row">' +
            '<h3 class="article-title"><span class="article-link" data-article="' + encoded + '">' + escHtml(article.title) + '</span></h3>' +
            subjectHtml +
          '</div>' +
          '<p class="article-summary">' + smartTruncate(cleanSummary(stripHtml(article.summary)), 250) + '</p>' +
          '<div class="article-meta">' +
            '<span class="source">' + escHtml(article.source || '') + '</span>' +
            '<span class="date">' + formatDateShort(article.pubDate) + '</span>' +
            rankHtml +
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
            '<button class="card-action-btn card-cards-btn" data-cards-article="' + encoded + '" title="Cards View">' +
              '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="1" y="1" width="14" height="9" rx="1.5"/><path d="M4 11v3M12 11v3M8 11v3"/></svg>' +
            '</button>' +
            (currentUser && article._isPublished && article._pubUserEmail === currentUser.email ? '<button class="card-action-btn card-edit-btn" data-publish-article="' + encoded + '" title="Edit IB post">' +
              '<span>&#x270F;</span>' +
            '</button>' : '') +
            (currentUser && article._isPublished && article._pubUserEmail === currentUser.email ? '<button class="card-action-btn card-delete-btn" data-publish-article="' + encoded + '" title="Delete IB post">' +
              '<span>&#x1F5D1;</span>' +
            '</button>' : '') +
            (!article._isPublished && currentUser ? '<button class="card-action-btn card-publish-btn" data-publish-article="' + encoded + '" title="Publish to blog">' +
              '<span>&#x1F4E4;</span>' +
            '</button>' : '') +
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
  let _reelsArticles = null;
  let _reelsExitRestore = null;
  function reelsArticles() { return _reelsArticles || currentArticles; }
  // Fullscreen removed — swipe always works in cards view (no fullscreen gate)

  function updateNavArrows(container) {
    if (!container) return;
    container.classList.add('reels-show-arrows');
    container.style.touchAction = 'pan-y';
  }

  function renderReels(articles) {
    try {
      if (!articles.length) { showEmpty(); return; }
      currentArticles = articles;
      currentReelIndex = 0;
      showReel();
    } catch (e) {
      console.error('renderReels failed:', e);
      showError('Failed to render cards view. Try refreshing.');
    }
  }

  function openReelsForArticle(link, articles, exitRestore) {
    if (articles) {
      _reelsArticles = articles;
      _reelsExitRestore = exitRestore || null;
      const idx = articles.findIndex(a => a.link === link);
      if (idx === -1) return;
      currentReelIndex = idx;
      closeClusterModal();
      document.body.classList.remove('modal-open');
      const cIdx = modalStack.findIndex(m => m.name === 'cluster');
      if (cIdx !== -1) modalStack.splice(cIdx, 1);
    } else {
      _reelsArticles = null;
      _reelsExitRestore = null;
      const article = findArticleByLink(link);
      if (!article) return;
      const idx = currentArticles.indexOf(article);
      if (idx === -1) return;
      currentReelIndex = idx;
    }
    currentView = 'reels';
    _persist();
    document.body.classList.add('cards-view');
    $$('#view-toggle .mode-btn, [data-view-toggle-inline] .mode-btn').forEach(b => b.classList.remove('active'));
    $$('#view-toggle .mode-btn, [data-view-toggle-inline] .mode-btn').forEach(b => {
      if (b.dataset.view === currentView) b.classList.add('active');
    });
    syncViewToggleBtn();
    sizeReelsContainer();
    reelsFrameId = ++nextFrameId;
    pushedFrameStack.push(reelsFrameId);
    try { history.pushState({ ibFrame: reelsFrameId, ibReels: true }, ''); } catch {}
    showReel();
  }

  function cardOverlayHtml(includeToolbar, hasThumb) {
    var html = '';
    if (includeToolbar !== false) {
      const showDesc = Settings.get('showDescription');
      // Standalone toolbar row — sits above image/text, no overlap.
      // Refresh is done via the IB logo in the header; not duplicated here.
      html += '<div class="reels-toolbar-row">' +
        '<div class="reels-toolbar-group reels-toolbar-left">' +
          '<button class="reels-tool-btn reels-fullscreen-btn" title="Toggle Fullscreen">' +
            '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' +
              '<path d="M2 5V2h3M11 2h3v3M14 11v3h-3M5 14H2v-3"/>' +
            '</svg>' +
          '</button>' +
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
          '<button class="reels-tool-btn reels-screenshot" title="Screenshot Card">' +
            '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' +
              '<path d="M2 4h2l1-2h6l1 2h2a1 1 0 011 1v8a1 1 0 01-1 1H1a1 1 0 01-1-1V5a1 1 0 011-1z"/>' +
              '<circle cx="8" cy="8" r="2.5"/>' +
            '</svg>' +
          '</button>' +
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
        '<button class="reels-action-btn reels-reel-publish-btn" title="Publish to blog">' +
          '<span class="reels-action-icon">&#x1F4E4;</span>' +
          '<span class="reels-action-label">Publish</span>' +
        '</button>' +
        '<button class="reels-action-btn reels-reel-edit-btn" style="display:none" title="Edit IB post">' +
          '<span class="reels-action-icon">&#x270F;</span>' +
          '<span class="reels-action-label">Edit</span>' +
        '</button>' +
        '<button class="reels-action-btn reels-reel-del-btn" style="display:none" title="Delete IB post">' +
          '<span class="reels-action-icon">&#x1F5D1;</span>' +
          '<span class="reels-action-label">Delete</span>' +
        '</button>' +
      '</div>';
    }
    html += '<div class="reels-img-wrap"><img class="reels-img" alt="" loading="eager" decoding="async"></div>';
    html += '<div class="reels-overlay">' +
        '<div class="reels-count-row">' +
          '<span class="reels-count"></span>' +
          '<div class="reels-badges">' +
            '<span class="reels-conflict" style="display:none"><span class="rc-warn">⚠</span> Conflict</span>' +
            '<span class="reels-mode-badge"></span>' +
          '</div>' +
        '</div>' +
        '<div class="reels-quote-head">' +
          '<h2 class="reels-title"></h2>' +
          '<div class="reels-meta">' +
            '<span class="reels-source"></span>' +
            '<span class="reels-date"></span>' +
            '<span class="reels-live-trending" style="display:none"><span class="lrk-arrow">↗</span> <span class="rk-num"></span></span>' +
            '<span class="reels-flag" style="display:none"></span>' +
          '</div>' +
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
    const imgUrl = article.imageUrl ? article.imageUrl.replace(/^\/\//, 'https://') : '';
    const hasThumb = imgUrl && imgUrl.startsWith('http');
    cardEl.classList.toggle('has-image', !!hasThumb);
    const imgWrap = cardEl.querySelector('.reels-img-wrap');
    const imgEl = cardEl.querySelector('.reels-img');
    if (hasThumb && imgEl && imgWrap) {
      imgEl.src = enhanceImageUrl(imgUrl) || imgUrl;
      imgWrap.classList.remove('no-image');
      imgWrap.style.display = '';
      // For published posts, try .png if .jpg fails (uploaded extension may differ)
      const altUrl = article._imageUrlPng || article._imageUrlJpg || '';
      imgEl.dataset.fb = altUrl || ('https://wsrv.nl/?url=' + encodeURIComponent(imgUrl) + '&output=jpg');
      imgEl.onerror = function() {
        if (this.dataset.fb) { this.src = this.dataset.fb; this.dataset.fb = ''; }
        else { imgWrap.classList.add('no-image'); }
      };
    } else {
      if (imgWrap) { imgWrap.classList.add('no-image'); imgWrap.style.display = ''; }
      if (imgEl) imgEl.src = '';
    }

    const count = cardEl.querySelector('.reels-count');
    if (count) count.textContent = (idx + 1) + ' / ' + total;
    const modeBadge = cardEl.querySelector('.reels-mode-badge');
    if (modeBadge) {
      modeBadge.textContent = 'LIVE';
      modeBadge.classList.toggle('mode-top', false);
      modeBadge.classList.toggle('mode-live', true);
    }
    const liveTrendingEl = cardEl.querySelector('.reels-live-trending');
    if (liveTrendingEl) {
      const show = article._trendingCount > 0;
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
    const source = cardEl.querySelector('.reels-source');
    const summaryText = cleanSummary(stripHtml(article.summary));
    const summary = cardEl.querySelector('.reels-summary');
    const summaryWrap = cardEl.querySelector('.reels-summary-wrap');
    const showDesc = Settings.get('showDescription');

    // Quote type: show quote text with opening quote mark, hide title
    if (article._pubType === 'quote') {
      cardEl.classList.add('quote-type-card');
      if (title) {
        title.innerHTML = '<span style="color:var(--accent);font-size:2em;font-weight:700;font-family:Georgia,serif;line-height:1;vertical-align:-0.15em;">\u201C</span>';
      }
      const quoteFrom = article._pubQuoteFrom || '';
      const quoteOccupation = article._pubQuoteOccupation || '';
      const quoteDate = article._pubQuoteDate || '';
      if (summary) {
        summary.classList.add('quote-text');
        summary.innerHTML = showDesc ? formatQuoteText(article.summary) : '';
      }
      if (summaryWrap) summaryWrap.style.display = showDesc ? '' : 'none';
      // Hide the source line — we show quote_from + watermark instead
      if (source) source.textContent = '';
      // Show quote date if set
      const dateEl = cardEl.querySelector('.reels-date');
      if (dateEl) {
        dateEl.textContent = quoteDate ? formatDateActual(quoteDate) : '';
      }
      // Add quote_from (red, bold) + occupation + separator + watermark after the summary
      const existingFrom = cardEl.querySelector('.quote-from-overlay');
      if (existingFrom) existingFrom.remove();
      const existingOcc = cardEl.querySelector('.quote-occupation-overlay');
      if (existingOcc) existingOcc.remove();
      const existingSep = cardEl.querySelector('.quote-separator');
      if (existingSep) existingSep.remove();
      const existingWm = cardEl.querySelector('.quote-watermark-overlay');
      if (existingWm) existingWm.remove();
      if (quoteFrom) {
        const fromEl = document.createElement('div');
        fromEl.className = 'quote-from-overlay';
        fromEl.textContent = '\u2014 ' + quoteFrom;
        summaryWrap.parentNode.insertBefore(fromEl, summaryWrap.nextSibling);
      }
      if (quoteOccupation) {
        const occEl = document.createElement('div');
        occEl.className = 'quote-occupation-overlay';
        occEl.innerHTML = escHtml(quoteOccupation).replace(/\n/g, '<br>');
        const fromRef2 = cardEl.querySelector('.quote-from-overlay') || summaryWrap;
        fromRef2.parentNode.insertBefore(occEl, fromRef2.nextSibling);
      }
      const sepEl = document.createElement('div');
      sepEl.className = 'quote-separator';
      const lastRef = cardEl.querySelector('.quote-occupation-overlay') || cardEl.querySelector('.quote-from-overlay') || summaryWrap;
      lastRef.parentNode.insertBefore(sepEl, lastRef.nextSibling);
      const wmEl = document.createElement('div');
      wmEl.className = 'quote-watermark-overlay';
      wmEl.textContent = 'Invisible Broadcast';
      sepEl.parentNode.insertBefore(wmEl, sepEl.nextSibling);
    } else {
      cardEl.classList.remove('quote-type-card');
      // Clean up any leftover quote elements from a previous render
      const oldFrom = cardEl.querySelector('.quote-from-overlay');
      if (oldFrom) oldFrom.remove();
      const oldOcc = cardEl.querySelector('.quote-occupation-overlay');
      if (oldOcc) oldOcc.remove();
      const oldSep = cardEl.querySelector('.quote-separator');
      if (oldSep) oldSep.remove();
      const oldWm = cardEl.querySelector('.quote-watermark-overlay');
      if (oldWm) oldWm.remove();
      if (title) title.textContent = article.title;
      if (source) source.textContent = article.source;
      if (summary) {
        summary.classList.remove('quote-text');
        summary.textContent = showDesc ? summaryText : '';
      }
      if (summaryWrap) {
        summaryWrap.style.display = showDesc ? '' : 'none';
      }
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
    // Show/hide edit/delete for IB posts
    const editBtn = cardEl.querySelector('.reels-reel-edit-btn');
    const delBtn = cardEl.querySelector('.reels-reel-del-btn');
    const publishBtnReel = cardEl.querySelector('.reels-reel-publish-btn');
    const isIbPost = article._isPublished && article._pubId;
    const isOwner = currentUser && article._pubUserEmail === currentUser.email;
    if (editBtn) editBtn.style.display = (isIbPost && isOwner) ? '' : 'none';
    if (delBtn) delBtn.style.display = (isIbPost && isOwner) ? '' : 'none';
    if (publishBtnReel) publishBtnReel.style.display = isIbPost ? 'none' : '';
  }

  function sizeReelsContainer() {
    const container = el.main.querySelector('.reels-container');
    if (!container) return;
    /* Table layout handles all sizing. Clear any stale inline styles. */
    container.style.height = '';
    container.style.maxHeight = '';
  }

  function showReel() {
    const articles = reelsArticles();
    const idx = currentReelIndex;
    const article = articles[idx];
    const total = articles.length;

    sizeReelsContainer();

    const existing = el.main.querySelector('.reels-container');

    if (!existing) {
      // Build the toolbar with awareness of whether the current article has a
      // source image (so the "share with image" button is conditionally shown).
      const reelsImgUrl = article && article.imageUrl ? article.imageUrl.replace(/^\/\//, 'https://') : '';
      const hasThumb = reelsImgUrl && reelsImgUrl.startsWith('http');
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
        const currentArticle = reelsArticles()[currentReelIndex];

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
          // Screenshot card — actual DOM capture via dom-to-image-more
        const ssBtn = e.target.closest('.reels-screenshot');
        if (ssBtn) {
          e.stopPropagation();
          handleScreenshot(currentArticle, ssBtn);
          return;
        }
        const home = e.target.closest('.reels-home-btn');
        if (home) { e.stopPropagation(); forceExitToHome(); return; }
        const fsBtn = e.target.closest('.reels-fullscreen-btn');
        if (fsBtn) {
          e.stopPropagation();
          toggleReelsFullscreen();
          return;
        }
        const toggleDesc = e.target.closest('.reels-toggle-desc');
        if (toggleDesc) {
          e.stopPropagation();
          const current = Settings.get('showDescription');
          Settings.set('showDescription', !current);
          syncSettingsToCloud();
          // Toggle the active class on the button directly
          toggleDesc.classList.toggle('active', !current);
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
          wrapper.className = 'rr-fetched section-divider-top';
          wrapper.innerHTML = '<div class="rr-loading">Loading\u2026</div>';
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
        const reelPublishBtn = e.target.closest('.reels-reel-publish-btn');
        if (reelPublishBtn) {
          e.stopPropagation();
          if (!requireAuth()) return;
          if (currentArticle) openPublishModal(currentArticle);
          return;
        }
        const reelEditBtn = e.target.closest('.reels-reel-edit-btn');
        if (reelEditBtn) {
          e.stopPropagation();
          if (!requireAuth()) return;
          if (currentArticle && currentArticle._isPublished && currentArticle._pubId) editPublishedArticle(currentArticle._pubId);
          return;
        }
        const reelDelBtn = e.target.closest('.reels-reel-del-btn');
        if (reelDelBtn) {
          e.stopPropagation();
          if (!requireAuth()) return;
          if (currentArticle && currentArticle._isPublished && currentArticle._pubId) deletePublishedArticle(currentArticle._pubId);
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
    if (typeof window.PublishModal !== 'undefined' && window.PublishModal.setCurrentUser) {
      window.PublishModal.setCurrentUser(currentUser);
    }
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
    const articles = reelsArticles();
    if (currentReelIndex < 1) return;
    currentReelIndex--;
    const a = articles[currentReelIndex];
    if (a) trackView(a.link);
    showReel();
  }

  function nextReel() {
    const articles = reelsArticles();
    if (currentReelIndex >= articles.length - 1) return;
    currentReelIndex++;
    const a = articles[currentReelIndex];
    if (a) trackView(a.link);
    showReel();
  }

  async function fetchArticleHtml(url) {
    if (isGoogleNewsRedirect(url)) return null;
    const fetchProxies = [
      { url: 'https://corsproxy.io/?url=', encode: true },
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

  function toggleReelsFullscreen() {
    const container = document.querySelector('.reels-container');
    if (!container) return;
    const isFs = document.fullscreenElement || document.webkitFullscreenElement;
    if (isFs) {
      if (document.exitFullscreen) document.exitFullscreen();
      else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
    } else {
      if (container.requestFullscreen) container.requestFullscreen().catch(err => console.warn('Fullscreen failed:', err.message));
      else if (container.webkitRequestFullscreen) container.webkitRequestFullscreen();
    }
  }

  function syncFullscreenBtn() {
    const isFs = !!(document.fullscreenElement || document.webkitFullscreenElement);
    document.body.classList.toggle('cards-fullscreen', isFs);
    const btn = document.querySelector('.reels-fullscreen-btn');
    if (btn) btn.classList.toggle('active', isFs);
  }

  document.addEventListener('fullscreenchange', syncFullscreenBtn);
  document.addEventListener('webkitfullscreenchange', syncFullscreenBtn);

  // Exit reels view via the in-app exit button (e.g. the home button
  // on the reels card). Cleans up the back-stack entry that was pushed
  // when the user entered reels, so the next back press doesn't try
  // to close an already-gone reels frame.
  function exitReels() {
    if (currentView !== 'reels') return;
    const restore = _reelsExitRestore;
    _reelsExitRestore = null;
    _reelsArticles = null;
    currentView = 'list';
    _persist();
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
    if (restore) {
      try { restore(); } catch(e) { console.warn('reels exit restore failed', e); }
    } else {
      displayCurrentSubcat();
    }
  }

  /* ── Categories view ──
   * A dedicated browse page for Global and India categories.
   * Selecting a card jumps straight into the matching scope.
   */
  function renderCategoriesView() {
    updateStickyHeader('Categories');
    const scope = currentScope === 'nation' ? 'nation' : 'global';
    const title = scope === 'global' ? 'Global' : 'India';
    const subtitle = scope === 'global'
      ? 'International coverage, world affairs, and cross-border reporting.'
      : 'India-focused stories, national policy, and regional context.';
    const icon = scope === 'global' ? '🌍' : '🇮🇳';
    const items = FeedManager.subcategoriesForScope(scope);
    const html = '<div class="categories-view">' +
      '<div class="categories-hero">' +
        '<div class="categories-hero-kicker">Browse by category</div>' +
        '<h3>' + escHtml(title) + ' categories</h3>' +
        '<p>' + escHtml(subtitle) + '</p>' +
      '</div>' +
      '<div class="categories-grid">' +
        '<section class="categories-panel">' +
          '<div class="categories-panel-header">' +
            '<div class="categories-panel-icon">' + icon + '</div>' +
            '<div>' +
              '<h4>' + escHtml(title) + '</h4>' +
              '<p>Tap a card to jump into that feed directly.</p>' +
            '</div>' +
          '</div>' +
          '<div class="categories-pill-grid">' +
            items.map(subcat => {
              const label = subcat === 'all' ? 'All' : FeedManager.subcatLabel(subcat, scope);
              const iconName = FeedManager.subcatIcon(subcat);
              const isActive = currentSubcat === subcat;
              return '<button class="categories-pill' + (isActive ? ' active' : '') + '" type="button" data-scope="' + escHtml(scope) + '" data-nation="' + escHtml(currentNation) + '" data-subcat="' + escHtml(subcat) + '">' +
                '<span class="categories-pill-icon">' + iconName + '</span>' +
                '<span class="categories-pill-label">' + escHtml(label) + '</span>' +
              '</button>';
            }).join('') +
          '</div>' +
        '</section>' +
      '</div>' +
    '</div>';
    el.main.innerHTML = html;

    el.main.querySelectorAll('.categories-pill').forEach(btn => {
      btn.addEventListener('click', () => {
        const scope = btn.dataset.scope || currentScope;
        const nation = btn.dataset.nation || currentNation;
        const subcat = btn.dataset.subcat || 'all';
        openSectionSelection(scope, nation, 'news', subcat);
      });
    });
  }

  /* ── Conflicts view ──
   * Lists cross-source conflict clusters across all loaded scope caches,
   * sorted by severity. Each cluster is a card showing the involved
   * articles and the conflicting figures / claims.
   */
  function renderConflictsView(container) {
    const root = container || el.main;
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
      root.innerHTML = '<div class="conflicts-empty"><div class="ce-icon">⚠️</div>' +
        '<h3>No articles loaded yet</h3>' +
        '<p>Visit Global or your Nation tab first so we can analyze the latest articles for conflicts.</p></div>';
      return;
    }

    // 2) Run conflict detection on the aggregated pool. Capped
    //    to the most recent CONFLICT_CORPUS_CAP articles so the
    //    Conflicts view never takes more than ~1s to render.
    const recent = all.slice(0, CONFLICT_CORPUS_CAP);
    const map = AI.detectConflicts(recent);

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
      root.innerHTML = '<div class="conflicts-empty"><div class="ce-icon">✓</div>' +
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

    root.innerHTML = '<div class="conflicts-list">' + html + '</div>';

    // Wire article links to open the modal.
    root.querySelectorAll('.cc-article-link').forEach(link => {
      link.addEventListener('click', e => {
        e.preventDefault();
        const url = decodeURIComponent(link.dataset.link);
        openArticleDetail(url);
      });
    });
  }

  /* ── Topics view ──
   *
   * Lists "story clusters": groups of articles from 2+ different
   * sources that cover the same topic. Each card shows the
   * cluster topic, the number of covering sources, a derived
   * critical rating (editorial confidence from source diversity)
   * and a derived "people's" rating (proxy: how many of those
   * sources published in the last 24h). Clicking a card opens
   * a detail modal listing every article in the cluster; the
   * "build article" icon on each card opens the publisher
   * modal pre-filled with a fresh composition.
   */
  let _topicsClusters = [];
  let _topicsBuilding = false;

  async function renderTopicsView(container) {
    const root = container || el.main;
    updateStickyHeader('Topics view');
    if (Object.keys(scopeCache).length === 0) {
      root.innerHTML = '<div class="topics-empty"><div class="ce-icon">📰</div>' +
        '<h3>No articles loaded yet</h3>' +
        '<p>Load articles in <a href="#" class="switch-to-feeds" style="color:var(--accent);text-decoration:underline;">Feeds</a> first, then switch to Topics to see clusters.</p></div>';
      root.querySelector('.switch-to-feeds')?.addEventListener('click', e => {
        e.preventDefault();
        currentSection = 'feeds';
        renderSectionTabs();
        renderCurrentSection();
      });
      return;
    }
    let all = collectScopeArticles();
    if (!all.length) {
      root.innerHTML = '<div class="topics-empty"><div class="ce-icon">📰</div>' +
        '<h3>No articles loaded yet</h3>' +
        '<p>Load articles in <a href="#" class="switch-to-feeds" style="color:var(--accent);text-decoration:underline;">Feeds</a> first, then switch to Topics to see clusters.</p></div>';
      root.querySelector('.switch-to-feeds')?.addEventListener('click', e => {
        e.preventDefault();
        currentSection = 'feeds';
        renderSectionTabs();
        renderCurrentSection();
      });
      return;
    }
    if (currentSearch) {
      all = applySearch(all);
    }
    if (!all.length) {
      root.innerHTML = '<div class="topics-empty"><div class="ce-icon">🔍</div>' +
        '<h3>No articles match your search</h3>' +
        '<p>Try a different search term or clear the search to see all topics.</p></div>';
      return;
    }

    // Show a loading state immediately. The clustering pass can
    // take a second on a full cache.
    root.innerHTML = '<div class="topics-empty"><div class="ce-icon">⏳</div>' +
      '<h3>Clustering articles…</h3>' +
      '<p>Grouping ' + all.length + ' article' + (all.length === 1 ? '' : 's') + ' by topic. This takes a moment.</p></div>';

    try {
      // Cap to the most recent 500 so the O(n²) TF-IDF pass
      // stays under ~1 second on a typical phone. Older
      // articles just aren't considered for clustering — the
      // user is here for today's stories anyway.
      const pool = all.slice(0, 500);
      const clusters = await Clustering.clusterArticles(pool, { threshold: 0.25, maxArticles: 500, minSources: 2 });
      _topicsClusters = clusters;

      if (!clusters.length) {
        root.innerHTML = '<div class="topics-empty"><div class="ce-icon">🔍</div>' +
          '<h3>No topic clusters found</h3>' +
          '<p>Across ' + pool.length + ' articles, we couldn\'t find any stories covered by 2+ different sources. ' +
          'This is normal early in a session or for niche feeds.</p></div>';
        return;
      }

      const html = clusters.map(renderClusterCard).join('');
      root.innerHTML = '<div class="topics-list">' + html + '</div>';

      root.querySelectorAll('.topic-card').forEach(card => {
        const clusterId = card.dataset.clusterId;
        card.addEventListener('click', e => {
          if (e.target.closest('.topic-critical-pill')) return;
          openClusterModal(clusterId);
        });
      });
    } catch (err) {
      console.warn('Topics clustering failed:', err && err.message);
      root.innerHTML = '<div class="topics-empty"><div class="ce-icon">⚠️</div>' +
        '<h3>Couldn\'t cluster articles</h3>' +
        '<p>' + escHtml(err && err.message || 'Unknown error') + '</p></div>';
    }
  }

  function renderClusterCard(cluster) {
    const topic = escHtml(cluster.topic || 'Story');
    const sources = cluster.sources || [];
    const articles = cluster.articles || [];
    const sample = articles.slice(0, 3).map(a => escHtml(a.title || '')).filter(Boolean).join(' · ');
    const critClass = (cluster.criticalLabel || 'low').toLowerCase();
    const peopleClass = (cluster.peopleLabel || 'low').toLowerCase();
    return '<div class="topic-card" data-cluster-id="' + cluster.id + '">' +
      '<div class="topic-card-head">' +
        '<h3 class="topic-title">' + topic + '</h3>' +
      '</div>' +
      '<div class="topic-meta">' +
        '<span class="topic-sources"><strong>' + sources.length + '</strong> source' + (sources.length === 1 ? '' : 's') + ' · ' + articles.length + ' article' + (articles.length === 1 ? '' : 's') + '</span>' +
        '<span class="topic-rating-pill rating-critical ' + critClass + '" title="Editorial confidence based on source diversity">Critical: ' + escHtml(cluster.criticalLabel || 'Low') + '</span>' +
        '<span class="topic-rating-pill rating-people ' + peopleClass + '" title="How many of the covering sources published in the last 24h. Stand-in for actual public interest rating.">Recent: ' + escHtml(cluster.peopleLabel || 'Low') + '</span>' +
      '</div>' +
      (sample ? '<div class="topic-sample">' + sample + '</div>' : '') +
      '<div class="topic-source-chips">' +
        sources.slice(0, 6).map(s => '<span class="topic-source-chip">' + escHtml(s) + '</span>').join('') +
        (sources.length > 6 ? '<span class="topic-source-chip more">+' + (sources.length - 6) + ' more</span>' : '') +
      '</div>' +
    '</div>';
  }

  // Open the cluster detail modal showing every article in the
  // cluster, with clickable rows that go straight to the
  // article reader.
  function openClusterModal(clusterId) {
    const cluster = _topicsClusters.find(c => c.id === clusterId);
    if (!cluster) return;
    const modal = $('#cluster-modal');
    if (!modal) return;
    $('#cluster-modal-title').textContent = cluster.topic || 'Topic';
    const body = $('#cluster-modal-body');
    if (!body) return;

    const critClass = (cluster.criticalLabel || 'low').toLowerCase();
    const peopleClass = (cluster.peopleLabel || 'low').toLowerCase();

    const header = '<div class="cluster-modal-summary">' +
      '<div class="cluster-modal-meta">' +
        '<span class="topic-rating-pill rating-critical ' + critClass + '">Critical: ' + escHtml(cluster.criticalLabel || 'Low') + '</span>' +
        '<span class="topic-rating-pill rating-people ' + peopleClass + '">Recent: ' + escHtml(cluster.peopleLabel || 'Low') + '</span>' +
        '<span class="cluster-modal-stat"><strong>' + cluster.sourceCount + '</strong> source' + (cluster.sourceCount === 1 ? '' : 's') + ' · ' +
        '<strong>' + cluster.articles.length + '</strong> article' + (cluster.articles.length === 1 ? '' : 's') + ' · ' +
        '<strong>' + cluster.recentCount + '</strong> in last 24h</span>' +
      '</div>' +
      '<button class="btn btn-primary cluster-build-btn" data-cluster-id="' + cluster.id + '">' +
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
          '<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>' +
        '</svg>' +
        'Build article from this topic' +
      '</button>' +
    '</div>';

    const rows = cluster.articles.map(a => {
      const title = escHtml(a.title || a.link || 'Untitled');
      const source = escHtml(a.source || 'Unknown source');
      const dateStr = a.pubDate ? formatDateShort(a.pubDate) : '';
      const lang = a.lang || 'en';
      return '<a class="cluster-article-row" data-link="' + encodeURIComponent(a.link || '') + '" href="javascript:void(0)">' +
        '<div class="cluster-article-title">' + title + '</div>' +
        '<div class="cluster-article-meta"><span>' + source + '</span>' + (dateStr ? '<span>·</span><span>' + dateStr + '</span>' : '') + '<span class="cluster-article-lang">' + lang + '</span></div>' +
      '</a>';
    }).join('');

    body.innerHTML = header + '<div class="cluster-article-list">' + rows + '</div>';

    // Wire rows: click → article reader.
    body.querySelectorAll('.cluster-article-row').forEach(row => {
      row.addEventListener('click', e => {
        e.preventDefault();
        const url = decodeURIComponent(row.dataset.link || '');
        if (!url) return;
        openArticleDetail(url);
      });
    });
    // Wire build button.
    const buildBtn = body.querySelector('.cluster-build-btn');
    if (buildBtn) {
      buildBtn.addEventListener('click', () => {
        closeClusterModal();
        openBuildModal(cluster.id);
      });
    }

    openModal('cluster', modal, closeClusterModal);
  }

  function closeClusterModal() {
    const modal = $('#cluster-modal');
    if (modal) modal.classList.remove('open');
  }

  // Open the publisher modal for a cluster. Generates a
  // fresh composition (headline + lead + 2–4 body sentences
  // attributed to sources + closing line) using TF.js USE
  // when available, falling back to TF-IDF otherwise.
  async function openBuildModal(clusterId) {
    const cluster = _topicsClusters.find(c => c.id === clusterId);
    if (!cluster) return;
    const modal = $('#build-modal');
    if (!modal) return;
    const body = $('#build-modal-body');
    if (!body) return;

    if (_topicsBuilding) return;
    _topicsBuilding = true;

    // Show loading overlay while the publisher composes the article
    showLoadingOverlay('Composing article\u2026');
    updateLoadingStatus('Reading ' + cluster.articles.length + ' sources and selecting key sentences\u2026');
    modal.classList.add('open');

    try {
      const article = await Publisher.buildArticle(cluster);
      hideLoadingOverlay();
      renderBuildArticle(article, cluster);
    } catch (err) {
      hideLoadingOverlay();
      console.warn('Build article failed:', err && err.message);
      body.innerHTML = '<div class="build-loading"><div class="ce-icon">⚠️</div>' +
        '<h3>Couldn\'t build article</h3>' +
        '<p>' + escHtml(err && err.message || 'Unknown error') + '</p></div>';
    } finally {
      _topicsBuilding = false;
    }
  }

  function renderBuildArticle(article, cluster) {
    const body = $('#build-modal-body');
    if (!body) return;
    const title = $('#build-modal-title');
    if (title) title.textContent = article.headline || 'Build Article';

    // Render the sources section as a list of clickable
    // entries (one per article in the cluster). Each shows
    // the article title, the source name, and the publish
    // date. Clicking opens the article in a new tab.
    const sourceRows = (article.sources || []).map(s => {
      const titleAttr = escHtml(s.title);
      const srcAttr = escHtml(s.name);
      const link = encodeURIComponent(s.link || '');
      const dateStr = s.pubDate ? formatDateShort(s.pubDate) : '';
      return '<a class="build-source-row" data-link="' + link + '" href="' + escHtml(s.link) + '" target="_blank" rel="noopener noreferrer">' +
        '<div class="build-source-title">' + titleAttr + '</div>' +
        '<div class="build-source-meta">' +
          '<span class="build-source-name">' + srcAttr + '</span>' +
          (dateStr ? '<span class="build-source-sep">·</span><span class="build-source-date">' + dateStr + '</span>' : '') +
        '</div>' +
      '</a>';
    }).join('');

    // The body is a single cohesive description (lead + 2–3
    // central sentences + closing, joined into one paragraph).
    // No inline source attribution — sources live in the
    // dedicated section below.
    const fullText = articleToPlainText(article);

    body.innerHTML =
      '<div class="build-headline-wrap">' +
        '<label class="build-label">Headline</label>' +
        '<input type="text" id="build-headline-input" class="build-headline" value="' + escHtml(article.headline || '') + '">' +
      '</div>' +
      '<div class="build-body-wrap">' +
        '<label class="build-label">Body (edit before publishing)</label>' +
        '<textarea id="build-article-textarea" class="build-textarea" rows="12">' +
          escHtml(fullText) +
        '</textarea>' +
      '</div>' +
      '<div class="build-actions">' +
        '<button class="btn btn-ghost" id="build-copy-btn">\uD83D\uDCCB Copy text</button>' +
        '<button class="btn btn-ghost" id="build-copy-md-btn">\uD83D\uDCCB Copy as Markdown</button>' +
        (currentUser ? '<button class="btn btn-primary" id="build-publish-btn">\uD83D\uDCE4 Publish</button>' : '') +
      '</div>' +
      '<div class="build-sources-wrap">' +
        '<div class="build-sources-header" id="build-sources-toggle">' +
          '<label class="build-label">Sources (' + (article.sources || []).length + ')</label>' +
          '<span class="build-sources-arrow">\u25B6</span>' +
        '</div>' +
        '<div class="build-sources-list" id="build-sources-list" style="display:none">' + (sourceRows || '<div class="build-no-sources">No source links available.</div>') + '</div>' +
      '</div>';

    // Wire buttons.
    const copyBtn = body.querySelector('#build-copy-btn');
    if (copyBtn) copyBtn.addEventListener('click', () => copyBuildArticle(article, 'text'));
    const copyMdBtn = body.querySelector('#build-copy-md-btn');
    if (copyMdBtn) copyMdBtn.addEventListener('click', () => copyBuildArticle(article, 'md'));
    const publishBtn = body.querySelector('#build-publish-btn');
    if (publishBtn) {
      publishBtn.addEventListener('click', () => {
        const headline = $('#build-headline-input')?.value?.trim() || article.headline || '';
        const textarea = $('#build-article-textarea');
        const desc = textarea?.value?.trim() || '';
        const fakeArticle = {
          title: headline,
          summary: desc,
          link: '',
          source: 'Built Article',
          _clusterSources: article.sources || [],
          subject: { display_name: headline }
        };
        openPublishModal(fakeArticle, article.sources || []);
      });
    }
    // Wire collapsible sources toggle
    const sourcesToggle = body.querySelector('#build-sources-toggle');
    const sourcesList = body.querySelector('#build-sources-list');
    if (sourcesToggle && sourcesList) {
      sourcesToggle.addEventListener('click', () => {
        const isOpen = sourcesList.style.display !== 'none';
        sourcesList.style.display = isOpen ? 'none' : 'block';
        const arrow = sourcesToggle.querySelector('.build-sources-arrow');
        if (arrow) arrow.textContent = isOpen ? '\u25B6' : '\u25BC';
      });
    }
  }

  // Build the plain-text version of the article for the
  // textarea + clipboard copy. ONE description (no per-
  // sentence attribution); sources are listed at the end
  // with their URLs.
  function articleToPlainText(article) {
    const lines = [];
    lines.push(article.headline || '');
    lines.push('');
    if (article.lead) { lines.push(article.lead); }
    if (article.body) { lines.push(article.body); }
    if (article.closing) { lines.push(article.closing); }
    lines.push('');
    lines.push('Sources:');
    for (const s of (article.sources || [])) {
      const t = s.title || s.link || 'Untitled';
      const src = s.name ? ' — ' + s.name : '';
      lines.push('  • ' + t + src);
      if (s.link) lines.push('    ' + s.link);
    }
    return lines.join('\n').trim();
  }

  // Markdown version: same structure, with the sources as
  // a bulleted list with proper markdown links.
  function articleToMarkdown(article) {
    const lines = [];
    lines.push('# ' + (article.headline || ''));
    lines.push('');
    if (article.lead) { lines.push('> ' + article.lead); }
    if (article.body) { lines.push(article.body); }
    if (article.closing) { lines.push('*' + article.closing + '*'); }
    lines.push('');
    lines.push('## Sources');
    for (const s of (article.sources || [])) {
      const t = s.title || s.link || 'Untitled';
      if (s.link) lines.push('- [' + t + '](' + s.link + ')' + (s.name ? ' — ' + s.name : ''));
      else lines.push('- ' + t + (s.name ? ' — ' + s.name : ''));
    }
    return lines.join('\n').trim();
  }

  async function copyBuildArticle(article, format) {
    const text = format === 'md' ? articleToMarkdown(article) : articleToPlainText(article);
    try {
      await navigator.clipboard.writeText(text);
      const btn = format === 'md' ? $('#build-copy-md-btn') : $('#build-copy-btn');
      if (btn) {
        const prev = btn.textContent;
        btn.textContent = '✓ Copied';
        setTimeout(() => { btn.textContent = prev; }, 1400);
      }
    } catch (e) {
      console.warn('Copy failed:', e && e.message);
    }
  }

  function closeBuildModal() {
    const modal = $('#build-modal');
    if (modal) modal.classList.remove('open');
  }

  /* ── Published articles storage (Supabase) ── */
  let _publishedCache = [];
  let _publishedFetchPromise = null;

  /** Format integer post_id as IB00001, IB00002, etc. */
  function formatPostId(id) {
    if (!id && id !== 0) return '';
    return 'IB' + String(id).padStart(5, '0');
  }

  function getSupabaseClient() {
    try { return SupabaseStore.getClient(); } catch { return null; }
  }

  async function fetchPublishedArticlesFromSupabase() {
    if (_publishedFetchPromise) return _publishedFetchPromise;
    _publishedFetchPromise = (async () => {
      try {
        const client = getSupabaseClient();
        if (!client) return [];
        const { data, error } = await client
          .from('published_articles')
          .select('*')
          .order('date_published', { ascending: false });
        if (error) throw error;
        console.log('[fetchPublishedArticlesFromSupabase] fetched ' + (data || []).length + ' articles from Supabase');
        _publishedCache = (data || []).map(r => {
          // Build image URL from post_id if present
          let imageUrl = '';
          if (r.post_id && (r.type === 'quote' || r.type === 'feeds')) {
            imageUrl = SUPABASE_URL + '/storage/v1/object/public/ib-post-images/' + formatPostId(r.post_id) + '.jpg';
            r._imageUrlJpg = imageUrl;
            r._imageUrlPng = SUPABASE_URL + '/storage/v1/object/public/ib-post-images/' + formatPostId(r.post_id) + '.png';
          }
          return {
            id: r.id,
            title: r.title || '',
            link: r.source_link || 'pub_' + r.id,
            summary: r.body || '',
            source: 'Invisible Broadcast',
            pubDate: r.date_published || r.created_at || new Date().toISOString(),
            feedUrl: 'published',
            feedHint: r.category || 'all',
            imageUrl: imageUrl,
            author: r.author || r.user_email || '',
            guid: 'pub_' + r.id,
            _isPublished: true,
            _pubScope: r.scope || 'global',
            _pubNation: r.nation || '',
            _pubCategory: r.category || 'all',
            _pubUserEmail: r.user_email || '',
            _pubId: r.id,
            _pubPostId: formatPostId(r.post_id),
            _pubType: r.type || 'feeds',
            _pubQuoteFrom: r.quote_from || '',
            _pubQuoteDate: r.quote_date || '',
            _pubQuoteOccupation: r.quote_occupation || '',
            _pubSourceName: r.source_name || '',
            _pubSourceLink: r.source_link || ''
          };
        });
        return _publishedCache;
      } catch (err) {
        console.warn('[Publish] Failed to fetch from Supabase:', err.message);
        return [];
      } finally {
        _publishedFetchPromise = null;
      }
    })();
    return _publishedFetchPromise;
  }

  function getCachedPublished() {
    return _publishedCache;
  }

  function applySourceFilter(articles) {
    if (sourceFilter === 'ib') {
      return articles.filter(a => a._isPublished);
    }
    if (sourceFilter === 'feeds') {
      return articles.filter(a => !a._isPublished);
    }
    return articles;
  }

  function addPublishedToFeed(articles) {
    const published = getCachedPublished();
    console.log('[addPublishedToFeed] sourceFilter=' + sourceFilter + ', published=' + published.length + ', articles=' + articles.length);
    if (!published.length || sourceFilter === 'feeds') return articles;
    if (sourceFilter === 'ib') {
      console.log('[addPublishedToFeed] returning published only:', published.length);
      return published;
    }
    return [...published, ...articles];
  }

  function getUserDisplayName() {
    if (!currentUser) return 'Unknown Author';
    return currentUser.user_metadata?.full_name || currentUser.user_metadata?.name || currentUser.email || 'Unknown Author';
  }

  function openPublishModal(article, sources) {
    if (!currentUser) return;
    const modal = $('#publish-modal');
    const body = $('#publish-modal-body');
    if (!modal || !body) return;
    modal.classList.add('open');
    const titleInput = $('#publish-title-input');
    const descInput = $('#publish-desc-textarea');
    const status = $('#publish-status');
    const authorInput = $('#publish-author-input');
    const sourcesContainer = $('#publish-sources-list');
    if (titleInput) titleInput.value = article.subject?.display_name || article.title || '';
    if (descInput) descInput.value = article.summary || '';
    if (status) status.textContent = '';
    if (authorInput) authorInput.value = getUserDisplayName();

    // Build sources list
    const sourceList = sources || (article._clusterSources) || (article.link ? [{ name: article.source || 'Source', link: article.link, title: article.title }] : []);
    if (sourcesContainer) {
      if (sourceList.length) {
        sourcesContainer.innerHTML = sourceList.map(s =>
          '<label class="publish-source-item">' +
            '<input type="checkbox" class="publish-source-cb" value="' + escAttr(s.link || '') + '" checked data-name="' + escAttr(s.name || '') + '" data-title="' + escAttr(s.title || '') + '">' +
            '<span class="publish-source-name">' + escHtml(s.name || 'Unknown') + '</span>' +
            '<span class="publish-source-title">' + escHtml((s.title || '').substring(0, 80)) + '</span>' +
          '</label>'
        ).join('');
      } else {
        sourcesContainer.innerHTML = '<div style="color:var(--text-tertiary);font-size:0.82rem;padding:8px;">No sources available.</div>';
      }
    }

    body._article = article;
    body._sources = sourceList;
    const closeBtn = $('#publish-modal-close');
    if (closeBtn) closeBtn.onclick = () => { modal.classList.remove('open'); };

    // Pre-fill scope/category
    const scopeSelect = $('#publish-scope-select');
    const nationSelect = $('#publish-nation-select');
    const categorySelect = $('#publish-category-select');
    if (scopeSelect) {
      scopeSelect.value = article._pubScope || currentScope || 'global';
      scopeSelect.onchange = () => {
        const wrap = document.getElementById('publish-nation-wrap');
        if (wrap) wrap.style.display = scopeSelect.value === 'nation' ? '' : 'none';
      };
      scopeSelect.onchange();
    }
    if (nationSelect) nationSelect.value = article._pubNation || currentNation || 'india';
    if (categorySelect) categorySelect.value = article._pubCategory || article.feedHint || currentSubcat || 'all';

    const submitBtn = $('#publish-submit-btn');
    if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = '\uD83D\uDCE4 Publish'; }
    if (submitBtn) submitBtn.onclick = async () => {
      const titleInput = $('#publish-title-input');
      const descInput = $('#publish-desc-textarea');
      const authorInput = $('#publish-author-input');
      const status = $('#publish-status');
      const checkedSources = [...document.querySelectorAll('.publish-source-cb:checked')].map(cb => ({
        name: cb.dataset.name || 'Source',
        link: cb.value,
        title: cb.dataset.title || ''
      }));
      if (!titleInput || !descInput) return;
      if (!titleInput.value.trim()) {
        if (status) status.textContent = 'Please enter a title.';
        return;
      }
      if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = '\u23F3 Publishing\u2026'; }
      if (status) status.textContent = 'Publishing\u2026';
      try {
        const authorName = authorInput?.value?.trim() || getUserDisplayName();
        const client = getSupabaseClient();
        if (!client) throw new Error('Supabase not available');
        const scopeVal = scopeSelect?.value || currentScope;
        const nationVal = scopeVal === 'nation' ? (nationSelect?.value || currentNation) : '';
        const categoryVal = categorySelect?.value || currentSubcat || 'all';
        const sourceName = checkedSources.map(s => s.name).join(', ') || article.source || '';
        const sourceLink = checkedSources.map(s => s.link).filter(Boolean).join(', ') || article.link || '';
        const { error } = await client
          .from('published_articles')
          .insert({
            user_id: currentUser.id,
            user_email: currentUser.email || '',
            author: authorName,
            date_published: new Date().toISOString(),
            title: titleInput.value.trim(),
            body: descInput.value.trim(),
            source_name: sourceName,
            source_link: sourceLink,
            scope: scopeVal,
            nation: nationVal,
            category: categoryVal,
            last_modified: new Date().toISOString()
          });
        if (error) throw error;
        // Refresh published cache
        _publishedCache = [];
        await fetchPublishedArticlesFromSupabase();
        if (status) {
          status.innerHTML = '\u2705 Published! <span style="color:var(--text-secondary);font-size:0.82rem;">Article saved to Supabase.</span>';
        }
        if (submitBtn) { submitBtn.textContent = '\u2705 Published'; }
        renderPublishedFeed();
      } catch (err) {
        console.warn('[Publish] Failed:', err);
        if (status) status.textContent = '\u274c ' + (err.message || 'Publish failed');
        if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = '\uD83D\uDCE4 Publish'; }
      }
    };
  }

  function renderPublishedFeed() {
    const published = getCachedPublished();
    if (published.length) {
      const container = $('#published-feed');
      if (container) {
        container.innerHTML = published.slice(0, 5).map(p =>
          '<div class="published-item">' +
            '<div class="published-title">' + escHtml(p.title || '') + '</div>' +
            '<div class="published-meta">' + escHtml(p.author || '') + ' · ' + (p.pubDate ? formatDateShort(p.pubDate) : '') + '</div>' +
          '</div>'
        ).join('');
      }
    }
  }

  async function editPublishedArticle(pubId) {
    if (!currentUser) return;
    function _setElMsg(el, text, type) {
      if (!el) return;
      el.textContent = text;
      el.className = 'publish-msg';
      if (type) el.classList.add(type);
    }
    try {
      const client = getSupabaseClient();
      if (!client) return;
      const { data, error } = await client
        .from('published_articles')
        .select('*')
        .eq('id', pubId)
        .single();
      if (error || !data) throw error || new Error('Not found');
      // Check 3-day edit window
      const pubDate = new Date(data.date_published);
      const diffDays = (Date.now() - pubDate.getTime()) / (1000 * 60 * 60 * 24);
      if (diffDays > 3) { alert('Edit window expired (3 days from publishing)'); return; }
      if (data.user_email !== currentUser.email) { alert('Only the author can edit this post'); return; }

      // Open the publish modal
      const modal = $('#yt-publish-modal');
      if (!modal) return;
      modal.classList.add('open');

      const isQuote = data.type === 'quote';

      // Switch to the correct tab
      if (isQuote) {
        $$('.publish-tab').forEach(t => t.classList.toggle('active', t.dataset.publishTab === 'quotes'));
        $$('.publish-pane').forEach(p => p.classList.toggle('active', p.dataset.publishPane === 'quotes'));
      } else {
        $$('.publish-tab').forEach(t => t.classList.toggle('active', t.dataset.publishTab === 'youtube'));
        $$('.publish-pane').forEach(p => p.classList.toggle('active', p.dataset.publishPane === 'youtube'));
      }

      if (isQuote) {
        // Pre-fill quote fields
        const quoteDesc = $('#quote-desc');
        const quoteFrom = $('#quote-from');
        const quoteOccupation = $('#quote-occupation');
        const quoteDate = $('#quote-date');
        const quoteSourceLink = $('#quote-source-link');
        const quoteScopeSelect = $('#quote-scope-select');
        const quoteMsg = $('#quote-publish-msg');
        if (quoteDesc) quoteDesc.value = data.body || '';
        if (quoteFrom) quoteFrom.value = data.quote_from || data.source_name || '';
        if (quoteOccupation) quoteOccupation.value = data.quote_occupation || '';
        if (quoteDate) quoteDate.value = data.quote_date || '';
        if (quoteSourceLink) quoteSourceLink.value = data.source_link || '';
        if (quoteScopeSelect) quoteScopeSelect.value = data.scope || 'global';
        if (quoteMsg) { quoteMsg.textContent = ''; quoteMsg.className = 'publish-msg'; }

        const quoteBtn = $('#quote-publish-btn');
        if (quoteBtn) {
          quoteBtn.textContent = '\uD83D\uDCE4 Update Quote';
          // Signal to publish-modal.ts to skip its addEventListener handler
          window._ibSkipPublish = true;
          quoteBtn.onclick = async () => {
            const desc = $('#quote-desc')?.value?.trim();
            const qFrom = $('#quote-from')?.value?.trim();
            const qOccupation = $('#quote-occupation')?.value?.trim() || '';
            const qLink = $('#quote-source-link')?.value?.trim();
            const qScope = $('#quote-scope-select')?.value || 'global';
            const qDate = $('#quote-date')?.value || '';
            if (!desc) { _setElMsg(quoteMsg, 'Please enter the quote text', 'error'); return; }
            quoteBtn.disabled = true; quoteBtn.textContent = 'Updating\u2026';
            try {
              const c2 = getSupabaseClient();
              const { error: updErr } = await c2.from('published_articles').update({
                body: desc,
                source_name: qFrom || '',
                source_link: qLink || '',
                scope: qScope,
                nation: qScope === 'nation' ? 'india' : '',
                quote_from: qFrom || '',
                quote_date: qDate,
                quote_occupation: qOccupation,
                last_modified: new Date().toISOString()
              }).eq('id', pubId);
              if (updErr) throw updErr;
              _publishedCache = [];
              await fetchPublishedArticlesFromSupabase();
              if (quoteMsg) { quoteMsg.innerHTML = '\u2705 Updated!'; quoteMsg.className = 'publish-msg success'; }
              quoteBtn.textContent = '\u2705 Updated';
              setTimeout(() => { modal.classList.remove('open'); displayCurrentSubcat(); }, 1000);
            } catch (e) {
              if (quoteMsg) { quoteMsg.textContent = '\u274c ' + (e.message || 'Update failed'); quoteMsg.className = 'publish-msg error'; }
              quoteBtn.disabled = false; quoteBtn.textContent = '\uD83D\uDCE4 Update Quote';
            }
          };
        }
      } else {
        // Pre-fill YouTube fields
        const titleInput = $('#publish-title');
        const descInput = $('#publish-desc');
        const urlInput = $('#publish-url');
        const pubMsg = $('#publish-msg');
        if (titleInput) titleInput.value = data.title || '';
        if (descInput) descInput.value = data.body || '';
        if (urlInput) urlInput.value = data.source_link || '';
        if (pubMsg) { pubMsg.textContent = ''; pubMsg.className = 'publish-msg'; }

        const ytBtn = $('#yt-publish-btn');
        if (ytBtn) {
          ytBtn.textContent = '\uD83D\uDCE4 Update';
          window._ibSkipPublish = true;
          ytBtn.onclick = async () => {
            const t = $('#publish-title')?.value?.trim();
            const d = $('#publish-desc')?.value?.trim();
            const u = $('#publish-url')?.value?.trim();
            if (!t) { _setElMsg(pubMsg, 'Please enter a title', 'error'); return; }
            ytBtn.disabled = true; ytBtn.textContent = 'Updating\u2026';
            try {
              const c2 = getSupabaseClient();
              const { error: updErr } = await c2.from('published_articles').update({
                title: t,
                body: d || '',
                source_link: u || '',
                last_modified: new Date().toISOString()
              }).eq('id', pubId);
              if (updErr) throw updErr;
              _publishedCache = [];
              await fetchPublishedArticlesFromSupabase();
              if (pubMsg) { pubMsg.innerHTML = '\u2705 Updated!'; pubMsg.className = 'publish-msg success'; }
              ytBtn.textContent = '\u2705 Updated';
              setTimeout(() => { modal.classList.remove('open'); displayCurrentSubcat(); }, 1000);
            } catch (e) {
              if (pubMsg) { pubMsg.textContent = '\u274c ' + (e.message || 'Update failed'); pubMsg.className = 'publish-msg error'; }
              ytBtn.disabled = false; ytBtn.textContent = '\uD83D\uDCE4 Update';
            }
          };
        }
      }

      // Close button
      const closeBtn = $('#yt-publish-modal-close');
      if (closeBtn) closeBtn.onclick = () => modal.classList.remove('open');

    } catch (err) {
      console.warn('[Publish] Edit failed:', err.message);
      alert('Failed to load article for editing');
    }
  }

  async function deletePublishedArticle(pubId) {
    if (!currentUser) return;
    if (!confirm('Delete this IB post? This cannot be undone.')) return;
    try {
      const client = getSupabaseClient();
      if (!client) throw new Error('Supabase not available');
      // Verify ownership and 3-day window
      const { data, error } = await client
        .from('published_articles')
        .select('user_email, date_published')
        .eq('id', pubId)
        .single();
      if (error || !data) throw error || new Error('Not found');
      if (data.user_email !== currentUser.email) { alert('Only the author can delete this post'); return; }
      const pubDate = new Date(data.date_published);
      const diffDays = (Date.now() - pubDate.getTime()) / (1000 * 60 * 60 * 24);
      if (diffDays > 3) { alert('Delete window expired (3 days from publishing)'); return; }
      const { error: delErr } = await client
        .from('published_articles')
        .delete()
        .eq('id', pubId);
      if (delErr) throw delErr;
      _publishedCache = [];
      await fetchPublishedArticlesFromSupabase();
      displayCurrentSubcat();
    } catch (err) {
      console.warn('[Publish] Delete failed:', err.message);
      alert('Delete failed: ' + (err.message || 'Unknown error'));
    }
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

  // Language list shown in the translate modal. The native name is
  // the value displayed to the user (Hindi speakers see हिन्दी, not
  // "Hindi"); the `code` is what we save to Settings. The list is
  // derived from Settings.LANGUAGES when available, with a sensible
  // fallback so the modal still works if the settings module is
  // empty.
  const LANG_LIST = (() => {
    if (typeof Settings !== 'undefined' && Settings.LANGUAGES) {
      return Object.entries(Settings.LANGUAGES).map(([code, native]) => ({ code, native }));
    }
    return [
      { code: 'en', native: 'English' },
      { code: 'hi', native: 'हिन्दी' },
      { code: 'kn', native: 'ಕನ್ನಡ' },
      { code: 'ta', native: 'தமிழ்' },
      { code: 'te', native: 'తెలుగు' },
      { code: 'ml', native: 'മലയാളം' },
      { code: 'bn', native: 'বাংলা' },
      { code: 'mr', native: 'मराठी' },
      { code: 'gu', native: 'ગુજરાતી' },
      { code: 'pa', native: 'ਪੰਜਾਬੀ' },
      { code: 'ur', native: 'اردو' },
      { code: 'es', native: 'Español' },
      { code: 'fr', native: 'Français' },
      { code: 'ar', native: 'العربية' },
      { code: 'zh', native: '中文' },
      { code: 'ja', native: '日本語' },
      { code: 'de', native: 'Deutsch' },
      { code: 'ru', native: 'Русский' },
      { code: 'pt', native: 'Português' }
    ];
  })();

  // Build the language list inside the translate modal and bind
  // each row so clicking a language saves the preference and
  // re-translates the visible articles.
  function openTranslateModal() {
    if (!el.translateModalBody) return;
    const current = Settings.get('language') || 'en';
    el.translateModalBody.innerHTML = LANG_LIST.map(l => {
      const active = l.code === current;
      return '<button type="button" class="tl-row' + (active ? ' tl-row-active' : '') +
        '" data-lang="' + l.code + '">' +
        '<span class="tl-native">' + l.native + '</span>' +
        (active ? '<span class="tl-check">✓</span>' : '') +
      '</button>';
    }).join('');
    openModal('translate', el.translateModal);
    // Bind clicks
    el.translateModalBody.querySelectorAll('.tl-row').forEach(btn => {
      btn.addEventListener('click', () => {
        const code = btn.dataset.lang;
        if (!code) return;
        Settings.save({ language: code });
        syncSettingsToCloud();
        closeModal('translate');
        const key = scopeKey();
        const cached = scopeCache[key];
        if (!cached) return;
        const articles = getFilteredArticles(currentSubcat, cached);
        renderTranslated(articles);
      });
    });
  }

  function bindTranslate() {
    if (el.translateBtn) {
      el.translateBtn.addEventListener('click', openTranslateModal);
    }
    if (el.translateModal) {
      const closeBtn = $('#translate-modal-close');
      if (closeBtn) closeBtn.addEventListener('click', () => closeModal('translate'));
      el.translateModal.addEventListener('click', e => {
        if (e.target === el.translateModal) closeModal('translate');
      });
    }
    // Cluster detail modal.
    const clusterModal = $('#cluster-modal');
    if (clusterModal) {
      const closeBtn = $('#cluster-modal-close');
      if (closeBtn) closeBtn.addEventListener('click', () => closeModal('cluster'));
      clusterModal.addEventListener('click', e => {
        if (e.target === clusterModal) closeModal('cluster');
      });
    }
    // Build-article modal.
    const buildModal = $('#build-modal');
    if (buildModal) {
      const closeBtn = $('#build-modal-close');
      if (closeBtn) closeBtn.addEventListener('click', closeBuildModal);
      buildModal.addEventListener('click', e => {
        if (e.target === buildModal) closeBuildModal();
      });
    }
  }

  function isGoogleNewsRedirect(url) {
    try { return new URL(url).hostname === 'news.google.com' && url.includes('/rss/articles/'); }
    catch { return false; }
  }

  // Sort options are static (Date ↓, Date ↑, Source A–Z). When the
  // user is in Trending mode the list is already pre-sorted by the
  // engine so sort is disabled, but we still keep the value
  // remembered so switching back to Live resumes the same sort.
  function updateSortOptions() {
    if (!el.sortBy) return;
    if (!el.sortBy.value) el.sortBy.value = currentSort || 'date-desc';
    currentSort = el.sortBy.value;
    _persist();
    // Keep the extras select in sync if it exists.
    if (el.sortByExtras && el.sortByExtras.value !== currentSort) {
      el.sortByExtras.value = currentSort;
    }
  }

  // updateModeButtonActive highlights the active mode button in any
  // legacy mode-toggle UI. With only Live + Trending remaining and
  // the toggle removed, this is a no-op.
  function updateModeButtonActive() { /* no-op: handled by updateRankControls */ }

  // Human-readable scope + subcategory label for the "where it's trending" details.
  // e.g. "Global · Technology" / "India · Politics" / "Global · All".
  function scopeLabel(scope, subcat) {
    const scopeName = (scope === 'nation')
      ? (FeedManager.getSelectedNation ? FeedManager.getSelectedNation() : 'Nation')
      : 'Global';
    const subName = (subcat && subcat !== 'all') ? (subcat.charAt(0).toUpperCase() + subcat.slice(1)) : 'All';
    return scopeName + ' · ' + subName;
  }

  // updateRankControls highlights the Trending button when the user
  // is in the Trending mode (the only non-Live mode that remains).
  function updateRankControls() {
    const inTrending = currentMode === 'top' && currentRankType === 'keyword';
    if (el.trendingBtn) {
      el.trendingBtn.classList.toggle('active', inTrending);
      el.trendingBtn.setAttribute('aria-pressed', inTrending ? 'true' : 'false');
    }
  }

  // Toggle Trending <-> Live. Trending shows the top 25 articles in
  // the current scope/subcat, ranked deterministically (TF-IDF ×
  // recency × buzz × authority). Click the button again to return
  // to Live.
  function toggleTrending() {
    const prevMode = currentMode;
    if (currentMode === 'top' && currentRankType === 'keyword') {
      currentMode = 'live';
      currentRankType = 'ai'; // reset to legacy default
    } else {
      currentMode = 'top';
      currentRankType = 'keyword';
    }
    switchModeNonBlocking(prevMode);
  }

  function bindTrendingBtn() {
    if (!el.trendingBtn) return;
    el.trendingBtn.addEventListener('click', () => toggleTrending());
  }

  // Minimum visible time for the mode-switch loading screen.
  // Without this, the Trending → Live switch is so fast (data
  // is already cached, no ranking pass, no conflict detection
  // over the full pool) that the loading state paints and
  // disappears within one frame — the user sees a flicker
  // rather than a clear "switching" transition. Showing the
  // loading state for at least 220 ms (a beat + a half) makes
  // the mode toggle feel deliberate in BOTH directions:
  // Live → Trending (because the ranking is slow) and
  // Trending → Live (because we hold the loading state for the
  // minimum). The user can still see a refresh-action button
  // or move on; the hold is only on the loading overlay.
  const MIN_MODE_LOADING_MS = 220;

  function switchModeNonBlocking(prevMode) {
    const token = ++pendingModeSwitch;
    loadedCount = 0;
    liveAllLoaded = false;
    loadAllState = 'idle';
    liveAllArticles = null;
    hasFreshBackground = false;
    // Skip the O(N²) heavy work (trending + conflict detection)
    // on the mode-switch render. Without this, the user clicking
    // Trending → Live freezes for ~2 seconds because conflict
    // detection runs over 200 articles (5k Jaccard + claim +
    // numeric pair comparisons). The cost was always there but
    // it was hidden by the ranking pass on Live → Trending.
    // The next user interaction (search, sort, filter, like)
    // re-arms the flag via renderCurrentList / bindSearch.
    skipHeavyWork = true;
    updateModeButtonActive();
    updateRankControls();
    updateSortOptions();
    updateStickyHeader();
    // Show a clear, user-friendly status message immediately. We
    // also paint the loading state into #main-content right away
    // so the user can't be left staring at a stale list while
    // the new one is being computed.
    if (currentMode === 'top') {
      setTopListStatus('Computing Trending…');
      showLoadingInline('Computing Trending…');
    } else {
      setTopListStatus('Loading live news…');
      showLoadingInline('Loading live news…');
    }
    const t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    requestAnimationFrame(() => {
      if (token !== pendingModeSwitch) return;
      (async () => {
        try {
          await displayCurrentSubcat();
        } finally {
          // Hold the loading state for at least MIN_MODE_LOADING_MS
          // from the moment the user clicked. If the underlying
          // work (ranking, conflict detection, translation) was
          // already slow, this is a no-op; if it was fast, this
          // keeps the loading state visible long enough for the
          // user to register the transition.
          const elapsed = ((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - t0;
          const remaining = Math.max(0, MIN_MODE_LOADING_MS - elapsed);
          if (remaining > 0) await new Promise(r => setTimeout(r, remaining));
          if (token === pendingModeSwitch) clearTopListStatus();
        }
      })();
    });
  }

  // Render an inline loading state into #main-content so the user
  // has something visible while a heavy operation is in flight.
  // This is separate from the #processing-overlay (which is the
  // full-screen modal) and only paints a small spinner + label
  // into the article area.
  function showLoadingInline(msg) {
    if (!el.main) return;
    el.main.innerHTML = '<div class="loading-state"><div class="loading-spinner"></div><p>' + (msg || 'Loading…') + '</p></div>';
  }

  // Track the cards-view (reels) frame so the browser back button
  // exits back to list view. We can't reuse the modal/subView stacks
  // because reels is a body-level class toggle, not a DOM element.
  // The frameId itself is declared at the outer scope (reelsFrameId)
  // so the popstate handler can read it.

  // Minimum visible time for the view-switch loading screen.
  // Without this, the cards ↔ list switch on a warm cache is so
  // fast (no fetch, no ranking pass, no conflict detection re-run
  // because skipHeavyWork persists across view toggles) that the
  // loading state would paint and disappear within a single frame
  // — the user sees a flicker rather than a clear "switching"
  // transition. Same rationale as MIN_MODE_LOADING_MS above:
  // 220 ms (a beat + a half) makes the toggle feel deliberate.
  // The heavy work (trending + conflicts) on a cold cache will
  // naturally take longer than this, so the hold is a no-op
  // there — it only kicks in when the underlying work was faster
  // than the minimum.
  const MIN_VIEW_LOADING_MS = 220;

  function bindSourceFilter() {
    const toggle = document.getElementById('source-toggle-switch');
    if (!toggle) return;
    const update = () => {
      const isIb = sourceFilter === 'ib';
      toggle.setAttribute('aria-checked', isIb ? 'true' : 'false');
      const wrap = document.getElementById('source-toggle-wrap');
      if (wrap) wrap.title = isIb ? 'Showing IB posts — click to show Feeds' : 'Showing Feeds — click to show IB';
    };
    toggle.addEventListener('click', async () => {
      console.log('[bindSourceFilter] clicked, current sourceFilter=' + sourceFilter);
      sourceFilter = sourceFilter === 'ib' ? 'feeds' : 'ib';
      console.log('[bindSourceFilter] new sourceFilter=' + sourceFilter);
      update();
      _persist();
      // Abort any in-flight background fetch for the current scope
      // so stale feed articles don't leak into the IB view.
      const prevKey = scopeKey();
      if (typeof abortBackgroundFetch === 'function') abortBackgroundFetch(prevKey);
      const labels = { ib: 'Loading IB posts\u2026', feeds: 'Loading feeds\u2026' };
      showLoadingOverlay(labels[sourceFilter] || 'Loading\u2026');
      // Force the browser to paint the overlay before we measure time.
      // Without this, a fast displayCurrentSubcat (warm cache) can
      // complete in the same frame the overlay appears, so the user
      // never sees it.
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      console.log('[bindSourceFilter] overlay painted, calling displayCurrentSubcat');
      const t0 = performance ? performance.now() : Date.now();
      await displayCurrentSubcat();
      const elapsed = (performance ? performance.now() : Date.now()) - t0;
      const remaining = Math.max(0, 300 - elapsed);
      if (remaining > 0) await new Promise(r => setTimeout(r, remaining));
      console.log('[bindSourceFilter] displayCurrentSubcat done, hiding overlay');
      hideLoadingOverlay();
    });
    update();
  }

  function bindViewToggle() {
    const footerBtn = document.getElementById('view-toggle-btn');
    if (footerBtn) {
      footerBtn.addEventListener('click', () => {
        const newView = currentView === 'reels' ? 'list' : 'reels';
        const wasReels = currentView === 'reels';
        currentView = newView;
        _persist();
        $$('#view-toggle .mode-btn, [data-view-toggle-inline] .mode-btn').forEach(b => b.classList.remove('active'));
        $$('#view-toggle .mode-btn, [data-view-toggle-inline] .mode-btn').forEach(b => {
          if (b.dataset.view === currentView) b.classList.add('active');
        });
        document.body.classList.toggle('cards-view', currentView === 'reels');
        syncViewToggleBtn();
      // Show the FULL-SCREEN processing overlay (same one used by
      // switchModeNonBlocking) — it has z-index 9999 and a backdrop
      // blur, so the user can't miss it. The earlier inline
      // loading-state div in #main-content was being collapsed
      // into the same paint as the new render when the toggle was
      // fast (warm cache, skipHeavyWork=true), so the spinner
      // never actually appeared on screen. The processing overlay
      // sits OUTSIDE #main-content so it survives the innerHTML
      // swap in el.main below.
      const overlayMsg = newView === 'reels'
        ? 'Loading cards view…'
        : 'Loading list view…';
      setTopListStatus(overlayMsg);
      // Also paint the inline loading state for the case where
      // the user is in cards view and exits via this handler —
      // el.main.innerHTML is the reels container, which gets
      // replaced below. The processing overlay is the primary
      // indicator; this is a belt-and-suspenders fallback that
      // also keeps #main-content from flashing old content.
      showLoadingInline(overlayMsg);
      sizeReelsContainer();

      // Schedule the actual render. We use a token to guard
      // against rapid double-clicks (the user mashes the toggle,
      // the second click fires before the first render resolves).
      // The render itself is deferred to the next macrotask so
      // the browser actually paints the processing overlay before
      // displayCurrentSubcat starts clobbering el.main.innerHTML.
      // We hold the overlay for at least MIN_VIEW_LOADING_MS from
      // the moment the user clicked so even a fast warm-cache
      // toggle shows a deliberate transition (otherwise the
      // overlay would flash and disappear in <16ms and the user
      // would still see nothing).
      const token = ++pendingViewSwitch;
      const t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        setTimeout(() => {
          if (token !== pendingViewSwitch) return;
          const renderStart = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
          const renderPromise = currentSection === 'topics' || currentSection === 'conflicts'
            ? renderCurrentSection()
            : displayCurrentSubcat();
          renderPromise.catch(err => {
            console.warn('render failed:', err);
          }).finally(() => {
            const elapsed = ((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - t0;
            const remaining = Math.max(0, MIN_VIEW_LOADING_MS - elapsed);
            setTimeout(() => {
              if (token === pendingViewSwitch) clearTopListStatus();
            }, remaining);
          });
        }, 0);

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
  }

  // Exit reels view (e.g. via back button or Escape) without going
  // through the click handler. Updates the back-stack so the next
  // back press doesn't keep trying to close an already-closed reels
  // frame. Goes through the SAME processing-overlay + minimum-hold
  // path as the click handler so the user sees a loading screen
  // on the cards→list transition even when they exit via the
  // browser back button (which is the most common cards→list
  // gesture on mobile).
  function exitReelsFromBack() {
    if (currentView !== 'reels') return;
    const restore = _reelsExitRestore;
    _reelsExitRestore = null;
    _reelsArticles = null;
    currentView = 'list';
    _persist();
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
    if (restore) {
      try { restore(); } catch(e) { console.warn('reels exit restore failed', e); }
      return;
    }
    setTopListStatus('Loading list view…');
    showLoadingInline('Loading list view…');
    const token = ++pendingViewSwitch;
    const t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    setTimeout(() => {
      if (token !== pendingViewSwitch) return;
      displayCurrentSubcat().catch(err => {
        console.warn('displayCurrentSubcat failed:', err);
      }).finally(() => {
        const elapsed = ((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - t0;
        const remaining = Math.max(0, MIN_VIEW_LOADING_MS - elapsed);
        setTimeout(() => {
          if (token === pendingViewSwitch) clearTopListStatus();
        }, remaining);
      });
    }, 0);
  }

  /* ── Fetch & Refresh ── */
  function scopeKey() {
    // Parliament subcats need their own cache so we don't
    // re-fetch the entire news pool for every chamber the user
    // visits. Suffix the key with the subcat for parliament ones.
    let key = currentScope + '_' + (currentScope === 'nation' ? currentNation : '');
    if (typeof currentSubcat === 'string' && currentSubcat.indexOf('parliament:') === 0) {
      key += '__' + currentSubcat;
    }
    return key;
  }

  // True when the current subcat is a single-parliament-feed view
  // (Lok Sabha, Rajya Sabha, a state Vidhan Sabha, etc.).
  function isParliamentSubcat(subcat) {
    return typeof subcat === 'string' && subcat.indexOf('parliament:') === 0;
  }

  // Display title + icon for the section header. For ordinary
  // subcats this delegates to the existing subcatLabel/subcatIcon.
  // For parliament subcats it pulls the chamber's name out of the
  // parliamentFeeds data so the user can see "Lok Sabha" instead
  // of the raw id. India VS/VP items in feeds.json only carry
  // {id, state, url} (no `name` field), so we derive a readable
  // name from state + id when name is missing — otherwise the
  // header renders as literal "undefined".
  function categoryDisplay(subcat, scope, nation) {
    if (isParliamentSubcat(subcat)) {
      const id = subcat.slice('parliament:'.length);
      const item = FeedManager.getParliamentItemById && FeedManager.getParliamentItemById(id);
      let name;
      if (item) {
        name = item.name
          || (item.state
            ? item.state + (item.id && item.id.indexOf('vidhan-parishad') >= 0
                ? ' Vidhan Parishad'
                : ' Vidhan Sabha')
            : item.id);
      } else {
        name = id;
      }
      const where = item ? (item.country || item.state || '') : '';
      return {
        icon: '🏛️',
        label: name,
        scopeLabel: where ? (FeedManager.getNations()[where] || where) : (scope === 'global' ? 'Global' : (FeedManager.getNations()[nation] || nation))
      };
    }
    return {
      icon: FeedManager.subcatIcon(subcat),
      label: FeedManager.subcatLabel(subcat, scope),
      scopeLabel: scope === 'global' ? 'Global' : (FeedManager.getNations()[nation] || nation)
    };
  }

  function showProgress(msg) {
    el.main.innerHTML = '<div class="loading-state"><div class="loading-spinner"></div><p>' + msg + '</p></div>';
  }

  // Performance caps. The two heavy operations in the rendering
  // path (computeTrendingInfo and detectConflicts) are both
  // O(N²)-ish on the article pool. With 5000+ articles in the
  // cache, running them on the full pool makes every render take
  // multiple seconds — every keystroke in the search box, every
  // background-fetch tick, every click on a like button. To keep
  // the UI responsive we cap the input to the most recent N
  // articles. The values below were picked so the visible list
  // always gets full-quality trending + conflict info, while the
  // older articles get the default (no trending, no conflicts)
  // — the user mostly cares about what they're looking at.
  // CONFLICT_CORPUS_CAP was originally 200 but that still cost
  // ~2 seconds on a 5k cache (5k Jaccard + claim + numeric pair
  // comparisons). 100 is fast enough (~500ms) and covers the
  // whole visible list in the 1-per-source default view.
  const TRENDING_CORPUS_CAP = 200;
  const CONFLICT_CORPUS_CAP = 100;
  // When true, displayCurrentSubcat skips the heavy O(N²) work
  // (trending + conflicts) and just renders. The background fetch
  // sets this on its re-render so we don't burn 5+ seconds on
  // every batch. We re-arm the flag when the user does anything
  // that needs a fresh computation (tab change, search clear,
  // sort change, filter change).
  let skipHeavyWork = false;

  // Phased-load state. The initial fetch used to block on
  // Promise.allSettled of all ~140 feeds, which made the app
  // unusable for several minutes on the first run (and again on
  // every cold start with a cold cache). The new flow is:
  //   1. Fetch a small "quick batch" of N sources in parallel and
  //      show them as soon as they all land (typically ~2-3 s).
  //   2. Fetch the rest of the sources in the BACKGROUND in small
  //      rolling batches of 5, appending each result into the
  //      scopeCache and re-rendering so the list grows live.
  //   3. Show a "Loading N more sources…" indicator at the top of
  //      the article list while the background fetch is in flight,
  //      so the user can see progress without the list jumping.
  // The user is fully interactive (tabs, sort, search, settings,
  // analyze) from the moment the quick batch paints.
  const QUICK_BATCH_SIZE = 10;
  const QUICK_PER_SOURCE_CAP = 25;
  const REST_BATCH_SIZE = 4;
  const REST_PER_SOURCE_CAP = 100;
  // Per-key tracker so a background fetch from a previous scope
  // doesn't keep mutating the cache after the user has switched
  // tabs. Aborted via the `aborted` flag below.
  const backgroundFetchAbort = {};
  // Last article count we re-rendered for in the current scope.
  // Used to throttle re-renders so we don't repaint the list on
  // every single batch (which would be expensive at >200 articles).
  let lastRenderedCount = 0;
  const RERENDER_EVERY_N = 10;

  async function renderContent() {
    if (isFetching) return;
    const key = scopeKey();
    if (scopeCache[key]) {
      if (currentSection === 'feeds') displayCurrentSubcat();
      return;
    }
    isFetching = true;
    showLoading();
    setTopListStatus('Loading feeds…');

    try {
      const feeds = FeedManager.getFeedsForSubcat(currentScope, currentScope === 'nation' ? currentNation : null, currentSubcat);
      // 'quotes' subcat has no RSS feeds — skip feed fetch but still
      // merge published articles from Supabase.
      if (!feeds.length && currentSubcat !== 'quotes') {
        showError('No feed sources available. Open Settings to add custom feeds.');
        isFetching = false;
        return;
      }

      const subs = FeedManager.subcategoriesForScope(currentScope);
      // Parliament subcats are not part of the news subcat list
      // (and never should be) — keep them. Only snap back to
      // 'all' if the current subcat is genuinely unknown.
      if (!subs.includes(currentSubcat) && !isParliamentSubcat(currentSubcat)) {
        currentSubcat = 'all';
        _persist();
      }

      // ── PHASE 1: quick batch (15 sources, low cap) ──────────
      // The user sees these articles in ~2-3 seconds even on a
      // cold cache. This is the first paint that gets the UI off
      // the loading spinner.
      const quickFeeds = feeds.slice(0, QUICK_BATCH_SIZE);
      const restFeeds = feeds.slice(QUICK_BATCH_SIZE);

      showProgress('Loading quick batch of ' + quickFeeds.length + ' sources\u2026');

      // Don't pin isFetching=true across the whole phased load —
      // release it after Phase 1 so the user can switch tabs and
      // trigger a different renderContent without us being stuck.
      const groups = {};
      const quickResults = await Promise.allSettled(
        quickFeeds.map(f => FeedFetcher.fetchFeed(f, QUICK_PER_SOURCE_CAP))
      );
      let quickCount = 0;
      for (let j = 0; j < quickResults.length; j++) {
        const result = quickResults[j];
        if (result.status === 'fulfilled') {
          for (const a of result.value) {
            a.subcat = a.feedHint || 'politics';
            if (!groups[a.subcat]) groups[a.subcat] = [];
            groups[a.subcat].push(a);
            quickCount++;
          }
        }
      }

      if (quickCount === 0 && restFeeds.length > 0) {
        // Quick batch had zero hits. Fall back to the full set
        // (with a higher cap) so the user at least sees *something*.
        showProgress('Quick batch empty — loading more sources\u2026');
        for (const f of restFeeds) {
          const v = await FeedFetcher.fetchFeed(f, REST_PER_SOURCE_CAP).catch(() => []);
          for (const a of v) {
            a.subcat = a.feedHint || 'politics';
            if (!groups[a.subcat]) groups[a.subcat] = [];
            groups[a.subcat].push(a);
            quickCount++;
          }
        }
      }

      // Always merge published articles into groups regardless of
      // sourceFilter — getFilteredArticles handles the source
      // filtering at display time.  If we only merged when
      // sourceFilter !== 'feeds', switching to IB would show 0
      // articles because groups never contained them.
      const allPublished = getCachedPublished();
      const matchingPub = allPublished.filter(p => {
        const scopeMatch = p._pubScope === currentScope;
        const nationMatch = currentScope !== 'nation' || p._pubNation === currentNation;
        const subcatMatch = currentSubcat === 'all' || p._pubCategory === 'all' || p._pubCategory === currentSubcat;
        return scopeMatch && nationMatch && subcatMatch;
      });
      for (const p of matchingPub) {
        const cat = p._pubCategory === 'all' ? (currentSubcat === 'all' ? 'general' : currentSubcat) : p._pubCategory;
        if (!groups[cat]) groups[cat] = [];
        groups[cat].push(p);
      }

      let allArticles = [];
      for (const cat of Object.keys(groups)) allArticles.push(...groups[cat]);
      scopeCache[key] = { articles: allArticles, groups };
      lastRenderedCount = allArticles.length;
      isFetching = false;
      clearTopListStatus();
      if (currentSection !== 'feeds') return;
      renderSubTabs();
      updateStickyHeader();
      displayCurrentSubcat();

      // ── PHASE 2: background fetch the rest ───────────────────
      // Runs in the background; never blocks the UI. We split into
      // small batches so the user can keep scrolling and the
      // re-render stays cheap. The fetch is aborted automatically
      // when the user navigates to a different scope/subcat.
      if (restFeeds.length > 0) {
        const abortFlag = { aborted: false };
        backgroundFetchAbort[key] = abortFlag;
        // Defer the background fetch to the next macrotask so the
        // current paint (the quick batch) gets a chance to settle
        // first. Without this, the browser may batch the Phase 1
        // paint and the first Phase 2 batch into the same frame,
        // and the user never sees a stable "initial" view.
        setTimeout(() => {
          if (!abortFlag.aborted) backgroundFetchRest(key, feeds, quickFeeds.length, abortFlag);
        }, 250);
      }
    } catch (err) {
      console.error(err);
      clearTopListStatus();
      showError('Failed to fetch news. Please check your connection.');
      isFetching = false;
    }
  }

  // Background fetch the rest of the sources in rolling batches.
  // We DO NOT re-render the article list on every batch. The
  // previous behaviour (render every ~10 new articles) caused a
  // visible blink: the entire #main-content was replaced via
  // innerHTML, which reset the scroll position and showed a
  // blank frame between the old and new content. The user sees
  // a "Loading N / M articles…" indicator at the top of the
  // list whose text we update in place; the article list itself
  // stays put. After the background fetch finishes, we do ONE
  // final re-render (with full heavy work enabled) so the user
  // sees the complete list with accurate trending + conflicts.
  async function backgroundFetchRest(key, allFeeds, startIndex, abortFlag) {
    const groups = (scopeCache[key] && scopeCache[key].groups) || {};
    for (let i = startIndex; i < allFeeds.length; i += REST_BATCH_SIZE) {
      if (abortFlag.aborted) return;
      const batch = allFeeds.slice(i, i + REST_BATCH_SIZE);
      const settled = await Promise.allSettled(
        batch.map(f => FeedFetcher.fetchFeed(f, REST_PER_SOURCE_CAP))
      );
      for (let j = 0; j < settled.length; j++) {
        const r = settled[j];
        if (r.status !== 'fulfilled') continue;
        for (const a of r.value) {
          a.subcat = a.feedHint || 'politics';
          if (!groups[a.subcat]) groups[a.subcat] = [];
          groups[a.subcat].push(a);
        }
      }
      // Merge the new batch into the cache. We don't re-render
      // the article list — that would blink the screen.
      let allArticles = [];
      for (const cat of Object.keys(groups)) allArticles.push(...groups[cat]);
      scopeCache[key] = { articles: allArticles, groups };
      lastRenderedCount = allArticles.length;
      // Update only the indicator text in place so the user sees
      // the count grow without the list repainting.
      updateBgFetchIndicator();
      // Yield to the browser so the user can interact and the
      // progress indicator can repaint.
      await new Promise(r => setTimeout(r, 0));
    }
    if (scopeKey() === key) {
      skipHeavyWork = false;
      lastRenderedCount = scopeCache[key] ? scopeCache[key].articles.length : 0;
      if (currentSection !== 'feeds') return;
      renderSubTabs();
      displayCurrentSubcat();
    }
  }

  // In-place update of the "Loading more sources…" indicator.
  // We just rewrite the textContent of the existing element
  // (created by renderArticles) so the list itself never has
  // to repaint. If the indicator isn't in the DOM (background
  // fetch done, or user navigated away) this is a no-op.
  function updateBgFetchIndicator() {
    const el = document.querySelector('.bg-fetch-indicator .bg-fetch-text');
    if (!el) return;
    const remaining = totalFeedsForKey(scopeKey());
    el.textContent = 'Loading more sources in the background… (' + lastRenderedCount + ' / ' + remaining + ' articles loaded)';
  }

  // Mark the in-flight background fetch for a given key as
  // aborted. Called when the user navigates to a different
  // scope or subcat while the previous background fetch is still
  // running.
  function abortBackgroundFetch(key) {
    const flag = backgroundFetchAbort[key];
    if (flag) flag.aborted = true;
  }

  // The total number of feeds that will eventually be loaded for a
  // given scope key. Used by the "Loading more sources…" indicator
  // to show progress (N / total). Cached per-key on first
  // renderContent so we don't re-query the FeedManager.
  const totalFeedsByKey = {};
  function totalFeedsForKey(key) {
    if (totalFeedsByKey[key]) return totalFeedsByKey[key];
    // Derive the scope + nation + subcat from the key.
    // Format: "scope_nation" (e.g. "nation_india") OR
    //         "scope" (e.g. "global") OR
    //         "scope_nation__parliament:<id>" (parliament subcat).
    const scopeEnd = key.indexOf('__');
    const main = scopeEnd >= 0 ? key.slice(0, scopeEnd) : key;
    const subcat = scopeEnd >= 0 ? key.slice(scopeEnd + 2) : null;
    const parts = main.split('_');
    const scope = parts[0];
    const nation = parts[1] || null;
    const feeds = FeedManager.getFeedsForSubcat(scope, nation, subcat);
    const total = feeds.reduce((s, f) => s + (f && f.url ? 1 : 0), 0);
    totalFeedsByKey[key] = total;
    return total;
  }

  /* ── (no demo helpers) ── */

  async function displayCurrentSubcat() {
    const key = scopeKey();
    const cached = scopeCache[key];
    console.log('[displayCurrentSubcat] key=' + key + ', sourceFilter=' + sourceFilter + ', cached=' + !!cached);
    if (cached) {
      const totalArticles = cached.articles ? cached.articles.length : 0;
      const ibArticles = cached.articles ? cached.articles.filter(a => a._isPublished).length : 0;
      const feedArticles = cached.articles ? cached.articles.filter(a => !a._isPublished).length : 0;
      console.log('[displayCurrentSubcat] total=' + totalArticles + ', ib=' + ibArticles + ', feeds=' + feedArticles);
    }
    if (!cached) { await renderContent(); return; }

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

    // (No AI scoring pass here — scoreArticles is a no-op stub
    // now that Transformers.js is gone. The existing TF-IDF
    // ranking in ai.js handles the view without any click-blocking
    // downloads or model loads.)

    // Trending mode: rank all articles in the current scope/subcat
    // with Analyzer.rankByAnalyzer (TF-IDF × recency × buzz ×
    // authority) and cap at 25. The ranker returns
    // `[{ article, score }, ...]`; we unwrap to the bare article and
    // stamp a 1-based `_rank` so the card can show a #N badge.
    // We cap the input to 2000 articles before ranking so a
    // runaway cache can't freeze the main thread for tens of
    // seconds; the ranker still finds the strongest stories because
    // TF-IDF naturally concentrates on the most-distinctive
    // articles at the top.
    if (currentMode === 'top' && currentRankType === 'keyword') {
      setTopListStatus('Computing Trending…');
      // Yield to the event loop so the spinner paints before the
      // (potentially long) ranker starts.
      await new Promise(r => setTimeout(r, 0));
      try {
        const RANK_INPUT_CAP = 2000;
        const rankInput = articles.length > RANK_INPUT_CAP
          ? articles.slice(0, RANK_INPUT_CAP)
          : articles;
        const ranked = Analyzer.rankByAnalyzer(rankInput, []);
        if (ranked && ranked.length) {
          articles = ranked.slice(0, 25).map(r => {
            r.article._kwRanked = true;
            return r.article;
          });
          articles.forEach((a, i) => { a._rank = i + 1; });
        }
      } catch (e) {
        console.warn('Trending ranking failed:', e);
      }
    }

    // Tag every article with its subject. tagArticleWithSubject
    // is memoised (it sets _subjectChecked after the first run) so
    // calling it again on the same article is O(1). This is also
    // the path that runs on Phase 2 background re-renders — the
    // newly-arrived articles get tagged (cheap), the existing
    // articles are skipped (free).
    for (const a of articles) tagArticleWithSubject(a);

    if (!skipHeavyWork) {
      // Compute per-article trending info from the most recent
      // TRENDING_CORPUS_CAP articles in the full corpus. We cap
      // the input because computeTrendingInfo is O(N×M) and the
      // oldest articles are basically never going to be on the
      // user's screen anyway.
      const fullCorpus = [];
      for (const cat of Object.keys(cached.groups)) {
        if (Array.isArray(cached.groups[cat])) fullCorpus.push(...cached.groups[cat]);
      }
      for (const a of fullCorpus) tagArticleWithSubject(a);
      // Sort by date desc, then cap. Sorting once is O(N log N) but
      // is a single pass on small strings — much cheaper than the
      // O(N×M) trending we used to do.
      fullCorpus.sort((a, b) => new Date(b.pubDate || 0) - new Date(a.pubDate || 0));
      const trendingCorpus = fullCorpus.slice(0, TRENDING_CORPUS_CAP);
      AI.computeTrendingInfo(articles, trendingCorpus);

      // Yield to the event loop so the browser can paint before
      // the (still relatively heavy) conflict-detection pass.
      await new Promise(r => setTimeout(r, 0));

      // Conflict detection: cap to the most recent
      // CONFLICT_CORPUS_CAP articles. detectConflicts does
      // O(N²) Jaccard clustering + claim + numeric extraction, so
      // passing the full 5000-article pool would freeze the tab
      // for several seconds. With a 200-article cap, the cost is
      // bounded at ~40k pair comparisons — fast enough to run
      // synchronously without a yield.
      try {
        const conflictArticles = articles.slice(0, CONFLICT_CORPUS_CAP);
        const conflictMap = AI.detectConflicts(conflictArticles);
        for (const a of articles) {
          const c = conflictMap.get(a.link);
          if (c) a._conflicts = c;
        }
      } catch (e) {
        console.warn('Conflict detection failed:', e);
      }
    } else {
      // Background re-render: skip the heavy work. The user
      // gets their new articles immediately; the next user
      // interaction (search, tab change, sort) will re-run the
      // full computation.
    }

    // One more yield before the render so the conflict badges
    // have a frame to be visible on their own.
    await new Promise(r => setTimeout(r, 0));

    try {
      await renderTranslated(articles);
    } catch (e) {
      console.error('Error rendering articles:', e);
      showError('Failed to render articles. Try refreshing.');
    } finally {
      // Always re-arm the flag. The skip only applies to a
      // SINGLE render — the next one (e.g. when the user types
      // in search) re-runs everything.
      skipHeavyWork = false;
      clearTopListStatus();
    }
  }

  function bindFilterSort() {
    // The sort select lives in the options menu (#header-extras).
    // The filter UI was moved out of the bottom-bar dropdown into
    // a dedicated modal (#filter-modal, see js/filter-modal.js).
    // The sort change is the only thing wired here; the filter
    // modal registers its own onApply callback below.
    const sortEls = [el.sortBy, el.sortByExtras].filter(Boolean);

    for (const sb of sortEls) {
      updateSortOptions();
      sb.addEventListener('change', () => {
        currentSort = sb.value;
        _persist();
        for (const other of sortEls) {
          if (other !== sb) other.value = sb.value;
        }
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
  let currentExploreQuery = '';
  let currentExploreTab = 'categories';

  function bindSearch() {
    if (!el.searchInput) return;
    let searchTimer = null;
    el.searchInput.addEventListener('input', () => {
      currentSearch = el.searchInput.value.trim().toLowerCase();
      _persist();
      if (searchTimer) clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        searchTimer = null;
        const key = scopeKey();
        const cached = scopeCache[key];
        if (!cached) return;
        const articles = getFilteredArticles(currentSubcat, cached);
        renderTranslated(articles);
      }, 250);
    });
    el.searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === 'Escape') {
        if (searchTimer) { clearTimeout(searchTimer); searchTimer = null; }
        currentSearch = el.searchInput.value.trim().toLowerCase();
        _persist();
        const key = scopeKey();
        const cached = scopeCache[key];
        if (!cached) return;
        const articles = getFilteredArticles(currentSubcat, cached);
        renderTranslated(articles);
        if (currentSearch) applySemanticRank(articles);
      }
    });
  }

  // Semantic re-ranking of the search results using Universal
  // Sentence Encoder embeddings. The substring filter in
  // applySearch() already narrowed the pool; this only re-orders
  // the surviving articles by cosine similarity between the
  // query embedding and each article's embedding. A version
  // counter kills stale results if the user keeps typing.
  let _searchVersion = 0;
  async function applySemanticRank(articles) {
    if (!currentSearch || !articles || !articles.length) return;
    if (!window.Embeddings) return;
    const myVersion = ++_searchVersion;

    // Kick off the model load in the background if it hasn't
    // started yet. No-op once it's already in flight.
    const m = await Embeddings.loadModel();
    if (!m) return;                            // library missing
    if (myVersion !== _searchVersion) return;  // user typed again

    try {
      const queryEmbedding = await Embeddings.embed(currentSearch);
      if (!queryEmbedding) return;
      if (myVersion !== _searchVersion) return;

      // Score every filtered article. Embeddings are cached by
      // URL so repeated searches (e.g. switching scopes) don't
      // re-compute.
      const scored = [];
      for (let i = 0; i < articles.length; i++) {
        const a = articles[i];
        const text = ((a.title || '') + '. ' + (a.summary || '')).trim();
        let articleEmbedding = Embeddings.getCached(a.link);
        if (!articleEmbedding && text) {
          articleEmbedding = await Embeddings.embed(text);
          if (articleEmbedding) Embeddings.setCached(a.link, articleEmbedding);
        }
        if (myVersion !== _searchVersion) return;
        const sim = articleEmbedding
          ? Embeddings.cosineSimilarity(queryEmbedding, articleEmbedding)
          : 0;
        scored.push({ article: a, score: sim });
      }
      if (myVersion !== _searchVersion) return;

      scored.sort((a, b) => b.score - a.score);
      const ranked = scored.map(s => s.article);

      // Only re-render if the user is still on the same query
      // and the substring filter still passes (it always will,
      // since we ranked the same set — this is just a safety
      // net in case currentSearch changed mid-flight).
      if (currentSearch && ranked.length) {
        renderTranslated(ranked);
      }
    } catch (e) {
      console.warn('Semantic rank failed:', e && e.message);
    }
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
  let currentSort = '';

  // Apply the user's filter (date range + source set) to the article
  // pool. Reads the current filter state from the FilterModal
  // module. Source set is empty = no source filter; date range
  // empty = no date filter.
  function applyFilters(articles) {
    let result = articles;
    if (window.FilterModal) {
      const f = FilterModal.getFilter();
      if (f.date_start) {
        const t = new Date(f.date_start + 'T00:00:00').getTime();
        if (!isNaN(t)) result = result.filter(a => {
          const at = a.pubDate ? new Date(a.pubDate).getTime() : 0;
          return at && at >= t;
        });
      }
      if (f.date_end) {
        const t = new Date(f.date_end + 'T23:59:59').getTime();
        if (!isNaN(t)) result = result.filter(a => {
          const at = a.pubDate ? new Date(a.pubDate).getTime() : 0;
          return at && at <= t;
        });
      }
      if (f.sources && f.sources.size > 0) {
        result = result.filter(a => f.sources.has(a.source));
      }
    }
    return result;
  }

  function applySort(articles, sortMode) {
    const sorted = [...articles];
    switch (sortMode) {
      case 'date-asc':
        sorted.sort((a, b) => new Date(a.pubDate || 0) - new Date(b.pubDate || 0));
        break;
      case 'source':
        sorted.sort((a, b) => (a.source || '').localeCompare(b.source || ''));
        break;
      case 'trending':
        // Sort by trending keyword count (how many other articles in
        // the corpus share this article's terms). Falls back to date
        // if no trending info is present. Same algorithm as the
        // Trending button, just in-place within the current subcat
        // instead of global top-25.
        sorted.sort((a, b) => {
          const ta = a._trendingCount || 0;
          const tb = b._trendingCount || 0;
          if (tb !== ta) return tb - ta;
          return new Date(b.pubDate || 0) - new Date(a.pubDate || 0);
        });
        break;
      default:
        sorted.sort((a, b) => new Date(b.pubDate || 0) - new Date(a.pubDate || 0));
    }
    return sorted;
  }

  async function refreshAll() {
    // The standalone refresh button was removed; the IB logo at the
    // top-left is now the only place that triggers a full reload.
    // This function is kept for that path and for any code that
    // calls it programmatically.
    const key = scopeKey();
    liveAllLoaded = false;
    loadedCount = 0;
    scopeCache[key] = null;
    const feeds = FeedManager.getFeedsForSubcat(currentScope, currentScope === 'nation' ? currentNation : null, currentSubcat);
    if (!feeds.length) return;
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
    if (currentSection !== 'feeds') return;
    renderSubTabs();
    updateStickyHeader();
    await displayCurrentSubcat();
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

    // The plain location.reload() on mobile is intercepted by the
    // service worker and serves the old cached files. We must
    // explicitly:
    //   1. Unregister the active service worker (so the next page
    //      load doesn't get the old asset shell from Cache
    //      Storage).
    //   2. Delete every Cache Storage entry (so even the in-flight
    //      request doesn't fall through to the old cache).
    //   3. Reload with `?cacheBust=<timestamp>` so the new HTML
    //      request isn't served from the browser's HTTP cache.
    // We chain these in a single async function so the user sees
    // the loading overlay for the whole sequence.
    (async () => {
      try {
        if ('serviceWorker' in navigator) {
          const regs = await navigator.serviceWorker.getRegistrations();
          await Promise.all(regs.map(r => r.unregister().catch(() => {})));
        }
        if ('caches' in window) {
          const keys = await caches.keys();
          await Promise.all(keys.map(k => caches.delete(k).catch(() => {})));
        }
      } catch (e) {
        console.warn('Cache cleanup failed (continuing anyway):', e);
      }
      // Reload with a cache-bust query string so the HTTP layer
      // doesn't serve the old HTML.
      const bust = '_t=' + Date.now();
      const url = new URL(window.location.href);
      url.searchParams.set(bust, '');
      window.location.replace(url.toString());
    })();
  }

  /* ── Top Date Picker (removed) ──
   *
   * The Top AI date picker used to live here. With the AI ranking
   * flow gone (Milestone 0), this whole section is no longer needed.
   * The function is kept as a no-op so init()'s bindTopDate() call
   * doesn't throw if it sneaks back in.
   */
  function bindTopDate() { /* no-op: removed with the AI ranking flow */ }

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
  // Core fetch logic — no UI side-effects. Callers manage overlay/spinner.
  async function _fetchAndCache() {
    const feeds = FeedManager.getFeedsForSubcat(currentScope, currentScope === 'nation' ? currentNation : null, currentSubcat);
    if (!feeds.length && currentSubcat !== 'quotes') return;

    const subs = FeedManager.subcategoriesForScope(currentScope);
    if (!subs.includes(currentSubcat) && !isParliamentSubcat(currentSubcat)) {
      currentSubcat = 'all';
      _persist();
    }

    const perSourceCap = 100;
    // Process feeds in small batches with yields to prevent browser freeze
    const BATCH = 4;
    const allResults = [];
    for (let i = 0; i < feeds.length; i += BATCH) {
      const batch = feeds.slice(i, i + BATCH);
      const settled = await Promise.allSettled(batch.map(f => FeedFetcher.fetchFeed(f, perSourceCap)));
      for (const s of settled) allResults.push(s);
      // Yield to browser so UI stays responsive
      await new Promise(r => setTimeout(r, 0));
    }

    const groups = {};
    for (let j = 0; j < allResults.length; j++) {
      const result = allResults[j];
      if (result.status !== 'fulfilled') continue;
      for (const a of result.value) {
        a.subcat = a.feedHint || 'politics';
        const cat = a.subcat;
        if (!groups[cat]) groups[cat] = [];
        groups[cat].push(a);
      }
    }

    // Always merge published articles into groups regardless of
    // sourceFilter — getFilteredArticles handles the source
    // filtering at display time.
    const allPublished = getCachedPublished();
    console.log('[_fetchAndCache] getCachedPublished returned ' + allPublished.length + ' articles');
    const matchingPub = allPublished.filter(p => {
      const scopeMatch = p._pubScope === currentScope;
      const nationMatch = currentScope !== 'nation' || p._pubNation === currentNation;
      const subcatMatch = currentSubcat === 'all' || p._pubCategory === 'all' || p._pubCategory === currentSubcat;
      return scopeMatch && nationMatch && subcatMatch;
    });
    for (const p of matchingPub) {
      const cat = p._pubCategory === 'all' ? (currentSubcat === 'all' ? 'general' : currentSubcat) : p._pubCategory;
      if (!groups[cat]) groups[cat] = [];
      groups[cat].push(p);
    }

    let allArticles = [];
    for (const cat of Object.keys(groups)) allArticles.push(...groups[cat]);

    const key = scopeKey();
    console.log('[_fetchAndCache] key=' + key + ', sourceFilter=' + sourceFilter + ', totalArticles=' + allArticles.length);
    const ibCount = allArticles.filter(a => a._isPublished).length;
    const feedCount = allArticles.filter(a => !a._isPublished).length;
    console.log('[_fetchAndCache] after filter: ib=' + ibCount + ', feeds=' + feedCount);
    scopeCache[key] = { articles: allArticles, groups };
    liveAllLoaded = false;
    loadAllState = 'idle';
    liveAllArticles = null;
    loadedCount = 0;
    hasFreshBackground = true;
  }

  async function backgroundRefresh() {
    if (isBackgroundRefreshing) return;
    isBackgroundRefreshing = true;
    // No blocking overlay — just show clock icon while loading (non-freezing)
    showRefreshSpinner();

    try {
      await _fetchAndCache();
      isBackgroundRefreshing = false;
      showRecentButton();
    } catch (err) {
      console.error('Background refresh failed:', err);
      isBackgroundRefreshing = false;
      hideRefreshStatus();
    }
  }

  // Fetch fresh data and immediately apply it (used by the clock icon click).
  async function fetchAndApplyFresh() {
    if (isBackgroundRefreshing) return;
    isBackgroundRefreshing = true;
    // Show a non-blocking mini loading state on the clock icon itself
    const rb = $('#ib-recent-btn');
    if (rb) {
      rb.classList.add('ib-loading-new');
      rb.title = 'Loading new feeds\u2026';
    }

    try {
      await _fetchAndCache();
      applyRecentAndShowLive();
    } catch (err) {
      console.error('Fetch and apply failed:', err);
    } finally {
      isBackgroundRefreshing = false;
      if (rb) rb.classList.remove('ib-loading-new');
    }
  }

  // Called when user clicks the "show recent" button. Re-renders the
  // visible content with the freshly-fetched articles, sorted by most
  // recent first. Always forces list view.
  function applyRecentAndShowLive() {
    if (currentSection !== 'feeds') return;
    loadedCount = 0;
    liveAllLoaded = false;
    loadAllState = 'idle';
    liveAllArticles = null;
    hasFreshBackground = false;
    hideRefreshStatus();
    // Force list view on refresh (reels → list)
    if (currentView !== 'list') {
      currentView = 'list';
      _persist();
      document.body.classList.remove('cards-view');
      $$('#view-toggle .mode-btn, [data-view-toggle-inline] .mode-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.view === currentView);
      });
      if (typeof syncViewToggleBtn === 'function') syncViewToggleBtn();
    }
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
      // Just show the clock icon every cycle — no background fetch.
      // The user clicks the icon to trigger the actual refresh
      // with a loading overlay, avoiding freezes.
      if (document.hidden) return;
      showRecentButton();
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
    if (recentBtn) recentBtn.addEventListener('click', fetchAndApplyFresh);
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

  // AI rank toggle in the IB row has been removed. The new analyze
  // button is bound in `bindAnalyzeBtn` (see analyze-modal.js / app.js init).

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


  // Render the Feed Health sectionction inside the Settings modal. Shows the
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
    if (currentSection === 'feeds') displayCurrentSubcat();
  }

  function bindSettings() {
    el.settingsBtn.addEventListener('click', e => { e.stopPropagation(); openSettings(); });
    el.modalClose.addEventListener('click', closeSettings);
    el.modalCancel.addEventListener('click', closeSettings);
    el.modalSave.addEventListener('click', saveSettings);
    el.modal.addEventListener('click', e => { if (e.target === el.modal) closeSettings(); });
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
    // Quote spacing toggle
    if (el.quotePreserveSpacing) {
      el.quotePreserveSpacing.checked = Settings.get('quotePreserveSpacing') !== false;
      el.quotePreserveSpacing.addEventListener('change', () => {
        Settings.set('quotePreserveSpacing', el.quotePreserveSpacing.checked);
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
    const searchToggleBtn = $('#search-toggle-btn');
    const searchRow = $('#header-search-row');
    const searchInput = $('#search-input');
    if (searchToggleBtn && searchRow) {
      searchToggleBtn.addEventListener('click', () => {
        const willShow = searchRow.hasAttribute('hidden');
        if (willShow) {
          searchRow.removeAttribute('hidden');
          searchToggleBtn.classList.add('active');
          if (searchInput) requestAnimationFrame(() => searchInput.focus());
        } else {
          searchRow.setAttribute('hidden', '');
          searchToggleBtn.classList.remove('active');
          if (searchInput) searchInput.blur();
        }
      });
    }
    if (el.hardRefreshModalClose) el.hardRefreshModalClose.addEventListener('click', closeHardRefreshModal);
    if (el.hardRefreshCancel) el.hardRefreshCancel.addEventListener('click', closeHardRefreshModal);
    if (el.hardRefreshConfirm) el.hardRefreshConfirm.addEventListener('click', performHardRefresh);
    if (el.hardRefreshModal) el.hardRefreshModal.addEventListener('click', e => { if (e.target === el.hardRefreshModal) closeHardRefreshModal(); });
    // Options button toggles the extras row (sort, filter, translate,
    // hard refresh, activity). The panel stays open until the user
    // clicks the button again or clicks outside — it used to auto-
    // hide after 5 seconds, but that was too aggressive when the
    // user was in the middle of picking a sort/filter.
    const optionsBtn = $('#options-btn');
    const headerExtras = $('#header-extras');
    if (optionsBtn && headerExtras) {
      optionsBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const hidden = headerExtras.style.display === 'none' || !headerExtras.style.display;
        headerExtras.style.display = hidden ? 'flex' : 'none';
        optionsBtn.classList.toggle('active', hidden);
      });
      // Clicking outside the extras row also closes it.
      document.addEventListener('click', (e) => {
        if (headerExtras.style.display === 'none') return;
        if (headerExtras.contains(e.target)) return;
        if (optionsBtn.contains(e.target)) return;
        headerExtras.style.display = 'none';
        optionsBtn.classList.remove('active');
      });
    }
    // Make the section title act as a category opener.
    // Power users tend to aim for the title, not the tiny icon.
    // The Conflicts view doesn't have categories, so the title
    // stays non-interactive there.
    if (el.sectionTitle) {
      el.sectionTitle.style.cursor = 'pointer';
      el.sectionTitle.addEventListener('click', () => {
        if (currentSection !== 'feeds') return;
        if (window.CategoriesModal) CategoriesModal.openModal();
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
      renderActivityFailed(container);
      return;
    } else if (tab === 'myposts') {
      renderMyPosts(container);
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

  function renderMyPosts(container) {
    if (!currentUser) {
      container.innerHTML = '<div class="activity-empty">Sign in to see your posts.</div>';
      return;
    }
    const published = getCachedPublished().filter(p => p._pubUserEmail === currentUser.email);
    if (!published.length) {
      container.innerHTML = '<div class="activity-empty">No posts yet. Publish an article to see it here.</div>';
      return;
    }
    container.innerHTML = '<div class="activity-list">' + published.map(p =>
      '<div class="activity-item">' +
        '<div class="ai-title" data-link="' + encodeURIComponent(p.link || 'pub_' + p._pubId) + '">' +
          escHtml(p.title || '') +
          (p.source ? '<div class="ai-source">' + escHtml(p.source) + '</div>' : '') +
        '</div>' +
        '<div class="ai-meta">' +
          '<span>' + (p.pubDate ? formatDateShort(p.pubDate) : '') + '</span>' +
          '<span>' +
            '<button class="btn btn-ghost ai-edit-btn" data-pubid="' + p._pubId + '" style="font-size:0.75rem;padding:2px 6px">&#x270F;</button>' +
            '<button class="btn btn-ghost ai-del-btn" data-pubid="' + p._pubId + '" style="font-size:0.75rem;padding:2px 6px">&#x1F5D1;</button>' +
          '</span>' +
        '</div>' +
      '</div>'
    ).join('') + '</div>';

    // Click on title to open original article
    container.querySelectorAll('.ai-title').forEach(el2 => {
      el2.addEventListener('click', () => {
        const link = decodeURIComponent(el2.dataset.link);
        if (!link) return;
        closeActivity();
        openArticleDetail(link);
      });
    });
    // Edit button
    container.querySelectorAll('.ai-edit-btn').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const pubId = btn.dataset.pubid;
        if (pubId) { closeActivity(); editPublishedArticle(pubId); }
      });
    });
    // Delete button
    container.querySelectorAll('.ai-del-btn').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const pubId = btn.dataset.pubid;
        if (pubId) { closeActivity(); deletePublishedArticle(pubId); }
      });
    });
  }

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

  async function handleAddFeed() {
    const name = el.feedNameInput?.value?.trim();
    const url = validatedFeed?.url || el.feedUrlInput?.value?.trim();
    const scope = el.feedScopeSelect?.value || 'global';
    const nation = el.feedNationSelect?.value || 'india';
    const subcat = el.feedSubcatSelect?.value || 'politics';
    if (!name || !url) {
      if (el.feedValidateMsg) { el.feedValidateMsg.textContent = 'Enter a name and validate a URL first.'; el.feedValidateMsg.className = 'feed-validate-msg error'; }
      return;
    }
    try { await FeedManager.addCustomFeed(name, url, scope, nation, subcat, 'en'); }
    catch (e) { console.warn('addCustomFeed failed:', e && e.message); }
    validatedFeed = null;
    if (el.feedUrlInput) el.feedUrlInput.value = '';
    if (el.feedNameInput) el.feedNameInput.value = '';
    if (el.feedValidateMsg) el.feedValidateMsg.textContent = '';
    await renderCustomFeedList();
  }

  async function renderCustomFeedList() {
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
      btn.addEventListener('click', async () => {
        try { await FeedManager.removeCustomFeed(btn.dataset.url); }
        catch (e) { console.warn('removeCustomFeed failed:', e && e.message); }
        await renderCustomFeedList();
      });
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
  //   - filter:    free-text search (matches name / region / lang)
  //   - scope:     'global' or 'nation' — which tab the user is on
  //   - region:    which region chip is selected (defaults to 'all')
  //   - status:    'all' | 'refused' — show only refused sources?
  let subsConfigFilter = '';
  let subsConfigScope = 'global';
  let subsConfigRegion = 'all';
  let subsConfigStatus = 'all';

  function openSourcesConfigModal() {
    if (!$('#sources-config-modal')) return;
    subsConfigFilter = '';
    subsConfigRegion = 'all';
    subsConfigStatus = 'all';
    // Default the scope tab to whichever scope the user is currently
    // viewing on the main page, so the modal opens to a relevant list.
    subsConfigScope = (currentScope === 'nation') ? 'nation' : 'global';
    openModal('sourcesConfig', $('#sources-config-modal'));
    renderSourcesConfigTable();
  }

  function closeSourcesConfigModal() {
    closeModal('sourcesConfig');
  }

  // Pick a stable "few" region chips to show when the user isn't
  // searching. We always show "All" + 4 of the most common regions
  // for the current scope so the chip row stays compact. When the
  // user types in the search box, all matching regions appear (so
  // niche categories like Education/Environment aren't hidden behind
  // a search barrier).
  const VISIBLE_REGION_COUNT = 4;
  function pickVisibleRegions(allRegions) {
    if (allRegions.length <= VISIBLE_REGION_COUNT + 1) return allRegions;
    // Prefer the scope's "All" bucket + the 4 most common sub-regions.
    const allBucket = allRegions.find(r => /—\s*All$|^All$/.test(r));
    const subRegions = allRegions.filter(r => r !== allBucket);
    // Sort by typical popularity — All/Sports first, then by region
    // size. We don't have a real popularity signal here without
    // scanning the feeds, so fall back to alphabetical for stability.
    subRegions.sort();
    return [allBucket, ...subRegions.slice(0, VISIBLE_REGION_COUNT)].filter(Boolean);
  }

  function renderSourcesConfigTable() {
    const body = $('#sources-config-body');
    if (!body) return;
    const allFeeds = FeedManager.getSubscribableFeeds();
    const subscribed = new Set(FeedManager.getSubscribedFeeds());

    // ── 1. Filter to the current scope ───────────────────────────
    // The scope tab ('global' or 'nation') restricts the master list
    // to one of the two top-level groups. The region chip then
    // narrows further within that scope.
    const scoped = allFeeds.filter(f => f.scope === subsConfigScope);

    // ── 2. Apply search + region + status filters ────────────────
    const q = (subsConfigFilter || '').toLowerCase().trim();
    const filtered = [];
    for (const f of scoped) {
      if (!f.hasRss || !f.url) continue;
      if (subsConfigRegion !== 'all' && f.region !== subsConfigRegion) continue;
      if (subsConfigStatus === 'refused' && !(window.SourceHealth && SourceHealth.isRefused(f.url))) continue;
      if (q) {
        const hay = ((f.name || '') + ' ' + (f.region || '') + ' ' + (f.lang || '') + ' ' + (f.hint || '')).toLowerCase();
        if (!hay.includes(q)) continue;
      }
      filtered.push(f);
    }

    // ── 3. Build region chip list ────────────────────────────────
    // "All" + the 4 most common regions for this scope, unless the
    // user is searching — then show every region that has at least
    // one match so niche categories (Education, Environment, etc.)
    // aren't hidden behind a search barrier.
    const scopedRegions = [...new Set(scoped.filter(f => f.hasRss).map(f => f.region || 'Other'))].sort();
    const visibleRegions = q ? scopedRegions : pickVisibleRegions(scopedRegions);

    // ── 4. Counts for scope tab badges ───────────────────────────
    const globalCount = allFeeds.filter(f => f.scope === 'global' && f.hasRss).length;
    const nationCount = allFeeds.filter(f => f.scope === 'nation' && f.hasRss).length;
    const refusedGlobal = allFeeds.filter(f => f.scope === 'global' && f.hasRss && window.SourceHealth && SourceHealth.isRefused(f.url)).length;
    const refusedNation = allFeeds.filter(f => f.scope === 'nation' && f.hasRss && window.SourceHealth && SourceHealth.isRefused(f.url)).length;

    // ── 5. Scope tabs (Global / Nation) ──────────────────────────
    const scopeTabs =
      '<div class="scm-scope-tabs">' +
        '<button class="scm-scope-btn' + (subsConfigScope === 'global' ? ' active' : '') + '" data-scope="global">' +
          '🌍 Global' +
          '<span class="scm-scope-count">' + globalCount + (refusedGlobal ? ' <span class="scm-refused-dot" title="' + refusedGlobal + ' refused">●</span>' : '') + '</span>' +
        '</button>' +
        '<button class="scm-scope-btn' + (subsConfigScope === 'nation' ? ' active' : '') + '" data-scope="nation">' +
          'Nation' +
          '<span class="scm-scope-count">' + nationCount + (refusedNation ? ' <span class="scm-refused-dot" title="' + refusedNation + ' refused">●</span>' : '') + '</span>' +
        '</button>' +
      '</div>';

    // ── 6. Status filter (All / Refused) ─────────────────────────
    const statusFilter =
      '<div class="scm-status-row">' +
        '<button class="scm-status-btn' + (subsConfigStatus === 'all' ? ' active' : '') + '" data-status="all">All</button>' +
        '<button class="scm-status-btn' + (subsConfigStatus === 'refused' ? ' active' : '') + '" data-status="refused">' +
          '⚠ Refused' +
        '</button>' +
      '</div>';

    // ── 7. Region chips (collapsed by default) ───────────────────
    // When NOT searching: only the few "always visible" regions
    // (picked by pickVisibleRegions). When searching: every region
    // in the current scope, with the "search-only" extras marked
    // dashed so the user can tell which ones the modal auto-uncovered.
    const regionsToShow = q ? scopedRegions : visibleRegions;
    const regionSelector =
      '<div class="scm-regions' + (q ? ' scm-regions-expanded' : '') + '">' +
        '<button class="scm-region-btn' + (subsConfigRegion === 'all' ? ' active' : '') + '" data-region="all">All regions</button>' +
        regionsToShow.map(r => {
          const isSearchExtra = q && !visibleRegions.includes(r);
          return '<button class="scm-region-btn' + (isSearchExtra ? ' scm-region-btn-search' : '') + (subsConfigRegion === r ? ' active' : '') + '" data-region="' + escAttr(r) + '">' + escHtml(r) + '</button>';
        }).join('') +
      '</div>';

    // ── 8. Bulk-action row + count ───────────────────────────────
    const visibleChecked = filtered.filter(f => subscribed.has(f.url)).length;
    const bulkRow =
      '<div class="scm-bulk-row">' +
        '<span class="scm-bulk-count"><strong>' + visibleChecked + '</strong> / ' + filtered.length + ' selected</span>' +
        '<div class="scm-bulk-actions">' +
          '<button class="btn" data-bulk="select-all">Select all (visible)</button>' +
          '<button class="btn" data-bulk="deselect-all">Deselect all (visible)</button>' +
        '</div>' +
      '</div>';

    // ── 9. Build source rows ─────────────────────────────────────
    const grouped = {};
    for (const f of filtered) {
      const region = f.region || 'Other';
      if (!grouped[region]) grouped[region] = [];
      grouped[region].push(f);
    }

    let rowsHtml = '';
    for (const [region, feeds] of Object.entries(grouped)) {
      rowsHtml += '<tr class="scm-region-header"><td colspan="4">' + escHtml(region) + '</td></tr>';
      for (const f of feeds) {
        const checked = subscribed.has(f.url);
        const isG = f.isGoogleNews || (f.url && f.url.includes('news.google.com'));
        const refused = !!(window.SourceHealth && SourceHealth.isRefused(f.url));
        const refusedCount = (window.SourceHealth && SourceHealth.getFailureCount(f.url)) || 0;
        rowsHtml +=
          '<tr class="scm-row' + (checked ? ' scm-active' : '') + (isG ? ' scm-google' : '') + (refused ? ' scm-refused' : '') + '" data-url="' + escAttr(f.url) + '">' +
            '<td class="scm-check"><input type="checkbox" class="scm-checkbox" data-url="' + escAttr(f.url) + '"' + (checked ? ' checked' : '') + '></td>' +
            '<td class="scm-name">' +
              escHtml(f.name) +
              (isG ? ' <span class="sub-google-badge">Google</span>' : '') +
              (refused ? ' <span class="scm-refused-pill" title="This source refused to load ' + refusedCount + ' times">⚠ refused</span>' : '') +
            '</td>' +
            '<td class="scm-cat">' + escHtml(f.hint || '') + '</td>' +
            '<td class="scm-lang">' + (f.lang || 'en').toUpperCase() + '</td>' +
          '</tr>';
      }
    }

    if (!rowsHtml) {
      const emptyMsg = subsConfigStatus === 'refused'
        ? 'No refused sources in this scope. Nice — everything is loading.'
        : (q ? 'No sources match your search.' : 'No sources in this scope.');
      rowsHtml = '<tr><td colspan="4" style="text-align:center;padding:24px;color:var(--text-tertiary);">' + emptyMsg + '</tr>';
    }

    body.innerHTML =
      scopeTabs +
      statusFilter +
      regionSelector +
      bulkRow +
      '<div class="scm-body">' +
        '<table class="scm-table">' +
          '<thead><tr><th></th><th>Name</th><th>Category</th><th>Lang</th></tr></thead>' +
          '<tbody>' + rowsHtml + '</tbody>' +
        '</table>' +
      '</div>';

    // ── 10. Bind everything ──────────────────────────────────────
    bindSourcesConfigControls();
    // Also update the count on the settings page (the "X of Y
    // sources enabled" line), since the bulk operations change it
    // without us otherwise going through the subscribed count.
    const meta = document.querySelector('.subs-config-meta');
    if (meta) {
      const total = allFeeds.filter(f => f.hasRss && f.url).length;
      meta.textContent = FeedManager.getSubscribedFeeds().length + ' of ' + total + ' sources enabled';
    }
  }

  // Wire up every interactive control in the Configure Sources body.
  // Called on every re-render so dynamically-built elements stay
  // responsive. We use a single delegated handler where possible to
  // keep the listener count small.
  function bindSourcesConfigControls() {
    const body = $('#sources-config-body');
    if (!body) return;

    // Scope tabs
    body.querySelectorAll('.scm-scope-btn').forEach(b => {
      b.addEventListener('click', () => {
        subsConfigScope = b.dataset.scope;
        subsConfigRegion = 'all';   // reset region when scope changes
        subsConfigStatus = 'all';   // reset status too
        renderSourcesConfigTable();
      });
    });

    // Status filter (All / Refused)
    body.querySelectorAll('.scm-status-btn').forEach(b => {
      b.addEventListener('click', () => {
        subsConfigStatus = b.dataset.status;
        renderSourcesConfigTable();
      });
    });

    // Region chips
    body.querySelectorAll('.scm-region-btn').forEach(b => {
      b.addEventListener('click', () => {
        subsConfigRegion = b.dataset.region;
        renderSourcesConfigTable();
      });
    });

    // Bulk actions: select / deselect every source currently visible
    // in the filtered list. Operates on the rendered rows so the
    // user gets a result that matches what they see on screen
    // (respects search + region + status filters).
    body.querySelectorAll('[data-bulk]').forEach(b => {
      b.addEventListener('click', () => {
        const mode = b.dataset.bulk; // 'select-all' | 'deselect-all'
        const rows = body.querySelectorAll('.scm-row[data-url]');
        let changed = false;
        rows.forEach(r => {
          const url = r.dataset.url;
          const cb = r.querySelector('.scm-checkbox');
          const want = (mode === 'select-all');
          if (cb && cb.checked !== want) {
            cb.checked = want;
            FeedManager.toggleSubscription(url);
            changed = true;
          }
        });
        if (changed) {
          localStorage.setItem('newsfeeds_subscriptions_initialized', '1');
          syncSubscriptionsToCloud();
          renderSourcesConfigTable();
        }
      });
    });

    // Row click → toggle subscription. The whole row is the click
    // target (not just the checkbox) so the user can tap anywhere
    // on the row, including the name, category, or lang cells.
    // We still let the checkbox itself handle its own change event
    // — clicking it directly fires both handlers, but toggle is
    // idempotent so the second one is a no-op.
    body.querySelectorAll('.scm-row[data-url]').forEach(row => {
      row.addEventListener('click', (e) => {
        // If the user clicked the checkbox or a badge inside the
        // checkbox cell, let the checkbox's own change event handle
        // it. Otherwise the row click fires the toggle.
        if (e.target.closest('.scm-check')) return;
        const url = row.dataset.url;
        const cb = row.querySelector('.scm-checkbox');
        if (!cb) return;
        FeedManager.toggleSubscription(url);
        localStorage.setItem('newsfeeds_subscriptions_initialized', '1');
        syncSubscriptionsToCloud();
        // Optimistic UI update — toggle the visual state immediately
        // and let the next render (or the settings-page count refresh)
        // reconcile the persisted state.
        const nowChecked = !cb.checked;
        cb.checked = nowChecked;
        row.classList.toggle('scm-active', nowChecked);
        // Update the bulk-row count
        const countEl = body.querySelector('.scm-bulk-count strong');
        if (countEl) {
          const newCount = nowChecked
            ? parseInt(countEl.textContent, 10) + 1
            : parseInt(countEl.textContent, 10) - 1;
          countEl.textContent = String(newCount);
        }
        // Update the settings-page count too
        const meta = document.querySelector('.subs-config-meta');
        if (meta) {
          const allFeeds = FeedManager.getSubscribableFeeds();
          const total = allFeeds.filter(f => f.hasRss && f.url).length;
          meta.textContent = FeedManager.getSubscribedFeeds().length + ' of ' + total + ' sources enabled';
        }
      });
    });

    // Checkbox change (when user clicks the checkbox directly)
    body.querySelectorAll('.scm-checkbox').forEach(cb => {
      cb.addEventListener('change', () => {
        FeedManager.toggleSubscription(cb.dataset.url);
        localStorage.setItem('newsfeeds_subscriptions_initialized', '1');
        syncSubscriptionsToCloud();
        const row = cb.closest('.scm-row');
        if (row) row.classList.toggle('scm-active', cb.checked);
        // Update the bulk-row count
        const countEl = body.querySelector('.scm-bulk-count strong');
        if (countEl) {
          const all = body.querySelectorAll('.scm-row[data-url] .scm-checkbox');
          let n = 0;
          all.forEach(c => { if (c.checked) n++; });
          countEl.textContent = String(n);
        }
        // Update the settings-page count
        const meta = document.querySelector('.subs-config-meta');
        if (meta) {
          const allFeeds = FeedManager.getSubscribableFeeds();
          const total = allFeeds.filter(f => f.hasRss && f.url).length;
          meta.textContent = FeedManager.getSubscribedFeeds().length + ' of ' + total + ' sources enabled';
        }
      });
    });
  }

  function bindFeedControls() {
    const openBtn = $('#open-custom-sources-btn');
    if (openBtn) {
      openBtn.addEventListener('click', () => {
        if (window.CustomSourcesModal) CustomSourcesModal.openModal();
      });
    }
  }

  function escAttr(s) { return (s == null ? '' : String(s)).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function escHtml(s) { return (s == null ? '' : String(s)).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }

  /* ── Article & Source Modals ── */
  function findArticleByLink(link) {
    if (currentArticles) {
      const found = currentArticles.find(a => a.link === link);
      if (found) return found;
    }
    for (const key of Object.keys(scopeCache)) {
      const cached = scopeCache[key];
      if (!cached || !cached.articles) continue;
      const found = cached.articles.find(a => a.link === link);
      if (found) return found;
    }
    return null;
  }

  function openArticleDetail(link) {
    const article = findArticleByLink(link);
    if (!article) return;
    trackView(link);
    el.articleModalTitle.textContent = article.title;
    el.articleModalSource.textContent = article.source;
    el.articleModalDate.textContent = formatDate(article.pubDate);
    el.articleModalSummary.textContent = cleanSummary(stripHtml(article.summary));
    const modalImgUrl = article.imageUrl ? article.imageUrl.replace(/^\/\//, 'https://') : '';
    if (modalImgUrl && modalImgUrl.startsWith('http')) {
      el.articleModalImg.src = modalImgUrl;
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
    // Re-arm heavy work for user-initiated re-renders (like /
    // dislike / sort / filter). The cap below is the most
    // important perf knob: detectConflicts is O(N²) and would
    // otherwise freeze the tab for seconds on every click.
    skipHeavyWork = false;
    if (Array.isArray(articles) && articles.length) {
      try {
        const conflictArticles = articles.slice(0, CONFLICT_CORPUS_CAP);
        const conflictMap = AI.detectConflicts(conflictArticles);
        for (const a of articles) {
          const c = conflictMap.get(a.link);
          if (c) a._conflicts = c;
          else delete a._conflicts;
        }
      } catch (e) { /* keep stale badges silently */ }
    }
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
    // Strip small dimension suffixes from filenames (e.g. photo-200x200.jpg → photo.jpg)
    // but preserve query-string size parameters that CDNs may need.
    u = u.replace(/[-_](\d+)x(\d+)(\.\w+)$/i, '$3');
    u = u.replace(/\?&$/, '').replace(/\?$/, '');
    return u !== url ? u : null;
  }

  async function fetchOGImage(articleUrl) {
    try {
      const proxy = 'https://corsproxy.io/?url=';
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
      // Fallback: generic CORS proxy
      u => 'https://corsproxy.io/?url=' + encodeURIComponent(u)
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

  // Capture the current card using dom-to-image-more for an exact visual
  // replica. Returns a Blob (PNG) or null on failure. Hides toolbar/action
  // buttons before capture so the output matches the clean card appearance.
  async function captureCardWithDomImage() {
    if (typeof domtoimage === 'undefined') return null;
    const card = document.querySelector('.reels-stack .reels-card');
    if (!card) return null;

    // Temporarily hide interactive overlays that shouldn't appear in the share
    const actionsBar = card.querySelector('.reels-actions');
    const toolbarRow = card.querySelector('.reels-toolbar-row');
    const navArrows = card.querySelectorAll('.reels-nav');
    const countRow = card.querySelector('.reels-count-row');
    const wasActionsHidden = actionsBar && actionsBar.classList.contains('reels-actions-hidden');
    const wasToolbarDisplay = toolbarRow ? toolbarRow.style.display : '';
    const navDisplays = Array.from(navArrows).map(n => n.style.display);
    const wasCountDisplay = countRow ? countRow.style.display : '';

    if (actionsBar) actionsBar.classList.add('reels-actions-hidden');
    if (toolbarRow) toolbarRow.style.display = 'none';
    navArrows.forEach(n => n.style.display = 'none');
    if (countRow) countRow.style.display = 'none';

    try {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const blob = await domtoimage.toBlob(card, {
        quality: 1,
        backgroundColor: '#000000',
        pixelRatio: dpr,
        cacheBust: true,
        filter: (node: Element) => {
          // Exclude hidden elements
          if (node instanceof HTMLElement && node.style.display === 'none') return false;
          return true;
        },
      });
      return blob;
    } catch (err) {
      console.warn('[Share] dom-to-image-more failed:', err.message);
      return null;
    } finally {
      // Restore hidden elements
      if (actionsBar && !wasActionsHidden) actionsBar.classList.remove('reels-actions-hidden');
      if (toolbarRow) toolbarRow.style.display = wasToolbarDisplay;
      navArrows.forEach((n, i) => { n.style.display = navDisplays[i]; });
      if (countRow) countRow.style.display = wasCountDisplay;
    }
  }

  // Screenshot card — captures the actual DOM element via dom-to-image-more,
  // hides all controls first, then shares or downloads the result.
  async function handleScreenshot(article, btn) {
    btn && btn.classList.add('btn-busy');
    try {
      const blob = await captureCardWithDomImage();
      if (!blob) { btn && btn.classList.remove('btn-busy'); flashCopyButton(btn, 'Screenshot failed'); return; }

      // Copy caption to clipboard (same as handleShareImage)
      const caption = await buildShareCaption(article);
      try { await navigator.clipboard.writeText(caption); } catch {}

      const SHARE_MAX_BYTES = 5 * 1024 * 1024;
      const tooLargeForShare = blob.size > SHARE_MAX_BYTES;
      const file = new File([blob], 'invisible-broadcast.png', { type: 'image/png' });

      if (navigator.share && !tooLargeForShare) {
        try {
          await navigator.share({ files: [file], title: article.title, text: caption });
          btn && btn.classList.remove('btn-busy');
          flashCopyButton(btn, 'Caption copied — share opened');
          return;
        } catch (err) {
          if (err && err.name === 'AbortError') { btn && btn.classList.remove('btn-busy'); return; }
        }
      }

      try {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'invisible-broadcast.png';
        a.click();
        URL.revokeObjectURL(a.href);
        const reason = tooLargeForShare
          ? 'Image too large for share — caption copied, image downloaded'
          : 'Caption copied — image downloaded';
        flashCopyButton(btn, reason);
      } catch {
        flashCopyButton(btn, 'Caption copied');
      }
      btn && btn.classList.remove('btn-busy');
    } catch (err) {
      btn && btn.classList.remove('btn-busy');
      console.warn('Screenshot failed:', err.message);
      flashCopyButton(btn, 'Screenshot failed');
    }
  }

  // Generate a share image. includeImage=true will fetch and embed the
  // source image; includeImage=false will produce a text-only card.
  async function handleShareImage(article, btn, includeImage) {
    btn && btn.classList.add('btn-busy');
    try {
      // dom-to-image-more doesn't support object-fit:cover, so always use custom canvas
      const imgUrl = article.imageUrl ? article.imageUrl.replace(/^\/\//, 'https://') : '';
      const hasThumb = imgUrl && imgUrl.startsWith('http');
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
        const enhanced = enhanceImageUrl(imgUrl);
        candidates.push(enhanced || imgUrl);
        // 2. Raw RSS image (fallback if enhanced URL fails)
        if (enhanced) candidates.push(imgUrl);
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

      // ── Quote type: compact card layout (image at top, text below) ──
      if (article._pubType === 'quote') {
        const quoteFrom = article._pubQuoteFrom || '';
        const quoteOccupation = article._pubQuoteOccupation || '';
        const quoteDate = article._pubQuoteDate || '';
        const quoteText = article.summary || article.title || '';
        // Font sizes mirror the on-screen quote card ratios (card ≈ 390px wide,
        // root 16px): mark 4.8rem ≈ 0.19W · date 0.72rem ≈ 0.03W ·
        // quote 0.9rem ≈ 0.038W · from 1.05rem ≈ 0.043W ·
        // occupation 0.82rem ≈ 0.034W · watermark 0.7rem ≈ 0.029W
        const quoteFontSize = Math.round(W * 0.038);
        const quoteLineH = Math.round(quoteFontSize * 1.5);
        const fromFontSize = Math.round(W * 0.043);
        const occFontSize = Math.round(W * 0.028);
        const wmFontSize = Math.round(W * 0.029);
        const dateFontSize = Math.round(W * 0.03);
        const quoteOpenSize = Math.round(W * 0.19);
        const medGap = Math.round(quoteLineH * 0.25);

        // Measure quote text
        const quoteParagraphs = quoteText.split('\n').filter(p => p.trim());
        const paraGap = Math.round(quoteLineH * 0.5);
        ctx.font = 'italic 700 ' + quoteFontSize + 'px Georgia, "Times New Roman", serif';
        let totalQLines = 0;
        const paraLineCounts: number[] = [];
        for (const para of quoteParagraphs) {
          const n = wrapText(ctx, para, 0, 0, textW, quoteLineH);
          paraLineCounts.push(n);
          totalQLines += n;
        }
        if (totalQLines === 0) { paraLineCounts.push(1); totalQLines = 1; }
        const qH = totalQLines * quoteLineH + Math.max(0, quoteParagraphs.length - 1) * paraGap;
        const fromH = quoteFrom ? fromFontSize : 0;
        // Occupation may wrap to up to 3 lines; measure wrapped height now
        const occLineH = Math.round(occFontSize * 1.3);
        const occMaxW = textW;
        let occLines: string[] = [];
        let occWrappedH = 0;
        if (quoteOccupation) {
          ctx.font = 'italic 700 ' + occFontSize + 'px Georgia, "Times New Roman", serif';
          // First split on explicit newlines (from textarea), then word-wrap each
          const occParagraphs = quoteOccupation.split('\n');
          for (const para of occParagraphs) {
            const words = para.split(' ');
            let occLine = '';
            for (const w of words) {
              const test = occLine ? occLine + ' ' + w : w;
              if (ctx.measureText(test).width > occMaxW && occLine) {
                occLines.push(occLine);
                occLine = w;
              } else {
                occLine = test;
              }
            }
            if (occLine) occLines.push(occLine);
          }
          if (occLines.length > 3) occLines = occLines.slice(0, 3);
          occWrappedH = occLines.length * occLineH;
        }
        const occH = quoteOccupation ? occWrappedH : 0;
        // Quote mark + date share one row; the row is as tall as the big mark.
        const quoteRowH = quoteOpenSize;
        const textBlockH = quoteRowH + medGap + qH + fromH + occH + medGap + medGap + wmFontSize;

        // Layout mirrors the on-screen card:
        //   image = top 60% of the canvas height, full width, cover-cropped.
        //   text  = region starts at 40% of the canvas WIDTH (the overlay's
        //           padding-top: 40% is width-relative) and the block is
        //           vertically centered in the remaining space, so the quote
        //           mark + date row overlaps the image bottom exactly like
        //           the cards view.
        //   no-image = use the full canvas, center the text block vertically.
        const padTop = hasImg ? Math.round(W * 0.4) : PAD;
        const padBottom = hasImg ? Math.round(W * 0.04) : PAD;
        const neededH = padTop + textBlockH + padBottom;
        const canvasH = Math.max(1350, neededH);
        c.height = canvasH * dpr;
        ctx.scale(dpr, dpr);
        ctx.imageSmoothingQuality = 'high';

        // Black background
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, W, canvasH);

        // Image: top 60% of the canvas, cover mode, centered.
        const imgBlockH = Math.round(canvasH * 0.6);
        let imgDrawW = 0, imgDrawH = 0;
        if (hasImg) {
          const scale = Math.max(W / imgW, imgBlockH / imgH);
          imgDrawW = Math.round(imgW * scale);
          imgDrawH = Math.round(imgH * scale);
          const drawX = Math.round((W - imgDrawW) / 2);
          const drawY = Math.round((imgBlockH - imgDrawH) / 2);

          ctx.save();
          ctx.beginPath();
          ctx.rect(0, 0, W, imgBlockH);
          ctx.clip();

          // Multi-pass downscale for sharper output
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
              curW = nextW;
              curH = nextH;
            }
            ctx.drawImage(curSrc, drawX, drawY, imgDrawW, imgDrawH);
          } else {
            ctx.drawImage(img, drawX, drawY, imgDrawW, imgDrawH);
          }

          // Smooth fade to black at the bottom edge (matches the cards view)
          const botFadeH = Math.round(imgBlockH * 0.32);
          const botGrad = ctx.createLinearGradient(0, imgBlockH - botFadeH, 0, imgBlockH);
          botGrad.addColorStop(0, 'rgba(0,0,0,0)');
          botGrad.addColorStop(0.4, 'rgba(0,0,0,0.25)');
          botGrad.addColorStop(0.75, 'rgba(0,0,0,0.7)');
          botGrad.addColorStop(1, 'rgba(0,0,0,1)');
          ctx.fillStyle = botGrad;
          ctx.fillRect(0, imgBlockH - botFadeH, W, botFadeH);

          ctx.restore();
        }

        // Text block: vertically centered in [padTop, canvasH - padBottom]
        const regionH = canvasH - padTop - padBottom;
        const textStartY = padTop + Math.max(0, Math.round((regionH - textBlockH) / 2));

        // ── Row 1: quote mark far left + date far right (PAD on each side),
        // sharing one vertical center so they sit on the same row (matching
        // the cards view flex row: space-between + center) ──
        const dateText = quoteDate ? formatDateActual(quoteDate) : '';
        const rowCenterY = textStartY + Math.round(quoteRowH / 2);
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#ff2929';
        ctx.font = '700 ' + quoteOpenSize + 'px Georgia, "Times New Roman", serif';
        ctx.fillText('\u201C', PAD, rowCenterY);
        if (dateText) {
          ctx.fillStyle = 'rgba(255,255,255,0.6)';
          ctx.font = '700 ' + dateFontSize + 'px Georgia, "Times New Roman", serif';
          const dateW = ctx.measureText(dateText).width;
          ctx.fillText(dateText, W - PAD - dateW, rowCenterY);
        }

        // Quote text — draw each paragraph with gap between them (italic + bold, pure white, no shadow box)
        ctx.fillStyle = '#fff';
        ctx.font = 'italic 700 ' + quoteFontSize + 'px Georgia, "Times New Roman", serif';
        const textBoxY = textStartY + quoteRowH + medGap;
        let textY = textBoxY + quoteLineH;
        let paraIdx = 0;
        for (const para of quoteParagraphs) {
          if (paraIdx > 0) textY += paraGap;
          wrapText(ctx, para, PAD, textY, textW, quoteLineH);
          textY += paraLineCounts[paraIdx] * quoteLineH;
          paraIdx++;
        }

        // Quote from — RIGHT aligned, red, with right padding so the name doesn't touch the edge
        const fromPadRight = Math.round(W * 0.03);
        let afterTextY = textBoxY + qH;
        if (quoteFrom) {
          const fromText = '\u2014 ' + quoteFrom;
          ctx.textBaseline = 'alphabetic';
          const fromTextW = ctx.measureText(fromText).width;
          const fromX = W - PAD - fromPadRight - fromTextW;
          const fromY = afterTextY + fromFontSize;
          ctx.fillStyle = '#ff2929';
          ctx.font = '700 ' + fromFontSize + 'px Georgia, "Times New Roman", serif';
          ctx.fillText(fromText, fromX, fromY);
          afterTextY += fromH;
        }

        // Occupation / title — RIGHT aligned, italic + bold, multiline (up to 3 lines), pure white
        if (quoteOccupation && occLines.length > 0) {
          ctx.textBaseline = 'alphabetic';
          ctx.fillStyle = '#fff';
          ctx.font = 'italic 700 ' + occFontSize + 'px Georgia, "Times New Roman", serif';
          for (let oi = 0; oi < occLines.length; oi++) {
            const olw = ctx.measureText(occLines[oi]).width;
            const olx = W - PAD - fromPadRight - olw;
            ctx.fillText(occLines[oi], olx, afterTextY + occLineH * (oi + 1));
          }
          afterTextY += occH;
        }

        afterTextY += medGap;

        // Separator line — right-aligned, fading (matching cards view: 60% width)
        const sepW = Math.round(textW * 0.6);
        const sepX = W - PAD - sepW;
        const sepGrad = ctx.createLinearGradient(sepX, 0, sepX + sepW, 0);
        sepGrad.addColorStop(0, 'rgba(255,255,255,0)');
        sepGrad.addColorStop(0.3, 'rgba(255,255,255,0.5)');
        sepGrad.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.strokeStyle = sepGrad;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(sepX, afterTextY);
        ctx.lineTo(sepX + sepW, afterTextY);
        ctx.stroke();
        afterTextY += medGap;

        // "Invisible Broadcast" — LEFT aligned, Georgia, pure white (matching cards view).
        // The date lives up in the quote mark row now (matching cards view), not here.
        ctx.fillStyle = '#fff';
        ctx.font = '700 ' + wmFontSize + 'px Georgia, "Times New Roman", serif';
        ctx.textBaseline = 'alphabetic';
        ctx.fillText('Invisible Broadcast', PAD, afterTextY + wmFontSize);

        const blob = await new Promise(r => c.toBlob(r, 'image/png'));
        if (!blob) { btn && btn.classList.remove('btn-busy'); handleShare(article.link, article.title, article.source); return; }

        // Build caption for quote
        const caption = buildQuoteCaption(article);
        try { await navigator.clipboard.writeText(caption); } catch {}

        const SHARE_MAX_BYTES = 5 * 1024 * 1024;
        const tooLargeForShare = blob.size > SHARE_MAX_BYTES;
        const file = new File([blob], 'invisible-broadcast-quote.png', { type: 'image/png' });
        if (navigator.share && !tooLargeForShare) {
          try {
            await navigator.share({ files: [file], title: 'Quote', text: caption });
            btn && btn.classList.remove('btn-busy');
            flashCopyButton(btn, 'Caption copied — share opened');
            return;
          } catch (err) {
            if (err && err.name === 'AbortError') { btn && btn.classList.remove('btn-busy'); return; }
          }
        }
        try {
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = 'invisible-broadcast-quote.png';
          a.click();
          URL.revokeObjectURL(a.href);
          flashCopyButton(btn, 'Caption copied — image downloaded');
        } catch {
          flashCopyButton(btn, 'Caption copied');
        }
        btn && btn.classList.remove('btn-busy');
        return;
      }

      // Measure title and full summary
      ctx.font = 'bold ' + titleFontSize + 'px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, sans-serif';
      const titleLines = wrapText(ctx, article.title || '', 0, 0, textW, titleLineH);
      ctx.font = bodyFontSize + 'px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, sans-serif';
      const summaryLines = fullSummary ? wrapText(ctx, fullSummary, 0, 0, textW, bodyLineH) : 0;

      // Text block height: source + gap + title + gap + summary
      const titleH = titleLines * titleLineH;
      const summaryH = summaryLines * bodyLineH;
      const sourceH = article.source ? sourceFontSize : 0;
      const medGap = Math.round(W * 0.03);

      const textBlockH = sourceH
        + (sourceH ? medGap : 0)
        + titleH
        + medGap
        + (summaryH > 0 ? summaryH + medGap : 0);

      // Image dimensions — cover mode: zoom to fill area, center, crop excess
      let imgDrawW = 0, imgDrawH = 0;
      let imgBlockH = 0;
      // Header area above the image for the IB block (only when image is present)
      const ibHeaderH = hasImg ? Math.round(W * 0.08) : 0;
      if (hasImg) {
        const maxW = W;
        const maxH = imgMaxAreaH - ibHeaderH;
        const scale = Math.max(maxW / imgW, maxH / imgH);
        imgDrawW = Math.round(imgW * scale);
        imgDrawH = Math.round(imgH * scale);
        imgBlockH = ibHeaderH + maxH;
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
        const maxW = W;
        const maxH = imgMaxAreaH - ibHeaderH;
        // Center the oversized image within the bounds (cover mode)
        const drawX = Math.round((maxW - imgDrawW) / 2);
        const drawY = cursorY + ibHeaderH + Math.round((maxH - imgDrawH) / 2);
        imageTopY = cursorY + ibHeaderH;
        const imgRadius = 0;

        // Clip to bounds so the image is cropped (cover mode)
        ctx.save();
        roundRect(ctx, 0, imageTopY, W, maxH, imgRadius);
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

        // Top fade: black → transparent (within bounds)
        const fadeH = Math.round(maxH * 0.2);
        const topGrad = ctx.createLinearGradient(0, imageTopY, 0, imageTopY + fadeH);
        topGrad.addColorStop(0, 'rgba(0,0,0,0.85)');
        topGrad.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = topGrad;
        ctx.fillRect(0, imageTopY, W, fadeH);
        // Bottom fade: transparent → black (within bounds)
        const botGrad = ctx.createLinearGradient(0, imageTopY + maxH - fadeH, 0, imageTopY + maxH);
        botGrad.addColorStop(0, 'rgba(0,0,0,0)');
        botGrad.addColorStop(1, 'rgba(0,0,0,0.85)');
        ctx.fillStyle = botGrad;
        ctx.fillRect(0, imageTopY + maxH - fadeH, W, fadeH);
        // Left fade: black → transparent
        const fadeW = Math.round(W * 0.18);
        const leftGrad = ctx.createLinearGradient(0, 0, fadeW, 0);
        leftGrad.addColorStop(0, 'rgba(0,0,0,0.85)');
        leftGrad.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = leftGrad;
        ctx.fillRect(0, imageTopY, fadeW, maxH);
        // Right fade: transparent → black
        const rightGrad = ctx.createLinearGradient(W - fadeW, 0, W, 0);
        rightGrad.addColorStop(0, 'rgba(0,0,0,0)');
        rightGrad.addColorStop(1, 'rgba(0,0,0,0.85)');
        ctx.fillStyle = rightGrad;
        ctx.fillRect(W - fadeW, imageTopY, fadeW, maxH);

        ctx.restore(); // remove clip
        cursorY += imgBlockH + gap;
      }

      // Source label (uppercase, red) on the left, published date on the right
      if (article.source) {
        ctx.fillStyle = '#ff2929';
        ctx.font = '700 ' + sourceFontSize + 'px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, sans-serif';
        ctx.textBaseline = 'alphabetic';
        ctx.textAlign = 'left';
        ctx.fillText(article.source.toUpperCase(), PAD, cursorY + sourceFontSize);

        // Published date only (no time) on the right side of the same row (in IST)
        if (article.pubDate) {
          const d = new Date(article.pubDate);
          const pubDateText = isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
          if (pubDateText) {
            ctx.fillStyle = 'rgba(230, 237, 243, 0.65)';
            ctx.font = '500 ' + sourceFontSize + 'px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, sans-serif';
            ctx.textAlign = 'right';
            ctx.fillText(pubDateText, W - PAD, cursorY + sourceFontSize);
            ctx.textAlign = 'left';
          }
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

      // Watermark removed per user request

      const blob = await new Promise(r => c.toBlob(r, 'image/png'));
      if (!blob) { btn && btn.classList.remove('btn-busy'); handleShare(article.link, article.title, article.source); return; }

      // Build the Instagram-style caption. The user asked for a
      // caption that's "the exact same as the title/summary, but
      // AI-rephrased without AI" — i.e. social-friendly copy
      // built from the article's own text, with five hashtags
      // (#invisiblebroadcast guaranteed, the others derived from
      // the article's subcat / source). The actual rephrasing is
      // done in buildShareCaption() — see comment there.
      const caption = await buildShareCaption(article);

      // Step 1: copy the caption text to the clipboard FIRST. The
      // user explicitly wants the text in the clipboard for
      // Instagram (which doesn't accept image+text in the share
      // sheet the way Twitter does — IG reads from the clipboard
      // when you paste into a new post). We always do this,
      // regardless of whether the share / download path succeeds.
      try { await navigator.clipboard.writeText(caption); } catch {}

      // Step 2: hand the image to the OS share sheet if available.
      // If the blob is too large for the share sheet (>5MB), skip
      // share and download instead — the user can still attach the
      // downloaded file manually. 5MB covers every realistic
      // phone-screen capture without choking the share intent.
      const SHARE_MAX_BYTES = 5 * 1024 * 1024;
      const tooLargeForShare = blob.size > SHARE_MAX_BYTES;
      const file = new File([blob], 'invisible-broadcast.png', { type: 'image/png' });
      if (navigator.share && !tooLargeForShare) {
        try {
          await navigator.share({ files: [file], title: article.title, text: caption });
          btn && btn.classList.remove('btn-busy');
          flashCopyButton(btn, 'Caption copied — share opened');
          return;
        } catch (err) {
          if (err && err.name === 'AbortError') { btn && btn.classList.remove('btn-busy'); return; }
          // Any other error (NotAllowedError, etc.) — fall through to download
        }
      }
      // Step 3: either share was unavailable, share was aborted by
      // the OS, or the image was too large. In all three cases
      // download the image to the user's device so they can pick
      // it up in their gallery / camera roll. The caption is
      // already in the clipboard from Step 1.
      try {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'invisible-broadcast.png';
        a.click();
        URL.revokeObjectURL(a.href);
        const reason = tooLargeForShare
          ? 'Image too large for share — caption copied, image downloaded'
          : 'Caption copied — image downloaded';
        flashCopyButton(btn, reason);
      } catch {
        flashCopyButton(btn, 'Caption copied');
      }
      btn && btn.classList.remove('btn-busy');
    } catch (err) {
      btn && btn.classList.remove('btn-busy');
      console.warn('Image share failed:', err.message);
      handleShare(article.link, article.title, article.source);
    }
  }

  // Build the share caption. The user does NOT want a literal
  // copy of the article title/description — they want a short
  // rephrased version that reads like social-media copy, plus
  // 5 hashtags (with #invisiblebroadcast guaranteed first).
  //
  // We don't use AI. The "rephrasing" is a deterministic
  // template-based pipeline that produces text CLEARLY different
  // from the original (not just a compression of the original
  // sentences with a few synonym swaps):
  //
  //   1. Clean the title — remove common news prefixes
  //      ("Breaking:", "Update:", "Just in:", "Reported:", …) and
  //      trailing punctuation → this becomes the **topic**.
  //   2. Use TF.js to find the most "central" sentence from the
  //      summary: build TF-IDF vectors, compute the centroid via
  //      tf.tensor2d().mean(0), then pick the sentence with the
  //      highest cosine similarity to the centroid. This is the
  //      **key fact** — a SINGLE sentence, not two.
  //   3. Compress the key fact (strip filler, apply synonyms,
  //      cap at ~120 chars).
  //   4. Build the body as "Update: [topic]. [compressed key fact]"
  //      — a freshly composed sentence around the extracted topic
  //      + key fact, not the original wording.
  //   5. Cap the body at ~280 chars (Instagram caption sweet spot).
  //   6. Append 5 hashtags from buildHashtags() below. The source
  //      name shows up here (e.g. #apple, #thehindu) instead of
  //      being spliced into the body — the body stays clean.
  //
  // The result is a short caption that uses the article's
  // information but in a clearly different structure. It does
  // NOT copy the title or summary verbatim.
  async function buildShareCaption(article) {
    if (!article) return '';
    const title = cleanTitleForTopic(article.title);
    const summary = cleanSummary(stripHtml(article.summary || '')).trim();
    const body = await buildRephrasedBody(title, summary);
    // Build source line for copied text
    const sourceName = article._pubSourceName || '';
    const sourceLink = article._pubSourceLink || article.link || '';
    const sourceLine = sourceName ? sourceName + '\n' + sourceLink : (sourceLink || '');
    const hashtags = buildHashtags(article).join(' ');
    const footer = sourceLine ? sourceLine + '\n\n' + hashtags : hashtags;
    if (!body) {
      return (title || cleanSummary(stripHtml(article.title || '')).trim()) +
        '\n\n' + footer;
    }
    return body + '\n\n' + footer;
  }

  // Build caption for Quote type posts. Format:
  // "quote text"
  // — quote_from
  //
  // Invisible Broadcast
  // source link
  // #invisiblebroadcast
  function buildQuoteCaption(article) {
    if (!article) return '';
    const quoteText = (article.summary || '').trim();
    const quoteFrom = article._pubQuoteFrom || '';
    const sourceLink = article._pubSourceLink || article.link || '';
    const lines = [];
    lines.push('\u201C' + quoteText + '\u201D');
    if (quoteFrom) lines.push('\u2014 ' + quoteFrom);
    lines.push('');
    lines.push('Invisible Broadcast');
    if (sourceLink) lines.push(sourceLink);
    lines.push('');
    lines.push('#invisiblebroadcast');
    return lines.join('\n');
  }

  // ── Rephraser internals (no AI, all rule-based + TF.js) ──

  // Clean a title for use as the topic in the caption.
  //   "Breaking: Apple unveils iPhone 15"     → "Apple unveils iPhone 15"
  //   "Update: New COVID variant detected"    → "New COVID variant detected"
  //   "Reported — Markets rally on Fed pause" → "Markets rally on Fed pause"
  function cleanTitleForTopic(title) {
    if (!title) return '';
    let t = String(title).trim();
    if (!t) return '';
    t = t.replace(
      /^(breaking|just in|update|developing|alert|news|exclusive|latest|watch|video|photos|reported|reports|according to|alert:|developing:)\s*[:\-—]\s*/i,
      ''
    );
    t = t.replace(/[.!?]+$/, '').trim();
    if (t.length > 0) t = t[0].toUpperCase() + t.slice(1);
    return t;
  }

  // Common leading phrases that add no information. We strip these
  // from the START of a sentence to compress without changing meaning.
  const FILLER_PREFIXES = [
    /^(according to|reports say|reports said|it is reported that|reportedly|officials said|according to reports)\s+/i,
    /^(the|a|an|in|on|at|for|with|by|of|to|as|from|that|this|these|those|over|under)\s+/i,
    /^(breaking|just in|update|developing|alert)\s*[:\-—]\s*/i
  ];

  // Light synonym-rewrite table. These are deliberately common,
  // non-controversial swaps that change surface wording without
  // altering meaning. Apply whole-word, case-preserving.
  const SYNONYM_TABLE = [
    [/\bsays\b/gi,         'reports'],
    [/\bsaid\b/gi,         'reported'],
    [/\breveals?\b/gi,     'shows'],
    [/\bannounced?\b/gi,   'unveiled'],
    [/\baccording to\b/gi, 'per'],
    [/\bin order to\b/gi,  'to'],
    [/\bdue to the fact that\b/gi, 'because'],
    [/\ba large number of\b/gi, 'many'],
    [/\ba majority of\b/gi, 'most'],
    [/\bin the event that\b/gi, 'if'],
    [/\bhas the ability to\b/gi, 'can'],
    [/\bwill be able to\b/gi, 'can'],
    [/\bit is important to note that\b/gi, ''],
    [/\bneedless to say\b/gi, '']
  ];

  // Compress a single sentence: strip leading filler, apply
  // synonym rewrites, collapse whitespace, cap length.
  function compressSentence(s, maxLen) {
    if (!s) return '';
    let out = s.trim();
    // Strip filler prefixes repeatedly (e.g. "The In a" → "a" → "").
    let prev;
    do { prev = out; for (const re of FILLER_PREFIXES) out = out.replace(re, ''); }
    while (out !== prev && out.length > 0);
    // Synonym swaps.
    for (const [re, rep] of SYNONYM_TABLE) out = out.replace(re, rep);
    // Collapse whitespace and stray leading punctuation.
    out = out.replace(/\s+/g, ' ').replace(/^[\s,;:\-—]+/, '').trim();
    // Cap. Prefer cutting at a sentence end or word boundary.
    if (maxLen && out.length > maxLen) {
      const slice = out.slice(0, maxLen);
      const lastSpace = slice.lastIndexOf(' ');
      out = (lastSpace > 40 ? slice.slice(0, lastSpace) : slice).trim();
      if (!/[.!?]$/.test(out)) out += '…';
    }
    return out;
  }

  // Cosine similarity between two plain-JS vectors. Used after
  // TF.js has computed the centroid.
  function _cosineSim(a, b) {
    let dot = 0, ma = 0, mb = 0;
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
      const av = a[i] || 0, bv = b[i] || 0;
      dot += av * bv;
      ma  += av * av;
      mb  += bv * bv;
    }
    const den = Math.sqrt(ma) * Math.sqrt(mb);
    return den === 0 ? 0 : dot / den;
  }

  // Use TF.js to extract the most "central" sentence from the
  // summary. We build TF-IDF vectors for each sentence, use
  async function extractKeyFact(summary) {
    if (!summary) return null;
    const sentences = summary
      .split(/(?<=[.!?])\s+/)
      .map(s => s.trim())
      .filter(Boolean);
    if (!sentences.length) return null;
    if (sentences.length === 1) return compressSentence(sentences[0], 120);

    const tokenized = sentences.map(s =>
      (s.toLowerCase().match(/\b[a-z]{3,}\b/g) || [])
    );

    const vocab = new Set();
    for (const tokens of tokenized) for (const t of tokens) vocab.add(t);
    const vocabList = Array.from(vocab);
    if (!vocabList.length) return compressSentence(sentences[0], 120);

    const N = sentences.length;
    const docFreq = {};
    for (const term of vocabList) {
      let c = 0;
      for (const tokens of tokenized) if (tokens.indexOf(term) !== -1) c++;
      docFreq[term] = c;
    }

    const vectors = tokenized.map(tokens => {
      const tf = {};
      for (const t of tokens) tf[t] = (tf[t] || 0) + 1;
      const v = new Array(vocabList.length);
      for (let i = 0; i < vocabList.length; i++) {
        const term = vocabList[i];
        const tfVal = tf[term] || 0;
        const idf   = Math.log(N / (docFreq[term] || 1));
        v[i] = tfVal * idf;
      }
      return v;
    });

    const dim = vectors[0].length;
    const centroid = new Array(dim).fill(0);
    for (const v of vectors) {
      for (let i = 0; i < dim; i++) centroid[i] += v[i];
    }
    for (let i = 0; i < dim; i++) centroid[i] /= vectors.length;

    let bestIdx = 0;
    let bestSim = -1;
    for (let i = 0; i < N; i++) {
      const sim = _cosineSim(vectors[i], centroid);
      if (sim > bestSim) { bestSim = sim; bestIdx = i; }
    }
    return compressSentence(sentences[bestIdx], 120);
  }

  // Build the rephrased body. This is the main rephraser.
  // It produces a NEW sentence (not a copy of the original)
  // by combining:
  //   - a cleaned title (the "topic")
  //   - the most central sentence from the summary (the "key fact"),
  //     extracted via TF.js TF-IDF + centroid finding
  // …wrapped in a simple "Update: [topic]." hook. The source name
  // is no longer spliced into the body — that read as awkward
  // filler ("Apple reports on Apple unveils iPhone 15…") and the
  // source is already represented in the hashtags instead.
  async function buildRephrasedBody(title, summary) {
    // 1. Extract the key fact from the summary using TF.js.
    //    This is a SINGLE sentence, not two, and it's the one
    //    most representative of the summary (highest cosine
    //    similarity to the TF-IDF centroid).
    let keyFact = null;
    if (summary) {
      try { keyFact = await extractKeyFact(summary); } catch {}
      // Fallback: first sentence of the summary, compressed.
      if (!keyFact) {
        const sentences = summary
          .split(/(?<=[.!?])\s+/)
          .map(s => s.trim())
          .filter(Boolean);
        if (sentences.length > 0) keyFact = compressSentence(sentences[0], 120);
      }
    }

    // 2. Build the body. The structure is deliberately different
    //    from the original title/summary so the output doesn't
    //    read like a verbatim copy.
    let body = '';
    if (title) {
      body = title + '.';
    } else if (keyFact) {
      body = keyFact;
    } else {
      return '';
    }

    // 3. Add the key fact — a single compressed sentence, clearly
    //    different in structure from the topic above. The two
    //    sentences together form a "rephrased" version: the topic
    //    names the story, the key fact elaborates.
    if (keyFact && body.indexOf(keyFact) === -1) {
      body += ' ' + keyFact;
    }

    // 4. Final cap at ~280 chars (Instagram caption sweet spot).
    if (body.length > 280) {
      const slice = body.slice(0, 280);
      const lastSpace = slice.lastIndexOf(' ');
      body = (lastSpace > 100 ? slice.slice(0, lastSpace) : slice).trim();
      if (!/[.!?…]$/.test(body)) body += '…';
    }
    return body;
  }

  // Build 5 hashtags. The first is always #invisiblebroadcast
  // (the user's brand). The remaining four are derived from
  // the article's subcat, source, and a couple of evergreen
  // news tags. The function de-duplicates and trims to 5.
  function buildHashtags(article) {
    const tags = ['#invisiblebroadcast'];
    const title = (article.title || '').toLowerCase();
    const summary = (article.summary || '').toLowerCase();
    const combined = title + ' ' + summary;

    // Emotional keyword → hashtag mappings
    const EMOTION_MAP = [
      [/\b(breakthrough|milestone|discover|invent|pioneer|first-ever|landmark)\b/, '#breakthrough'],
      [/\b(victory|triumph|win\b|won\b|champion|success|achievement|accomplish)\b/, '#victory'],
      [/\b(hope|optimis|promising|encouraging|positive|progress|improve|better)\b/, '#progress'],
      [/\b(innovation|innovative|cutting-edge|next-gen|futur|revolution)\b/, '#innovation'],
      [/\b(crisis|emergency|disaster|catastrophe|devastat|tragedy|tragic)\b/, '#crisis'],
      [/\b(warning|warned|alert|danger|threat|risky|hazard)\b/, '#warning'],
      [/\b(controversy|controversial|scandal|allegation|probe)\b/, '#controversy'],
      [/\b(concern|worried|worrying|alarming|fears?|anxiety)\b/, '#concern'],
      [/\b(deadly|kill|death|fatal|casualt|attack|violen|war\b|collide)\b/, '#tragedy'],
      [/\b(surge|boost|growth|increase|expand|boom|rally)\b/, '#surge'],
      [/\b(drop|decline|fall|plunge|slump|slowdown|shrink)\b/, '#decline'],
      [/\b(agreement|deal\b|treaty|alliance|partnership|coalition)\b/, '#deal'],
      [/\b(approve|approval|clear|greenlit|sanction|ratify)\b/, '#approved'],
      [/\b(ban\b|banned|restrict|curb|crackdown|outlaw|prohibit)\b/, '#crackdown'],
      [/\b(resign|resignation|ousted|fired|sack|dismiss|quit\b)\b/, '#resignation'],
      [/\b(elected|election|vote|ballot|candidate|campaign|poll)\b/, '#election'],
      [/\b(court|verdict|judge|sue|lawsuit|legal|convict|sentence)\b/, '#legal'],
      [/\b(protest|rally|demonstrat|strike|walkout|unrest)\b/, '#protest'],
      [/\b(release|launch|unveil|introduce|debut|rollout|premier)\b/, '#launch'],
      [/\b(investigate|probe|inquiry|audit|scrutiny|review)\b/, '#investigation'],
      [/\b(donate|donation|aid\b|relief|charity|fundraiser|philanthropy)\b/, '#philanthropy'],
      [/\b(health|disease|virus|vaccine|medical|hospital|surgery|treatment)\b/, '#health'],
      [/\b(climate|weather|storm|flood|earthquake|wildfire|drought|heatwave)\b/, '#climate'],
      [/\b(tech|digital|ai\b|robot|cyber|software|startup|app\b)\b/, '#tech'],
      [/\b(science|research|study|lab\b|experiment|academic|scientist)\b/, '#science'],
      [/\b(space|nasa|satellite|rocket|orbit|astronaut|cosmic|lunar|mars)\b/, '#space'],
      [/\b(sport|game\b|match\b|tournament|championship|olymp|league)\b/, '#sports'],
      [/\b(market|stock|trade|tariff|economy|inflation|gdp|budget)\b/, '#economy'],
      [/\b(music|film|movie|artist|concert|album|actor|award|festival)\b/, '#culture'],
      [/\b(education|school|university|college|student|teacher|academy)\b/, '#education'],
      [/\b(energy|oil\b|gas\b|fuel|renewable|solar|wind|nuclear|power)\b/, '#energy'],
      [/\b(religion|faith|church|temple|mosque|worship|spirit|divine)\b/, '#faith'],
      [/\b(housing|rent|mortgage|real-estate|property|homeless|shelter)\b/, '#housing'],
      [/\b(immigration|migrant|asylum|refugee|border|deportation|visa)\b/, '#immigration'],
      [/\b(crime|criminal|theft|fraud|robbery|smuggling|gang|mafia)\b/, '#crime'],
      [/\b(diploma|diplomat|ambassador|summit|bilateral|foreign|geopolitical)\b/, '#diplomacy'],
      [/\b(infrastructure|bridge|road|railway|highway|tunnel|dam|construction)\b/, '#infrastructure'],
      [/\b(agriculture|farm|farmer|crop|harvest|food|rural|organic)\b/, '#agriculture'],
      [/\b(peace|ceasefire|truce|reconciliation|armistice|negotiation)\b/, '#peace'],
      [/\b(memorial|tribute|honor|remembrance|anniversary|legacy)\b/, '#tribute'],
      [/\b(sanction|embargo|boycott|freeze|blacklist|penalty)\b/, '#sanctions'],
      [/\b(privacy|surveillance|encryption|data-breach|hack\b|cyberattack)\b/, '#privacy'],
    ];
    for (const [re, tag] of EMOTION_MAP) {
      if (re.test(combined) && !tags.includes(tag)) tags.push(tag);
      if (tags.length >= 4) break;
    }

    // Extract named entities: capitalized multi-word phrases in the title
    const titleClean = (article.title || '').trim();
    const entities = [];
    if (titleClean) {
      const rawEntities = titleClean.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\b/g) || [];
      const stopEntities = new Set(['The', 'This', 'That', 'These', 'Those', 'What', 'How', 'Why', 'When', 'Where', 'Who', 'In', 'On', 'At', 'For', 'With', 'By', 'To', 'From', 'As', 'But', 'Not', 'All', 'One', 'Two', 'New', 'After', 'Before', 'Over', 'Under', 'More', 'Most', 'Some', 'Such', 'Than', 'Then', 'Also', 'Very', 'Just', 'About', 'Into', 'Through', 'During', 'Before', 'After', 'Above', 'Below', 'Between', 'Among', 'Without', 'Within', 'Along', 'Across', 'Behind', 'Beyond', 'Upcoming', 'Ongoing', 'Recent', 'Latest', 'Breaking', 'Update', 'Developing', 'Report', 'Exclusive', 'Alert', 'Video', 'Photo', 'Watch', 'Listen', 'Live']);
      for (const ent of rawEntities) {
        const clean = ent.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
        if (clean.length >= 3 && !stopEntities.has(ent)) {
          const tag = '#' + clean;
          if (!tags.includes(tag)) { entities.push(tag); }
          if (entities.length >= 2) break;
        }
      }
    }

    // Interleave entities first (they're most specific), then emotional tags
    const result = ['#invisiblebroadcast'];
    const seen = new Set(result);
    const interleave = [];
    const maxE = Math.min(entities.length, 2);
    for (let i = 0; i < maxE; i++) {
      if (!seen.has(entities[i])) { interleave.push(entities[i]); seen.add(entities[i]); }
    }
    const pool = tags.slice(1); // emotional tags after #invisiblebroadcast
    for (const t of pool) {
      if (result.length + interleave.length >= 5) break;
      if (!seen.has(t)) { interleave.push(t); seen.add(t); }
    }
    // Pad with subcat, source, evergreen
    const fallback = [];
    const subcat = (article.feedHint || article.subcat || '').toString().toLowerCase().replace(/[^a-z0-9]/g, '');
    if (subcat && !seen.has('#' + subcat)) { fallback.push('#' + subcat); seen.add('#' + subcat); }
    const source = (article.source || '').toString().toLowerCase().replace(/^the\s+/, '').split(/[\s\-—–|]+/)[0].replace(/[^a-z0-9]/g, '');
    if (source && source !== subcat && !seen.has('#' + source)) { fallback.push('#' + source); seen.add('#' + source); }
    for (const f of ['#news', '#today', '#breaking', '#worldnews', '#headlines', '#dailynews']) {
      if (!seen.has(f)) { fallback.push(f); seen.add(f); }
      if (fallback.length >= 5 - result.length) break;
    }
    // Build final: first entity, then from interleave pool, then fallback
    for (const item of interleave) {
      if (result.length >= 5) break;
      result.push(item);
    }
    for (const item of fallback) {
      if (result.length >= 5) break;
      result.push(item);
    }
    return result.slice(0, 5);
  }

  // Brief "blinking" feedback after a successful copy. We
  // temporarily swap the button's text/title so the user gets a
  // visible confirmation. The previous label is restored after
  // 1.6s.
  function flashCopyButton(btn, msg) {
    if (!btn) return;
    try {
      const prevLabel = btn.getAttribute('aria-label') || btn.textContent;
      const prevTitle = btn.getAttribute('title') || '';
      btn.setAttribute('data-prev-label', prevLabel);
      btn.setAttribute('data-prev-title', prevTitle);
      btn.setAttribute('aria-label', msg);
      btn.setAttribute('title', msg);
      btn.classList.add('btn-copied');
      // Build a small "copied!" pill that floats above the button.
      let pill = btn.querySelector('.copy-pill');
      if (!pill) {
        pill = document.createElement('span');
        pill.className = 'copy-pill';
        btn.appendChild(pill);
      }
      pill.textContent = msg;
      pill.classList.add('copy-pill-show');
      setTimeout(() => {
        pill.classList.remove('copy-pill-show');
        btn.classList.remove('btn-copied');
        const pl = btn.getAttribute('data-prev-label');
        const pt = btn.getAttribute('data-prev-title');
        if (pl != null) btn.setAttribute('aria-label', pl);
        if (pt != null) btn.setAttribute('title', pt);
      }, 1600);
    } catch {}
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
      // Per-card ⚖️ Analyze button. Opens the config modal pre-filled
      // with the article's tagged subject.
      const analyzeBtn = e.target.closest('.card-analyze-btn');
      if (analyzeBtn) {
        e.stopPropagation();
        const url = decodeURIComponent(analyzeBtn.dataset.article);
        const article = findArticleByLink(url);
        if (article && article.subject && window.AnalyzeModal) {
          AnalyzeModal.openConfig({ subject: article.subject, sourceArticle: article });
        } else if (window.AnalyzeModal) {
          AnalyzeModal.openConfig({});
        }
        return;
      }
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
        const shareCheckImg = article && article.imageUrl ? article.imageUrl.replace(/^\/\//, 'https://') : '';
        if (shareCheckImg && shareCheckImg.startsWith('http')) {
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
      // Cards button — open reels view at this article
      const cardsBtn = e.target.closest('[data-cards-article]');
      if (cardsBtn) {
        e.stopPropagation();
        if (el.articleModal && el.articleModal.classList.contains('open')) closeArticleModal();
        openReelsForArticle(decodeURIComponent(cardsBtn.dataset.cardsArticle));
        return;
      }
      const publishBtn = e.target.closest('.card-publish-btn');
      if (publishBtn) {
        e.stopPropagation();
        if (!currentUser) { alert('Please sign in to publish articles'); return; }
        const url = decodeURIComponent(publishBtn.dataset.publishArticle);
        const article = findArticleByLink(url);
        if (article) openPublishModal(article);
        return;
      }
      const editBtn = e.target.closest('.card-edit-btn');
      if (editBtn) {
        e.stopPropagation();
        if (!currentUser) { alert('Please sign in'); return; }
        const url = decodeURIComponent(editBtn.dataset.publishArticle);
        const article = findArticleByLink(url);
        if (article && article._isPublished && article._pubId) editPublishedArticle(article._pubId);
        return;
      }
      const deleteBtn = e.target.closest('.card-delete-btn');
      if (deleteBtn) {
        e.stopPropagation();
        if (!currentUser) { alert('Please sign in'); return; }
        const url = decodeURIComponent(deleteBtn.dataset.publishArticle);
        const article = findArticleByLink(url);
        if (article && article._isPublished && article._pubId) deletePublishedArticle(article._pubId);
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
    const articleModalCardsBtn = $('#article-modal-cards-btn');
    if (articleModalCardsBtn) {
      articleModalCardsBtn.addEventListener('click', () => {
        const url = el.articleModalRead.dataset.url;
        if (!url) return;
        closeArticleModal();
        const cluster = _topicsClusters.find(c => c.articles.some(a => a.link === url));
        if (cluster) {
          const clusterId = cluster.id;
          const restore = () => {
            closeClusterModal();
            openClusterModal(clusterId);
          };
          openReelsForArticle(url, cluster.articles, restore);
        } else {
          openReelsForArticle(url);
        }
      });
    }
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
      // Notify PublishModal about the signed-in user
      if (window.PublishModal && typeof window.PublishModal.setCurrentUser === 'function') {
        window.PublishModal.setCurrentUser(user);
      }
    } else {
      if (window.PublishModal && typeof window.PublishModal.setCurrentUser === 'function') {
        window.PublishModal.setCurrentUser(null);
      }
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

    // Resolve the current session. If the URL has OAuth tokens (redirect
    // from Google) and getSession() returns null due to a race in the
    // Supabase client's async initialisation, we manually extract them
    // and call setSession so the user is signed in immediately.
    (async () => {
      const { data } = await client.auth.getSession();
      if (data?.session) {
        handleAuthChange(null, data.session);
        return;
      }
      // Fallback: manually process OAuth tokens from the URL hash
      const hash = window.location.hash;
      if (hash) {
        if (hash.includes('access_token=')) {
          try {
            const p = new URLSearchParams(hash.replace(/^#/, ''));
            const at = p.get('access_token');
            const rt = p.get('refresh_token');
            if (at && rt) {
              const { data: sd, error: se } = await client.auth.setSession({ access_token: at, refresh_token: rt });
              if (!se && sd?.session) {
                handleAuthChange(null, sd.session);
                // Clean up the URL so the tokens aren't visible
                history.replaceState(history.state, '', location.pathname + location.search);
                return;
              }
            }
          } catch (e) { console.warn('OAuth fallback failed:', e); }
        } else if (hash.includes('error=')) {
          const p = new URLSearchParams(hash.replace(/^#/, ''));
          const errDesc = p.get('error_description') || p.get('error') || 'OAuth error';
          console.warn('[Auth] OAuth error in URL hash:', errDesc);
          // Clean the hash
          history.replaceState(history.state, '', location.pathname + location.search);
        }
      }
      handleAuthChange(null, null);
    })();

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

    // Google OAuth button — full-page redirect with PKCE flow.
    // PKCE is the standard for SPAs and doesn't require a client secret.
    const googleBtn = $('#auth-google-btn');
    if (googleBtn) {
      googleBtn.addEventListener('click', () => {
        if (window.location.protocol === 'file:') {
          const msg = $('#auth-msg');
          if (msg) { msg.textContent = 'Google sign-in requires a web server (http:// or https://).'; msg.classList.add('error'); }
          return;
        }
        client.auth.signInWithOAuth({
          provider: 'google',
          options: {
            redirectTo: window.location.origin + '/News-Feeds/',
            queryParams: {
              prompt: 'select_account',
              access_type: 'offline',
            },
          },
        });
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

  /* ── Loading Overlay ── */
  function showLoadingOverlay(status) {
    console.log('[showLoadingOverlay] status=' + status);
    const overlay = $('#app-loading-overlay');
    const sp = $('#app-loading-spinner');
    const statusEl = $('#app-loading-status');
    const progressWrap = $('#app-loading-progress-wrap');
    const confirm = $('#app-loading-confirm');
    if (overlay) {
      console.log('[showLoadingOverlay] overlay element found, adding open class');
      overlay.classList.add('open');
    } else {
      console.warn('[showLoadingOverlay] #app-loading-overlay not found in DOM!');
    }
    if (sp) sp.style.display = 'block';
    if (statusEl) statusEl.textContent = status || 'Loading\u2026';
    if (progressWrap) progressWrap.style.display = 'none';
    if (confirm) confirm.style.display = 'none';
  }
  function updateLoadingStatus(status) {
    const el = $('#app-loading-status');
    if (el) el.textContent = status;
  }
  function showLoadingProgress(pct) {
    const wrap = $('#app-loading-progress-wrap');
    const bar = $('#app-loading-progress-bar');
    if (wrap) wrap.style.display = 'block';
    if (bar) bar.style.width = Math.round(pct * 100) + '%';
  }
  function showLoadingConfirm() {
    const sp = $('#app-loading-spinner');
    const confirm = $('#app-loading-confirm');
    if (sp) sp.style.display = 'none';
    if (confirm) confirm.style.display = 'flex';
  }
  function hideLoadingOverlay() {
    console.log('[hideLoadingOverlay] removing open class');
    const overlay = $('#app-loading-overlay');
    if (overlay) overlay.classList.remove('open');
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

    // Populate the footer bar immediately so it shows the section title
    // (feeds/topics/conflicts) without waiting for the full fetch chain.
    try { updateStickyHeader(); } catch (e) { /* noop */ }

    // First-run subscription initialisation. Previously this only
    // ran when the user opened the Settings modal (via
    // renderSubscriptionList), so an incognito user — who never
    // visits Settings — saw "no articles" on the first run even
    // though every source is by default enabled. Run the same
    // logic here, before any feed fetch, so the initial article
    // load always has the full set of subscriptions.
    try {
      const hasInit = localStorage.getItem('newsfeeds_subscriptions_initialized') === '1';
      const currentSubs = FeedManager.getSubscribedFeeds();
      if (!hasInit && currentSubs.length === 0) {
        const allFeeds = FeedManager.getSubscribableFeeds();
        const allUrls = allFeeds.filter(f => f.hasRss && f.url).map(f => f.url);
        if (allUrls.length) {
          FeedManager.saveSubscribedFeeds(allUrls);
          localStorage.setItem('newsfeeds_subscriptions_initialized', '1');
        }
      }
    } catch (e) {
      console.warn('Subscription auto-init failed:', e);
    }

    // Restore persisted cross-page state from AppState so the user
    // lands on the same scope / nation / subcat / mode / view / sort
    // / search they left on the last visit. Must happen AFTER all let
    // declarations have executed (to avoid TDZ issues) and before any
    // rendering. The FeedManager default below is the fallback.
    (function _restoreState() {
      const params = new URLSearchParams(window.location.search);
      const s = AppState.load();
      const paramScope = params.get('scope');
      const paramNation = params.get('nation');
      const paramSection = params.get('section');
      const paramSubcat = params.get('subcat');
      const paramExploreTab = params.get('exploreTab');

      if (paramExploreTab) {
        currentExploreTab = paramExploreTab;
      }

      if (paramScope === 'global') {
        currentScope = 'global';
      } else if (paramScope === 'nation') {
        currentScope = 'nation';
      } else if (s.currentScope) {
        currentScope = s.currentScope;
      }

      if (paramNation) {
        currentNation = paramNation;
      } else if (s.currentNation) {
        currentNation = s.currentNation;
      } else {
        currentNation = FeedManager.getSelectedNation();
      }

      if (paramSection) {
        currentSection = paramSection;
      } else if (s.currentSection) {
        currentSection = s.currentSection === 'news' || s.currentSection === 'explore' ? 'feeds' : s.currentSection;
      } else {
        currentSection = 'feeds';
      }

      if (paramSubcat) {
        currentSubcat = paramSubcat;
        currentSection = 'feeds';
      } else if (s.currentSubcat) {
        currentSubcat = s.currentSubcat;
      }

      if (s.currentMode) currentMode = s.currentMode;
      if (s.currentView) currentView = s.currentView;
      if (s.currentSort) currentSort = s.currentSort;
      if (s.sourceFilter) sourceFilter = s.sourceFilter;
    })();

    await SupabaseStore.load();
    // Load custom feeds (Supabase is the source of truth when the
    // user is signed in; localStorage is a cache + the only store
    // when signed out). This must run AFTER SupabaseStore is ready
    // so FeedManager can hit the `custom_feeds` table.
    try { await FeedManager.loadCustomFeeds(); } catch (e) {
      console.warn('FeedManager.loadCustomFeeds failed:', e && e.message);
    }
    // Resume any article-archive queue from a previous session.
    // This must happen AFTER SupabaseStore is ready (the archive
    // uses SupabaseStore.getClient()) and after FeedManager is
    // loaded (the archive looks up feed lang by URL).
    if (window.ArticleArchive && ArticleArchive.init) ArticleArchive.init();
    // Pre-fetch published articles from Supabase — MUST await so
    // getCachedPublished() returns data when renderContent() merges
    // IB articles into groups.
    await fetchPublishedArticlesFromSupabase();
    bindAuth();

    // AI model consent flow. First visit → prompt. Subsequent loads
    // with consent → background load (no overlay since the model is
    // already locally cached by the browser). Declined → silent no-op.
    if (window.Embeddings && Embeddings.needsConsent) {
      if (Embeddings.needsConsent()) {
        showLoadingOverlay('Loading feeds\u2026');
        const skipBtn = $('#app-loading-skip-btn');
        const dlBtn = $('#app-loading-download-btn');
        if (skipBtn) skipBtn.onclick = () => {
          Embeddings.setConsent(false);
          hideLoadingOverlay();
        };
        if (dlBtn) dlBtn.onclick = () => {
          Embeddings.setConsent(true);
          updateLoadingStatus('Downloading AI library\u2026');
          showLoadingProgress(0);
          Embeddings.loadModelWithProgress(p => {
            if (p.status === 'download') {
              if (p.phase === 'library') updateLoadingStatus('Downloading AI library\u2026');
              else updateLoadingStatus('Downloading AI model\u2026');
              if (typeof p.progress === 'number') showLoadingProgress(p.progress);
            } else if (p.status === 'ready') {
              updateLoadingStatus('AI model ready');
              setTimeout(hideLoadingOverlay, 400);
            } else if (p.status === 'error') {
              updateLoadingStatus('AI model failed: ' + (p.error || 'unknown error'));
              setTimeout(hideLoadingOverlay, 2000);
            }
          }).catch(() => {});
        };
        setTimeout(showLoadingConfirm, 600);
      } else if (Embeddings.hasConsent()) {
        // Already consented — load silently in the background.
        // The model is cached locally so this is fast and never
        // freezes the UI.
        Embeddings.loadModelWithProgress().catch(() => {});
      }
    }

    renderTopTabs();
    bindTopTabs();
    bindSectionTabs();
    bindTrendingBtn();
    bindSourceFilter();
    bindViewToggle();
    syncViewToggleBtn();
    bindTranslate();
    bindSearch();
    bindFilterSort();
    bindFilterToggles();
    bindSettings();
    bindActivity();
    bindArticleClicks();
    bindFeedControls();
    bindTopDate();
    bindSourcesConfig();
    if (window.AnalyzeModal) AnalyzeModal.bindAll();
    if (window.PublishModal) PublishModal.bindAll();
    if (window.FilterModal) {
      FilterModal.setOnApply(() => {
        // When the user applies a filter, re-render the current
        // list. The filter state lives in the FilterModal module.
        const key = scopeKey();
        const cached = scopeCache[key];
        if (!cached) return;
        const articles = getFilteredArticles(currentSubcat, cached);
        renderTranslated(articles);
      });
      FilterModal.bindAll();
    }
    if (window.CategoriesModal) {
      // The modal calls this with a subcat id when the user
      // picks a category or a parliament item. Same identifier
      // scheme as the old tab strip ('all', 'politics', …,
      // 'parliament:<id>').
      CategoriesModal.setOnSelect(sub => selectCategory(sub));
      CategoriesModal.bindAll();
    }
    if (window.CustomSourcesModal) {
      CustomSourcesModal.bindAll();
    }
    if (currentSection === 'topics') {
      renderTopicsView();
    } else if (currentSection === 'conflicts') {
      renderConflictsView();
    } else {
      await renderContent();
    }

    // Start periodic auto-refresh — fetches silently in the background
    // every 5 minutes. The page never re-renders automatically; user clicks
    // the "show recent" icon to apply the fresh data.
    startAutoRefresh();
    window.addEventListener('beforeunload', stopAutoRefresh);


  }

  init();
})();
