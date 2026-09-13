-- ===========================================================================
-- Kujira Forex — Supabase schema
-- Phase 1 is single-user and fully local (no cloud needed). Run this when you
-- enable cloud sync. Written for the multi-user target (RLS option C), so the
-- jump to Phase 2 (accounts + billing) needs no schema rewrite.
-- Row shape matches the client: id (text), data (jsonb), updated_at,
-- deleted_at and user_id.
-- ===========================================================================

begin;

-- TRADES ---------------------------------------------------------------------
create table if not exists trades (
  id          text not null,
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
declare
  v_pk_name text;
  v_is_scoped_pk boolean;
begin
  if exists (select 1 from trades where user_id is null) then
    raise exception 'Backfill trades.user_id before enabling RLS. Run migrations/phase2-user-id-backfill.sql first.';
  end if;
  alter table trades alter column user_id set not null;

  -- Phase 1 generated IDs are client-side and therefore only unique within a
  -- user's namespace. Convert the old global primary key after the owner-led
  -- user_id backfill. Duplicate (user_id,id) rows deliberately abort this
  -- transaction, so an operator must reconcile them instead of losing data.
  select c.conname
       , c.conkey = array[
           (select a.attnum::int2 from pg_catalog.pg_attribute as a
             where a.attrelid = 'public.trades'::regclass and a.attname = 'user_id'),
           (select a.attnum::int2 from pg_catalog.pg_attribute as a
             where a.attrelid = 'public.trades'::regclass and a.attname = 'id')
         ]::smallint[]
    into v_pk_name, v_is_scoped_pk
    from pg_catalog.pg_constraint as c
   where c.conrelid = 'public.trades'::regclass
     and c.contype = 'p';
  if v_pk_name is not null
     and (v_pk_name <> 'trades_user_id_id_pkey' or not coalesce(v_is_scoped_pk, false)) then
    execute format('alter table public.trades drop constraint %I', v_pk_name);
  end if;
  if not exists (
    select 1
      from pg_catalog.pg_constraint as c
     where c.conrelid = 'public.trades'::regclass
       and c.conname = 'trades_user_id_id_pkey'
  ) then
    alter table public.trades add constraint trades_user_id_id_pkey primary key (user_id, id);
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
  stripe_subscription_id     text,
  last_billing_subscription_id text,
  last_billing_event_created bigint,
  last_billing_event_id      text,
  last_billing_event_type    text,
  updated_at          timestamptz not null default now()
);
alter table profiles add column if not exists last_billing_event_created bigint;
alter table profiles add column if not exists last_billing_event_id text;
alter table profiles add column if not exists last_billing_event_type text;
alter table profiles add column if not exists stripe_subscription_id text;
alter table profiles add column if not exists last_billing_subscription_id text;
-- A Stripe customer must identify at most one profile. This named index is
-- idempotent for a fresh or existing table, and deliberately fails if legacy
-- duplicate customer IDs need owner-led reconciliation before Phase 2.
create unique index if not exists profiles_stripe_customer_id_uidx
  on profiles (stripe_customer_id)
  where stripe_customer_id is not null;
create unique index if not exists profiles_stripe_subscription_id_uidx
  on profiles (stripe_subscription_id)
  where stripe_subscription_id is not null;
alter table profiles enable row level security;

-- Stripe event identities are durable so retries cannot re-apply a plan
-- change. The worker reaches this table only through apply_stripe_event below.
create table if not exists stripe_webhook_events (
  event_id       text primary key,
  event_type     text not null,
  customer_id    text not null,
  subscription_id text not null,
  event_created  bigint not null,
  plan           text not null check (plan in ('free', 'pro')),
  received_at    timestamptz not null default now()
);
alter table stripe_webhook_events add column if not exists subscription_id text;
do $$
begin
  if exists (select 1 from stripe_webhook_events where subscription_id is null) then
    raise exception 'Backfill stripe_webhook_events.subscription_id before enabling billing';
  end if;
  alter table stripe_webhook_events alter column subscription_id set not null;
end;
$$;
alter table stripe_webhook_events enable row level security;

-- RLS ------------------------------------------------------------------------
-- Phase 1 stays local-only. Do not add an anonymous trades policy. Cloud sync
-- uses the authenticated RPC below only after the user-id backfill.

