/**
 * migrate-images-v2.js — Rename Supabase Storage images to epoch-ms filenames.
 *
 * The SQL UPDATE approach only changes metadata, not actual S3 data.
 * This script uses the Storage API to properly migrate:
 *   1. Download from old path (IB00043.jpg or ibpost<space>.jpg)
 *   2. Upload to new path (ibpost<epoch_ms>.jpg)
 *   3. Delete old path
 *
 * Run in browser console while logged in as admin.
 */

(async function migrateImages() {
  const BUCKET = 'ib-post-images';

  const client = window.SupabaseStore && SupabaseStore.getClient();
  if (!client) {
    console.error('[migrate] SupabaseStore not found. Are you on the app page?');
    return;
  }

  // Verify authentication
  const { data: { session }, error: sessErr } = await client.auth.getSession();
  if (sessErr || !session) {
    console.error('[migrate] NOT LOGGED IN. Please log in to the app first, then re-run this script.');
    console.error('[migrate] Session error:', sessErr?.message || 'no session');
    return;
  }
  console.log('[migrate] Authenticated as:', session.user.email || session.user.id);

  /** Convert timestamp to epoch ms (same as ibPostKey in app code) */
  function toEpochMs(ts) {
    return String(new Date(ts).getTime());
  }

  /** Convert PostgREST timestamptz to filename-safe format */
  function toSafeTs(ts) {
    if (!ts) return '';
    return ts.replace('T', ' ').replace(/([+-]\d{2}):00$/, '$1');
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
    const safeTs = toSafeTs(row.last_modified);

    // Check if target already exists (actual upload, not just metadata)
    let alreadyExists = false;
    for (const ext of ['jpg', 'png']) {
      try {
        const { data: existing, error: ckErr } = await client.storage.from(BUCKET).download(newBase + '.' + ext);
        if (!ckErr && existing) {
          alreadyExists = true;
          break;
        }
      } catch (e) { /* ignore */ }
    }
    if (alreadyExists) {
      console.log('[migrate] #' + row.post_id + ' — already at ' + newBase);
      skipped++;
      continue;
    }

    // Try all possible old source paths (IB original + space-format from first SQL migration)
    const oldPaths = [
      ibId + '.jpg',
      ibId + '.png',
      'ibpost' + safeTs + '.jpg',
      'ibpost' + safeTs + '.png'
    ];

    let sourceFile = null;
    let sourceExt = null;
    for (const path of oldPaths) {
      try {
        const { data: blob, error: dlErr } = await client.storage.from(BUCKET).download(path);
        if (!dlErr && blob) {
          sourceFile = blob;
          sourceExt = path.endsWith('.png') ? 'png' : 'jpg';
          console.log('[migrate] #' + row.post_id + ' — found at ' + path);
          break;
        }
      } catch (e) { /* ignore */ }
    }

    if (!sourceFile) {
      console.warn('[migrate] #' + row.post_id + ' — no source found, skipping');
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
      console.error('[migrate] #' + row.post_id + ' — upload failed:', upErr.message);
      failed++;
      continue;
    }

    // Delete old files (best effort)
    for (const path of oldPaths) {
      if (path !== newPath) {
        const { error: rmErr } = await client.storage.from(BUCKET).remove([path]);
        if (rmErr) {
          console.warn('[migrate] #' + row.post_id + ' — delete old ' + path + ' failed:', rmErr.message);
        }
      }
    }

    console.log('[migrate] #' + row.post_id + ' — done (' + newPath + ')');
    migrated++;
  }

  console.log('[migrate] Complete. Migrated: ' + migrated + ', Skipped: ' + skipped + ', Failed: ' + failed);
})();
