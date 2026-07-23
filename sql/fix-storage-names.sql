-- Fix storage names: everything → ibpost<epoch_ms>.ext
-- Run in Supabase SQL Editor (superuser).

-- 1) IB-prefixed files → ibpost<epoch_ms>
UPDATE storage.objects o
SET name = 'ibpost' || round(EXTRACT(EPOCH FROM p.last_modified) * 1000) ||
  CASE WHEN o.name LIKE '%.png' THEN '.png' ELSE '.jpg' END
FROM published_articles p
WHERE o.bucket_id = 'ib-post-images'
  AND (o.name = 'IB' || LPAD(p.post_id::text, 5, '0') || '.jpg'
    OR o.name = 'IB' || LPAD(p.post_id::text, 5, '0') || '.png')
  AND p.last_modified IS NOT NULL;

-- 2) ibpost<space timestamp> files → ibpost<epoch_ms>
--    Parse the timestamp from the filename, convert to epoch ms
UPDATE storage.objects o
SET name = 'ibpost' || round(EXTRACT(EPOCH FROM
    (REPLACE(REPLACE(REPLACE(o.name, 'ibpost', ''), '.jpg', ''), '.png', '') || ':00')::timestamptz
  ) * 1000) ||
  CASE WHEN o.name LIKE '%.png' THEN '.png' ELSE '.jpg' END
WHERE o.bucket_id = 'ib-post-images'
  AND o.name LIKE 'ibpost2026%';
