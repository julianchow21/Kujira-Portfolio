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
const USER_D = '00000000-0000-0000-0000-00000000000d';
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
insert into auth.users (id) values (${sqlLiteral(USER_D)});
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
insert into public.trades (id, data, user_id) values
  ('a_trade', '{"owner":"a"}'::jsonb, ${sqlLiteral(USER_A)}),
  ('b_trade', '{"owner":"b"}'::jsonb, ${sqlLiteral(USER_B)}),
  ('stale_trade', '{"value":"initial"}'::jsonb, ${sqlLiteral(USER_A)}),
  ('clock_trade', '{"value":"initial"}'::jsonb, ${sqlLiteral(USER_A)}),
  ('cas_trade', '{"writer":"initial"}'::jsonb, ${sqlLiteral(USER_A)});
insert into public.trades (id, data, user_id)
select 'cap_' || g::text, jsonb_build_object('n', g), ${sqlLiteral(USER_C)}
  from generate_series(1, 49) as g;
create table public.test_barrier (id integer primary key, ready integer not null default 0);
insert into public.test_barrier (id) values (1);
`, 'seed synthetic rows');

const bootstrapProfiles = runSql(`
select count(*)::text from public.profiles
 where id in (${sqlLiteral(USER_A)}, ${sqlLiteral(USER_B)}, ${sqlLiteral(USER_C)})
   and plan = 'free';`, 'profile bootstrap').stdout.trim();
assert(bootstrapProfiles === '3', `auth profile bootstrap did not create three free profiles: ${bootstrapProfiles}`);
const preExistingProfile = runSql(`
select plan || '|' || coalesce(stripe_customer_id, 'null') || '|' ||
       coalesce(stripe_subscription_id, 'null')
  from public.profiles where id = ${sqlLiteral(USER_D)};`,
  'pre-existing auth profile backfill').stdout.trim();
assert(preExistingProfile === 'free|null|null',
  `pre-existing auth user was not bootstrapped safely: ${preExistingProfile}`);

const accountStateA = runSql(`${rolePrefix('authenticated', USER_A)}
select plan || '|' || trade_count::text || '|' || coalesce(trade_cap::text, 'null') || '|' ||
       (entitlements->>'simulator') || '|' || (entitlements->>'csv_import')
  from public.get_account_state();`, 'free account state').stdout.trim();
assert(accountStateA === 'free|4|50|false|false', `unexpected free account state: ${accountStateA}`);
const accountStateC = runSql(`${rolePrefix('authenticated', USER_C)}
select plan || '|' || trade_count::text || '|' || coalesce(trade_cap::text, 'null')
  from public.get_account_state();`, 'cap account state').stdout.trim();
assert(accountStateC === 'free|49|50', `unexpected cap account state: ${accountStateC}`);
const freeFeature = runSql(`${rolePrefix('authenticated', USER_A)}
select allowed::text || ',' || feature || ',' || plan || ',' || reason
  from public.authorise_feature('simulator');`, 'free feature denial').stdout.trim();
assert(freeFeature === 'false,simulator,free,feature_requires_pro', `free feature denial was not explicit: ${freeFeature}`);
const unknownFeature = runSql(`${rolePrefix('authenticated', USER_A)}
select allowed::text || ',' || coalesce(feature, 'null') || ',' || plan || ',' || reason
  from public.authorise_feature('not_declared');`, 'unknown feature denial').stdout.trim();
assert(unknownFeature === 'false,not_declared,free,unknown_feature', `unknown feature denial was not explicit: ${unknownFeature}`);

runSql('update public.test_barrier set ready = 0 where id = 1;', 'reset free-cap barrier');
const capRaceResults = await Promise.all([
  spawnSql(writerSql(USER_C, 'cap_writer_a', 'cap_race', 'null'), 'free-cap writer A'),
  spawnSql(writerSql(USER_C, 'cap_writer_b', 'cap_race', 'null'), 'free-cap writer B'),
]);
const capRaceApplied = capRaceResults.map((result, index) => onlyResult(result, `free-cap writer ${index + 1}`));
assert(capRaceApplied.filter(value => value === 'true').length === 1
    && capRaceApplied.filter(value => value === 'false').length === 1,
  `free-cap race result was ${capRaceApplied.join(',')}`);
assert(runSql(`${rolePrefix('service_role')}
select count(*)::text from public.trades where user_id = ${sqlLiteral(USER_C)} and deleted_at is null;`,
  'check free cap after race').stdout.trim() === '50', 'free-cap race exceeded 50 live rows');

const capDenied = expectSqlStateFailure(`${rolePrefix('authenticated', USER_C)}
select * from public.sync_trade('cap_over', '{"n":51}'::jsonb, null, false);`,
  'free create at cap', 'P0001');
assert(/free_trade_cap/.test(`${capDenied.stderr}\n${capDenied.stdout}`), 'free-cap error was not distinct');
const capEdit = runSql(`${rolePrefix('authenticated', USER_C)}
select applied::text from public.sync_trade('cap_1', '{"n":"edited"}'::jsonb,
  (select updated_at from public.trades where user_id = ${sqlLiteral(USER_C)} and id = 'cap_1'), false);`,
  'free edit at cap').stdout.trim();
assert(capEdit === 'true', `free live-row edit at cap failed: ${capEdit}`);
const capDelete = runSql(`${rolePrefix('authenticated', USER_C)}
select applied::text from public.sync_trade('cap_1', null,
  (select updated_at from public.trades where user_id = ${sqlLiteral(USER_C)} and id = 'cap_1'), true);`,
  'free delete at cap').stdout.trim();
assert(capDelete === 'true', `free delete at cap failed: ${capDelete}`);
assert(runSql(`${rolePrefix('authenticated', USER_C)}
select count(*)::text from public.trades where deleted_at is null;`,
  'count after free delete').stdout.trim() === '49', 'free delete did not reduce live count');
const capReplacement = runSql(`${rolePrefix('authenticated', USER_C)}
select applied::text from public.sync_trade('cap_replacement', '{"n":"replacement"}'::jsonb, null, false);`,
  'free create after delete').stdout.trim();
assert(capReplacement === 'true', `free create after delete failed: ${capReplacement}`);
const restoreDenied = expectSqlStateFailure(`${rolePrefix('authenticated', USER_C)}
select * from public.sync_trade('cap_1', '{"n":"restored"}'::jsonb,
  (select updated_at from public.trades where user_id = ${sqlLiteral(USER_C)} and id = 'cap_1'), false);`,
  'free restore at cap', 'P0001');
assert(/free_trade_cap/.test(`${restoreDenied.stderr}\n${restoreDenied.stdout}`), 'free restore error was not distinct');

const bindC = runSql(`${rolePrefix('service_role')}
select bound::text || ',' || duplicate::text || ',' || matched::text || ',' || reason
  from public.bind_stripe_customer(${sqlLiteral(USER_C)}, 'cus_c');`,
  'bind synthetic pro customer').stdout.trim();
assert(bindC === 'true,false,1,bound', `synthetic pro customer binding failed: ${bindC}`);
const beginC = runSql(`${rolePrefix('service_role')}
select accepted::text || ',' || existing::text || ',' || intent_id || ',' || status || ',' || reason
  from public.begin_stripe_checkout(${sqlLiteral(USER_C)}, 'intent_c', 'idem_c');`,
  'begin synthetic checkout').stdout.trim();
assert(beginC === 'true,false,intent_c,pending,started', `synthetic checkout reservation failed: ${beginC}`);
const recordC = runSql(`${rolePrefix('service_role')}
select recorded::text || ',' || duplicate::text || ',' || reason
  from public.record_stripe_checkout('intent_c', 'cs_c', 'cus_c');`,
  'record synthetic checkout').stdout.trim();
assert(recordC === 'true,false,recorded', `synthetic checkout recording failed: ${recordC}`);
const completeC = runSql(`${rolePrefix('service_role')}
select applied::text || ',' || duplicate::text || ',' || matched::text || ',' || reason
  from public.complete_stripe_checkout('evt_checkout_c', 100, 'cus_c', 'sub_c', 'cs_c');`,
  'complete synthetic checkout').stdout.trim();
assert(completeC === 'true,false,1,applied', `synthetic checkout completion failed: ${completeC}`);
const proCreate = runSql(`${rolePrefix('authenticated', USER_C)}
select applied::text from public.sync_trade('pro_trade', '{"plan":"pro"}'::jsonb, null, false);`,
  'pro create beyond cap').stdout.trim();
assert(proCreate === 'true', `pro create beyond cap failed: ${proCreate}`);
const proState = runSql(`${rolePrefix('authenticated', USER_C)}
select plan || '|' || trade_count::text || '|' || coalesce(trade_cap::text, 'null') || '|' ||
       (entitlements->>'csv_import')
  from public.get_account_state();`, 'pro account state').stdout.trim();
assert(proState === 'pro|51|null|true', `unexpected pro account state: ${proState}`);
const proFeature = runSql(`${rolePrefix('authenticated', USER_C)}
select allowed::text || ',' || reason from public.authorise_feature('csv_import');`,
  'pro feature authorisation').stdout.trim();
assert(proFeature === 'true,allowed', `pro feature authorisation failed: ${proFeature}`);
const proImport = runSql(`${rolePrefix('authenticated', USER_C)}
select imported::text || ',' || skipped_existing::text || ',' || reason
  from public.import_trades('[
    {"id":"pro_trade","data":{"symbol":"EURUSD"}},
    {"id":"pro_import","data":{"symbol":"GBPUSD"}}
  ]'::jsonb);`, 'pro import with existing row').stdout.trim();
