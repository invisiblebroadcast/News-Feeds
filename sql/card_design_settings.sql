-- ── card_design_settings ──
-- Stores per-post quote card design/studio settings as JSONB.
-- Each row maps a published_articles UUID to its full design config
-- so the editor can reload state when reopening.

CREATE TABLE IF NOT EXISTS card_design_settings (
  id           UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  article_id   UUID NOT NULL REFERENCES published_articles(id) ON DELETE CASCADE,
  user_id      UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  design_data  JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ DEFAULT now(),
  updated_at   TIMESTAMPTZ DEFAULT now(),
  UNIQUE(article_id, user_id)
);

-- Auto-update updated_at on modification
CREATE OR REPLACE FUNCTION update_card_design_settings_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS card_design_settings_updated_at ON card_design_settings;
CREATE TRIGGER card_design_settings_updated_at
  BEFORE UPDATE ON card_design_settings
  FOR EACH ROW
  EXECUTE FUNCTION update_card_design_settings_timestamp();

-- Index for fast lookups by article
CREATE INDEX IF NOT EXISTS idx_card_design_settings_article
  ON card_design_settings(article_id);

-- ── Row Level Security ──
ALTER TABLE card_design_settings ENABLE ROW LEVEL SECURITY;

-- Users can read their own settings
CREATE POLICY "Users read own card design settings"
  ON card_design_settings FOR SELECT
  USING (auth.uid() = user_id);

-- Users can insert their own settings
CREATE POLICY "Users insert own card design settings"
  ON card_design_settings FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- Users can update their own settings
CREATE POLICY "Users update own card design settings"
  ON card_design_settings FOR UPDATE
  USING (auth.uid() = user_id);

-- Users can delete their own settings
CREATE POLICY "Users delete own card design settings"
  ON card_design_settings FOR DELETE
  USING (auth.uid() = user_id);
