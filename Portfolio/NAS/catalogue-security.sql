\set ON_ERROR_STOP on

begin transaction read only;
set local search_path = pg_catalog;

-- Canonical, secret-free ownership and privilege contract for the complete
-- database. Portfolio-owned objects and grants changed by schema.sql are
-- audited independently by restore-security.sql after the current migration.
with contract(entry) as (
  select jsonb_build_array('contract', 'portfolio_catalogue_security_v1')::text

  union all
  select jsonb_build_array(
    'auth_required',
    (select rolcanlogin and not rolsuper from pg_roles where rolname = 'supabase_auth_admin'),
    has_database_privilege('supabase_auth_admin', current_database(), 'CONNECT'),
    has_schema_privilege('supabase_auth_admin', 'auth', 'USAGE'),
    has_schema_privilege('supabase_auth_admin', 'auth', 'CREATE'),
    has_table_privilege('supabase_auth_admin', 'auth.users', 'SELECT'),
    has_table_privilege('supabase_auth_admin', 'auth.users', 'INSERT'),
    has_table_privilege('supabase_auth_admin', 'auth.users', 'UPDATE'),
    has_table_privilege('supabase_auth_admin', 'auth.users', 'DELETE'),
    has_table_privilege('supabase_auth_admin', 'auth.users', 'TRUNCATE'),
    has_table_privilege('supabase_auth_admin', 'auth.users', 'REFERENCES'),
    has_table_privilege('supabase_auth_admin', 'auth.users', 'TRIGGER')
  )::text

  union all
  select jsonb_build_array(
    'auth_owners',
    pg_get_userbyid((select nspowner from pg_namespace where nspname = 'auth')),
    (select pg_get_userbyid(relowner) from pg_class where oid = 'auth.users'::regclass)
  )::text

  union all
  select jsonb_build_array(
    'role', role.rolname, role.rolsuper, role.rolinherit, role.rolcreaterole,
    role.rolcreatedb, role.rolcanlogin, role.rolreplication,
    role.rolbypassrls, role.rolconnlimit,
    coalesce(extract(epoch from role.rolvaliduntil)::text, '')
  )::text
    from pg_roles as role
   where role.rolname !~ '^pg_'
     and role.rolname <> 'portfolio_rpc'

  union all
  select jsonb_build_array(
    'membership', granted.rolname, member.rolname, membership.admin_option,
    pg_get_userbyid(membership.grantor)
  )::text
    from pg_auth_members as membership
    join pg_roles as granted on granted.oid = membership.roleid
    join pg_roles as member on member.oid = membership.member
   where granted.rolname <> 'portfolio_rpc'
     and member.rolname <> 'portfolio_rpc'

  union all
  select jsonb_build_array(
    'schema', schema.nspname, pg_get_userbyid(schema.nspowner)
  )::text
    from pg_namespace as schema
   where schema.nspname <> 'information_schema'
     and schema.nspname !~ '^pg_'
     and schema.nspname <> 'private'

  union all
  select jsonb_build_array(
    'schema_acl', schema.nspname,
    case when acl.grantee = 0 then 'PUBLIC' else pg_get_userbyid(acl.grantee) end,
    pg_get_userbyid(acl.grantor), acl.privilege_type, acl.is_grantable
  )::text
    from pg_namespace as schema
    cross join lateral aclexplode(coalesce(schema.nspacl, acldefault('n', schema.nspowner))) as acl
   where schema.nspname <> 'information_schema'
     and schema.nspname !~ '^pg_'
     and schema.nspname not in ('private', 'public')
     and not (schema.nspname = 'auth' and acl.grantee = to_regrole('portfolio_rpc')::oid)

  union all
  select jsonb_build_array(
    'relation', schema.nspname, relation.relname, relation.relkind,
    pg_get_userbyid(relation.relowner), relation.relpersistence,
    relation.relrowsecurity, relation.relforcerowsecurity,
    relation.relreplident
  )::text
    from pg_class as relation
    join pg_namespace as schema on schema.oid = relation.relnamespace
   where schema.nspname <> 'information_schema'
     and schema.nspname !~ '^pg_'
     and schema.nspname <> 'private'
     and not (
       schema.nspname = 'public'
       and (relation.relname, relation.relkind) in (
         ('portfolio_records', 'r'),
         ('portfolio_change_seq', 'S'),
         ('portfolio_records_pkey', 'i'),
         ('portfolio_records_sync_idx', 'i')
       )
     )

  union all
  select jsonb_build_array(
    'relation_acl', schema.nspname, relation.relname,
    case when acl.grantee = 0 then 'PUBLIC' else pg_get_userbyid(acl.grantee) end,
    pg_get_userbyid(acl.grantor), acl.privilege_type, acl.is_grantable
  )::text
    from pg_class as relation
    join pg_namespace as schema on schema.oid = relation.relnamespace
    cross join lateral aclexplode(coalesce(
      relation.relacl,
      acldefault(case when relation.relkind = 'S' then 's'::"char" else 'r'::"char" end, relation.relowner)
    )) as acl
   where relation.relkind in ('r', 'p', 'v', 'm', 'f', 'S')
     and schema.nspname <> 'information_schema'
     and schema.nspname !~ '^pg_'
     and schema.nspname <> 'private'
     and not (
       schema.nspname = 'public'
       and (relation.relname, relation.relkind) in (
         ('portfolio_records', 'r'),
         ('portfolio_change_seq', 'S')
       )
     )

  union all
  select jsonb_build_array(
    'column_acl', schema.nspname, relation.relname, attribute.attname,
    case when acl.grantee = 0 then 'PUBLIC' else pg_get_userbyid(acl.grantee) end,
    pg_get_userbyid(acl.grantor), acl.privilege_type, acl.is_grantable
  )::text
    from pg_attribute as attribute
    join pg_class as relation on relation.oid = attribute.attrelid
    join pg_namespace as schema on schema.oid = relation.relnamespace
    cross join lateral aclexplode(attribute.attacl) as acl
   where attribute.attnum > 0
     and not attribute.attisdropped
     and schema.nspname <> 'information_schema'
     and schema.nspname !~ '^pg_'
     and schema.nspname <> 'private'
     and not (
       schema.nspname = 'public'
       and relation.relname = 'portfolio_records'
       and relation.relkind = 'r'
     )

  union all
  select jsonb_build_array(
    'function', schema.nspname, function.proname,
    pg_get_function_identity_arguments(function.oid),
    pg_get_userbyid(function.proowner), function.prokind,
    function.prosecdef, function.proleakproof, function.proisstrict,
    function.provolatile, function.proparallel,
    array(select setting from unnest(coalesce(function.proconfig, array[]::text[])) as setting order by setting)
  )::text
    from pg_proc as function
    join pg_namespace as schema on schema.oid = function.pronamespace
   where schema.nspname <> 'information_schema'
     and schema.nspname !~ '^pg_'
     and schema.nspname <> 'private'
     and not (
       schema.nspname = 'public'
       and function.oid = any(array[
         to_regprocedure('public.portfolio_stamp_record()')::oid,
         to_regprocedure('public.portfolio_bind_auth_user()')::oid,
         to_regprocedure('public.portfolio_upsert_record(text,text,jsonb,integer,bigint)')::oid,
         to_regprocedure('public.portfolio_delete_record(text,text,bigint)')::oid,
         to_regprocedure('public.portfolio_restore_record(text,text,jsonb,integer,bigint)')::oid,
         to_regprocedure('public.portfolio_restore_record(text,text,bigint)')::oid,
         to_regprocedure('public.portfolio_get_records_page(bigint,bigint,integer)')::oid,
         to_regprocedure('public.portfolio_sync_page(bigint,integer)')::oid,
         to_regprocedure('public.portfolio_sync_boundary()')::oid
       ])
     )

  union all
  select jsonb_build_array(
    'function_acl', schema.nspname, function.proname,
    pg_get_function_identity_arguments(function.oid),
    case when acl.grantee = 0 then 'PUBLIC' else pg_get_userbyid(acl.grantee) end,
    pg_get_userbyid(acl.grantor), acl.privilege_type, acl.is_grantable
  )::text
    from pg_proc as function
    join pg_namespace as schema on schema.oid = function.pronamespace
    cross join lateral aclexplode(coalesce(function.proacl, acldefault('f', function.proowner))) as acl
   where schema.nspname <> 'information_schema'
     and schema.nspname !~ '^pg_'
     and schema.nspname <> 'private'
     and not (
       schema.nspname = 'public'
       and function.oid = any(array[
         to_regprocedure('public.portfolio_stamp_record()')::oid,
         to_regprocedure('public.portfolio_bind_auth_user()')::oid,
         to_regprocedure('public.portfolio_upsert_record(text,text,jsonb,integer,bigint)')::oid,
         to_regprocedure('public.portfolio_delete_record(text,text,bigint)')::oid,
         to_regprocedure('public.portfolio_restore_record(text,text,jsonb,integer,bigint)')::oid,
         to_regprocedure('public.portfolio_restore_record(text,text,bigint)')::oid,
         to_regprocedure('public.portfolio_get_records_page(bigint,bigint,integer)')::oid,
         to_regprocedure('public.portfolio_sync_page(bigint,integer)')::oid,
         to_regprocedure('public.portfolio_sync_boundary()')::oid
       ])
     )
     and not (
       schema.nspname = 'auth'
       and function.proname in ('uid', 'jwt')
       and pg_get_function_identity_arguments(function.oid) = ''
     )

  union all
  select jsonb_build_array(
    'type', schema.nspname, type.typname, type.typtype,
    pg_get_userbyid(type.typowner)
  )::text
    from pg_type as type
    join pg_namespace as schema on schema.oid = type.typnamespace
   where schema.nspname <> 'information_schema'
     and schema.nspname !~ '^pg_'
     and schema.nspname <> 'private'

  union all
  select jsonb_build_array(
    'type_acl', schema.nspname, type.typname,
    case when acl.grantee = 0 then 'PUBLIC' else pg_get_userbyid(acl.grantee) end,
    pg_get_userbyid(acl.grantor), acl.privilege_type, acl.is_grantable
  )::text
    from pg_type as type
    join pg_namespace as schema on schema.oid = type.typnamespace
    cross join lateral aclexplode(coalesce(type.typacl, acldefault('T', type.typowner))) as acl
   where schema.nspname <> 'information_schema'
     and schema.nspname !~ '^pg_'
     and schema.nspname <> 'private'

  union all
  select jsonb_build_array(
    'policy', schema.nspname, relation.relname, policy.polname,
    policy.polcmd, policy.polpermissive,
    array(
      select case when role_oid = 0 then 'PUBLIC' else pg_get_userbyid(role_oid) end
        from unnest(policy.polroles) as role_oid
       order by 1
    ),
    coalesce(pg_get_expr(policy.polqual, policy.polrelid), ''),
    coalesce(pg_get_expr(policy.polwithcheck, policy.polrelid), '')
  )::text
    from pg_policy as policy
    join pg_class as relation on relation.oid = policy.polrelid
    join pg_namespace as schema on schema.oid = relation.relnamespace
   where schema.nspname <> 'information_schema'
     and schema.nspname !~ '^pg_'
     and schema.nspname <> 'private'
     and not (
       schema.nspname = 'public'
       and relation.relname = 'portfolio_records'
       and policy.polname in (
         'portfolio_records_owner_select',
         'portfolio_records_rpc_insert',
         'portfolio_records_rpc_update'
       )
     )

  union all
  select jsonb_build_array(
    'trigger', schema.nspname, relation.relname, trigger.tgname,
    trigger.tgenabled, pg_get_triggerdef(trigger.oid, true)
  )::text
    from pg_trigger as trigger
    join pg_class as relation on relation.oid = trigger.tgrelid
    join pg_namespace as schema on schema.oid = relation.relnamespace
   where not trigger.tgisinternal
     and schema.nspname <> 'information_schema'
     and schema.nspname !~ '^pg_'
     and schema.nspname <> 'private'
     and not (
       (schema.nspname = 'public' and relation.relname = 'portfolio_records'
         and trigger.tgname = 'portfolio_stamp_record')
       or (schema.nspname = 'auth' and relation.relname = 'users'
         and trigger.tgname = 'portfolio_bind_auth_user_after_insert')
     )

  union all
  select jsonb_build_array(
    'default_acl', pg_get_userbyid(default_acl.defaclrole),
    coalesce(schema.nspname, ''), default_acl.defaclobjtype,
    case when acl.grantee = 0 then 'PUBLIC' else pg_get_userbyid(acl.grantee) end,
    pg_get_userbyid(acl.grantor), acl.privilege_type, acl.is_grantable
  )::text
    from pg_default_acl as default_acl
    left join pg_namespace as schema on schema.oid = default_acl.defaclnamespace
    cross join lateral aclexplode(default_acl.defaclacl) as acl
   where pg_get_userbyid(default_acl.defaclrole) <> 'portfolio_rpc'
     and (schema.nspname is null or schema.nspname <> 'private')
     and acl.grantee <> to_regrole('portfolio_rpc')::oid

  union all
  select jsonb_build_array(
    'extension', extension.extname, extension.extversion,
    pg_get_userbyid(extension.extowner), schema.nspname,
    extension.extrelocatable
  )::text
    from pg_extension as extension
    join pg_namespace as schema on schema.oid = extension.extnamespace

  union all
  select jsonb_build_array(
    'event_trigger', event_trigger.evtname, event_trigger.evtevent,
    event_trigger.evtenabled, pg_get_userbyid(function.proowner),
    schema.nspname, function.proname,
    pg_get_function_identity_arguments(function.oid)
  )::text
    from pg_event_trigger as event_trigger
    join pg_proc as function on function.oid = event_trigger.evtfoid
    join pg_namespace as schema on schema.oid = function.pronamespace

  union all
  select jsonb_build_array(
    'publication', publication.pubname, pg_get_userbyid(publication.pubowner),
    publication.puballtables, publication.pubinsert, publication.pubupdate,
    publication.pubdelete, publication.pubtruncate
  )::text
    from pg_publication as publication

  union all
  select jsonb_build_array(
    'publication_relation', publication.pubname, schema.nspname, relation.relname
  )::text
    from pg_publication_rel as publication_relation
    join pg_publication as publication on publication.oid = publication_relation.prpubid
    join pg_class as relation on relation.oid = publication_relation.prrelid
    join pg_namespace as schema on schema.oid = relation.relnamespace

  union all
  select jsonb_build_array(
    'large_object', large_object.oid, pg_get_userbyid(large_object.lomowner)
  )::text
    from pg_largeobject_metadata as large_object

  union all
  select jsonb_build_array(
    'large_object_acl', large_object.oid,
    case when acl.grantee = 0 then 'PUBLIC' else pg_get_userbyid(acl.grantee) end,
    pg_get_userbyid(acl.grantor), acl.privilege_type, acl.is_grantable
  )::text
    from pg_largeobject_metadata as large_object
    cross join lateral aclexplode(coalesce(large_object.lomacl, acldefault('L', large_object.lomowner))) as acl
)
select entry
  from contract
 order by entry collate "C";

commit;
