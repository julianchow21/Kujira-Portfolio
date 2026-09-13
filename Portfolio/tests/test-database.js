#!/usr/bin/env node
'use strict';

// Genuine PostgreSQL contract tests for the recovered Portfolio NAS schema.
// This file is dependency-free, uses only a private Unix socket, and never
// reads a database URL, password, personal PostgreSQL configuration, or an
// existing cluster. The auth schema and roles are a minimal test fixture,
// not Supabase Auth. They exist only to exercise the schema auth.uid(),
// auth.jwt(), RLS, and RPC boundaries with synthetic UUIDs and payloads.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SCHEMA_PATH = path.join(REPO_ROOT, 'Portfolio', 'Supabase', 'schema.sql');
const RESTORE_SECURITY_PATH = path.join(REPO_ROOT, 'Portfolio', 'NAS', 'restore-security.sql');
const CATALOGUE_SECURITY_PATH = path.join(REPO_ROOT, 'Portfolio', 'NAS', 'catalogue-security.sql');
const PG_BIN_DIR = process.env.PORTFOLIO_PG_BIN || null;
const NO_LOCK_PROOF = process.env.PORTFOLIO_NO_LOCK_PROOF === '1';
const BIN_NAMES = ['initdb', 'pg_ctl', 'psql'];
const MAX_CLUSTER_BYTES = 200n * 1024n * 1024n;
const MIN_FREE_BYTES = 1024n * 1024n * 1024n;
const USER_A = '00000000-0000-0000-0000-00000000000a';
const USER_B = '00000000-0000-0000-0000-00000000000b';
const USER_C = '00000000-0000-0000-0000-00000000000c';
const PORTFOLIO_FUNCTION_SIGNATURES = [
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

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sqlLiteral(value) {
  return "'" + String(value).replace(/'/g, "''") + "'";
}

function jsonbLiteral(value) {
  return sqlLiteral(JSON.stringify(value)) + '::jsonb';
}

function shellQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

function assertNonNull(value, label) {
  assert(value !== null && value !== undefined && value !== '', label + ' was NULL or empty');
}

function pathSizeBytes(root) {
  let total = 0n;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    const stat = fs.lstatSync(entryPath);
    if (stat.isSymbolicLink()) total += BigInt(stat.size);
    else if (stat.isDirectory()) total += pathSizeBytes(entryPath);
    else total += BigInt(stat.size);
  }
  return total;
}

function freeBytesAt(location) {
  const stat = fs.statfsSync(location);
  return BigInt(stat.bsize) * BigInt(stat.bavail);
}

function findExecutable(name) {
  const result = spawnSync('/bin/sh', ['-c', 'command -v ' + name], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

const binaries = Object.fromEntries(BIN_NAMES.map(function(name) {
  return [name, PG_BIN_DIR ? path.join(PG_BIN_DIR, name) : findExecutable(name)];
}));
const missingBinaries = BIN_NAMES.filter(function(name) {
  try {
    if (!binaries[name]) return true;
    const stat = fs.statSync(binaries[name]);
    return !stat.isFile() || (stat.mode & 0o111) === 0;
  } catch {
    return true;
  }
});
if (missingBinaries.length) {
  console.error('BLOCKED: PostgreSQL 18.6 binaries missing or not executable' +
    (PG_BIN_DIR ? ' in PORTFOLIO_PG_BIN=' + PG_BIN_DIR : ' on PATH') +
    ': ' + missingBinaries.join(', '));
  process.exit(2);
}
if (!fs.existsSync(SCHEMA_PATH)) {
  console.error('BLOCKED: recovered Portfolio schema file is missing: ' + SCHEMA_PATH);
  process.exit(2);
}
if (!fs.existsSync(RESTORE_SECURITY_PATH) || !fs.existsSync(CATALOGUE_SECURITY_PATH)) {
  console.error('BLOCKED: Portfolio NAS security SQL files are missing');
  process.exit(2);
}

let tempRoot;
let clusterDir;
let socketDir;
let serverLog;
let serverStarted = false;
let cleanupDone = false;
let cleanupPreserved = false;
let trustedDatabaseName = null;

function processEnvironment() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('PG')) delete env[key];
  }
  // psql -X plus explicit nonexistent files keeps personal .psqlrc,
  // .pg_service.conf, .pgpass, and history out of this test. No HOME
  // override is needed, and no password lookup can succeed.
  env.PSQL_HISTORY = path.join(tempRoot, 'psql.history');
  env.PGPASSFILE = path.join(tempRoot, 'missing.pgpass');
  env.PGSERVICEFILE = path.join(tempRoot, 'missing.pg_service.conf');
  env.LC_ALL = 'C';
  return env;
}

function psqlArgs(extra, database) {
  return [
    '-X', '-q',
    '-v', 'ON_ERROR_STOP=1',
    '-v', 'VERBOSITY=verbose',
    '-A', '-t',
    '-h', socketDir,
    '-U', 'postgres',
    '-d', database || 'postgres'
  ].concat(extra);
}

function runPsqlInDatabase(database, extra, label) {
  const result = spawnSync(binaries.psql, psqlArgs(extra, database), {
    cwd: REPO_ROOT,
    env: processEnvironment(),
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024
  });
  if (result.error) throw new Error(label + ': ' + result.error.message);
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim().slice(-3000);
    throw new Error(label + ': psql exited ' + result.status + (detail ? ': ' + detail : ''));
  }
  return result;
}

function runPsql(extra, label) {
  return runPsqlInDatabase('postgres', extra, label);
}

function runSql(sql, label) {
  return runPsql(['-c', sql], label).stdout;
}

function runSqlInDatabase(database, sql, label) {
  return runPsqlInDatabase(database, ['-c', sql], label).stdout;
}

function runSqlFile(filePath, label) {
  return runPsql(['-f', filePath], label).stdout;
}

function runSqlFileInDatabase(database, filePath, label) {
  return runPsqlInDatabase(database, ['-f', filePath], label).stdout;
}

function expectSqlFileFailure(filePath, label, expectedCode, expectedMessage) {
  const result = spawnSync(binaries.psql, psqlArgs(['-f', filePath]), {
    cwd: REPO_ROOT,
    env: processEnvironment(),
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024
  });
  if (result.error) throw new Error(label + ': ' + result.error.message);
  assert(result.status !== 0, label + ': expected PostgreSQL to reject the file');
  const detail = errorText(result);
  assert(new RegExp('ERROR:\\s+' + expectedCode + '\\b').test(detail),
    label + ': expected SQLSTATE ' + expectedCode + ', got ' + detail.trim().slice(-1800));
  if (expectedMessage) {
    assert(detail.includes(expectedMessage),
      label + ': expected ' + expectedMessage + ', got ' + detail.trim().slice(-1800));
  }
  return result;
}

function errorText(result) {
  return (result.stderr || '') + '\n' + (result.stdout || '');
}

function expectSqlFailure(sql, label, expectedCode, expectedMessage) {
  expectedCode = expectedCode || '42501';
  const result = spawnSync(binaries.psql, psqlArgs(['-c', sql]), {
    cwd: REPO_ROOT,
    env: processEnvironment(),
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024
  });
  if (result.error) throw new Error(label + ': ' + result.error.message);
  assert(result.status !== 0, label + ': expected PostgreSQL to deny the operation');
  const detail = errorText(result);
  assert(new RegExp('ERROR:\\s+' + expectedCode + '\\b').test(detail),
    label + ': expected SQLSTATE ' + expectedCode + ', got ' + detail.trim().slice(-1800));
  if (expectedMessage) {
    assert(detail.includes(expectedMessage),
      label + ': expected ' + expectedMessage + ', got ' + detail.trim().slice(-1800));
  }
  return result;
}

function scalar(sql, label) {
  const values = runSql(sql, label).trim().split(/\r?\n/).filter(Boolean);
  assert(values.length === 1, label + ': expected one scalar, got ' + JSON.stringify(values));
  assertNonNull(values[0], label);
  return values[0];
}

function jsonRows(sql, label) {
  const output = runSql(sql, label).trim();
  if (!output) return [];
  return output.split(/\r?\n/).filter(Boolean).map(function(line, index) {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(label + ': row ' + (index + 1) + ' was not JSON: ' + error.message);
    }
  });
}

// Build the expected function-body manifest from a separate database that was
// populated from the checked-in canonical schema. This avoids copying expected
// function bodies into the audit or letting a tampered target define its own
// expected text. The manifest is session-scoped input to restore-security.sql,
// not an archive hash or producer identity claim.
function functionBodyManifest(database, label) {
  const signatures = PORTFOLIO_FUNCTION_SIGNATURES.map(sqlLiteral).join(', ');
  const output = runSqlInDatabase(database, [
    'select signature || ' + sqlLiteral('=') + ' ||',
    '       pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure(signature)))',
    '  from pg_catalog.unnest(array[' + signatures + ']) as entries(signature)',
    ' order by signature;'
  ].join('\n'), label);
  const rows = output.trim().split(/\r?\n/).filter(Boolean);
  assert(rows.length === PORTFOLIO_FUNCTION_SIGNATURES.length,
    label + ': expected one body hash for each canonical function, got ' + rows.length);
  const expected = new Set(PORTFOLIO_FUNCTION_SIGNATURES);
  for (const row of rows) {
    const separator = row.lastIndexOf('=');
    assert(separator > 0, label + ': malformed function body manifest entry');
    const signature = row.slice(0, separator);
    const hash = row.slice(separator + 1);
    assert(expected.has(signature), label + ': unexpected function body manifest entry ' + signature);
    assert(/^[0-9a-f]{32}$/.test(hash), label + ': malformed function body hash for ' + signature);
  }
  return rows.join('|');
}