assert(proImport === '1,1,applied', `pro import semantics were unsafe: ${proImport}`);
expectSqlStateFailure(`${rolePrefix('authenticated', USER_C)}
select * from public.import_trades('[{"id":"atomic_good","data":{"symbol":"USDJPY"}},
  {"id":"atomic_bad","data":[]}]'::jsonb);`,
  'atomic import validation', '22023');
assert(runSql(`select count(*)::text from public.trades
 where user_id = ${sqlLiteral(USER_C)} and id = 'atomic_good';`,
  'atomic import rollback').stdout.trim() === '0',
  'invalid import partially committed a preceding row');

const freeImport = runSql(`${rolePrefix('authenticated', USER_B)}
select imported::text || ',' || skipped_existing::text || ',' || reason
  from public.import_trades('[{"id":"free_import","data":{"symbol":"EURUSD"}}]'::jsonb);`,
  'free import denial').stdout.trim();
assert(freeImport === '0,0,feature_requires_pro', `free import was not denied: ${freeImport}`);

const cancelC = runSql(`${rolePrefix('service_role')}
select applied::text || ',' || duplicate::text || ',' || matched::text || ',' || reason
  from public.apply_stripe_event('evt_cancel_c', 'customer.subscription.deleted', 150,
    'cus_c', 'sub_c', 'free');`, 'record synthetic cancellation').stdout.trim();
