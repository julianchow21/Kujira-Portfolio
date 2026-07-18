-- ===========================================================================
-- Kujira Forex — Supabase schema
-- Phase 1 is single-user and fully local (no cloud needed). Run this when you
-- enable cloud sync. Written for the multi-user target (RLS option C), so the
-- jump to Phase 2 (accounts + billing) needs no schema rewrite.
-- Row shape matches the client: id (text), data (jsonb), updated_at, user_id.
-- ===========================================================================

-- TRADES ---------------------------------------------------------------------
create table if not exists trades (
  id          text primary key,
  data        jsonb       not null default '{}'::jsonb,
  updated_at  timestamptz not null default now(),
  user_id     uuid        default auth.uid()
);
create index if not exists trades_updated_at_idx on trades (updated_at desc);
create index if not exists trades_user_idx       on trades (user_id);
alter table trades enable row level security;

-- PROFILES (one row per user: plan + Stripe link). Stubbed now so adding Stripe
-- in Phase 2 only writes here. -------------------------------------------------
create table if not exists profiles (
  id                  uuid        primary key references auth.users (id) on delete cascade,
  plan                text        not null default 'free',   -- free | pro | premium
  stripe_customer_id  text,
  updated_at          timestamptz not null default now()
);
alter table profiles enable row level security;

-- RLS ------------------------------------------------------------------------
-- Optional Phase 1 quick start (only if you enable cloud BEFORE auth): allow
-- anon full access to trades. DROP this before going multi-user.
--   create policy "anon trades" on trades for all to anon using (true) with check (true);

-- Phase 2 multi-user (target). Each user sees only their own rows.
create policy "own trades read"  on trades   for select to authenticated using (auth.uid() = user_id);
create policy "own trades write" on trades   for all    to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own profile read" on profiles for select to authenticated using (auth.uid() = id);
create policy "own profile write" on profiles for all   to authenticated using (auth.uid() = id) with check (auth.uid() = id);
-- ===========================================================================
