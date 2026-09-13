const assert = require('assert');
const fs = require('fs');
const path = require('path');

const schemaPath = path.join(__dirname, '..', 'Supabase', 'schema.sql');
const schema = fs.readFileSync(schemaPath, 'utf8');

const allowedTypes = [
  'stocks', 'stockTxns', 'watchlist', 'crypto', 'realestate',
  'cash', 'cashTxns', 'cpfHistory', 'income', 'expenses',
  'snapshots', 'trash', 'insurance', 'insuranceRiders',
  'cpfBalances', 'categories', 'settings', '_meta', '_syncMeta'
];

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`✅ PASS: ${name}`);
    passed += 1;
  } catch (error) {
    console.error(`❌ FAIL: ${name}`);
    console.error(error.message);
    failed += 1;
  }
}

function mustMatch(pattern, name) {
  assert.match(schema, pattern, name);
}

function mustNotMatch(pattern, name) {
  assert.doesNotMatch(schema, pattern, name);
}

function functionBody(name) {
  const startPattern = new RegExp(
    `create\\s+or\\s+replace\\s+function\\s+public\\.${name}\\s*\\(`,
    'i'
  );
  const start = schema.search(startPattern);
  assert.notStrictEqual(start, -1, `function ${name} is defined`);
  const next = schema.indexOf('create or replace function public.', start + 1);
  return schema.slice(start, next === -1 ? schema.length : next);
}

function functionNamesForSearchPath() {
  return [
    'portfolio_stamp_record',
    'portfolio_bind_auth_user',
    'portfolio_upsert_record',
    'portfolio_delete_record',
    'portfolio_restore_record',
    'portfolio_get_records_page',
    'portfolio_sync_page',
    'portfolio_sync_boundary'
  ];
}

console.log('--- Testing Portfolio Supabase schema ---');

test('migration is transaction-wrapped and creates a hardened non-login RPC role', () => {
  const firstBegin = schema.indexOf('begin;');
  assert.notStrictEqual(firstBegin, -1);
  assert.strictEqual(schema.trim().endsWith('commit;'), true);
  assert.match(schema, /create role portfolio_rpc[\s\S]{0,240}nologin[\s\S]{0,240}nosuperuser[\s\S]{0,240}nocreatedb[\s\S]{0,240}nocreaterole[\s\S]{0,240}noreplication[\s\S]{0,240}nobypassrls/i);
  assert.match(schema, /alter role portfolio_rpc[\s\S]{0,240}nologin[\s\S]{0,240}nosuperuser[\s\S]{0,240}nocreatedb[\s\S]{0,240}nocreaterole[\s\S]{0,240}noreplication[\s\S]{0,240}nobypassrls/i);
  assert.match(schema, /create role portfolio_rpc[\s\S]{0,320}noinherit/i);
  assert.match(schema, /alter role portfolio_rpc[\s\S]{0,320}noinherit/i);
});

test('record table has the exact legacy collection allowlist', () => {
  const tableStart = schema.indexOf('create table if not exists public.portfolio_records');
  assert.notStrictEqual(tableStart, -1);
  const checkStart = schema.indexOf(
    'constraint portfolio_records_record_type_check',
    tableStart
  );
  assert.notStrictEqual(checkStart, -1);
  const checkEnd = schema.indexOf('),', checkStart);
  assert.notStrictEqual(checkEnd, -1);
  const check = schema.slice(checkStart, checkEnd);
  const values = [...check.matchAll(/'([^']+)'/g)].map((match) => match[1]);
  assert.deepStrictEqual(values, allowedTypes);
  assert.strictEqual(check.includes('_priceCache'), false);
});

test('records use the owner key, object payloads, version one, and guarded IDs', () => {
  mustMatch(/primary key\s*\(\s*user_id\s*,\s*record_type\s*,\s*record_id\s*\)/i);
  mustMatch(/payload\s+jsonb\s+not null\s+default\s+'\{\}'::jsonb/i);
  mustMatch(/jsonb_typeof\(payload\)\s*=\s*'object'/i);
  mustMatch(/position\s+integer\s+not null\s+default\s+0/i);
  mustMatch(/portfolio_records_position_check\s+check\s*\(\s*position\s*>=\s*0\s*\)/i);
  mustMatch(/version\s+bigint\s+not null\s+default\s+1/i);
  mustMatch(/version\s*>=\s*1/i);
  mustMatch(/record_id\s*~\s*'\^\[A-Za-z0-9_-\]\{1,64\}\$'/i);
  mustNotMatch(/char_length\(record_id\)\s*<=\s*200/i);
  mustMatch(/user_id\s+uuid[\s\S]{0,120}references\s+private\.portfolio_owner\s*\(owner_id\)\s+on delete restrict/i);
});