-- Phase 2 multi-user (target). Each user sees only their own rows. Direct
-- trade table writes stay closed; authenticated clients use sync_trade below.
drop policy if exists "own trades read" on trades;
drop policy if exists "own trades write" on trades;
drop policy if exists "own profile read" on profiles;
drop policy if exists "own profile write" on profiles;
create policy "own trades read"  on trades   for select to authenticated using (auth.uid() = user_id);
create policy "own profile read" on profiles for select to authenticated using (auth.uid() = id);
-- Authenticated clients may read their own plan, but only the service role
-- webhook path may write it. Service role bypasses RLS, while these grants
-- prevent direct PostgREST writes from an authenticated client.
revoke all on table profiles from anon, authenticated, public;
grant select on table profiles to authenticated;
grant select, insert, update, delete on table profiles to service_role;
revoke all on table trades from anon, authenticated, public;
grant select on table trades to authenticated;
grant select, insert, update, delete on table trades to service_role;
revoke all on table stripe_webhook_events from anon, authenticated, public, service_role;

-- SERVER TIMESTAMPS -----------------------------------------------------------
-- The client no longer sends updated_at (data safety rule 3: echo the server's
-- own timestamp, never the client clock). The column default stamps inserts;
-- this trigger advances updated_at on every UPDATE so a re-sync of an edited
-- row gets a fresh server time. clock_timestamp() is used because now() is
-- fixed at transaction start. The one-microsecond floor keeps two updates in
-- one transaction ordered for the client's server timestamp token.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at = pg_catalog.clock_timestamp();
  if new.updated_at <= old.updated_at then
    new.updated_at = old.updated_at + interval '1 microsecond';
  end if;
  return new;
end; $$;
drop trigger if exists trades_set_updated_at on trades;
drop trigger if exists profiles_set_updated_at on profiles;
create trigger trades_set_updated_at before update on trades for each row execute function public.set_updated_at();
create trigger profiles_set_updated_at before update on profiles for each row execute function public.set_updated_at();

