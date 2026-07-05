// @ts-nocheck
/* ── Publish Modal ──
 *
 * YouTube transcript → Jekyll post publishing pipeline.
 * FAB + modal with YouTube/Audio tabs. Only visible to
 * signed-in users.
 *
 * Dependencies:
 *   - SupabaseStore (for auth user id)
 *   - GitHub REST API (for committing _posts/*.md)
 *   - youtubetranscript.com API (free, no API key)
 */
const PublishModal = (() => {
    const GITHUB_CONFIG_KEY = 'newsfeeds_github_config';
    function $(sel, ctx) { return (ctx || document).querySelector(sel); }
    function $$(sel, ctx) { return [...(ctx || document).querySelectorAll(sel)]; }
    let currentUser = null;
    let publishedPosts = [];
    let editingPost = null;
    /* ── GitHub config persistence ── */
    function loadGithubConfig() {
        try {
            return JSON.parse(localStorage.getItem(GITHUB_CONFIG_KEY) || '{}');
        }
        catch {
            return {};
        }
    }
    function saveGithubConfig(config) {
        localStorage.setItem(GITHUB_CONFIG_KEY, JSON.stringify(config));
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
    /* ── Jekyll post helpers ── */
    function slugify(text) {
        return text
            .toLowerCase()
            .replace(/[^\w\s-]/g, '')
            .replace(/\s+/g, '-')
            .replace(/-+/g, '-')
            .replace(/^-|-$/g, '')
            .substring(0, 80) || 'post';
    }
    function formatUtcDate(date) {
        const y = date.getUTCFullYear();
        const m = String(date.getUTCMonth() + 1).padStart(2, '0');
        const d = String(date.getUTCDate()).padStart(2, '0');
        const hh = String(date.getUTCHours()).padStart(2, '0');
        const mm = String(date.getUTCMinutes()).padStart(2, '0');
        const ss = String(date.getUTCSeconds()).padStart(2, '0');
        return `${y}-${m}-${d} ${hh}:${mm}:${ss} +0000`;
    }
    function buildPostContent(title, dateStr, authorId, youtubeUrl, description) {
        const escapedTitle = (title || '').replace(/"/g, '\\"');
        return '---\n' +
            `title: "${escapedTitle}"\n` +
            `date: ${dateStr}\n` +
            `author_id: ${authorId}\n` +
            `youtube_url: ${youtubeUrl}\n` +
            `layout: post\n` +
            '---\n' +
            '\n' +
            (description || '');
    }
    /* ── GitHub API ── */
    async function githubRequest(path, method, body, token) {
        const res = await fetch(`https://api.github.com${path}`, {
            method: method || 'GET',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Accept': 'application/vnd.github.v3+json',
                'Content-Type': 'application/json'
            },
            body: body ? JSON.stringify(body) : undefined
        });
        const data = await res.json();
        if (!res.ok)
            throw new Error(data.message || `GitHub API error: ${res.status}`);
        return data;
    }
    async function getSha(owner, repo, path, token) {
        try {
            const data = await githubRequest(`/repos/${owner}/${repo}/contents/${path}`, 'GET', null, token);
            return data.sha;
        }
        catch {
            return null;
        }
    }
    function base64Encode(str) {
        return btoa(unescape(encodeURIComponent(str)));
    }
    async function publishPost(title, description, youtubeUrl) {
        const config = loadGithubConfig();
        if (!config.owner || !config.repo || !config.token) {
            throw new Error('Please configure your GitHub repository in the settings above');
        }
        const now = new Date();
        const dateStr = formatUtcDate(now);
        const slug = slugify(title);
        const filename = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}-${slug}.md`;
        const filePath = `_posts/${filename}`;
        const content = buildPostContent(title, dateStr, currentUser.id, youtubeUrl, description);
        const existingSha = editingPost ? editingPost.sha : await getSha(config.owner, config.repo, filePath, config.token);
        const body = {
            message: existingSha ? `Update post: ${title}` : `New post: ${title}`,
            content: base64Encode(content),
            branch: 'main'
        };
        if (existingSha)
            body.sha = existingSha;
        await githubRequest(`/repos/${config.owner}/${config.repo}/contents/${filePath}`, 'PUT', body, config.token);
        return { filename, path: filePath };
    }
    /* ── Frontmatter parsing ── */
    function parseFrontmatter(content) {
        const match = content.match(/^---\n([\s\S]*?)\n---\n/);
        if (!match)
            return null;
        const fm = {};
        for (const line of match[1].split('\n')) {
            const parts = line.match(/^(\w+):\s*(.+)$/);
            if (parts) {
                let val = parts[2].trim();
                if (val.startsWith('"') && val.endsWith('"'))
                    val = val.slice(1, -1);
                fm[parts[1]] = val;
            }
        }
        return fm;
    }
    /* ── Edit window check ── */
    function canEdit(frontmatter) {
        if (!frontmatter || !frontmatter.author_id || !frontmatter.date)
            return false;
        if (frontmatter.author_id !== currentUser.id)
            return false;
        const postDate = new Date(frontmatter.date + ' UTC');
        if (isNaN(postDate.getTime()))
            return false;
        const diff = Date.now() - postDate.getTime();
        return diff < 30 * 60 * 1000;
    }
    /* ── Fetch user's posts from _posts ── */
    async function fetchMyPosts() {
        const config = loadGithubConfig();
        if (!config.owner || !config.repo || !config.token)
            return [];
        try {
            const data = await githubRequest(`/repos/${config.owner}/${config.repo}/contents/_posts`, 'GET', null, config.token);
            if (!Array.isArray(data))
                return [];
            const posts = [];
            for (const item of data) {
                if (!item.name.endsWith('.md'))
                    continue;
                try {
                    const content = await githubRequest(`/repos/${config.owner}/${config.repo}/contents/_posts/${item.name}`, 'GET', null, config.token);
                    if (!content.content)
                        continue;
                    const decoded = decodeURIComponent(escape(atob(content.content)));
                    const fm = parseFrontmatter(decoded);
                    if (fm && fm.author_id === currentUser.id) {
                        posts.push({
                            name: item.name,
                            path: `_posts/${item.name}`,
                            sha: content.sha,
                            frontmatter: fm,
                            rawContent: decoded
                        });
                    }
                }
                catch { }
            }
            return posts;
        }
        catch (e) {
            console.warn('[PublishModal] Failed to fetch posts:', e.message);
            return [];
        }
    }
    function getTimeRemaining(dateStr) {
        const postDate = new Date(dateStr + ' UTC');
        const elapsed = Date.now() - postDate.getTime();
        const remaining = 30 * 60 * 1000 - elapsed;
        if (remaining <= 0)
            return '';
        const mins = Math.floor(remaining / 60000);
        const secs = Math.floor((remaining % 60000) / 1000);
        return `${mins}m ${secs}s left`;
    }
    /* ── Render "My Posts" ── */
    async function renderMyPosts() {
        const list = $('#my-posts-list');
        if (!list)
            return;
        const posts = await fetchMyPosts();
        publishedPosts = posts;
        if (!posts.length) {
            list.innerHTML = '<div style="color:var(--text-tertiary);font-size:0.82rem;">No published posts found.</div>';
            return;
        }
        list.innerHTML = posts.map(p => {
            const editable = canEdit(p.frontmatter);
            const timeLeft = editable ? getTimeRemaining(p.frontmatter.date) : '';
            return '<div class="my-post-item">' +
                '<span class="my-post-title" title="' + escAttr(p.frontmatter.title || p.name) + '">' + escHtml(p.frontmatter.title || p.name) + '</span>' +
                (timeLeft ? '<span style="font-size:0.7rem;color:var(--text-tertiary);flex-shrink:0;">' + timeLeft + '</span>' : '') +
                '<button class="btn my-post-edit-btn" data-post-path="' + escAttr(p.path) + '"' + (!editable ? ' disabled title="Edit window expired (30 min)"' : '') + '>Edit</button>' +
                '</div>';
        }).join('');
        list.querySelectorAll('.my-post-edit-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const path = btn.dataset.postPath;
                const post = publishedPosts.find(p => p.path === path);
                if (!post || !canEdit(post.frontmatter))
                    return;
                loadPostForEditing(post);
            });
        });
    }
    function loadPostForEditing(post) {
        editingPost = post;
        const titleInput = $('#publish-title');
        const descInput = $('#publish-desc');
        const urlInput = $('#publish-url');
        const publishBtn = $('#publish-btn');
        if (titleInput)
            titleInput.value = post.frontmatter.title || '';
        if (descInput) {
            const body = post.rawContent.replace(/^---\n[\s\S]*?\n---\n/, '').trim();
            descInput.value = body;
        }
        if (urlInput)
            urlInput.value = post.frontmatter.youtube_url || '';
        if (publishBtn)
            publishBtn.textContent = 'Update Post';
        showTab('youtube');
    }
    /* ── Tab switching ── */
    function showTab(tab) {
        $$('.publish-tab').forEach(t => t.classList.toggle('active', t.dataset.publishTab === tab));
        $$('.publish-pane').forEach(p => p.classList.toggle('active', p.dataset.publishPane === tab));
    }
    /* ── FAB visibility (called from app-home.js updateAuthUI) ── */
    function updateFabVisibility() {
        const fab = $('#publish-fab');
        if (!fab)
            return;
        fab.classList.toggle('fab-hidden', !currentUser);
    }
    function setCurrentUser(user) {
        currentUser = user;
        updateFabVisibility();
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
        const publishBtn = $('#publish-btn');
        if (publishBtn) {
            publishBtn.disabled = true;
            publishBtn.textContent = 'Publishing\u2026';
        }
        try {
            await publishPost(title, desc, url || '');
            const action = editingPost ? 'updated' : 'published';
            setMsg(msg, `Post ${action} successfully! It may take a few minutes to appear on the site.`, 'success');
            editingPost = null;
            if (publishBtn)
                publishBtn.textContent = 'Publish';
            await renderMyPosts();
        }
        catch (e) {
            setMsg(msg, e.message || 'Publish failed', 'error');
        }
        finally {
            if (publishBtn)
                publishBtn.disabled = false;
        }
    }
    function openModal() {
        const modal = $('#publish-modal');
        if (!modal)
            return;
        editingPost = null;
        const publishBtn = $('#publish-btn');
        if (publishBtn)
            publishBtn.textContent = 'Publish';
        const msg = $('#publish-msg');
        if (msg) {
            msg.textContent = '';
            msg.className = 'publish-msg';
        }
        const config = loadGithubConfig();
        const ownerInput = $('#publish-github-owner');
        const repoInput = $('#publish-github-repo');
        const tokenInput = $('#publish-github-token');
        if (ownerInput)
            ownerInput.value = config.owner || '';
        if (repoInput)
            repoInput.value = config.repo || '';
        if (tokenInput)
            tokenInput.value = config.token || '';
        renderMyPosts();
        if (window.appState && typeof window.appState.openModal === 'function') {
            window.appState.openModal('publish', modal);
        }
        else {
            modal.classList.add('open');
        }
        showTab('youtube');
    }
    function closeModal() {
        if (window.appState && typeof window.appState.closeModal === 'function') {
            window.appState.closeModal('publish');
        }
        else {
            const modal = $('#publish-modal');
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
        const publishBtn = $('#publish-btn');
        if (publishBtn) {
            publishBtn.addEventListener('click', handlePublish);
        }
        const closeBtn = $('#publish-modal-close');
        if (closeBtn)
            closeBtn.addEventListener('click', closeModal);
        const modal = $('#publish-modal');
        if (modal) {
            modal.addEventListener('click', e => {
                if (e.target === modal)
                    closeModal();
            });
        }
        ['publish-github-owner', 'publish-github-repo', 'publish-github-token'].forEach(id => {
            const input = $(`#${id}`);
            if (input) {
                input.addEventListener('input', () => {
                    const config = {
                        owner: $('#publish-github-owner')?.value?.trim() || '',
                        repo: $('#publish-github-repo')?.value?.trim() || '',
                        token: $('#publish-github-token')?.value?.trim() || ''
                    };
                    saveGithubConfig(config);
                });
            }
        });
    }
    function escHtml(s) {
        return (s == null ? '' : String(s)).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
    function escAttr(s) {
        return (s == null ? '' : String(s)).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
    return {
        bindAll,
        setCurrentUser,
        openModal,
        closeModal
    };
})();
window.PublishModal = PublishModal;
