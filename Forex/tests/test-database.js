#!/usr/bin/env node
'use strict';

// Genuine PostgreSQL contract tests for the Forex schema. This file is
// deliberately dependency-free and never accepts a database URL, password or
// existing cluster path. It creates one private temporary cluster, connects
// only through its Unix socket as the explicit postgres role, then removes
// only the directory created by this invocation.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SCHEMA_PATH = path.join(REPO_ROOT, 'Forex', 'schema.sql');
const USER_A = '00000000-0000-0000-0000-00000000000a';
const USER_B = '00000000-0000-0000-0000-00000000000b';
const USER_C = '00000000-0000-0000-0000-00000000000c';
const BIN_NAMES = ['initdb', 'pg_ctl', 'psql'];

function findExecutable(name) {
  const result = spawnSync('/bin/sh', ['-c', `command -v ${name}`], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

const binaries = Object.fromEntries(BIN_NAMES.map(name => [name, findExecutable(name)]));
const missing = BIN_NAMES.filter(name => !binaries[name]);
if (missing.length) {
  console.error(`BLOCKED: PostgreSQL contract tests need ${missing.join(', ')}, none was found`);
  process.exit(2);
}
if (typeof process.getuid === 'function' && process.getuid() === 0) {
  console.error('BLOCKED: initdb refuses to initialise a cluster as root');
  process.exit(2);
}

let tempRoot;
let clusterDir;
let socketDir;
let serverLog;
let serverStarted = false;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sqlLiteral(value) {
  return "'" + String(value).replace(/'/g, "''") + "'";
}

function processEnvironment() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('PG')) delete env[key];
  }
  // Force any password lookup to a fresh, nonexistent path. The cluster uses
  // local trust authentication and every connection parameter is explicit.
  env.PGPASSFILE = path.join(tempRoot, 'missing.pgpass');
  env.PGSERVICEFILE = path.join(tempRoot, 'missing.pg_service.conf');
  return env;
}

function psqlArgs(extra) {
  return [
    '-X',
    '-q',
    '-v', 'ON_ERROR_STOP=1',
    '-v', 'VERBOSITY=verbose',
    '-A', '-t',
    '-h', socketDir,
    '-U', 'postgres',
    '-d', 'postgres',
    ...extra,
  ];
}

function runPsql(extra, label) {
  const result = spawnSync(binaries.psql, psqlArgs(extra), {
    cwd: REPO_ROOT,
    env: processEnvironment(),
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  if (result.error) throw new Error(`${label}: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim().slice(-2000);
    throw new Error(`${label}: psql exited ${result.status}${detail ? `: ${detail}` : ''}`);
  }
  return result;
}

function runSql(sql, label) {
  return runPsql(['-c', sql], label);
}

function expectSqlFailure(sql, label) {
  return expectSqlStateFailure(sql, label, '42501');
}

function expectSqlStateFailure(sql, label, sqlState) {
  const result = spawnSync(binaries.psql, psqlArgs(['-c', sql]), {
    cwd: REPO_ROOT,
    env: processEnvironment(),
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  if (result.error) throw new Error(`${label}: ${result.error.message}`);
  assert(result.status !== 0, `${label}: expected PostgreSQL to deny the operation`);
  const errorText = `${result.stderr || ''}\n${result.stdout || ''}`;
  assert(new RegExp(`ERROR:\\s+${sqlState}\\b`).test(errorText),
    `${label}: expected SQLSTATE ${sqlState}, got ${errorText.trim().slice(-1200)}`);
  return result;
}

function spawnSql(sql, label, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const child = spawn(binaries.psql, psqlArgs(['-c', sql]), {
      cwd: REPO_ROOT,
      env: processEnvironment(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      reject(new Error(`${label}: timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`${label}: ${error.message}`));
    });
    child.on('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function rolePrefix(role, userId) {
  const claim = userId === undefined ? '' : userId;
  return [
    `set role ${role};`,
    `do $$begin perform pg_catalog.set_config('request.jwt.claim.sub', ${sqlLiteral(claim)}, false); end $$;`,
  ].join('\n');
}

function barrierWaitSql() {
  return `
do $$
declare
  deadline timestamptz := pg_catalog.clock_timestamp() + interval '10 seconds';
begin
  loop
    exit when (select ready from public.test_barrier where id = 1) >= 2;
    if pg_catalog.clock_timestamp() >= deadline then
      raise exception 'test barrier timeout';
    end if;
    perform pg_catalog.pg_sleep(0.01);
  end loop;
end $$;`;
}