assert(cancelC === 'true,false,1,applied', `synthetic cancellation was not applied: ${cancelC}`);
const beginC2 = runSql(`${rolePrefix('service_role')}
select accepted::text || ',' || existing::text || ',' || intent_id || ',' || status || ',' || reason
  from public.begin_stripe_checkout(${sqlLiteral(USER_C)}, 'intent_c2', 'idem_c2');`,
  'begin replacement checkout').stdout.trim();
assert(beginC2 === 'true,false,intent_c2,pending,started', `replacement checkout was blocked: ${beginC2}`);
runSql(`${rolePrefix('service_role')}
select recorded::text from public.record_stripe_checkout('intent_c2', 'cs_c2', 'cus_c');`,
  'record replacement checkout');
const completeC2 = runSql(`${rolePrefix('service_role')}
select applied::text || ',' || duplicate::text || ',' || matched::text || ',' || reason
  from public.complete_stripe_checkout('evt_checkout_c2', 151, 'cus_c', 'sub_c2', 'cs_c2');`,
  'complete replacement checkout').stdout.trim();
assert(completeC2 === 'true,false,1,applied', `replacement checkout completion failed: ${completeC2}`);
const pastDueC = runSql(`${rolePrefix('service_role')}
select applied::text || ',' || duplicate::text || ',' || matched::text || ',' || reason
  from public.apply_stripe_event('evt_past_due_c', 'customer.subscription.updated', 160,
    'cus_c', 'sub_c2', 'free');`, 'record past-due subscription').stdout.trim();
assert(pastDueC === 'true,false,1,applied', `past-due subscription event was not applied: ${pastDueC}`);
const activeCCheckout = runSql(`${rolePrefix('service_role')}
select accepted::text || ',' || existing::text || ',' || coalesce(reason, 'null')
  from public.begin_stripe_checkout(${sqlLiteral(USER_C)}, 'intent_c3', 'idem_c3');`,
  'reject checkout with active past-due subscription').stdout.trim();
assert(activeCCheckout === 'false,false,active subscription must be cancelled',
  `past-due subscription was incorrectly treated as cancelled: ${activeCCheckout}`);
const cancelC2 = runSql(`${rolePrefix('service_role')}
select applied::text || ',' || duplicate::text || ',' || matched::text || ',' || reason
  from public.apply_stripe_event('evt_cancel_c2', 'customer.subscription.deleted', 170,
    'cus_c', 'sub_c2', 'free');`, 'record replacement cancellation').stdout.trim();
assert(cancelC2 === 'true,false,1,applied', `replacement cancellation was not applied: ${cancelC2}`);
const deletedPro = expectSqlStateFailure(`${rolePrefix('service_role')}
select * from public.apply_stripe_event('evt_bad_deleted_plan', 'customer.subscription.deleted', 171,
  'cus_c', 'sub_c2', 'pro');`, 'reject deleted event granting pro', '22023');
assert(/Deleted subscription event cannot grant pro/.test(`${deletedPro.stderr}\n${deletedPro.stdout}`),
  'deleted subscription event accepted a pro plan');
