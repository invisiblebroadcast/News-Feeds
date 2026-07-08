-- Sequential post_id for published_articles.
-- The existing 'id' is a UUID PK. We add a separate 'post_id'
-- integer that auto-increments and is used as the public-facing
-- identifier (and as the image filename for quote images).

-- 1. Create the sequence
CREATE SEQUENCE IF NOT EXISTS published_articles_post_id_seq;

-- 2. Add the column with a default from the sequence
ALTER TABLE published_articles
  ADD COLUMN IF NOT EXISTS post_id integer
  DEFAULT nextval('published_articles_post_id_seq');

-- 3. Backfill any existing rows that have NULL post_id
UPDATE published_articles SET post_id = nextval('published_articles_post_id_seq')
WHERE post_id IS NULL;

-- 4. Make NOT NULL after backfill
ALTER TABLE published_articles
  ALTER COLUMN post_id SET NOT NULL;

-- 5. Unique constraint (one post_id per row)
ALTER TABLE published_articles
  ADD CONSTRAINT published_articles_post_id_key UNIQUE (post_id);

-- 6. Set the sequence to start after the current max
SELECT setval('published_articles_post_id_seq',
  COALESCE((SELECT MAX(post_id) FROM published_articles), 0) + 1);

-- ─── Supabase Storage bucket for quote images ───
-- Run this in the Supabase Dashboard → Storage → New Bucket,
-- OR via the SQL editor if your project allows storage inserts:
--
--   Bucket name: ib-post-images
--   Public: true (so images are accessible via URL)
--   File size limit: 2 MB
--   Allowed MIME types: image/png, image/jpeg
--
-- RLS policy for the bucket (allows authenticated uploads,
-- public reads):
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'ib-post-images',
  'ib-post-images',
  true,
  2097152,  -- 2 MB
  ARRAY['image/png', 'image/jpeg']
)
ON CONFLICT (id) DO UPDATE SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Allow authenticated users to upload to ib-post-images
CREATE POLICY "Authenticated users can upload quote images"
ON storage.objects FOR INSERT
TO authenticated
WITH CHECK (bucket_id = 'ib-post-images');

-- Allow anyone to read from ib-post-images (public bucket)
CREATE POLICY "Public read access for quote images"
ON storage.objects FOR SELECT
TO public
USING (bucket_id = 'ib-post-images');

-- Allow the owner to delete their own uploads
CREATE POLICY "Owners can delete their quote images"
ON storage.objects FOR DELETE
TO authenticated
USING (bucket_id = 'ib-post-images' AND auth.uid() = owner);
