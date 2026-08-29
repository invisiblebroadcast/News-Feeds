// @ts-nocheck
(async () => {
    const $ = (sel, ctx) => (ctx || document).querySelector(sel);
    function escHtml(s) { return (s == null ? '' : String(s)).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
    function init() {
        bindAIModel();
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
        if (!sel)
            return;
        const lang = Settings.get('language') || 'en';
        sel.value = lang;
        sel.addEventListener('change', () => {
            Settings.set('language', sel.value);
            AppState.set('language', sel.value);
        });
    }
    function renderSubscriptions() {
        const list = $('#subscription-list');
        if (!list)
            return;
        FeedManager.load().then(() => {
            const subs = FeedManager.getSubscribedFeeds();
            const all = FeedManager.getSubscribableFeeds();
            const byRegion = {};
            for (const f of all) {
                const region = f.region || f.nation || 'other';
                if (!byRegion[region])
                    byRegion[region] = [];
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
    function renderFailedPanel(panel) {
        if (!window.SourceHealth || !panel) return;
        const entries = SourceHealth.getVisibleSources()
            .sort((a, b) => (b.failures || 0) - (a.failures || 0));
        if (entries.length === 0) {
            panel.innerHTML = '<p style="opacity:.6;margin:0">No failed sources tracked yet.</p>';
            return;
        }
        const allFeeds = (window.FeedManager && typeof FeedManager.getSubscribableFeeds === 'function')
            ? FeedManager.getSubscribableFeeds() : [];
        let html = '<ul style="list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:8px">';
        for (const e of entries) {
            const match = allFeeds.find(f => f.url === e.url);
            const title = (match && match.title) ? match.title : e.url;
            const region = (match && match.region) ? match.region : '';
            const pill = e.disabled
                ? '<span style="background:#ef4444;color:#fff;padding:2px 7px;border-radius:10px;font-size:11px;font-weight:600">DISABLED</span>'
                : '<span style="background:#f59e0b;color:#000;padding:2px 7px;border-radius:10px;font-size:11px;font-weight:600">' + (e.failures || 0) + ' / 5 FAILS</span>';
            const err = e.lastError ? '<div style="font-size:11px;color:var(--text-secondary,#999);margin-top:3px;word-break:break-all">Error: ' + escHtml(e.lastError) + '</div>' : '';
            const time = e.lastFailureAt ? '<div style="font-size:11px;color:var(--text-secondary,#999);margin-top:2px">' + new Date(e.lastFailureAt).toLocaleString() + '</div>' : '';
            html += '<li style="background:var(--surface-secondary,#1a1a2e);border-radius:8px;padding:10px 12px;border:1px solid var(--border-primary,#333)">';
            html += '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">';
            html += pill;
            html += '<strong style="font-size:13px">' + escHtml(title) + '</strong>';
            if (region) html += '<span style="font-size:11px;opacity:.5">' + escHtml(region) + '</span>';
            html += '</div>';
            html += '<div style="font-size:11px;color:var(--text-secondary,#888);margin-top:4px;word-break:break-all;opacity:.7">' + escHtml(e.url) + '</div>';
            html += err;
            html += time;
            html += '</li>';
        }
        html += '</ul>';
        panel.innerHTML = html;
    }
    function bindFeedHealth() {
        const toggle = $('#auto-disable-failing-sources');
        const count = $('#feed-health-count');
        const reenable = $('#reenable-all-btn');
        const viewBtn = $('#view-failed-btn');
        const panel = $('#failed-sources-panel');
        let panelOpen = false;
        if (toggle) {
            toggle.checked = Settings.get('autoDisableFailingSources') === true;
            toggle.addEventListener('change', () => {
                Settings.set('autoDisableFailingSources', toggle.checked);
            });
        }
        if (viewBtn) {
            viewBtn.addEventListener('click', () => {
                panelOpen = !panelOpen;
                if (panelOpen) {
                    renderFailedPanel(panel);
                    panel.style.display = 'block';
                    viewBtn.textContent = 'Hide Failed & Disabled Sources';
                } else {
                    panel.style.display = 'none';
                    viewBtn.textContent = 'View Failed & Disabled Sources';
                }
            });
        }
        if (window.SourceHealth) {
            const updateHealth = () => {
                const tracked = SourceHealth.getTrackedSources();
                const disabled = tracked.filter(s => s.disabled);
                const total = tracked.length;
                if (count) {
                    if (total === 0) {
                        count.innerHTML = '<span class="feed-health-count-empty">No failing sources tracked yet.</span>';
                    }
                    else {
                        count.innerHTML = '<strong>' + disabled.length + '</strong> of <strong>' + total + '</strong> sources disabled.';
                    }
                }
                if (reenable) {
                    reenable.disabled = disabled.length === 0;
                    reenable.onclick = () => {
                        SourceHealth.reEnableAll();
                        updateHealth();
                    };
                }
                if (viewBtn) {
                    viewBtn.style.display = total === 0 ? 'none' : '';
                }
                if (panelOpen) renderFailedPanel(panel);
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
                if (!url) {
                    msg.className = 'feed-validate-msg error';
                    msg.textContent = 'Please enter a URL.';
                    return;
                }
                msg.className = 'feed-validate-msg';
                msg.textContent = 'Validating…';
                const result = await FeedManager.validateFeed(url);
                if (result.valid) {
                    msg.className = 'feed-validate-msg success';
                    msg.textContent = 'Valid RSS feed — ' + result.count + ' articles.';
                }
                else {
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
                if (!url)
                    return;
                FeedManager.addCustomFeed(name, url, scope, nation, subcat);
                urlInput.value = '';
                nameInput.value = '';
                renderCustomList();
            });
        }
        function renderCustomList() {
            if (!list)
                return;
            const feeds = FeedManager.getCustomFeeds();
            if (!feeds.length) {
                list.innerHTML = '<p style="font-size:0.82rem;color:var(--text-tertiary);font-style:italic;margin-top:8px;">No custom feeds added yet.</p>';
                return;
            }
            const nations = FeedManager.getNations();
            const nationOpts = Object.entries(nations).map(([k, v]) => '<option value="' + k + '">' + v + '</option>').join('');
            const cats = FeedManager.subcategories();
            const subOpts = cats.map(c => '<option value="' + c + '">' + c + '</option>').join('');
            const scopeOpts = '<option value="global">Global</option><option value="nation">Nation</option>';
            list.innerHTML = '<ul class="feed-list">' + feeds.map(f =>
                '<li><span class="feed-source feed-source-editable" data-url="' + f.url.replace(/"/g, '&quot;') + '" data-name="' + (f.name || '').replace(/"/g, '&quot;') + '" data-scope="' + (f.scope || 'global') + '" data-nation="' + (f.nation || '') + '" data-subcat="' + (f.subcat || 'politics') + '">' + f.name + '</span> <span class="feed-cat">' + (f.scope === 'nation' ? (nations[f.nation] || f.nation) + ' / ' : 'Global / ') + (f.subcat || 'politics') + '</span> <span class="feed-remove" data-url="' + f.url.replace(/"/g, '&quot;') + '">Remove</span></li>'
            ).join('') + '</ul>';
            list.querySelectorAll('.feed-remove').forEach(el => {
                el.addEventListener('click', () => {
                    FeedManager.removeCustomFeed(el.dataset.url);
                    renderCustomList();
                });
            });
            list.querySelectorAll('.feed-source-editable').forEach(el => {
                el.addEventListener('click', e => {
                    e.stopPropagation();
                    const existing = list.querySelector('.feed-edit-popup');
                    if (existing) existing.remove();
                    const popup = document.createElement('div');
                    popup.className = 'feed-edit-popup';
                    popup.innerHTML =
                        '<div class="feed-edit-row"><label>Name</label><input type="text" class="feed-edit-name" value="' + (el.dataset.name || '').replace(/"/g, '&quot;') + '"></div>' +
                        '<div class="feed-edit-row"><label>Scope</label><select class="feed-edit-scope">' + scopeOpts + '</select></div>' +
                        '<div class="feed-edit-row feed-edit-nation-row"><label>Nation</label><select class="feed-edit-nation">' + nationOpts + '</select></div>' +
                        '<div class="feed-edit-row"><label>Subcategory</label><select class="feed-edit-subcat">' + subOpts + '</select></div>' +
                        '<div class="feed-edit-actions"><button class="feed-edit-save">Save</button><button class="feed-edit-cancel">Cancel</button></div>';
                    el.parentNode.insertBefore(popup, el.nextSibling);
                    const scopeSel = popup.querySelector('.feed-edit-scope');
                    const nationRow = popup.querySelector('.feed-edit-nation-row');
                    scopeSel.value = el.dataset.scope || 'global';
                    popup.querySelector('.feed-edit-nation').value = el.dataset.nation || '';
                    popup.querySelector('.feed-edit-subcat').value = el.dataset.subcat || 'politics';
                    nationRow.style.display = scopeSel.value === 'nation' ? '' : 'none';
                    scopeSel.addEventListener('change', () => { nationRow.style.display = scopeSel.value === 'nation' ? '' : 'none'; });
                    popup.querySelector('.feed-edit-cancel').addEventListener('click', () => popup.remove());
                    popup.querySelector('.feed-edit-save').addEventListener('click', async () => {
                        const newName = popup.querySelector('.feed-edit-name').value.trim() || el.dataset.name;
                        const newScope = scopeSel.value;
                        const newNation = popup.querySelector('.feed-edit-nation').value;
                        const newSubcat = popup.querySelector('.feed-edit-subcat').value;
                        await FeedManager.addCustomFeed(newName, el.dataset.url, newScope, newNation, newSubcat);
                        popup.remove();
                        renderCustomList();
                    });
                    document.addEventListener('click', function closePopup(ev) {
                        if (!popup.contains(ev.target) && ev.target !== el) {
                            popup.remove();
                            document.removeEventListener('click', closePopup);
                        }
                    });
                });
            });
        }
    }
    function bindNitter() {
        const btn = $('#settings-nitter-clear');
        if (btn) {
            btn.addEventListener('click', () => {
                try {
                    localStorage.removeItem('newsfeeds_tweet_cache');
                }
                catch { }
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
                if (modal)
                    modal.classList.add('open');
                renderSourcesConfig();
            });
        }
        if (closeBtn)
            closeBtn.addEventListener('click', () => modal.classList.remove('open'));
        if (doneBtn)
            doneBtn.addEventListener('click', () => modal.classList.remove('open'));
        if (search) {
            search.addEventListener('input', () => renderSourcesConfig(search.value));
        }
        function renderSourcesConfig(query) {
            if (!body)
                return;
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
                    if (!byRegion[region])
                        byRegion[region] = [];
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
                        if (e.target.closest('.scm-check input'))
                            return;
                        const cb = row.querySelector('.scm-check input');
                        if (cb) {
                            cb.checked = !cb.checked;
                            cb.dispatchEvent(new Event('change'));
                        }
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
                if (modal)
                    modal.classList.add('open');
            });
        }
        const authAvatarBtn = $('#auth-avatar-btn');
        if (authAvatarBtn) {
            authAvatarBtn.addEventListener('click', () => {
                const dd = $('#auth-dropdown');
                if (dd)
                    dd.style.display = dd.style.display === 'none' ? 'block' : 'none';
            });
        }
    }
    function bindHardRefresh() {
        const btn = $('#hard-refresh-btn');
        if (!btn)
            return;
        btn.addEventListener('click', () => {
            if (!confirm('This will clear all cached articles and reset app state. Your sign-in session will be preserved. Continue?'))
                return;
            const PRESERVE_KEYS = ['supabase.auth.token'];
            const toRemove = [];
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                if (!key)
                    continue;
                if (PRESERVE_KEYS.includes(key))
                    continue;
                toRemove.push(key);
            }
            toRemove.forEach(k => localStorage.removeItem(k));
            try {
                sessionStorage.clear();
            }
            catch { }
            (async () => {
                try {
                    if ('serviceWorker' in navigator) {
                        const regs = await navigator.serviceWorker.getRegistrations();
                        await Promise.all(regs.map(r => r.unregister().catch(() => { })));
                    }
                    if ('caches' in window) {
                        const keys = await caches.keys();
                        await Promise.all(keys.map(k => caches.delete(k).catch(() => { })));
                    }
                }
                catch (e) {
                }
                window.location.href = 'index.html?_t=' + Date.now();
            })();
        });
    }
    function bindAIModel() {
        const statusEl = $('#ai-model-status');
        const statusText = $('#ai-model-status-text');
        const dlBtn = $('#ai-model-download-btn');
        const rmBtn = $('#ai-model-remove-btn');
        const progressWrap = $('#ai-model-progress-wrap');
        const progressBar = $('#ai-model-progress-bar');
        const detailEl = $('#ai-model-detail');
        if (!statusEl)
            return;
        if (!window.Embeddings) {
            statusText.textContent = 'Not available';
            if (detailEl) detailEl.textContent = 'AI module did not load. Try refreshing the page.';
            return;
        }
        function refreshUI() {
            const ready = Embeddings.isReady && Embeddings.isReady();
            const consented = Embeddings.hasConsent && Embeddings.hasConsent();
            const declined = localStorage.getItem('embeddings_consent') === '0';
            statusEl.className = 'ai-model-status';
            if (ready) {
                statusEl.classList.add('ai-ready');
                statusText.textContent = 'Downloaded';
                if (dlBtn) dlBtn.style.display = 'none';
                if (rmBtn) rmBtn.style.display = '';
                if (detailEl) detailEl.textContent = 'AI semantic search is active. Articles will be grouped by meaning.';
            }
            else if (consented) {
                statusEl.classList.add('ai-downloading');
                statusText.textContent = 'Consented (load on next search)';
                if (dlBtn) {
                    dlBtn.style.display = '';
                    dlBtn.textContent = 'Download Now';
                }
                if (rmBtn) rmBtn.style.display = 'none';
                if (detailEl) detailEl.textContent = 'Model will download automatically when you use search, or click Download Now.';
            }
            else if (declined) {
                statusEl.classList.add('ai-declined');
                statusText.textContent = 'Disabled';
                if (dlBtn) {
                    dlBtn.style.display = '';
                    dlBtn.textContent = 'Enable & Download';
                }
                if (rmBtn) rmBtn.style.display = 'none';
                if (detailEl) detailEl.textContent = 'AI search is off. Enable it to download the model.';
            }
            else {
                statusText.textContent = 'Not configured';
                if (dlBtn) {
                    dlBtn.style.display = '';
                    dlBtn.textContent = 'Download Model';
                }
                if (rmBtn) rmBtn.style.display = 'none';
                if (detailEl) detailEl.textContent = 'Download a ~25 MB model for smarter, meaning-based article search.';
            }
        }
        if (dlBtn) {
            dlBtn.addEventListener('click', () => {
                Embeddings.setConsent(true);
                if (progressWrap) progressWrap.style.display = 'block';
                if (dlBtn) {
                    dlBtn.disabled = true;
                    dlBtn.textContent = 'Downloading…';
                }
                if (statusText) statusText.textContent = 'Downloading…';
                statusEl.className = 'ai-model-status ai-downloading';
                Embeddings.loadModelWithProgress(p => {
                    if (p.status === 'download') {
                        if (typeof p.progress === 'number' && progressBar)
                            progressBar.style.width = Math.round(p.progress * 100) + '%';
                        if (statusText)
                            statusText.textContent = 'Downloading ' + (p.phase === 'library' ? 'library' : 'model') + '…';
                    }
                    else if (p.status === 'ready') {
                        if (progressBar) progressBar.style.width = '100%';
                        if (statusText) statusText.textContent = 'Downloaded';
                        if (dlBtn) dlBtn.disabled = false;
                        setTimeout(() => {
                            if (progressWrap) progressWrap.style.display = 'none';
                            refreshUI();
                        }, 600);
                    }
                    else if (p.status === 'error') {
                        if (statusText) statusText.textContent = 'Failed';
                        if (dlBtn) {
                            dlBtn.disabled = false;
                            dlBtn.textContent = 'Retry Download';
                        }
                        if (detailEl) detailEl.textContent = 'Error: ' + (p.error || 'unknown');
                    }
                }).catch(() => {
                    if (dlBtn) {
                        dlBtn.disabled = false;
                        dlBtn.textContent = 'Retry Download';
                    }
                    if (statusText) statusText.textContent = 'Failed';
                    if (progressWrap) progressWrap.style.display = 'none';
                });
            });
        }
        if (rmBtn) {
            rmBtn.addEventListener('click', () => {
                Embeddings.setConsent(false);
                refreshUI();
            });
        }
        refreshUI();
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    }
    else {
        init();
    }
})();