test('envelope constraints bind array IDs and singleton identity/order', () => {
  mustMatch(/constraint portfolio_records_envelope_check\s+check/i);
  mustMatch(/record_type in \([\s\S]{0,260}'snapshots',\s*'trash',\s*'insurance',\s*'insuranceRiders'[\s\S]{0,260}payload \? 'id'[\s\S]{0,180}jsonb_typeof\(payload -> 'id'\)\s*=\s*'string'[\s\S]{0,180}payload ->> 'id'\s*=\s*record_id/i);
  mustMatch(/record_type in \('cpfBalances',\s*'categories',\s*'settings',\s*'_meta',\s*'_syncMeta'\)[\s\S]{0,160}record_id\s*=\s*'singleton'[\s\S]{0,100}position\s*=\s*0/i);
});

test('position is a first-class column in every returned record shape', () => {
  for (const name of [
    'portfolio_upsert_record',
    'portfolio_delete_record',
    'portfolio_restore_record',
    'portfolio_get_records_page',
    'portfolio_sync_page'
  ]) {
    const body = functionBody(name);
    assert.match(body, /record_id text,\s*"position" integer,\s*payload jsonb/i);
    assert.match(body, /(?:record_id|v_row\.record_id|r\.record_id),\s*(?:position|v_row\.position|r\.position)/i);
  }
  const tableStart = schema.indexOf('create table if not exists public.portfolio_records');
  const tableEnd = schema.indexOf(');', tableStart);
  assert.notStrictEqual(tableStart, -1);
  assert.notStrictEqual(tableEnd, -1);
  assert.match(schema.slice(tableStart, tableEnd), /record_id\s+text[\s\S]{0,100}position\s+integer/i);
});

test('function result positions quote the keyword and preserve the position JSON field', () => {
  const returnBlocks = [...schema.matchAll(/returns\s+table\s*\(([\s\S]*?)\n\)/ig)].map((match) => match[1]);
  assert.strictEqual(returnBlocks.length, 6);
  for (const block of returnBlocks) {
    assert.match(block, /(?:^|\n)\s*"position"\s+integer\s*,/i);
    assert.doesNotMatch(block, /(?:^|\n)\s*position\s+integer\s*,/i);
  }
  assert.doesNotMatch(schema, /returns\s+table\s*\([\s\S]{0,220}record_id\s+text,\s*position\s+integer/i);
  assert.match(schema, /returns\s+table\s*\([\s\S]{0,220}record_id\s+text,\s*"position"\s+integer,\s*payload\s+jsonb/i);
});

test('owner table is private, singleton, and existing-user guarded', () => {
  mustMatch(/create schema if not exists private/i);
  mustMatch(/create table if not exists private\.portfolio_owner/i);
  mustMatch(/primary key\s*\(\s*owner_key\s*\)/i);
  mustMatch(/portfolio_owner_singleton_check\s+check\s*\(\s*owner_key\s*\)/i);
  mustMatch(/references\s+auth\.users\s*\(id\)\s+on delete restrict/i);
  mustMatch(/select count\(\*\)[\s\S]{0,180}from auth\.users/i);
  mustMatch(/if v_user_count\s*>\s*1[\s\S]{0,100}PORTFOLIO_OWNER_MULTIPLE_USERS/i);
  mustMatch(/if v_user_count\s*=\s*1[\s\S]{0,300}insert into private\.portfolio_owner/i);
});

test('RLS is enabled and forced, with authenticated owner AAL2 reads only', () => {
  mustMatch(/alter table public\.portfolio_records enable row level security/i);
  mustMatch(/alter table public\.portfolio_records force row level security/i);
  mustMatch(/create policy portfolio_records_owner_select[\s\S]{0,320}for select to authenticated/i);
  mustMatch(/auth\.uid\(\)\s*=\s*user_id/i);
  mustMatch(/auth\.jwt\(\)\s*->>\s*'aal'\s*\)\s*=\s*'aal2'/i);
  mustNotMatch(/create policy[\s\S]{0,180}on public\.portfolio_records[\s\S]{0,120}for\s+(?:all|insert|update|delete)\s+to\s+(?:anon|authenticated)/i);
});

test('RLS also constrains the non-bypass RPC role, without a DELETE policy', () => {
  mustMatch(/create policy portfolio_records_owner_select[\s\S]{0,160}for select to authenticated,\s*portfolio_rpc/i);
  mustMatch(/create policy portfolio_records_rpc_insert[\s\S]{0,180}for insert to portfolio_rpc[\s\S]{0,320}auth\.uid\(\)\s+is not null[\s\S]{0,180}auth\.uid\(\)\s*=\s*user_id[\s\S]{0,180}aal2/i);
  mustMatch(/create policy portfolio_records_rpc_update[\s\S]{0,220}for update to portfolio_rpc[\s\S]{0,380}using[\s\S]{0,220}auth\.uid\(\)\s*=\s*user_id[\s\S]{0,260}with check[\s\S]{0,220}auth\.uid\(\)\s*=\s*user_id/i);
  mustNotMatch(/create policy[\s\S]{0,180}on public\.portfolio_records[\s\S]{0,120}for delete/i);
});

test('API roles have no direct table or sequence writes', () => {
  mustMatch(/revoke all on table public\.portfolio_records from PUBLIC, anon, authenticated/i);
  mustMatch(/revoke all on table private\.portfolio_owner from PUBLIC, anon, authenticated/i);
  mustMatch(/revoke all on sequence public\.portfolio_change_seq from PUBLIC, anon, authenticated/i);
  mustMatch(/grant select on table public\.portfolio_records to authenticated/i);
  mustNotMatch(/grant\s+(?:all|insert|update|delete)[\s\S]{0,100}to\s+(?:anon|authenticated)/i);
  mustMatch(/revoke create on schema public from PUBLIC/i);
});

test('portfolio_rpc receives only the minimum trigger and RPC data access', () => {
  mustMatch(/grant usage on schema public, private, auth to portfolio_rpc/i);
  mustMatch(/grant execute on function auth\.uid\(\) to portfolio_rpc/i);
  mustMatch(/grant execute on function auth\.jwt\(\) to portfolio_rpc/i);
  mustMatch(/grant select, insert, update on table private\.portfolio_owner to portfolio_rpc/i);
  mustMatch(/grant select, insert, update on table public\.portfolio_records to portfolio_rpc/i);
  mustMatch(/grant usage on sequence public\.portfolio_change_seq to portfolio_rpc/i);
  mustMatch(/revoke delete, truncate, references, trigger[\s\S]{0,100}private\.portfolio_owner from portfolio_rpc/i);
  mustNotMatch(/revoke update[\s\S]{0,100}private\.portfolio_owner from portfolio_rpc/i);
  mustMatch(/revoke delete, truncate, references, trigger[\s\S]{0,100}public\.portfolio_records from portfolio_rpc/i);
  mustNotMatch(/grant[\s\S]{0,120}(?:delete|truncate|references|trigger)[\s\S]{0,80}to portfolio_rpc/i);
  const apiExecuteGrants = [...schema.matchAll(/grant execute on function public\.[\s\S]{0,220}?to authenticated/ig)];
  assert.strictEqual(apiExecuteGrants.length, 6);
  for (const grant of apiExecuteGrants) assert.doesNotMatch(grant[0], /portfolio_rpc/i);
});

test('every function uses an empty search path', () => {
  for (const name of functionNamesForSearchPath()) {
    const body = functionBody(name);
    assert.match(body, /security definer/i, `${name} is SECURITY DEFINER`);
    assert.match(body, /set search_path\s*=\s*''/i, `${name} clears search_path`);
  }
});

test('every SECURITY DEFINER function is owned by the hardened RPC role', () => {
  const signatures = {
    portfolio_stamp_record: '\\(\\)',
    portfolio_bind_auth_user: '\\(\\)',
    portfolio_upsert_record: '\\(text, text, jsonb, integer, bigint\\)',
    portfolio_delete_record: '\\(text, text, bigint\\)',
    portfolio_restore_record: '\\(text, text, jsonb, integer, bigint\\)',
    portfolio_get_records_page: '\\(bigint, bigint, integer\\)',
    portfolio_sync_page: '\\(bigint, integer\\)',
    portfolio_sync_boundary: '\\(\\)'
  };
  for (const [name, signature] of Object.entries(signatures)) {
    mustMatch(new RegExp(`alter\\s+function\\s+public\\.${name}${signature}\\s+owner\\s+to\\s+portfolio_rpc`, 'i'));
  }
  mustMatch(/alter\s+function\s+public\.portfolio_restore_record\(text, text, bigint\)\s+owner\s+to\s+portfolio_rpc/i);
});

test('owner trigger binds the first later user and rejects subsequent users', () => {
  const body = functionBody('portfolio_bind_auth_user');
  assert.match(body, /pg_advisory_xact_lock/i);
  assert.match(body, /select po\.owner_id[\s\S]{0,180}for update/i);
  assert.match(body, /PORTFOLIO_OWNER_ALREADY_BOUND/i);
  assert.match(body, /new\.id/i);
  mustMatch(/create trigger portfolio_bind_auth_user_after_insert[\s\S]{0,140}after insert on auth\.users/i);
  mustMatch(/execute function public\.portfolio_bind_auth_user\(\)/i);
});

test('owner binding lock privilege is present without destructive owner access', () => {
  const body = functionBody('portfolio_bind_auth_user');
  assert.match(body, /from private\.portfolio_owner[\s\S]{0,100}for update/i);
  mustMatch(/grant select, insert, update on table private\.portfolio_owner to portfolio_rpc/i);
  mustMatch(/revoke delete, truncate, references, trigger[\s\S]{0,100}private\.portfolio_owner from portfolio_rpc/i);
  mustNotMatch(/grant[\s\S]{0,120}(?:delete|truncate|references|trigger)[\s\S]{0,80}private\.portfolio_owner[\s\S]{0,80}to portfolio_rpc/i);
});

test('mutating RPCs validate type, ID, payload, and expected version', () => {
  for (const name of [
    'portfolio_upsert_record',
    'portfolio_delete_record',
    'portfolio_restore_record'
  ]) {
    const body = functionBody(name);
    assert.match(body, /p_record_type is null[\s\S]{0,400}PORTFOLIO_INVALID_RECORD_TYPE/i);
    assert.match(body, /p_record_id is null[\s\S]{0,300}PORTFOLIO_INVALID_RECORD_ID/i);
    assert.match(body, /p_record_id\s*!~\s*'\^\[A-Za-z0-9_-\]\{1,64\}\$'/i);
    assert.match(body, /char_length\(p_record_id\)\s*>\s*64/i);
    if (name === 'portfolio_upsert_record' || name === 'portfolio_restore_record') {
      assert.match(body, /p_position is null\s+or\s+p_position\s*<\s*0/i);
      assert.match(body, /PORTFOLIO_INVALID_POSITION/i);
    }
    assert.match(body, /p_expected_version is null\s+or\s+p_expected_version\s*<\s*0/i);
    assert.match(body, /PORTFOLIO_INVALID_EXPECTED_VERSION/i);
  }
  const upsert = functionBody('portfolio_upsert_record');
  mustMatch(/portfolio_upsert_record\(\s*p_record_type text,\s*p_record_id text,\s*p_payload jsonb,\s*p_position integer,\s*p_expected_version bigint\s*\)/i);
  assert.match(upsert, /jsonb_typeof\(p_payload\)\s*<>\s*'object'/i);
  assert.match(upsert, /PORTFOLIO_INVALID_PAYLOAD/i);
  assert.match(upsert, /p_record_type in \([\s\S]{0,260}'snapshots',\s*'trash',\s*'insurance',\s*'insuranceRiders'[\s\S]{0,200}not \(p_payload \? 'id'\)[\s\S]{0,220}jsonb_typeof\(p_payload -> 'id'\)\s*<>\s*'string'[\s\S]{0,220}p_payload ->> 'id'\) is distinct from p_record_id/i);
  assert.match(upsert, /p_record_type in \('cpfBalances',\s*'categories',\s*'settings',\s*'_meta',\s*'_syncMeta'\)[\s\S]{0,180}p_record_id\s*<>\s*'singleton'[\s\S]{0,120}p_position\s*<>\s*0/i);
  assert.match(upsert, /PORTFOLIO_INVALID_ENVELOPE/i);
});

test('RPCs explicitly require the configured owner and AAL2', () => {
  for (const name of [
    'portfolio_upsert_record',
    'portfolio_delete_record',
    'portfolio_restore_record',
    'portfolio_get_records_page',
    'portfolio_sync_page',
    'portfolio_sync_boundary'
  ]) {
    const body = functionBody(name);
    assert.match(body, /auth\.uid\(\)/i, `${name} checks auth.uid()`);
    assert.match(body, /auth\.jwt\(\)\s*->>\s*'aal'[\s\S]{0,40}'aal2'/i, `${name} checks AAL2`);
    assert.match(body, /private\.portfolio_owner/i, `${name} checks owner table`);
    assert.match(body, /po\.owner_id\s*=\s*v_uid/i, `${name} compares owner ID`);
  }
});

test('upsert uses expected zero for insert and an atomic live-row CAS for update', () => {
  const body = functionBody('portfolio_upsert_record');
  assert.match(body, /if p_expected_version\s*=\s*0/i);
  assert.match(body, /on conflict\s+on constraint\s+portfolio_records_pkey\s+do nothing/i);
  assert.doesNotMatch(body, /on conflict\s*\(\s*(?:user_id|record_type|record_id)\b/i);
  assert.match(body, /update public\.portfolio_records as r[\s\S]{0,700}position\s*=\s*p_position[\s\S]{0,700}r\.version\s*=\s*p_expected_version[\s\S]{0,120}r\.deleted_at is null/i);
  assert.match(body, /version\s*=\s*r\.version\s*\+\s*1/i);
});

test('RPC predicates qualify table columns that collide with return fields', () => {
  mustMatch(/constraint portfolio_records_pkey\s+primary key\s*\(\s*user_id\s*,\s*record_type\s*,\s*record_id\s*\)/i);
  mustMatch(/on conflict\s+on constraint\s+portfolio_records_pkey\s+do nothing/i);
  mustNotMatch(/on conflict\s*\(\s*(?:user_id|record_type|record_id)\b/i);
  for (const name of [
    'portfolio_upsert_record',
    'portfolio_delete_record',
    'portfolio_restore_record',
    'portfolio_get_records_page',
    'portfolio_sync_page',
    'portfolio_sync_boundary'
  ]) {
    const body = functionBody(name);
    assert.doesNotMatch(body, /(?:where|and|or)\s+(?:user_id|record_type|record_id|position|version|change_seq|deleted_at)\s*=/i, `${name} qualifies predicate columns`);
    assert.doesNotMatch(body, /select\s+(?:user_id|record_type|record_id|position|version|change_seq|deleted_at)\s+from\s+public\.portfolio_records/i, `${name} qualifies selected columns`);
  }
});

test('delete and restore use atomic state predicates and increment versions', () => {
  const deleteBody = functionBody('portfolio_delete_record');
  assert.match(deleteBody, /set deleted_at\s*=\s*pg_catalog\.clock_timestamp\(\)/i);
  assert.match(deleteBody, /r\.version\s*=\s*p_expected_version[\s\S]{0,100}r\.deleted_at is null/i);
  assert.match(deleteBody, /version\s*=\s*r\.version\s*\+\s*1/i);
  assert.doesNotMatch(deleteBody, /set[\s\S]{0,180}payload\s*=/i);
  assert.match(deleteBody, /PORTFOLIO_ALREADY_DELETED/i);

  const restoreBody = functionBody('portfolio_restore_record');
  mustMatch(/portfolio_restore_record\(\s*p_record_type text,\s*p_record_id text,\s*p_payload jsonb,\s*p_position integer,\s*p_expected_version bigint\s*\)/i);
  assert.match(restoreBody, /jsonb_typeof\(p_payload\)\s*<>\s*'object'/i);
  assert.match(restoreBody, /PORTFOLIO_INVALID_PAYLOAD/i);
  assert.match(restoreBody, /PORTFOLIO_INVALID_ENVELOPE/i);
  assert.match(restoreBody, /set deleted_at\s*=\s*null/i);
  assert.match(restoreBody, /payload\s*=\s*p_payload[\s\S]{0,120}position\s*=\s*p_position/i);
  assert.match(restoreBody, /updated_at\s*=\s*pg_catalog\.clock_timestamp\(\)/i);
  assert.match(restoreBody, /r\.version\s*=\s*p_expected_version[\s\S]{0,100}r\.deleted_at is not null/i);
  assert.match(restoreBody, /version\s*=\s*r\.version\s*\+\s*1/i);
  assert.match(restoreBody, /PORTFOLIO_ALREADY_LIVE/i);
  const legacyRestoreStart = schema.indexOf('as $portfolio_restore_record_legacy$');
  const legacyRestoreEnd = schema.indexOf('$portfolio_restore_record_legacy$;', legacyRestoreStart);
  const legacyRestoreDefinitionStart = schema.lastIndexOf('create or replace function public.portfolio_restore_record(', legacyRestoreStart);
  assert.notStrictEqual(legacyRestoreDefinitionStart, -1);
  assert.notStrictEqual(legacyRestoreStart, -1);
  assert.notStrictEqual(legacyRestoreEnd, -1);
  const legacyRestoreBody = schema.slice(legacyRestoreDefinitionStart, legacyRestoreEnd);
  assert.match(legacyRestoreBody, /security definer[\s\S]{0,80}set search_path\s*=\s*''/i);
  assert.match(legacyRestoreBody, /update public\.portfolio_records as r[\s\S]{0,420}r\.version\s*=\s*p_expected_version[\s\S]{0,100}r\.deleted_at is not null/i);
});

test('sequence trigger and sync cursor provide ordered durable changes', () => {
  const stampBody = functionBody('portfolio_stamp_record');
  assert.match(stampBody, /nextval\([\s\S]{0,100}public\.portfolio_change_seq/i);
  mustMatch(/before insert or update on public\.portfolio_records/i);
  const syncBody = functionBody('portfolio_sync_page');
  assert.match(syncBody, /p_after_change_seq is null\s+or\s+p_after_change_seq\s*<\s*0/i);
  assert.match(syncBody, /p_limit is null\s+or\s+p_limit\s*<\s*1\s+or\s+p_limit\s*>\s*500/i);
  assert.match(syncBody, /r\.change_seq\s*>\s*p_after_change_seq/i);
  assert.match(syncBody, /order by r\.change_seq asc, r\.record_type asc, r\.record_id asc/i);
  assert.doesNotMatch(syncBody, /r\.deleted_at is null/i);
  const boundaryBody = functionBody('portfolio_sync_boundary');
  assert.match(boundaryBody, /max\(r\.change_seq\)/i);
});

test('get records pages use one immutable snapshot boundary and deterministic cursors', () => {
  const body = functionBody('portfolio_get_records_page');
  assert.match(body, /portfolio_get_records_page\([\s\S]{0,220}p_snapshot_sequence bigint default null[\s\S]{0,120}p_limit integer default 200/i);
  assert.match(body, /snapshot_sequence bigint/i);
  assert.match(body, /p_snapshot_sequence is null[\s\S]{0,220}max\(r\.change_seq\)[\s\S]{0,160}into v_snapshot_sequence/i);
  assert.match(body, /p_after_change_seq is null\s+or\s+p_after_change_seq\s*<\s*0/i);
  assert.match(body, /p_snapshot_sequence is not null\s+and\s+p_snapshot_sequence\s*<\s*0[\s\S]{0,100}PORTFOLIO_INVALID_SNAPSHOT/i);
  assert.match(body, /p_limit is null\s+or\s+p_limit\s*<\s*1\s+or\s+p_limit\s*>\s*500/i);
  assert.match(body, /p_after_change_seq\s*>\s*v_snapshot_sequence[\s\S]{0,100}PORTFOLIO_INVALID_CURSOR/i);
  assert.match(body, /r\.change_seq\s*>\s*p_after_change_seq[\s\S]{0,120}r\.change_seq\s*<=\s*v_snapshot_sequence/i);
  assert.match(body, /v_snapshot_sequence\s+as\s+snapshot_sequence/i);
  assert.match(body, /order by r\.change_seq asc, r\.record_type asc, r\.record_id asc/i);
  assert.match(body, /limit p_limit/i);
});

test('all named RPCs are deny-by-default and granted only to authenticated', () => {
  const signatures = {
    portfolio_upsert_record: 'text, text, jsonb, integer, bigint',
    portfolio_delete_record: 'text, text, bigint',
    portfolio_restore_record: 'text, text, jsonb, integer, bigint',
    portfolio_get_records_page: 'bigint, bigint, integer',
    portfolio_sync_boundary: ''
  };
  for (const [name, signature] of Object.entries(signatures)) {
    const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const escapedSignature = signature.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const revoke = new RegExp(
      `revoke\\s+all\\s+on\\s+function\\s+public\\.${escapedName}\\(${escapedSignature}\\)\\s+from\\s+PUBLIC,\\s*anon,\\s*authenticated,\\s*service_role`,
      'i'
    );
    const grant = new RegExp(
      `grant\\s+execute\\s+on\\s+function\\s+public\\.${escapedName}\\(${escapedSignature}\\)\\s+to\\s+authenticated`,
      'i'
    );
    mustMatch(revoke, `${name} revokes default execute`);
    mustMatch(grant, `${name} grants authenticated execute`);
  }
  mustMatch(/revoke\s+all\s+on\s+function\s+public\.portfolio_restore_record\(text, text, bigint\)\s+from\s+PUBLIC,\s*anon,\s*authenticated,\s*service_role/i);
  mustMatch(/grant\s+execute\s+on\s+function\s+public\.portfolio_restore_record\(text, text, bigint\)\s+to\s+authenticated/i);
  mustNotMatch(/grant execute[\s\S]{0,160}to\s+(?:PUBLIC|anon)/i);
  mustMatch(/revoke all on function public\.portfolio_sync_page\(bigint, integer\)[\s\S]{0,120}from PUBLIC, anon, authenticated, service_role/i);
  mustNotMatch(/grant execute on function public\.portfolio_sync_page\([\s\S]{0,100}?\)\s+to authenticated/i);
});

test('service_role is explicitly denied schema privileges and never receives API execution', () => {
  for (const pattern of [
    /revoke all on schema private from PUBLIC, anon, authenticated, service_role/i,
    /revoke all on table private\.portfolio_owner from PUBLIC, anon, authenticated, service_role/i,
    /revoke all on table public\.portfolio_records from PUBLIC, anon, authenticated, service_role/i,
    /revoke all on sequence public\.portfolio_change_seq from PUBLIC, anon, authenticated, service_role/i,
    /revoke all on function public\.portfolio_stamp_record\(\)[\s\S]{0,100}from PUBLIC, anon, authenticated, service_role/i,
    /revoke all on function public\.portfolio_bind_auth_user\(\)[\s\S]{0,100}from PUBLIC, anon, authenticated, service_role/i,
    /revoke all on function public\.portfolio_upsert_record\(text, text, jsonb, integer, bigint\)[\s\S]{0,100}from PUBLIC, anon, authenticated, service_role/i,
    /revoke all on function public\.portfolio_delete_record\(text, text, bigint\)[\s\S]{0,100}from PUBLIC, anon, authenticated, service_role/i,
    /revoke all on function public\.portfolio_restore_record\(text, text, jsonb, integer, bigint\)[\s\S]{0,100}from PUBLIC, anon, authenticated, service_role/i,
    /revoke all on function public\.portfolio_restore_record\(text, text, bigint\)[\s\S]{0,100}from PUBLIC, anon, authenticated, service_role/i,
    /revoke all on function public\.portfolio_get_records_page\(bigint, bigint, integer\)[\s\S]{0,100}from PUBLIC, anon, authenticated, service_role/i,
    /revoke all on function public\.portfolio_sync_page\(bigint, integer\)[\s\S]{0,100}from PUBLIC, anon, authenticated, service_role/i,
    /revoke all on function public\.portfolio_sync_boundary\(\)[\s\S]{0,100}from PUBLIC, anon, authenticated, service_role/i
  ]) mustMatch(pattern);
  mustMatch(/revoke all on function auth\.uid\(\) from PUBLIC, anon, authenticated, service_role/i);
  mustMatch(/revoke all on function auth\.jwt\(\) from PUBLIC, anon, authenticated, service_role/i);
  mustNotMatch(/grant execute on function public\.[\s\S]{0,180}to service_role/i);
  mustNotMatch(/grant\s+(?:all|select|insert|update|delete|truncate|references|trigger)[\s\S]{0,120}to service_role/i);
  mustNotMatch(/grant execute on function auth\.(?:uid|jwt)\(\)[\s\S]{0,100}to service_role/i);
});

test('schema has no destructive reset, credentials, or hardcoded identifiers', () => {
  mustNotMatch(/drop\s+table/i);
  mustNotMatch(/["'][0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}["']/i);
  mustNotMatch(/(?:password|secret|api[_ -]?key)\s*[:=]/i);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
