(async () => {
  const $ = (sel, ctx) => (ctx || document).querySelector(sel);
  const $$ = (sel, ctx) => [...(ctx || document).querySelectorAll(sel)];

  function init() {
    renderBookmarks();
    bindAuth();
  }

  function getArticleData(link) {
    try {
      const raw = localStorage.getItem('newsfeeds_article_data_cache') ||
                   localStorage.getItem('newsfeeds_article_data_supa') ||
                   '{}';
      const data = JSON.parse(raw);
      return data[link] || {};
    } catch { return {}; }
  }

  function saveArticleData(link, data) {
    try {
      const key = 'newsfeeds_article_data_cache';
      const raw = localStorage.getItem(key) || '{}';
      const all = JSON.parse(raw);
      if (data.flag || data.note || data.like || data.dislike || data.viewed) {
        all[link] = { ...(all[link] || {}), ...data };
      } else {
        delete all[link];
      }
      localStorage.setItem(key, JSON.stringify(all));
    } catch (e) {
      console.warn('Bookmarks: saveArticleData failed', e);
    }
  }

  function getFlagColor(flag) {
    const colors = {
      save: '#6e7681',
      investigative: '#d29922',
      favorite: '#f778ba',
      important: '#58a6ff',
      urgent: '#ff2929'
    };
    return colors[flag] || '#6e7681';
  }

  function formatDateShort(d) {
    if (!d) return '';
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

  function renderBookmarks() {
    const grid = $('#bookmarks-grid');
    if (!grid) return;

    try {
      const raw = localStorage.getItem('newsfeeds_article_data_cache') ||
                   localStorage.getItem('newsfeeds_article_data_supa') ||
                   '{}';
      const data = JSON.parse(raw);
      const saved = Object.entries(data).filter(([_, d]) => d.flag === 'save');

      if (!saved.length) {
        grid.innerHTML = '<div class="empty-state-page">' +
          '<div class="esp-icon">&#x1F516;</div>' +
          '<h3>No saved articles</h3>' +
          '<p>Articles you save for later will appear here. Look for the bookmark icon on any article card.</p>' +
        '</div>';
        return;
      }

      grid.innerHTML = saved.map(([url, d]) =>
        '<article class="article-card" data-url="' + url.replace(/"/g, '&quot;') + '">' +
          '<div class="article-body">' +
            '<h3 class="article-title">' +
              '<span class="article-link">' + (d.articleTitle || 'Untitled') + '</span>' +
            '</h3>' +
            '<div class="article-meta">' +
              (d.articleSource ? '<span class="source">' + d.articleSource + '</span>' : '') +
              '<span class="date">' + formatDateShort(d.viewed) + '</span>' +
              '<span class="flag-badge" style="background:' + getFlagColor('save') + '">save</span>' +
            '</div>' +
            '<div class="card-actions">' +
              '<button class="card-action-btn bookmark-remove-btn" title="Remove bookmark">' +
                '<span>&#x2B50;</span><span>Remove</span>' +
              '</button>' +
            '</div>' +
          '</div>' +
        '</article>'
      ).join('');

      grid.querySelectorAll('.article-card').forEach(card => {
        card.addEventListener('click', e => {
          if (e.target.closest('.bookmark-remove-btn')) return;
          const url = decodeURIComponent(card.dataset.url);
          if (url) window.open(url, '_blank');
        });
      });

      grid.querySelectorAll('.bookmark-remove-btn').forEach(btn => {
        btn.addEventListener('click', e => {
          e.stopPropagation();
          const card = e.target.closest('.article-card');
          if (!card) return;
          const url = decodeURIComponent(card.dataset.url);
          const ad = getArticleData(url);
          ad.flag = '';
          saveArticleData(url, ad);
          card.remove();
          if (!grid.querySelector('.article-card')) {
            grid.innerHTML = '<div class="empty-state-page">' +
              '<div class="esp-icon">&#x1F516;</div>' +
              '<h3>No saved articles</h3>' +
              '<p>All bookmarks removed.</p>' +
            '</div>';
          }
        });
      });
    } catch {
      grid.innerHTML = '<div class="empty-state-page"><div class="esp-icon">&#x26A0;&#xFE0F;</div><h3>Could not load bookmarks</h3></div>';
    }
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
