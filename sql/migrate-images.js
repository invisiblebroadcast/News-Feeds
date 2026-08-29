/**
 * migrate-images.js — Rename Supabase Storage images from
 *   IB00043.jpg  →  ibpost<last_modified>.jpg
 *
 * Run in the browser console while logged in as an admin user.
 *
 * Usage:
 *   1. Open the Invisible Broadcast app in your browser
 *   2. Sign in as an admin
 *   3. Open DevTools → Console
 *   4. Paste this entire script and press Enter
 *   5. Watch the logs — it will process each article sequentially
 */

(async function migrateImages() {
  const BUCKET = 'ib-post-images';

  /** Convert timestamptz to epoch milliseconds for safe filenames. */
  function ibPostKey(ts) {
    if (!ts) return '';
    return String(new Date(ts).getTime());
  }

  // Get the Supabase client from the page
  const client = window.SupabaseStore && SupabaseStore.getClient();
  if (!client) {
    return;
  }
  const { data: articles, error: fetchErr } = await client
    .from('published_articles')
    .select('id, post_id, last_modified, type')
    .not('post_id', 'is', null)
    .in('type', ['quote', 'feeds'])
    .not('last_modified', 'is', null)
    .order('id');

  if (fetchErr) {
    return;
  }
  let migrated = 0;
  let skipped = 0;
  let failed = 0;

  for (const row of articles) {
    const oldBase = 'IB' + String(row.post_id).padStart(5, '0');
    const newBase = 'ibpost' + ibPostKey(row.last_modified);

    // Skip if old and new names are the same (shouldn't happen, but safe)
    if (oldBase === newBase) {
      skipped++;
      continue;
    }

    // Try to download the old image (.jpg first, then .png)
    let sourceFile = null;
    let sourceExt = null;
    for (const ext of ['jpg', 'png']) {
      const oldPath = oldBase + '.' + ext;
      try {
        const { data: blob, error: dlErr } = await client.storage
          .from(BUCKET)
          .download(oldPath);
        if (!dlErr && blob) {
          sourceFile = blob;
          sourceExt = ext;
          break;
        }
      } catch (e) {
        // ignore
      }
    }

    if (!sourceFile) {
      // Also try the new name — maybe already migrated
      let alreadyMigrated = false;
      for (const ext of ['jpg', 'png']) {
        const newPath = newBase + '.' + ext;
        try {
          const { data: existing } = await client.storage
            .from(BUCKET)
            .download(newPath);
          if (existing) {
            alreadyMigrated = true;
            break;
          }
        } catch (e) {
          // ignore
        }
      }
      if (alreadyMigrated) {
        skipped++;
        continue;
      }
      skipped++;
      continue;
    }

    // Upload to new path
    const newPath = newBase + '.' + sourceExt;
    const { error: upErr } = await client.storage
      .from(BUCKET)
      .upload(newPath, sourceFile, {
        contentType: sourceExt === 'png' ? 'image/png' : 'image/jpeg',
        upsert: true,
        cacheControl: '0'
      });

    if (upErr) {
      failed++;
      continue;
    }

    // Delete old files
    for (const ext of ['jpg', 'png']) {
      await client.storage.from(BUCKET).remove([oldBase + '.' + ext]);
    }
    migrated++;
  }
})();
