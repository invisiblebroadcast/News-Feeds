/**
 * migrate-images-v2.js — Rename Supabase Storage images to epoch-ms filenames.
 *
 * Handles both old formats:
 *   IB00043.jpg
 *   ibpost2026-07-23 09:59:17.850109+00.jpg  (broken space format)
 *
 * Target: ibpost<epoch_ms>.jpg
 *
 * Run in browser console while logged in as admin.
 */

(async function migrateImages() {
  const BUCKET = 'ib-post-images';

  const client = window.SupabaseStore && SupabaseStore.getClient();
  if (!client) {
    console.error('[migrate] Not logged in.');
    return;
  }

  /** Convert PostgREST timestamptz to PostgreSQL ::text format */
  function toPgText(ts) {
    if (!ts) return '';
    return ts.replace('T', ' ').replace(/([+-]\d{2}):00$/, '$1');
  }

  /** Convert timestamp to epoch ms (same as ibPostKey in app code) */
  function toEpochMs(ts) {
    return String(new Date(ts).getTime());
  }

  console.log('[migrate] Fetching articles...');
  const { data: articles, error: fetchErr } = await client
    .from('published_articles')
    .select('id, post_id, last_modified, type')
    .not('post_id', 'is', null)
    .in('type', ['quote', 'feeds'])
    .not('last_modified', 'is', null)
    .order('id');

  if (fetchErr) {
    console.error('[migrate] Fetch failed:', fetchErr.message);
    return;
  }

  console.log('[migrate] Found ' + articles.length + ' articles.');
  let migrated = 0, skipped = 0, failed = 0;

  for (const row of articles) {
    const ibId = 'IB' + String(row.post_id).padStart(5, '0');
    const newBase = 'ibpost' + toEpochMs(row.last_modified);

    // Check if the target already exists
    let alreadyExists = false;
    for (const ext of ['jpg', 'png']) {
      try {
        const { data: existing } = await client.storage.from(BUCKET).download(newBase + '.' + ext);
        if (existing) { alreadyExists = true; break; }
      } catch (e) { /* ignore */ }
    }
    if (alreadyExists) {
      console.log('[migrate] #' + row.id + ' — already at ' + newBase);
      skipped++;
      continue;
    }

    // Try all possible old source paths
    const oldPaths = [
      ibId + '.jpg',
      ibId + '.png',
      'ibpost' + toPgText(row.last_modified) + '.jpg',
      'ibpost' + toPgText(row.last_modified) + '.png'
    ];

    let sourceFile = null;
    let sourceExt = null;
    for (const path of oldPaths) {
      try {
        const { data: blob, error: dlErr } = await client.storage.from(BUCKET).download(path);
        if (!dlErr && blob) {
          sourceFile = blob;
          sourceExt = path.endsWith('.png') ? 'png' : 'jpg';
          console.log('[migrate] #' + row.id + ' — found at ' + path);
          break;
        }
      } catch (e) { /* ignore */ }
    }

    if (!sourceFile) {
      console.warn('[migrate] #' + row.id + ' — no source found, skipping');
      skipped++;
      continue;
    }

    // Upload with new name
    const newPath = newBase + '.' + sourceExt;
    const { error: upErr } = await client.storage.from(BUCKET).upload(newPath, sourceFile, {
      contentType: sourceExt === 'png' ? 'image/png' : 'image/jpeg',
      upsert: true,
      cacheControl: '0'
    });

    if (upErr) {
      console.error('[migrate] #' + row.id + ' — upload failed:', upErr.message);
      failed++;
      continue;
    }

    // Delete all old files
    for (const path of oldPaths) {
      await client.storage.from(BUCKET).remove([path]);
    }

    console.log('[migrate] #' + row.id + ' — done (' + newPath + ')');
    migrated++;
  }

  console.log('[migrate] Complete. Migrated: ' + migrated + ', Skipped: ' + skipped + ', Failed: ' + failed);
})();
