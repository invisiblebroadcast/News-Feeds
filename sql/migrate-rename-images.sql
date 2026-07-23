-- Rename existing images from IB00043.jpg → ibpost<last_modified>.jpg
-- Run in Supabase SQL Editor (runs as superuser, bypasses RLS).

-- Preview first (check the mappings are correct):
SELECT
  o.name AS old_name,
  'ibpost' || p.last_modified || '.jpg' AS new_name,
  p.post_id,
  p.last_modified
FROM storage.objects o
JOIN published_articles p
  ON o.name = 'IB' || LPAD(p.post_id::text, 5, '0') || '.jpg'
WHERE o.bucket_id = 'ib-post-images'
  AND p.last_modified IS NOT NULL;

-- Rename .jpg files:
UPDATE storage.objects o
SET name = 'ibpost' || p.last_modified || '.jpg'
FROM published_articles p
WHERE o.bucket_id = 'ib-post-images'
  AND o.name = 'IB' || LPAD(p.post_id::text, 5, '0') || '.jpg'
  AND p.last_modified IS NOT NULL;

-- Rename .png files:
UPDATE storage.objects o
SET name = 'ibpost' || p.last_modified || '.png'
FROM published_articles p
WHERE o.bucket_id = 'ib-post-images'
  AND o.name = 'IB' || LPAD(p.post_id::text, 5, '0') || '.png'
  AND p.last_modified IS NOT NULL;
