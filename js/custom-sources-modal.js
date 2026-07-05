// @ts-nocheck
window.CustomSourcesModal = (() => {
    let validatedFeed = null;
    function openModal() {
        const modal = $('#custom-sources-modal');
        if (!modal)
            return;
        renderNationSelect();
        renderSubcatSelect();
        renderList();
        if (window.appState && window.appState.openModal) {
            window.appState.openModal('customSources', modal);
        }
        else {
            modal.classList.add('open');
            document.body.classList.add('modal-open');
        }
    }
    function closeModal() {
        if (window.appState && window.appState.closeModal) {
            window.appState.closeModal('customSources');
        }
        else {
            const modal = $('#custom-sources-modal');
            if (modal)
                modal.classList.remove('open');
            document.body.classList.remove('modal-open');
        }
    }
    function renderNationSelect() {
        const sel = $('#cs-nation-select');
        if (!sel)
            return;
        const nations = (window.FeedManager && window.FeedManager.getNations) ? FeedManager.getNations() : {};
        const current = (window.appState && window.appState.currentNation) || 'india';
        sel.innerHTML = Object.keys(nations).map(k => '<option value="' + k + '"' + (k === current ? ' selected' : '') + '>' + (nations[k] || k) + '</option>').join('');
        const scopeSel = $('#cs-scope-select');
        if (scopeSel) {
            sel.style.display = scopeSel.value === 'nation' ? '' : 'none';
            scopeSel.addEventListener('change', () => {
                sel.style.display = scopeSel.value === 'nation' ? '' : 'none';
            });
        }
    }
    function renderSubcatSelect() {
        const sel = $('#cs-subcat-select');
        if (!sel)
            return;
        const subs = (window.FeedManager && window.FeedManager.subcategories) ? FeedManager.subcategories() : [];
        sel.innerHTML =
            '<option value="all">All categories</option>' +
                subs.map(s => '<option value="' + s + '">' + (FeedManager.subcatLabel ? FeedManager.subcatLabel(s, 'global') : s) + '</option>').join('');
    }
    async function renderList() {
        const container = $('#cs-feed-list');
        if (!container)
            return;
        const feeds = (window.FeedManager && window.FeedManager.getCustomFeeds) ? FeedManager.getCustomFeeds() : [];
        if (!feeds.length) {
            container.innerHTML = '<p style="color:var(--text-tertiary);font-size:0.82rem;padding:12px;">No custom feeds added yet.</p>';
            return;
        }
        container.innerHTML = '<ul class="feed-list">' + feeds.map(f => {
            const scopeName = f.scope === 'nation'
                ? ((window.FeedManager && FeedManager.getNations && FeedManager.getNations()[f.nation]) || f.nation || 'Nation')
                : 'Global';
            const catLabel = f.subcat === 'all' ? 'All categories'
                : ((window.FeedManager && FeedManager.subcatLabel) ? FeedManager.subcatLabel(f.subcat, f.scope) : f.subcat);
            return '<li>' +
                '<div style="display:flex;flex-direction:column;gap:2px;flex:1;min-width:0;">' +
                '<span style="font-weight:500;font-size:0.9rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + escHtml(f.name) + '</span>' +
                '<span style="font-size:0.78rem;color:var(--text-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' +
                escHtml(scopeName) + ' / ' + escHtml(catLabel) +
                '</span>' +
                '</div>' +
                '<span class="feed-remove cs-feed-remove" data-url="' + escAttr(f.url) + '">Remove</span>' +
                '</li>';
        }).join('') + '</ul>';
        container.querySelectorAll('.cs-feed-remove').forEach(btn => {
            btn.addEventListener('click', async () => {
                try {
                    await FeedManager.removeCustomFeed(btn.dataset.url);
                }
                catch (e) {
                    console.warn('removeCustomFeed failed:', e && e.message);
                }
                await renderList();
            });
        });
    }
    async function handleValidate() {
        const url = $('#cs-url-input')?.value?.trim();
        if (!url)
            return;
        const msg = $('#cs-validate-msg');
        if (msg) {
            msg.textContent = 'Validating\u2026';
            msg.className = 'feed-validate-msg';
        }
        try {
            const result = await FeedManager.validateFeed(url);
            if (msg) {
                if (result.valid) {
                    validatedFeed = { url, title: result.title };
                    msg.textContent = 'Valid: ' + result.title + ' (' + result.count + ' articles)';
                    msg.className = 'feed-validate-msg success';
                    const nameInput = $('#cs-name-input');
                    if (nameInput && !nameInput.value)
                        nameInput.value = result.title;
                }
                else {
                    validatedFeed = null;
                    msg.textContent = 'Invalid: ' + (result.error || 'Unknown');
                    msg.className = 'feed-validate-msg error';
                }
            }
        }
        catch {
            validatedFeed = null;
            if (msg) {
                msg.textContent = 'Validation failed';
                msg.className = 'feed-validate-msg error';
            }
        }
    }
    async function handleAdd() {
        const name = $('#cs-name-input')?.value?.trim();
        const url = validatedFeed?.url || $('#cs-url-input')?.value?.trim();
        const scope = $('#cs-scope-select')?.value || 'global';
        const nation = $('#cs-nation-select')?.value || 'india';
        const subcat = $('#cs-subcat-select')?.value || 'all';
        const msg = $('#cs-validate-msg');
        if (!name || !url) {
            if (msg) {
                msg.textContent = 'Enter a name and URL first.';
                msg.className = 'feed-validate-msg error';
            }
            return;
        }
        try {
            await FeedManager.addCustomFeed(name, url, scope, nation, subcat, 'en');
        }
        catch (e) {
            console.warn('addCustomFeed failed:', e && e.message);
        }
        validatedFeed = null;
        const urlInput = $('#cs-url-input');
        if (urlInput)
            urlInput.value = '';
        const nameInput = $('#cs-name-input');
        if (nameInput)
            nameInput.value = '';
        if (msg)
            msg.textContent = '';
        await renderList();
    }
    function bindAll() {
        const closeBtn = $('#custom-sources-modal-close');
        if (closeBtn)
            closeBtn.addEventListener('click', closeModal);
        const modal = $('#custom-sources-modal');
        if (modal)
            modal.addEventListener('click', e => { if (e.target === modal)
                closeModal(); });
        const validateBtn = $('#cs-validate-btn');
        if (validateBtn)
            validateBtn.addEventListener('click', handleValidate);
        const addBtn = $('#cs-add-btn');
        if (addBtn)
            addBtn.addEventListener('click', handleAdd);
        const urlInput = $('#cs-url-input');
        if (urlInput)
            urlInput.addEventListener('keydown', e => { if (e.key === 'Enter')
                handleValidate(); });
        const scopeSel = $('#cs-scope-select');
        if (scopeSel)
            scopeSel.addEventListener('change', renderNationSelect);
    }
    return { openModal, closeModal, bindAll };
})();
