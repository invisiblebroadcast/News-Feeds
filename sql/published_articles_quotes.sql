-- Add 'type' and 'quote_from' columns to published_articles
-- for the new Quotes post type.

-- 'type' distinguishes between regular feed posts and quotes.
-- Default 'feeds' keeps existing rows working.
ALTER TABLE published_articles
  ADD COLUMN IF NOT EXISTS type text NOT NULL DEFAULT 'feeds';

-- 'quote_from' stores who the quote is attributed to (e.g. a person's name).
ALTER TABLE published_articles
  ADD COLUMN IF NOT EXISTS quote_from text NOT NULL DEFAULT '';

-- Index for filtering by type
CREATE INDEX IF NOT EXISTS idx_published_articles_type
  ON published_articles (type);
