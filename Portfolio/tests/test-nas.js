'use strict';

/*
 * The NAS controller is deliberately tested with small in-memory doubles.
 * These doubles model the Supabase response envelope, including RPC errors,
 * but never contain a real token or a real account.
 */
const assert = require('assert');
const nas = require('../Worker/kjr-nas.js');

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER_USER = '22222222-2222-4222-8222-222222222222';

const ARRAY_TYPES = [
  'stocks', 'stockTxns', 'watchlist', 'crypto', 'realestate', 'cash',
  'cashTxns', 'cpfHistory', 'income', 'expenses', 'snapshots', 'trash',
  'insurance', 'insuranceRiders'
];
const SINGLETON_TYPES = ['cpfBalances', 'categories', 'settings', '_meta'];

function makeStorage() {
  const map = new Map();
  const calls = [];
  const storage = {
    isProtectedStorage: true,
    map,
    calls,
    deferSet: null,
    deferRemove: null,
    getItem(key) {
      calls.push({ op: 'get', key });
      return map.has(key) ? map.get(key) : null;
    },
    setItem(key, value) {
      calls.push({ op: 'set', key, value });
      if (storage.deferSet) return storage.deferSet(key, value);
      map.set(key, String(value));
    },
    removeItem(key) {
      calls.push({ op: 'remove', key });
      if (storage.deferRemove) return storage.deferRemove(key);
      map.delete(key);
    },
    seed(key, value) {
      map.set(key, typeof value === 'string' ? value : JSON.stringify(value));
    }
  };
  return storage;
}

function makeAuth(userId = USER, aal = 'aal2') {
  const calls = [];
  const auth = {
    calls,
    user: { id: userId },
    aal,
    signOutError: null,
    getUser: async () => ({ data: { user: auth.user }, error: null }),
    signInWithPassword: async (args) => {
      calls.push({ method: 'signInWithPassword', args });
      return { data: { user: auth.user, session: { access_token: 'do-not-store' } }, error: null };
    },
    signOut: async (args) => {
      calls.push({ method: 'signOut', args });
      if (auth.signOutError) throw auth.signOutError;
      return { data: null, error: null };
    },
    mfa: {
      getAuthenticatorAssuranceLevel: async () => ({
        data: { currentLevel: auth.aal, nextLevel: auth.aal },
        error: null
      }),
      listFactors: async () => ({
        data: {
          all: [
            { id: 'phone-a', factor_type: 'phone', status: 'verified' },
            { id: 'totp-a', factor_type: 'totp', status: 'verified', secret: 'hidden' }
          ]
        },
        error: null
      }),
      enroll: async (args) => {
        calls.push({ method: 'enroll', args });
        return {
          data: {
            id: 'totp-new',
            type: 'totp',
            totp: {
              secret: 'one-time-secret',
              qr_code: 'one-time-qr',
              uri: 'otpauth://totp/Kujira:owner'
            }
          },
          error: null
        };
      },
      challengeAndVerify: async (args) => {
        calls.push({ method: 'challengeAndVerify', args });
        return { data: { session: { access_token: 'do-not-store' } }, error: null };
      }
    }
  };
  return auth;
}

function makeClient(auth, routes = {}) {
  const calls = [];
  const client = {
    auth,
    calls,
    async rpc(name, args) {
      calls.push({ name, args });
      if (!Object.prototype.hasOwnProperty.call(routes, name)) {
        return { data: [], error: null };
      }
      const route = routes[name];
      if (typeof route === 'function') return route(args, calls);
      if (route && route.error) return { data: null, error: route.error };
      return { data: route, error: null };
    }
  };
  return client;
}

function makeMigration() {
  return {
    planLegacyImport(db) {
      if (!db || !Array.isArray(db.records)) throw new Error('bad import');
      return {
        formatVersion: 1,
        records: db.records,
        sourceHash: 'source-hash',
        recordsHash: 'records-hash'
      };
    }
  };
}

function makeController({ auth = makeAuth(), routes = {}, storage = makeStorage(), encryption, now, isLocalPreview, signOutFlushTimeoutMs } = {}) {
  const client = makeClient(auth, routes);
  const controller = nas.createController({
    client,
    storage,
    migration: makeMigration(),
    encryption: encryption || { isEnabled: () => true, isUnlocked: () => true },
    now: now || (() => '2026-09-04T12:00:00.000Z'),
    isLocalPreview,
    signOutFlushTimeoutMs
  });
  return { controller, client, auth, storage };
}

function key(userId, suffix) {
  return `kjr-pf-nas-v1:${userId}:${suffix}`;
}

function legacy(type, id, payload, position = 0) {
  return { recordType: type, recordId: id, payload, position };
}

function serverRow({
  userId = USER,
  type = 'stocks',
  id = 'stock-a',
  payload = { id: 'stock-a', ticker: 'AAA' },
  position = 0,
  version = 1,
  seq = 1,
  snapshotSequence = 4,
  deletedAt = null
} = {}) {
  return {
    user_id: userId,
    record_type: type,
    record_id: id,
    payload,
    position,
    version,
    change_seq: seq,
    snapshot_sequence: snapshotSequence,
    created_at: '2026-09-04T00:00:00.000Z',
    updated_at: '2026-09-04T00:00:00.000Z',
    deleted_at: deletedAt
  };
}

function planDb(records) {
  return { records };
}

async function rejectsCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert(error instanceof Error);
    assert.strictEqual(error.code, `PORTFOLIO_NAS_${code}`);
    assert(!/secret|token|password|123456/i.test(error.message));
    return true;
  });
}

async function expectOwnerHydrateFailure(rows, expectedCode, setup, boundary = 1) {
  const storage = makeStorage();
  storage.seed(key(USER, 'records'), { untouched: true });
  const before = Array.from(storage.map.entries());
  const auth = makeAuth();
  const routes = {
    portfolio_sync_boundary: boundary,
    portfolio_get_records_page: () => rows
  };
  const made = makeController({ auth, routes, storage });
  if (setup) setup(made);
  await rejectsCode(made.controller.hydrate(), expectedCode);
  assert.deepStrictEqual(Array.from(storage.map.entries()), before);
  assert.strictEqual(storage.calls.some((call) => call.op === 'get'), false,
    'failed owner gate or invalid pages must not read cache');
}

