-- Kujira Portfolio, private single-owner Supabase storage
--
-- The owner table is intentionally private.  The public table is a durable
-- record envelope around the legacy local collections, with tombstones and a
-- server-owned sequence for incremental reconciliation.

begin;

create schema if not exists private;

do $portfolio_rpc_role$
begin
  if not exists (
    select 1
      from pg_catalog.pg_roles
     where rolname = 'portfolio_rpc'
  ) then
    create role portfolio_rpc
      nologin
      nosuperuser
      nocreatedb
      nocreaterole
      noreplication
      nobypassrls
      noinherit;
  end if;
end;
$portfolio_rpc_role$;

alter role portfolio_rpc
  with nologin
       nosuperuser
       nocreatedb
       nocreaterole
       noreplication
       nobypassrls
       noinherit;

create sequence if not exists public.portfolio_change_seq
  as bigint
  start with 1
  increment by 1
  minvalue 1;

create table if not exists private.portfolio_owner (
  owner_key boolean not null default true,
  owner_id  uuid    not null unique
    references auth.users (id) on delete restrict,
  bound_at  timestamptz not null default pg_catalog.now(),
  primary key (owner_key),
  constraint portfolio_owner_singleton_check check (owner_key)
);

-- This is deliberately an install-time guard.  A database with more than one
-- existing Auth user is not safe to bind implicitly, so the migration stops
-- before it can choose an owner.  A re-run never rewrites an established one.
do $portfolio_owner_install$
declare
  v_user_count bigint;
  v_user_id uuid;
begin
  perform pg_catalog.pg_advisory_xact_lock(741234567890123456);

  select count(*)
    into v_user_count
    from auth.users as u;

  if v_user_count > 1 then
    raise exception 'PORTFOLIO_OWNER_MULTIPLE_USERS';
  end if;

  if v_user_count = 1
     and not exists (
       select 1
         from private.portfolio_owner as po
        where po.owner_key = true
     ) then
    select u.id
      into v_user_id
      from auth.users as u
     limit 1;

    insert into private.portfolio_owner (owner_key, owner_id)
    values (true, v_user_id)
    on conflict (owner_key) do nothing;
  end if;
end;
$portfolio_owner_install$;

create table if not exists public.portfolio_records (
  user_id     uuid not null
    references private.portfolio_owner (owner_id) on delete restrict,
  record_type text not null,
  record_id   text not null,
  position    integer not null default 0,
  payload     jsonb not null default '{}'::jsonb,
  version     bigint not null default 1,
  change_seq  bigint not null,
  created_at  timestamptz not null default pg_catalog.now(),
  updated_at  timestamptz not null default pg_catalog.now(),
  deleted_at  timestamptz,
  constraint portfolio_records_pkey primary key (user_id, record_type, record_id),
  constraint portfolio_records_record_type_check check (
    record_type in (
      'stocks', 'stockTxns', 'watchlist', 'crypto', 'realestate',
      'cash', 'cashTxns', 'cpfHistory', 'income', 'expenses',
      'snapshots', 'trash', 'insurance', 'insuranceRiders',
      'cpfBalances', 'categories', 'settings', '_meta', '_syncMeta'
    )
  ),
  constraint portfolio_records_record_id_check check (
    record_id ~ '^[A-Za-z0-9_-]{1,64}$'
  ),
  constraint portfolio_records_payload_object_check check (
    pg_catalog.jsonb_typeof(payload) = 'object'
  ),
  constraint portfolio_records_position_check check (position >= 0),
  constraint portfolio_records_envelope_check check (
    (
      record_type in (
        'stocks', 'stockTxns', 'watchlist', 'crypto', 'realestate',
        'cash', 'cashTxns', 'cpfHistory', 'income', 'expenses',
        'snapshots', 'trash', 'insurance', 'insuranceRiders'
      )
      and payload ? 'id'
      and pg_catalog.jsonb_typeof(payload -> 'id') = 'string'
      and payload ->> 'id' = record_id
    )
    or (
      record_type in ('cpfBalances', 'categories', 'settings', '_meta', '_syncMeta')
      and record_id = 'singleton'
      and position = 0
    )
  ),
  constraint portfolio_records_version_check check (version >= 1)
);