const lateSameSubscription = runSql(`${rolePrefix('service_role')}
select applied::text || ',' || duplicate::text || ',' || matched::text || ',' || reason
  from public.apply_stripe_event('evt_late_update_c2', 'customer.subscription.updated', 180,
    'cus_c', 'sub_c2', 'pro');`, 'reject late same-subscription reactivation').stdout.trim();
assert(lateSameSubscription === 'false,false,1,subscription permanently fenced',
  `deleted subscription was reactivated by a later update: ${lateSameSubscription}`);
const beginC3 = runSql(`${rolePrefix('service_role')}
select accepted::text || ',' || existing::text || ',' || intent_id || ',' || status || ',' || reason
  from public.begin_stripe_checkout(${sqlLiteral(USER_C)}, 'intent_c3', 'idem_c3');`,
  'begin post-cancellation checkout').stdout.trim();
assert(beginC3 === 'true,false,intent_c3,pending,started', `post-cancellation checkout was blocked: ${beginC3}`);
const beginC3Again = runSql(`${rolePrefix('service_role')}
select accepted::text || ',' || existing::text || ',' || intent_id || ',' || status || ',' || reason
  from public.begin_stripe_checkout(${sqlLiteral(USER_C)}, 'intent_c3_other', 'idem_c3_other');`,
  'reuse active checkout reservation').stdout.trim();
assert(beginC3Again === 'true,true,intent_c3,pending,existing checkout',
  `concurrent checkout reservation was not reused: ${beginC3Again}`);
const expireC3 = runSql(`${rolePrefix('service_role')}
select expired::text || ',' || duplicate::text || ',' || reason
  from public.expire_stripe_checkout('intent_c3', null, 'cus_c');`,
  'release failed checkout reservation').stdout.trim();
assert(expireC3 === 'true,false,expired', `checkout reservation release failed: ${expireC3}`);

  assert(runSql(`select count(*)::text from public.profiles where id = ${sqlLiteral(USER_B)};`,
    'admin profile seed visibility').stdout.trim() === '1',
    'admin could not see seeded second profile');

  const bindA = runSql(`${rolePrefix('service_role')}
select bound::text || ',' || duplicate::text || ',' || matched::text || ',' || reason
  from public.bind_stripe_customer(${sqlLiteral(USER_A)}, 'cus_a');`,
    'bind primary Stripe customer').stdout.trim();
  assert(bindA === 'true,false,1,bound', `primary Stripe customer binding failed: ${bindA}`);
  const bindARepeat = runSql(`${rolePrefix('service_role')}
select bound::text || ',' || duplicate::text || ',' || matched::text || ',' || reason
  from public.bind_stripe_customer(${sqlLiteral(USER_A)}, 'cus_a');`,
    'repeat primary Stripe customer binding').stdout.trim();
  assert(bindARepeat === 'true,true,1,already bound', `repeat customer binding was not idempotent: ${bindARepeat}`);
  const bindAMismatch = runSql(`${rolePrefix('service_role')}
select bound::text || ',' || duplicate::text || ',' || matched::text || ',' || reason
  from public.bind_stripe_customer(${sqlLiteral(USER_A)}, 'cus_other');`,
    'reject primary customer rebinding').stdout.trim();
  assert(bindAMismatch === 'false,false,1,profile already bound to another customer',
    `customer rebinding fence failed: ${bindAMismatch}`);
  const bindDToA = runSql(`${rolePrefix('service_role')}
select bound::text || ',' || duplicate::text || ',' || matched::text || ',' || reason
  from public.bind_stripe_customer(${sqlLiteral(USER_D)}, 'cus_a');`,
    'reject duplicate Stripe customer binding').stdout.trim();
  assert(bindDToA === 'false,false,1,customer already bound', `duplicate customer fence failed: ${bindDToA}`);

  const beginA = runSql(`${rolePrefix('service_role')}
select accepted::text || ',' || existing::text || ',' || intent_id || ',' || status || ',' || reason
  from public.begin_stripe_checkout(${sqlLiteral(USER_A)}, 'intent_a', 'idem_a');`,
    'begin primary checkout').stdout.trim();
  assert(beginA === 'true,false,intent_a,pending,started', `primary checkout reservation failed: ${beginA}`);
  const recordA = runSql(`${rolePrefix('service_role')}
select recorded::text || ',' || duplicate::text || ',' || reason
  from public.record_stripe_checkout('intent_a', 'cs_a', 'cus_a');`,
    'record primary checkout').stdout.trim();
  assert(recordA === 'true,false,recorded', `primary checkout recording failed: ${recordA}`);
  const completeA = runSql(`${rolePrefix('service_role')}
select applied::text || ',' || duplicate::text || ',' || matched::text || ',' || reason
  from public.complete_stripe_checkout('evt_checkout_a', 100, 'cus_a', 'sub_a', 'cs_a');`,
    'complete primary checkout').stdout.trim();
  assert(completeA === 'true,false,1,applied', `primary checkout completion failed: ${completeA}`);
  const completeARepeat = runSql(`${rolePrefix('service_role')}
select applied::text || ',' || duplicate::text || ',' || matched::text || ',' || reason
  from public.complete_stripe_checkout('evt_checkout_a', 100, 'cus_a', 'sub_a', 'cs_a');`,
    'replay primary checkout').stdout.trim();
  assert(completeARepeat === 'false,true,1,duplicate', `checkout completion replay was unsafe: ${completeARepeat}`);

  const bindB = runSql(`${rolePrefix('service_role')}
select bound::text || ',' || duplicate::text || ',' || matched::text || ',' || reason
  from public.bind_stripe_customer(${sqlLiteral(USER_B)}, 'cus_b');`,
    'bind second Stripe customer').stdout.trim();
  assert(bindB === 'true,false,1,bound', `second Stripe customer binding failed: ${bindB}`);
  const beginB = runSql(`${rolePrefix('service_role')}
select accepted::text || ',' || existing::text || ',' || intent_id || ',' || status || ',' || reason
  from public.begin_stripe_checkout(${sqlLiteral(USER_B)}, 'intent_b', 'idem_b');`,
    'begin second checkout').stdout.trim();
  assert(beginB === 'true,false,intent_b,pending,started', `second checkout reservation failed: ${beginB}`);
  const recordB = runSql(`${rolePrefix('service_role')}
select recorded::text || ',' || duplicate::text || ',' || reason
  from public.record_stripe_checkout('intent_b', 'cs_b', 'cus_b');`,
    'record second checkout').stdout.trim();
  assert(recordB === 'true,false,recorded', `second checkout recording failed: ${recordB}`);
  const completeB = runSql(`${rolePrefix('service_role')}
select applied::text || ',' || duplicate::text || ',' || matched::text || ',' || reason
  from public.complete_stripe_checkout('evt_checkout_b', 101, 'cus_b', 'sub_b', 'cs_b');`,
    'complete second checkout').stdout.trim();
  assert(completeB === 'true,false,1,applied', `second checkout completion failed: ${completeB}`);

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
select
  has_table_privilege('authenticated', 'public.stripe_checkout_sessions', 'SELECT')::text || ',' ||
  has_table_privilege('authenticated', 'public.stripe_checkout_sessions', 'INSERT')::text || ',' ||
  has_table_privilege('authenticated', 'public.stripe_checkout_sessions', 'UPDATE')::text || ',' ||
  has_table_privilege('authenticated', 'public.stripe_checkout_sessions', 'DELETE')::text || ',' ||
  has_table_privilege('service_role', 'public.stripe_checkout_sessions', 'SELECT')::text || ',' ||
  has_table_privilege('service_role', 'public.stripe_checkout_sessions', 'INSERT')::text || ',' ||
  has_table_privilege('service_role', 'public.stripe_checkout_sessions', 'UPDATE')::text || ',' ||
  has_table_privilege('service_role', 'public.stripe_checkout_sessions', 'DELETE')::text;