function writerSql(userId, writer, tradeId, expectedSql) {
  return `
begin;
update public.test_barrier set ready = ready + 1 where id = 1;
commit;
${barrierWaitSql()}
begin;
${rolePrefix('authenticated', userId)}
select applied::text
  from public.sync_trade(
    ${sqlLiteral(tradeId)},
    jsonb_build_object('writer', ${sqlLiteral(writer)}),
    ${expectedSql},
    false
  );
commit;`;
}

function billingWriterSql(eventId, eventCreated, plan) {
  return `
begin;
update public.test_barrier set ready = ready + 1 where id = 1;
commit;
${barrierWaitSql()}
${rolePrefix('service_role')}
select applied::text || ',' || duplicate::text || ',' || matched::text || ',' || reason
  from public.apply_stripe_event(
    ${sqlLiteral(eventId)},
    'customer.subscription.updated',
    ${eventCreated},
    'cus_a',
    'sub_a',
    ${sqlLiteral(plan)}
  );`;
}

function onlyResult(result, label) {
  assert(result.code === 0, `${label}: ${result.stderr.trim() || 'psql failed'}`);
  const values = result.stdout.trim().split(/\s+/).filter(Boolean);
  assert(values.length === 1 && (values[0] === 'true' || values[0] === 'false'),
    `${label}: expected one boolean result, got ${JSON.stringify(result.stdout)}`);
  return values[0];
}

function billingResult(result, label) {
  assert(result.code === 0, `${label}: ${result.stderr.trim() || 'psql failed'}`);
  const value = result.stdout.trim();
  assert(/^(?:true|false),(?:true|false),-?\d+,[^\n]+$/.test(value),
    `${label}: expected billing result row, got ${JSON.stringify(result.stdout)}`);
  return value;
}

function shellQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

let cleanupDone = false;
let cleanupPreserved = false;

function cleanup() {
  if (cleanupDone) return true;
  if (cleanupPreserved || !tempRoot) return false;
  if (serverStarted) {
    const stop = spawnSync(binaries.pg_ctl, ['-D', clusterDir, '-m', 'fast', '-w', 'stop'], {
      cwd: REPO_ROOT,
      env: processEnvironment(),
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    });
    const status = spawnSync(binaries.pg_ctl, ['-D', clusterDir, 'status'], {
      cwd: REPO_ROOT,
      env: processEnvironment(),
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    });
    const pidFileGone = !fs.existsSync(path.join(clusterDir, 'postmaster.pid'));
    const stopped = status.status === 3 && pidFileGone;
    if (stop.status !== 0 || !stopped) {
      cleanupPreserved = true;
      if (!process.exitCode) process.exitCode = 1;
      console.error(`BLOCKED: could not prove PostgreSQL stopped, preserving ${tempRoot}`);
      return false;
    }
    serverStarted = false;
  }
  try {
    if (fs.existsSync(tempRoot)) fs.rmSync(tempRoot, { recursive: true, force: true });
    cleanupDone = true;
    return true;
  } catch (error) {
    cleanupPreserved = true;
    if (!process.exitCode) process.exitCode = 1;
    console.error(`BLOCKED: cleanup failed, preserving ${tempRoot}: ${error.message}`);
    return false;
  }
}

