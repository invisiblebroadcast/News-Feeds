(async () => {
  const $ = (sel, ctx) => (ctx || document).querySelector(sel);
  console.log('[NewsFeeds] App version: ' + (typeof APP_VERSION !== 'undefined' ? APP_VERSION : '?'));

  function init() {
    populateLanguage();
    renderSubscriptions();
    bindFeedHealth();
    bindCustomFeeds();
    bindNitter();
    bindSourcesConfig();
    bindAuth();
    showNitterHint();
    bindHardRefresh();
  }

  function populateLanguage() {
    const sel = $('#settings-language');
    if (!sel) return;
    const lang = Settings.get('language') || 'en';
    sel.value = lang;
    sel.addEventListener('change', () => {
      Settings.set('language', sel.value);
      AppState.set('language', sel.value);
    });
  }

  function renderSubscriptions() {
    const list = $('#subscription-list');
    if (!list) return;
    FeedManager.load().then(() => {
      const subs = FeedManager.getSubscribedFeeds();
      const all = FeedManager.getSubscribableFeeds();
      const byRegion = {};
      for (const f of all) {
        const region = f.region || f.nation || 'other';
        if (!byRegion[region]) byRegion[region] = [];
        byRegion[region].push(f);
      }
      let html = '';
      for (const [region, feeds] of Object.entries(byRegion)) {
        html += '<div class="sub-region"><div class="sub-region-title">' + region + '</div>';
        for (const f of feeds) {
          const checked = subs.includes(f.url) ? ' checked' : '';
          const cls = f.url ? '' : ' sub-no-rss';
          html += '<label class="sub-item' + cls + '">' +
            (f.url ? '<input type="checkbox" class="sub-checkbox" value="' + f.url.replace(/"/g, '&quot;') + '"' + checked + '>' : '') +
            '<span class="sub-name">' + f.name + '</span>' +
            (f.lang ? '<span class="sub-lang">' + f.lang + '</span>' : '') +
            (f.url ? '' : '<span class="sub-no-badge">No RSS</span>') +
          '</label>';
        }
        html += '</div>';
      }
      list.innerHTML = html;
      list.querySelectorAll('.sub-checkbox').forEach(cb => {
        cb.addEventListener('change', () => {
          const subs = FeedManager.toggleSubscription(cb.value);
          cb.checked = subs.includes(cb.value);
        });
      });
    });
  }

  function bindFeedHealth() {
    const toggle = $('#auto-disable-failing-sources');
    const count = $('#feed-health-count');
    const reenable = $('#reenable-all-btn');
    if (toggle) {
      toggle.checked = Settings.get('autoDisableFailingSources') === true;
      toggle.addEventListener('change', () => {
        Settings.set('autoDisableFailingSources', toggle.checked);
      });
    }
    if (window.SourceHealth) {
      const updateHealth = () => {
        const data = SourceHealth.getAll();
        const disabled = SourceHealth.getDisabled();
        const total = Object.keys(data).length;
        if (count) {
          if (total === 0) {
            count.innerHTML = '<span class="feed-health-count-empty">No failing sources tracked yet.</span>';
          } else {
            count.innerHTML = '<strong>' + disabled.length + '</strong> of <strong>' + total + '</strong> sources disabled.';
          }
        }
        if (reenable) {
          reenable.disabled = disabled.length === 0;
          reenable.onclick = () => {
            SourceHealth.resetAll();
            updateHealth();
          };
        }
      };
      updateHealth();
    }
  }

  function bindCustomFeeds() {
    const urlInput = $('#feed-url-input');
    const nameInput = $('#feed-name-input');
    const scopeSelect = $('#feed-scope-select');
    const nationSelect = $('#feed-nation-select');
    const subcatSelect = $('#feed-subcat-select');
    const validateBtn = $('#feed-validate-btn');
    const addBtn = $('#feed-add-btn');
    const msg = $('#feed-validate-msg');
    const list = $('#feed-custom-list');

    FeedManager.load().then(() => {
      const nations = FeedManager.getNations();
      if (nationSelect) {
        nationSelect.innerHTML = Object.entries(nations).map(([k, v]) => '<option value="' + k + '">' + v + '</option>').join('');
      }
      const cats = FeedManager.subcategories();
      if (subcatSelect) {
        subcatSelect.innerHTML = cats.map(c => '<option value="' + c + '">' + c + '</option>').join('');
      }
      renderCustomList();
    });

    if (validateBtn) {
      validateBtn.addEventListener('click', async () => {
        const url = urlInput ? urlInput.value.trim() : '';
        if (!url) { msg.className = 'feed-validate-msg error'; msg.textContent = 'Please enter a URL.'; return; }
        msg.className = 'feed-validate-msg'; msg.textContent = 'Validating…';
        const result = await FeedManager.validateFeed(url);
        if (result.valid) {
          msg.className = 'feed-validate-msg success';
          msg.textContent = 'Valid RSS feed — ' + result.count + ' articles.';
        } else {
          msg.className = 'feed-validate-msg error';
          msg.textContent = result.error || 'Invalid feed.';
        }
      });
    }

    if (addBtn && urlInput && nameInput && scopeSelect && nationSelect && subcatSelect) {
      addBtn.addEventListener('click', () => {
        const url = urlInput.value.trim();
        const name = nameInput.value.trim() || url;
        const scope = scopeSelect.value;
        const nation = nationSelect.value;
        const subcat = subcatSelect.value;
        if (!url) return;
        FeedManager.addCustomFeed(name, url, scope, nation, subcat);
        urlInput.value = '';
        nameInput.value = '';
        renderCustomList();
      });
    }

    function renderCustomList() {
      if (!list) return;
      const feeds = FeedManager.getCustomFeeds();
      if (!feeds.length) { list.innerHTML = '<p style="font-size:0.82rem;color:var(--text-tertiary);font-style:italic;margin-top:8px;">No custom feeds added yet.</p>'; return; }
      list.innerHTML = '<ul class="feed-list">' + feeds.map(f =>
        '<li><span class="feed-source">' + f.name + '</span> <span class="feed-cat">' + (f.scope || 'global') + '</span> <span class="feed-remove" data-url="' + f.url.replace(/"/g, '&quot;') + '">Remove</span></li>'
      ).join('') + '</ul>';
      list.querySelectorAll('.feed-remove').forEach(el => {
        el.addEventListener('click', () => {
          FeedManager.removeCustomFeed(el.dataset.url);
          renderCustomList();
        });
      });
    }
  }

  function bindNitter() {
    const btn = $('#settings-nitter-clear');
    if (btn) {
      btn.addEventListener('click', () => {
        try { localStorage.removeItem('newsfeeds_tweet_cache'); } catch {}
        btn.textContent = 'Cache cleared';
        setTimeout(() => { btn.textContent = 'Clear tweet cache'; }, 2000);
      });
    }
  }

  function showNitterHint() {
    const hint = $('#settings-nitter-hint');
    if (hint && window.TwitterFetcher) {
      const instance = TwitterFetcher.getCurrentInstance?.() || 'nitter.net';
      hint.textContent = 'Current instance: ' + instance;
    }
  }

  function bindSourcesConfig() {
    const modal = $('#sources-config-modal');
    const openBtn = $('#sources-config-btn');
    const closeBtn = $('#sources-config-modal-close');
    const doneBtn = $('#sources-config-done');
    const search = $('#sources-config-search');
    const body = $('#sources-config-body');

    if (openBtn) {
      openBtn.addEventListener('click', () => {
        if (modal) modal.classList.add('open');
        renderSourcesConfig();
      });
    }
    if (closeBtn) closeBtn.addEventListener('click', () => modal.classList.remove('open'));
    if (doneBtn) doneBtn.addEventListener('click', () => modal.classList.remove('open'));
    if (search) {
      search.addEventListener('input', () => renderSourcesConfig(search.value));
    }

    function renderSourcesConfig(query) {
      if (!body) return;
      FeedManager.load().then(() => {
        const all = FeedManager.getSubscribableFeeds();
        const subs = FeedManager.getSubscribedFeeds();
        let filtered = all;
        if (query) {
          const q = query.toLowerCase();
          filtered = all.filter(f => f.name.toLowerCase().includes(q) || (f.region || '').toLowerCase().includes(q));
        }
        const byRegion = {};
        for (const f of filtered) {
          const region = f.region || f.nation || 'Other';
          if (!byRegion[region]) byRegion[region] = [];
          byRegion[region].push(f);
        }
        let html = '<table class="scm-table"><thead><tr><th></th><th>Source</th><th>Category</th><th>Lang</th></tr></thead><tbody>';
        for (const [region, feeds] of Object.entries(byRegion)) {
          html += '<tr class="scm-region-header"><td colspan="4">' + region + '</td></tr>';
          for (const f of feeds) {
            const checked = subs.includes(f.url) ? ' checked' : '';
            html += '<tr class="scm-row' + (checked ? ' scm-active' : '') + '" data-url="' + f.url.replace(/"/g, '&quot;') + '">' +
              '<td class="scm-check"><input type="checkbox"' + checked + '></td>' +
              '<td class="scm-name">' + f.name + '</td>' +
              '<td class="scm-cat">' + (f.hint || '—') + '</td>' +
              '<td class="scm-lang">' + (f.lang || 'en') + '</td>' +
            '</tr>';
          }
        }
        html += '</tbody></table>';
        body.innerHTML = html;
        body.querySelectorAll('.scm-row').forEach(row => {
          row.addEventListener('click', e => {
            if (e.target.closest('.scm-check input')) return;
            const cb = row.querySelector('.scm-check input');
            if (cb) { cb.checked = !cb.checked; cb.dispatchEvent(new Event('change')); }
          });
          const cb = row.querySelector('.scm-check input');
          if (cb) {
            cb.addEventListener('change', () => {
              FeedManager.toggleSubscription(row.dataset.url);
              row.classList.toggle('scm-active', cb.checked);
            });
          }
        });
      });
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
    const authAvatarBtn = $('#auth-avatar-btn');
    if (authAvatarBtn) {
      authAvatarBtn.addEventListener('click', () => {
        const dd = $('#auth-dropdown');
        if (dd) dd.style.display = dd.style.display === 'none' ? 'block' : 'none';
      });
    }
  }

  function bindHardRefresh() {
    const btn = $('#hard-refresh-btn');
    if (!btn) return;
    btn.addEventListener('click', () => {
      if (!confirm('This will clear all cached articles and reset app state. Your sign-in session will be preserved. Continue?')) return;
      const PRESERVE_KEYS = ['supabase.auth.token'];
      const toRemove = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key) continue;
        if (PRESERVE_KEYS.includes(key)) continue;
        toRemove.push(key);
      }
      toRemove.forEach(k => localStorage.removeItem(k));
      try { sessionStorage.clear(); } catch {}
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
        } catch (e) { console.warn('Cache cleanup failed:', e); }
        window.location.href = 'index.html?_t=' + Date.now();
      })();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