alter sequence public.portfolio_change_seq
  owned by public.portfolio_records.change_seq;

create index if not exists portfolio_records_sync_idx
  on public.portfolio_records (user_id, change_seq, record_type, record_id);

-- The sequence and timestamp are server-owned.  The trigger also covers
-- administrative inserts and updates, so no caller can supply a cursor value.
create or replace function public.portfolio_stamp_record()
returns trigger
language plpgsql
security definer
set search_path = ''
as $portfolio_stamp_record$
begin
  -- Hold the allocation lock until this transaction commits. Without this,
  -- two transactions can reserve change_seq values in allocation order while
  -- committing in the opposite order, allowing a cursor boundary to skip
  -- the earlier transaction forever.
  perform pg_catalog.pg_advisory_xact_lock(741234567890123457);
  new.change_seq := pg_catalog.nextval(
    'public.portfolio_change_seq'::pg_catalog.regclass
  );
  if tg_op = 'UPDATE' then
    new.updated_at := pg_catalog.clock_timestamp();
  end if;
  return new;
end;
$portfolio_stamp_record$;

drop trigger if exists portfolio_stamp_record on public.portfolio_records;
create trigger portfolio_stamp_record
before insert or update on public.portfolio_records
for each row execute function public.portfolio_stamp_record();

-- API reads are deliberately narrower than table access.  The foreign key
-- constrains every record to the configured owner, so auth.uid() = user_id is
-- also an explicit configured-owner check without exposing private.owner.
alter table public.portfolio_records enable row level security;
alter table public.portfolio_records force row level security;

drop policy if exists portfolio_records_owner_select on public.portfolio_records;
drop policy if exists portfolio_records_rpc_insert on public.portfolio_records;
drop policy if exists portfolio_records_rpc_update on public.portfolio_records;
create policy portfolio_records_owner_select
on public.portfolio_records
for select to authenticated, portfolio_rpc
using (
  auth.uid() is not null
  and (auth.jwt() ->> 'aal') = 'aal2'
  and auth.uid() = user_id
);

create policy portfolio_records_rpc_insert
on public.portfolio_records
for insert to portfolio_rpc
with check (
  auth.uid() is not null
  and (auth.jwt() ->> 'aal') = 'aal2'
  and auth.uid() = user_id
);

create policy portfolio_records_rpc_update
on public.portfolio_records
for update to portfolio_rpc
using (
  auth.uid() is not null
  and (auth.jwt() ->> 'aal') = 'aal2'
  and auth.uid() = user_id
)
with check (
  auth.uid() is not null
  and (auth.jwt() ->> 'aal') = 'aal2'
  and auth.uid() = user_id
);

-- The Auth trigger binds the first user created after installation.  The
-- advisory lock makes two concurrent first-user inserts deterministic.
create or replace function public.portfolio_bind_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $portfolio_bind_auth_user$
declare
  v_owner_id uuid;
begin
  perform pg_catalog.pg_advisory_xact_lock(741234567890123456);

  select po.owner_id
    into v_owner_id
    from private.portfolio_owner as po
   where po.owner_key = true
   for update;

  if v_owner_id is not null then
    raise exception 'PORTFOLIO_OWNER_ALREADY_BOUND';
  end if;

  insert into private.portfolio_owner (owner_key, owner_id)
  values (true, new.id);

  return new;
exception
  when unique_violation then
    raise exception 'PORTFOLIO_OWNER_ALREADY_BOUND';
end;
$portfolio_bind_auth_user$;

drop trigger if exists portfolio_bind_auth_user_after_insert on auth.users;
create trigger portfolio_bind_auth_user_after_insert
after insert on auth.users
for each row execute function public.portfolio_bind_auth_user();

-- ---------------------------------------------------------------------------
-- Authorised RPCs
-- ---------------------------------------------------------------------------

