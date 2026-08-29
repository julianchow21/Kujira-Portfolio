-- ===========================================================================
-- Kujira Forex — Supabase schema
-- Phase 1 is single-user and fully local (no cloud needed). Run this when you
-- enable cloud sync. Written for the multi-user target (RLS option C), so the
-- jump to Phase 2 (accounts + billing) needs no schema rewrite.
-- Row shape matches the client: id (text), data (jsonb), updated_at,
-- deleted_at and user_id.
-- ===========================================================================

-- TRADES ---------------------------------------------------------------------
create table if not exists trades (
  id          text primary key,
  data        jsonb       not null default '{}'::jsonb,
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz,
  user_id     uuid        default auth.uid()
);
alter table trades add column if not exists deleted_at timestamptz;
create index if not exists trades_updated_at_idx on trades (updated_at desc);
create index if not exists trades_sync_cursor_idx on trades (updated_at asc, id asc);
create index if not exists trades_user_idx       on trades (user_id);
do $$
begin
  if exists (select 1 from trades where user_id is null) then
    raise exception 'Backfill trades.user_id before enabling RLS. Run migrations/phase2-user-id-backfill.sql first.';
  end if;
end;
$$;
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
-- Phase 1 stays local-only. Do not add an anonymous trades policy. Cloud sync
-- uses the authenticated RPC below only after the user-id backfill.

-- Phase 2 multi-user (target). Each user sees only their own rows.
drop policy if exists "own trades read" on trades;
drop policy if exists "own trades write" on trades;
drop policy if exists "own profile read" on profiles;
drop policy if exists "own profile write" on profiles;
create policy "own trades read"  on trades   for select to authenticated using (auth.uid() = user_id);
create policy "own trades write" on trades   for all    to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own profile read" on profiles for select to authenticated using (auth.uid() = id);
create policy "own profile write" on profiles for all   to authenticated using (auth.uid() = id) with check (auth.uid() = id);

-- SERVER TIMESTAMPS -----------------------------------------------------------
-- The client no longer sends updated_at (data safety rule 3: echo the server's
-- own timestamp, never the client clock). The column default stamps inserts;
-- this trigger advances updated_at on every UPDATE so a re-sync of an edited
-- row gets a fresh server time. Without it, upserted rows keep their original
-- insert timestamp and table-level reconciliation could miss newer edits.
create or replace function public.set_updated_at() returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end; $$;
drop trigger if exists trades_set_updated_at on trades;
drop trigger if exists profiles_set_updated_at on profiles;
create trigger trades_set_updated_at before update on trades for each row execute function public.set_updated_at();
create trigger profiles_set_updated_at before update on profiles for each row execute function public.set_updated_at();

-- PER-ROW COMPARE-AND-SWAP ----------------------------------------------------
-- The client sends only the last timestamp it received from this database.
-- The row is locked before comparison, so two writers cannot both apply
-- against the same version. Deletes are tombstones and therefore survive
-- offline clients and complete paginated reads.
create or replace function public.sync_trade(
  p_id text,
  p_data jsonb,
  p_expected_updated_at timestamptz,
  p_delete boolean default false
)
returns table (
  applied boolean,
  row_id text,
  row_data jsonb,
  server_updated_at timestamptz,
  server_deleted_at timestamptz
)
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.trades%rowtype;
begin
  if v_uid is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if p_id is null or length(p_id) > 64 or p_id !~ '^[A-Za-z0-9_-]+$' then
    raise exception 'Invalid trade ID' using errcode = '22023';
  end if;

  select t.*
    into v_row
    from public.trades as t
   where t.id = p_id
     and t.user_id = v_uid
   for update;

  if found then
    if p_expected_updated_at is null
       or p_expected_updated_at is distinct from v_row.updated_at then
      return query select false, v_row.id, v_row.data, v_row.updated_at, v_row.deleted_at;
      return;
    end if;

    update public.trades as t
       set data = case when p_delete then t.data else coalesce(p_data, '{}'::jsonb) end,
           deleted_at = case when p_delete then now() else null end
     where t.id = p_id
       and t.user_id = v_uid
     returning t.* into v_row;
  else
    if p_expected_updated_at is not null then
      return query select false, null::text, null::jsonb, null::timestamptz, null::timestamptz;
      return;
    end if;

    insert into public.trades (id, data, deleted_at, user_id)
    values (p_id, case when p_delete then '{}'::jsonb else coalesce(p_data, '{}'::jsonb) end,
            case when p_delete then now() else null end, v_uid)
    returning * into v_row;
  end if;

  return query select true, v_row.id, v_row.data, v_row.updated_at, v_row.deleted_at;
end;
$$;

revoke all on function public.sync_trade(text, jsonb, timestamptz, boolean) from public;
revoke all on function public.sync_trade(text, jsonb, timestamptz, boolean) from anon;
grant execute on function public.sync_trade(text, jsonb, timestamptz, boolean) to authenticated;
-- ===========================================================================