function rolePrefix(role, userId, aal) {
  assert(['anon', 'authenticated', 'service_role', 'portfolio_rpc'].includes(role),
    'unexpected fixture role ' + role);
  const claims = {};
  if (userId) claims.sub = userId;
  if (aal) claims.aal = aal;
  return [
    'set role ' + role + ';',
    'do $$',
    'begin',
    '  perform pg_catalog.set_config(' +
      sqlLiteral('request.jwt.claim.sub') + ', ' + sqlLiteral(userId || '') + ', false);',
    '  perform pg_catalog.set_config(' +
      sqlLiteral('request.jwt.claims') + ', ' + sqlLiteral(JSON.stringify(claims)) + ', false);',
    'end',
    '$$;'
  ].join('\n');
}

function recordArgs(recordType, recordId, payload, position, expectedVersion) {
  return [
    sqlLiteral(recordType),
    sqlLiteral(recordId),
    jsonbLiteral(payload),
    String(position),
    expectedVersion === null ? 'null::bigint' : String(expectedVersion) + '::bigint'
  ].join(', ');
}

function deleteArgs(recordType, recordId, expectedVersion) {
  return [sqlLiteral(recordType), sqlLiteral(recordId), String(expectedVersion) + '::bigint'].join(', ');
}

function rpcRow(prefix, functionName, args, label) {
  const rows = jsonRows([
    prefix,
    'select pg_catalog.row_to_json(r)::text',
    '  from public.' + functionName + '(' + args + ') as r;'
  ].join('\n'), label);
  assert(rows.length === 1, label + ': expected exactly one returned row, got ' + rows.length);
  return rows[0];
}

function rpcError(prefix, functionName, args, label, expectedMessage) {
  return expectSqlFailure([
    prefix,
    'select pg_catalog.row_to_json(r)::text',
    '  from public.' + functionName + '(' + args + ') as r;'
  ].join('\n'), label, 'P0001', expectedMessage);
}

function rememberToken(tokens, row, label) {
  assertNonNull(row.change_seq, label + '.change_seq');
  const token = BigInt(row.change_seq);
  assert(token > 0n, label + '.change_seq was not positive: ' + token);
  if (tokens.length) {
    assert(token > tokens[tokens.length - 1],
      label + '.change_seq ' + token + ' did not advance beyond ' + tokens[tokens.length - 1]);
  }
  tokens.push(token);
  return token;
}

function assertRecordEnvelope(row, expectedId, label) {
  assert(row.user_id === USER_A, label + '.user_id did not bind to the configured owner');
  assert(row.record_type === 'stocks', label + '.record_type was ' + row.record_type);
  assert(row.record_id === expectedId, label + '.record_id was ' + row.record_id);
  assert(row.payload && row.payload.id === expectedId,
    label + '.payload.id did not match the record id');
  assertNonNull(row.version, label + '.version');
  assertNonNull(row.change_seq, label + '.change_seq');
  assertNonNull(row.created_at, label + '.created_at');
  assertNonNull(row.updated_at, label + '.updated_at');
}

function barrierWaitSql() {
  return [
    'do $$',
    'declare',
    "  deadline timestamptz := pg_catalog.clock_timestamp() + interval '10 seconds';",
    'begin',
    '  loop',
    '    exit when (select ready from public.test_barrier where id = 1) >= 2;',
    '    if pg_catalog.clock_timestamp() >= deadline then',
    "      raise exception 'test barrier timeout';",
    '    end if;',
    '    perform pg_catalog.pg_sleep(0.01);',
    '  end loop;',
    'end',
    '$$;'
  ].join('\n');
}

function concurrentUpsertSql(writer, recordId, expectedVersion) {
  return [
    'begin;',
    'update public.test_barrier set ready = ready + 1 where id = 1;',
    'commit;',
    barrierWaitSql(),
    'begin;',
    rolePrefix('authenticated', USER_A, 'aal2'),
    'select pg_catalog.row_to_json(r)::text',
    '  from public.portfolio_upsert_record(' +
      recordArgs('stocks', recordId, { id: recordId, writer: writer }, 0, expectedVersion) + ') as r;',
    'commit;'
  ].join('\n');
}

function parseChildRow(result, label) {
  assert(result.code === 0, label + ': expected success, got ' + result.stderr.trim());
  const rows = result.stdout.trim().split(/\r?\n/).filter(Boolean);
  assert(rows.length === 1, label + ': expected one JSON row, got ' + JSON.stringify(rows));
  try {
    return JSON.parse(rows[0]);
  } catch (error) {
    throw new Error(label + ': invalid returned JSON: ' + error.message);
  }
}

function spawnSql(sql, label, timeoutMs) {
  timeoutMs = timeoutMs || 20000;
  return new Promise(function(resolve, reject) {
    const child = spawn(binaries.psql, psqlArgs(['-c', sql]), {
      cwd: REPO_ROOT,
      env: processEnvironment(),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(function() {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      reject(new Error(label + ': timed out after ' + timeoutMs + 'ms'));
    }, timeoutMs);
    child.stdout.on('data', function(chunk) { stdout += chunk; });
    child.stderr.on('data', function(chunk) { stderr += chunk; });
    child.on('error', function(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(label + ': ' + error.message));
    });
    child.on('close', function(code) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: code, stdout: stdout, stderr: stderr });
    });
  });
}

