-- ── Custom Feed Sources ──
-- Each user can add RSS feeds that are personal to them.
-- When signed in, feeds are stored in Supabase (this table).
-- When signed out, feeds are stored in localStorage only.
--
-- RLS ensures users only see and modify their own feeds.
--
-- Run this SQL in your Supabase dashboard SQL editor.

-- 1. Create the table (idempotent — safe to run repeatedly)
create table if not exists custom_feeds (
  user_id    uuid references auth.users(id) on delete cascade not null,
  name       text not null,
  url        text not null,
  scope      text not null default 'global',
  nation     text not null default '',
  subcat     text not null default 'politics',
  lang       text not null default 'en',
  created_at timestamptz not null default now(),
  primary key (user_id, url)
);

-- 2. Enable Row-Level Security
alter table custom_feeds enable row level security;

-- 3. Drop existing policies (so re-running the script is clean)
drop policy if exists "Users can view their own custom feeds" on custom_feeds;
drop policy if exists "Users can insert their own custom feeds" on custom_feeds;
drop policy if exists "Users can update their own custom feeds" on custom_feeds;
drop policy if exists "Users can delete their own custom feeds" on custom_feeds;

-- 4. Create RLS policies
create policy "Users can view their own custom feeds"
  on custom_feeds for select
  using (auth.uid() = user_id);

create policy "Users can insert their own custom feeds"
  on custom_feeds for insert
  with check (auth.uid() = user_id);

create policy "Users can update their own custom feeds"
  on custom_feeds for update
  using (auth.uid() = user_id);

create policy "Users can delete their own custom feeds"
  on custom_feeds for delete
  using (auth.uid() = user_id);

-- 5. (Optional) Add indexes for performance
create index if not exists idx_custom_feeds_user_id on custom_feeds (user_id);
create index if not exists idx_custom_feeds_scope on custom_feeds (scope, nation);
