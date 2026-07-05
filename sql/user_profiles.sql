-- ── User Profiles ──
-- Stores extended user profile information beyond what Supabase Auth
-- provides (email, hashed password). Each user gets one row, created
-- automatically on sign-up via a trigger.
--
-- RLS ensures users can only read/update their own profile.
--
-- Run this in your Supabase dashboard SQL editor.

-- 1. Create the table
create table if not exists user_profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  full_name     text not null default '',
  avatar_url    text not null default '',
  subscriptions text[] not null default '{}',
  app_settings  jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- 2. Auto-create a profile row when a new user signs up
create or replace function handle_new_user()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
begin
  insert into user_profiles (id, full_name, avatar_url)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'full_name', ''),
    coalesce(new.raw_user_meta_data ->> 'avatar_url', '')
  );
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- 3. Enable Row-Level Security
alter table user_profiles enable row level security;

-- 4. Drop existing policies (safe to re-run)
drop policy if exists "Users can view own profile" on user_profiles;
drop policy if exists "Users can insert own profile" on user_profiles;
drop policy if exists "Users can update own profile" on user_profiles;

-- 5. Create RLS policies
create policy "Users can view own profile"
  on user_profiles for select
  using (auth.uid() = id);

create policy "Users can insert own profile"
  on user_profiles for insert
  with check (auth.uid() = id);

create policy "Users can update own profile"
  on user_profiles for update
  using (auth.uid() = id);

-- 6. Index for quick lookups
create index if not exists idx_user_profiles_id on user_profiles (id);