`, 'inspect profile and event grants').stdout.trim().split(/\n/);
  assert(profilePrivilegeOutput[0] === 'true,false,false,false,false;false,false,false,false',
    `unexpected profile grants: ${profilePrivilegeOutput[0]}`);
  assert(profilePrivilegeOutput[1] === 'false,false,false,false,false',
    `unexpected event table grants: ${profilePrivilegeOutput[1]}`);
  assert(profilePrivilegeOutput[2] === 'false,false,false,false,false,false,false,false',
    `unexpected checkout table grants: ${profilePrivilegeOutput[2]}`);

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
select
  has_function_privilege('anon', 'public.get_account_state()', 'EXECUTE')::text || ',' ||
  has_function_privilege('authenticated', 'public.get_account_state()', 'EXECUTE')::text || ',' ||
  has_function_privilege('anon', 'public.authorise_feature(text)', 'EXECUTE')::text || ',' ||
  has_function_privilege('authenticated', 'public.authorise_feature(text)', 'EXECUTE')::text || ',' ||
  has_function_privilege('anon', 'public.import_trades(jsonb)', 'EXECUTE')::text || ',' ||
  has_function_privilege('authenticated', 'public.import_trades(jsonb)', 'EXECUTE')::text;
select
  has_function_privilege('authenticated', 'public.bind_stripe_customer(uuid,text)', 'EXECUTE')::text || ',' ||
  has_function_privilege('service_role', 'public.bind_stripe_customer(uuid,text)', 'EXECUTE')::text || ',' ||
  has_function_privilege('authenticated', 'public.begin_stripe_checkout(uuid,text,text)', 'EXECUTE')::text || ',' ||
  has_function_privilege('service_role', 'public.begin_stripe_checkout(uuid,text,text)', 'EXECUTE')::text || ',' ||
  has_function_privilege('authenticated', 'public.record_stripe_checkout(text,text,text)', 'EXECUTE')::text || ',' ||
  has_function_privilege('service_role', 'public.record_stripe_checkout(text,text,text)', 'EXECUTE')::text || ',' ||
  has_function_privilege('authenticated', 'public.expire_stripe_checkout(text,text,text)', 'EXECUTE')::text || ',' ||
  has_function_privilege('service_role', 'public.expire_stripe_checkout(text,text,text)', 'EXECUTE')::text || ',' ||
  has_function_privilege('authenticated', 'public.complete_stripe_checkout(text,bigint,text,text,text)', 'EXECUTE')::text || ',' ||
  has_function_privilege('service_role', 'public.complete_stripe_checkout(text,bigint,text,text,text)', 'EXECUTE')::text;
`, 'inspect billing RPC grants').stdout.trim().split(/\n/);
  assert(billingPrivilegeOutput[0] === 'false,false,true',
    `unexpected billing RPC grants: ${billingPrivilegeOutput[0]}`);
  assert(billingPrivilegeOutput[1] === 'true;postgres;search_path=""',
    `unexpected billing RPC owner/config: ${billingPrivilegeOutput[1]}`);
  assert(billingPrivilegeOutput[2] === 'false,true,false,true,false,true',
    `unexpected account RPC grants: ${billingPrivilegeOutput[2]}`);
  assert(billingPrivilegeOutput[3] === 'false,true,false,true,false,true,false,true,false,true',
    `unexpected checkout RPC grants: ${billingPrivilegeOutput[3]}`);

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
  expectSqlFailure(`${rolePrefix('service_role')}
update public.profiles set plan = 'free' where id = ${sqlLiteral(USER_A)};`,
    'service-role direct profile UPDATE');
  expectSqlFailure(`${rolePrefix('service_role')}
update public.profiles set stripe_customer_id = 'cus_service_tamper' where id = ${sqlLiteral(USER_A)};`,
    'service-role direct binding UPDATE');
  expectSqlFailure(`${rolePrefix('service_role')}
insert into public.profiles (id, plan) values (${sqlLiteral(USER_D)}, 'pro');`,
    'service-role direct profile INSERT');
  expectSqlFailure(`${rolePrefix('service_role')}
delete from public.profiles where id = ${sqlLiteral(USER_D)};`,
    'service-role direct profile DELETE');
  const bindD = runSql(`${rolePrefix('service_role')}
select bound::text || ',' || duplicate::text || ',' || matched::text || ',' || reason
  from public.bind_stripe_customer(${sqlLiteral(USER_D)}, 'cus_d');`,
    'bind duplicate-subscription test customer').stdout.trim();
  assert(bindD === 'true,false,1,bound', `duplicate-subscription customer binding failed: ${bindD}`);
  runSql(`${rolePrefix('service_role')}
select accepted::text from public.begin_stripe_checkout(${sqlLiteral(USER_D)}, 'intent_d', 'idem_d');
select recorded::text from public.record_stripe_checkout('intent_d', 'cs_d', 'cus_d');`,
    'prepare duplicate-subscription checkout');
  expectSqlStateFailure(`${rolePrefix('service_role')}
select * from public.complete_stripe_checkout('evt_checkout_d', 180, 'cus_d', 'sub_b', 'cs_d');`,
    'duplicate Stripe subscription completion', '23505');
  expectSqlStateFailure(`${rolePrefix('service_role')}
select * from public.complete_stripe_checkout('evt_checkout_a_replay', 100, 'cus_a', 'sub_a', 'cs_a');`,
    'completed checkout replay with new event ID', '22023');

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
select * from public.get_account_state();`, 'unauthenticated account state call');
  expectSqlFailure(`set role authenticated;
