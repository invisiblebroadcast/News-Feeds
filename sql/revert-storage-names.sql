-- REVERT: undo SQL renames so files are accessible again.
-- The SQL UPDATE only changed metadata, not actual S3 data.
-- This restores names to IB00043.jpg so the JS migration can find them.
-- Run in Supabase SQL Editor.

-- Revert ibpost<epoch_ms> files back to IB format
UPDATE storage.objects o
SET name = 'IB' || LPAD(p.post_id::text, 5, '0') ||
  CASE WHEN o.name LIKE '%.png' THEN '.png' ELSE '.jpg' END
FROM published_articles p
WHERE o.bucket_id = 'ib-post-images'
  AND o.name LIKE 'ibpost%.%'
  AND p.post_id IS NOT NULL
  AND p.last_modified IS NOT NULL
  AND round(EXTRACT(EPOCH FROM p.last_modified) * 1000)::bigint =
    replace(
      replace(o.name, 'ibpost', ''),
      CASE WHEN o.name LIKE '%.png' THEN '.png' ELSE '.jpg' END,
      ''
    )::bigint;

-- Verify
SELECT name FROM storage.objects
WHERE bucket_id = 'ib-post-images'
ORDER BY name;
