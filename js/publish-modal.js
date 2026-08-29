// @ts-nocheck
/* ── Publish Modal ──
 *
 * YouTube transcript + Quotes → Supabase publishing pipeline.
 * FAB + modal with YouTube/Audio/Quotes tabs. Only visible to
 * signed-in users.
 *
 * Dependencies:
 *   - SupabaseStore (for auth user id + DB writes)
 *   - youtubetranscript.com API (free, no API key)
 */
const PublishModal = (() => {
    function $(sel, ctx) { return (ctx || document).querySelector(sel); }
    function $$(sel, ctx) { return [...(ctx || document).querySelectorAll(sel)]; }
    let currentUser = null;
    /** Format integer post_id as IB00001, IB00002, etc. */
    function formatPostId(id) {
        if (!id && id !== 0)
            return '';
        return 'IB' + String(id).padStart(5, '0');
    }
    /** Convert timestamptz to epoch milliseconds for safe filenames. */
    function ibPostKey(ts) {
        if (!ts)
            return '';
        return String(new Date(ts).getTime());
    }
    /* ── YouTube helpers ── */
    function getVideoId(url) {
        const patterns = [
            /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
            /^([a-zA-Z0-9_-]{11})$/
        ];
        for (const p of patterns) {
            const m = url.match(p);
            if (m)
                return m[1];
        }
        return null;
    }
    async function fetchTranscript(videoId) {
        const res = await fetch(`https://youtubetranscript.com/?v=${videoId}`);
        if (!res.ok)
            throw new Error('Transcript unavailable for this video');
        return res.json();
    }
    async function fetchVideoTitle(videoId) {
        try {
            const res = await fetch(`https://youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`);
            if (res.ok) {
                const data = await res.json();
                return data.title || '';
            }
        }
        catch { }
        return '';
    }
    /* ── Actions ── */
    function setMsg(el, text, type) {
        if (!el)
            return;
        el.textContent = text;
        el.className = 'publish-msg';
        if (type)
            el.classList.add(type);
    }
    /* ── YouTube: publish to Supabase ── */
    async function handleFetchTranscript() {
        const urlInput = $('#publish-url');
        const titleInput = $('#publish-title');
        const descInput = $('#publish-desc');
        const msg = $('#publish-msg');
        const fetchBtn = $('#publish-fetch-btn');
        const url = urlInput?.value?.trim();
        if (!url) {
            setMsg(msg, 'Please enter a YouTube URL', 'error');
            return;
        }
        const videoId = getVideoId(url);
        if (!videoId) {
            setMsg(msg, 'Invalid YouTube URL', 'error');
            return;
        }
        if (fetchBtn) {
            fetchBtn.disabled = true;
            fetchBtn.textContent = 'Fetching\u2026';
        }
        setMsg(msg, 'Fetching transcript\u2026', '');
        try {
            const [transcript, videoTitle] = await Promise.all([
                fetchTranscript(videoId),
                fetchVideoTitle(videoId)
            ]);
            if (!transcript || !transcript.length) {
                throw new Error('No transcript available for this video');
            }
            if (videoTitle && titleInput) {
                titleInput.value = videoTitle;
            }
            const transcriptText = transcript.map(t => t.text).join('\n');
            if (descInput) {
                descInput.value = transcriptText;
            }
            setMsg(msg, 'Transcript fetched successfully!', 'success');
        }
        catch (e) {
            setMsg(msg, e.message || 'Failed to fetch transcript', 'error');
        }
        finally {
            if (fetchBtn) {
                fetchBtn.disabled = false;
                fetchBtn.textContent = 'Fetch Transcript';
            }
        }
    }
    async function handlePublish() {
        // Skip if we're in edit mode (app-home.ts sets this flag)
        if (window._ibSkipPublish) {
            window._ibSkipPublish = false;
            return;
        }
        const title = $('#publish-title')?.value?.trim();
        const desc = $('#publish-desc')?.value?.trim();
        const url = $('#publish-url')?.value?.trim();
        const msg = $('#publish-msg');
        if (!currentUser) {
            setMsg(msg, 'Please sign in first', 'error');
            return;
        }
        if (!title) {
            setMsg(msg, 'Please enter a title', 'error');
            return;
        }
        if (!desc) {
            setMsg(msg, 'Please enter content', 'error');
            return;
        }
        const publishBtn = $('#yt-publish-btn');
        if (publishBtn) {
            publishBtn.disabled = true;
            publishBtn.textContent = 'Publishing\u2026';
        }
        try {
            const client = window.SupabaseStore && SupabaseStore.getClient();
            if (!client)
                throw new Error('Supabase client not available');
            const { error } = await client
                .from('published_articles')
                .insert({
                user_id: currentUser.id,
                user_email: currentUser.email || '',
                author: currentUser.email || '',
                title: title,
                body: desc,
                source_name: 'YouTube',
                source_link: url || '',
                scope: 'global',
                nation: '',
                category: 'all',
                type: 'feeds',
                quote_from: '',
                tags: postTags.getTags()
            });
            if (error)
                throw error;
            setMsg(msg, 'Post published successfully!', 'success');
            postTags.setTags([]);
            if ($('#publish-title'))
                $('#publish-title').value = '';
            if ($('#publish-desc'))
                $('#publish-desc').value = '';
            if ($('#publish-url'))
                $('#publish-url').value = '';
            setTimeout(() => {
                closeModal();
                if (window.appState && typeof window.appState.refreshCurrentView === 'function') {
                    window.appState.refreshCurrentView();
                }
            }, 800);
        }
        catch (e) {
            setMsg(msg, e.message || 'Publish failed', 'error');
        }
        finally {
            if (publishBtn) {
                publishBtn.disabled = false;
                publishBtn.textContent = 'Publish';
            }
        }
    }
    /* ── Posts: publish to Supabase ── */
    let _postImageFile = null;
    function initPostImageHandlers() {
        const fileInput = $('#post-image');
        const preview = $('#post-image-preview');
        const previewImg = $('#post-image-preview-img');
        const removeBtn = $('#post-image-remove');
        if (fileInput) {
            fileInput.addEventListener('change', () => {
                const file = fileInput.files[0];
                if (!file)
                    return;
                if (file.type !== 'image/png' && file.type !== 'image/jpeg') {
                    fileInput.value = '';
                    return;
                }
                if (file.size > 2 * 1024 * 1024) {
                    fileInput.value = '';
                    return;
                }
                _postImageFile = file;
                if (preview && previewImg) {
                    previewImg.src = URL.createObjectURL(file);
                    preview.style.display = 'block';
                }
            });
        }
        if (removeBtn) {
            removeBtn.addEventListener('click', () => {
                _postImageFile = null;
                if (fileInput)
                    fileInput.value = '';
                if (preview)
                    preview.style.display = 'none';
            });
        }
    }
    async function handlePublishPost() {
        // Skip if we're in edit mode (app-home.ts sets this flag)
        if (window._ibSkipPublish) {
            window._ibSkipPublish = false;
            return;
        }
        const title = $('#post-title')?.value?.trim();
        const desc = $('#post-desc')?.value?.trim();
        const sourceName = $('#post-source-name')?.value?.trim() || '';
        const sourceLink = $('#post-source-link')?.value?.trim() || '';
        const scopeVal = $('#post-scope-select')?.value || 'global';
        const categoryVal = $('#post-category-select')?.value || 'all';
        const msg = $('#post-publish-msg');
        if (!currentUser) {
            setMsg(msg, 'Please sign in first', 'error');
            return;
        }
        if (!title) {
            setMsg(msg, 'Please enter a title', 'error');
            return;
        }
        if (!desc) {
            setMsg(msg, 'Please enter content', 'error');
            return;
        }
        const publishBtn = $('#post-publish-btn');
        if (publishBtn) {
            publishBtn.disabled = true;
            publishBtn.textContent = 'Publishing\u2026';
        }
        try {
            const client = window.SupabaseStore && SupabaseStore.getClient();
            if (!client)
                throw new Error('Supabase client not available');
            const { data: inserted, error } = await client
                .from('published_articles')
                .insert({
                user_id: currentUser.id,
                user_email: currentUser.email || '',
                author: currentUser.email || '',
                title: title,
                body: desc,
                source_name: sourceName || 'Invisible Broadcast',
                source_link: sourceLink || '',
                scope: scopeVal,
                nation: scopeVal === 'nation' ? 'india' : '',
                category: categoryVal,
                type: 'feeds',
                quote_from: '',
                tags: postTags.getTags()
            })
                .select('id, post_id, last_modified')
                .single();
            if (error)
                throw error;
            const postId = inserted?.post_id;
            const lastModified = inserted?.last_modified;
            if (_postImageFile && postId && lastModified) {
                const ext = _postImageFile.type === 'image/png' ? 'png' : 'jpg';
                const filePath = 'ibpost' + ibPostKey(lastModified) + '.' + ext;
                const { error: uploadErr } = await client.storage
                    .from('ib-post-images')
                    .upload(filePath, _postImageFile, {
                    contentType: _postImageFile.type,
                    upsert: true,
                    cacheControl: '0'
                });
                if (uploadErr) {
                }
            }
            setMsg(msg, 'Post published successfully!', 'success');
            _postImageFile = null;
            postTags.setTags([]);
            // Show Design Post button and auto-open studio
            const studioBtn = $('#post-studio-btn');
            if (studioBtn) {
                studioBtn.style.display = '';
                studioBtn.textContent = 'Design Post';
                studioBtn.disabled = false;
                studioBtn.onclick = () => {
                    if (window.PostDesigner) {
                        closeModal();
                        const dupData = window._duplicateDesignData;
                        window._duplicateDesignData = null;
                        const opts = {
                            summary: desc || '',
                            description: desc || '',
                            title: title || '',
                            pubDate: new Date().toISOString(),
                            _pubType: 'feeds',
                        };
                        const studioOpts = {
                            articleId: inserted?.id || null,
                            userId: currentUser ? currentUser.id : null,
                            onComplete: () => { _publishedFetchPromise = null; },
                        };
                        if (dupData) {
                            studioOpts.initialSettings = dupData;
                        }
                        PostDesigner.open(opts, studioOpts);
                    }
                };
                // Auto-open studio after short delay
                setTimeout(() => { if (studioBtn.onclick) studioBtn.onclick(); }, 600);
            }
        }
        catch (e) {
            setMsg(msg, e.message || 'Publish failed', 'error');
        }
        finally {
            if (publishBtn) {
                publishBtn.disabled = false;
                publishBtn.textContent = 'Publish Post';
            }
        }
    }
    /* ── Quotes: publish to Supabase ── */
    /* ── Handle Quote Publish ── */
    async function handlePublishQuote() {
        // Skip if we're in edit mode (app-home.ts sets this flag)
        if (window._ibSkipPublish) {
            window._ibSkipPublish = false;
            return;
        }
        const desc = $('#quote-desc')?.value?.trim();
        const quoteFrom = $('#quote-from')?.value?.trim();
        const quoteOccupation = $('#quote-occupation')?.value?.trim() || '';
        const quoteDate = $('#quote-date')?.value || '';
        const sourceLink = $('#quote-source-link')?.value?.trim();
        const scopeVal = $('#quote-scope-select')?.value || 'global';
        const msg = $('#quote-publish-msg');
        if (!currentUser) {
            setMsg(msg, 'Please sign in first', 'error');
            return;
        }
        if (!desc) {
            setMsg(msg, 'Please enter the quote text', 'error');
            return;
        }
        const publishBtn = $('#quote-publish-btn');
        if (publishBtn) {
            publishBtn.disabled = true;
            publishBtn.textContent = 'Publishing\u2026';
        }
        try {
            const client = window.SupabaseStore && SupabaseStore.getClient();
            if (!client)
                throw new Error('Supabase client not available');
            const { data: inserted, error } = await client
                .from('published_articles')
                .insert({
                user_id: currentUser.id,
                user_email: currentUser.email || '',
                author: currentUser.email || '',
                title: '',
                body: desc,
                source_name: quoteFrom || '',
                source_link: sourceLink || '',
                scope: scopeVal,
                nation: scopeVal === 'nation' ? 'india' : '',
                category: 'quotes',
                type: 'quote',
                quote_from: quoteFrom || '',
                quote_date: quoteDate,
                quote_occupation: quoteOccupation,
                tags: quoteTags.getTags()
            })
                .select('id, post_id, last_modified')
                .single();
            if (error)
                throw error;
            setMsg(msg, 'Quote published successfully!', 'success');
            quoteTags.setTags([]);
            // Show the Design Quote button and store article data for studio
            const studioBtn = $('#quote-studio-btn');
            if (studioBtn) {
                studioBtn.style.display = '';
                studioBtn.textContent = 'Design Quote';
                studioBtn.onclick = () => {
                    if (window.QuoteCardStudio) {
                        closeModal();
                        const dupData = window._duplicateDesignData;
                        window._duplicateDesignData = null;
                        const article = {
                            _pubType: 'quote',
                            summary: desc,
                            title: '',
                            _pubQuoteFrom: quoteFrom || '',
                            _pubQuoteOccupation: quoteOccupation,
                            _pubQuoteDate: quoteDate,
                            id: inserted?.id || null,
                        };
                        const studioOpts = {
                            articleId: inserted?.id || null,
                            userId: currentUser ? currentUser.id : null,
                        };
                        if (dupData) {
                            studioOpts.initialSettings = dupData;
                        }
                        window.QuoteCardStudio.open(article, studioOpts);
                    }
                };
                // Auto-open studio after short delay
                setTimeout(() => { if (studioBtn.onclick)
                    studioBtn.onclick(); }, 600);
            }
        }
        catch (e) {
            setMsg(msg, e.message || 'Publish failed', 'error');
        }
        finally {
            if (publishBtn) {
                publishBtn.disabled = false;
                publishBtn.textContent = 'Publish Quote';
            }
        }
    }
    /* ── Tab switching ── */
    function showTab(tab) {
        $$('.publish-tab').forEach(t => {
            t.style.display = '';
            t.classList.toggle('active', t.dataset.publishTab === tab);
        });
        $$('.publish-pane').forEach(p => p.classList.toggle('active', p.dataset.publishPane === tab));
    }
    /* ── FAB visibility (called from app-home.js updateAuthUI) ── */
    function updateFabVisibility() {
        const fab = $('#publish-fab');
        if (!fab)
            return;
        fab.classList.toggle('fab-hidden', !currentUser);
    }
    function _setQuoters(rows) {
        const map = {};
        (rows || []).forEach(r => {
            const n = (r.quote_from || '').trim();
            if (!n) return;
            const key = n.toLowerCase();
            if (!map[key]) map[key] = { name: n, occupation: (r.quote_occupation || '').trim() };
        });
        _allQuoters = Object.values(map);
    }
    function setCurrentUser(user) {
        currentUser = user;
        updateFabVisibility();
        if (user) _loadQuotersFromDB().then(_setQuoters); else _allQuoters = [];
    }
    function openModal() {
        const modal = $('#yt-publish-modal');
        if (!modal)
            return;
        // Refresh quoter list on open
        if (currentUser) _loadQuotersFromDB().then(_setQuoters);
        const publishBtn = $('#yt-publish-btn');
        if (publishBtn)
            publishBtn.textContent = 'Publish';
        const msg = $('#publish-msg');
        if (msg) {
            msg.textContent = '';
            msg.className = 'publish-msg';
        }
        // Reset all form fields to avoid stale edit/duplicate data
        const ids = ['post-title', 'post-desc', 'post-scope-select', 'quote-desc', 'quote-from', 'quote-occupation', 'quote-date', 'quote-source-link', 'quote-scope-select'];
        ids.forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
        const previews = ['post-image-preview', 'quote-image-preview'];
        previews.forEach(id => { const el = document.getElementById(id); if (el) el.style.display = 'none'; });
        const fileInputs = ['post-image', 'quote-image'];
        fileInputs.forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
        const quoteMsg = document.getElementById('quote-publish-msg');
        if (quoteMsg) { quoteMsg.textContent = ''; quoteMsg.className = 'publish-msg'; }
        const postMsg = document.getElementById('post-publish-msg');
        if (postMsg) { postMsg.textContent = ''; postMsg.className = 'publish-msg'; }
        if (window.PublishModal && PublishModal.postTags) PublishModal.postTags.setTags([]);
        if (window.PublishModal && PublishModal.quoteTags) PublishModal.quoteTags.setTags([]);
        // Clear any stale duplicate data
        window._duplicateDesignData = null;
        window._duplicateFgPaths = null;
        window._duplicateEditId = null;
        if (window.appState && typeof window.appState.openModal === 'function') {
            window.appState.openModal('publish', modal);
        }
        else {
            modal.classList.add('open');
        }
        showTab('youtube');
    }
    function closeModal() {
        // Reset form fields on close to prevent stale data
        const ids = ['post-title', 'post-desc', 'post-scope-select', 'quote-desc', 'quote-from', 'quote-occupation', 'quote-date', 'quote-source-link', 'quote-scope-select'];
        ids.forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
        ['post-image-preview', 'quote-image-preview'].forEach(id => { const el = document.getElementById(id); if (el) el.style.display = 'none'; });
        ['post-image', 'quote-image'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
        window._duplicateDesignData = null;
        window._duplicateFgPaths = null;
        window._duplicateEditId = null;
        if (window.appState && typeof window.appState.closeModal === 'function') {
            window.appState.closeModal('publish');
        }
        else {
            const modal = $('#yt-publish-modal');
            if (modal)
                modal.classList.remove('open');
        }
    }
    /* ── Bindings ── */
    function bindAll() {
        const fab = $('#publish-fab');
        if (fab) {
            fab.addEventListener('click', openModal);
        }
        $$('.publish-tab').forEach(tab => {
            tab.addEventListener('click', () => showTab(tab.dataset.publishTab));
        });
        const fetchBtn = $('#publish-fetch-btn');
        if (fetchBtn) {
            fetchBtn.addEventListener('click', handleFetchTranscript);
        }
        const publishBtn = $('#yt-publish-btn');
        if (publishBtn) {
            publishBtn.addEventListener('click', handlePublish);
        }
        const closeBtn = $('#yt-publish-modal-close');
        if (closeBtn)
            closeBtn.addEventListener('click', closeModal);
        const modal = $('#yt-publish-modal');
        if (modal) {
            modal.addEventListener('click', e => {
                if (e.target === modal)
                    closeModal();
            });
        }
        // Post tab
        const postPublishBtn = $('#post-publish-btn');
        if (postPublishBtn) {
            postPublishBtn.addEventListener('click', handlePublishPost);
        }
        initPostImageHandlers();
        // Quotes tab
        const quotePublishBtn = $('#quote-publish-btn');
        if (quotePublishBtn) {
            quotePublishBtn.addEventListener('click', handlePublishQuote);
        }
        initQuoterDropdown();
    }
    function escHtml(s) {
        return (s == null ? '' : String(s)).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
    function escAttr(s) {
        return (s == null ? '' : String(s)).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
    /* ── Tags system ── */
    const TAG_MAX = 5;
    const TAG_RELATED_MAP = [
        [/\b(politics|election|vote|parliament|congress|bjp|inc|mla|mp|minister|governor|president|pm|cm)\b/i, 'politics'],
        [/\b(business|economy|market|stock|trade|inflation|gdp|finance|bank|startup|company)\b/i, 'business'],
        [/\b(tech|ai|software|computer|digital|cyber|robot|startup|app|google|apple|microsoft|meta)\b/i, 'technology'],
        [/\b(science|research|study|lab|experiment|nasa|space|physics|chemistry|biology)\b/i, 'science'],
        [/\b(health|medical|hospital|vaccine|disease|doctor|treatment|drug|pharma|mental)\b/i, 'health'],
        [/\b(sport|cricket|football|tennis|olympic|match|tournament|championship|player|team)\b/i, 'sports'],
        [/\b(movie|music|film|actor|album|concert|festival|art|culture|entertainment)\b/i, 'entertainment'],
        [/\b(climate|environment|pollution|renewable|solar|energy|flood|earthquake|wildfire)\b/i, 'environment'],
        [/\b(education|school|university|student|teacher|exam|college|academic|learning)\b/i, 'education'],
        [/\b(war|military|army|attack|conflict|missile|weapon|defence|security|terror)\b/i, 'defence'],
        [/\b(law|court|judge|legal|crime|police|arrest|verdict|justice|rights)\b/i, 'legal'],
        [/\b(india|delhi|mumbai|bangalore|chennai|kolkata|hyderabad|indian)\b/i, 'india'],
        [/\b(world|global|united nations|un|nato|eu|china|usa|america|russia|uk)\b/i, 'world'],
    ];
    async function fetchRecentTags() {
        try {
            const client = window.SupabaseStore && SupabaseStore.getClient();
            if (!client)
                return [];
            const { data } = await client
                .from('published_articles')
                .select('tags')
                .not('tags', 'is', null)
                .order('date_published', { ascending: false })
                .limit(200);
            if (!data)
                return [];
            const freq = {};
            for (const row of data) {
                const tags = Array.isArray(row.tags) ? row.tags : [];
                for (const t of tags) {
                    const k = t.toLowerCase().trim();
                    if (k)
                        freq[k] = (freq[k] || 0) + 1;
                }
            }
            return Object.entries(freq)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 12)
                .map(([tag]) => tag);
        }
        catch {
            return [];
        }
    }
    function suggestRelatedTags(title, body) {
        const text = ((title || '') + ' ' + (body || '')).toLowerCase();
        const found = [];
        for (const [re, tag] of TAG_RELATED_MAP) {
            if (re.test(text) && !found.includes(tag))
                found.push(tag);
            if (found.length >= 5)
                break;
        }
        return found;
    }
    function createTagsInstance(prefix) {
        const chipsEl = document.getElementById(prefix + '-tags-chips');
        const inputEl = document.getElementById(prefix + '-tags-input');
        const suggestionsEl = document.getElementById(prefix + '-tags-suggestions');
        const relatedEl = document.getElementById(prefix + '-tags-related');
        const recentEl = document.getElementById(prefix + '-tags-recent');
        let tags = [];
        function render() {
            if (!chipsEl)
                return;
            chipsEl.innerHTML = '';
            for (let i = 0; i < tags.length; i++) {
                const chip = document.createElement('span');
                chip.className = 'ib-tag-chip';
                chip.innerHTML = escHtml(tags[i]) + ' <span class="ib-tag-chip-remove" data-idx="' + i + '">&times;</span>';
                chipsEl.appendChild(chip);
            }
            if (inputEl) {
                inputEl.disabled = tags.length >= TAG_MAX;
                inputEl.placeholder = tags.length >= TAG_MAX ? 'Max 5 tags' : 'Add tag...';
            }
        }
        function addTag(raw) {
            const val = raw.replace(/[,;]/g, '').trim().toLowerCase();
            if (!val || val.length > 30)
                return;
            if (tags.includes(val))
                return;
            if (tags.length >= TAG_MAX)
                return;
            tags.push(val);
            render();
            if (inputEl)
                inputEl.value = '';
        }
        function removeTag(idx) {
            tags.splice(idx, 1);
            render();
        }
        if (chipsEl) {
            chipsEl.addEventListener('click', e => {
                const rm = e.target.closest('.ib-tag-chip-remove');
                if (rm)
                    removeTag(parseInt(rm.dataset.idx));
            });
        }
        if (inputEl) {
            inputEl.addEventListener('keydown', e => {
                if (e.key === 'Enter' || e.key === ',') {
                    e.preventDefault();
                    addTag(inputEl.value);
                }
                else if (e.key === 'Backspace' && !inputEl.value && tags.length) {
                    removeTag(tags.length - 1);
                }
            });
            inputEl.addEventListener('blur', () => {
                if (inputEl.value.trim())
                    addTag(inputEl.value);
                setTimeout(() => { if (suggestionsEl)
                    suggestionsEl.style.display = 'none'; }, 200);
            });
            inputEl.addEventListener('focus', () => {
                updateSuggestions();
                if (suggestionsEl)
                    suggestionsEl.style.display = '';
            });
        }
        let _lastTitle = '', _lastBody = '';
        function updateSuggestions(title, body) {
            if (title !== undefined)
                _lastTitle = title;
            if (body !== undefined)
                _lastBody = body;
            if (!relatedEl || !recentEl)
                return;
            const related = suggestRelatedTags(_lastTitle, _lastBody);
            const filtered = related.filter(t => !tags.includes(t));
            relatedEl.innerHTML = '';
            for (const t of filtered) {
                const btn = document.createElement('span');
                btn.className = 'ib-tag-suggestion';
                btn.textContent = t;
                btn.addEventListener('mousedown', e => { e.preventDefault(); addTag(t); updateSuggestions(); });
                relatedEl.appendChild(btn);
            }
            if (filtered.length === 0)
                relatedEl.innerHTML = '<span style="font-size:0.7rem;color:rgba(255,255,255,0.25)">None found</span>';
            fetchRecentTags().then(recent => {
                const filtered = recent.filter(t => !tags.includes(t));
                recentEl.innerHTML = '';
                for (const t of filtered) {
                    const btn = document.createElement('span');
                    btn.className = 'ib-tag-suggestion';
                    btn.textContent = t;
                    btn.addEventListener('mousedown', e => { e.preventDefault(); addTag(t); updateSuggestions(); });
                    recentEl.appendChild(btn);
                }
                if (filtered.length === 0)
                    recentEl.innerHTML = '<span style="font-size:0.7rem;color:rgba(255,255,255,0.25)">None yet</span>';
            });
        }
        render();
        return {
            getTags: () => [...tags],
            setTags: (arr) => { tags = Array.isArray(arr) ? arr.slice(0, TAG_MAX) : []; render(); },
            updateSuggestions,
            addTag
        };
    }
    const postTags = createTagsInstance('post');
    const quoteTags = createTagsInstance('quote');
    /* ── Quoter History (localStorage) ── */
    function getQuoterHistory() { return []; }
    function saveQuoterToHistory() { /* no-op */ }
    function removeQuoterFromHistory(name) {
        /* no-op: quoters are now sourced from Supabase */
    }
    let _allQuoters = [];
    async function _loadQuotersFromDB() {
        try {
            const client = window.SupabaseStore && SupabaseStore.getClient();
            if (!client || !currentUser) return [];
            const { data, error } = await client.from('published_articles')
                .select('quote_from, quote_occupation')
                .eq('user_id', currentUser.id)
                .not('quote_from', 'eq', '')
                .not('quote_from', 'is', null)
                .order('date_published', { ascending: false });
            if (error || !data) return [];
            return data;
        } catch (_) { return []; }
    }
    function initQuoterDropdown() {
        const fromInput = $('#quote-from');
        const occInput = $('#quote-occupation');
        const dropdown = $('#quoter-dropdown');
        if (!fromInput || !dropdown) return;
        _loadQuotersFromDB().then(_setQuoters);
        function showDropdown(query) {
            if (!_allQuoters.length) { dropdown.style.display = 'none'; return; }
            const q = (query || '').toLowerCase().trim();
            const matches = q
                ? _allQuoters.filter(h => h.name.toLowerCase().includes(q) || (h.occupation || '').toLowerCase().includes(q))
                : _allQuoters;
            if (!matches.length) { dropdown.style.display = 'none'; return; }
            dropdown.innerHTML = matches.slice(0, 10).map(h => {
                const occText = h.occupation ? '<span class="qd-sep"> — </span><span class="qd-occ">' + escHtml(h.occupation) + '</span>' : '';
                return '<div class="quoter-dropdown-item" data-qname="' + (h.name || '').replace(/"/g, '&quot;') + '" data-qocc="' + (h.occupation || '').replace(/"/g, '&quot;') + '">' +
                    '<span class="qd-name">' + escHtml(h.name) + '</span>' +
                    occText +
                    '</div>';
            }).join('');
            dropdown.style.display = '';
        }
        fromInput.addEventListener('input', () => showDropdown(fromInput.value));
        fromInput.addEventListener('focus', () => showDropdown(fromInput.value));
        fromInput.addEventListener('blur', () => { setTimeout(() => { dropdown.style.display = 'none'; }, 200); });
        dropdown.addEventListener('mousedown', e => {
            const item = e.target.closest('.quoter-dropdown-item');
            if (!item) return;
            e.preventDefault();
            fromInput.value = item.dataset.qname || '';
            if (occInput) occInput.value = item.dataset.qocc || '';
            dropdown.style.display = 'none';
        });
    }
    return {
        bindAll,
        setCurrentUser,
        openModal,
        closeModal,
        postTags,
        quoteTags
    };
})();
window.PublishModal = PublishModal;