select * from public.authorise_feature('simulator');`, 'unauthenticated feature call');
  expectSqlFailure(`set role authenticated;
select * from public.import_trades('[]'::jsonb);`, 'unauthenticated import call');
  expectSqlFailure(`${rolePrefix('authenticated', USER_A)}
select * from public.bind_stripe_customer(${sqlLiteral(USER_A)}, 'cus_auth_tamper');`,
    'authenticated customer binding call');
  expectSqlFailure(`${rolePrefix('authenticated', USER_A)}
select * from public.begin_stripe_checkout(${sqlLiteral(USER_A)}, 'intent_auth', 'idem_auth');`,
    'authenticated checkout reservation call');
  expectSqlStateFailure(`${rolePrefix('authenticated', USER_A)}
select * from public.sync_trade('primitive_data', '[]'::jsonb, null, false);`,
    'primitive trade data', '22023');
  expectSqlStateFailure(`${rolePrefix('authenticated', USER_A)}
select * from public.import_trades('[{"id":"primitive_import","data":[]}]'::jsonb);`,
    'primitive import data', '22023');
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

  const newSubscriptionEarlier = runSql(`${rolePrefix('service_role')}
select applied::text || ',' || duplicate::text || ',' || matched::text || ',' || reason
  from public.apply_stripe_event('evt_new_sub_earlier', 'customer.subscription.updated', 199, 'cus_a', 'sub_b', 'free');`,
    'reject unbound new subscription event').stdout.trim();
  assert(newSubscriptionEarlier === 'false,false,1,subscription attribution failed',
    `unbound new subscription was accepted: ${newSubscriptionEarlier}`);
  const newSubscriptionReplay = runSql(`${rolePrefix('service_role')}
