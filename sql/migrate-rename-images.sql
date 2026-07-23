-- Rename existing images to ibpost<epoch_ms>.jpg (safe filenames).
-- Run in Supabase SQL Editor (runs as superuser, bypasses RLS).

-- epoch_ms helper: same value that JS new Date(ts).getTime() produces
-- round(EXTRACT(EPOCH FROM timestamptz) * 1000)

-- Preview first:
SELECT
  o.name AS old_name,
  'ibpost' || round(EXTRACT(EPOCH FROM p.last_modified) * 1000) || '.jpg' AS new_name
FROM storage.objects o
JOIN published_articles p
  ON o.name IN (
    'IB' || LPAD(p.post_id::text, 5, '0') || '.jpg',
    'ibpost' || p.last_modified || '.jpg'
  )
WHERE o.bucket_id = 'ib-post-images'
  AND p.last_modified IS NOT NULL;

-- Rename old IB00043.jpg files:
UPDATE storage.objects o
SET name = 'ibpost' || round(EXTRACT(EPOCH FROM p.last_modified) * 1000) || '.jpg'
FROM published_articles p
WHERE o.bucket_id = 'ib-post-images'
  AND o.name = 'IB' || LPAD(p.post_id::text, 5, '0') || '.jpg'
  AND p.last_modified IS NOT NULL;

-- Rename old ibpost<timestamp>.jpg files (space-format from earlier migration):
UPDATE storage.objects o
SET name = 'ibpost' || round(EXTRACT(EPOCH FROM p.last_modified) * 1000) || '.jpg'
FROM published_articles p
WHERE o.bucket_id = 'ib-post-images'
  AND o.name = 'ibpost' || p.last_modified || '.jpg'
  AND p.last_modified IS NOT NULL;

-- Same for .png:

-- Rename old IB00043.png files:
UPDATE storage.objects o
SET name = 'ibpost' || round(EXTRACT(EPOCH FROM p.last_modified) * 1000) || '.png'
FROM published_articles p
WHERE o.bucket_id = 'ib-post-images'
  AND o.name = 'IB' || LPAD(p.post_id::text, 5, '0') || '.png'
  AND p.last_modified IS NOT NULL;

-- Rename old ibpost<timestamp>.png files:
UPDATE storage.objects o
SET name = 'ibpost' || round(EXTRACT(EPOCH FROM p.last_modified) * 1000) || '.png'
FROM published_articles p
WHERE o.bucket_id = 'ib-post-images'
  AND o.name = 'ibpost' || p.last_modified || '.png'
  AND p.last_modified IS NOT NULL;
