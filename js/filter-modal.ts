// @ts-nocheck
/* ── Filter Modal ──
 *
 * Replaces the simple "All Sources" dropdown with a full filter
 * modal containing:
 *   - Date range (start / end date pickers; blank = no filter)
 *   - Source list (checkbox per source; click anywhere on a row
 *     to toggle the checkbox)
 *
 * The source list is scope-aware: in the India tab, only India
 * sources are shown; in the Global tab, only Global sources. The
 * list comes from the full feeds.json database, not just the
 * currently subscribed ones, so the user can see sources they
 * could enable. Already-enabled sources are pre-selected.
 *
 * Filter state is kept in a `currentFilter` object that includes
 * the date range and a Set of source names. The Set is applied
 * to the article pool by `applyFilterToArticles` in app.js.
 */
const FilterModal = (() => {
  // Current filter state (live as the user adjusts the modal).
  const currentFilter = {
    date_start: '',
    date_end: '',
    sources: new Set() // empty = no source filter
  };

  function openFilterModal() {
    const modal = $('#filter-modal');
    if (!modal) return;
    renderSourceList();
    // Pre-fill the date inputs from the current filter state.
    const ds = $('#filter-date-start');
    const de = $('#filter-date-end');
    if (ds) ds.value = currentFilter.date_start;
    if (de) de.value = currentFilter.date_end;
    // Update the active-count badge in the header so the user can
    // see what's currently applied even before reopening the modal.
    updateActiveCount();
    openModal('filter', modal);
  }

  function closeFilterModal() {
    closeModal('filter');
  }

  function updateActiveCount() {
    const el = $('#filter-active-count');
    if (!el) return;
    const n = currentFilter.sources.size;
    if (n === 0 && !currentFilter.date_start && !currentFilter.date_end) {
      el.textContent = 'All sources';
    } else {
      const parts = [];
      if (n > 0) parts.push(n + ' source' + (n === 1 ? '' : 's'));
      if (currentFilter.date_start || currentFilter.date_end) parts.push('date');
      el.textContent = parts.join(' + ');
    }
  }

  // Build the source list. We pull from the full feeds database
  // and group by scope (India / Global). Only the scope matching
  // the user's current view is rendered, so an India-tab user
  // sees only India sources and vice versa.
  function renderSourceList() {
    const list = $('#filter-source-list');
    if (!list) return;
    // Determine the current scope. The app exposes currentScope on
    // window.appState; we fall back to 'nation' as the most
    // common default.
    const scope = (window.appState && window.appState.currentScope) || 'nation';
    const isIndia = scope === 'nation';
    // Update the scope-hint label.
    const hint = $('#filter-scope-hint');
    if (hint) hint.textContent = '(showing ' + (isIndia ? 'India' : 'Global') + ' sources)';
    // Pull all feeds from the database. The FeedManager is the
    // canonical source of truth — it already loaded feeds.json.
    const allFeeds = (window.FeedManager && typeof FeedManager.getSubscribableFeeds === 'function')
      ? FeedManager.getSubscribableFeeds()
      : [];
    const subscribed = (window.FeedManager && typeof FeedManager.getSubscribedFeeds === 'function')
      ? new Set(FeedManager.getSubscribedFeeds())
      : new Set();
    // Filter by scope. "Global" feeds are scope='global';
    // "India" feeds are scope='nation' with nation='india'.
    const scoped = allFeeds.filter(f => {
      if (!f || !f.name || !f.hasRss) return false;
      if (isIndia) return f.scope === 'nation' && (!f.nation || f.nation === 'india');
      return f.scope === 'global';
    });
    if (!scoped.length) {
      list.innerHTML = '<div class="filter-empty">No sources available for this scope.</div>';
      return;
    }
    // Pre-populate the source Set with the currently subscribed
    // sources on first open. Subsequent opens preserve the user's
    // manual deselections.
    if (currentFilter.sources.size === 0) {
      for (const f of scoped) {
        if (subscribed.has(f.url)) currentFilter.sources.add(f.name);
      }
    }
    // Sort by name for stable display.
    scoped.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    list.innerHTML = scoped.map(f => {
      const checked = currentFilter.sources.has(f.name);
      const region = f.region ? '<span class="filter-source-region">' + escapeHtml(f.region) + '</span>' : '';
      return '<label class="filter-source-row" data-name="' + escAttr(f.name) + '">' +
        '<input type="checkbox" class="filter-source-cb"' + (checked ? ' checked' : '') + '>' +
        '<span class="filter-source-name">' + escapeHtml(f.name) + '</span>' +
        region +
      '</label>';
    }).join('');
    // Bind row clicks. A click anywhere on the row toggles the
    // checkbox; the checkbox itself is purely visual.
    list.querySelectorAll('.filter-source-row').forEach(row => {
      row.addEventListener('click', (e) => {
        // Prevent double-toggle when clicking directly on the
        // checkbox (the native click already toggled it).
        if (e.target.tagName === 'INPUT') {
          // Native toggle already happened — sync the state below.
        } else {
          const cb = row.querySelector('input');
          if (cb) cb.checked = !cb.checked;
        }
        const cb = row.querySelector('input');
        const name = row.dataset.name;
        if (!name) return;
        if (cb.checked) currentFilter.sources.add(name);
        else currentFilter.sources.delete(name);
        e.preventDefault();
      });
    });
  }

  // Apply: read inputs, write to currentFilter, close, trigger
  // re-render. The re-render is initiated by the caller (app.js)
  // through a callback we install at bind time.
  let onApply = null;
  function applyAndClose() {
    const ds = $('#filter-date-start');
    const de = $('#filter-date-end');
    currentFilter.date_start = ds ? ds.value : '';
    currentFilter.date_end = de ? de.value : '';
    updateActiveCount();
    closeFilterModal();
    if (typeof onApply === 'function') onApply(currentFilter);
  }
  function resetFilter() {
    currentFilter.date_start = '';
    currentFilter.date_end = '';
    currentFilter.sources = new Set();
    // Re-render to clear checkboxes.
    renderSourceList();
    const ds = $('#filter-date-start');
    const de = $('#filter-date-end');
    if (ds) ds.value = '';
    if (de) de.value = '';
    updateActiveCount();
    if (typeof onApply === 'function') onApply(currentFilter);
  }
  function selectAll() {
    list.querySelectorAll('.filter-source-cb').forEach(cb => {
      cb.checked = true;
      const row = cb.closest('.filter-source-row');
      if (row) currentFilter.sources.add(row.dataset.name);
    });
  }
  function selectNone() {
    list.querySelectorAll('.filter-source-cb').forEach(cb => {
      cb.checked = false;
      const row = cb.closest('.filter-source-row');
      if (row) currentFilter.sources.delete(row.dataset.name);
    });
  }

  function bindAll() {
    const open = $('#filter-modal-btn');
    if (open) open.addEventListener('click', openFilterModal);
    const close = $('#filter-modal-close');
    if (close) close.addEventListener('click', closeFilterModal);
    const cancel = $('#filter-modal-cancel');
    if (cancel) cancel.addEventListener('click', closeFilterModal);
    const apply = $('#filter-modal-apply');
    if (apply) apply.addEventListener('click', applyAndClose);
    const reset = $('#filter-modal-reset');
    if (reset) reset.addEventListener('click', resetFilter);
    const sa = $('#filter-select-all');
    if (sa) sa.addEventListener('click', selectAll);
    const sn = $('#filter-select-none');
    if (sn) sn.addEventListener('click', selectNone);
    // Click outside closes
    const modal = $('#filter-modal');
    if (modal) modal.addEventListener('click', e => {
      if (e.target === modal) closeFilterModal();
    });
  }

  function setOnApply(fn) { onApply = fn; }
  function getFilter() { return currentFilter; }

  // Helpers (duplicated for self-containment).
  // app.js's $ / $$ are local to its own IIFE, so they're not
  // visible here. Define our own — the original bindAll() crashed
  // with "ReferenceError: $ is not defined" the moment app.js
  // called FilterModal.bindAll() during init().
  function $(s, c) { return (c || document).querySelector(s); }
  function $$(s, c) { return [...(c || document).querySelectorAll(s)]; }
  function escapeHtml(s) { return (s == null ? '' : String(s)).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function escAttr(s) { return (s == null ? '' : String(s)).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

  return {
    openFilterModal,
    closeFilterModal,
    bindAll,
    setOnApply,
    getFilter,
    updateActiveCount
  };
})();

// Expose on window — see js/feeds.js for the rationale.
window.FilterModal = FilterModal;
