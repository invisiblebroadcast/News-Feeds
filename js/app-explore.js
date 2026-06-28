(async () => {
  const $ = (sel, ctx) => (ctx || document).querySelector(sel);
  const $$ = (sel, ctx) => [...(ctx || document).querySelectorAll(sel)];

  const CATEGORIES = [
    { id: 'all', label: 'All', icon: '\uD83D\uDCCA' },
    { id: 'politics', label: 'Politics & Governance', icon: '\uD83C\uDFDB\uFE0F' },
    { id: 'business', label: 'Business & Economy', icon: '\uD83D\uDCC8' },
    { id: 'technology', label: 'Technology & Innovation', icon: '\uD83D\uDCBB' },
    { id: 'science', label: 'Science & Research', icon: '\uD83D\uDD2C' },
    { id: 'health', label: 'Health & Medicine', icon: '\u2764\uFE0F' },
    { id: 'sports', label: 'Sports & Athletics', icon: '\u26BD' },
    { id: 'entertainment', label: 'Culture & Entertainment', icon: '\uD83C\uDFAC' },
    { id: 'environment', label: 'Environment & Climate', icon: '\uD83C\uDF31' },
    { id: 'education', label: 'Education & Academia', icon: '\uD83C\uDF93' }
  ];

  let currentScope = AppState ? (AppState.get('currentScope') || 'global') : 'global';
  let currentNation = AppState ? (AppState.get('currentNation') || 'india') : 'india';

  function init() {
    renderScopeTabs();
    renderCategories();
    renderParliament();
    bindAuth();
  }

  function renderScopeTabs() {
    const container = document.querySelector('.page-header');
    if (!container) return;
    const existing = document.getElementById('explore-scope-tabs');
    if (existing) existing.remove();
    const tabs = document.createElement('div');
    tabs.id = 'explore-scope-tabs';
    tabs.style.cssText = 'display:flex;gap:8px;margin:12px 0 16px;';
    tabs.innerHTML =
      '<button class="btn btn-sm' + (currentScope === 'global' ? ' btn-primary' : ' btn-ghost') + '" data-explore-scope="global">Global</button>' +
      '<button class="btn btn-sm' + (currentScope === 'nation' ? ' btn-primary' : ' btn-ghost') + '" data-explore-scope="nation" data-explore-nation="india">India</button>';
    tabs.addEventListener('click', e => {
      const btn = e.target.closest('[data-explore-scope]');
      if (!btn) return;
      const scope = btn.dataset.exploreScope;
      const nation = btn.dataset.exploreNation || 'india';
      currentScope = scope;
      currentNation = nation;
      if (AppState) {
        AppState.set('currentScope', scope);
        AppState.set('currentNation', nation);
      }
      renderScopeTabs();
      renderCategories();
      renderSourcesBrowser();
    });
    container.after(tabs);
  }

  function renderCategories() {
    const grid = $('#explore-categories-grid');
    if (!grid) return;
    const scopeParam = currentScope === 'global' ? '' : '&scope=nation&nation=' + currentNation;
    grid.innerHTML = CATEGORIES.map(c =>
      '<a href="index.html?subcat=' + c.id + scopeParam + '" class="category-card">' +
        '<span class="cat-icon">' + c.icon + '</span>' +
        '<span class="cat-name">' + c.label + '</span>' +
      '</a>'
    ).join('');
  }

  function renderParliament() {
    const container = $('#explore-parliament');
    if (!container) return;
    if (!window.FeedManager) {
      container.innerHTML = '<p style="color:var(--text-tertiary);font-size:0.9rem;">Load feeds to see parliament sources.</p>';
      return;
    }

    FeedManager.load().then(() => {
      const pf = FeedManager.getParliamentFeeds();
      if (!pf) {
        container.innerHTML = '<p style="color:var(--text-tertiary);font-size:0.9rem;">No parliament feeds available.</p>';
        return;
      }

      let html = '';

      if (currentScope === 'nation') {
        // India Central
        if (pf.india?.central?.length) {
          html += '<div class="parliament-group"><h3>India — Central</h3><div class="parliament-grid">';
          for (const item of pf.india.central) {
            const hasUrl = !!item.url;
            html += '<div class="parliament-item' + (hasUrl ? '' : ' disabled') + '"' +
              (hasUrl ? ' data-feed-id="' + item.id + '"' : '') + '>' +
              '<span class="pi-name">' + item.name + '</span>' +
              (hasUrl ? '<span class="pi-badge">RSS</span>' : '<span class="pi-badge" style="color:var(--accent);">No RSS</span>') +
            '</div>';
          }
          html += '</div></div>';
        }

        // India Vidhan Sabha
        if (pf.india?.['vidhan-sabha']?.length) {
          html += '<div class="parliament-group"><h3>India — Vidhan Sabha (States)</h3><div class="parliament-grid">';
          for (const item of pf.india['vidhan-sabha']) {
            const hasUrl = !!item.url;
            html += '<div class="parliament-item' + (hasUrl ? '' : ' disabled') + '"' +
              (hasUrl ? ' data-feed-id="' + item.id + '"' : '') + '>' +
              '<span class="pi-name">' + item.name + (item.state ? ' — ' + item.state : '') + '</span>' +
              (hasUrl ? '<span class="pi-badge">RSS</span>' : '<span class="pi-badge" style="color:var(--accent);">No RSS</span>') +
            '</div>';
          }
          html += '</div></div>';
        }
      } else {
        // International
        if (pf.international?.top?.length) {
          html += '<div class="parliament-group"><h3>International</h3><div class="parliament-grid">';
          for (const item of pf.international.top) {
            const hasUrl = !!item.url;
            html += '<div class="parliament-item' + (hasUrl ? '' : ' disabled') + '"' +
              (hasUrl ? ' data-feed-id="' + item.id + '"' : '') + '>' +
              '<span class="pi-name">' + item.name + (item.country ? ' — ' + item.country : '') + '</span>' +
              (hasUrl ? '<span class="pi-badge">RSS</span>' : '<span class="pi-badge" style="color:var(--accent);">No RSS</span>') +
            '</div>';
          }
          html += '</div></div>';
        }
      }

      if (!html) {
        container.innerHTML = '<p style="color:var(--text-tertiary);font-size:0.9rem;">No parliament feeds available for this scope.</p>';
        return;
      }
      container.innerHTML = html;

      // Wire click to navigate home with parliament subcat
      container.querySelectorAll('.parliament-item[data-feed-id]').forEach(item => {
        item.addEventListener('click', () => {
          const id = item.dataset.feedId;
          AppState.set('currentScope', 'nation');
          AppState.set('currentNation', 'india');
          AppState.set('currentSubcat', 'parliament:' + id);
          window.location.href = 'index.html?subcat=parliament:' + id;
        });
      });
    });
  }

  function bindAuth() {
    const authBtn = $('#auth-btn');
    if (authBtn) {
      authBtn.addEventListener('click', () => {
        const modal = $('#auth-modal');
        if (modal) modal.classList.add('open');
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
