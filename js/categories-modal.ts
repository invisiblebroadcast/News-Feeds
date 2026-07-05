/* ── Categories Modal ──
 *
 * Two-tab modal:
 *   1. News Feeds        — All + the existing news subcats
 *   2. Parliament Statements —
 *        On India scope: Lok Sabha, Rajya Sabha, every state's
 *        Vidhan Sabha, every state's Vidhan Parishad.
 *        On Global scope: 3 sub-views (Top 10–15, All countries,
 *        G7 + BRICS), each drillable into a country-grouped list.
 *
 * Click handling is intentionally direct (per-button .onclick
 * instead of document-level delegation) so that the user always
 * sees a click registered. The previous delegated version was
 * failing on some browsers because the modal's body content has
 * overflow:auto — clicks on a button partially under the scroll
 * edge were swallowed by the overflow container before reaching
 * the delegated handler in some environments. The direct-binding
 * approach below attaches the handler to the button itself, which
 * is always reachable.
 *
 * The modal is owned by CategoriesModal but driven by app.js.
 *   - app.js calls CategoriesModal.openModal() when the user
 *     clicks the ☰ button.
 *   - app.js calls CategoriesModal.setOnSelect(fn) to receive
 *     a subcat id when the user picks something.
 *   - app.js calls CategoriesModal.bindAll() once at startup to
 *     wire the tab switcher + close buttons (these never need
 *     to be re-bound because the tab/close markup is static).
 */