function openSqlSession(label, timeoutMs) {
  timeoutMs = timeoutMs || 30000;
  const child = spawn(binaries.psql, psqlArgs([]), {
    cwd: REPO_ROOT,
    env: processEnvironment(),
    stdio: ['pipe', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  let settled = false;
  const waiters = new Map();
  let doneResolve;
  let doneReject;
  const done = new Promise(function(resolve, reject) {
    doneResolve = resolve;
    doneReject = reject;
  });
  function inspectMarkers() {
    for (const [marker, waiter] of waiters) {
      if (stdout.includes(marker)) {
        waiters.delete(marker);
        clearTimeout(waiter.timer);
        waiter.resolve(stdout);
      }
    }
  }
  const timer = setTimeout(function() {
    if (settled) return;
    settled = true;
    child.kill('SIGTERM');
    const error = new Error(label + ': timed out after ' + timeoutMs + 'ms\n' +
      stdout.slice(-1800) + '\n' + stderr.slice(-1800));
    for (const waiter of waiters.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    waiters.clear();
    doneReject(error);
  }, timeoutMs);
  child.stdout.on('data', function(chunk) {
    stdout += chunk;
    inspectMarkers();
  });
  child.stderr.on('data', function(chunk) { stderr += chunk; });
  child.on('error', function(error) {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    const wrapped = new Error(label + ': ' + error.message);
    for (const waiter of waiters.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(wrapped);
    }
    waiters.clear();
    doneReject(wrapped);
  });
  child.on('close', function(code) {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    for (const waiter of waiters.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(label + ': marker ' + waiter.marker +
        ' was never emitted, exit ' + code + '\n' + stderr.slice(-1800)));
    }
    waiters.clear();
    doneResolve({ code: code, stdout: stdout, stderr: stderr });
  });
  return {
    write: function(sql) {
      assert(!settled, label + ': cannot write after session ended');
      child.stdin.write(sql);
    },
    end: function() { child.stdin.end(); },
    output: function() { return stdout; },
    waitFor: function(marker, markerTimeoutMs) {
      markerTimeoutMs = markerTimeoutMs || timeoutMs;
      if (stdout.includes(marker)) return Promise.resolve(stdout);
      return new Promise(function(resolve, reject) {
        const markerTimer = setTimeout(function() {
          waiters.delete(marker);
          reject(new Error(label + ': marker ' + marker +
            ' was not emitted within ' + markerTimeoutMs + 'ms\n' +
            stdout.slice(-1800) + '\n' + stderr.slice(-1800)));
        }, markerTimeoutMs);
        waiters.set(marker, { marker: marker, resolve: resolve, reject: reject, timer: markerTimer });
        inspectMarkers();
      });
    },
    done: done
  };
}

async function waitForAdvisoryWait(pid, label, timeoutMs) {
  timeoutMs = timeoutMs || 5000;
  assert(/^\d+$/.test(String(pid)), label + ': invalid backend PID ' + pid);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const waiting = scalar([
      'select count(*)::text',
      'from pg_catalog.pg_locks l',
      'where l.pid = ' + String(Number(pid)),
      "  and l.locktype = 'advisory'",
      '  and not l.granted;'
    ].join('\n'), label + ' lock poll');
    if (waiting === '1') return;
    await new Promise(function(resolve) { setTimeout(resolve, 25); });
  }
  throw new Error(label + ': backend did not enter a waiting advisory lock');
}

function startInteractiveSql(sql, label, marker, timeoutMs) {
  timeoutMs = timeoutMs || 30000;
  const child = spawn(binaries.psql, psqlArgs([]), {
    cwd: REPO_ROOT,
    env: processEnvironment(),
    stdio: ['pipe', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  let readyResolve;
  let readyReject;
  const ready = new Promise(function(resolve, reject) {
    readyResolve = resolve;
    readyReject = reject;
  });
  let doneResolve;
  let doneReject;
  const done = new Promise(function(resolve, reject) {
    doneResolve = resolve;
    doneReject = reject;
  });
  let settled = false;
  let markerSeen = false;
  const timer = setTimeout(function() {
    if (settled) return;
    settled = true;
    child.kill('SIGTERM');
    const error = new Error(label + ': timed out after ' + timeoutMs + 'ms');
    readyReject(error);
    doneReject(error);
  }, timeoutMs);
  child.stdout.on('data', function(chunk) {
    stdout += chunk;
    if (!markerSeen && stdout.includes(marker)) {
      markerSeen = true;
      readyResolve();
    }
  });
  child.stderr.on('data', function(chunk) { stderr += chunk; });
  child.on('error', function(error) {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    readyReject(new Error(label + ': ' + error.message));
    doneReject(new Error(label + ': ' + error.message));
  });
  child.on('close', function(code) {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (!markerSeen) readyReject(new Error(label + ': marker ' + marker + ' was never emitted'));
    doneResolve({ code: code, stdout: stdout, stderr: stderr });
  });
  child.stdin.end(sql);
  return { ready: ready, done: done };
}

function jsonLinesFromOutput(output, label) {
  return output.trim().split(/\r?\n/).filter(function(line) {
    return line.trim().startsWith('{');
  }).map(function(line) {
    try {
      return JSON.parse(line.trim());
    } catch (error) {
      throw new Error(label + ': invalid JSON output: ' + error.message);
    }
  });
}

function assertDeniedOutput(result, label, expectedCode, expectedMessage) {
  assert(result.code !== 0, label + ': expected failure');
  const detail = errorText(result);
  assert(new RegExp('ERROR:\\s+' + expectedCode + '\\b').test(detail),
    label + ': expected SQLSTATE ' + expectedCode + ', got ' + detail.trim().slice(-1800));
  if (expectedMessage) assert(detail.includes(expectedMessage),
    label + ': expected ' + expectedMessage + ', got ' + detail.trim().slice(-1800));
}

async function runNoLockLateCommitProof() {
  runSql('insert into auth.users (id) values (' + sqlLiteral(USER_A) + ');',
    'bind owner for no-lock regression proof');

  const sessionA = openSqlSession('no-lock proof session A');
  sessionA.write([
    'begin;',
    rolePrefix('authenticated', USER_A, 'aal2'),
    'select pg_catalog.row_to_json(r)::text',
    "  from public.portfolio_upsert_record('stocks', 'noLockA', '" +
      JSON.stringify({ id: 'noLockA', writer: 'no_lock_a' }).replace(/'/g, "''") +
      "'::jsonb, 0, 0) as r;",
    "select 'A_READY';"
  ].join('\n') + '\n');
  await sessionA.waitFor('A_READY');

  const sessionB = openSqlSession('no-lock proof session B');
  sessionB.write([
    'begin;',
    rolePrefix('authenticated', USER_A, 'aal2'),
    "select 'B_STARTED:' || pg_catalog.pg_backend_pid()::text;",
    'select pg_catalog.row_to_json(r)::text',
    "  from public.portfolio_upsert_record('stocks', 'noLockB', '" +
      JSON.stringify({ id: 'noLockB', writer: 'no_lock_b' }).replace(/'/g, "''") +
      "'::jsonb, 0, 0) as r;",
    "select 'B_WRITTEN';",
    'commit;',
    "select 'B_BOUNDARY:' || change_seq::text from public.portfolio_records where record_id = 'noLockB';",
    "select 'B_PAGE_ROWS:' || count(*)::text from public.portfolio_get_records_page(0::bigint, null::bigint, 500::integer) where record_id in ('noLockA', 'noLockB');",
    "select 'B_DONE';"
  ].join('\n') + '\n');
  await sessionB.waitFor('B_DONE');
  const bOutput = sessionB.output();
  const boundaryMatch = bOutput.match(/B_BOUNDARY:(\d+)/);
  const pageMatch = bOutput.match(/B_PAGE_ROWS:(\d+)/);
  assert(boundaryMatch, 'no-lock proof B did not expose its committed boundary');
  assert(pageMatch, 'no-lock proof B did not expose its page row count');
  assert(pageMatch[1] === '1',
    'no-lock proof unexpectedly saw the uncommitted A row before A commit: ' + pageMatch[1]);
  sessionB.end();
  const bResult = await sessionB.done;
  assert(bResult.code === 0, 'no-lock proof session B failed: ' + bResult.stderr.trim());

  sessionA.write("commit;\nselect 'A_COMMITTED';\n");
  await sessionA.waitFor('A_COMMITTED');
  sessionA.end();
  const aResult = await sessionA.done;
  assert(aResult.code === 0, 'no-lock proof session A failed: ' + aResult.stderr.trim());

  const rows = jsonRows([
    'select pg_catalog.row_to_json(r)::text',
    'from public.portfolio_records r',
    "where r.record_id in ('noLockA', 'noLockB')",
    'order by r.change_seq;'
  ].join('\n'), 'read no-lock proof rows');
  assert(rows.length === 2, 'no-lock proof did not store two rows');
  const aToken = BigInt(rows[0].change_seq);
  const bToken = BigInt(rows[1].change_seq);
  assert(rows[0].record_id === 'noLockA' && rows[1].record_id === 'noLockB',
    'no-lock proof sequence order did not expose allocation-before-commit');
  assert(aToken < bToken,
    'no-lock proof did not allocate A before B: ' + aToken + ' and ' + bToken);
  const missedByBoundary = scalar([
    'select count(*)::text',
    'from public.portfolio_records',
    "where record_id = 'noLockA' and change_seq <= " + boundaryMatch[1] + '::bigint;'
  ].join('\n'), 'prove no-lock boundary misses late A commit');
  assert(missedByBoundary === '1',
    'no-lock proof did not leave A at or below B boundary: ' + missedByBoundary);
  return { aToken: aToken, bToken: bToken, pageRows: pageMatch[1] };
}

function checkPostgresVersion() {
  for (const name of BIN_NAMES) {
    const result = spawnSync(binaries[name], ['--version'], { encoding: 'utf8' });
    assert(result.status === 0, name + ' --version failed');
    assert(/PostgreSQL.*18\.6\b/.test(result.stdout),
      name + ' is not PostgreSQL 18.6: ' + result.stdout.trim());
  }
}

function cleanup() {
  if (cleanupDone) return true;
  if (cleanupPreserved || !tempRoot) return false;
  if (serverStarted && trustedDatabaseName) {
    const drop = spawnSync(binaries.psql, psqlArgs([
      '-c', 'drop database if exists ' + trustedDatabaseName + ';'
    ]), {
      cwd: REPO_ROOT,
      env: processEnvironment(),
      encoding: 'utf8',
      maxBuffer: 2 * 1024 * 1024
    });
    if (drop.status !== 0) {
      cleanupPreserved = true;
      if (!process.exitCode) process.exitCode = 1;
      console.error('BLOCKED: could not remove trusted canonical test database, preserving ' + tempRoot);
      return false;
    }
    trustedDatabaseName = null;
  }
  if (serverStarted) {
    const stop = spawnSync(binaries.pg_ctl, ['-D', clusterDir, '-m', 'fast', '-w', 'stop'], {
      cwd: REPO_ROOT,
      env: processEnvironment(),
      encoding: 'utf8',
      maxBuffer: 2 * 1024 * 1024
    });
    const status = spawnSync(binaries.pg_ctl, ['-D', clusterDir, 'status'], {
      cwd: REPO_ROOT,
      env: processEnvironment(),
      encoding: 'utf8',
      maxBuffer: 2 * 1024 * 1024
    });
    const pidFileGone = !fs.existsSync(path.join(clusterDir, 'postmaster.pid'));
    const stopped = status.status === 3 && pidFileGone;
    if (stop.status !== 0 || !stopped) {
      cleanupPreserved = true;
      if (!process.exitCode) process.exitCode = 1;
      console.error('BLOCKED: could not prove PostgreSQL stopped, preserving ' + tempRoot);
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
    console.error('BLOCKED: cleanup failed, preserving ' + tempRoot + ': ' + error.message);
    return false;
  }
}

async function main() {
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    throw new Error('BLOCKED: initdb refuses to initialise a cluster as root');
  }
  checkPostgresVersion();
  const freeBefore = freeBytesAt(os.tmpdir());
  assert(freeBefore >= MIN_FREE_BYTES,
    'less than 1 GiB free at ' + os.tmpdir() + ' before cluster creation: ' + freeBefore);

  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kjr-portfolio-pg-'));
  clusterDir = path.join(tempRoot, 'cluster');
  socketDir = path.join(tempRoot, 'socket');
  serverLog = path.join(tempRoot, 'postgres.log');
  fs.mkdirSync(socketDir, { mode: 0o700 });
  assert((fs.statSync(socketDir).mode & 0o777) === 0o700,
    'private PostgreSQL socket directory is not mode 0700');

  const init = spawnSync(binaries.initdb, [
    '-D', clusterDir, '-U', 'postgres',
    '--no-locale', '--encoding=UTF8',
    '--auth-local=trust', '--auth-host=reject'
  ], {
    cwd: REPO_ROOT,
    env: processEnvironment(),
    encoding: 'utf8',
    maxBuffer: 2 * 1024 * 1024
  });
  if (init.error || init.status !== 0) {
    throw new Error('initdb failed: ' +
      (init.stderr || init.stdout || init.error?.message || '').trim().slice(-2400));
  }
  const freshSize = pathSizeBytes(clusterDir);
  assert(freshSize <= MAX_CLUSTER_BYTES,
    'fresh PostgreSQL cluster exceeds 200 MiB: ' + freshSize + ' bytes');

  const postgresOptions = [
    '-k ' + shellQuote(socketDir),
    "-c listen_addresses=''",
    '-c unix_socket_permissions=0700'
  ].join(' ');
  serverStarted = true;
  const start = spawnSync(binaries.pg_ctl, [
    '-D', clusterDir, '-o', postgresOptions, '-l', serverLog, '-w', 'start'
  ], {
    cwd: REPO_ROOT,
    env: processEnvironment(),
    encoding: 'utf8',
    maxBuffer: 2 * 1024 * 1024
  });
  if (start.error || start.status !== 0) {
    const log = fs.existsSync(serverLog) ? fs.readFileSync(serverLog, 'utf8').slice(-2400) : '';
    throw new Error('pg_ctl start failed: ' +
      (start.stderr || start.stdout || start.error?.message || '') + (log ? '\n' + log : ''));
  }

  const runtime = scalar([
    "select pg_catalog.current_setting('listen_addresses') || '|' ||",
    "       pg_catalog.current_setting('unix_socket_directories') || '|' ||",
    "       pg_catalog.current_setting('unix_socket_permissions');"
  ].join('\n'), 'verify local-only PostgreSQL listener');
  const runtimeParts = runtime.split('|');
  assert(runtimeParts[0] === '', 'PostgreSQL unexpectedly listens on TCP: ' + runtimeParts[0]);
  assert(runtimeParts[1] === socketDir, 'PostgreSQL socket directory drifted: ' + runtimeParts[1]);
  assert(runtimeParts[2] === '0700', 'PostgreSQL socket permissions drifted: ' + runtimeParts[2]);

  const bootstrap = [
    '-- TEST FIXTURE ONLY, not Supabase Auth. Keep this minimal.',
    '-- This owner and its grants model the Supabase Auth admin role only',
    '-- for catalogue-security.sql. No real Auth service or credentials run.',
    'create role supabase_auth_admin login noinherit;',
    'create schema auth authorization supabase_auth_admin;',
    'set role supabase_auth_admin;',
    'create table auth.users (id uuid primary key);',
    'create or replace function auth.uid()',
    'returns uuid language sql stable',
    'as $fn$',
    "  select nullif(pg_catalog.current_setting('request.jwt.claim.sub', true), '')::uuid",
    '$fn$;',
    'create or replace function auth.jwt()',
    'returns jsonb language sql stable',
    'as $fn$',
    "  select coalesce(nullif(pg_catalog.current_setting('request.jwt.claims', true), ''), '{}')::jsonb",
    '$fn$;',
    'set role postgres;',
    'create role anon nologin noinherit;',
    'create role authenticated nologin noinherit;',
    'create role service_role nologin noinherit bypassrls;',
    'grant usage on schema auth to anon, authenticated, service_role;',
    'grant execute on function auth.uid() to anon, authenticated, service_role;',
    'grant execute on function auth.jwt() to anon, authenticated, service_role;',
    'grant connect on database postgres to supabase_auth_admin;'
  ].join('\n');
  runSql(bootstrap, 'bootstrap minimal synthetic Auth fixture');

  const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
  assert(schema.length > 0, 'Portfolio schema file was empty');
  const allocationLockLine = '  perform pg_catalog.pg_advisory_xact_lock(741234567890123457);\n';
  assert(!NO_LOCK_PROOF || schema.includes(allocationLockLine),
    'no-lock proof could not find the canonical sequence allocation lock');
  const appliedSchema = NO_LOCK_PROOF
    ? schema.replace(allocationLockLine, '  -- deliberately omitted for no-lock regression proof\n')
    : schema;
  const applyPath = path.join(tempRoot, 'schema.sql');
  fs.writeFileSync(applyPath, appliedSchema, 'utf8');
  runSqlFile(applyPath, 'apply Portfolio schema');
  runSqlFile(applyPath, 'reapply Portfolio schema idempotence');
  if (NO_LOCK_PROOF) {
    const proof = await runNoLockLateCommitProof();
    const clusterSize = pathSizeBytes(clusterDir);
    assert(clusterSize <= MAX_CLUSTER_BYTES,
      'no-lock proof PostgreSQL cluster exceeded 200 MiB: ' + clusterSize + ' bytes');
    assert(freeBytesAt(os.tmpdir()) >= MIN_FREE_BYTES,
      'less than 1 GiB free at ' + os.tmpdir() + ' after no-lock proof');
    assert(cleanup(), 'no-lock proof cluster cleanup was not verified');
    console.log('EXPECTED FAIL PROOF: without the allocation lock, A committed at seq ' +
      proof.aToken + ' after B boundary ' + proof.bToken + ', and B page saw only ' +
      proof.pageRows + ' row, so a cursor at B boundary would skip A');
    return;
  }

  // Capture expected function bodies from a separate database populated from
  // the checked-in canonical schema. The target audit receives only this
  // generated hash manifest, so a changed function body cannot make the
  // target define its own expected value and no body text is duplicated here.
  trustedDatabaseName = 'portfolio_trusted';
  runSql('create database ' + trustedDatabaseName + ';', 'create trusted canonical test database');
  const trustedBootstrap = bootstrap
    .replace(/^create role [^\n]+;\n/gm, '')
    .replace('create schema auth authorization supabase_auth_admin;',
      'create schema if not exists auth authorization supabase_auth_admin;')
    .replace('create table auth.users (id uuid primary key);',
      'create table if not exists auth.users (id uuid primary key);');
  runSqlInDatabase(trustedDatabaseName, trustedBootstrap,
    'bootstrap trusted canonical test database');
  runSqlFileInDatabase(trustedDatabaseName, applyPath,
    'apply canonical schema to trusted test database');
  const trustedBodyManifest = functionBodyManifest(trustedDatabaseName,
    'capture trusted canonical function body manifest');
  runSql('drop database ' + trustedDatabaseName + ';',
    'drop trusted canonical test database');
  trustedDatabaseName = null;
  const targetBodyManifest = functionBodyManifest('postgres',
    'capture target canonical function body manifest');
  assert(targetBodyManifest === trustedBodyManifest,
    'target canonical function bodies differ from the trusted separate database:\n' +
    'trusted=' + trustedBodyManifest + '\n' + 'target=' + targetBodyManifest);

  const bodyAuditPath = path.join(tempRoot, 'restore-security-body.sql');
  fs.writeFileSync(bodyAuditPath, [
    'set portfolio.trusted_function_hashes = ' + sqlLiteral(trustedBodyManifest) + ';',
    '\\i ' + RESTORE_SECURITY_PATH
  ].join('\n') + '\n', 'utf8');
  const restoreSecurityOutput = runSqlFile(bodyAuditPath,
    'run exact staged restore security audit');
  assert(restoreSecurityOutput.includes('portfolio_restore_security_ok'),
    'staged restore security audit did not return its exact success token');
  const catalogueSecurityOutput = runSqlFile(CATALOGUE_SECURITY_PATH,
    'run exact catalogue security audit');
  assert(catalogueSecurityOutput.includes('["contract", "portfolio_catalogue_security_v1"]'),
    'catalogue security audit did not return its contract marker');
  assert(catalogueSecurityOutput.includes(
    '["auth_required", true, true, true, true, true, true, true, true, true, true, true]'),
  'catalogue security audit did not prove the synthetic supabase_auth_admin fixture');

  // The restore audit must reject a required NOT NULL change. Keep this
  // negative fixture in its own transaction and rerun the positive audit to
  // prove that the canonical schema remains intact afterwards.
  const negativeRestorePath = path.join(tempRoot, 'restore-security-negative.sql');
  fs.writeFileSync(negativeRestorePath, [
    'begin;',
    'alter table public.portfolio_records alter column payload drop not null;',
    '\\i ' + bodyAuditPath
  ].join('\n') + '\n', 'utf8');
  expectSqlFileFailure(negativeRestorePath, 'negative missing-NOT-NULL restore audit',
    'P0001', 'Portfolio column structure mismatch');
  const tamperedBodyPath = path.join(tempRoot, 'restore-security-tampered-body.sql');
  fs.writeFileSync(tamperedBodyPath, [
    'begin;',
    'create or replace function public.portfolio_sync_boundary()',
    'returns bigint',
    'language plpgsql',
    'security definer',
    'set search_path = \'\'',
    'as $portfolio_tampered_body$',
    'begin',
    '  return 0::bigint;',
    'end;',
    '$portfolio_tampered_body$;',
    '\\i ' + bodyAuditPath
  ].join('\n') + '\n', 'utf8');
  expectSqlFileFailure(tamperedBodyPath, 'negative tampered function body audit',
    'P0001', 'Portfolio function body content mismatch');
  assert(runSqlFile(bodyAuditPath, 'restore audit after negative fixtures')
    .includes('portfolio_restore_security_ok'),
  'restore audit did not pass after the negative fixtures rolled back');

  assert(scalar('select count(*)::text from private.portfolio_owner;', 'owner rows after empty install') === '0',
    'schema bound an owner before the first synthetic Auth user');
  runSql('insert into auth.users (id) values (' + sqlLiteral(USER_A) + ');',
    'bind first synthetic Auth user');
  assert(scalar('select owner_id::text from private.portfolio_owner where owner_key = true;',
    'read configured owner') === USER_A, 'first Auth user did not bind as the owner');
  assert(scalar('select count(*)::text from private.portfolio_owner;', 'owner singleton count') === '1',
    'owner table did not remain a singleton');

  // This disabled-trigger insert is only a wrong-user fixture. Real Auth
  // inserts cannot bypass the owner-binding trigger.
  runSql([
    'alter table auth.users disable trigger portfolio_bind_auth_user_after_insert;',
    'insert into auth.users (id) values (' + sqlLiteral(USER_B) + ');',
    'alter table auth.users enable trigger portfolio_bind_auth_user_after_insert;'
  ].join('\n'), 'seed second synthetic Auth fixture');
  expectSqlFailure('insert into auth.users (id) values (' + sqlLiteral(USER_C) + ');',
    'second real Auth bind attempt', 'P0001', 'PORTFOLIO_OWNER_ALREADY_BOUND');
  assert(scalar('select owner_id::text from private.portfolio_owner where owner_key = true;',
    'owner after second Auth attempt') === USER_A, 'owner binding changed after second Auth attempt');

  const rls = scalar([
    'select c.relrowsecurity::text || ' + sqlLiteral(',') + ' || c.relforcerowsecurity::text',
    'from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace',
    "where n.nspname = 'public' and c.relname = 'portfolio_records';"
  ].join('\n'), 'inspect Portfolio RLS');
  assert(rls === 'true,true', 'Portfolio records RLS was not enabled and forced: ' + rls);

  function tablePrivileges(role, tableName) {
    return scalar([
      'select has_table_privilege(' + sqlLiteral(role) + ', ' + sqlLiteral(tableName) + ", 'SELECT')::text || ',' ||",
      "       has_table_privilege(" + sqlLiteral(role) + ', ' + sqlLiteral(tableName) + ", 'INSERT')::text || ',' ||",
      "       has_table_privilege(" + sqlLiteral(role) + ', ' + sqlLiteral(tableName) + ", 'UPDATE')::text || ',' ||",
      "       has_table_privilege(" + sqlLiteral(role) + ', ' + sqlLiteral(tableName) + ", 'DELETE')::text || ',' ||",
      "       has_table_privilege(" + sqlLiteral(role) + ', ' + sqlLiteral(tableName) + ", 'TRUNCATE')::text;"
    ].join('\n'), 'inspect ' + role + ' privileges on ' + tableName);
  }

  assert(tablePrivileges('authenticated', 'public.portfolio_records') === 'true,false,false,false,false',
    'authenticated direct records grants were broader than SELECT');
  assert(tablePrivileges('anon', 'public.portfolio_records') === 'false,false,false,false,false',
    'anon received a records table grant');
  assert(tablePrivileges('service_role', 'public.portfolio_records') === 'false,false,false,false,false',
    'service_role received a records table grant');
  assert(tablePrivileges('portfolio_rpc', 'public.portfolio_records') === 'true,true,true,false,false',
    'portfolio_rpc records grants were not constrained');
  assert(tablePrivileges('portfolio_rpc', 'private.portfolio_owner') === 'true,true,true,false,false',
    'portfolio_rpc owner grants were not constrained');
  assert(tablePrivileges('anon', 'private.portfolio_owner') === 'false,false,false,false,false',
    'anon received private owner-table access');
  assert(scalar("select has_sequence_privilege('portfolio_rpc', 'public.portfolio_change_seq', 'USAGE')::text;",
    'portfolio_rpc sequence usage') === 'true', 'portfolio_rpc lacks sequence usage');
  assert(scalar("select has_sequence_privilege('authenticated', 'public.portfolio_change_seq', 'USAGE')::text;",
    'authenticated sequence usage') === 'false', 'authenticated can advance the sequence');

  function functionPrivilege(role, signature) {
    return scalar('select has_function_privilege(' + sqlLiteral(role) + ', ' +
      sqlLiteral(signature) + ", 'EXECUTE')::text;", 'inspect ' + role + ' EXECUTE on ' + signature);
  }

  const grantedFunctions = [
    'public.portfolio_upsert_record(text,text,jsonb,integer,bigint)',
    'public.portfolio_delete_record(text,text,bigint)',
    'public.portfolio_restore_record(text,text,jsonb,integer,bigint)',
    'public.portfolio_restore_record(text,text,bigint)',
    'public.portfolio_get_records_page(bigint,bigint,integer)',
    'public.portfolio_sync_boundary()'
  ];
  for (const signature of grantedFunctions) {
    assert(functionPrivilege('authenticated', signature) === 'true',
      'authenticated cannot execute ' + signature);
    assert(functionPrivilege('anon', signature) === 'false', 'anon can execute ' + signature);
    assert(functionPrivilege('service_role', signature) === 'false',
      'service_role can execute ' + signature);
  }
  assert(functionPrivilege('authenticated', 'public.portfolio_sync_page(bigint,integer)') === 'false',
    'internal sync_page RPC was exposed directly to authenticated clients');
  for (const signature of ['public.portfolio_stamp_record()', 'public.portfolio_bind_auth_user()']) {
    assert(functionPrivilege('authenticated', signature) === 'false',
      'internal trigger ' + signature + ' is callable by authenticated');
    assert(functionPrivilege('anon', signature) === 'false',
      'internal trigger ' + signature + ' is callable by anon');
  }

  const definerRole = scalar([
    "select rolsuper::text || ',' || rolbypassrls::text || ',' || rolcanlogin::text || ',' || rolinherit::text",
    "from pg_catalog.pg_roles where rolname = 'portfolio_rpc';"
  ].join('\n'), 'inspect portfolio_rpc role');
  assert(definerRole === 'false,false,false,false',
    'portfolio_rpc role was not constrained: ' + definerRole);
  assert(scalar([
    'select count(*)::text',
    'from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace',
    "where n.nspname = 'public' and p.prosecdef",
    "  and pg_catalog.pg_get_userbyid(p.proowner) = 'portfolio_rpc'",
    "  and coalesce(array_to_string(p.proconfig, ','), '') like '%search_path=%';"
  ].join('\n'), 'inspect SECURITY DEFINER function metadata') === '9',
    'not all Portfolio trigger/RPC functions use constrained SECURITY DEFINER metadata');

  // Coordinator-only barrier table for deterministic two-session races. It
  // is created by the bootstrap administrator after the application schema,
  // and API roles never receive any privilege on it.
  runSql([
    'create table public.test_barrier (id integer primary key, ready integer not null default 0);',
    'insert into public.test_barrier (id) values (1);'
  ].join('\n'), 'create private concurrency barrier');

  const ownerClaims = rolePrefix('authenticated', USER_A, 'aal2');
  assert(scalar([
    rolePrefix('authenticated', USER_A, 'aal2'),
    'select count(*)::text from public.portfolio_records;'
  ].join('\n'), 'empty authenticated own-row SELECT') === '0',
    'authenticated saw records before any record was written');
  assert(scalar([
    rolePrefix('authenticated', USER_A, 'aal1'),
    'select count(*)::text from public.portfolio_records;'
  ].join('\n'), 'AAL1 direct records SELECT') === '0',
    'AAL1 direct SELECT bypassed the AAL2 RLS policy');
  expectSqlFailure([
    rolePrefix('authenticated', USER_A, 'aal2'),
    'insert into public.portfolio_records',
    '  (user_id, record_type, record_id, position, payload, version, change_seq)',
    'values (' + sqlLiteral(USER_A) + ", 'stocks', 'directInsert', 0,",
    '        ' + jsonbLiteral({ id: 'directInsert' }) + ', 1, 999999);'
  ].join('\n'), 'authenticated direct INSERT', '42501');
  expectSqlFailure([
    rolePrefix('authenticated', USER_A, 'aal2'),
    'update public.portfolio_records set payload = ' +
      jsonbLiteral({ id: 'directInsert', tampered: true }) + ';'
  ].join('\n'), 'authenticated direct UPDATE', '42501');
  expectSqlFailure([
    rolePrefix('authenticated', USER_A, 'aal2'),
    'delete from public.portfolio_records;'
  ].join('\n'), 'authenticated direct DELETE', '42501');
  expectSqlFailure([
    rolePrefix('authenticated', USER_A, 'aal2'),
    'truncate public.portfolio_records;'
  ].join('\n'), 'authenticated direct TRUNCATE', '42501');
  expectSqlFailure([
    rolePrefix('authenticated', USER_A, 'aal2'),
    'update private.portfolio_owner set owner_id = ' + sqlLiteral(USER_B) +
      ' where owner_key = true;'
  ].join('\n'), 'authenticated owner binding UPDATE', '42501');
  expectSqlFailure([
    rolePrefix('anon', USER_A, 'aal2'),
    'select count(*) from public.portfolio_records;'
  ].join('\n'), 'anon direct records SELECT', '42501');
  expectSqlFailure([
    rolePrefix('service_role', USER_A, 'aal2'),
    'select count(*) from public.portfolio_records;'
  ].join('\n'), 'service_role direct records SELECT', '42501');

  const tokens = [];
  const stockCreate = rpcRow(ownerClaims, 'portfolio_upsert_record',
    recordArgs('stocks', 'stockA', { id: 'stockA', ticker: 'SYN-A' }, 0, 0),
    'authenticated AAL2 create');
  assertRecordEnvelope(stockCreate, 'stockA', 'stock create');
  assert(stockCreate.version === 1, 'stock create version was ' + stockCreate.version);
  assert(stockCreate.deleted_at === null, 'stock create unexpectedly returned a tombstone');
  const stockToken1 = rememberToken(tokens, stockCreate, 'stock create');

  assert(scalar([
    ownerClaims,
    "select count(*)::text from public.portfolio_records where user_id = " +
      sqlLiteral(USER_A) + " and record_id = 'stockA';"
  ].join('\n'), 'authenticated own-row SELECT after create') === '1',
    'authenticated could not read its own row');
  assert(scalar([
    rolePrefix('authenticated', USER_B, 'aal2'),
    "select count(*)::text from public.portfolio_records where record_id = 'stockA';"
  ].join('\n'), 'wrong-user RLS SELECT') === '0', 'wrong user saw the owner record');

  const stockUpdate = rpcRow(ownerClaims, 'portfolio_upsert_record',
    recordArgs('stocks', 'stockA', { id: 'stockA', ticker: 'SYN-A-UPDATED' }, 2, 1),
    'authenticated AAL2 update');
  assertRecordEnvelope(stockUpdate, 'stockA', 'stock update');
  assert(stockUpdate.version === 2, 'stock update version was ' + stockUpdate.version);
  assert(stockUpdate.payload.ticker === 'SYN-A-UPDATED', 'stock update payload was not stored');
  const stockToken2 = rememberToken(tokens, stockUpdate, 'stock update');
  assert(stockToken2 > stockToken1, 'server token did not advance on update');

  rpcError(ownerClaims, 'portfolio_upsert_record',
    recordArgs('stocks', 'stockA', { id: 'stockA', ticker: 'STALE' }, 0, 1),
    'stale authenticated update', 'PORTFOLIO_CONFLICT');
  rpcError(rolePrefix('authenticated', USER_A, 'aal1'), 'portfolio_upsert_record',
    recordArgs('stocks', 'stockA', { id: 'stockA', ticker: 'AAL1' }, 0, 2),
    'AAL1 RPC write', 'PORTFOLIO_AAL2_REQUIRED');
  rpcError(rolePrefix('authenticated', USER_B, 'aal2'), 'portfolio_upsert_record',
    recordArgs('stocks', 'wrongUser', { id: 'wrongUser' }, 0, 0),
    'wrong-user RPC write', 'PORTFOLIO_NOT_OWNER');
  rpcError(rolePrefix('authenticated', null, null), 'portfolio_upsert_record',
    recordArgs('stocks', 'noAuth', { id: 'noAuth' }, 0, 0),
    'missing-auth RPC write', 'PORTFOLIO_AUTH_REQUIRED');
  expectSqlFailure([
    rolePrefix('anon', USER_A, 'aal2'),
    'select * from public.portfolio_upsert_record(' +
      recordArgs('stocks', 'anonCall', { id: 'anonCall' }, 0, 0) + ');'
  ].join('\n'), 'anon RPC EXECUTE', '42501');
  expectSqlFailure([
    rolePrefix('service_role', USER_A, 'aal2'),
    'select * from public.portfolio_upsert_record(' +
      recordArgs('stocks', 'serviceCall', { id: 'serviceCall' }, 0, 0) + ');'
  ].join('\n'), 'service_role RPC EXECUTE', '42501');

  const raceSeed = rpcRow(ownerClaims, 'portfolio_upsert_record',
    recordArgs('stocks', 'raceUpdate', { id: 'raceUpdate', writer: 'seed' }, 0, 0),
    'seed concurrent update row');
  rememberToken(tokens, raceSeed, 'concurrent update seed');
  runSql('update public.test_barrier set ready = 0 where id = 1;', 'reset concurrent update barrier');
  const updateWriters = ['update_a', 'update_b'];
  const updateResults = await Promise.all(updateWriters.map(function(writer) {
    return spawnSql(concurrentUpsertSql(writer, 'raceUpdate', 1), 'concurrent update ' + writer);
  }));
  const updateWinnerIndex = updateResults.findIndex(function(result) { return result.code === 0; });
  assert(updateWinnerIndex >= 0, 'concurrent update had no winner');
  assert(updateResults.filter(function(result) { return result.code === 0; }).length === 1,
    'concurrent update had more than one winner');
  const updateWinner = parseChildRow(updateResults[updateWinnerIndex],
    'concurrent update ' + updateWriters[updateWinnerIndex]);
  assert(updateWinner.version === 2, 'concurrent update winner version was ' + updateWinner.version);
  assert(updateWinner.payload.writer === updateWriters[updateWinnerIndex],
    'concurrent update returned a payload from the wrong writer');
  const updateLoserIndex = updateWinnerIndex === 0 ? 1 : 0;
  assertDeniedOutput(updateResults[updateLoserIndex], 'concurrent update loser', 'P0001',
    'PORTFOLIO_CONFLICT');
  const storedUpdate = jsonRows([
    "select payload::text from public.portfolio_records where record_id = 'raceUpdate';"
  ].join('\n'), 'read concurrent update winner payload');
  assert(storedUpdate.length === 1 &&
      storedUpdate[0].writer === updateWriters[updateWinnerIndex],
    'stored concurrent update payload did not match the winning writer');
  rememberToken(tokens, updateWinner, 'concurrent update winner');

  runSql('update public.test_barrier set ready = 0 where id = 1;', 'reset concurrent create barrier');
  const createWriters = ['create_a', 'create_b'];
  const createResults = await Promise.all(createWriters.map(function(writer) {
    return spawnSql(concurrentUpsertSql(writer, 'raceCreate', 0), 'concurrent create ' + writer);
  }));
  const createWinnerIndex = createResults.findIndex(function(result) { return result.code === 0; });
  assert(createWinnerIndex >= 0, 'concurrent create had no winner');
  assert(createResults.filter(function(result) { return result.code === 0; }).length === 1,
    'concurrent create had more than one winner');
  const createWinner = parseChildRow(createResults[createWinnerIndex],
    'concurrent create ' + createWriters[createWinnerIndex]);
  assert(createWinner.version === 1, 'concurrent create winner version was ' + createWinner.version);
  assert(createWinner.payload.writer === createWriters[createWinnerIndex],
    'concurrent create returned a payload from the wrong writer');
  const createLoserIndex = createWinnerIndex === 0 ? 1 : 0;
  assertDeniedOutput(createResults[createLoserIndex], 'concurrent create loser', 'P0001',
    'PORTFOLIO_CONFLICT');
  assert(scalar("select count(*)::text from public.portfolio_records where record_id = 'raceCreate';",
    'concurrent create row count') === '1', 'concurrent create produced more than one row');
  const storedCreate = jsonRows([
    "select payload::text from public.portfolio_records where record_id = 'raceCreate';"
  ].join('\n'), 'read concurrent create winner payload');
  assert(storedCreate.length === 1 &&
      storedCreate[0].writer === createWriters[createWinnerIndex],
    'stored concurrent create payload did not match the winning writer');
  rememberToken(tokens, createWinner, 'concurrent create winner');

  // Regression for cursor loss on late commit. Session A deliberately keeps
  // its write transaction open after allocating its token. Session B starts
  // while A is open, and must wait on the trigger's transaction-scoped
  // advisory lock before it can allocate a later token. After B commits, its
  // own page must already include A, and the stored sequence must follow the
  // real commit order. Without the trigger lock, B commits first and its
  // boundary can permanently skip A.
  const lateA = openSqlSession('late-commit session A');
  lateA.write([
    'begin;',
    rolePrefix('authenticated', USER_A, 'aal2'),
    'select pg_catalog.row_to_json(r)::text',
    "  from public.portfolio_upsert_record('stocks', 'lateA', '" +
      JSON.stringify({ id: 'lateA', writer: 'late_a' }).replace(/'/g, "''") +
      "'::jsonb, 0, 0) as r;",
    "select 'A_READY';"
  ].join('\n') + '\n');
  await lateA.waitFor('A_READY');

  const lateB = openSqlSession('late-commit session B');
  lateB.write([
    'begin;',
    rolePrefix('authenticated', USER_A, 'aal2'),
    "select 'B_STARTED:' || pg_catalog.pg_backend_pid()::text;",
    'select pg_catalog.row_to_json(r)::text',
    "  from public.portfolio_upsert_record('stocks', 'lateB', '" +
      JSON.stringify({ id: 'lateB', writer: 'late_b' }).replace(/'/g, "''") +
      "'::jsonb, 0, 0) as r;",
    "select 'B_BEFORE_COMMIT';",
    'commit;',
    'select \'B_SEES_ROWS:\' || count(*)::text',
    "  from public.portfolio_get_records_page(0::bigint, null::bigint, 500::integer) as r",
    " where r.record_id in ('lateA', 'lateB');",
    "select 'B_DONE';"
  ].join('\n') + '\n');
  const bStartedOutput = await lateB.waitFor('B_STARTED:');
  const bPidMatch = bStartedOutput.match(/B_STARTED:(\d+)/);
  assert(bPidMatch, 'late-commit session B did not expose a backend PID');
  await waitForAdvisoryWait(bPidMatch[1], 'late-commit session B');

  lateA.write("commit;\nselect 'A_COMMITTED';\n");
  lateA.end();
  await lateA.waitFor('A_COMMITTED');
  const lateAResult = await lateA.done;
  assert(lateAResult.code === 0, 'late-commit session A failed: ' + lateAResult.stderr.trim());

  await lateB.waitFor('B_SEES_ROWS:2');
  await lateB.waitFor('B_DONE');
  lateB.end();
  const lateBResult = await lateB.done;
  assert(lateBResult.code === 0, 'late-commit session B failed: ' + lateBResult.stderr.trim());
  const lateRows = jsonRows([
    'select pg_catalog.row_to_json(r)::text',
    'from public.portfolio_records r',
    "where r.record_id in ('lateA', 'lateB')",
    'order by r.change_seq;'
  ].join('\n'), 'read late-commit rows');
  assert(lateRows.length === 2, 'late-commit regression did not store two rows');
  assert(lateRows[0].record_id === 'lateA' && lateRows[1].record_id === 'lateB',
    'late-commit sequence order did not follow commit order');
  const lateAToken = rememberToken(tokens, lateRows[0], 'late-commit A');
  const lateBToken = rememberToken(tokens, lateRows[1], 'late-commit B');
  assert(lateBToken > lateAToken, 'late-commit B token did not follow A token');

  const tombCreate = rpcRow(ownerClaims, 'portfolio_upsert_record',
    recordArgs('stocks', 'trashItem', { id: 'trashItem', label: 'before-delete' }, 4, 0),
    'create tombstone test row');
  const tombCreateToken = rememberToken(tokens, tombCreate, 'tombstone create');
  const tombDelete = rpcRow(ownerClaims, 'portfolio_delete_record',
    deleteArgs('stocks', 'trashItem', 1), 'delete tombstone test row');
  assertRecordEnvelope(tombDelete, 'trashItem', 'tombstone delete');
  assert(tombDelete.version === 2, 'tombstone delete version was ' + tombDelete.version);
  assertNonNull(tombDelete.deleted_at, 'tombstone delete.deleted_at');
  const tombDeleteToken = rememberToken(tokens, tombDelete, 'tombstone delete');
  assert(tombDeleteToken > tombCreateToken, 'tombstone delete token did not advance');
  rpcError(ownerClaims, 'portfolio_restore_record',
    recordArgs('stocks', 'trashItem', { id: 'trashItem', label: 'stale-restore' }, 4, 1),
    'stale tombstone restore', 'PORTFOLIO_CONFLICT');
  rpcError(ownerClaims, 'portfolio_upsert_record',
    recordArgs('stocks', 'trashItem', { id: 'trashItem', label: 'resurrect-by-write' }, 4, 0),
    'tombstoned create', 'PORTFOLIO_TOMBSTONED');
  const tombRestore = rpcRow(ownerClaims, 'portfolio_restore_record',
    recordArgs('stocks', 'trashItem', { id: 'trashItem', label: 'restored' }, 5, 2),
    'restore tombstone test row');
  assertRecordEnvelope(tombRestore, 'trashItem', 'tombstone restore');
  assert(tombRestore.version === 3, 'tombstone restore version was ' + tombRestore.version);
  assert(tombRestore.deleted_at === null, 'restored row retained deleted_at');
  assert(tombRestore.payload.label === 'restored', 'restore payload was not stored');
  rememberToken(tokens, tombRestore, 'tombstone restore');

  const legacyCreate = rpcRow(ownerClaims, 'portfolio_upsert_record',
    recordArgs('stocks', 'legacyItem', { id: 'legacyItem', label: 'legacy' }, 0, 0),
    'create legacy restore row');
  rememberToken(tokens, legacyCreate, 'legacy restore create');
  const legacyDelete = rpcRow(ownerClaims, 'portfolio_delete_record',
    deleteArgs('stocks', 'legacyItem', 1), 'delete legacy restore row');
  rememberToken(tokens, legacyDelete, 'legacy restore delete');
  const legacyRestore = rpcRow(ownerClaims, 'portfolio_restore_record',
    sqlLiteral('stocks') + ', ' + sqlLiteral('legacyItem') + ', 2::bigint',
    'legacy restore overload');
  assertRecordEnvelope(legacyRestore, 'legacyItem', 'legacy restore');
  assert(legacyRestore.payload.label === 'legacy', 'legacy restore did not retain payload');
  assert(legacyRestore.deleted_at === null, 'legacy restore retained deleted_at');
  rememberToken(tokens, legacyRestore, 'legacy restore');

  const pageOne = jsonRows([
    ownerClaims,
    'select pg_catalog.row_to_json(r)::text',
    'from public.portfolio_get_records_page(0::bigint, null::bigint, 1::integer) as r;'
  ].join('\n'), 'first stable snapshot page');
  assert(pageOne.length === 1, 'first stable snapshot page returned ' + pageOne.length + ' rows');
  const snapshotSequence = BigInt(pageOne[0].snapshot_sequence);
  const pageOneToken = BigInt(pageOne[0].change_seq);
  assert(snapshotSequence >= pageOneToken && pageOneToken > 0n,
    'first page returned an invalid snapshot or change token');
  const pageTwo = jsonRows([
    ownerClaims,
    'select pg_catalog.row_to_json(r)::text',
    'from public.portfolio_get_records_page(' + pageOneToken + '::bigint, ' +
      snapshotSequence + '::bigint, 3::integer) as r;'
  ].join('\n'), 'second stable snapshot page');
  assert(pageTwo.length > 0, 'second stable snapshot page was unexpectedly empty');
  for (const row of pageTwo) {
    assert(BigInt(row.change_seq) > pageOneToken &&
        BigInt(row.change_seq) <= snapshotSequence,
      'stable snapshot page returned a row outside cursor bounds');
    assert(BigInt(row.snapshot_sequence) === snapshotSequence,
      'stable snapshot page changed its snapshot token between pages');
  }
  const afterSnapshot = rpcRow(ownerClaims, 'portfolio_upsert_record',
    recordArgs('stocks', 'afterSnapshot', { id: 'afterSnapshot', label: 'after-snapshot' }, 0, 0),
    'create row after stable snapshot');
  const afterSnapshotToken = rememberToken(tokens, afterSnapshot, 'after-snapshot create');
  assert(afterSnapshotToken > snapshotSequence, 'post-snapshot write did not advance token');
  const frozenPage = jsonRows([
    ownerClaims,
    'select pg_catalog.row_to_json(r)::text',
    'from public.portfolio_get_records_page(' + pageOneToken + '::bigint, ' +
      snapshotSequence + '::bigint, 500::integer) as r;'
  ].join('\n'), 'read frozen snapshot after new write');
  assert(!frozenPage.some(function(row) { return row.record_id === 'afterSnapshot'; }),
    'frozen snapshot included a row created after its boundary');
  const freshPage = jsonRows([
    ownerClaims,
    'select pg_catalog.row_to_json(r)::text',
    'from public.portfolio_get_records_page(' + pageOneToken + '::bigint, null::bigint, 500::integer) as r;'
  ].join('\n'), 'read fresh page after new write');
  assert(freshPage.some(function(row) { return row.record_id === 'afterSnapshot'; }),
    'fresh page omitted the post-snapshot row');

  // An update or delete can move an unread row beyond the original snapshot
  // while the client is still paging. The client must retain original S,
  // finish the frozen page, then take a new boundary and catch up >S before it
  // persists that newer boundary. This proves the real PG protocol, including
  // a changed live row and a durable tombstone, without requiring history rows.
  const gapStart = tokens[tokens.length - 1];
  const gapA = rpcRow(ownerClaims, 'portfolio_upsert_record',
    recordArgs('stocks', 'gapA', { id: 'gapA', label: 'page-a' }, 0, 0),
    'create unread-page A');
  const gapAToken = rememberToken(tokens, gapA, 'unread-page A');
  const gapB = rpcRow(ownerClaims, 'portfolio_upsert_record',
    recordArgs('stocks', 'gapB', { id: 'gapB', label: 'page-b-before' }, 0, 0),
    'create unread-page B');
  const gapBToken = rememberToken(tokens, gapB, 'unread-page B');
  const gapC = rpcRow(ownerClaims, 'portfolio_upsert_record',
    recordArgs('stocks', 'gapC', { id: 'gapC', label: 'page-c-before' }, 0, 0),
    'create unread-page C');
  const gapCToken = rememberToken(tokens, gapC, 'unread-page C');
  const gapPageOne = jsonRows([
    ownerClaims,
    'select pg_catalog.row_to_json(r)::text',
    'from public.portfolio_get_records_page(' + gapStart + '::bigint, null::bigint, 1::integer) as r;'
  ].join('\n'), 'first unread-page snapshot page');
  assert(gapPageOne.length === 1 && gapPageOne[0].record_id === 'gapA',
    'first unread-page snapshot did not return gapA');
  const gapSnapshot = BigInt(gapPageOne[0].snapshot_sequence);
  assert(gapSnapshot === gapCToken && gapSnapshot >= gapAToken,
    'unread-page snapshot did not capture the original S boundary');

  const gapBUpdate = rpcRow(ownerClaims, 'portfolio_upsert_record',
    recordArgs('stocks', 'gapB', { id: 'gapB', label: 'page-b-after' }, 1, 1),
    'update unread-page B between pages');
  const gapBUpdateToken = rememberToken(tokens, gapBUpdate, 'unread-page B update');
  const gapCDelete = rpcRow(ownerClaims, 'portfolio_delete_record',
    deleteArgs('stocks', 'gapC', 1), 'delete unread-page C between pages');
  const gapCDeleteToken = rememberToken(tokens, gapCDelete, 'unread-page C delete');
  assert(gapBUpdateToken > gapSnapshot && gapCDeleteToken > gapSnapshot,
    'between-page update or delete did not move beyond original S');

  const gapFrozenPage = jsonRows([
    ownerClaims,
    'select pg_catalog.row_to_json(r)::text',
    'from public.portfolio_get_records_page(' + gapAToken + '::bigint, ' +
      gapSnapshot + '::bigint, 500::integer) as r;'
  ].join('\n'), 'read frozen page after unread update and delete');
  assert(!gapFrozenPage.some(function(row) { return row.record_id === 'gapB' || row.record_id === 'gapC'; }),
    'frozen page incorrectly treated moved unread rows as part of original S');

  const gapCatchupBoundary = BigInt(scalar([
    ownerClaims,
    'select public.portfolio_sync_boundary()::text;'
  ].join('\n'), 'take catch-up boundary after unread update and delete'));
  assert(gapCatchupBoundary >= gapCDeleteToken && gapCatchupBoundary > gapSnapshot,
    'catch-up boundary did not advance beyond original S');
  const gapCatchupPage = jsonRows([
    ownerClaims,
    'select pg_catalog.row_to_json(r)::text',
    'from public.portfolio_get_records_page(' + gapSnapshot + '::bigint, ' +
      gapCatchupBoundary + '::bigint, 500::integer) as r;'
  ].join('\n'), 'catch up unread update and delete before persisting boundary');
  const gapBSeen = gapCatchupPage.find(function(row) { return row.record_id === 'gapB'; });
  const gapCSeen = gapCatchupPage.find(function(row) { return row.record_id === 'gapC'; });
  assert(gapBSeen && gapBSeen.payload.label === 'page-b-after',
    'catch-up page omitted the latest unread update payload');
  assert(gapCSeen && gapCSeen.deleted_at !== null,
    'catch-up page omitted the durable unread delete tombstone');
  for (const row of [gapBSeen, gapCSeen]) {
    assert(BigInt(row.change_seq) > gapSnapshot && BigInt(row.change_seq) <= gapCatchupBoundary,
      'catch-up row fell outside the >S and <=boundary range');
    assert(BigInt(row.snapshot_sequence) === gapCatchupBoundary,
      'catch-up row did not carry the current catch-up boundary');
  }

  rpcError(ownerClaims, 'portfolio_get_records_page',
    (snapshotSequence + 1n) + '::bigint, ' + snapshotSequence + '::bigint, 10::integer',
    'cursor beyond snapshot', 'PORTFOLIO_INVALID_CURSOR');
  rpcError(ownerClaims, 'portfolio_get_records_page',
    '0::bigint, null::bigint, 0::integer',
    'invalid page limit', 'PORTFOLIO_INVALID_LIMIT');
  assert(BigInt(scalar([
    ownerClaims,
    'select public.portfolio_sync_boundary()::text;'
  ].join('\n'), 'authenticated sync boundary')) >= afterSnapshotToken,
    'sync boundary did not reach latest token');
  expectSqlFailure([
    ownerClaims,
    'select * from public.portfolio_sync_page(0::bigint, 10::integer);'
  ].join('\n'), 'internal sync_page RPC', '42501');

  const finalCreate = rpcRow(ownerClaims, 'portfolio_upsert_record',
    recordArgs('stocks', 'finalTombstone', { id: 'finalTombstone', label: 'durable' }, 0, 0),
    'create final durable tombstone row');
  rememberToken(tokens, finalCreate, 'final tombstone create');
  const finalDelete = rpcRow(ownerClaims, 'portfolio_delete_record',
    deleteArgs('stocks', 'finalTombstone', 1), 'create final durable tombstone');
  const finalToken = rememberToken(tokens, finalDelete, 'final tombstone delete');
  assertNonNull(finalDelete.deleted_at, 'final tombstone deleted_at');
  const durable = jsonRows([
    'select pg_catalog.row_to_json(r)::text',
    'from public.portfolio_records r',
    'where r.user_id = ' + sqlLiteral(USER_A) + " and r.record_id = 'finalTombstone';"
  ].join('\n'), 'read durable tombstone as administrator');
  assert(durable.length === 1 && durable[0].deleted_at !== null,
    'delete removed the durable tombstone row');
  const durablePage = jsonRows([
    ownerClaims,
    'select pg_catalog.row_to_json(r)::text',
    'from public.portfolio_get_records_page(0::bigint, null::bigint, 500::integer) as r;'
  ].join('\n'), 'read durable tombstone through page RPC');
  const durablePageRow = durablePage.find(function(row) { return row.record_id === 'finalTombstone'; });
  assert(durablePageRow && durablePageRow.deleted_at !== null,
    'authenticated pagination omitted the durable tombstone');
  assert(BigInt(durablePageRow.change_seq) === finalToken,
    'durable tombstone returned a different server change token');

  const clusterSize = pathSizeBytes(clusterDir);
  assert(clusterSize <= MAX_CLUSTER_BYTES,
    'PostgreSQL cluster exceeded 200 MiB: ' + clusterSize + ' bytes');
  const freeAfter = freeBytesAt(os.tmpdir());
  assert(freeAfter >= MIN_FREE_BYTES,
    'less than 1 GiB free at ' + os.tmpdir() + ' after tests: ' + freeAfter);
  assert(cleanup(), 'temporary PostgreSQL cluster cleanup was not verified');
  console.log('PASS: Portfolio PostgreSQL schema, synthetic Auth fixture boundary, grants, forced RLS, AAL2, CAS, tombstones, cursors and concurrency contracts (cluster ' +
    clusterSize + ' bytes, ' + tokens.length + ' monotonic tokens)');
}

process.on('exit', cleanup);
process.on('SIGINT', function() { cleanup(); process.exit(130); });
process.on('SIGTERM', function() { cleanup(); process.exit(143); });

main().catch(function(error) {
  console.error('FAIL: ' + error.message);
  process.exitCode = 1;
});
