-- Add 'type' and 'quote_from' columns to published_articles
-- for the new Quotes post type.

-- 'type' distinguishes between regular feed posts and quotes.
-- Default 'feeds' keeps existing rows working.
ALTER TABLE published_articles
  ADD COLUMN IF NOT EXISTS type text NOT NULL DEFAULT 'feeds';

-- 'quote_from' stores who the quote is attributed to (e.g. a person's name).
ALTER TABLE published_articles
  ADD COLUMN IF NOT EXISTS quote_from text NOT NULL DEFAULT '';

-- 'quote_date' stores the date the quote was made/said (not the publish date).
-- Format: text, e.g. '2026-07-20'. Empty string means not set.
ALTER TABLE published_articles
  ADD COLUMN IF NOT EXISTS quote_date text NOT NULL DEFAULT '';

-- 'quote_occupation' stores the quoter's qualification/title (e.g. MP, MLA, Musician).
ALTER TABLE published_articles
  ADD COLUMN IF NOT EXISTS quote_occupation text NOT NULL DEFAULT '';

-- Index for filtering by type
CREATE INDEX IF NOT EXISTS idx_published_articles_type
  ON published_articles (type);