select applied::text || ',' || duplicate::text || ',' || matched::text || ',' || reason
  from public.apply_stripe_event('evt_new_sub_earlier', 'customer.subscription.updated', 199, 'cus_a', 'sub_b', 'free');`,
    'replay rejected unbound subscription event').stdout.trim();
  assert(newSubscriptionReplay === newSubscriptionEarlier,
    `rejected new subscription replay changed result: ${newSubscriptionReplay}`);
  const newSubscriptionEqual = runSql(`${rolePrefix('service_role')}
select applied::text || ',' || duplicate::text || ',' || matched::text || ',' || reason
  from public.apply_stripe_event('evt_new_sub_equal', 'customer.subscription.updated', 201, 'cus_a', 'sub_b', 'free');`,
    'reject unbound new subscription equal-time event').stdout.trim();
  assert(newSubscriptionEqual === 'false,false,1,subscription attribution failed',
    `unbound new subscription equal-time event was accepted: ${newSubscriptionEqual}`);
  const lateOldCancellation = runSql(`${rolePrefix('service_role')}
select applied::text || ',' || duplicate::text || ',' || matched::text || ',' || reason
  from public.apply_stripe_event('evt_old_sub_late_cancel', 'customer.subscription.deleted', 999, 'cus_a', 'sub_b', 'free');`,
    'reject late unbound subscription cancellation').stdout.trim();
  assert(lateOldCancellation === 'false,false,1,subscription attribution failed',
    `late unbound subscription cancellation was accepted: ${lateOldCancellation}`);
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

  const pausedBilling = runSql(`${rolePrefix('service_role')}
select applied::text || ',' || duplicate::text || ',' || matched::text || ',' || reason
  from public.apply_stripe_event('evt_paused_a', 'customer.subscription.paused', 202,
    'cus_a', 'sub_a', 'free');`, 'apply paused subscription event').stdout.trim();
  assert(pausedBilling === 'true,false,1,applied',
    `paused subscription event was not applied: ${pausedBilling}`);
  assert(runSql(`select plan from public.profiles where id = ${sqlLiteral(USER_A)};`,
    'check paused billing plan').stdout.trim() === 'free',
    'paused subscription did not remove Pro access');
  expectSqlStateFailure(`${rolePrefix('service_role')}
select * from public.apply_stripe_event('evt_bad_paused_a', 'customer.subscription.paused', 202,
  'cus_a', 'sub_a', 'pro');`, 'reject paused event granting pro', '22023');

  const resumedBilling = runSql(`${rolePrefix('service_role')}
select applied::text || ',' || duplicate::text || ',' || matched::text || ',' || reason
  from public.apply_stripe_event('evt_resumed_a', 'customer.subscription.resumed', 203,
    'cus_a', 'sub_a', 'pro');`, 'apply resumed subscription event').stdout.trim();
  assert(resumedBilling === 'true,false,1,applied',
    `resumed subscription event was not applied: ${resumedBilling}`);
  assert(runSql(`select plan from public.profiles where id = ${sqlLiteral(USER_A)};`,
    'check resumed billing plan').stdout.trim() === 'pro',
    'resumed subscription did not restore Pro access');
  expectSqlStateFailure(`${rolePrefix('service_role')}
select * from public.apply_stripe_event('evt_bad_resumed_a', 'customer.subscription.resumed', 203,
  'cus_a', 'sub_a', 'free');`, 'reject resumed event without pro', '22023');

  const deletedAfterResume = runSql(`${rolePrefix('service_role')}
select applied::text || ',' || duplicate::text || ',' || matched::text || ',' || reason
  from public.apply_stripe_event('evt_deleted_after_resume_a', 'customer.subscription.deleted', 204,
    'cus_a', 'sub_a', 'free');`, 'apply deleted subscription event after resume').stdout.trim();
  assert(deletedAfterResume === 'true,false,1,applied',
    `deleted subscription event after resume was not applied: ${deletedAfterResume}`);
  const resumedAfterDelete = runSql(`${rolePrefix('service_role')}
