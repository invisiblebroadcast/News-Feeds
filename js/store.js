// @ts-nocheck
const CloudStore = (() => {
    const GITHUB_OWNER = 'invisiblebroadcast';
    const GITHUB_REPO = 'News-Feeds';
    const GITHUB_PATH = 'data/article-data.json';
    const GITHUB_BRANCH = 'main';
    const RAW_URL = `https://raw.githubusercontent.com/${GITHUB_OWNER}/${GITHUB_REPO}/${GITHUB_BRANCH}/${GITHUB_PATH}`;
    const API_URL = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${GITHUB_PATH}`;
    const CACHE_KEY = 'newsfeeds_article_data_cache';
    const TOKEN_KEY = 'github_token';
    let saveTimer = null;
    let pendingData = null;
    function getToken() {
        try {
            return localStorage.getItem(TOKEN_KEY) || '';
        }
        catch {
            return '';
        }
    }
    function readCache() {
        try {
            return JSON.parse(localStorage.getItem(CACHE_KEY) || '{}');
        }
        catch {
            return {};
        }
    }
    function writeCache(data) {
        try {
            localStorage.setItem(CACHE_KEY, JSON.stringify(data));
        }
        catch { }
    }
    async function load() {
        try {
            const res = await fetch(RAW_URL, { cache: 'no-cache' });
            if (!res.ok)
                throw new Error('HTTP ' + res.status);
            const data = await res.json();
            writeCache(data);
            return data;
        }
        catch (err) {
            console.warn('CloudStore: failed to load from GitHub, using cache:', err.message);
            return readCache();
        }
    }
    function hasToken() { return !!getToken(); }
    function get(key) {
        const all = readCache();
        return all[key] || {};
    }
    function set(key, value) {
        const all = readCache();
        if (value.flag || value.note || value.like || value.dislike || value.viewed)
            all[key] = value;
        else
            delete all[key];
        writeCache(all);
        if (getToken())
            scheduleSave(all);
    }
    function scheduleSave(data) {
        pendingData = data;
        if (saveTimer)
            clearTimeout(saveTimer);
        saveTimer = setTimeout(commit, 5000);
    }
    async function commit(data) {
        const payload = data || pendingData;
        if (!payload)
            return;
        saveTimer = null;
        pendingData = null;
        const token = getToken();
        if (!token)
            return;
        try {
            let sha = null;
            const metaRes = await fetch(API_URL, {
                headers: { Authorization: 'token ' + token, Accept: 'application/vnd.github.v3+json' }
            });
            if (metaRes.ok) {
                const meta = await metaRes.json();
                sha = meta.sha;
            }
            const json = JSON.stringify(payload, null, 2);
            const bytes = new TextEncoder().encode(json);
            let binary = '';
            for (const b of bytes)
                binary += String.fromCharCode(b);
            const content = btoa(binary);
            const body = { message: 'update article data', content: content, branch: GITHUB_BRANCH };
            if (sha)
                body.sha = sha;
            const putRes = await fetch(API_URL, {
                method: 'PUT',
                headers: {
                    Authorization: 'token ' + token,
                    Accept: 'application/vnd.github.v3+json',
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(body)
            });
            if (!putRes.ok) {
                const errText = await putRes.text();
                console.warn('CloudStore: GitHub commit failed (' + putRes.status + '):', errText);
            }
        }
        catch (err) {
            console.warn('CloudStore: commit error:', err.message);
        }
    }
    function getAll() {
        return readCache();
    }
    return { load, get, set, hasToken, getAll };
})();
