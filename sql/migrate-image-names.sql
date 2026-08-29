-- Migrate image filenames from IB00043.jpg → ibpost<last_modified>.jpg
--
-- STEP 1: Preview — run this first to verify the mappings are correct.
-- This shows old filename → new filename for every article that has images.

SELECT
  id,
  post_id,
  last_modified,
  'IB' || LPAD(post_id::text, 5, '0') AS old_name,
  'ibpost' || last_modified::text     AS new_name
FROM published_articles
WHERE post_id IS NOT NULL
  AND type IN ('quote', 'feeds')
  AND last_modified IS NOT NULL
ORDER BY id;

-- STEP 2: Run the JS migration script (migrate-images.js) in the browser
-- console while logged in as an admin user. It will:
--   1. Fetch all articles with post_id + last_modified
--   2. For each: download old image (IB00043.jpg), upload as (ibpost<ts>.jpg)
--   3. Delete the old file from storage
--
-- STEP 3: After the JS migration completes, optionally clean up the
-- formatPostId function (no longer needed for image paths).