select applied::text || ',' || duplicate::text || ',' || matched::text || ',' || reason
  from public.apply_stripe_event('evt_resumed_after_delete_a', 'customer.subscription.resumed', 205,
    'cus_a', 'sub_a', 'pro');`, 'reject resumed event after deletion').stdout.trim();
  assert(resumedAfterDelete === 'false,false,1,subscription permanently fenced',
    `deleted subscription was reactivated by a later resumed event: ${resumedAfterDelete}`);

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

  // Exercise the migration path separately from the fresh-schema reapply. An
  // empty legacy table can be completed safely, while an existing incomplete
  // row must abort instead of fabricating billing attribution.
  const legacyTablePrefix = `
alter table public.stripe_checkout_sessions rename to stripe_checkout_sessions_saved;
alter index public.stripe_checkout_sessions_pkey rename to stripe_checkout_sessions_saved_pkey;
alter index public.stripe_checkout_sessions_session_uidx rename to stripe_checkout_sessions_saved_session_uidx;
alter index public.stripe_checkout_sessions_idempotency_uidx rename to stripe_checkout_sessions_saved_idempotency_uidx;
alter index public.stripe_checkout_sessions_active_user_uidx rename to stripe_checkout_sessions_saved_active_user_uidx;
create table public.stripe_checkout_sessions (intent_id text);
`;
  const legacyShapePath = path.join(tempRoot, 'legacy-shape.sql');
  fs.writeFileSync(legacyShapePath, `${legacyTablePrefix}
${schema}
select count(*)::text from information_schema.columns
 where table_schema = 'public' and table_name = 'stripe_checkout_sessions';
select count(*)::text from information_schema.columns
 where table_schema = 'public' and table_name = 'stripe_checkout_sessions' and is_nullable = 'NO';
select
  (select count(*) from pg_catalog.pg_constraint where conrelid = 'public.stripe_checkout_sessions'::regclass and contype = 'p')::text || ',' ||
  (select count(*) from pg_catalog.pg_constraint where conrelid = 'public.stripe_checkout_sessions'::regclass and contype = 'f' and confrelid = 'public.profiles'::regclass)::text || ',' ||
  (select count(*) from pg_catalog.pg_constraint where conrelid = 'public.stripe_checkout_sessions'::regclass and conname = 'stripe_checkout_sessions_status_ck')::text;
`, 'utf8');
  const legacyShape = spawnSync(binaries.psql, psqlArgs(['-f', legacyShapePath]), {
    cwd: REPO_ROOT,
    env: processEnvironment(),
    encoding: 'utf8',
    maxBuffer: 2 * 1024 * 1024,
  });
  assert(legacyShape.status === 0,
    `empty legacy checkout table did not upgrade: ${(legacyShape.stderr || legacyShape.stdout).slice(-2000)}`);
  const legacyShapeOutput = legacyShape.stdout.trim().split(/\n/).slice(-3);
  assert(legacyShapeOutput.join(',') === '9,6,1,1,1',
    `legacy checkout table shape was incomplete: ${legacyShapeOutput.join(',')}`);
  runSql(`
drop table public.stripe_checkout_sessions;
alter table public.stripe_checkout_sessions_saved rename to stripe_checkout_sessions;
alter index public.stripe_checkout_sessions_saved_pkey rename to stripe_checkout_sessions_pkey;
alter index public.stripe_checkout_sessions_saved_session_uidx rename to stripe_checkout_sessions_session_uidx;
alter index public.stripe_checkout_sessions_saved_idempotency_uidx rename to stripe_checkout_sessions_idempotency_uidx;
alter index public.stripe_checkout_sessions_saved_active_user_uidx rename to stripe_checkout_sessions_active_user_uidx;
`, 'restore checkout table after legacy shape test');

  const legacyRowsPath = path.join(tempRoot, 'legacy-rows.sql');
  fs.writeFileSync(legacyRowsPath, `${legacyTablePrefix}
insert into public.stripe_checkout_sessions (intent_id) values ('legacy_intent');
${schema}
`, 'utf8');
  const legacyRows = spawnSync(binaries.psql, psqlArgs(['-f', legacyRowsPath]), {
    cwd: REPO_ROOT,
    env: processEnvironment(),
    encoding: 'utf8',
    maxBuffer: 2 * 1024 * 1024,
  });
  assert(legacyRows.status !== 0, 'incomplete legacy checkout row was silently upgraded');
  assert(/Backfill stripe_checkout_sessions identity columns/.test(`${legacyRows.stderr}\n${legacyRows.stdout}`),
    `legacy checkout row did not fail with a controlled migration error: ${(legacyRows.stderr || legacyRows.stdout).slice(-2000)}`);

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
