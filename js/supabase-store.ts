// @ts-nocheck
const SUPABASE_URL = 'https://yokftwevcspbpbnwmrnb.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inlva2Z0d2V2Y3NwYnBibndtcm5iIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODEyNjEzNzEsImV4cCI6MjA5NjgzNzM3MX0.zfdj2115WsFw2KFyFkW54W-ShDNRwtKxQ8UiKNfF7U0';

const SupabaseStore = (() => {
  const { createClient } = supabase;
  const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const CACHE_KEY = 'newsfeeds_article_data_supa';

  function readCache() {
    try { return JSON.parse(localStorage.getItem(CACHE_KEY) || '{}'); }
    catch { return {}; }
  }

  function writeCache(data) {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(data)); }
    catch {}
  }

  function userId() {
    const u = client.auth.getUser();
    return u?.data?.user?.id || null;
  }

  async function ensureSession() {
    const { data } = await client.auth.getSession();
    return data?.session || null;
  }

  async function load() {
    const session = await ensureSession();
    if (!session) return readCache();
    const { data, error } = await client
      .from('article_activities')
      .select('*')
      .eq('user_id', session.user.id);
    if (error) { console.warn('SupabaseStore: load error', error.message); return readCache(); }
    const map = {};
    if (data) {
      for (const row of data) {
        map[row.article_url] = {
          articleTitle: row.article_title,
          articleSource: row.article_source,
          viewed: row.viewed_at ? new Date(row.viewed_at).getTime() : undefined,
          like: row.liked || undefined,
          dislike: row.disliked || undefined,
          flag: row.flag || undefined,
          note: row.note || undefined
        };
      }
    }
    writeCache(map);
    return map;
  }

  function get(link) {
    const all = readCache();
    return all[link] || {};
  }

  async function set(link, value) {
    const all = readCache();
    if (value.flag || value.note || value.like || value.dislike || value.viewed) all[link] = value;
    else delete all[link];
    writeCache(all);

    const session = await ensureSession();
    if (!session) return;
    const record = {
      user_id: session.user.id,
      article_url: link,
      article_title: value.articleTitle || null,
      article_source: value.articleSource || null,
      viewed_at: value.viewed ? new Date(value.viewed).toISOString() : null,
      liked: !!value.like,
      disliked: !!value.dislike,
      flag: value.flag || null,
      note: value.note || null
    };
    const { error } = await client
      .from('article_activities')
      .upsert(record, { onConflict: 'user_id,article_url' });
    if (error) console.warn('SupabaseStore: upsert error', error.message);
  }

  function getAll() {
    return readCache();
  }

  function getClient() { return client; }

  return { load, get, set, getAll, getClient };
})();

// Expose on window — see js/feeds.js for the rationale.
window.SupabaseStore = SupabaseStore;