-- ATOMIC STRIPE EVENT FENCE --------------------------------------------------
-- The worker supplies a verified Stripe event, never a raw plan PATCH. This
-- function locks profile attribution and event ordering in one transaction.
-- A customer must resolve to exactly one profile. Equal-time different events
-- are rejected instead of choosing an arbitrary event-ID order. The event
-- timestamp fence is scoped to last_billing_subscription_id, so an old
-- subscription cannot make a new subscription's earlier event look stale.
-- A server-owned binding change must reset that fence in an explicit trusted
-- operation. Until then, a mismatch is rejected without consuming the event.
create or replace function public.apply_stripe_event(
  p_event_id text,
  p_event_type text,
  p_event_created bigint,
  p_customer_id text,
  p_subscription_id text,
  p_plan text
)
returns table (
  applied boolean,
  duplicate boolean,
  matched integer,
  reason text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing public.stripe_webhook_events%rowtype;
  v_profile_id uuid;
  v_subscription_id text;
  v_last_subscription_id text;
  v_last_created bigint;
  v_last_id text;
  v_inserted_id text;
  v_matched integer;
begin
  if p_event_id is null
     or pg_catalog.length(p_event_id) = 0
     or pg_catalog.length(p_event_id) > 255
     or p_event_id <> pg_catalog.btrim(p_event_id)
     or p_event_id ~ '[[:cntrl:]]'
     or p_event_type is null
     or p_event_type not in (
       'customer.subscription.updated',
       'customer.subscription.deleted'
     )
     or p_event_created is null
     or p_event_created < 0
     or p_customer_id is null
     or pg_catalog.length(p_customer_id) = 0
     or pg_catalog.length(p_customer_id) > 255
     or p_customer_id <> pg_catalog.btrim(p_customer_id)
     or p_customer_id ~ '[[:cntrl:]]'
     or p_subscription_id is null
     or pg_catalog.length(p_subscription_id) = 0
     or pg_catalog.length(p_subscription_id) > 255
     or p_subscription_id <> pg_catalog.btrim(p_subscription_id)
     or p_subscription_id ~ '[[:cntrl:]]'
     or p_plan is null
     or p_plan not in ('free', 'pro') then
    raise exception 'Invalid Stripe event identity' using errcode = '22023';
  end if;

  -- The unique customer index prevents new duplicate attribution. The table
  -- lock closes the check-to-update gap against trusted profile maintenance,
  -- while the row lock below serialises this customer's event fence.
  lock table public.profiles in share row exclusive mode;

  select e.*
    into v_existing
    from public.stripe_webhook_events as e
   where e.event_id = p_event_id
   for update;
  if found then
    if v_existing.event_type is distinct from p_event_type
       or v_existing.customer_id is distinct from p_customer_id
       or v_existing.subscription_id is distinct from p_subscription_id
       or v_existing.event_created is distinct from p_event_created
       or v_existing.plan is distinct from p_plan then
      raise exception 'Stripe event ID was reused with different data' using errcode = '22023';
    end if;
    return query select false, true, 1, 'duplicate';
    return;
  end if;

  select count(*)::integer
    into v_matched
    from (
      select p.id
        from public.profiles as p
       where p.stripe_customer_id = p_customer_id
       for update
    ) as locked_profiles;
  if v_matched <> 1 then
    return query select false, false, v_matched, 'customer attribution failed';
    return;
  end if;

  select p.id, p.stripe_subscription_id, p.last_billing_subscription_id,
         p.last_billing_event_created, p.last_billing_event_id
    into v_profile_id, v_subscription_id, v_last_subscription_id, v_last_created, v_last_id
    from public.profiles as p
   where p.stripe_customer_id = p_customer_id
   for update;

  if v_subscription_id is distinct from p_subscription_id then
    return query select false, false, v_matched, 'subscription attribution failed';
    return;
  end if;

  if v_last_created is not null and v_last_subscription_id is null then
    return query select false, false, v_matched, 'billing subscription fence uninitialised';
    return;
  end if;
  if v_last_created is not null
     and v_last_subscription_id is distinct from p_subscription_id then
    return query select false, false, v_matched, 'billing subscription fence mismatch';
    return;
  end if;

  if v_last_created is not null and p_event_created < v_last_created then
    insert into public.stripe_webhook_events
      (event_id, event_type, customer_id, subscription_id, event_created, plan)
    values (p_event_id, p_event_type, p_customer_id, p_subscription_id, p_event_created, p_plan)
    on conflict (event_id) do nothing;
    return query select false, false, v_matched, 'stale event';
    return;
  end if;
  if v_last_created is not null
     and p_event_created = v_last_created
     and v_last_id is distinct from p_event_id then
    return query select false, false, v_matched, 'ambiguous event ordering';
    return;
  end if;

  insert into public.stripe_webhook_events
    (event_id, event_type, customer_id, subscription_id, event_created, plan)
  values (p_event_id, p_event_type, p_customer_id, p_subscription_id, p_event_created, p_plan)
  on conflict (event_id) do nothing
  returning event_id into v_inserted_id;
  if v_inserted_id is null then
    select e.*
      into v_existing
      from public.stripe_webhook_events as e
     where e.event_id = p_event_id
     for update;
    if v_existing.event_type is distinct from p_event_type
       or v_existing.customer_id is distinct from p_customer_id
       or v_existing.subscription_id is distinct from p_subscription_id
       or v_existing.event_created is distinct from p_event_created
       or v_existing.plan is distinct from p_plan then
      raise exception 'Stripe event ID was reused with different data' using errcode = '22023';
    end if;
    return query select false, true, v_matched, 'duplicate';
    return;
  end if;

  update public.profiles
     set plan = p_plan,
         last_billing_subscription_id = p_subscription_id,
         last_billing_event_created = p_event_created,
         last_billing_event_id = p_event_id,
         last_billing_event_type = p_event_type
   where id = v_profile_id;
  return query select true, false, v_matched, 'applied';
end;
$$;

alter function public.apply_stripe_event(text, text, bigint, text, text, text) owner to postgres;
revoke all on function public.apply_stripe_event(text, text, bigint, text, text, text) from public;
revoke all on function public.apply_stripe_event(text, text, bigint, text, text, text) from anon;
revoke all on function public.apply_stripe_event(text, text, bigint, text, text, text) from authenticated;
grant execute on function public.apply_stripe_event(text, text, bigint, text, text, text) to service_role;

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
security definer
set search_path = ''
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
           deleted_at = case when p_delete then pg_catalog.clock_timestamp() else null end
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
            case when p_delete then pg_catalog.clock_timestamp() else null end, v_uid)
    on conflict (user_id, id) do nothing
    returning * into v_row;

    if found then
      return query select true, v_row.id, v_row.data, v_row.updated_at, v_row.deleted_at;
      return;
    end if;

    -- A concurrent create won the primary-key race. Return the row only when
    -- it belongs to this caller, otherwise expose no other user's data.
    select t.*
      into v_row
      from public.trades as t
     where t.id = p_id
       and t.user_id = v_uid
     for update;
    if found then
      return query select false, v_row.id, v_row.data, v_row.updated_at, v_row.deleted_at;
      return;
    end if;

    return query select false, null::text, null::jsonb, null::timestamptz, null::timestamptz;
    return;
  end if;

  return query select true, v_row.id, v_row.data, v_row.updated_at, v_row.deleted_at;
end;
$$;

-- Keep this function owned by the trusted Supabase database owner. The
-- authenticated role receives EXECUTE only, never direct table-write grants.
alter function public.sync_trade(text, jsonb, timestamptz, boolean) owner to postgres;

revoke all on function public.sync_trade(text, jsonb, timestamptz, boolean) from public;
revoke all on function public.sync_trade(text, jsonb, timestamptz, boolean) from anon;
grant execute on function public.sync_trade(text, jsonb, timestamptz, boolean) to authenticated;

commit;
-- ===========================================================================