async function run() {
  let passed = 0;
  async function test(name, fn) {
    await fn();
    passed += 1;
    console.log(`PASS: ${name}`);
  }

  await test('AAL1, non-owner and boundary failures cannot read finance storage', async () => {
    const lockedStorage = makeStorage();
    lockedStorage.seed(key(USER, 'records'), { rows: [] });
    const aal1 = makeController({ auth: makeAuth(USER, 'aal1'), storage: lockedStorage });
    await rejectsCode(aal1.controller.hydrate(), 'AAL2_REQUIRED');
    assert.strictEqual(lockedStorage.calls.some((call) => call.op === 'get'), false);

    const boundaryStorage = makeStorage();
    boundaryStorage.seed(key(USER, 'records'), { rows: [] });
    const boundaryError = makeController({
      auth: makeAuth(),
      storage: boundaryStorage,
      routes: { portfolio_sync_boundary: { error: { code: 'NETWORK_DOWN' } } }
    });
    await rejectsCode(boundaryError.controller.hydrate(), 'BOUNDARY_FAILED');
    assert.strictEqual(boundaryStorage.calls.some((call) => call.op === 'get'), false);

    const nonOwnerStorage = makeStorage();
    nonOwnerStorage.seed(key(OTHER_USER, 'records'), { rows: [] });
    const nonOwner = makeController({
      auth: makeAuth(OTHER_USER),
      storage: nonOwnerStorage,
      routes: { portfolio_sync_boundary: { error: { code: 'PORTFOLIO_NOT_OWNER' } } }
    });
    await rejectsCode(nonOwner.controller.hydrate(), 'BOUNDARY_FAILED');
    assert.strictEqual(nonOwnerStorage.calls.some((call) => call.op === 'get'), false);
  });

  await test('AAL2 owner hydrates ordered pages, singleton values and sync metadata', async () => {
    const rows = [
      serverRow({ type: 'stocks', id: 'stock-b', payload: { id: 'stock-b' }, position: 1, seq: 1 }),
      serverRow({ type: 'settings', id: 'singleton', payload: { theme: 'dark' }, seq: 2 }),
      serverRow({ type: '_syncMeta', id: 'singleton', payload: { schemaVersion: 9 }, seq: 3 }),
      serverRow({ type: 'stocks', id: 'stock-a', payload: { id: 'stock-a' }, position: 0, seq: 4 })
    ];
    const routes = {
      portfolio_sync_boundary: 4,
      portfolio_get_records_page: (args) => args.p_after_change_seq === 0 ? rows.slice(0, 2) : rows.slice(2)
    };
    const made = makeController({ routes });
    const db = await made.controller.hydrate();
    assert.deepStrictEqual(db.stocks.map((stock) => stock.id), ['stock-a', 'stock-b']);
    assert.deepStrictEqual(db.settings, { theme: 'dark' });
    assert.strictEqual(db.schemaVersion, 9);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(db, '_syncMeta'), false);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(db, '_priceCache'), false);
    assert.strictEqual(made.storage.map.has(key(USER, 'records')), true);
    assert.strictEqual(made.storage.map.has(key(USER, 'cursor')), true);
    const pageCalls = made.client.calls.filter((call) => call.name === 'portfolio_get_records_page');
    assert.deepStrictEqual(pageCalls.map((call) => call.args), [
      { p_after_change_seq: 0, p_snapshot_sequence: null, p_limit: 200 },
      { p_after_change_seq: 2, p_snapshot_sequence: 4, p_limit: 200 }
    ]);
  });

  await test('paginated hydrate carries one snapshot boundary and rejects between-page changes', async () => {
    const first = serverRow({ id: 'snap-a', payload: { id: 'snap-a' }, seq: 1, snapshotSequence: 2 });
    const second = serverRow({ id: 'snap-b', payload: { id: 'snap-b' }, seq: 2, snapshotSequence: 2 });
    const missingSecond = Object.assign({}, second);
    delete missingSecond.snapshot_sequence;
    const success = makeController({
      routes: {
        portfolio_sync_boundary: 2,
        portfolio_get_records_page: (args) => args.p_after_change_seq === 0
          ? [first]
          : [second]
      }
    });
    await success.controller.hydrate();
    const successPages = success.client.calls.filter((call) => call.name === 'portfolio_get_records_page');
    assert.deepStrictEqual(successPages[0].args, {
      p_after_change_seq: 0,
      p_snapshot_sequence: null,
      p_limit: 200
    });
    assert.deepStrictEqual(successPages[1].args, {
      p_after_change_seq: 1,
      p_limit: 200,
      p_snapshot_sequence: 2
    });

    const changedStorage = makeStorage();
    changedStorage.seed(key(USER, 'records'), 'unchanged-record-cache');
    const changed = makeController({
      storage: changedStorage,
      routes: {
        portfolio_sync_boundary: 2,
        portfolio_get_records_page: (args) => args.p_after_change_seq === 0
          ? [first]
          : [serverRow({ id: 'snap-b', payload: { id: 'snap-b' }, seq: 2, snapshotSequence: 3 })]
      }
    });
    await rejectsCode(changed.controller.hydrate(), 'SNAPSHOT_CHANGED');
    assert.strictEqual(changedStorage.map.get(key(USER, 'records')), 'unchanged-record-cache');

    const missing = makeController({
      routes: {
        portfolio_sync_boundary: 2,
        portfolio_get_records_page: (args) => args.p_after_change_seq === 0
          ? [first]
          : [missingSecond]
      }
    });
    await rejectsCode(missing.controller.hydrate(), 'SNAPSHOT_MISSING');

    const regressing = makeController({
      routes: {
        portfolio_sync_boundary: 2,
        portfolio_get_records_page: (args) => args.p_after_change_seq === 0
          ? [first]
          : [serverRow({ id: 'snap-b', payload: { id: 'snap-b' }, seq: 2, snapshotSequence: 1 })]
      }
    });
    await rejectsCode(regressing.controller.hydrate(), 'SNAPSHOT_REGRESSION');

    const empty = makeController({
      routes: { portfolio_sync_boundary: 7, portfolio_get_records_page: [] }
    });
    const emptyDb = await empty.controller.hydrate();
    assert.deepStrictEqual(emptyDb.stocks, []);
    assert.deepStrictEqual(empty.client.calls.filter((call) => call.name === 'portfolio_get_records_page')[0].args, {
      p_after_change_seq: 0,
      p_snapshot_sequence: null,
      p_limit: 200
    });
    assert.strictEqual(empty.controller.getStatus().cursor, 7);
  });

  await test('hydrate catches an update or tombstone that moves beyond the original snapshot between pages', async () => {
    const first = serverRow({ id: 'race-a', payload: { id: 'race-a', label: 'first' }, seq: 1, snapshotSequence: 2 });
    const updated = serverRow({ id: 'race-b', payload: { id: 'race-b', label: 'updated' }, version: 2, seq: 3, snapshotSequence: 3 });
    const updatedCalls = [];
    const updatedMade = makeController({
      routes: {
        portfolio_sync_boundary: 2,
        portfolio_get_records_page: (args) => {
          updatedCalls.push(args);
          if (args.p_after_change_seq === 0) return [first];
          if (args.p_after_change_seq === 1) return [];
          if (args.p_after_change_seq === 2) return [updated];
          return [];
        }
      }
    });
    const updatedDb = await updatedMade.controller.hydrate();
    assert.deepStrictEqual(updatedDb.stocks.map((stock) => stock.id), ['race-a', 'race-b']);
    assert.strictEqual(updatedDb.stocks.find((stock) => stock.id === 'race-b').label, 'updated');
    assert.strictEqual(updatedMade.controller.getStatus().cursor, 3);
    assert.deepStrictEqual(updatedCalls.map((args) => args.p_after_change_seq), [0, 1, 2, 3, 3]);
    assert.strictEqual(updatedCalls.some((args) => Object.prototype.hasOwnProperty.call(args, 'p_snapshot_sequence') && args.p_snapshot_sequence === 4), false);

    const tombstone = serverRow({
      id: 'race-b', payload: { id: 'race-b', label: 'before-delete' }, version: 2, seq: 3,
      snapshotSequence: 3, deletedAt: '2026-09-04T01:00:00.000Z'
    });
    const deleteCalls = [];
    const deletedMade = makeController({
      routes: {
        portfolio_sync_boundary: 2,
        portfolio_get_records_page: (args) => {
          deleteCalls.push(args);
          if (args.p_after_change_seq === 0) return [first];
          if (args.p_after_change_seq === 1) return [];
          if (args.p_after_change_seq === 2) return [tombstone];
          return [];
        }
      }
    });
    const deletedDb = await deletedMade.controller.hydrate();
    assert.deepStrictEqual(deletedDb.stocks.map((stock) => stock.id), ['race-a']);
    assert.strictEqual(deletedMade.controller.getStatus().cursor, 3);
    assert.deepStrictEqual(deleteCalls.map((args) => args.p_after_change_seq), [0, 1, 2, 3, 3]);
  });

  await test('wrong-user, malformed, duplicate and cursor-regression pages do not mutate cache', async () => {
    await expectOwnerHydrateFailure([serverRow({ userId: OTHER_USER })], 'WRONG_USER');
    await expectOwnerHydrateFailure([serverRow({ payload: [] })], 'MALFORMED_ROW');
    const duplicate = [serverRow({ seq: 1 }), serverRow({ seq: 2 })];
    await expectOwnerHydrateFailure(duplicate, 'DUPLICATE_RECORD', null, 2);
    const regression = [
      serverRow({ seq: 2 }),
      serverRow({ seq: 1, id: 'stock-b', payload: { id: 'stock-b' } })
    ];
    await expectOwnerHydrateFailure(regression, 'CURSOR_REGRESSION');
  });

  await test('canonical UUIDs and record envelope identities are enforced before mutation', async () => {
    const badAuth = makeAuth('not-a-canonical-uuid');
    const badUser = makeController({ auth: badAuth });
    await rejectsCode(badUser.controller.hydrate(), 'UNSAFE_USER');
    assert.strictEqual(badUser.client.calls.some((call) => call.name === 'portfolio_sync_boundary'), false);
    assert.strictEqual(badUser.storage.calls.length, 0);

    const invalidImports = [
      [legacy('stocks', 'a:b', { id: 'a:b' })],
      [legacy('stocks', 'a'.repeat(65), { id: 'a'.repeat(65) })],
      [legacy('stocks', 'stock-a', { ticker: 'AAA' })],
      [legacy('stocks', 'stock-a', { id: 'stock-b' })],
      [legacy('settings', 'settings-a', { theme: 'dark' })],
      [legacy('settings', 'singleton', { theme: 'dark' }, 1)]
    ];
    for (const records of invalidImports) {
      const made = makeController();
      await rejectsCode(made.controller.stage(planDb(records)), 'IMPORT_INVALID');
      assert.strictEqual(made.client.calls.length, 0);
      assert.strictEqual(made.storage.calls.length, 0);
    }

    await expectOwnerHydrateFailure(
      [serverRow({ payload: { ticker: 'AAA' } })], 'MALFORMED_ROW'
    );
    await expectOwnerHydrateFailure(
      [serverRow({ payload: { id: 'stock-b' } })], 'MALFORMED_ROW'
    );
    await expectOwnerHydrateFailure(
      [serverRow({ type: 'settings', id: 'settings-a', payload: { theme: 'dark' } })],
      'MALFORMED_ROW'
    );
    await expectOwnerHydrateFailure(
      [serverRow({ type: 'settings', id: 'singleton', payload: { theme: 'dark' }, position: 1 })],
      'MALFORMED_ROW'
    );
  });

  await test('identity change never deletes the prior user namespace before owner verification', async () => {
    const auth = makeAuth();
    const storage = makeStorage();
    const made = makeController({
      auth,
      storage,
      routes: {
        portfolio_sync_boundary: 1,
        portfolio_get_records_page: [serverRow({
          id: 'owned-a', payload: { id: 'owned-a' }, snapshotSequence: 1
        })]
      }
    });
    await made.controller.hydrate();
    storage.seed(key(USER, 'queue'), 'owner-queue-bytes');
    storage.seed(key(USER, 'recovery'), 'owner-recovery-bytes');
    const before = ['records', 'queue', 'recovery', 'cursor']
      .map((suffix) => [suffix, storage.map.get(key(USER, suffix))]);
    auth.user = { id: OTHER_USER };
    made.client.rpc = async (name) => {
      if (name === 'portfolio_sync_boundary') {
        return { data: null, error: { code: 'PORTFOLIO_NOT_OWNER' } };
      }
      throw new Error('page must not be reached');
    };
    await rejectsCode(made.controller.cached(), 'BOUNDARY_FAILED');
    assert.deepStrictEqual(
      before.map(([suffix]) => [suffix, storage.map.get(key(USER, suffix))]),
      before
    );
  });

  await test('exact user namespace and encryption lock fail closed', async () => {
    const made = makeController({
      routes: { portfolio_sync_boundary: 0 }
    });
    await made.controller.hydrate();
    const keys = Array.from(made.storage.map.keys());
    assert.deepStrictEqual(keys.sort(), [key(USER, 'cursor'), key(USER, 'records')].sort());
    const lockedStorage = makeStorage();
    const encryption = { isEnabled: () => true, isUnlocked: () => false };
    const locked = makeController({ storage: lockedStorage, encryption });
    await rejectsCode(locked.controller.cached(), 'ENCRYPTION_LOCKED');
    assert.strictEqual(lockedStorage.calls.length, 0);
  });

  await test('native storage-shaped adapters are rejected without key access', async () => {
    const calls = [];
    const nativeStorage = {
      getItem(key) { calls.push(['get', key]); return null; },
      setItem(key, value) { calls.push(['set', key, value]); },
      removeItem(key) { calls.push(['remove', key]); }
    };
    assert.throws(() => nas.createController({
      client: makeClient(makeAuth()),
      storage: nativeStorage,
      migration: makeMigration(),
      encryption: { isEnabled: () => true, isUnlocked: () => true }
    }), (error) => error && error.code === 'PORTFOLIO_NAS_PROTECTED_STORAGE_REQUIRED');
    assert.deepStrictEqual(calls, []);
  });

  await test('pending owner gate returns detached desired state without hydration or writes', async () => {
    const initial = makeController({ routes: { portfolio_sync_boundary: 0 } });
    await initial.controller.hydrate();
    await initial.controller.stage(planDb([
      legacy('stocks', 'pending-b', { id: 'pending-b', amount: 2 }, 1),
      legacy('stocks', 'pending-a', { id: 'pending-a', amount: 1 }, 0),
      legacy('settings', 'singleton', { theme: 'dark' }, 0),
      legacy('_syncMeta', 'singleton', { schemaVersion: 10 }, 0)
    ]));
    const beforeRecords = initial.storage.map.get(key(USER, 'records'));
    const second = makeController({
      storage: initial.storage,
      routes: { portfolio_sync_boundary: 0 }
    });
    const pending = await second.controller.pending();
    assert.strictEqual(pending.count, 4);
    assert.deepStrictEqual(pending.desiredDb.stocks.map((stock) => stock.id), ['pending-a', 'pending-b']);
    assert.deepStrictEqual(pending.desiredDb.settings, { theme: 'dark' });
    assert.strictEqual(pending.desiredDb.schemaVersion, 10);
    pending.desiredDb.stocks[0].amount = 999;
    const secondPending = await second.controller.pending();
    assert.strictEqual(secondPending.desiredDb.stocks[0].amount, 1);
    assert.strictEqual(initial.storage.map.get(key(USER, 'records')), beforeRecords);
    assert.deepStrictEqual(
      second.client.calls.filter((call) => call.name).map((call) => call.name),
      ['portfolio_sync_boundary', 'portfolio_sync_boundary']
    );
    assert.strictEqual(second.client.calls.some((call) => call.name === 'portfolio_get_records_page'), false);
    assert.strictEqual(second.client.calls.some((call) => call.name !== 'portfolio_sync_boundary'), false);

    const emptyStorage = makeStorage();
    emptyStorage.seed(key(USER, 'queue'), { generation: 2, desiredRecords: [], operations: [] });
    const empty = makeController({
      storage: emptyStorage,
      routes: { portfolio_sync_boundary: 0 }
    });
    assert.deepStrictEqual(await empty.controller.pending(), { count: 0, desiredDb: null });

    const lockedStorage = makeStorage();
    lockedStorage.seed(key(USER, 'queue'), { generation: 1, desiredRecords: [], operations: [] });
    const locked = makeController({
      storage: lockedStorage,
      auth: makeAuth(USER, 'aal1'),
      routes: { portfolio_sync_boundary: 0 }
    });
    await rejectsCode(locked.controller.pending(), 'AAL2_REQUIRED');
    assert.strictEqual(lockedStorage.calls.some((call) => call.op === 'get'), false);
  });

  await test('rebasePending recovers desired state, hydrates once and re-stages without record writes', async () => {
    const initialRow = serverRow({
      id: 'conflict-a',
      payload: { id: 'conflict-a', amount: 1 },
      version: 1,
      seq: 1,
      snapshotSequence: 1
    });
    const made = makeController({
      routes: { portfolio_sync_boundary: 1, portfolio_get_records_page: [initialRow] }
    });
    await made.controller.hydrate();
    await made.controller.stage(planDb([
      legacy('stocks', 'conflict-a', { id: 'conflict-a', amount: 2 })
    ]));
    const calls = [];
    made.client.rpc = async (name, args) => {
      calls.push({ name, args });
      if (name === 'portfolio_sync_boundary') return { data: 2, error: null };
      if (name === 'portfolio_get_records_page') {
        return [serverRow({
          id: 'conflict-a',
          payload: { id: 'conflict-a', amount: 3 },
          version: 2,
          seq: 2,
          snapshotSequence: 2
        })];
      }
      throw new Error('record write must not be reached');
    };
    const result = await made.controller.rebasePending();
    assert.strictEqual(result.count, 1);
    assert.strictEqual(result.desiredDb.stocks[0].amount, 2);
    assert.deepStrictEqual(calls.map((call) => call.name), [
      'portfolio_sync_boundary', 'portfolio_get_records_page'
    ]);
    assert.deepStrictEqual(calls[1].args, {
      p_after_change_seq: 0,
      p_snapshot_sequence: null,
      p_limit: 200
    });
    const queue = JSON.parse(made.storage.map.get(key(USER, 'queue')));
    assert.strictEqual(queue.generation, 2);
    assert.deepStrictEqual(queue.operations.map((op) => [op.kind, op.expectedVersion]), [
      ['upsert', 2]
    ]);
    const recovery = JSON.parse(made.storage.map.get(key(USER, 'recovery')));
    assert.strictEqual(recovery.length, 1);
    assert.strictEqual(recovery[0].reason, 'conflict');
    assert.strictEqual(recovery[0].db.stocks[0].amount, 2);
    assert.strictEqual(JSON.parse(made.storage.map.get(key(USER, 'records'))).baseline[0].payload.amount, 3);
  });

  await test('discardPending recovers desired state before durable queue removal and retains it on hydrate failure', async () => {
    const initialRow = serverRow({
      id: 'discard-a',
      payload: { id: 'discard-a', amount: 1 },
      version: 1,
      seq: 1,
      snapshotSequence: 1
    });
    const made = makeController({
      routes: { portfolio_sync_boundary: 1, portfolio_get_records_page: [initialRow] }
    });
    await made.controller.hydrate();
    await made.controller.stage(planDb([
      legacy('stocks', 'discard-a', { id: 'discard-a', amount: 2 })
    ]));
    const calls = [];
    made.client.rpc = async (name, args) => {
      calls.push({ name, args });
      if (name === 'portfolio_sync_boundary') return { data: 2, error: null };
      if (name === 'portfolio_get_records_page') {
        return [serverRow({
          id: 'discard-a',
          payload: { id: 'discard-a', amount: 3 },
          version: 2,
          seq: 2,
          snapshotSequence: 2
        })];
      }
      throw new Error('record write must not be reached');
    };
    const db = await made.controller.discardPending();
    assert.strictEqual(db.stocks[0].amount, 3);
    assert.deepStrictEqual(calls.map((call) => call.name), [
      'portfolio_sync_boundary', 'portfolio_get_records_page'
    ]);
    assert.strictEqual(made.storage.map.has(key(USER, 'queue')), false);
    const recovery = JSON.parse(made.storage.map.get(key(USER, 'recovery')));
    assert.strictEqual(recovery.length, 1);
    assert.strictEqual(recovery[0].db.stocks[0].amount, 2);

    const failing = makeController({
      routes: {
        portfolio_sync_boundary: 0,
        portfolio_get_records_page: []
      }
    });
    await failing.controller.hydrate();
    await failing.controller.stage(planDb([
      legacy('stocks', 'discard-fail', { id: 'discard-fail' })
    ]));
    const originalQueue = failing.storage.map.get(key(USER, 'queue'));
    failing.client.rpc = async (name) => {
      if (name === 'portfolio_sync_boundary') return { data: 0, error: null };
      return { data: null, error: { code: 'TEMPORARY_NETWORK' } };
    };
    await rejectsCode(failing.controller.discardPending(), 'RPC_FAILED');
    assert.strictEqual(failing.storage.map.get(key(USER, 'queue')), originalQueue);
  });

  await test('verified session stages offline, then flush performs a fresh live owner gate', async () => {
    const made = makeController({ routes: { portfolio_sync_boundary: 0 } });
    await made.controller.hydrate();
    made.client.calls.length = 0;
    let offlineNetworkAttempts = 0;
    made.auth.getUser = async () => {
      offlineNetworkAttempts += 1;
      throw new Error('offline');
    };
    made.auth.mfa.getAuthenticatorAssuranceLevel = async () => {
      offlineNetworkAttempts += 1;
      throw new Error('offline');
    };
    made.client.rpc = async () => {
      offlineNetworkAttempts += 1;
      throw new Error('offline');
    };
    const staged = await made.controller.stage(planDb([
      legacy('stocks', 'offline-a', { id: 'offline-a', amount: 1 })
    ]));
    assert.strictEqual(staged.operations.length, 1);
    assert.strictEqual(offlineNetworkAttempts, 0);
    assert.strictEqual(made.client.calls.length, 0);
    assert.strictEqual(made.storage.map.has(key(USER, 'queue')), true);

    let liveUserCalls = 0;
    made.auth.getUser = async () => {
      liveUserCalls += 1;
      return { data: { user: made.auth.user }, error: null };
    };
    made.auth.mfa.getAuthenticatorAssuranceLevel = async () => ({
      data: { currentLevel: 'aal2', nextLevel: 'aal2' }, error: null
    });
    const flushedCalls = [];
    made.client.rpc = async (name, args) => {
      flushedCalls.push({ name, args });
      if (name === 'portfolio_sync_boundary') return { data: 0, error: null };
      return {
        data: [serverRow({
          id: args.p_record_id,
          payload: args.p_payload,
          version: 1,
          seq: 1
        })],
        error: null
      };
    };
    await made.controller.flush();
    assert.strictEqual(liveUserCalls, 1);
    assert.deepStrictEqual(flushedCalls.map((call) => call.name), [
      'portfolio_sync_boundary', 'portfolio_upsert_record'
    ]);
  });

  await test('stage and flush await protected queue durability before reporting or writing remotely', async () => {
    const made = makeController({ routes: { portfolio_sync_boundary: 0 } });
    await made.controller.hydrate();
    made.client.calls.length = 0;
    let releaseQueue;
    let queueWriteStartedResolve;
    const queueWriteStarted = new Promise((resolve) => { queueWriteStartedResolve = resolve; });
    let queueReleased = false;
    made.storage.deferSet = (key, value) => {
      if (!key.endsWith(':queue') || queueReleased) {
        made.storage.map.set(key, String(value));
        return undefined;
      }
      queueWriteStartedResolve();
      return new Promise((resolve) => {
        releaseQueue = () => {
          queueReleased = true;
          made.storage.map.set(key, String(value));
          resolve();
        };
      });
    };
    const remoteCalls = [];
    made.client.rpc = async (name, args) => {
      remoteCalls.push({ name, args });
      if (name === 'portfolio_sync_boundary') return { data: 0, error: null };
      return {
        data: [serverRow({
          id: args.p_record_id,
          payload: args.p_payload,
          seq: 1,
          snapshotSequence: 1
        })],
        error: null
      };
    };
    let stageResolved = false;
    const staging = made.controller.stage(planDb([
      legacy('stocks', 'durable-a', { id: 'durable-a', amount: 1 })
    ])).then((value) => {
      stageResolved = true;
      return value;
    });
    await queueWriteStarted;
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(stageResolved, false);
    const flushing = made.controller.flush();
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(stageResolved, false);
    assert.deepStrictEqual(remoteCalls, []);
    releaseQueue();
    await staging;
    await flushing;
    assert.deepStrictEqual(remoteCalls.map((call) => call.name), [
      'portfolio_sync_boundary', 'portfolio_upsert_record'
    ]);
  });

  await test('preview guard blocks controller auth and every protected write before side effects', async () => {
    const made = makeController({ isLocalPreview: () => true });
    await rejectsCode(made.controller.getAssurance(), 'PREVIEW_BLOCKED');
    await rejectsCode(made.controller.listTotpFactors(), 'PREVIEW_BLOCKED');
    await rejectsCode(made.controller.pending(), 'PREVIEW_BLOCKED');
    await rejectsCode(made.controller.signInWithPassword('owner@example.com', 'private-password'), 'PREVIEW_BLOCKED');
    await rejectsCode(made.controller.stage(planDb([
      legacy('stocks', 'preview-a', { id: 'preview-a' })
    ])), 'PREVIEW_BLOCKED');
    await rejectsCode(made.controller.flush(), 'PREVIEW_BLOCKED');
    await rejectsCode(made.controller.stashRecovery(planDb([
      legacy('stocks', 'preview-a', { id: 'preview-a' })
    ]), 'before-import'), 'PREVIEW_BLOCKED');
    await rejectsCode(made.controller.signOut(), 'PREVIEW_BLOCKED');
    assert.deepStrictEqual(made.auth.calls, []);
    assert.deepStrictEqual(made.client.calls, []);
    assert.strictEqual(made.storage.calls.some((call) => call.op === 'set' || call.op === 'remove'), false);
  });

  await test('controller waits for the encrypted vault flush before reporting a durable queue', async () => {
    let block = false;
    let release;
    let flushStartedResolve;
    const deferred = new Promise((resolve) => { release = resolve; });
    const flushStarted = new Promise((resolve) => { flushStartedResolve = resolve; });
    const encryption = {
      isEnabled: () => true,
      isUnlocked: () => true,
      flush: async () => {
        if (!block) return true;
        flushStartedResolve();
        await deferred;
        return true;
      }
    };
    const made = makeController({ encryption, routes: { portfolio_sync_boundary: 0 } });
    await made.controller.hydrate();
    block = true;
    let stageResolved = false;
    const staging = made.controller.stage(planDb([
      legacy('stocks', 'encrypted-a', { id: 'encrypted-a' })
    ])).then((value) => { stageResolved = true; return value; });
    await flushStarted;
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(stageResolved, false);
    release();
    await staging;
    assert.strictEqual(stageResolved, true);
  });

  await test('sign-out waits for an active flush without erasing its durable cache', async () => {
    const made = makeController({ routes: { portfolio_sync_boundary: 0 } });
    await made.controller.hydrate();
    await made.controller.stage(planDb([
      legacy('stocks', 'race-a', { id: 'race-a', amount: 1 })
    ]));
    const beforeQueue = made.storage.map.get(key(USER, 'queue'));
    const beforeRecords = made.storage.map.get(key(USER, 'records'));
    let release;
    let rpcStartedResolve;
    const rpcStarted = new Promise((resolve) => { rpcStartedResolve = resolve; });
    const deferred = new Promise((resolve) => { release = resolve; });
    made.client.rpc = async (name, args) => {
      if (name === 'portfolio_sync_boundary') return { data: 0, error: null };
      if (name === 'portfolio_upsert_record') {
        rpcStartedResolve();
        await deferred;
        return {
          data: [serverRow({ id: args.p_record_id, payload: args.p_payload, version: 1, seq: 1 })],
          error: null
        };
      }
      return { data: [], error: null };
    };
    const unhandled = [];
    const onUnhandledRejection = (error) => unhandled.push(error);
    process.on('unhandledRejection', onUnhandledRejection);
    const flushing = made.controller.flush();
    await rpcStarted;
    let signOutFinished = false;
    const signingOut = made.controller.signOut().then(() => { signOutFinished = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(signOutFinished, false);
    assert.deepStrictEqual(made.auth.calls.filter((call) => call.method === 'signOut'), []);
    release();
    await signingOut;
    assert.strictEqual(made.controller.getStatus().authenticated, false);
    assert.notStrictEqual(made.storage.map.get(key(USER, 'queue')), beforeQueue);
    assert.strictEqual(JSON.parse(made.storage.map.get(key(USER, 'queue'))).operations.length, 0);
    assert.strictEqual(made.storage.map.has(key(USER, 'records')), false);
    assert.notStrictEqual(made.storage.map.get(key(USER, 'records')), beforeRecords);
    await rejectsCode(made.controller.flush(), 'SESSION_CLOSED');
    await rejectsCode(made.controller.stage(planDb([
      legacy('stocks', 'race-b', { id: 'race-b' })
    ])), 'SESSION_CLOSED');
    const result = await flushing;
    await new Promise((resolve) => setImmediate(resolve));
    process.removeListener('unhandledRejection', onUnhandledRejection);
    assert.strictEqual(result.cancelled, undefined);
    assert.strictEqual(JSON.parse(made.storage.map.get(key(USER, 'queue'))).operations.length, 0);
    assert.strictEqual(made.storage.map.has(key(USER, 'records')), false);
    assert.deepStrictEqual(unhandled, []);
  });

  await test('sign-out has a bounded wait, then cancels a hung flush without clearing its queue', async () => {
    const made = makeController({ signOutFlushTimeoutMs: 10, routes: { portfolio_sync_boundary: 0 } });
    await made.controller.hydrate();
    await made.controller.stage(planDb([
      legacy('stocks', 'timeout-a', { id: 'timeout-a', amount: 1 })
    ]));
    const beforeQueue = made.storage.map.get(key(USER, 'queue'));
    const beforeRecords = made.storage.map.get(key(USER, 'records'));
    let rpcStartedResolve;
    const rpcStarted = new Promise((resolve) => { rpcStartedResolve = resolve; });
    let release;
    const deferred = new Promise((resolve) => { release = resolve; });
    made.client.rpc = async (name, args) => {
      if (name === 'portfolio_sync_boundary') return { data: 0, error: null };
      rpcStartedResolve();
      await deferred;
      return { data: [serverRow({ id: args.p_record_id, payload: args.p_payload, version: 1, seq: 1 })], error: null };
    };
    const flushing = made.controller.flush();
    await rpcStarted;
    await made.controller.signOut();
    assert.strictEqual(made.controller.getStatus().authenticated, false);
    assert.strictEqual(made.storage.map.get(key(USER, 'queue')), beforeQueue);
    assert.strictEqual(made.storage.map.get(key(USER, 'records')), beforeRecords);
    release();
    const result = await flushing;
    assert.strictEqual(result.cancelled, true);
    assert.strictEqual(made.storage.map.get(key(USER, 'queue')), beforeQueue);
    assert.strictEqual(made.storage.map.get(key(USER, 'records')), beforeRecords);
  });

  await test('sign-out uses local scope, clears cache after auth error and preserves recovery state', async () => {
    const auth = makeAuth();
    auth.signOutError = new Error('network, do not echo');
    const made = makeController({ auth });
    await made.controller.signInWithPassword('owner@example.com', 'private-password');
    ['records', 'queue', 'recovery', 'cursor'].forEach((suffix) => {
      made.storage.seed(key(USER, suffix), { private: true });
    });
    await rejectsCode(made.controller.signOut(), 'SIGNOUT_FAILED');
    const signOutCalls = auth.calls.filter((call) => call.method === 'signOut');
    assert.deepStrictEqual(signOutCalls, [{ method: 'signOut', args: { scope: 'local' } }]);
    ['records', 'cursor'].forEach((suffix) => {
      assert.strictEqual(made.storage.map.has(key(USER, suffix)), false);
    });
    ['queue', 'recovery'].forEach((suffix) => {
      assert.strictEqual(made.storage.map.has(key(USER, suffix)), true);
    });
    assert.strictEqual(made.controller.getStatus().authenticated, false);
  });

  await test('TOTP methods use only totp and never persist enrollment secrets', async () => {
    const made = makeController();
    const factors = await made.controller.listTotpFactors();
    assert.deepStrictEqual(factors.map((factor) => factor.id), ['totp-a']);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(factors[0], 'secret'), false);
    const enrollment = await made.controller.enrolTotp('Julian device');
    assert.deepStrictEqual(enrollment, {
      factorId: 'totp-new',
      qrCode: 'one-time-qr',
      secret: 'one-time-secret',
      uri: 'otpauth://totp/Kujira:owner'
    });
    await made.controller.challengeAndVerify('totp-a', '123456');
    const enrollCall = made.auth.calls.find((call) => call.method === 'enroll');
    assert.deepStrictEqual(enrollCall.args, { factorType: 'totp', friendlyName: 'Julian device' });
    const verifyCall = made.auth.calls.find((call) => call.method === 'challengeAndVerify');
    assert.deepStrictEqual(verifyCall.args, {
      factorId: 'totp-a', code: '123456'
    });
    assert.strictEqual(made.auth.calls.some((call) => call.method === 'challenge'), false);
    assert.strictEqual(made.auth.calls.some((call) => call.method === 'verify'), false);
    assert.strictEqual(made.storage.map.size, 0);
  });

  await test('stage creates update delete restore and position-only operations, queue is durable', async () => {
    const initialRows = [
      serverRow({ id: 'stock-a', payload: { id: 'stock-a', amount: 1 }, version: 1, seq: 1, snapshotSequence: 3 }),
      serverRow({ id: 'stock-b', payload: { id: 'stock-b' }, version: 2, seq: 2, snapshotSequence: 3 }),
      serverRow({ id: 'stock-c', payload: { id: 'stock-c', amount: 1 }, version: 4, seq: 3, snapshotSequence: 3, deletedAt: '2026-09-04T01:00:00.000Z' })
    ];
    const made = makeController({
      routes: { portfolio_sync_boundary: 3, portfolio_get_records_page: initialRows }
    });
    await made.controller.hydrate();
    const desired = [
      legacy('stocks', 'stock-a', { id: 'stock-a', amount: 2 }, 0),
      legacy('stocks', 'stock-c', { id: 'stock-c', amount: 9 }, 0),
      legacy('stocks', 'stock-d', { id: 'stock-d' }, 0)
    ];
    const staged = await made.controller.stage(planDb(desired));
    assert.deepStrictEqual(staged.operations.map((op) => [op.kind, op.recordId, op.expectedVersion]), [
      ['upsert', 'stock-a', 1],
      ['restore', 'stock-c', 4],
      ['upsert', 'stock-d', 0],
      ['delete', 'stock-b', 2]
    ]);
    assert.deepStrictEqual(staged.operations.find((op) => op.kind === 'restore'), {
      kind: 'restore',
      recordType: 'stocks',
      recordId: 'stock-c',
      expectedVersion: 4,
      payload: { id: 'stock-c', amount: 9 },
      position: 0
    });
    const queuedRaw = JSON.parse(made.storage.map.get(key(USER, 'queue')));
    assert.strictEqual(queuedRaw.operations.length, 4);
    assert.strictEqual(JSON.stringify(queuedRaw).includes('user_id'), false);

    const positionOnly = await made.controller.stage(planDb([
      legacy('stocks', 'stock-a', { id: 'stock-a', amount: 1 }, 7),
      legacy('stocks', 'stock-b', { id: 'stock-b' }, 0),
      legacy('stocks', 'stock-c', { id: 'stock-c', amount: 1 }, 0)
    ]));
    assert.deepStrictEqual(positionOnly.operations.map((op) => [op.kind, op.recordId, op.expectedVersion]), [
      ['upsert', 'stock-a', 1],
      ['restore', 'stock-c', 4]
    ]);
  });

  await test('changed tombstone restores atomically with payload and position', async () => {
    const tombstone = serverRow({
      id: 'stock-c',
      payload: { id: 'stock-c', amount: 1 },
      version: 4,
      seq: 3,
      snapshotSequence: 3,
      deletedAt: '2026-09-04T01:00:00.000Z'
    });
    const made = makeController({
      routes: { portfolio_sync_boundary: 3, portfolio_get_records_page: [tombstone] }
    });
    await made.controller.hydrate();
    await made.controller.stage(planDb([
      legacy('stocks', 'stock-c', { id: 'stock-c', amount: 9 }, 2)
    ]));
    const calls = [];
    made.client.rpc = async (name, args) => {
      calls.push({ name, args });
      if (name === 'portfolio_sync_boundary') return { data: 3, error: null };
      if (name === 'portfolio_restore_record') {
        return {
          data: [serverRow({
            id: 'stock-c',
            payload: args.p_payload,
            position: args.p_position,
            version: 5,
            seq: 4
          })],
          error: null
        };
      }
      return { data: [], error: null };
    };
    await made.controller.flush();
    assert.deepStrictEqual(calls.map((call) => call.name), [
      'portfolio_sync_boundary', 'portfolio_restore_record'
    ]);
    assert.deepStrictEqual(calls[1].args, {
      p_record_type: 'stocks',
      p_record_id: 'stock-c',
      p_payload: { id: 'stock-c', amount: 9 },
      p_position: 2,
      p_expected_version: 4
    });
  });

  await test('CAS failure stays queued and is exposed as a stable NAS error', async () => {
    const made = makeController({
      routes: {
        portfolio_sync_boundary: 0
      }
    });
    await made.controller.hydrate();
    await made.controller.stage(planDb([legacy('stocks', 'stock-a', { id: 'stock-a' })]));
    made.client.calls.length = 0;
    made.client.auth.mfa.getAuthenticatorAssuranceLevel = async () => ({
      data: { currentLevel: 'aal2', nextLevel: 'aal2' }, error: null
    });
    const originalRpc = made.client.rpc;
    made.client.rpc = async (name, args) => {
      made.client.calls.push({ name, args });
      if (name === 'portfolio_sync_boundary') return { data: 0, error: null };
      return { data: null, error: { code: 'PORTFOLIO_CONFLICT' } };
    };
    await rejectsCode(made.controller.flush(), 'CAS_FAILED');
    const queue = JSON.parse(made.storage.map.get(key(USER, 'queue')));
    assert.strictEqual(queue.operations.length, 1);
    assert.strictEqual(queue.operations[0].expectedVersion, 0);
    made.client.rpc = originalRpc;
  });

  await test('stage during deferred flush survives, with baseline re-queued against the new version', async () => {
    const made = makeController({ routes: { portfolio_sync_boundary: 0 } });
    await made.controller.hydrate();
    await made.controller.stage(planDb([legacy('stocks', 'stock-a', { id: 'stock-a', n: 1 })]));
    let release;
    const deferred = new Promise((resolve) => { release = resolve; });
    made.client.rpc = async (name, args) => {
      made.client.calls.push({ name, args });
      if (name === 'portfolio_sync_boundary') return { data: 0, error: null };
      if (name === 'portfolio_upsert_record') {
        await deferred;
        return { data: [serverRow({ id: 'stock-a', payload: args.p_payload, version: 1, seq: 1 })], error: null };
      }
      return { data: [], error: null };
    };
    const flushing = made.controller.flush();
    await new Promise((resolve) => setImmediate(resolve));
    const stagedLater = made.controller.stage(planDb([
      legacy('stocks', 'stock-a', { id: 'stock-a', n: 2 })
    ]));
    await stagedLater;
    release();
    await flushing;
    const queue = JSON.parse(made.storage.map.get(key(USER, 'queue')));
    assert.strictEqual(queue.generation, 2);
    assert.deepStrictEqual(queue.operations.map((op) => [op.kind, op.expectedVersion]), [['upsert', 1]]);
    assert.strictEqual(queue.desiredRecords[0].payload.n, 2);
  });

  await test('partial success persists the authoritative baseline and re-queues only the failed desired record', async () => {
    const made = makeController({ routes: { portfolio_sync_boundary: 0 } });
    await made.controller.hydrate();
    await made.controller.stage(planDb([
      legacy('stocks', 'stock-a', { id: 'stock-a' }),
      legacy('stocks', 'stock-b', { id: 'stock-b' })
    ]));
    let upserts = 0;
    made.client.rpc = async (name, args) => {
      made.client.calls.push({ name, args });
      if (name === 'portfolio_sync_boundary') return { data: 0, error: null };
      if (name === 'portfolio_upsert_record' && upserts++ === 0) {
        return { data: [serverRow({ id: args.p_record_id, payload: args.p_payload, version: 1, seq: 10 })], error: null };
      }
      return { data: null, error: { code: 'TEMPORARY_NETWORK' } };
    };
    await rejectsCode(made.controller.flush(), 'RPC_FAILED');
    const queue = JSON.parse(made.storage.map.get(key(USER, 'queue')));
    assert.deepStrictEqual(queue.operations.map((op) => op.recordId), ['stock-b']);
    const records = JSON.parse(made.storage.map.get(key(USER, 'records')));
    assert.strictEqual(records.baseline.some((row) => row.record_id === 'stock-a'), true);
  });

  await test('persistent desired state loads in a fresh controller and record/payload bounds fail before writes', async () => {
    const storage = makeStorage();
    const first = makeController({ storage, routes: { portfolio_sync_boundary: 0 } });
    await first.controller.hydrate();
    await first.controller.stage(planDb([legacy('stocks', 'stock-a', { id: 'stock-a' })]));
    const secondAuth = makeAuth();
    const second = makeController({
      storage,
      auth: secondAuth,
      routes: {
        portfolio_sync_boundary: 0,
        portfolio_upsert_record: (args) => ({ data: [serverRow({ id: args.p_record_id, payload: args.p_payload, version: 1, seq: 1 })], error: null })
      }
    });
    await second.controller.flush();
    assert.strictEqual(JSON.parse(storage.map.get(key(USER, 'queue'))).operations.length, 0);

    const before = Array.from(storage.map.entries());
    const tooMany = Array.from({ length: 10001 }, (_, index) => legacy('stocks', `id-${index}`, { id: `id-${index}` }));
    await rejectsCode(first.controller.stage(planDb(tooMany)), 'RECORD_LIMIT');
    assert.deepStrictEqual(Array.from(storage.map.entries()), before);
    const huge = 'x'.repeat(12 * 1024 * 1024 + 1);
    await rejectsCode(first.controller.stage(planDb([legacy('stocks', 'large', { id: 'large', value: huge })])), 'PAYLOAD_LIMIT');
    assert.deepStrictEqual(Array.from(storage.map.entries()), before);
  });

  await test('recovery requires owner AAL2, validates allowlist and stores no price cache', async () => {
    const made = makeController();
    await rejectsCode(made.controller.stashRecovery(planDb([legacy('stocks', 'a', { id: 'a' })]), 'bad-reason'), 'RECOVERY_REASON');
    const aal1 = makeController({ auth: makeAuth(USER, 'aal1') });
    await rejectsCode(aal1.controller.stashRecovery(planDb([legacy('stocks', 'a', { id: 'a' })]), 'conflict'), 'AAL2_REQUIRED');
    assert.strictEqual(aal1.storage.calls.some((call) => call.op === 'get'), false);
    made.client.calls.length = 0;
    made.client.auth.mfa.getAuthenticatorAssuranceLevel = async () => ({
      data: { currentLevel: 'aal2', nextLevel: 'aal2' }, error: null
    });
    made.client.rpc = async (name, args) => {
      made.client.calls.push({ name, args });
      return name === 'portfolio_sync_boundary' ? { data: 0, error: null } : { data: [], error: null };
    };
    const result = await made.controller.stashRecovery({
      records: [legacy('stocks', 'a', { id: 'a' })],
      _priceCache: { secret: 'not-needed' }
    }, 'before-import');
    assert.strictEqual(result.createdAt, '2026-09-04T12:00:00.000Z');
    const recovery = JSON.parse(made.storage.map.get(key(USER, 'recovery')));
    assert.strictEqual(Array.isArray(recovery), true);
    assert.strictEqual(recovery.length, 1);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(recovery[0].db, '_priceCache'), false);
    assert.strictEqual(recovery[0].reason, 'before-import');
  });

  await test('recovery journal appends, evicts only its oldest sixth entry and rejects malformed state', async () => {
    const times = [1, 2, 3, 4, 5, 6].map((day) => `2026-09-0${day}T12:00:00.000Z`);
    const made = makeController({
      routes: { portfolio_sync_boundary: 0 },
      now: () => times.shift()
    });
    const reasons = ['conflict', 'before-import', 'before-hydrate', 'conflict', 'before-import', 'before-hydrate'];
    for (const reason of reasons.slice(0, 5)) {
      await made.controller.stashRecovery(planDb([legacy('stocks', 'recovery-a', { id: 'recovery-a' })]), reason);
    }
    const firstFive = JSON.parse(made.storage.map.get(key(USER, 'recovery')));
    assert.strictEqual(firstFive.length, 5);
    assert.deepStrictEqual(firstFive.map((entry) => entry.createdAt), [
      '2026-09-01T12:00:00.000Z', '2026-09-02T12:00:00.000Z',
      '2026-09-03T12:00:00.000Z', '2026-09-04T12:00:00.000Z',
      '2026-09-05T12:00:00.000Z'
    ]);
    await made.controller.stashRecovery(
      planDb([legacy('stocks', 'recovery-b', { id: 'recovery-b' })]), reasons[5]
    );
    const afterSix = JSON.parse(made.storage.map.get(key(USER, 'recovery')));
    assert.strictEqual(afterSix.length, 5);
    assert.deepStrictEqual(afterSix.map((entry) => entry.createdAt), [
      '2026-09-02T12:00:00.000Z', '2026-09-03T12:00:00.000Z',
      '2026-09-04T12:00:00.000Z', '2026-09-05T12:00:00.000Z',
      '2026-09-06T12:00:00.000Z'
    ]);
    assert.strictEqual(afterSix[4].db.records[0].payload.id, 'recovery-b');

    const malformedStorage = makeStorage();
    const malformedRaw = JSON.stringify([{ reason: 'conflict' }]);
    malformedStorage.seed(key(USER, 'recovery'), malformedRaw);
    const malformed = makeController({
      storage: malformedStorage,
      routes: { portfolio_sync_boundary: 0 }
    });
    await rejectsCode(
      malformed.controller.stashRecovery(
        planDb([legacy('stocks', 'recovery-c', { id: 'recovery-c' })]), 'conflict'
      ),
      'MALFORMED_RECOVERY'
    );
    assert.strictEqual(malformedStorage.map.get(key(USER, 'recovery')), malformedRaw);
  });

  await test('recovery listing and restore are owner-gated, detached and read-only', async () => {
    const made = makeController({ routes: { portfolio_sync_boundary: 0 } });
    await made.controller.stashRecovery(
      planDb([legacy('stocks', 'restore-a', { id: 'restore-a', amount: 1 })]),
      'before-import'
    );
    await made.controller.stashRecovery(
      planDb([legacy('stocks', 'restore-b', { id: 'restore-b', amount: 2 })]),
      'conflict'
    );
    made.client.calls.length = 0;
    made.storage.calls.length = 0;
    const listed = await made.controller.listRecovery();
    assert.deepStrictEqual(listed.map((entry) => entry.reason), ['before-import', 'conflict']);
    assert.deepStrictEqual(listed.map((entry) => entry.index), [0, 1]);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(listed[0], 'db'), false);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(listed[0], 'payload'), false);
    const restored = await made.controller.restoreRecovery(0);
    assert.strictEqual(restored.records[0].payload.id, 'restore-a');
    restored.records[0].payload.amount = 999;
    const restoredAgain = await made.controller.restoreRecovery(0);
    assert.strictEqual(restoredAgain.records[0].payload.amount, 1);
    await rejectsCode(made.controller.restoreRecovery(9), 'RECOVERY_INDEX');
    assert.deepStrictEqual(made.client.calls.map((call) => call.name), [
      'portfolio_sync_boundary', 'portfolio_sync_boundary',
      'portfolio_sync_boundary', 'portfolio_sync_boundary'
    ]);
    assert.strictEqual(made.storage.calls.some((call) => call.op === 'set'), false);
    assert.strictEqual(made.storage.calls.some((call) => call.op === 'remove'), false);

    const lockedStorage = makeStorage();
    lockedStorage.seed(key(USER, 'recovery'), []);
    const locked = makeController({
      storage: lockedStorage,
      auth: makeAuth(USER, 'aal1'),
      routes: { portfolio_sync_boundary: 0 }
    });
    await rejectsCode(locked.controller.listRecovery(), 'AAL2_REQUIRED');
    assert.strictEqual(lockedStorage.calls.some((call) => call.op === 'get'), false);
  });

  console.log(`NAS tests passed: ${passed}`);
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
