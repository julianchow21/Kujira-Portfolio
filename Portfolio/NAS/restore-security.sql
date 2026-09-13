\set ON_ERROR_STOP on

begin;
set local search_path = pg_catalog;

do $portfolio_restore_security$
declare
  v_allowed_authenticated text[] := array[
    'public.portfolio_upsert_record(text,text,jsonb,integer,bigint)',
    'public.portfolio_delete_record(text,text,bigint)',
    'public.portfolio_restore_record(text,text,jsonb,integer,bigint)',
    'public.portfolio_restore_record(text,text,bigint)',
    'public.portfolio_get_records_page(bigint,bigint,integer)',
    'public.portfolio_sync_boundary()'
  ];
  v_function oid;
  v_function_signatures text[] := array[
    'public.portfolio_stamp_record()',
    'public.portfolio_bind_auth_user()',
    'public.portfolio_upsert_record(text,text,jsonb,integer,bigint)',
    'public.portfolio_delete_record(text,text,bigint)',
    'public.portfolio_restore_record(text,text,jsonb,integer,bigint)',
    'public.portfolio_restore_record(text,text,bigint)',
    'public.portfolio_get_records_page(bigint,bigint,integer)',
    'public.portfolio_sync_page(bigint,integer)',
    'public.portfolio_sync_boundary()'
  ];
  v_policy_roles oid[];
  v_role text;
  v_sequence_increment numeric;
  v_sequence_is_called boolean;
  v_sequence_last_value numeric;
  v_sequence_max_record numeric;
  v_sequence_next_value numeric;
  v_stamp_definition text;
  v_trusted_body_manifest text;
  v_trusted_body_entries text[];
  v_body_entry text;
  v_expected_body_hash text;
  v_actual_body_hash text;
  v_nextval_marker text := 'pg_catalog.' || 'nextval' || '(';
  v_signature text;
  v_owner_predicate text := $portfolio_owner_predicate$((auth.uid() IS NOT NULL) AND ((auth.jwt() ->> 'aal'::text) = 'aal2'::text) AND (auth.uid() = user_id))$portfolio_owner_predicate$;
