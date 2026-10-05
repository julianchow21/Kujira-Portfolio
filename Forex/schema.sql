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
  plan                text        not null default 'free' check (plan in ('free', 'pro')),
  stripe_customer_id  text,
  stripe_subscription_id     text,
  last_billing_subscription_id text,
  last_billing_event_created bigint,
  last_billing_event_id      text,
  last_billing_event_type    text,
  updated_at          timestamptz not null default now()
);
do $$
declare
  v_constraint record;
begin
  -- Replace any legacy plan check, including the old free|pro|premium shape,
  -- so a repeated application cannot leave a paid tier outside this contract.
  for v_constraint in
    select c.conname
      from pg_catalog.pg_constraint as c
     where c.conrelid = 'public.profiles'::regclass
       and c.contype = 'c'
       and pg_catalog.pg_get_constraintdef(c.oid) like '%plan%'
  loop
    execute format('alter table public.profiles drop constraint %I', v_constraint.conname);
  end loop;
  alter table public.profiles
    add constraint profiles_plan_check check (plan in ('free', 'pro'));
end;
$$;
alter table profiles alter column plan set default 'free';
alter table profiles alter column plan set not null;
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

-- PROFILE BOOTSTRAP -----------------------------------------------------------
-- Authenticated users receive a free profile as part of the auth.users insert.
-- No client path can choose a paid plan or any Stripe binding fields here.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, plan)
  values (new.id, 'free')
  on conflict (id) do nothing;
  return new;
end;
$$;
alter function public.handle_new_user() owner to postgres;
revoke all on function public.handle_new_user() from public, anon, authenticated, service_role;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
-- Auth users that pre-date this trigger receive the same safe free bootstrap.
-- Existing rows are never rewritten, so a paid profile cannot be downgraded by
-- reapplying the schema.
insert into public.profiles (id, plan)
select u.id, 'free'
  from auth.users as u
on conflict (id) do nothing;

