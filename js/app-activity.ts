// @ts-nocheck
(async () => {
  const $ = (sel, ctx) => (ctx || document).querySelector(sel);
  const $$ = (sel, ctx) => [...(ctx || document).querySelectorAll(sel)];

  let currentTab = 'history';
  let articleData = {};

  function init() {
    loadArticleData();
    bindTabs();
    renderTab(currentTab);
    bindAuth();
  }

  function loadArticleData() {
    try {
      const raw = localStorage.getItem('newsfeeds_article_data_cache') ||
                   localStorage.getItem('newsfeeds_article_data_supa') ||
                   '{}';
      articleData = JSON.parse(raw);
    } catch {
      articleData = {};
    }
  }

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

  function bindTabs() {
    const container = $('.activity-tabs');
    if (!container) return;
    container.addEventListener('click', e => {
      const tab = e.target.closest('.activity-tab');
      if (!tab) return;
      currentTab = tab.dataset.actab;
      $$('.activity-tab').forEach(t => t.classList.toggle('active', t === tab));
      renderTab(currentTab);
    });
  }

  function renderTab(tab) {
    const content = $('#activity-content');
    if (!content) return;
    switch (tab) {
      case 'history': renderHistory(content); break;
      case 'liked': renderFiltered(content, 'like', true); break;
      case 'disliked': renderFiltered(content, 'dislike', true); break;
      case 'flagged': renderFlagged(content); break;
      case 'failed': renderFailedSources(content); break;
    }
  }

  function renderHistory(content) {
    const items = Object.entries(articleData)
      .filter(([_, d]) => d.viewed)
      .sort((a, b) => (b[1].viewed || 0) - (a[1].viewed || 0))
      .slice(0, 200);
    if (!items.length) {
      content.innerHTML = '<div class="activity-empty">No reading history yet.</div>';
      return;
    }
    content.innerHTML = '<div class="activity-list">' + items.map(([url, d]) =>
      '<div class="activity-item" data-url="' + url.replace(/"/g, '&quot;') + '">' +
        '<div style="flex:1;min-width:0">' +
          '<div class="ai-title">' + (d.articleTitle || url) + '</div>' +
          (d.articleSource ? '<div class="ai-source">' + d.articleSource + '</div>' : '') +
        '</div>' +
        '<div class="ai-meta">' +
          '<span>' + formatDateShort(d.viewed) + '</span>' +
        '</div>' +
      '</div>'
    ).join('') + '</div>';
    content.querySelectorAll('.activity-item').forEach(item => {
      item.addEventListener('click', () => {
        const url = decodeURIComponent(item.dataset.url);
        if (url) window.open(url, '_blank');
      });
    });
  }

  function renderFiltered(content, field, value) {
    const items = Object.entries(articleData)
      .filter(([_, d]) => d[field] === value)
      .sort((a, b) => {
        const ta = a[1].viewed || 0;
        const tb = b[1].viewed || 0;
        return tb - ta;
      });
    if (!items.length) {
      content.innerHTML = '<div class="activity-empty">No ' + field + 'd articles yet.</div>';
      return;
    }
    content.innerHTML = '<div class="activity-list">' + items.map(([url, d]) =>
      '<div class="activity-item" data-url="' + url.replace(/"/g, '&quot;') + '">' +
        '<div style="flex:1;min-width:0">' +
          '<div class="ai-title">' + (d.articleTitle || url) + '</div>' +
          (d.articleSource ? '<div class="ai-source">' + d.articleSource + '</div>' : '') +
        '</div>' +
        '<div class="ai-meta">' +
          (d.viewed ? '<span>' + formatDateShort(d.viewed) + '</span>' : '') +
        '</div>' +
      '</div>'
    ).join('') + '</div>';
    content.querySelectorAll('.activity-item').forEach(item => {
      item.addEventListener('click', () => {
        const url = decodeURIComponent(item.dataset.url);
        if (url) window.open(url, '_blank');
      });
    });
  }

  function renderFlagged(content) {
    const items = Object.entries(articleData)
      .filter(([_, d]) => d.flag)
      .sort((a, b) => {
        const ta = a[1].viewed || 0;
        const tb = b[1].viewed || 0;
        return tb - ta;
      });
    if (!items.length) {
      content.innerHTML = '<div class="activity-empty">No flagged articles yet.</div>';
      return;
    }
    content.innerHTML = '<div class="activity-list">' + items.map(([url, d]) =>
      '<div class="activity-item" data-url="' + url.replace(/"/g, '&quot;') + '">' +
        '<div style="flex:1;min-width:0">' +
          '<div class="ai-title">' + (d.articleTitle || url) + '</div>' +
          (d.articleSource ? '<div class="ai-source">' + d.articleSource + '</div>' : '') +
        '</div>' +
        '<div class="ai-meta">' +
          '<span class="ai-badge" style="background:' + (window.FLAG_COLORS?.[d.flag] || 'var(--text-tertiary)') + ';color:#fff;">' + d.flag + '</span>' +
          (d.viewed ? '<span>' + formatDateShort(d.viewed) + '</span>' : '') +
        '</div>' +
      '</div>'
    ).join('') + '</div>';
    content.querySelectorAll('.activity-item').forEach(item => {
      item.addEventListener('click', () => {
        const url = decodeURIComponent(item.dataset.url);
        if (url) window.open(url, '_blank');
      });
    });
  }

  function renderFailedSources(content) {
    if (!window.SourceHealth) {
      content.innerHTML = '<div class="activity-empty">Source Health module not available.</div>';
      return;
    }
    const all = SourceHealth.getAll();
    const entries = Object.entries(all);
    if (!entries.length) {
      content.innerHTML = '<div class="activity-empty">No failed sources tracked yet.</div>';
      return;
    }
    const disabled = SourceHealth.getDisabled();
    const disabledSet = new Set(disabled);
    content.innerHTML = entries.map(([url, info]) => {
      const isDisabled = disabledSet.has(url);
      return '<div class="failed-item' + (isDisabled ? ' failed-item-disabled' : '') + '">' +
        '<div class="failed-row-main">' +
          '<div class="failed-title">' +
            '<span>' + (info.name || url) + '</span>' +
            (isDisabled ? '<span class="failed-disabled-pill">Disabled</span>' : '') +
            '<span class="failed-count-pill">' + (info.failures || 0) + ' failure' + (info.failures !== 1 ? 's' : '') + '</span>' +
          '</div>' +
          '<div class="failed-url">' + url + '</div>' +
          (info.lastError ? '<div class="failed-error">' + info.lastError + '</div>' : '') +
        '</div>' +
        '<div class="failed-actions">' +
          (isDisabled ? '<button class="btn btn-ghost failed-reenable-btn" data-url="' + url.replace(/"/g, '&quot;') + '">Re-enable</button>' : '') +
        '</div>' +
      '</div>';
    }).join('');
    content.querySelectorAll('.failed-reenable-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        SourceHealth.enable(btn.dataset.url);
        renderTab('failed');
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