async function main() {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kjr-forex-pg-'));
  clusterDir = path.join(tempRoot, 'cluster');
  socketDir = path.join(tempRoot, 'socket');
  serverLog = path.join(tempRoot, 'postgres.log');
  fs.mkdirSync(socketDir, { mode: 0o700 });

  const init = spawnSync(binaries.initdb, [
    '-D', clusterDir,
    '-U', 'postgres',
    '--no-locale',
    '--encoding=UTF8',
    '--auth-local=trust',
    '--auth-host=reject',
  ], {
    cwd: REPO_ROOT,
    env: processEnvironment(),
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  if (init.error || init.status !== 0) {
    throw new Error(`initdb failed: ${(init.stderr || init.stdout || init.error?.message || '').trim().slice(-2000)}`);
  }

  const postgresOptions = `-k ${shellQuote(socketDir)} -c listen_addresses='' -c unix_socket_permissions=0700`;
  serverStarted = true;
  const start = spawnSync(binaries.pg_ctl, [
    '-D', clusterDir,
    '-o', postgresOptions,
    '-l', serverLog,
    '-w',
    'start',
  ], {
    cwd: REPO_ROOT,
    env: processEnvironment(),
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  if (start.error || start.status !== 0) {
    const log = fs.existsSync(serverLog) ? fs.readFileSync(serverLog, 'utf8').slice(-2000) : '';
    throw new Error(`pg_ctl start failed: ${(start.stderr || start.stdout || start.error?.message || '').trim()}${log ? `\n${log}` : ''}`);
  }

  const bootstrap = `
create schema auth;
create table auth.users (id uuid primary key);
create or replace function auth.uid()
returns uuid
language sql
stable
as $fn$
  select nullif(pg_catalog.current_setting('request.jwt.claim.sub', true), '')::uuid
$fn$;
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
grant usage on schema auth, public to anon, authenticated, service_role;
grant select on auth.users to service_role;
`;
  runSql(bootstrap, 'bootstrap Supabase auth fixture');

  const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
  const applyPath = path.join(tempRoot, 'apply.sql');
  fs.writeFileSync(applyPath, schema, 'utf8');
  runPsql(['-f', applyPath], 'apply Forex schema');
  runPsql(['-f', applyPath], 'reapply Forex schema idempotence');

  runSql(`
insert into auth.users (id) values
  (${sqlLiteral(USER_A)}), (${sqlLiteral(USER_B)}), (${sqlLiteral(USER_C)});
insert into public.profiles (id, plan) values
  (${sqlLiteral(USER_A)}, 'free'), (${sqlLiteral(USER_B)}, 'free');
insert into public.trades (id, data, user_id) values
  ('a_trade', '{"owner":"a"}'::jsonb, ${sqlLiteral(USER_A)}),
  ('b_trade', '{"owner":"b"}'::jsonb, ${sqlLiteral(USER_B)}),
  ('stale_trade', '{"value":"initial"}'::jsonb, ${sqlLiteral(USER_A)}),
  ('clock_trade', '{"value":"initial"}'::jsonb, ${sqlLiteral(USER_A)}),
  ('cas_trade', '{"writer":"initial"}'::jsonb, ${sqlLiteral(USER_A)});
create table public.test_barrier (id integer primary key, ready integer not null default 0);
insert into public.test_barrier (id) values (1);
`, 'seed synthetic rows');

  assert(runSql(`select count(*)::text from public.profiles where id = ${sqlLiteral(USER_B)};`,
    'admin profile seed visibility').stdout.trim() === '1',
    'admin could not see seeded second profile');

  runSql(`${rolePrefix('service_role')}
update public.profiles
   set stripe_customer_id = 'cus_a', stripe_subscription_id = 'sub_a'
 where id = ${sqlLiteral(USER_A)};`, 'seed Stripe customer attribution');

  const privilegeOutput = runSql(`
select
  has_table_privilege('authenticated', 'public.trades', 'SELECT')::text || ',' ||
  has_table_privilege('authenticated', 'public.trades', 'INSERT')::text || ',' ||
  has_table_privilege('authenticated', 'public.trades', 'UPDATE')::text || ',' ||
  has_table_privilege('authenticated', 'public.trades', 'DELETE')::text || ',' ||
  has_table_privilege('authenticated', 'public.trades', 'TRUNCATE')::text || ';' ||
  has_table_privilege('service_role', 'public.trades', 'SELECT')::text || ',' ||
  has_table_privilege('service_role', 'public.trades', 'INSERT')::text || ',' ||
  has_table_privilege('service_role', 'public.trades', 'UPDATE')::text || ',' ||
  has_table_privilege('service_role', 'public.trades', 'DELETE')::text;
select
  has_function_privilege('anon', 'public.sync_trade(text,jsonb,timestamptz,boolean)', 'EXECUTE')::text || ',' ||
  has_function_privilege('authenticated', 'public.sync_trade(text,jsonb,timestamptz,boolean)', 'EXECUTE')::text;
select p.prosecdef::text || ';' || pg_get_userbyid(p.proowner) || ';' || coalesce(array_to_string(p.proconfig, ','), '')
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname = 'sync_trade'
   and pg_catalog.pg_get_function_identity_arguments(p.oid) = 'p_id text, p_data jsonb, p_expected_updated_at timestamp with time zone, p_delete boolean';
`, 'inspect PostgreSQL grants').stdout.trim().split(/\n/);
  assert(privilegeOutput[0] === 'true,false,false,false,false;true,true,true,true', `unexpected trade grants: ${privilegeOutput[0]}`);
  assert(privilegeOutput[1] === 'false,true', `unexpected RPC grants: ${privilegeOutput[1]}`);
  assert(privilegeOutput[2] === 'true;postgres;search_path=""', `unexpected RPC owner/config: ${privilegeOutput[2]}`);

  const profilePrivilegeOutput = runSql(`
select
  has_table_privilege('authenticated', 'public.profiles', 'SELECT')::text || ',' ||
  has_table_privilege('authenticated', 'public.profiles', 'INSERT')::text || ',' ||
  has_table_privilege('authenticated', 'public.profiles', 'UPDATE')::text || ',' ||
  has_table_privilege('authenticated', 'public.profiles', 'DELETE')::text || ',' ||
  has_table_privilege('authenticated', 'public.profiles', 'TRUNCATE')::text || ';' ||
  has_table_privilege('service_role', 'public.profiles', 'SELECT')::text || ',' ||
  has_table_privilege('service_role', 'public.profiles', 'INSERT')::text || ',' ||
  has_table_privilege('service_role', 'public.profiles', 'UPDATE')::text || ',' ||
  has_table_privilege('service_role', 'public.profiles', 'DELETE')::text;
select
  has_table_privilege('authenticated', 'public.stripe_webhook_events', 'SELECT')::text || ',' ||
  has_table_privilege('authenticated', 'public.stripe_webhook_events', 'INSERT')::text || ',' ||
  has_table_privilege('authenticated', 'public.stripe_webhook_events', 'UPDATE')::text || ',' ||
  has_table_privilege('authenticated', 'public.stripe_webhook_events', 'DELETE')::text || ',' ||
  has_table_privilege('authenticated', 'public.stripe_webhook_events', 'TRUNCATE')::text;
`, 'inspect profile and event grants').stdout.trim().split(/\n/);
  assert(profilePrivilegeOutput[0] === 'true,false,false,false,false;true,true,true,true',
    `unexpected profile grants: ${profilePrivilegeOutput[0]}`);
  assert(profilePrivilegeOutput[1] === 'false,false,false,false,false',
    `unexpected event table grants: ${profilePrivilegeOutput[1]}`);

  const billingPrivilegeOutput = runSql(`
select
  has_function_privilege('anon', 'public.apply_stripe_event(text,text,bigint,text,text,text)', 'EXECUTE')::text || ',' ||
  has_function_privilege('authenticated', 'public.apply_stripe_event(text,text,bigint,text,text,text)', 'EXECUTE')::text || ',' ||
  has_function_privilege('service_role', 'public.apply_stripe_event(text,text,bigint,text,text,text)', 'EXECUTE')::text;
select p.prosecdef::text || ';' || pg_get_userbyid(p.proowner) || ';' || coalesce(array_to_string(p.proconfig, ','), '')
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname = 'apply_stripe_event'
   and pg_catalog.pg_get_function_identity_arguments(p.oid) = 'p_event_id text, p_event_type text, p_event_created bigint, p_customer_id text, p_subscription_id text, p_plan text';
`, 'inspect billing RPC grants').stdout.trim().split(/\n/);
  assert(billingPrivilegeOutput[0] === 'false,false,true',
    `unexpected billing RPC grants: ${billingPrivilegeOutput[0]}`);
  assert(billingPrivilegeOutput[1] === 'true;postgres;search_path=""',
    `unexpected billing RPC owner/config: ${billingPrivilegeOutput[1]}`);

  const ownSelect = runSql(`${rolePrefix('authenticated', USER_A)}
select count(*)::text from public.trades where id = 'a_trade';
select count(*)::text from public.trades where id = 'b_trade';`, 'authenticated own-row SELECT').stdout.trim().split(/\n/);
  assert(ownSelect.join(',') === '1,0', `RLS exposed the wrong rows: ${ownSelect.join(',')}`);

  const ownProfileSelect = runSql(`${rolePrefix('authenticated', USER_A)}
select count(*)::text from public.profiles where id = ${sqlLiteral(USER_A)};
select count(*)::text from public.profiles where id = ${sqlLiteral(USER_B)};`, 'authenticated own-profile SELECT').stdout.trim().split(/\n/);
  assert(ownProfileSelect.join(',') === '1,0', `profile RLS exposed the wrong rows: ${ownProfileSelect.join(',')}`);
  expectSqlFailure(`${rolePrefix('authenticated', USER_A)}
update public.profiles
   set plan = 'pro', stripe_customer_id = 'cus_client_tamper'
 where id = ${sqlLiteral(USER_A)};`, 'authenticated direct profile UPDATE');
  expectSqlFailure(`${rolePrefix('authenticated', USER_A)}
insert into public.profiles (id, plan) values (${sqlLiteral(USER_B)}, 'pro');`, 'authenticated direct profile INSERT');
  expectSqlFailure(`${rolePrefix('authenticated', USER_A)}
delete from public.profiles where id = ${sqlLiteral(USER_A)};`, 'authenticated direct profile DELETE');
  expectSqlFailure(`${rolePrefix('authenticated', USER_A)}
truncate public.profiles;`, 'authenticated direct profile TRUNCATE');
  expectSqlStateFailure(`${rolePrefix('service_role')}
insert into public.profiles (id, plan, stripe_customer_id)
values (${sqlLiteral(USER_C)}, 'free', 'cus_a');`, 'duplicate Stripe customer INSERT', '23505');
  runSql(`${rolePrefix('service_role')}
update public.profiles
   set stripe_customer_id = 'cus_b', stripe_subscription_id = 'sub_b'
 where id = ${sqlLiteral(USER_B)};`, 'seed duplicate customer update fixture');
  expectSqlStateFailure(`${rolePrefix('service_role')}
update public.profiles
   set stripe_customer_id = 'cus_a'
 where id = ${sqlLiteral(USER_B)};`, 'duplicate Stripe customer UPDATE', '23505');
  expectSqlStateFailure(`${rolePrefix('service_role')}
update public.profiles
   set stripe_subscription_id = 'sub_a'
 where id = ${sqlLiteral(USER_B)};`, 'duplicate Stripe subscription UPDATE', '23505');
  runSql(`delete from public.profiles where id = ${sqlLiteral(USER_B)};`,
    'remove seeded second profile before service-role CRUD');

  expectSqlFailure(`${rolePrefix('authenticated', USER_A)}
insert into public.trades (id, data, user_id) values ('direct_insert', '{}'::jsonb, ${sqlLiteral(USER_A)});`, 'authenticated direct INSERT');
  expectSqlFailure(`${rolePrefix('authenticated', USER_A)}
update public.trades set data = '{"owner":"tampered"}'::jsonb where id = 'a_trade';`, 'authenticated direct UPDATE');
  expectSqlFailure(`${rolePrefix('authenticated', USER_A)}
delete from public.trades where id = 'a_trade';`, 'authenticated direct DELETE');
  expectSqlFailure(`${rolePrefix('authenticated', USER_A)}
truncate public.trades;`, 'authenticated direct TRUNCATE');
  expectSqlFailure(`set role anon;
select * from public.sync_trade('a_trade', '{}'::jsonb, null, false);`, 'anon RPC execute');
  expectSqlFailure(`set role authenticated;
select * from public.sync_trade('a_trade', '{}'::jsonb, null, false);`, 'unauthenticated RPC call');
  expectSqlFailure(`set role authenticated;
select * from public.apply_stripe_event('evt_client', 'customer.subscription.updated', 1, 'cus_a', 'sub_a', 'pro');`,
    'authenticated billing RPC execute');
  expectSqlFailure(`set role anon;
select * from public.apply_stripe_event('evt_anon', 'customer.subscription.updated', 1, 'cus_a', 'sub_a', 'pro');`,
    'anon billing RPC execute');
  expectSqlStateFailure(`${rolePrefix('service_role')}
select * from public.apply_stripe_event('evt_checkout', 'checkout.session.completed', 1, 'cus_a', 'sub_a', 'pro');`,
    'checkout event cannot grant through billing RPC', '22023');
  expectSqlFailure(`${rolePrefix('authenticated', USER_A)}
insert into public.stripe_webhook_events
  (event_id, event_type, customer_id, subscription_id, event_created, plan)
values ('evt_client_write', 'customer.subscription.updated', 'cus_a', 'sub_a', 1, 'pro');`,
    'authenticated direct event ledger INSERT');

  runSql(`${rolePrefix('service_role')}
insert into public.profiles (id, plan, stripe_customer_id)
values (${sqlLiteral(USER_B)}, 'free', 'cus_database_test');
update public.profiles set plan = 'pro' where id = ${sqlLiteral(USER_B)};
do $$
declare v_plan text;
begin
  select plan into v_plan from public.profiles where id = ${sqlLiteral(USER_B)};
  if v_plan is distinct from 'pro' then raise exception 'service role profile update failed'; end if;
end $$;
delete from public.profiles where id = ${sqlLiteral(USER_B)};`, 'service-role profile CRUD');

  runSql('update public.test_barrier set ready = 0 where id = 1;', 'reset billing barrier');
  const billingResults = await Promise.all([
    spawnSql(billingWriterSql('evt_concurrent_a', 200, 'pro'), 'billing writer A'),
    spawnSql(billingWriterSql('evt_concurrent_b', 200, 'free'), 'billing writer B'),
  ]);
  const billingRows = billingResults.map((result, index) => billingResult(result, `billing writer ${index + 1}`));
  assert(billingRows.filter(value => value === 'true,false,1,applied').length === 1,
    `concurrent billing did not apply exactly one event: ${billingRows.join(' | ')}`);
  assert(billingRows.filter(value => value === 'false,false,1,ambiguous event ordering').length === 1,
    `concurrent billing did not reject the equal-time event: ${billingRows.join(' | ')}`);

  const appliedBilling = runSql(`${rolePrefix('service_role')}
select applied::text || ',' || duplicate::text || ',' || matched::text || ',' || reason
  from public.apply_stripe_event('evt_after_concurrent', 'customer.subscription.updated', 201, 'cus_a', 'sub_a', 'pro');`,
    'apply later billing event').stdout.trim();
  assert(appliedBilling === 'true,false,1,applied', `later billing event was not applied: ${appliedBilling}`);
  const duplicateBilling = runSql(`${rolePrefix('service_role')}
select applied::text || ',' || duplicate::text || ',' || matched::text || ',' || reason
  from public.apply_stripe_event('evt_after_concurrent', 'customer.subscription.updated', 201, 'cus_a', 'sub_a', 'pro');`,
    'replay billing event').stdout.trim();
  assert(duplicateBilling === 'false,true,1,duplicate', `duplicate billing event was not idempotent: ${duplicateBilling}`);
  const staleBilling = runSql(`${rolePrefix('service_role')}
select applied::text || ',' || duplicate::text || ',' || matched::text || ',' || reason
  from public.apply_stripe_event('evt_stale', 'customer.subscription.updated', 199, 'cus_a', 'sub_a', 'free');`,
    'reject stale billing event').stdout.trim();
  assert(staleBilling === 'false,false,1,stale event', `stale billing event was not fenced: ${staleBilling}`);
  const staleReplay = runSql(`${rolePrefix('service_role')}
select applied::text || ',' || duplicate::text || ',' || matched::text || ',' || reason
  from public.apply_stripe_event('evt_stale', 'customer.subscription.updated', 199, 'cus_a', 'sub_a', 'free');`,
    'replay stale billing event').stdout.trim();
  assert(staleReplay === 'false,true,1,duplicate', `stale event ledger replay was not idempotent: ${staleReplay}`);
  const ambiguousBilling = runSql(`${rolePrefix('service_role')}
select applied::text || ',' || duplicate::text || ',' || matched::text || ',' || reason
  from public.apply_stripe_event('evt_ambiguous', 'customer.subscription.updated', 201, 'cus_a', 'sub_a', 'free');`,
    'reject ambiguous billing event').stdout.trim();
  assert(ambiguousBilling === 'false,false,1,ambiguous event ordering',
    `ambiguous billing event was not fenced: ${ambiguousBilling}`);
  const missingCustomer = runSql(`${rolePrefix('service_role')}
select applied::text || ',' || duplicate::text || ',' || matched::text || ',' || reason
  from public.apply_stripe_event('evt_missing_customer', 'customer.subscription.updated', 202, 'cus_missing', 'sub_missing', 'pro');`,
    'reject unlinked billing customer').stdout.trim();
  assert(missingCustomer === 'false,false,0,customer attribution failed',
    `missing billing customer was not rejected: ${missingCustomer}`);
  const wrongSubscription = runSql(`${rolePrefix('service_role')}
select applied::text || ',' || duplicate::text || ',' || matched::text || ',' || reason
  from public.apply_stripe_event('evt_wrong_subscription', 'customer.subscription.updated', 202, 'cus_a', 'sub_other', 'pro');`,
    'reject mismatched billing subscription').stdout.trim();
  assert(wrongSubscription === 'false,false,1,subscription attribution failed',
    `mismatched billing subscription was not rejected: ${wrongSubscription}`);
  expectSqlStateFailure(`${rolePrefix('service_role')}
select * from public.apply_stripe_event('evt_after_concurrent', 'customer.subscription.updated', 202, 'cus_a', 'sub_a', 'free');`,
    'reuse Stripe event ID with changed data', '22023');
  assert(runSql(`select plan from public.profiles where id = ${sqlLiteral(USER_A)};`,
    'check billing plan').stdout.trim() === 'pro', 'billing fence changed the plan after rejected events');

  runSql(`${rolePrefix('service_role')}
update public.profiles
   set stripe_subscription_id = 'sub_b'
 where id = ${sqlLiteral(USER_A)};`, 'switch server binding without fence reset');
  const newSubscriptionEarlier = runSql(`${rolePrefix('service_role')}
select applied::text || ',' || duplicate::text || ',' || matched::text || ',' || reason
  from public.apply_stripe_event('evt_new_sub_earlier', 'customer.subscription.updated', 199, 'cus_a', 'sub_b', 'free');`,
    'reject new subscription earlier event until trusted reset').stdout.trim();
  assert(newSubscriptionEarlier === 'false,false,1,billing subscription fence mismatch',
    `new subscription inherited the old timestamp fence: ${newSubscriptionEarlier}`);
  const newSubscriptionReplay = runSql(`${rolePrefix('service_role')}
select applied::text || ',' || duplicate::text || ',' || matched::text || ',' || reason
  from public.apply_stripe_event('evt_new_sub_earlier', 'customer.subscription.updated', 199, 'cus_a', 'sub_b', 'free');`,
    'replay rejected new subscription event').stdout.trim();
  assert(newSubscriptionReplay === newSubscriptionEarlier,
    `rejected new subscription replay changed result: ${newSubscriptionReplay}`);
  const newSubscriptionEqual = runSql(`${rolePrefix('service_role')}
select applied::text || ',' || duplicate::text || ',' || matched::text || ',' || reason
  from public.apply_stripe_event('evt_new_sub_equal', 'customer.subscription.updated', 201, 'cus_a', 'sub_b', 'free');`,
    'reject new subscription equal-time event until trusted reset').stdout.trim();
  assert(newSubscriptionEqual === 'false,false,1,billing subscription fence mismatch',
    `new subscription equal-time event bypassed the binding fence: ${newSubscriptionEqual}`);
  const lateOldCancellation = runSql(`${rolePrefix('service_role')}
select applied::text || ',' || duplicate::text || ',' || matched::text || ',' || reason
  from public.apply_stripe_event('evt_old_sub_late_cancel', 'customer.subscription.deleted', 999, 'cus_a', 'sub_a', 'free');`,
    'reject late old subscription cancellation').stdout.trim();
  assert(lateOldCancellation === 'false,false,1,subscription attribution failed',
    `late old subscription cancellation was accepted: ${lateOldCancellation}`);
  const oldSubscriptionReplay = runSql(`${rolePrefix('service_role')}
select applied::text || ',' || duplicate::text || ',' || matched::text || ',' || reason
  from public.apply_stripe_event('evt_after_concurrent', 'customer.subscription.updated', 201, 'cus_a', 'sub_a', 'pro');`,
    'replay already-recorded old subscription event').stdout.trim();
  assert(oldSubscriptionReplay === 'false,true,1,duplicate',
    `old subscription replay was not idempotent: ${oldSubscriptionReplay}`);
  assert(runSql(`select count(*)::text from public.stripe_webhook_events
 where event_id in ('evt_new_sub_earlier', 'evt_new_sub_equal', 'evt_old_sub_late_cancel');`,
    'check rejected binding events were not consumed').stdout.trim() === '0',
    'rejected binding transition events were written to the ledger');

  runSql(`${rolePrefix('service_role')}
do $$
declare first_ts timestamptz; second_ts timestamptz;
begin
  update public.trades set data = jsonb_build_object('value', 'clock-one')
   where id = 'clock_trade' returning updated_at into first_ts;
  update public.trades set data = jsonb_build_object('value', 'clock-two')
   where id = 'clock_trade' returning updated_at into second_ts;
  if first_ts is null or second_ts is null or second_ts <= first_ts then
    raise exception 'updated_at did not advance within one transaction';
  end if;
end $$;`, 'same-transaction server timestamps');

  runSql(`${rolePrefix('authenticated', USER_A)}
do $$
declare first_ts timestamptz; second_ts timestamptz; r record;
begin
  select updated_at into first_ts from public.trades where id = 'stale_trade';
  select * into r from public.sync_trade('stale_trade', jsonb_build_object('value', 'first'), first_ts, false);
  if r.applied is distinct from true then raise exception 'legitimate update was rejected'; end if;
  second_ts := r.server_updated_at;
  if first_ts is null or second_ts is null or second_ts <= first_ts then
    raise exception 'server timestamp did not advance';
  end if;

  select * into r from public.sync_trade('stale_trade', jsonb_build_object('value', 'stale'), first_ts, false);
  if r.applied is distinct from false or r.row_data->>'value' is distinct from 'first' then raise exception 'stale save was applied'; end if;
  select * into r from public.sync_trade('stale_trade', jsonb_build_object('value', 'stale'), first_ts, true);
  if r.applied is distinct from false or r.server_deleted_at is not null then raise exception 'stale delete was applied'; end if;

  select * into r from public.sync_trade('stale_trade', '{}'::jsonb, second_ts, true);
  if r.applied is distinct from true or r.row_data->>'value' is distinct from 'first' or r.server_deleted_at is null then raise exception 'tombstone delete failed'; end if;
  select * into r from public.sync_trade('stale_trade', jsonb_build_object('value', 'resurrect'), null, false);
  if r.applied is distinct from false or r.row_data->>'value' is distinct from 'first' or r.server_deleted_at is null then raise exception 'null-token save resurrected tombstone'; end if;
end $$;`, 'CAS stale and tombstone contract');

  const casToken = runSql("select updated_at::text from public.trades where id = 'cas_trade';", 'read CAS token').stdout.trim();
  assert(casToken, 'CAS token query returned no value');
  runSql('update public.test_barrier set ready = 0 where id = 1;', 'reset CAS barrier');
  const casResults = await Promise.all([
    spawnSql(writerSql(USER_A, 'writer_a', 'cas_trade', `${sqlLiteral(casToken)}::timestamptz`), 'CAS writer A'),
    spawnSql(writerSql(USER_A, 'writer_b', 'cas_trade', `${sqlLiteral(casToken)}::timestamptz`), 'CAS writer B'),
  ]);
  const casApplied = casResults.map((result, index) => onlyResult(result, `CAS writer ${index + 1}`));
  assert(casApplied.filter(value => value === 'true').length === 1 && casApplied.filter(value => value === 'false').length === 1,
    `two-writer CAS result was ${casApplied.join(',')}`);
  const casWinnerIndex = casApplied.findIndex(value => value === 'true');
  const casWriters = ['writer_a', 'writer_b'];
  const casOwner = runSql("select data->>'writer' from public.trades where id = 'cas_trade';", 'check CAS winner').stdout.trim();
  assert(casOwner === casWriters[casWinnerIndex],
    `CAS row payload ${casOwner} did not match applied writer ${casWriters[casWinnerIndex]}`);

  runSql('update public.test_barrier set ready = 0 where id = 1;', 'reset create barrier');
  const createResults = await Promise.all([
    spawnSql(writerSql(USER_A, 'create_a', 'create_race', 'null'), 'create writer A'),
    spawnSql(writerSql(USER_A, 'create_b', 'create_race', 'null'), 'create writer B'),
  ]);
  const createApplied = createResults.map((result, index) => onlyResult(result, `create writer ${index + 1}`));
  assert(createApplied.filter(value => value === 'true').length === 1 && createApplied.filter(value => value === 'false').length === 1,
    `concurrent create result was ${createApplied.join(',')}`);
  const createWinnerIndex = createApplied.findIndex(value => value === 'true');
  const createWriters = ['create_a', 'create_b'];
  const createOwner = runSql("select data->>'writer' from public.trades where id = 'create_race';", 'check create winner').stdout.trim();
  assert(createOwner === createWriters[createWinnerIndex],
    `create row payload ${createOwner} did not match applied writer ${createWriters[createWinnerIndex]}`);
  assert(runSql("select count(*)::text from public.trades where id = 'create_race';", 'check create race').stdout.trim() === '1',
    'concurrent create produced more than one row');

  assert(runSql(`${rolePrefix('authenticated', USER_A)}
select applied::text from public.sync_trade('shared_id', jsonb_build_object('owner', 'a'), null, false);`,
    'user A creates shared trade ID').stdout.trim() === 'true',
    'user A could not create its namespaced trade ID');
  assert(runSql(`${rolePrefix('authenticated', USER_B)}
select applied::text from public.sync_trade('shared_id', jsonb_build_object('owner', 'b'), null, false);`,
    'user B creates shared trade ID').stdout.trim() === 'true',
    'user B could not create the same namespaced trade ID');
  assert(runSql("select count(*)::text from public.trades where id = 'shared_id';",
    'check shared trade ID rows').stdout.trim() === '2',
    'owner-scoped trade IDs did not coexist');
  assert(runSql(`${rolePrefix('authenticated', USER_A)}
select data->>'owner' from public.trades where id = 'shared_id';`,
    'user A shared trade isolation').stdout.trim() === 'a',
    'user A could not read its shared trade row');
  assert(runSql(`${rolePrefix('authenticated', USER_B)}
select data->>'owner' from public.trades where id = 'shared_id';`,
    'user B shared trade isolation').stdout.trim() === 'b',
    'user B could not read its shared trade row');

runSql(`${rolePrefix('authenticated', USER_B)}
do $$
declare r record;
begin
  select * into r from public.sync_trade('a_trade', jsonb_build_object('owner', 'b-guess'), null, false);
  if r.applied is distinct from true or r.row_id is distinct from 'a_trade'
     or r.row_data->>'owner' is distinct from 'b-guess'
     or r.server_updated_at is null or r.server_deleted_at is not null then
    raise exception 'owner-scoped guessed ID did not create only the caller row';
  end if;
end $$;`, 'cross-user guessed ID');
  assert(runSql("select count(*)::text from public.trades where id = 'a_trade';", 'verify cross-user ID rows').stdout.trim() === '2',
    'owner-scoped guessed ID did not coexist with the existing row');
  assert(runSql(`select data->>'owner' from public.trades where id = 'a_trade' and user_id = ${sqlLiteral(USER_A)};`, 'verify cross-user target').stdout.trim() === 'a',
    'cross-user guessed ID changed the existing owner row');

  if (!cleanup()) throw new Error('temporary PostgreSQL cluster cleanup was not verified');
  console.log('PASS: genuine PostgreSQL schema, grants, RLS, CAS, tombstone and concurrency contracts');
}

process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });
process.on('SIGTERM', () => { cleanup(); process.exit(143); });

main().catch(error => {
  console.error(`FAIL: ${error.message}`);
  process.exitCode = 1;
});