// We attach to window explicitly (rather than a top-level `const`)
// because app.js gates its call sites on `if (window.CategoriesModal)`.
// Top-level `const`/`let` declarations live in the global scope but
// are NOT properties of `window` in browsers, so without this the
// click handler silently no-ops and the category button shows
// nothing when the user taps it. Using `window.CategoriesModal`
// here makes the module reachable from both the bare name (in
// other modules loaded into the same global) and the `window.`
// form (used by app.js).
window.CategoriesModal = (() => {
  let activeTab = 'news';
  // Sub-view state for the parliament tab when on a non-India
  // scope. 'menu' shows the three list pickers; anything else
  // (e.g. 'top', 'all', 'g7-brics') shows that specific list.
  let parliamentSubView = 'menu';
  // Set by the app at startup. Receives a subcat id ('all',
  // 'politics', …, or 'parliament:<id>') when the user picks
  // something. The modal closes itself before/after the call.
  let onSelect = null;

  /* ── Lifecycle ──────────────────────────────────────────── */

  function openModal() {
    const modal = $('#categories-modal');
    if (!modal) return;
    // Always start on the News tab so re-opening the modal is
    // predictable.
    activeTab = 'news';
    parliamentSubView = 'menu';
    renderTabs();
    renderPanes();
    // Open via the shared app.js modal manager so the back-stack
    // + body.modal-open class are consistent with every other
    // modal in the app.
    if (window.appState && window.appState.openModal) {
      window.appState.openModal('categories', modal);
    } else {
      modal.classList.add('open');
      document.body.classList.add('modal-open');
    }
  }

  function closeModal() {
    if (window.appState && window.appState.closeModal) {
      window.appState.closeModal('categories');
    } else {
      const modal = $('#categories-modal');
      if (modal) modal.classList.remove('open');
      document.body.classList.remove('modal-open');
    }
  }

  function setOnSelect(fn) { onSelect = fn; }

  // Re-paint the panes. Called after a sub-view change (e.g. the
  // user clicked Top / All / G7+BRICS or the Back button) without
  // closing the modal.
  function renderPanes() {
    renderNewsPane();
    renderParliamentPane();
  }

  // Switch the active tab visually. The actual pane re-rendering
  // is already done at openModal time, so all we need to do here
  // is toggle the .active classes.
  function renderTabs() {
    $$('.cat-tab').forEach(btn => {
      const isActive = btn.dataset.catTab === activeTab;
      btn.classList.toggle('active', isActive);
      btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });
    $$('.cat-pane').forEach(pane => {
      const isActive =
        (pane.id === 'cat-pane-news' && activeTab === 'news') ||
        (pane.id === 'cat-pane-parliament' && activeTab === 'parliament');
      pane.classList.toggle('active', isActive);
    });
  }

  /* ── News tab ───────────────────────────────────────────── */

  function renderNewsPane() {
    const grid = $('#cat-news-grid');
    if (!grid) return;
    const scope = (window.appState && window.appState.currentScope) || 'nation';
    const subs = (window.FeedManager && FeedManager.subcategoriesForScope)
      ? FeedManager.subcategoriesForScope(scope)
      : ['all'];
    const currentSubcat = (window.appState && window.appState.currentSubcat) || 'all';
    const allActive = currentSubcat === 'all';

    // Build the HTML. Every button gets data-subcat so the
    // delegate-free click handler below can find the chosen
    // subcat without depending on the DOM structure.
    const parts = [];
    parts.push(
      '<button class="cat-pill cat-pill-all' + (allActive ? ' active' : '') +
      '" data-subcat="all" type="button">' +
        '<span class="cat-pill-icon">\uD83D\uDCCA</span>' +
        '<span class="cat-pill-label">All</span>' +
        '<span class="cat-pill-sub">Show every article in this scope</span>' +
      '</button>'
    );
    for (const s of subs) {
      if (s === 'all') continue;
      const isActive = currentSubcat === s;
      const icon = FeedManager.subcatIcon(s);
      const label = FeedManager.subcatLabel(s, scope);
      parts.push(
        '<button class="cat-pill' + (isActive ? ' active' : '') +
        '" data-subcat="' + escapeHtml(s) + '" type="button">' +
          '<span class="cat-pill-icon">' + icon + '</span>' +
          '<span class="cat-pill-label">' + escapeHtml(label) + '</span>' +
        '</button>'
      );
    }
    grid.innerHTML = parts.join('');

    // Direct .onclick binding — every button gets its own handler.
    // .onclick is fine here because the grid is rebuilt every
    // time the modal opens, so there's no risk of duplicate
    // listeners.
    Array.from(grid.querySelectorAll('.cat-pill[data-subcat]')).forEach(btn => {
      btn.onclick = function(ev) {
        ev.preventDefault();
        ev.stopPropagation();
        const subcat = this.getAttribute('data-subcat');
        pick(subcat);
      };
    });
  }

  /* ── Parliament tab ────────────────────────────────────── */

  function renderParliamentPane() {
    const content = $('#cat-parliament-content');
    if (!content) return;
    const scope = (window.appState && window.appState.currentScope) || 'nation';
    const nation = (window.appState && window.appState.currentNation) || 'india';

    let html;
    if (scope === 'nation' && nation === 'india') {
      html = renderIndiaParliament();
    } else if (parliamentSubView === 'menu') {
      html = renderInternationalMenu();
    } else {
      html = renderInternationalList(parliamentSubView);
    }
    content.innerHTML = html;

    // Bind the parliament pill clicks.
    Array.from(content.querySelectorAll('.cat-pill-parliament[data-parliament-id]')).forEach(btn => {
      btn.onclick = function(ev) {
        ev.preventDefault();
        ev.stopPropagation();
        if (this.disabled) return;
        const id = this.getAttribute('data-parliament-id');
        if (id) pick('parliament:' + id);
      };
    });

    // International list pickers (Top / All / G7+BRICS).
    Array.from(content.querySelectorAll('[data-intl-list]')).forEach(btn => {
      btn.onclick = function(ev) {
        ev.preventDefault();
        ev.stopPropagation();
        parliamentSubView = this.getAttribute('data-intl-list');
        renderParliamentPane();
      };
    });

    // "Back to lists" button shown when drilled into a list.
    const back = content.querySelector('#cat-back-btn');
    if (back) {
      back.onclick = function(ev) {
        ev.preventDefault();
        ev.stopPropagation();
        parliamentSubView = 'menu';
        renderParliamentPane();
      };
    }
  }

  function renderIndiaParliament() {
    const pf = (window.FeedManager && FeedManager.getParliamentFeeds)
      ? FeedManager.getParliamentFeeds() : null;
    if (!pf || !pf.india) {
      return '<p class="cat-empty">No parliament data available.</p>';
    }
    const out = [];
    out.push('<section class="cat-parliament-section">' +
      '<h3 class="cat-parliament-title">Central Parliament</h3>' +
      renderParliamentGrid(pf.india.central || []) +
    '</section>');
    const vs = pf.india['vidhan-sabha'] || [];
    if (vs.length) {
      out.push('<section class="cat-parliament-section">' +
        '<h3 class="cat-parliament-title">Vidhan Sabha <span class="cat-parliament-sub">(State Legislative Assemblies)</span></h3>' +
        renderParliamentGrid(vs) +
      '</section>');
    }
    const vp = pf.india['vidhan-parishad'] || [];
    if (vp.length) {
      out.push('<section class="cat-parliament-section">' +
        '<h3 class="cat-parliament-title">Vidhan Parishad <span class="cat-parliament-sub">(State Legislative Councils — 6 states)</span></h3>' +
        renderParliamentGrid(vp) +
      '</section>');
    }
    return out.join('');
  }

  function renderInternationalMenu() {
    const cards = [
      { id: 'top',     title: 'Top 10\u201315 Major Parliaments', sub: 'A curated set of the world\u2019s most active legislatures (US, UK, EU, BRICS, etc.)' },
      { id: 'all',     title: 'All Countries',                    sub: 'A flat list of ~60 parliaments from every continent' },
      { id: 'g7-brics',title: 'G7 + BRICS',                       sub: 'The G7 industrialised democracies plus the BRICS emerging economies' }
    ];
    return '<div class="cat-intl-menu">' +
      cards.map(c =>
        '<button class="cat-intl-card" data-intl-list="' + escapeHtml(c.id) + '" type="button">' +
          '<span class="cat-intl-card-title">' + escapeHtml(c.title) + '</span>' +
          '<span class="cat-intl-card-sub">' + escapeHtml(c.sub) + '</span>' +
          '<span class="cat-intl-card-arrow">\u2192</span>' +
        '</button>'
      ).join('') +
    '</div>';
  }

  function renderInternationalList(key) {
    const pf = (window.FeedManager && FeedManager.getParliamentFeeds)
      ? FeedManager.getParliamentFeeds() : null;
    const list = (pf && pf.international && pf.international[key]) || [];
    if (!list.length) return '<p class="cat-empty">No feeds in this list.</p>';
    const byCountry = {};
    for (const item of list) {
      const c = item.country || 'Other';
      if (!byCountry[c]) byCountry[c] = [];
      byCountry[c].push(item);
    }
    const countries = Object.keys(byCountry).sort((a, b) => a.localeCompare(b));
    return '<button class="cat-back-btn" id="cat-back-btn" type="button">' +
             '<span>\u2190</span> Back to lists' +
           '</button>' +
      countries.map(c =>
        '<section class="cat-parliament-section">' +
          '<h3 class="cat-parliament-title">' + escapeHtml(c) + '</h3>' +
          renderParliamentGrid(byCountry[c]) +
        '</section>'
      ).join('');
  }

  function renderParliamentGrid(items) {
    if (!items.length) return '<p class="cat-empty">No items.</p>';
    const activeSubcat = (window.appState && window.appState.currentSubcat) || '';
    const activeId = activeSubcat.indexOf('parliament:') === 0
      ? activeSubcat.slice('parliament:'.length) : '';
    return '<div class="cat-parliament-grid">' +
      items.map(item => {
        const hasFeed = !!item.url;
        let cls = 'cat-pill cat-pill-parliament';
        if (!hasFeed) cls += ' cat-pill-disabled';
        if (item.id === activeId) cls += ' active';
        // India parliament items in feeds.json only carry {id, state, url}
        // (no `name` field); international items carry {id, name, country, url}.
        // Derive a readable name for the India case so the pill doesn't
        // render as literal "undefined — Andhra Pradesh".
        const derivedName = item.name
          || (item.state
            ? item.state + (item.id && item.id.indexOf('vidhan-parishad') >= 0
                ? ' Vidhan Parishad'
                : ' Vidhan Sabha')
            : item.id);
        const label = escapeHtml(derivedName) +
          (item.state || item.country
            ? ' <span class="cat-pill-sub">\u2014 ' + escapeHtml(item.state || item.country) + '</span>'
            : '');
        return '<button class="' + cls + '"' +
          (hasFeed ? ' data-parliament-id="' + escapeHtml(item.id) + '"' : ' disabled') +
          ' type="button">' +
            '<span class="cat-pill-icon">\uD83C\uDFDB\uFE0F;</span>' +
            '<span class="cat-pill-label">' + label + '</span>' +
            (hasFeed ? '' : '<span class="cat-pill-sub">No RSS feed available</span>') +
          '</button>';
      }).join('') +
    '</div>';
  }

  /* ── Pick → callback → close ────────────────────────────── */

  function pick(subcat) {
    if (!subcat) return;
    if (typeof onSelect === 'function') {
      try {
        onSelect(subcat);
      } catch (err) {
        console.error('[CategoriesModal] onSelect threw:', err);
      }
    } else {
      console.warn('[CategoriesModal] pick() called but onSelect is not set; subcat=' + subcat);
    }
    closeModal();
  }

  /* ── Wiring (one-time, at startup) ─────────────────────── */

  function bindAll() {
    // Tab switcher.
    const tabBar = $('#cat-tabs');
    if (tabBar) {
      tabBar.onclick = function(ev) {
        const tab = ev.target.closest('.cat-tab');
        if (!tab) return;
        const key = tab.dataset.catTab;
        if (key === activeTab) return;
        activeTab = key;
        renderTabs();
      };
    }
    // X close button.
    const xBtn = $('#categories-modal-close');
    if (xBtn) xBtn.onclick = closeModal;
    // Click on the dimmed overlay (outside the modal body) closes.
    const overlay = $('#categories-modal');
    if (overlay) {
      overlay.onclick = function(ev) {
        if (ev.target === overlay) closeModal();
      };
    }
  }

  /* ── Helpers ────────────────────────────────────────────── */
  function $(s, c) { return (c || document).querySelector(s); }
  function $$(s, c) { return [...(c || document).querySelectorAll(s)]; }
  function escapeHtml(s) {
    return (s == null ? '' : String(s))
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  return {
    openModal, closeModal, bindAll, setOnSelect, renderPanes
  };
})();