begin
  if exists (
    select 1
      from pg_roles
     where rolname = 'portfolio_rpc'
       and (rolsuper or rolinherit or rolcreaterole or rolcreatedb or rolcanlogin
         or rolreplication or rolbypassrls)
  ) or not exists (select 1 from pg_roles where rolname = 'portfolio_rpc') then
    raise exception 'portfolio_rpc role attributes are unsafe';
  end if;

  if exists (
    select 1
      from pg_auth_members as membership
      join pg_roles as granted on granted.oid = membership.roleid
      join pg_roles as member on member.oid = membership.member
     where granted.rolname = 'portfolio_rpc'
        or member.rolname = 'portfolio_rpc'
  ) then
    raise exception 'portfolio_rpc role membership is unsafe';
  end if;

  foreach v_signature in array v_function_signatures loop
    v_function := to_regprocedure(v_signature);
    if v_function is null then
      raise exception 'required function is missing: %', v_signature;
    end if;
    if exists (
      select 1
        from pg_proc as p
       where p.oid = v_function
         and (pg_get_userbyid(p.proowner) <> 'portfolio_rpc'
           or not p.prosecdef
           or p.proconfig is null
           or cardinality(p.proconfig) <> 1
           or not ('search_path=""' = any(p.proconfig)))
    ) then
      raise exception 'function security contract failed: %', v_signature;
    end if;

    foreach v_role in array array['anon', 'authenticated', 'service_role'] loop
      if to_regrole(v_role) is null then
        raise exception 'required API role is missing: %', v_role;
      end if;
      if has_function_privilege(v_role, v_function, 'EXECUTE') is distinct from
        (v_role = 'authenticated' and v_signature = any(v_allowed_authenticated)) then
        raise exception 'function execute privilege mismatch: % for %', v_signature, v_role;
      end if;
    end loop;
  end loop;

  -- Metadata such as owner and SECURITY DEFINER does not prove that a
  -- restored function still has the canonical body. A trusted operator or
  -- test fixture supplies a generated hash manifest from a separately
  -- deployed canonical schema through this session-only setting. The audit
  -- compares every body, and never accepts the archive manifest as this
  -- producer-independent trust source.
  v_trusted_body_manifest := current_setting('portfolio.trusted_function_hashes', true);
  if v_trusted_body_manifest is null or pg_catalog.btrim(v_trusted_body_manifest) = '' then
    raise exception 'trusted canonical function body manifest is required';
  end if;
  v_trusted_body_entries := pg_catalog.string_to_array(v_trusted_body_manifest, '|');
  if pg_catalog.cardinality(v_trusted_body_entries) <> pg_catalog.cardinality(v_function_signatures) then
    raise exception 'trusted canonical function body manifest entry count mismatch';
  end if;
  foreach v_signature in array v_function_signatures loop
    v_function := to_regprocedure(v_signature);
    v_expected_body_hash := null;
    foreach v_body_entry in array v_trusted_body_entries loop
      if pg_catalog.split_part(v_body_entry, '=', 1) = v_signature then
        if v_expected_body_hash is not null then
          raise exception 'trusted canonical function body manifest duplicate: %', v_signature;
        end if;
        v_expected_body_hash := pg_catalog.split_part(v_body_entry, '=', 2);
      end if;
    end loop;
    if v_expected_body_hash is null
       or v_expected_body_hash !~ '^[0-9a-f]{32}$' then
      raise exception 'trusted canonical function body manifest entry missing: %', v_signature;
    end if;
    v_actual_body_hash := pg_catalog.md5(pg_catalog.pg_get_functiondef(v_function));
    if v_actual_body_hash <> v_expected_body_hash then
      raise exception 'Portfolio function body content mismatch: %', v_signature;
    end if;
  end loop;

  -- Sequence values are the sync cursor. The trigger must hold the
  -- allocation lock until commit, otherwise transaction A can reserve N,
  -- transaction B can reserve N+1 and commit first, and a reader can cross
  -- the visible boundary before A commits. Inspect the installed function
  -- definition so this remains a live catalogue assertion after restore.
  select pg_get_functiondef(to_regprocedure('public.portfolio_stamp_record()'))
    into v_stamp_definition;
  if position('pg_catalog.pg_advisory_xact_lock(741234567890123457)' in v_stamp_definition) = 0
     or position(v_nextval_marker in v_stamp_definition) = 0
     or position('pg_catalog.pg_advisory_xact_lock(741234567890123457)' in v_stamp_definition)
        > position(v_nextval_marker in v_stamp_definition) then
    raise exception 'Portfolio sequence allocation lock contract mismatch';
  end if;

  if exists (
    select 1
      from pg_proc as p
      join pg_namespace as n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname like 'portfolio\_%' escape '\'
       and not (p.oid = any(array(
         select to_regprocedure(signature)::oid
           from unnest(v_function_signatures) as signature
       )))
  ) then
    raise exception 'unexpected Portfolio-prefixed function exists';
  end if;

  if exists (
    select 1
      from pg_proc as p
      cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) as acl
     where p.oid = any(array(
       select to_regprocedure(signature)::oid
         from unnest(v_function_signatures) as signature
     ))
       and acl.privilege_type = 'EXECUTE'
       and not (
         acl.grantee = p.proowner
         or (acl.grantee = to_regrole('authenticated')::oid
           and p.oid = any(array(
             select to_regprocedure(signature)::oid
               from unnest(v_allowed_authenticated) as signature
           ))
           and not acl.is_grantable)
       )
  ) then
    raise exception 'unexpected Portfolio function execute grant exists';
  end if;

  foreach v_signature in array array['auth.uid()', 'auth.jwt()'] loop
    v_function := to_regprocedure(v_signature);
    if v_function is null then
      raise exception 'required Auth helper is missing: %', v_signature;
    end if;
    foreach v_role in array array['anon', 'authenticated', 'service_role', 'portfolio_rpc'] loop
      if has_function_privilege(v_role, v_function, 'EXECUTE') is distinct from
        (v_role = any(array['authenticated', 'portfolio_rpc'])) then
        raise exception 'Auth helper execute privilege mismatch: % for %', v_signature, v_role;
      end if;
    end loop;
    if exists (
      select 1
        from pg_proc as p
        cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) as acl
       where p.oid = v_function
         and acl.privilege_type = 'EXECUTE'
         and not (
           acl.grantee = p.proowner
           or (acl.grantee in (to_regrole('authenticated')::oid, to_regrole('portfolio_rpc')::oid)
             and not acl.is_grantable)
         )
    ) then
      raise exception 'unexpected Auth helper execute grant exists: %', v_signature;
    end if;
  end loop;

  if not exists (
       select 1 from pg_class as c
        where c.oid = to_regclass('private.portfolio_owner') and c.relkind = 'r'
     ) or not exists (
       select 1 from pg_class as c
        where c.oid = to_regclass('public.portfolio_records') and c.relkind = 'r'
     ) or not exists (
       select 1 from pg_class as c
        where c.oid = to_regclass('public.portfolio_change_seq') and c.relkind = 'S'
     ) or not exists (
       select 1
         from pg_class as c
         join pg_index as i on i.indexrelid = c.oid
        where c.oid = to_regclass('public.portfolio_records_pkey')
          and c.relkind = 'i'
          and i.indrelid = to_regclass('public.portfolio_records')
     ) or not exists (
       select 1
         from pg_class as c
         join pg_index as i on i.indexrelid = c.oid
        where c.oid = to_regclass('public.portfolio_records_sync_idx')
          and c.relkind = 'i'
          and i.indrelid = to_regclass('public.portfolio_records')
  ) then
    raise exception 'required Portfolio relation is missing';
  end if;

  -- schema.sql deliberately uses IF NOT EXISTS for data-bearing relations.
  -- Prove the complete current PostgreSQL structure here so a same-name restored object
  -- cannot bypass the current migration or the catalogue exclusions.
  if exists (
    with expected(
      schema_name, relation_name, relation_kind, access_method,
      row_security, force_row_security, replica_identity, check_count,
      has_index, has_triggers, has_toast
    ) as (
      values
        ('private', 'portfolio_owner', 'r', 'heap', false, false, 'd', 1, true, true, false),
        ('private', 'portfolio_owner_owner_id_key', 'i', 'btree', false, false, 'n', 0, false, false, false),
        ('private', 'portfolio_owner_pkey', 'i', 'btree', false, false, 'n', 0, false, false, false),
        ('public', 'portfolio_change_seq', 'S', '', false, false, 'n', 0, false, false, false),
        ('public', 'portfolio_records', 'r', 'heap', true, true, 'd', 6, true, true, true),
        ('public', 'portfolio_records_pkey', 'i', 'btree', false, false, 'n', 0, false, false, false),
        ('public', 'portfolio_records_sync_idx', 'i', 'btree', false, false, 'n', 0, false, false, false)
    )
    select 1
      from expected
      left join pg_namespace as schema on schema.nspname = expected.schema_name
      left join pg_class as relation
        on relation.relnamespace = schema.oid
       and relation.relname = expected.relation_name
      left join pg_am as access_method on access_method.oid = relation.relam
     where relation.oid is null
        or relation.relkind::text <> expected.relation_kind
        or relation.relpersistence::text <> 'p'
        or pg_get_userbyid(relation.relowner) <> current_user::text
        or coalesce(access_method.amname, '') <> expected.access_method
        or relation.reltablespace <> 0
        or relation.relrowsecurity <> expected.row_security
        or relation.relforcerowsecurity <> expected.force_row_security
        or relation.relreplident::text <> expected.replica_identity
        or relation.relchecks <> expected.check_count
        or relation.relhasindex <> expected.has_index
        or relation.relhastriggers <> expected.has_triggers
        or (relation.reltoastrelid <> 0) <> expected.has_toast
        or relation.relhasrules
        or relation.relispartition
        or not relation.relispopulated
        or relation.reloftype <> 0
        or relation.reloptions is not null
  ) then
    raise exception 'Portfolio relation structure mismatch';
  end if;

  if exists (
    select 1
      from pg_inherits as inheritance
     where inheritance.inhrelid in (
         'private.portfolio_owner'::regclass,
         'public.portfolio_records'::regclass
       )
        or inheritance.inhparent in (
         'private.portfolio_owner'::regclass,
         'public.portfolio_records'::regclass
       )
  ) then
    raise exception 'Portfolio table inheritance is unexpected';
  end if;

  if exists (
    with expected(
      schema_name, relation_name, column_number, column_name, data_type,
      not_null, default_expression, collation_kind, storage_kind
    ) as (
      values
        ('private', 'portfolio_owner', 1, 'owner_key', 'boolean', true, 'true', 'none', 'p'),
        ('private', 'portfolio_owner', 2, 'owner_id', 'uuid', true, '<NULL>', 'none', 'p'),
        ('private', 'portfolio_owner', 3, 'bound_at', 'timestamp with time zone', true, 'now()', 'none', 'p'),
        ('public', 'portfolio_records', 1, 'user_id', 'uuid', true, '<NULL>', 'none', 'p'),
        ('public', 'portfolio_records', 2, 'record_type', 'text', true, '<NULL>', 'default', 'x'),
        ('public', 'portfolio_records', 3, 'record_id', 'text', true, '<NULL>', 'default', 'x'),
        ('public', 'portfolio_records', 4, 'position', 'integer', true, '0', 'none', 'p'),
        ('public', 'portfolio_records', 5, 'payload', 'jsonb', true, $portfolio_empty_json_default$'{}'::jsonb$portfolio_empty_json_default$, 'none', 'x'),
        ('public', 'portfolio_records', 6, 'version', 'bigint', true, '1', 'none', 'p'),
        ('public', 'portfolio_records', 7, 'change_seq', 'bigint', true, '<NULL>', 'none', 'p'),
        ('public', 'portfolio_records', 8, 'created_at', 'timestamp with time zone', true, 'now()', 'none', 'p'),
        ('public', 'portfolio_records', 9, 'updated_at', 'timestamp with time zone', true, 'now()', 'none', 'p'),
        ('public', 'portfolio_records', 10, 'deleted_at', 'timestamp with time zone', false, '<NULL>', 'none', 'p')
    ), actual as (
      select schema.nspname::text,
             relation.relname::text,
             attribute.attnum::integer,
             attribute.attname::text,
             format_type(attribute.atttypid, attribute.atttypmod),
             attribute.attnotnull,
             coalesce(pg_get_expr(default_value.adbin, default_value.adrelid, false), '<NULL>'),
             case
               when attribute.attcollation = 0 then 'none'
               when attribute.attcollation = 'pg_catalog."default"'::regcollation then 'default'
               else attribute.attcollation::regcollation::text
             end,
             attribute.attstorage::text
        from pg_attribute as attribute
        join pg_class as relation on relation.oid = attribute.attrelid
        join pg_namespace as schema on schema.oid = relation.relnamespace
        left join pg_attrdef as default_value
          on default_value.adrelid = attribute.attrelid
         and default_value.adnum = attribute.attnum
       where attribute.attnum > 0
         and attribute.attrelid in (
           'private.portfolio_owner'::regclass,
           'public.portfolio_records'::regclass
         )
    )
    select 1
      from (
        (select * from expected except all select * from actual)
        union all
        (select * from actual except all select * from expected)
      ) as mismatch
  ) then
    raise exception 'Portfolio column structure mismatch';
  end if;

  if exists (
    select 1
      from pg_attribute as attribute
     where attribute.attnum > 0
       and attribute.attrelid in (
         'private.portfolio_owner'::regclass,
         'public.portfolio_records'::regclass
       )
       and (
         attribute.attisdropped
         or attribute.attidentity::text <> ''
         or attribute.attgenerated::text <> ''
         or attribute.attcompression::text <> ''
         or attribute.attstattarget is not null
         or attribute.atthasmissing
         or attribute.attmissingval is not null
         or not attribute.attislocal
         or attribute.attinhcount <> 0
         or attribute.attndims <> 0
         or attribute.attacl is not null
         or attribute.attoptions is not null
         or attribute.attfdwoptions is not null
       )
  ) then
    raise exception 'Portfolio column metadata mismatch';
  end if;

  if exists (
    with expected(schema_name, relation_name, constraint_name, constraint_type, definition) as (
      values
        ('private', 'portfolio_owner', 'portfolio_owner_owner_id_fkey', 'f', 'FOREIGN KEY (owner_id) REFERENCES auth.users(id) ON DELETE RESTRICT'),
        ('private', 'portfolio_owner', 'portfolio_owner_owner_id_key', 'u', 'UNIQUE (owner_id)'),
        ('private', 'portfolio_owner', 'portfolio_owner_pkey', 'p', 'PRIMARY KEY (owner_key)'),
        ('private', 'portfolio_owner', 'portfolio_owner_singleton_check', 'c', 'CHECK (owner_key)'),
        ('public', 'portfolio_records', 'portfolio_records_envelope_check', 'c', $portfolio_constraint$CHECK ((((record_type = ANY (ARRAY['stocks'::text, 'stockTxns'::text, 'watchlist'::text, 'crypto'::text, 'realestate'::text, 'cash'::text, 'cashTxns'::text, 'cpfHistory'::text, 'income'::text, 'expenses'::text, 'snapshots'::text, 'trash'::text, 'insurance'::text, 'insuranceRiders'::text])) AND (payload ? 'id'::text) AND (jsonb_typeof((payload -> 'id'::text)) = 'string'::text) AND ((payload ->> 'id'::text) = record_id)) OR ((record_type = ANY (ARRAY['cpfBalances'::text, 'categories'::text, 'settings'::text, '_meta'::text, '_syncMeta'::text])) AND (record_id = 'singleton'::text) AND ("position" = 0))))$portfolio_constraint$),
        ('public', 'portfolio_records', 'portfolio_records_payload_object_check', 'c', $portfolio_constraint$CHECK ((jsonb_typeof(payload) = 'object'::text))$portfolio_constraint$),
        ('public', 'portfolio_records', 'portfolio_records_pkey', 'p', 'PRIMARY KEY (user_id, record_type, record_id)'),
        ('public', 'portfolio_records', 'portfolio_records_position_check', 'c', 'CHECK (("position" >= 0))'),
        ('public', 'portfolio_records', 'portfolio_records_record_id_check', 'c', $portfolio_constraint$CHECK ((record_id ~ '^[A-Za-z0-9_-]{1,64}$'::text))$portfolio_constraint$),
        ('public', 'portfolio_records', 'portfolio_records_record_type_check', 'c', $portfolio_constraint$CHECK ((record_type = ANY (ARRAY['stocks'::text, 'stockTxns'::text, 'watchlist'::text, 'crypto'::text, 'realestate'::text, 'cash'::text, 'cashTxns'::text, 'cpfHistory'::text, 'income'::text, 'expenses'::text, 'snapshots'::text, 'trash'::text, 'insurance'::text, 'insuranceRiders'::text, 'cpfBalances'::text, 'categories'::text, 'settings'::text, '_meta'::text, '_syncMeta'::text])))$portfolio_constraint$),
        ('public', 'portfolio_records', 'portfolio_records_user_id_fkey', 'f', 'FOREIGN KEY (user_id) REFERENCES private.portfolio_owner(owner_id) ON DELETE RESTRICT'),
        ('public', 'portfolio_records', 'portfolio_records_version_check', 'c', 'CHECK ((version >= 1))')
    ), actual as (
      select schema.nspname::text,
             relation.relname::text,
             constraint_row.conname::text,
             constraint_row.contype::text,
             pg_get_constraintdef(constraint_row.oid, false)
        from pg_constraint as constraint_row
        join pg_class as relation on relation.oid = constraint_row.conrelid
       join pg_namespace as schema on schema.oid = relation.relnamespace
       where constraint_row.conrelid in (
         'private.portfolio_owner'::regclass,
         'public.portfolio_records'::regclass
       )
         and constraint_row.contype in ('c', 'f', 'p', 'u')
    )
    select 1
      from (
        (select * from expected except all select * from actual)
        union all
        (select * from actual except all select * from expected)
      ) as mismatch
  ) then
    raise exception 'Portfolio constraint structure mismatch';
  end if;

  if exists (
    select 1
      from pg_constraint as constraint_row
     where constraint_row.conrelid in (
         'private.portfolio_owner'::regclass,
         'public.portfolio_records'::regclass
       )
       and constraint_row.contype in ('c', 'f', 'p', 'u')
       and (
         not constraint_row.convalidated
         or constraint_row.condeferrable
         or constraint_row.condeferred
         or not constraint_row.conislocal
         or constraint_row.coninhcount <> 0
         or constraint_row.conparentid <> 0
         or constraint_row.connoinherit is distinct from (constraint_row.contype <> 'c')
       )
  ) then
    raise exception 'Portfolio constraint metadata mismatch';
  end if;

  if not exists (
    select 1 from pg_constraint
     where conrelid = 'private.portfolio_owner'::regclass
       and conname = 'portfolio_owner_pkey'
       and conindid = 'private.portfolio_owner_pkey'::regclass
  ) or not exists (
    select 1 from pg_constraint
     where conrelid = 'private.portfolio_owner'::regclass
       and conname = 'portfolio_owner_owner_id_key'
       and conindid = 'private.portfolio_owner_owner_id_key'::regclass
  ) or not exists (
    select 1 from pg_constraint
     where conrelid = 'private.portfolio_owner'::regclass
       and conname = 'portfolio_owner_owner_id_fkey'
       and conindid = 'auth.users_pkey'::regclass
  ) or not exists (
    select 1 from pg_constraint
     where conrelid = 'public.portfolio_records'::regclass
       and conname = 'portfolio_records_pkey'
       and conindid = 'public.portfolio_records_pkey'::regclass
  ) or not exists (
    select 1 from pg_constraint
     where conrelid = 'public.portfolio_records'::regclass
       and conname = 'portfolio_records_user_id_fkey'
       and conindid = 'private.portfolio_owner_owner_id_key'::regclass
  ) then
    raise exception 'Portfolio constraint index binding mismatch';
  end if;

  if exists (
    with expected(
      schema_name, index_name, table_schema, table_name,
      is_unique, is_primary, column_count, key_count, column_keys, definition
    ) as (
      values
        ('private', 'portfolio_owner_owner_id_key', 'private', 'portfolio_owner', true, false, 1, 1, '2', 'CREATE UNIQUE INDEX portfolio_owner_owner_id_key ON private.portfolio_owner USING btree (owner_id)'),
        ('private', 'portfolio_owner_pkey', 'private', 'portfolio_owner', true, true, 1, 1, '1', 'CREATE UNIQUE INDEX portfolio_owner_pkey ON private.portfolio_owner USING btree (owner_key)'),
        ('public', 'portfolio_records_pkey', 'public', 'portfolio_records', true, true, 3, 3, '1 2 3', 'CREATE UNIQUE INDEX portfolio_records_pkey ON public.portfolio_records USING btree (user_id, record_type, record_id)'),
        ('public', 'portfolio_records_sync_idx', 'public', 'portfolio_records', false, false, 4, 4, '1 7 2 3', 'CREATE INDEX portfolio_records_sync_idx ON public.portfolio_records USING btree (user_id, change_seq, record_type, record_id)')
    ), actual as (
      select index_schema.nspname::text,
             index_relation.relname::text,
             table_schema.nspname::text,
             table_relation.relname::text,
             index_row.indisunique,
             index_row.indisprimary,
             index_row.indnatts::integer,
             index_row.indnkeyatts::integer,
             index_row.indkey::text,
             pg_get_indexdef(index_row.indexrelid, 0, false)
        from pg_index as index_row
        join pg_class as index_relation on index_relation.oid = index_row.indexrelid
        join pg_namespace as index_schema on index_schema.oid = index_relation.relnamespace
        join pg_class as table_relation on table_relation.oid = index_row.indrelid
        join pg_namespace as table_schema on table_schema.oid = table_relation.relnamespace
       where index_row.indexrelid in (
         'private.portfolio_owner_owner_id_key'::regclass,
         'private.portfolio_owner_pkey'::regclass,
         'public.portfolio_records_pkey'::regclass,
         'public.portfolio_records_sync_idx'::regclass
       )
    )
    select 1
      from (
        (select * from expected except all select * from actual)
        union all
        (select * from actual except all select * from expected)
      ) as mismatch
  ) then
    raise exception 'Portfolio index structure mismatch';
  end if;

  if exists (
    select 1
      from pg_index as index_row
     where index_row.indexrelid in (
         'private.portfolio_owner_owner_id_key'::regclass,
         'private.portfolio_owner_pkey'::regclass,
         'public.portfolio_records_pkey'::regclass,
         'public.portfolio_records_sync_idx'::regclass
       )
       and (
         index_row.indisexclusion
         or not index_row.indimmediate
         or index_row.indisclustered
         or not index_row.indisvalid
         or index_row.indcheckxmin
         or not index_row.indisready
         or not index_row.indislive
         or index_row.indisreplident
         or index_row.indnullsnotdistinct
         or index_row.indexprs is not null
         or index_row.indpred is not null
       )
  ) then
    raise exception 'Portfolio index metadata mismatch';
  end if;

  if not exists (
    select 1
      from pg_sequence as sequence_row
     where sequence_row.seqrelid = 'public.portfolio_change_seq'::regclass
       and format_type(sequence_row.seqtypid, -1) = 'bigint'
       and sequence_row.seqstart = 1
       and sequence_row.seqincrement = 1
       and sequence_row.seqmax = 9223372036854775807
       and sequence_row.seqmin = 1
       and sequence_row.seqcache = 1
       and not sequence_row.seqcycle
  ) or (
    select count(*)
      from pg_depend as dependency
     where dependency.classid = 'pg_class'::regclass
       and dependency.objid = 'public.portfolio_change_seq'::regclass
       and dependency.objsubid = 0
       and dependency.refclassid = 'pg_class'::regclass
       and dependency.refobjid = 'public.portfolio_records'::regclass
       and dependency.refobjsubid = 7
       and dependency.deptype = 'a'
  ) <> 1 then
    raise exception 'Portfolio sequence structure mismatch';
  end if;

  if exists (
    select 1
      from pg_depend as dependency
     where dependency.classid = 'pg_class'::regclass
       and dependency.objid = 'public.portfolio_change_seq'::regclass
       and dependency.objsubid = 0
       and dependency.refclassid = 'pg_class'::regclass
       and dependency.deptype in ('a', 'i')
       and not (
         dependency.refobjid = 'public.portfolio_records'::regclass
         and dependency.refobjsubid = 7
         and dependency.deptype = 'a'
       )
  ) then
    raise exception 'unexpected Portfolio sequence ownership exists';
  end if;

  -- Read sequence state without calling nextval or setval. The table lock keeps
  -- its maximum stable until this transaction commits. Numeric arithmetic
  -- detects an exhausted BIGINT sequence without overflowing the audit itself.
  lock table public.portfolio_records in share mode;
  select
    sequence_state.last_value::numeric,
    sequence_state.is_called,
    sequence_row.seqincrement::numeric,
    coalesce(record_state.max_change_seq, 0::numeric)
    into v_sequence_last_value,
         v_sequence_is_called,
         v_sequence_increment,
         v_sequence_max_record
    from public.portfolio_change_seq as sequence_state
    join pg_sequence as sequence_row
      on sequence_row.seqrelid = 'public.portfolio_change_seq'::regclass
    cross join (
      select max(records.change_seq)::numeric as max_change_seq
        from public.portfolio_records as records
    ) as record_state;

  v_sequence_next_value := v_sequence_last_value
    + case when v_sequence_is_called then v_sequence_increment else 0::numeric end;
  if v_sequence_next_value > 9223372036854775807::numeric
     or v_sequence_next_value <= v_sequence_max_record then
    raise exception 'Portfolio sequence next value is not safely ahead of records';
  end if;

  if exists (
    select 1
      from pg_constraint as foreign_key
     where foreign_key.oid in (
         (select oid from pg_constraint where conrelid = 'private.portfolio_owner'::regclass and conname = 'portfolio_owner_owner_id_fkey'),
         (select oid from pg_constraint where conrelid = 'public.portfolio_records'::regclass and conname = 'portfolio_records_user_id_fkey')
       )
       and (
         select count(*) <> 4 or bool_or(trigger.tgenabled <> 'O')
           from pg_trigger as trigger
          where trigger.tgconstraint = foreign_key.oid
            and trigger.tgisinternal
       )
  ) then
    raise exception 'Portfolio foreign key trigger structure mismatch';
  end if;

  if exists (
    select 1
      from pg_class as c
      join pg_namespace as n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relname like 'portfolio\_%' escape '\'
       and (c.relname, c.relkind) not in (
         ('portfolio_records', 'r'),
         ('portfolio_change_seq', 'S'),
         ('portfolio_records_pkey', 'i'),
         ('portfolio_records_sync_idx', 'i')
       )
  ) then
    raise exception 'unexpected Portfolio-prefixed relation exists';
  end if;

  if exists (
    select 1
      from pg_type as t
      join pg_namespace as n on n.oid = t.typnamespace
     where n.nspname = 'public'
       and t.typname like 'portfolio\_%' escape '\'
       and not (
         t.typname = 'portfolio_records'
         and t.typtype = 'c'
         and t.typrelid = to_regclass('public.portfolio_records')
       )
  ) then
    raise exception 'unexpected Portfolio-prefixed type exists';
  end if;

  foreach v_role in array array['anon', 'authenticated', 'service_role', 'portfolio_rpc'] loop
    foreach v_signature in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] loop
      if has_table_privilege(v_role, 'private.portfolio_owner', v_signature) is distinct from
        (v_role = 'portfolio_rpc' and v_signature = any(array['SELECT', 'INSERT', 'UPDATE'])) then
        raise exception 'private owner privilege mismatch: % for %', v_signature, v_role;
      end if;
      if has_table_privilege(v_role, 'public.portfolio_records', v_signature) is distinct from
        ((v_role = 'portfolio_rpc' and v_signature = any(array['SELECT', 'INSERT', 'UPDATE']))
          or (v_role = 'authenticated' and v_signature = 'SELECT')) then
        raise exception 'records privilege mismatch: % for %', v_signature, v_role;
      end if;
    end loop;
  end loop;

  if exists (
    select 1
      from pg_class as relation
      cross join lateral aclexplode(coalesce(relation.relacl, acldefault('r', relation.relowner))) as acl
     where relation.oid in ('private.portfolio_owner'::regclass, 'public.portfolio_records'::regclass)
       and not (
         acl.grantee = relation.relowner
         or (relation.oid = 'private.portfolio_owner'::regclass
           and acl.grantee = to_regrole('portfolio_rpc')::oid
           and acl.privilege_type = any(array['SELECT', 'INSERT', 'UPDATE'])
           and not acl.is_grantable)
         or (relation.oid = 'public.portfolio_records'::regclass
           and acl.grantee = to_regrole('portfolio_rpc')::oid
           and acl.privilege_type = any(array['SELECT', 'INSERT', 'UPDATE'])
           and not acl.is_grantable)
         or (relation.oid = 'public.portfolio_records'::regclass
           and acl.grantee = to_regrole('authenticated')::oid
           and acl.privilege_type = 'SELECT'
           and not acl.is_grantable)
       )
  ) then
    raise exception 'unexpected Portfolio table grant exists';
  end if;

  if exists (
    select 1
      from pg_attribute as attribute
     where attribute.attrelid = 'public.portfolio_records'::regclass
       and attribute.attnum > 0
       and not attribute.attisdropped
       and attribute.attacl is not null
  ) then
    raise exception 'unexpected Portfolio column grant exists';
  end if;

  foreach v_role in array array['anon', 'authenticated', 'service_role', 'portfolio_rpc'] loop
    foreach v_signature in array array['SELECT', 'UPDATE', 'USAGE'] loop
      if has_sequence_privilege(v_role, 'public.portfolio_change_seq', v_signature) is distinct from
        (v_role = 'portfolio_rpc' and v_signature = 'USAGE') then
        raise exception 'sequence privilege mismatch: % for %', v_signature, v_role;
      end if;
    end loop;
  end loop;

  if exists (
    select 1
      from pg_class as c
      cross join lateral aclexplode(coalesce(c.relacl, acldefault('s', c.relowner))) as acl
     where c.oid = 'public.portfolio_change_seq'::regclass
       and not (
         acl.grantee = c.relowner
         or (acl.grantee = to_regrole('portfolio_rpc')::oid
           and acl.privilege_type = 'USAGE'
           and not acl.is_grantable)
       )
  ) then
    raise exception 'unexpected Portfolio sequence grant exists';
  end if;

  foreach v_role in array array['anon', 'authenticated', 'service_role', 'portfolio_rpc'] loop
    if has_schema_privilege(v_role, 'private', 'CREATE')
       or has_schema_privilege(v_role, 'public', 'CREATE') then
      raise exception 'schema create privilege mismatch for %', v_role;
    end if;
    if has_schema_privilege(v_role, 'private', 'USAGE') is distinct from (v_role = 'portfolio_rpc') then
      raise exception 'private schema usage mismatch for %', v_role;
    end if;
    if not has_schema_privilege(v_role, 'public', 'USAGE') then
      raise exception 'public schema usage missing for %', v_role;
    end if;
  end loop;
  if not has_schema_privilege('portfolio_rpc', 'auth', 'USAGE')
     or has_schema_privilege('portfolio_rpc', 'auth', 'CREATE') then
    raise exception 'auth schema privilege mismatch for portfolio_rpc';
  end if;

  if exists (
    select 1
      from pg_namespace as n
      cross join lateral aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) as acl
     where n.nspname in ('public', 'private')
       and not (
         acl.grantee = n.nspowner
         or (n.nspname = 'public' and acl.grantee = 0
           and acl.privilege_type = 'USAGE' and not acl.is_grantable)
         or (acl.grantee = to_regrole('portfolio_rpc')::oid
           and acl.privilege_type = 'USAGE' and not acl.is_grantable)
       )
  ) then
    raise exception 'unexpected Portfolio schema grant exists';
  end if;

  if not exists (
    select 1
      from pg_class
     where oid = 'public.portfolio_records'::regclass
       and relrowsecurity
       and relforcerowsecurity
  ) then
    raise exception 'Portfolio records RLS is not forced';
  end if;

  if exists (
    select 1
      from pg_policy as policy
      join pg_class as relation on relation.oid = policy.polrelid
      join pg_namespace as schema on schema.oid = relation.relnamespace
     where schema.nspname = 'public'
       and policy.polname like 'portfolio\_%' escape '\'
       and not (
         relation.oid = 'public.portfolio_records'::regclass
         and policy.polname in (
           'portfolio_records_owner_select',
           'portfolio_records_rpc_insert',
           'portfolio_records_rpc_update'
         )
       )
  ) then
    raise exception 'unexpected Portfolio-prefixed policy exists';
  end if;

  if (select count(*) from pg_policy where polrelid = 'public.portfolio_records'::regclass) <> 3 then
    raise exception 'Portfolio records policy count mismatch';
  end if;
  select array[to_regrole('authenticated')::oid, to_regrole('portfolio_rpc')::oid]
    into v_policy_roles;
  if not exists (
    select 1 from pg_policy
     where polrelid = 'public.portfolio_records'::regclass
       and polname = 'portfolio_records_owner_select'
       and polcmd = 'r' and polpermissive
       and polroles @> v_policy_roles and polroles <@ v_policy_roles
       and pg_get_expr(polqual, polrelid, false) = v_owner_predicate
       and polwithcheck is null
  ) or not exists (
    select 1 from pg_policy
     where polrelid = 'public.portfolio_records'::regclass
       and polname = 'portfolio_records_rpc_insert'
       and polcmd = 'a' and polpermissive
       and polroles = array[to_regrole('portfolio_rpc')::oid]
       and polqual is null
       and pg_get_expr(polwithcheck, polrelid, false) = v_owner_predicate
  ) or not exists (
    select 1 from pg_policy
     where polrelid = 'public.portfolio_records'::regclass
       and polname = 'portfolio_records_rpc_update'
       and polcmd = 'w' and polpermissive
       and polroles = array[to_regrole('portfolio_rpc')::oid]
       and pg_get_expr(polqual, polrelid, false) = v_owner_predicate
       and pg_get_expr(polwithcheck, polrelid, false) = v_owner_predicate
  ) then
    raise exception 'Portfolio records policy contract mismatch';
  end if;

  if not exists (
    select 1
      from pg_trigger as trigger
     where not trigger.tgisinternal
       and trigger.tgrelid = 'public.portfolio_records'::regclass
       and trigger.tgname = 'portfolio_stamp_record'
       and trigger.tgfoid = to_regprocedure('public.portfolio_stamp_record()')
       and trigger.tgenabled = 'O'
       and trigger.tgtype = 23
       and trigger.tgconstraint = 0
       and not trigger.tgdeferrable
       and not trigger.tginitdeferred
       and trigger.tgnargs = 0
       and trigger.tgargs = '\x'::bytea
       and trigger.tgattr::text = ''
       and trigger.tgqual is null
       and trigger.tgoldtable is null
       and trigger.tgnewtable is null
       and pg_get_triggerdef(trigger.oid, false) = 'CREATE TRIGGER portfolio_stamp_record BEFORE INSERT OR UPDATE ON public.portfolio_records FOR EACH ROW EXECUTE FUNCTION public.portfolio_stamp_record()'
  ) or not exists (
    select 1
      from pg_trigger as trigger
     where not trigger.tgisinternal
       and trigger.tgrelid = 'auth.users'::regclass
       and trigger.tgname = 'portfolio_bind_auth_user_after_insert'
       and trigger.tgfoid = to_regprocedure('public.portfolio_bind_auth_user()')
       and trigger.tgenabled = 'O'
       and trigger.tgtype = 5
       and trigger.tgconstraint = 0
       and not trigger.tgdeferrable
       and not trigger.tginitdeferred
       and trigger.tgnargs = 0
       and trigger.tgargs = '\x'::bytea
       and trigger.tgattr::text = ''
       and trigger.tgqual is null
       and trigger.tgoldtable is null
       and trigger.tgnewtable is null
       and pg_get_triggerdef(trigger.oid, false) = 'CREATE TRIGGER portfolio_bind_auth_user_after_insert AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.portfolio_bind_auth_user()'
  ) then
    raise exception 'required Portfolio trigger contract mismatch';
  end if;

  if exists (
    select 1
      from pg_trigger as trigger
     where not trigger.tgisinternal
       and (
         trigger.tgrelid = 'public.portfolio_records'::regclass
         or trigger.tgname like 'portfolio\_%' escape '\'
         or trigger.tgfoid = any(array(
           select to_regprocedure(signature)::oid
             from unnest(v_function_signatures) as signature
         ))
       )
       and not (
         (trigger.tgrelid = 'public.portfolio_records'::regclass
           and trigger.tgname = 'portfolio_stamp_record'
           and trigger.tgfoid = to_regprocedure('public.portfolio_stamp_record()'))
         or (trigger.tgrelid = 'auth.users'::regclass
           and trigger.tgname = 'portfolio_bind_auth_user_after_insert'
           and trigger.tgfoid = to_regprocedure('public.portfolio_bind_auth_user()'))
       )
  ) then
    raise exception 'unexpected Portfolio trigger exists';
  end if;

  if exists (
    select 1
      from pg_rewrite as rewrite
      join pg_class as relation on relation.oid = rewrite.ev_class
      join pg_namespace as schema on schema.oid = relation.relnamespace
     where schema.nspname = 'public'
       and (
         relation.oid = 'public.portfolio_records'::regclass
         or rewrite.rulename like 'portfolio\_%' escape '\'
       )
  ) then
    raise exception 'unexpected Portfolio rewrite rule exists';
  end if;

  if exists (
    select 1
      from pg_publication as publication
      left join pg_publication_rel as publication_relation
        on publication_relation.prpubid = publication.oid
     where publication.puballtables
        or publication_relation.prrelid = 'public.portfolio_records'::regclass
  ) then
    raise exception 'Portfolio records are unexpectedly published';
  end if;

  if exists (
    select 1
      from pg_default_acl as default_acl
      cross join lateral aclexplode(default_acl.defaclacl) as acl
     where default_acl.defaclrole = to_regrole('portfolio_rpc')::oid
        or acl.grantee = to_regrole('portfolio_rpc')::oid
  ) then
    raise exception 'unexpected Portfolio default privilege exists';
  end if;
end;
$portfolio_restore_security$;

select 'portfolio_restore_security_ok';
commit;
