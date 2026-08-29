-- NOTE: Direct UPDATE on storage.objects only changes metadata,
-- not the actual S3 object. Use migrate-images-v2.js in the
-- browser console instead. It downloads each file and re-uploads
-- with the correct name.
--
-- To preview what the JS script will do:
SELECT
  id,
  post_id,
  last_modified,
  'IB' || LPAD(post_id::text, 5, '0') AS old_ib_name,
  'ibpost' || to_char(last_modified, 'YYYY-MM-DD" "HH24:MI:SS.USOF') AS old_ibpost_name,
  'ibpost' || round(EXTRACT(EPOCH FROM last_modified) * 1000) AS new_name
FROM published_articles
WHERE post_id IS NOT NULL
  AND type IN ('quote', 'feeds')
  AND last_modified IS NOT NULL
ORDER BY id;