create or replace function public.portfolio_upsert_record(
  p_record_type text,
  p_record_id text,
  p_payload jsonb,
  p_position integer,
  p_expected_version bigint
)
returns table (
  user_id uuid,
  record_type text,
  record_id text,
  "position" integer,
  payload jsonb,
  version bigint,
  change_seq bigint,
  created_at timestamptz,
  updated_at timestamptz,
  deleted_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $portfolio_upsert_record$
declare
  v_uid uuid := auth.uid();
  v_row public.portfolio_records%rowtype;
  v_deleted_at timestamptz;
begin
  if v_uid is null then
    raise exception 'PORTFOLIO_AUTH_REQUIRED';
  end if;
  if coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then
    raise exception 'PORTFOLIO_AAL2_REQUIRED';
  end if;
  if not exists (
    select 1
      from private.portfolio_owner as po
     where po.owner_key = true
       and po.owner_id = v_uid
  ) then
    raise exception 'PORTFOLIO_NOT_OWNER';
  end if;

  if p_record_type is null or p_record_type not in (
    'stocks', 'stockTxns', 'watchlist', 'crypto', 'realestate',
    'cash', 'cashTxns', 'cpfHistory', 'income', 'expenses',
    'snapshots', 'trash', 'insurance', 'insuranceRiders',
    'cpfBalances', 'categories', 'settings', '_meta', '_syncMeta'
  ) then
    raise exception 'PORTFOLIO_INVALID_RECORD_TYPE';
  end if;
  if p_record_id is null
     or p_record_id !~ '^[A-Za-z0-9_-]{1,64}$'
     or pg_catalog.char_length(p_record_id) > 64 then
    raise exception 'PORTFOLIO_INVALID_RECORD_ID';
  end if;
  if p_payload is null or pg_catalog.jsonb_typeof(p_payload) <> 'object' then
    raise exception 'PORTFOLIO_INVALID_PAYLOAD';
  end if;
  if p_position is null or p_position < 0 then
    raise exception 'PORTFOLIO_INVALID_POSITION';
  end if;
  if (
    p_record_type in (
      'stocks', 'stockTxns', 'watchlist', 'crypto', 'realestate',
      'cash', 'cashTxns', 'cpfHistory', 'income', 'expenses',
      'snapshots', 'trash', 'insurance', 'insuranceRiders'
    )
    and (
      not (p_payload ? 'id')
      or pg_catalog.jsonb_typeof(p_payload -> 'id') <> 'string'
      or (p_payload ->> 'id') is distinct from p_record_id
    )
  ) or (
    p_record_type in ('cpfBalances', 'categories', 'settings', '_meta', '_syncMeta')
    and (p_record_id <> 'singleton' or p_position <> 0)
  ) then
    raise exception 'PORTFOLIO_INVALID_ENVELOPE';
  end if;
  if p_expected_version is null or p_expected_version < 0 then
    raise exception 'PORTFOLIO_INVALID_EXPECTED_VERSION';
  end if;

  if p_expected_version = 0 then
    insert into public.portfolio_records (
      user_id, record_type, record_id, position, payload, version, deleted_at
    )
    values (
      v_uid, p_record_type, p_record_id, p_position, p_payload, 1, null
    )
    on conflict on constraint portfolio_records_pkey do nothing
    returning * into v_row;

    if not found then
      select r.deleted_at
        into v_deleted_at
        from public.portfolio_records as r
       where r.user_id = v_uid
         and r.record_type = p_record_type
         and r.record_id = p_record_id;
      if not found then
        raise exception 'PORTFOLIO_CONFLICT';
      elsif v_deleted_at is not null then
        raise exception 'PORTFOLIO_TOMBSTONED';
      else
        raise exception 'PORTFOLIO_CONFLICT';
      end if;
    end if;
  else
    update public.portfolio_records as r
       set position = p_position,
           payload = p_payload,
           version = r.version + 1,
           deleted_at = null
     where r.user_id = v_uid
       and r.record_type = p_record_type
       and r.record_id = p_record_id
       and r.version = p_expected_version
       and r.deleted_at is null
    returning r.* into v_row;

    if not found then
      select r.deleted_at
        into v_deleted_at
        from public.portfolio_records as r
       where r.user_id = v_uid
         and r.record_type = p_record_type
         and r.record_id = p_record_id;
      if not found then
        raise exception 'PORTFOLIO_NOT_FOUND';
      elsif v_deleted_at is not null then
        raise exception 'PORTFOLIO_TOMBSTONED';
      else
        raise exception 'PORTFOLIO_CONFLICT';
      end if;
    end if;
  end if;

  return query
  select v_row.user_id, v_row.record_type, v_row.record_id,
         v_row.position, v_row.payload, v_row.version, v_row.change_seq,
         v_row.created_at, v_row.updated_at, v_row.deleted_at;
end;
$portfolio_upsert_record$;

create or replace function public.portfolio_delete_record(
  p_record_type text,
  p_record_id text,
  p_expected_version bigint
)
returns table (
  user_id uuid,
  record_type text,
  record_id text,
  "position" integer,
  payload jsonb,
  version bigint,
  change_seq bigint,
  created_at timestamptz,
  updated_at timestamptz,
  deleted_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $portfolio_delete_record$
declare
  v_uid uuid := auth.uid();
  v_row public.portfolio_records%rowtype;
  v_deleted_at timestamptz;
begin
  if v_uid is null then
    raise exception 'PORTFOLIO_AUTH_REQUIRED';
  end if;
  if coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then
    raise exception 'PORTFOLIO_AAL2_REQUIRED';
  end if;
  if not exists (
    select 1
      from private.portfolio_owner as po
     where po.owner_key = true
       and po.owner_id = v_uid
  ) then
    raise exception 'PORTFOLIO_NOT_OWNER';
  end if;

  if p_record_type is null or p_record_type not in (
    'stocks', 'stockTxns', 'watchlist', 'crypto', 'realestate',
    'cash', 'cashTxns', 'cpfHistory', 'income', 'expenses',
    'snapshots', 'trash', 'insurance', 'insuranceRiders',
    'cpfBalances', 'categories', 'settings', '_meta', '_syncMeta'
  ) then
    raise exception 'PORTFOLIO_INVALID_RECORD_TYPE';
  end if;
  if p_record_id is null
     or p_record_id !~ '^[A-Za-z0-9_-]{1,64}$'
     or pg_catalog.char_length(p_record_id) > 64 then
    raise exception 'PORTFOLIO_INVALID_RECORD_ID';
  end if;
  if p_expected_version is null or p_expected_version < 0 then
    raise exception 'PORTFOLIO_INVALID_EXPECTED_VERSION';
  end if;

  update public.portfolio_records as r
     set deleted_at = pg_catalog.clock_timestamp(),
         version = r.version + 1
   where r.user_id = v_uid
     and r.record_type = p_record_type
     and r.record_id = p_record_id
     and r.version = p_expected_version
     and r.deleted_at is null
  returning r.* into v_row;

  if not found then
    select r.deleted_at
      into v_deleted_at
      from public.portfolio_records as r
     where r.user_id = v_uid
       and r.record_type = p_record_type
       and r.record_id = p_record_id;
    if not found then
      raise exception 'PORTFOLIO_NOT_FOUND';
    elsif v_deleted_at is not null then
      raise exception 'PORTFOLIO_ALREADY_DELETED';
    else
      raise exception 'PORTFOLIO_CONFLICT';
    end if;
  end if;

  return query
  select v_row.user_id, v_row.record_type, v_row.record_id,
         v_row.position, v_row.payload, v_row.version, v_row.change_seq,
         v_row.created_at, v_row.updated_at, v_row.deleted_at;
end;
$portfolio_delete_record$;

create or replace function public.portfolio_restore_record(
  p_record_type text,
  p_record_id text,
  p_payload jsonb,
  p_position integer,
  p_expected_version bigint
)
returns table (
  user_id uuid,
  record_type text,
  record_id text,
  "position" integer,
  payload jsonb,
  version bigint,
  change_seq bigint,
  created_at timestamptz,
  updated_at timestamptz,
  deleted_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $portfolio_restore_record$
declare
  v_uid uuid := auth.uid();
  v_row public.portfolio_records%rowtype;
  v_deleted_at timestamptz;
begin
  if v_uid is null then
    raise exception 'PORTFOLIO_AUTH_REQUIRED';
  end if;
  if coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then
    raise exception 'PORTFOLIO_AAL2_REQUIRED';
  end if;
  if not exists (
    select 1
      from private.portfolio_owner as po
     where po.owner_key = true
       and po.owner_id = v_uid
  ) then
    raise exception 'PORTFOLIO_NOT_OWNER';
  end if;

  if p_record_type is null or p_record_type not in (
    'stocks', 'stockTxns', 'watchlist', 'crypto', 'realestate',
    'cash', 'cashTxns', 'cpfHistory', 'income', 'expenses',
    'snapshots', 'trash', 'insurance', 'insuranceRiders',
    'cpfBalances', 'categories', 'settings', '_meta', '_syncMeta'
  ) then
    raise exception 'PORTFOLIO_INVALID_RECORD_TYPE';
  end if;
  if p_record_id is null
     or p_record_id !~ '^[A-Za-z0-9_-]{1,64}$'
     or pg_catalog.char_length(p_record_id) > 64 then
    raise exception 'PORTFOLIO_INVALID_RECORD_ID';
  end if;
  if p_payload is null or pg_catalog.jsonb_typeof(p_payload) <> 'object' then
    raise exception 'PORTFOLIO_INVALID_PAYLOAD';
  end if;
  if p_position is null or p_position < 0 then
    raise exception 'PORTFOLIO_INVALID_POSITION';
  end if;
  if (
    p_record_type in (
      'stocks', 'stockTxns', 'watchlist', 'crypto', 'realestate',
      'cash', 'cashTxns', 'cpfHistory', 'income', 'expenses',
      'snapshots', 'trash', 'insurance', 'insuranceRiders'
    )
    and (
      not (p_payload ? 'id')
      or pg_catalog.jsonb_typeof(p_payload -> 'id') <> 'string'
      or (p_payload ->> 'id') is distinct from p_record_id
    )
  ) or (
    p_record_type in ('cpfBalances', 'categories', 'settings', '_meta', '_syncMeta')
    and (p_record_id <> 'singleton' or p_position <> 0)
  ) then
    raise exception 'PORTFOLIO_INVALID_ENVELOPE';
  end if;
  if p_expected_version is null or p_expected_version < 0 then
    raise exception 'PORTFOLIO_INVALID_EXPECTED_VERSION';
  end if;

  update public.portfolio_records as r
     set deleted_at = null,
         payload = p_payload,
         position = p_position,
         updated_at = pg_catalog.clock_timestamp(),
         version = r.version + 1
   where r.user_id = v_uid
     and r.record_type = p_record_type
     and r.record_id = p_record_id
     and r.version = p_expected_version
     and r.deleted_at is not null
  returning r.* into v_row;

  if not found then
    select r.deleted_at
      into v_deleted_at
      from public.portfolio_records as r
     where r.user_id = v_uid
       and r.record_type = p_record_type
       and r.record_id = p_record_id;
    if not found then
      raise exception 'PORTFOLIO_NOT_FOUND';
    elsif v_deleted_at is null then
      raise exception 'PORTFOLIO_ALREADY_LIVE';
    else
      raise exception 'PORTFOLIO_CONFLICT';
    end if;
  end if;

  return query
  select v_row.user_id, v_row.record_type, v_row.record_id,
         v_row.position, v_row.payload, v_row.version, v_row.change_seq,
         v_row.created_at, v_row.updated_at, v_row.deleted_at;
end;
$portfolio_restore_record$;

-- Preserve the existing client call shape while keeping it CAS-safe.  This
-- compatibility overload restores the current stored payload and position in
-- the same atomic state transition, so it cannot race a separate write.
create or replace function public.portfolio_restore_record(
  p_record_type text,
  p_record_id text,
  p_expected_version bigint
)
returns table (
  user_id uuid,
  record_type text,
  record_id text,
  "position" integer,
  payload jsonb,
  version bigint,
  change_seq bigint,
  created_at timestamptz,
  updated_at timestamptz,
  deleted_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $portfolio_restore_record_legacy$
declare
  v_uid uuid := auth.uid();
  v_row public.portfolio_records%rowtype;
  v_deleted_at timestamptz;
begin
  if v_uid is null then
    raise exception 'PORTFOLIO_AUTH_REQUIRED';
  end if;
  if coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then
    raise exception 'PORTFOLIO_AAL2_REQUIRED';
  end if;
  if not exists (
    select 1
      from private.portfolio_owner as po
     where po.owner_key = true
       and po.owner_id = v_uid
  ) then
    raise exception 'PORTFOLIO_NOT_OWNER';
  end if;

  if p_record_type is null or p_record_type not in (
    'stocks', 'stockTxns', 'watchlist', 'crypto', 'realestate',
    'cash', 'cashTxns', 'cpfHistory', 'income', 'expenses',
    'snapshots', 'trash', 'insurance', 'insuranceRiders',
    'cpfBalances', 'categories', 'settings', '_meta', '_syncMeta'
  ) then
    raise exception 'PORTFOLIO_INVALID_RECORD_TYPE';
  end if;
  if p_record_id is null
     or p_record_id !~ '^[A-Za-z0-9_-]{1,64}$'
     or pg_catalog.char_length(p_record_id) > 64 then
    raise exception 'PORTFOLIO_INVALID_RECORD_ID';
  end if;
  if p_expected_version is null or p_expected_version < 0 then
    raise exception 'PORTFOLIO_INVALID_EXPECTED_VERSION';
  end if;

  update public.portfolio_records as r
     set deleted_at = null,
         updated_at = pg_catalog.clock_timestamp(),
         version = r.version + 1
   where r.user_id = v_uid
     and r.record_type = p_record_type
     and r.record_id = p_record_id
     and r.version = p_expected_version
     and r.deleted_at is not null
  returning r.* into v_row;

  if not found then
    select r.deleted_at
      into v_deleted_at
      from public.portfolio_records as r
     where r.user_id = v_uid
       and r.record_type = p_record_type
       and r.record_id = p_record_id;
    if not found then
      raise exception 'PORTFOLIO_NOT_FOUND';
    elsif v_deleted_at is null then
      raise exception 'PORTFOLIO_ALREADY_LIVE';
    else
      raise exception 'PORTFOLIO_CONFLICT';
    end if;
  end if;

  return query
  select v_row.user_id, v_row.record_type, v_row.record_id,
         v_row.position, v_row.payload, v_row.version, v_row.change_seq,
         v_row.created_at, v_row.updated_at, v_row.deleted_at;
end;
$portfolio_restore_record_legacy$;

create or replace function public.portfolio_get_records_page(
  p_after_change_seq bigint default 0,
  p_snapshot_sequence bigint default null,
  p_limit integer default 200
)
returns table (
  user_id uuid,
  record_type text,
  record_id text,
  "position" integer,
  payload jsonb,
  version bigint,
  change_seq bigint,
  created_at timestamptz,
  updated_at timestamptz,
  deleted_at timestamptz,
  snapshot_sequence bigint
)
language plpgsql
security definer
set search_path = ''
as $portfolio_get_records_page$
declare
  v_uid uuid := auth.uid();
  v_snapshot_sequence bigint;
begin
  if v_uid is null then
    raise exception 'PORTFOLIO_AUTH_REQUIRED';
  end if;
  if coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then
    raise exception 'PORTFOLIO_AAL2_REQUIRED';
  end if;
  if not exists (
    select 1
      from private.portfolio_owner as po
     where po.owner_key = true
       and po.owner_id = v_uid
  ) then
    raise exception 'PORTFOLIO_NOT_OWNER';
  end if;
  if p_after_change_seq is null or p_after_change_seq < 0 then
    raise exception 'PORTFOLIO_INVALID_CURSOR';
  end if;
  if p_snapshot_sequence is not null and p_snapshot_sequence < 0 then
    raise exception 'PORTFOLIO_INVALID_SNAPSHOT';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 500 then
    raise exception 'PORTFOLIO_INVALID_LIMIT';
  end if;

  if p_snapshot_sequence is null then
    select coalesce(max(r.change_seq), 0)
      into v_snapshot_sequence
      from public.portfolio_records as r
     where r.user_id = v_uid;
  else
    v_snapshot_sequence := p_snapshot_sequence;
  end if;

  if p_after_change_seq > v_snapshot_sequence then
    raise exception 'PORTFOLIO_INVALID_CURSOR';
  end if;

  return query
  select r.user_id, r.record_type, r.record_id, r.position, r.payload,
         r.version, r.change_seq, r.created_at, r.updated_at,
         r.deleted_at, v_snapshot_sequence as snapshot_sequence
    from public.portfolio_records as r
   where r.user_id = v_uid
     and r.change_seq > p_after_change_seq
     and r.change_seq <= v_snapshot_sequence
   order by r.change_seq asc, r.record_type asc, r.record_id asc
   limit p_limit;
end;
$portfolio_get_records_page$;

create or replace function public.portfolio_sync_page(
  p_after_change_seq bigint default 0,
  p_limit integer default 200
)
returns table (
  user_id uuid,
  record_type text,
  record_id text,
  "position" integer,
  payload jsonb,
  version bigint,
  change_seq bigint,
  created_at timestamptz,
  updated_at timestamptz,
  deleted_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $portfolio_sync_page$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'PORTFOLIO_AUTH_REQUIRED';
  end if;
  if coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then
    raise exception 'PORTFOLIO_AAL2_REQUIRED';
  end if;
  if not exists (
    select 1
      from private.portfolio_owner as po
     where po.owner_key = true
       and po.owner_id = v_uid
  ) then
    raise exception 'PORTFOLIO_NOT_OWNER';
  end if;
  if p_after_change_seq is null or p_after_change_seq < 0 then
    raise exception 'PORTFOLIO_INVALID_CURSOR';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 500 then
    raise exception 'PORTFOLIO_INVALID_LIMIT';
  end if;

  return query
  select r.user_id, r.record_type, r.record_id, r.position, r.payload,
         r.version, r.change_seq, r.created_at, r.updated_at,
         r.deleted_at
    from public.portfolio_records as r
   where r.user_id = v_uid
     and r.change_seq > p_after_change_seq
   order by r.change_seq asc, r.record_type asc, r.record_id asc
   limit p_limit;
end;
$portfolio_sync_page$;

create or replace function public.portfolio_sync_boundary()
returns bigint
language plpgsql
security definer
set search_path = ''
as $portfolio_sync_boundary$
declare
  v_uid uuid := auth.uid();
  v_boundary bigint;
begin
  if v_uid is null then
    raise exception 'PORTFOLIO_AUTH_REQUIRED';
  end if;
  if coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then
    raise exception 'PORTFOLIO_AAL2_REQUIRED';
  end if;
  if not exists (
    select 1
      from private.portfolio_owner as po
     where po.owner_key = true
       and po.owner_id = v_uid
  ) then
    raise exception 'PORTFOLIO_NOT_OWNER';
  end if;

  select coalesce(max(r.change_seq), 0)
    into v_boundary
    from public.portfolio_records as r
   where r.user_id = v_uid;
  return v_boundary;
end;
$portfolio_sync_boundary$;

-- The table owner remains the migration administrator.  Function ownership is
-- moved to the non-login, NO BYPASSRLS role so FORCE RLS applies inside every
-- SECURITY DEFINER function as well as at the API boundary.
alter function public.portfolio_stamp_record() owner to portfolio_rpc;
alter function public.portfolio_bind_auth_user() owner to portfolio_rpc;
alter function public.portfolio_upsert_record(text, text, jsonb, integer, bigint)
  owner to portfolio_rpc;
alter function public.portfolio_delete_record(text, text, bigint)
  owner to portfolio_rpc;
alter function public.portfolio_restore_record(text, text, jsonb, integer, bigint)
  owner to portfolio_rpc;
alter function public.portfolio_restore_record(text, text, bigint)
  owner to portfolio_rpc;
alter function public.portfolio_get_records_page(bigint, bigint, integer)
  owner to portfolio_rpc;
alter function public.portfolio_sync_page(bigint, integer)
  owner to portfolio_rpc;
alter function public.portfolio_sync_boundary()
  owner to portfolio_rpc;

-- Keep all API entry points deny-by-default.  The trigger functions are
-- callable only by their triggers, while the five canonical RPCs and one
-- CAS-safe restore compatibility overload are the only
-- functions callable by the authenticated API role.  service_role is denied
-- explicitly as defence in depth for this schema.
revoke all on function public.portfolio_stamp_record() from PUBLIC, anon, authenticated, service_role;
revoke all on function public.portfolio_bind_auth_user() from PUBLIC, anon, authenticated, service_role;

revoke all on function public.portfolio_upsert_record(text, text, jsonb, integer, bigint)
  from PUBLIC, anon, authenticated, service_role;
revoke all on function public.portfolio_delete_record(text, text, bigint)
  from PUBLIC, anon, authenticated, service_role;
revoke all on function public.portfolio_restore_record(text, text, jsonb, integer, bigint)
  from PUBLIC, anon, authenticated, service_role;
revoke all on function public.portfolio_restore_record(text, text, bigint)
  from PUBLIC, anon, authenticated, service_role;
revoke all on function public.portfolio_get_records_page(bigint, bigint, integer)
  from PUBLIC, anon, authenticated, service_role;
revoke all on function public.portfolio_sync_page(bigint, integer)
  from PUBLIC, anon, authenticated, service_role;
revoke all on function public.portfolio_sync_boundary()
  from PUBLIC, anon, authenticated, service_role;

grant execute on function public.portfolio_upsert_record(text, text, jsonb, integer, bigint)
  to authenticated;
grant execute on function public.portfolio_delete_record(text, text, bigint)
  to authenticated;
grant execute on function public.portfolio_restore_record(text, text, jsonb, integer, bigint)
  to authenticated;
grant execute on function public.portfolio_restore_record(text, text, bigint)
  to authenticated;
grant execute on function public.portfolio_get_records_page(bigint, bigint, integer)
  to authenticated;
grant execute on function public.portfolio_sync_boundary()
  to authenticated;

-- No API role can alter ownership, records, or the sequence directly.  The
-- only table read granted below is the RLS-protected records table.
revoke create on schema public from PUBLIC, service_role;
revoke all on schema private from PUBLIC, anon, authenticated, service_role;
revoke all on table private.portfolio_owner from PUBLIC, anon, authenticated, service_role;
revoke all on table public.portfolio_records from PUBLIC, anon, authenticated, service_role;
revoke all on sequence public.portfolio_change_seq from PUBLIC, anon, authenticated, service_role;
grant select on table public.portfolio_records to authenticated;

-- Minimal definer-role access.  The role cannot log in or bypass RLS, and it
-- has no direct delete, truncate, references, or trigger privilege.
revoke all on schema public, private, auth from portfolio_rpc;
revoke all on function auth.uid() from PUBLIC, anon, authenticated, service_role, portfolio_rpc;
revoke all on function auth.jwt() from PUBLIC, anon, authenticated, service_role, portfolio_rpc;
revoke all on table private.portfolio_owner from portfolio_rpc;
revoke all on table public.portfolio_records from portfolio_rpc;
revoke all on sequence public.portfolio_change_seq from portfolio_rpc;
grant usage on schema public, private, auth to portfolio_rpc;
grant execute on function auth.uid() to authenticated;
grant execute on function auth.uid() to portfolio_rpc;
grant execute on function auth.jwt() to authenticated;
grant execute on function auth.jwt() to portfolio_rpc;
grant select, insert, update on table private.portfolio_owner to portfolio_rpc;
grant select, insert, update on table public.portfolio_records to portfolio_rpc;
grant usage on sequence public.portfolio_change_seq to portfolio_rpc;

revoke delete, truncate, references, trigger
  on table private.portfolio_owner from portfolio_rpc;
revoke delete, truncate, references, trigger
  on table public.portfolio_records from portfolio_rpc;

commit;