-- SERVER-CREATED CHECKOUT SESSIONS -------------------------------------------
-- The Worker reserves an intent before calling Stripe, then records the Stripe
-- session before returning a browser URL. A partial unique index permits only
-- one active checkout per user while retaining completed history.
create table if not exists stripe_checkout_sessions (
  intent_id       text primary key,
  session_id      text,
  idempotency_key text not null,
  user_id         uuid not null references profiles (id) on delete cascade,
  customer_id     text,
  subscription_id text,
  status          text not null default 'pending'
                  check (status in ('pending', 'created', 'completed', 'expired')),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
-- A previous partial deployment may have created this table without all of the
-- later columns. Add the shape first, then validate and constrain it below.
alter table stripe_checkout_sessions add column if not exists intent_id text;
alter table stripe_checkout_sessions add column if not exists session_id text;
alter table stripe_checkout_sessions add column if not exists idempotency_key text;
alter table stripe_checkout_sessions add column if not exists user_id uuid;
alter table stripe_checkout_sessions add column if not exists customer_id text;
alter table stripe_checkout_sessions add column if not exists subscription_id text;
alter table stripe_checkout_sessions add column if not exists status text;
alter table stripe_checkout_sessions add column if not exists created_at timestamptz;
alter table stripe_checkout_sessions add column if not exists updated_at timestamptz;
do $$
declare
  v_bad_types text;
  v_primary_key text;
begin
  select pg_catalog.string_agg(c.column_name || ':' || c.udt_name, ', ' order by c.column_name)
    into v_bad_types
    from information_schema.columns as c
   where c.table_schema = 'public'
     and c.table_name = 'stripe_checkout_sessions'
     and ((c.column_name in ('intent_id', 'session_id', 'idempotency_key', 'customer_id', 'subscription_id', 'status')
           and c.udt_name <> 'text')
       or (c.column_name = 'user_id' and c.udt_name <> 'uuid')
       or (c.column_name in ('created_at', 'updated_at') and c.udt_name <> 'timestamptz'));
  if v_bad_types is not null then
    raise exception 'stripe_checkout_sessions has incompatible column types: %', v_bad_types
      using errcode = '42804';
  end if;

  -- Identity, ownership and state cannot be inferred safely from an old row.
  -- Abort instead of fabricating an idempotency key, owner or lifecycle state.
  if exists (
    select 1
      from public.stripe_checkout_sessions as s
     where s.intent_id is null
        or s.idempotency_key is null
        or s.user_id is null
        or s.status is null
  ) then
    raise exception 'Backfill stripe_checkout_sessions identity columns before enabling billing'
      using errcode = '23502';
  end if;
  if exists (
    select 1
      from public.stripe_checkout_sessions as s
     where s.status not in ('pending', 'created', 'completed', 'expired')
  ) then
    raise exception 'Invalid stripe_checkout_sessions status requires owner review'
      using errcode = '23514';
  end if;
  if exists (
    select 1
      from public.stripe_checkout_sessions as s
     where s.status in ('created', 'completed')
       and (s.session_id is null or s.customer_id is null)
  ) then
    raise exception 'Backfill stripe_checkout_sessions created session attribution before enabling billing'
      using errcode = '23502';
  end if;
  if exists (
    select 1
      from public.stripe_checkout_sessions as s
     where s.status = 'completed'
       and s.subscription_id is null
  ) then
    raise exception 'Backfill stripe_checkout_sessions completed subscription attribution before enabling billing'
      using errcode = '23502';
  end if;
  if exists (
    select 1 from public.stripe_checkout_sessions group by intent_id having count(*) > 1
  ) then
    raise exception 'Duplicate stripe_checkout_sessions intent_id requires owner review'
      using errcode = '23505';
  end if;
  if exists (
    select 1 from public.stripe_checkout_sessions group by idempotency_key having count(*) > 1
  ) then
    raise exception 'Duplicate stripe_checkout_sessions idempotency_key requires owner review'
      using errcode = '23505';
  end if;
  if exists (
    select 1
      from public.stripe_checkout_sessions
     where session_id is not null
     group by session_id
    having count(*) > 1
  ) then
    raise exception 'Duplicate stripe_checkout_sessions session_id requires owner review'
      using errcode = '23505';
  end if;
  if exists (
    select 1
      from public.stripe_checkout_sessions as s
      left join public.profiles as p on p.id = s.user_id
     where p.id is null
  ) then
    raise exception 'Backfill stripe_checkout_sessions user ownership before enabling billing'
      using errcode = '23503';
  end if;

  -- Timestamps are the only nullable legacy values safe to derive locally.
  update public.stripe_checkout_sessions
     set created_at = coalesce(created_at, pg_catalog.clock_timestamp()),
         updated_at = coalesce(updated_at, pg_catalog.clock_timestamp())
   where created_at is null or updated_at is null;

  select pg_catalog.pg_get_constraintdef(c.oid, true)
    into v_primary_key
    from pg_catalog.pg_constraint as c
   where c.conrelid = 'public.stripe_checkout_sessions'::regclass
     and c.contype = 'p';
  if v_primary_key is null then
    alter table public.stripe_checkout_sessions
      add constraint stripe_checkout_sessions_intent_pkey primary key (intent_id);
  elsif v_primary_key <> 'PRIMARY KEY (intent_id)' then
    raise exception 'stripe_checkout_sessions primary key must be intent_id'
      using errcode = '42830';
  end if;

  if not exists (
    select 1
      from pg_catalog.pg_constraint as c
     where c.conrelid = 'public.stripe_checkout_sessions'::regclass
       and c.contype = 'f'
       and c.confrelid = 'public.profiles'::regclass
       and c.conkey @> ARRAY[
         (select a.attnum from pg_catalog.pg_attribute as a
           where a.attrelid = c.conrelid and a.attname = 'user_id')::smallint
       ]
  ) then
    alter table public.stripe_checkout_sessions
      add constraint stripe_checkout_sessions_profile_fkey
      foreign key (user_id) references public.profiles (id) on delete cascade;
  end if;

  if not exists (
    select 1
      from pg_catalog.pg_constraint as c
     where c.conrelid = 'public.stripe_checkout_sessions'::regclass
       and c.conname = 'stripe_checkout_sessions_status_ck'
  ) then
    alter table public.stripe_checkout_sessions
      add constraint stripe_checkout_sessions_status_ck
      check (status in ('pending', 'created', 'completed', 'expired'));
  end if;
end;
$$;
alter table stripe_checkout_sessions alter column intent_id set not null;
alter table stripe_checkout_sessions alter column idempotency_key set not null;
alter table stripe_checkout_sessions alter column user_id set not null;
alter table stripe_checkout_sessions alter column status set default 'pending';
alter table stripe_checkout_sessions alter column status set not null;
alter table stripe_checkout_sessions alter column created_at set default now();
alter table stripe_checkout_sessions alter column created_at set not null;
alter table stripe_checkout_sessions alter column updated_at set default now();
alter table stripe_checkout_sessions alter column updated_at set not null;
create unique index if not exists stripe_checkout_sessions_session_uidx
  on stripe_checkout_sessions (session_id)
  where session_id is not null;
create unique index if not exists stripe_checkout_sessions_idempotency_uidx
  on stripe_checkout_sessions (idempotency_key);
create unique index if not exists stripe_checkout_sessions_active_user_uidx
  on stripe_checkout_sessions (user_id)
  where status in ('pending', 'created');
alter table stripe_checkout_sessions enable row level security;

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
alter table stripe_webhook_events add column if not exists checkout_session_id text;
create unique index if not exists stripe_webhook_events_checkout_session_uidx
  on stripe_webhook_events (checkout_session_id)
  where checkout_session_id is not null;
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
-- Authenticated clients may read their own plan. Trusted billing RPCs run as
-- the database owner, while direct profile writes remain closed to every API
-- role.
revoke all on table profiles from anon, authenticated, public;
grant select on table profiles to authenticated;
-- Profile plan and Stripe fields are writable only through the trusted RPCs.
-- The service role has no direct table-write escape hatch.
revoke all on table profiles from service_role;
revoke all on table trades from anon, authenticated, public;
grant select on table trades to authenticated;
grant select, insert, update, delete on table trades to service_role;
revoke all on table stripe_webhook_events from anon, authenticated, public, service_role;
revoke all on table stripe_checkout_sessions from anon, authenticated, public, service_role;

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
drop trigger if exists stripe_checkout_sessions_set_updated_at on stripe_checkout_sessions;
create trigger stripe_checkout_sessions_set_updated_at
  before update on stripe_checkout_sessions
  for each row execute function public.set_updated_at();

-- ACCOUNT STATE AND ENTITLEMENTS ---------------------------------------------
-- This is the authenticated source for the client account banner and Worker
-- feature checks. The six feature names are the declared product contract.
create or replace function public.get_account_state()
returns table (
  plan          text,
  trade_count   bigint,
  trade_cap     integer,
  entitlements  jsonb
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_plan text;
  v_trade_count bigint;
begin
  if v_uid is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  select p.plan
    into v_plan
    from public.profiles as p
   where p.id = v_uid
   for update;
  if not found then
    raise exception 'Account profile is not initialised' using errcode = '42501';
  end if;

  select count(*)::bigint
    into v_trade_count
    from public.trades as t
   where t.user_id = v_uid
     and t.deleted_at is null;

  return query
  select v_plan,
         v_trade_count,
         case when v_plan = 'free' then 50 else null::integer end,
         pg_catalog.jsonb_build_object(
           'unlimited_trades', v_plan = 'pro',
           'simulator', v_plan = 'pro',
           'advanced_analytics', v_plan = 'pro',
           'ai_coach', v_plan = 'pro',
           'chart_markers', v_plan = 'pro',
           'csv_import', v_plan = 'pro'
         );
end;
$$;
alter function public.get_account_state() owner to postgres;
revoke all on function public.get_account_state() from public, anon, service_role;
grant execute on function public.get_account_state() to authenticated;

create or replace function public.authorise_feature(p_feature text)
returns table (
  allowed boolean,
  feature text,
  plan text,
  reason text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_plan text;
begin
  if v_uid is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  select p.plan
    into v_plan
    from public.profiles as p
   where p.id = v_uid;
  if not found then
    raise exception 'Account profile is not initialised' using errcode = '42501';
  end if;

  if p_feature is null or p_feature not in (
    'unlimited_trades', 'simulator', 'advanced_analytics',
    'ai_coach', 'chart_markers', 'csv_import'
  ) then
    return query select false, p_feature, v_plan, 'unknown_feature';
    return;
  end if;

  if v_plan = 'pro' then
    return query select true, p_feature, v_plan, 'allowed';
  else
    return query select false, p_feature, v_plan, 'feature_requires_pro';
  end if;
end;
$$;
alter function public.authorise_feature(text) owner to postgres;
revoke all on function public.authorise_feature(text) from public, anon, service_role;
grant execute on function public.authorise_feature(text) to authenticated;

-- TRADE PAYLOAD VALIDATION ---------------------------------------------------
-- JSONB has no application-level domain checks. Keep trusted write RPCs
-- finite and explicit so malformed browser/CSV payloads cannot become rows.
create or replace function public.trade_data_is_valid(p_data jsonb)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_entry timestamptz;
  v_exit timestamptz;
  v_created timestamptz;
  v_updated timestamptz;
  v_number numeric;
begin
  if p_data is null or pg_catalog.jsonb_typeof(p_data) <> 'object' then return false; end if;
  if pg_catalog.jsonb_typeof(p_data->'symbol') is distinct from 'string'
     or pg_catalog.length(pg_catalog.btrim(p_data->>'symbol')) = 0
     or pg_catalog.length(p_data->>'symbol') > 64
     or p_data->>'symbol' ~ '[[:cntrl:]]' then return false; end if;
  if pg_catalog.jsonb_typeof(p_data->'side') is distinct from 'string'
     or p_data->>'side' not in ('long', 'short') then return false; end if;
  if pg_catalog.jsonb_typeof(p_data->'quantity') is distinct from 'number' then return false; end if;
  begin
    v_number := (p_data->>'quantity')::numeric;
    if v_number <= 0 or v_number > 1e300 then return false; end if;
  exception when others then return false; end;
  if pg_catalog.jsonb_typeof(p_data->'entryPrice') is distinct from 'number' then return false; end if;
  begin
    v_number := (p_data->>'entryPrice')::numeric;
    if v_number <= 0 or v_number > 1e300 then return false; end if;
  exception when others then return false; end;
  if pg_catalog.jsonb_typeof(p_data->'entryAt') is distinct from 'string'
     or p_data->>'entryAt' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?Z$' then return false; end if;
  begin v_entry := (p_data->>'entryAt')::timestamptz;
  exception when others then return false; end;
  if p_data ? 'exitAt' then
    if pg_catalog.jsonb_typeof(p_data->'exitAt') is distinct from 'string' then return false; end if;
    if p_data->>'exitAt' = '' then
      if p_data ? 'exitPrice' and p_data->>'exitPrice' <> '' then return false; end if;
    else
      if p_data->>'exitAt' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?Z$' then return false; end if;
      begin v_exit := (p_data->>'exitAt')::timestamptz;
      exception when others then return false; end;
      if v_exit < v_entry then return false; end if;
      if pg_catalog.jsonb_typeof(p_data->'exitPrice') is distinct from 'number' then return false; end if;
      begin
        v_number := (p_data->>'exitPrice')::numeric;
        if v_number <= 0 or v_number > 1e300 then return false; end if;
      exception when others then return false; end;
    end if;
  elsif p_data ? 'exitPrice' and p_data->>'exitPrice' <> '' then return false;
  end if;
  if p_data ? 'stopPrice' then
    if p_data->>'stopPrice' is distinct from '' then
      if pg_catalog.jsonb_typeof(p_data->'stopPrice') is distinct from 'number' then return false; end if;
      begin
        v_number := (p_data->>'stopPrice')::numeric;
        if v_number <= 0 or v_number > 1e300 then return false; end if;
      exception when others then return false; end;
    end if;
  end if;
  if p_data ? 'fees' then
    if pg_catalog.jsonb_typeof(p_data->'fees') is distinct from 'number' then return false; end if;
    begin
      v_number := (p_data->>'fees')::numeric;
      if v_number < 0 or v_number > 1e300 then return false; end if;
    exception when others then return false; end;
  end if;
  if p_data ? 'contractMultiplier' then
    if pg_catalog.jsonb_typeof(p_data->'contractMultiplier') is distinct from 'number' then return false; end if;
    begin
      v_number := (p_data->>'contractMultiplier')::numeric;
      if v_number <= 0 or v_number > 1e300 then return false; end if;
    exception when others then return false; end;
  end if;
  if p_data ? 'createdAt' then
    if pg_catalog.jsonb_typeof(p_data->'createdAt') is distinct from 'string'
       or p_data->>'createdAt' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?Z$' then return false; end if;
    begin v_created := (p_data->>'createdAt')::timestamptz;
    exception when others then return false; end;
  end if;
  if p_data ? 'updatedAt' then
    if pg_catalog.jsonb_typeof(p_data->'updatedAt') is distinct from 'string'
       or p_data->>'updatedAt' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?Z$' then return false; end if;
    begin v_updated := (p_data->>'updatedAt')::timestamptz;
    exception when others then return false; end;
  end if;
  if p_data ? 'notes' and pg_catalog.jsonb_typeof(p_data->'notes') is distinct from 'string' then return false; end if;
  if p_data ? 'setupTags' and pg_catalog.jsonb_typeof(p_data->'setupTags') is distinct from 'array' then return false; end if;
  if p_data ? 'mistakeTags' and pg_catalog.jsonb_typeof(p_data->'mistakeTags') is distinct from 'array' then return false; end if;
  if p_data ? 'emotionTags' and pg_catalog.jsonb_typeof(p_data->'emotionTags') is distinct from 'array' then return false; end if;
  if p_data ? 'marketTags' and pg_catalog.jsonb_typeof(p_data->'marketTags') is distinct from 'array' then return false; end if;
  return true;
end;
$$;
alter function public.trade_data_is_valid(jsonb) owner to postgres;
revoke all on function public.trade_data_is_valid(jsonb) from public, anon, authenticated, service_role;

-- HOSTED CSV IMPORT -----------------------------------------------------------
-- The browser sends an array of {id, data} objects. Existing IDs are skipped,
-- never overwritten or resurrected. Validation happens before the first write,
-- and any later error aborts the whole RPC transaction.
create or replace function public.import_trades(p_rows jsonb)
returns table (
  imported         integer,
  skipped_existing integer,
  reason           text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_plan text;
  v_item jsonb;
  v_id text;
  v_data jsonb;
  v_seen_ids text[] := '{}'::text[];
  v_inserted integer;
  v_imported integer := 0;
  v_skipped integer := 0;
begin
  if v_uid is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if p_rows is null or pg_catalog.jsonb_typeof(p_rows) <> 'array' then
    raise exception 'Invalid import batch' using errcode = '22023';
  end if;
  if pg_catalog.jsonb_array_length(p_rows) > 500
     or pg_catalog.octet_length(p_rows::text) > 4194304 then
    raise exception 'Import batch exceeds bounds' using errcode = '22023';
  end if;

  select p.plan
    into v_plan
    from public.profiles as p
   where p.id = v_uid
   for update;
  if not found then
    raise exception 'Account profile is not initialised' using errcode = '42501';
  end if;
  if v_plan <> 'pro' then
    return query select 0, 0, 'feature_requires_pro';
    return;
  end if;
  if pg_catalog.jsonb_array_length(p_rows) = 0 then
    return query select 0, 0, 'empty_batch';
    return;
  end if;

  for v_item in select value from pg_catalog.jsonb_array_elements(p_rows)
  loop
    if pg_catalog.jsonb_typeof(v_item) <> 'object'
       or pg_catalog.jsonb_typeof(v_item->'id') <> 'string'
       or pg_catalog.jsonb_typeof(v_item->'data') <> 'object' then
      raise exception 'Invalid import row' using errcode = '22023';
    end if;
    v_id := v_item->>'id';
    v_data := v_item->'data';
    if pg_catalog.length(v_id) = 0
       or pg_catalog.length(v_id) > 64
       or v_id <> pg_catalog.btrim(v_id)
       or v_id !~ '^[A-Za-z0-9_-]+$' then
      raise exception 'Invalid import trade ID' using errcode = '22023';
    end if;
    if pg_catalog.octet_length(v_data::text) > 65536 then
      raise exception 'Import trade data exceeds bounds' using errcode = '22023';
    end if;
    if not public.trade_data_is_valid(v_data) then
      raise exception 'Invalid trade data' using errcode = '22023';
    end if;
    if pg_catalog.array_position(v_seen_ids, v_id) is not null then
      raise exception 'Duplicate import trade ID' using errcode = '22023';
    end if;
    v_seen_ids := pg_catalog.array_append(v_seen_ids, v_id);

    insert into public.trades (id, data, user_id)
    values (v_id, v_data, v_uid)
    on conflict (user_id, id) do nothing;
    get diagnostics v_inserted = row_count;
    if v_inserted = 1 then
      v_imported := v_imported + 1;
    else
      v_skipped := v_skipped + 1;
    end if;
  end loop;

  return query select v_imported, v_skipped, 'applied';
end;
$$;
alter function public.import_trades(jsonb) owner to postgres;
revoke all on function public.import_trades(jsonb) from public, anon, service_role;
grant execute on function public.import_trades(jsonb) to authenticated;

-- TRUSTED STRIPE CUSTOMER BINDING --------------------------------------------
-- Only the authenticated Worker may call these functions. The user UUID is
-- supplied only after the Worker has validated the user's JWT. Browser clients
-- receive no execute grant and cannot set a paid plan or Stripe identity.
create or replace function public.bind_stripe_customer(
  p_user_id uuid,
  p_customer_id text
)
returns table (
  bound    boolean,
  duplicate boolean,
  matched  integer,
  reason   text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_profile public.profiles%rowtype;
  v_matched integer;
begin
  if p_user_id is null
     or p_customer_id is null
     or pg_catalog.length(p_customer_id) = 0
     or pg_catalog.length(p_customer_id) > 255
     or p_customer_id <> pg_catalog.btrim(p_customer_id)
     or p_customer_id ~ '[[:cntrl:]]' then
    raise exception 'Invalid Stripe customer binding' using errcode = '22023';
  end if;

  lock table public.profiles in share row exclusive mode;
  select p.*
    into v_profile
    from public.profiles as p
   where p.id = p_user_id
   for update;
  if not found then
    return query select false, false, 0, 'profile attribution failed';
    return;
  end if;

  if v_profile.stripe_customer_id is not null then
    if v_profile.stripe_customer_id is distinct from p_customer_id then
      return query select false, false, 1, 'profile already bound to another customer';
      return;
    end if;
    return query select true, true, 1, 'already bound';
    return;
  end if;

  select count(*)::integer
    into v_matched
    from public.profiles as p
   where p.stripe_customer_id = p_customer_id;
  if v_matched > 0 then
    return query select false, false, v_matched, 'customer already bound';
    return;
  end if;

  update public.profiles
     set stripe_customer_id = p_customer_id
   where id = p_user_id;
  return query select true, false, 1, 'bound';
end;
$$;
alter function public.bind_stripe_customer(uuid, text) owner to postgres;
revoke all on function public.bind_stripe_customer(uuid, text) from public, anon, authenticated;
grant execute on function public.bind_stripe_customer(uuid, text) to service_role;

-- CHECKOUT INTENT RESERVATION -------------------------------------------------
-- The profile row serialises concurrent tabs. The active-session unique index
-- then makes one pending or created checkout the only session for that user.
create or replace function public.begin_stripe_checkout(
  p_user_id uuid,
  p_intent_id text,
  p_idempotency_key text
)
returns table (
  accepted       boolean,
  existing       boolean,
  intent_id      text,
  session_id     text,
  customer_id    text,
  idempotency_key text,
  status         text,
  reason         text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_plan text;
  v_customer_id text;
  v_subscription_id text;
  v_last_subscription_id text;
  v_last_event_type text;
  v_checkout public.stripe_checkout_sessions%rowtype;
begin
  if p_user_id is null
     or p_intent_id is null
     or pg_catalog.length(p_intent_id) = 0
     or pg_catalog.length(p_intent_id) > 255
     or p_intent_id <> pg_catalog.btrim(p_intent_id)
     or p_intent_id ~ '[[:cntrl:]]'
     or p_idempotency_key is null
     or pg_catalog.length(p_idempotency_key) = 0
     or pg_catalog.length(p_idempotency_key) > 255
     or p_idempotency_key <> pg_catalog.btrim(p_idempotency_key)
     or p_idempotency_key ~ '[[:cntrl:]]' then
    raise exception 'Invalid Stripe checkout intent' using errcode = '22023';
  end if;

  select p.plan, p.stripe_customer_id, p.stripe_subscription_id,
         p.last_billing_subscription_id, p.last_billing_event_type
    into v_plan, v_customer_id, v_subscription_id,
         v_last_subscription_id, v_last_event_type
    from public.profiles as p
   where p.id = p_user_id
   for update;
  if not found then
    return query select false, false, null::text, null::text, null::text,
                        null::text, null::text, 'profile attribution failed';
    return;
  end if;
  if v_plan = 'pro' then
    return query select false, false, null::text, null::text, v_customer_id,
                        null::text, null::text, 'already pro';
    return;
  end if;
  if v_subscription_id is not null
     and (
       v_last_event_type is distinct from 'customer.subscription.deleted'
       or v_last_subscription_id is distinct from v_subscription_id
     ) then
    return query select false, false, null::text, null::text, v_customer_id,
                        null::text, null::text, 'active subscription must be cancelled';
    return;
  end if;

  select s.*
    into v_checkout
    from public.stripe_checkout_sessions as s
   where s.user_id = p_user_id
     and s.status in ('pending', 'created')
   order by s.created_at desc
   limit 1
   for update;
  if found then
    return query select true, true, v_checkout.intent_id, v_checkout.session_id,
                        coalesce(v_checkout.customer_id, v_customer_id),
                        v_checkout.idempotency_key, v_checkout.status,
                        'existing checkout';
    return;
  end if;

  select s.*
    into v_checkout
    from public.stripe_checkout_sessions as s
   where s.idempotency_key = p_idempotency_key
   for update;
  if found then
    return query select false, true, v_checkout.intent_id, v_checkout.session_id,
                        coalesce(v_checkout.customer_id, v_customer_id),
                        v_checkout.idempotency_key, v_checkout.status,
                        'idempotency key already used';
    return;
  end if;

  insert into public.stripe_checkout_sessions
    (intent_id, idempotency_key, user_id, customer_id, status)
  values
    (p_intent_id, p_idempotency_key, p_user_id, v_customer_id, 'pending');
  return query select true, false, p_intent_id, null::text, v_customer_id,
                      p_idempotency_key, 'pending', 'started';
end;
$$;
alter function public.begin_stripe_checkout(uuid, text, text) owner to postgres;
revoke all on function public.begin_stripe_checkout(uuid, text, text) from public, anon, authenticated;
grant execute on function public.begin_stripe_checkout(uuid, text, text) to service_role;

create or replace function public.record_stripe_checkout(
  p_intent_id text,
  p_session_id text,
  p_customer_id text
)
returns table (
  recorded  boolean,
  duplicate boolean,
  reason    text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_checkout public.stripe_checkout_sessions%rowtype;
  v_customer_id text;
begin
  if p_intent_id is null
     or pg_catalog.length(p_intent_id) = 0
     or pg_catalog.length(p_intent_id) > 255
     or p_intent_id <> pg_catalog.btrim(p_intent_id)
     or p_intent_id ~ '[[:cntrl:]]'
     or p_session_id is null
     or pg_catalog.length(p_session_id) = 0
     or pg_catalog.length(p_session_id) > 255
     or p_session_id <> pg_catalog.btrim(p_session_id)
     or p_session_id ~ '[[:cntrl:]]'
     or p_customer_id is null
     or pg_catalog.length(p_customer_id) = 0
     or pg_catalog.length(p_customer_id) > 255
     or p_customer_id <> pg_catalog.btrim(p_customer_id)
     or p_customer_id ~ '[[:cntrl:]]' then
    raise exception 'Invalid Stripe checkout binding' using errcode = '22023';
  end if;

  -- Resolve and lock the profile before the checkout row. All checkout RPCs
  -- use this order, which prevents a tab race from forming a lock cycle.
  select s.user_id
    into v_user_id
    from public.stripe_checkout_sessions as s
   where s.intent_id = p_intent_id;
  if not found then
    return query select false, false, 'checkout intent missing';
    return;
  end if;
  select p.stripe_customer_id
    into v_customer_id
    from public.profiles as p
   where p.id = v_user_id
   for update;
  if not found then
    return query select false, false, 'checkout user attribution failed';
    return;
  end if;
  select s.*
    into v_checkout
    from public.stripe_checkout_sessions as s
   where s.intent_id = p_intent_id
   for update;
  if not found then
    return query select false, false, 'checkout intent missing';
    return;
  end if;
  if v_checkout.status in ('created', 'completed')
     and v_checkout.session_id = p_session_id
     and v_checkout.customer_id = p_customer_id then
    return query select true, true, 'already recorded';
    return;
  end if;
  if v_checkout.status <> 'pending' then
    return query select false, false, 'checkout intent is not pending';
    return;
  end if;

  if v_customer_id is distinct from p_customer_id then
    return query select false, false, 'customer attribution failed';
    return;
  end if;

  if exists (
    select 1
      from public.stripe_checkout_sessions as s
     where s.session_id = p_session_id
       and s.intent_id <> p_intent_id
  ) then
    return query select false, false, 'checkout session already bound';
    return;
  end if;

  update public.stripe_checkout_sessions
     set session_id = p_session_id,
         customer_id = p_customer_id,
         status = 'created'
   where intent_id = p_intent_id;
  return query select true, false, 'recorded';
end;
$$;
alter function public.record_stripe_checkout(text, text, text) owner to postgres;
revoke all on function public.record_stripe_checkout(text, text, text) from public, anon, authenticated;
grant execute on function public.record_stripe_checkout(text, text, text) to service_role;

create or replace function public.expire_stripe_checkout(
  p_intent_id text,
  p_session_id text,
  p_customer_id text
)
returns table (
  expired   boolean,
  duplicate boolean,
  reason    text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_profile_customer_id text;
  v_checkout public.stripe_checkout_sessions%rowtype;
begin
  if p_intent_id is null
     or pg_catalog.length(p_intent_id) = 0
     or pg_catalog.length(p_intent_id) > 255
     or p_intent_id <> pg_catalog.btrim(p_intent_id)
     or p_intent_id ~ '[[:cntrl:]]'
     or p_session_id is not null and (
       pg_catalog.length(p_session_id) = 0
       or pg_catalog.length(p_session_id) > 255
       or p_session_id <> pg_catalog.btrim(p_session_id)
       or p_session_id ~ '[[:cntrl:]]'
     )
     or p_customer_id is null
     or pg_catalog.length(p_customer_id) = 0
     or pg_catalog.length(p_customer_id) > 255
     or p_customer_id <> pg_catalog.btrim(p_customer_id)
     or p_customer_id ~ '[[:cntrl:]]' then
    raise exception 'Invalid Stripe checkout expiry' using errcode = '22023';
  end if;

  select s.user_id
    into v_user_id
    from public.stripe_checkout_sessions as s
   where s.intent_id = p_intent_id;
  if not found then
    return query select false, false, 'checkout intent missing';
    return;
  end if;
  select p.stripe_customer_id
    into v_profile_customer_id
    from public.profiles as p
   where p.id = v_user_id
   for update;
  if not found or v_profile_customer_id is distinct from p_customer_id then
    return query select false, false, 'customer attribution failed';
    return;
  end if;
  select s.*
    into v_checkout
    from public.stripe_checkout_sessions as s
   where s.intent_id = p_intent_id
   for update;
  if not found then
    return query select false, false, 'checkout intent missing';
    return;
  end if;

  if v_checkout.status = 'expired'
     and v_checkout.customer_id = p_customer_id
     and (p_session_id is null or v_checkout.session_id = p_session_id) then
    return query select false, true, 'already expired';
    return;
  end if;
  if v_checkout.status = 'pending' then
    if p_session_id is not null then
      return query select false, false, 'pending checkout has no session';
      return;
    end if;
  elsif v_checkout.status = 'created' then
    if p_session_id is null
       or v_checkout.session_id is distinct from p_session_id
       or v_checkout.customer_id is distinct from p_customer_id then
      return query select false, false, 'checkout session attribution failed';
      return;
    end if;
  else
    return query select false, false, 'checkout intent is not active';
    return;
  end if;

  update public.stripe_checkout_sessions
     set status = 'expired'
   where intent_id = p_intent_id;
  return query select true, false, 'expired';
end;
$$;
alter function public.expire_stripe_checkout(text, text, text) owner to postgres;
revoke all on function public.expire_stripe_checkout(text, text, text) from public, anon, authenticated;
grant execute on function public.expire_stripe_checkout(text, text, text) to service_role;

-- CHECKOUT COMPLETION FENCE ---------------------------------------------------
-- A signed checkout event can initialise a subscription only when the Worker
-- previously recorded the exact session, customer and intent. This trusted
-- transition also permits a new subscription after a recorded cancellation by
-- resetting the billing fence for that verified session only.
create or replace function public.complete_stripe_checkout(
  p_event_id text,
  p_event_created bigint,
  p_customer_id text,
  p_subscription_id text,
  p_session_id text
)
returns table (
  applied  boolean,
  duplicate boolean,
  matched  integer,
  reason   text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing public.stripe_webhook_events%rowtype;
  v_checkout public.stripe_checkout_sessions%rowtype;
  v_profile public.profiles%rowtype;
  v_matched integer;
  v_inserted_id text;
begin
  if p_event_id is null
     or pg_catalog.length(p_event_id) = 0
     or pg_catalog.length(p_event_id) > 255
     or p_event_id <> pg_catalog.btrim(p_event_id)
     or p_event_id ~ '[[:cntrl:]]'
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
     or p_session_id is null
     or pg_catalog.length(p_session_id) = 0
     or pg_catalog.length(p_session_id) > 255
     or p_session_id <> pg_catalog.btrim(p_session_id)
     or p_session_id ~ '[[:cntrl:]]' then
    raise exception 'Invalid Stripe checkout event identity' using errcode = '22023';
  end if;

  lock table public.profiles in share row exclusive mode;

  select e.*
    into v_existing
    from public.stripe_webhook_events as e
   where e.event_id = p_event_id
   for update;
  if found then
    if v_existing.event_type is distinct from 'checkout.session.completed'
       or v_existing.customer_id is distinct from p_customer_id
       or v_existing.subscription_id is distinct from p_subscription_id
       or v_existing.event_created is distinct from p_event_created
       or v_existing.plan is distinct from 'pro'
       or v_existing.checkout_session_id is distinct from p_session_id then
      raise exception 'Stripe event ID was reused with different data' using errcode = '22023';
    end if;
    return query select false, true, 1, 'duplicate';
    return;
  end if;

  select count(*)::integer
    into v_matched
    from public.profiles as p
   where p.stripe_customer_id = p_customer_id;
  if v_matched <> 1 then
    return query select false, false, v_matched, 'customer attribution failed';
    return;
  end if;

  select s.*
    into v_checkout
    from public.stripe_checkout_sessions as s
   where s.session_id = p_session_id
   for update;
  if not found
     or v_checkout.customer_id is distinct from p_customer_id then
    return query select false, false, v_matched, 'checkout session attribution failed';
    return;
  end if;

  if v_checkout.status = 'completed' then
    select e.*
      into v_existing
      from public.stripe_webhook_events as e
     where e.checkout_session_id = p_session_id
     for update;
    if not found then
      return query select false, false, v_matched, 'checkout completion ledger missing';
      return;
    end if;
    if v_existing.event_type is distinct from 'checkout.session.completed'
       or v_existing.event_id is distinct from p_event_id
       or v_existing.customer_id is distinct from p_customer_id
       or v_existing.subscription_id is distinct from p_subscription_id
       or v_existing.event_created is distinct from p_event_created
       or v_existing.plan is distinct from 'pro' then
      raise exception 'Checkout session was already completed with different data'
        using errcode = '22023';
    end if;
    return query select false, true, v_matched, 'duplicate';
    return;
  end if;
  if v_checkout.status <> 'created' then
    return query select false, false, v_matched, 'checkout session is not created';
    return;
  end if;

  select p.*
    into v_profile
    from public.profiles as p
   where p.id = v_checkout.user_id
     and p.stripe_customer_id = p_customer_id
   for update;
  if not found then
    return query select false, false, v_matched, 'checkout user attribution failed';
    return;
  end if;
  if v_profile.plan = 'pro'
     and v_profile.stripe_subscription_id is distinct from p_subscription_id then
    return query select false, false, v_matched, 'active subscription already bound';
    return;
  end if;
  if v_profile.stripe_subscription_id is not null
     and (
       v_profile.last_billing_event_type is distinct from 'customer.subscription.deleted'
       or v_profile.last_billing_subscription_id is distinct from v_profile.stripe_subscription_id
       or p_subscription_id = v_profile.stripe_subscription_id
     ) then
    return query select false, false, v_matched, 'active subscription must be cancelled';
    return;
  end if;

  insert into public.stripe_webhook_events
    (event_id, event_type, customer_id, subscription_id, event_created, plan, checkout_session_id)
  values
    (p_event_id, 'checkout.session.completed', p_customer_id, p_subscription_id,
     p_event_created, 'pro', p_session_id)
  on conflict (event_id) do nothing
  returning event_id into v_inserted_id;
  if v_inserted_id is null then
    select e.*
      into v_existing
      from public.stripe_webhook_events as e
     where e.event_id = p_event_id
     for update;
    if v_existing.event_type is distinct from 'checkout.session.completed'
       or v_existing.customer_id is distinct from p_customer_id
       or v_existing.subscription_id is distinct from p_subscription_id
       or v_existing.event_created is distinct from p_event_created
       or v_existing.plan is distinct from 'pro'
       or v_existing.checkout_session_id is distinct from p_session_id then
      raise exception 'Stripe event ID was reused with different data' using errcode = '22023';
    end if;
    return query select false, true, v_matched, 'duplicate';
    return;
  end if;

  update public.profiles
     set plan = 'pro',
         stripe_subscription_id = p_subscription_id,
         last_billing_subscription_id = p_subscription_id,
         last_billing_event_created = p_event_created,
         last_billing_event_id = p_event_id,
         last_billing_event_type = 'checkout.session.completed'
   where id = v_profile.id;
  update public.stripe_checkout_sessions
     set status = 'completed', subscription_id = p_subscription_id
   where intent_id = v_checkout.intent_id;
  return query select true, false, v_matched, 'applied';
end;
$$;
alter function public.complete_stripe_checkout(text, bigint, text, text, text) owner to postgres;
revoke all on function public.complete_stripe_checkout(text, bigint, text, text, text) from public, anon, authenticated;
grant execute on function public.complete_stripe_checkout(text, bigint, text, text, text) to service_role;

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
  v_last_event_type text;
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
       'customer.subscription.deleted',
       'customer.subscription.paused',
       'customer.subscription.resumed'
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
  if p_event_type = 'customer.subscription.deleted' and p_plan <> 'free' then
    raise exception 'Deleted subscription event cannot grant pro' using errcode = '22023';
  end if;
  if p_event_type = 'customer.subscription.paused' and p_plan <> 'free' then
    raise exception 'Paused subscription event must be free' using errcode = '22023';
  end if;
  if p_event_type = 'customer.subscription.resumed' and p_plan <> 'pro' then
    raise exception 'Resumed subscription event must grant pro' using errcode = '22023';
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
         p.last_billing_event_created, p.last_billing_event_id,
         p.last_billing_event_type
    into v_profile_id, v_subscription_id, v_last_subscription_id, v_last_created,
         v_last_id, v_last_event_type
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
  if v_last_event_type = 'customer.subscription.deleted'
     and v_last_subscription_id = p_subscription_id then
    return query select false, false, v_matched, 'subscription permanently fenced';
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
  v_plan text;
  v_live_count bigint;
  v_row public.trades%rowtype;
begin
  if v_uid is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if p_delete is null then
    raise exception 'Invalid delete flag' using errcode = '22023';
  end if;
  if p_id is null
     or pg_catalog.length(p_id) > 64
     or p_id !~ '^[A-Za-z0-9_-]+$' then
    raise exception 'Invalid trade ID' using errcode = '22023';
  end if;
  if p_data is not null
     and (
       pg_catalog.jsonb_typeof(p_data) <> 'object'
       or pg_catalog.octet_length(p_data::text) > 65536
     ) then
    raise exception 'Invalid trade data' using errcode = '22023';
  end if;
  if not p_delete and not public.trade_data_is_valid(p_data) then
    raise exception 'Invalid trade data' using errcode = '22023';
  end if;

  -- The profile lock serialises all free-plan creates and restores for one
  -- user, so two concurrent writers cannot both pass the live-row cap.
  select p.plan
    into v_plan
    from public.profiles as p
   where p.id = v_uid
   for update;
  if not found then
    raise exception 'Account profile is not initialised' using errcode = '42501';
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

    if not p_delete and v_row.deleted_at is not null and v_plan = 'free' then
      select count(*)::bigint
        into v_live_count
        from public.trades as t
       where t.user_id = v_uid
         and t.deleted_at is null;
      if v_live_count >= 50 then
        raise exception 'free_trade_cap'
          using errcode = 'P0001', detail = 'Free plan permits 50 live trades';
      end if;
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

    if not p_delete and v_plan = 'free' then
      select count(*)::bigint
        into v_live_count
        from public.trades as t
       where t.user_id = v_uid
         and t.deleted_at is null;
      if v_live_count >= 50 then
        raise exception 'free_trade_cap'
          using errcode = 'P0001', detail = 'Free plan permits 50 live trades';
      end if;
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
