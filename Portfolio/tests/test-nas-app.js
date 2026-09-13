'use strict';

/* Behavioural checks for the optional NAS app boundary. These tests execute
 * the real app functions in small VM sandboxes, with synthetic storage, vault
 * and controller doubles. No browser account, token or finance data is used.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const appSrc = fs.readFileSync(path.join(__dirname, '..', 'Worker', 'app.js'), 'utf8');
const USER = '11111111-1111-4111-8111-111111111111';

function extractFunction(name) {
  const sig = new RegExp('function\\s+' + name.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&') + '\\s*\\(');
  const match = sig.exec(appSrc);
  if (!match) throw new Error(`Missing app function: ${name}`);
  let start = match.index;
  if (/async\s$/.test(appSrc.slice(Math.max(0, match.index - 6), match.index))) start = match.index - 6;
  let i = appSrc.indexOf('{', match.index);
  let depth = 0;
  let quote = null;
  let lineComment = false;
  let blockComment = false;
  for (; i < appSrc.length; i += 1) {
    const c = appSrc[i];
    const next = appSrc[i + 1];
    if (lineComment) { if (c === '\n') lineComment = false; continue; }
    if (blockComment) { if (c === '*' && next === '/') { blockComment = false; i += 1; } continue; }
    if (quote) { if (c === '\\') { i += 1; continue; } if (c === quote) quote = null; continue; }
    if (c === '/' && next === '/') { lineComment = true; i += 1; continue; }
    if (c === '/' && next === '*') { blockComment = true; i += 1; continue; }
    if (c === '\'' || c === '"' || c === '`') { quote = c; continue; }
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return appSrc.slice(start, i + 1);
    }
  }
  throw new Error(`Unbalanced app function: ${name}`);
}

const TARGETS = [
  'backendMode', 'isNasMode', 'isLegacyReadonlyMode', 'nasUserKey',
  '_assertNasWriteAllowed', '_nasCachePayload', 'persistNasAppDb', 'readNasAppDb',
  'readNasPriceCache', '_flushNasProtectedStorage', 'persistNasPriceCache', '_nasEnqueue',
  '_markLocalUnsaved', '_clearLocalUnsaved', '_hasLocalUnsaved', '_nasStatus', 'saveNasLocal',
  '_nasQueuedCount', 'loadNasFinance', 'denyReadonlyMutation',
  'resetLocalConfirm', 'importBackupFromFile', 'signOutNas',
  '_vaultSetMessage', '_importVaultEnvelope', '_resetEncryptedBrowserData', 'showVaultUnlockGate',
  'ibkrConfirmImport', 'insuranceImportConfirm'
];
const FUNCTIONS = TARGETS.map(extractFunction).join('\n\n');

function makeStorage(timeline) {
  const map = new Map();
  const calls = [];
  const storage = {
    isProtectedStorage: true,
    map,
    calls,
    getItem(key) {
      calls.push({ op: 'get', key });
      if (timeline) timeline.push(`get:${key}`);
      return map.has(key) ? map.get(key) : null;
    },
    setItem(key, value) {
      calls.push({ op: 'set', key, value });
      if (timeline) timeline.push(`set:${key}`);
      map.set(key, String(value));
    },
    removeItem(key) {
      calls.push({ op: 'remove', key });
      if (timeline) timeline.push(`remove:${key}`);
      map.delete(key);
    }
  };
  return storage;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function makeSandbox(options = {}) {
  const timeline = options.timeline || [];
  const storage = makeStorage(timeline);
  const events = [];
  const vault = options.vault || { flush: async () => true };
  const controller = options.controller || {
    async stage() { return { operations: [] }; },
    async pending() { return { count: 0, desiredDb: null }; },
    status() { return { userId: USER }; },
    async hydrate() { return { stocks: [], crypto: [], cash: [] }; },
    async signOut() { return true; }
  };
  const sandbox = {
    __storage: storage,
    __vault: vault,
    __controller: controller,
    __document: options.document,
    __events: events,
    __timeline: timeline,
    __restoreReadonly: options.restoreReadonly || (() => false),
    setTimeout,
    clearTimeout,
    console,
    JSON,
    Promise
  };
  vm.createContext(sandbox);
  const setup = `
    var LK_BACKEND_MODE = 'kjr-pf-backend-mode-v1';
    var LK_NAS_PREFIX = 'kjr-pf-nas-v1:';
    var LK_UNSAVED = 'kjr-pf-local-unsaved-v1';
    var NAS_MODES = new Set(['legacy', 'nas', 'legacy-readonly']);
    var localStorage = globalThis.__storage;
    var window = { localStorage: localStorage };
    var document = globalThis.__document || { getElementById: function () { return { classList: { remove: function () {} } }; } };
    var protectedStorage = localStorage;
    var nasProtectedStorage = localStorage;
    var _vaultManager = globalThis.__vault;
    var _nasController = globalThis.__controller;
    var _nasUserId = null;
    var _nasReady = true;
    var _nasPendingCount = 0;
    var _nasState = 'local';
    var _nasLifecycleChain = Promise.resolve();
    var _nasAppGeneration = 0;
    var _nasSyncTimer = null;
    var _nasReadonlyRestoring = false;
    var _nasLegacyReadonlyRaw = null;
    var _nasConflictRetryReady = false;
    var _localSaveRevision = 0;
    var _localUnsavedInMemory = false;
    var _activeLocalSave = null;
    var _localBase = null;
    var DB = globalThis.__db || { stocks: [], crypto: [], cash: [], settings: {}, _priceCache: {} };
    var location = { protocol: 'https:', hostname: 'nas.example', origin: 'https://nas.example', reload: function () { globalThis.__reloaded = true; } };
    var isLocalPreview = function () { return false; };
    var nasVaultReady = function () { return true; };
    var requireNasVault = function () {};
    var mergeDefaults = function (value) { return JSON.parse(JSON.stringify(value)); };
    var freshDB = function () { return { stocks: [], crypto: [], cash: [], settings: {}, _priceCache: {} }; };
    var localPersistPayload = function () { return JSON.parse(JSON.stringify(DB)); };
    var setSyncStatus = function (state, detail) { globalThis.__events.push('status:' + state + ':' + (detail || '')); };
    var setNasConflictActions = function () {};
    var renderBackendBanner = function () {};
    var showToast = function (message, kind) { globalThis.__events.push('toast:' + kind + ':' + message); };
    var renderAll = function () {};
    var route = function () {};
    var loadSettingsForm = function () {};
    var clearNasAuthFields = function () {};
    var _vaultSetMessage = function () {};
    var confirm = function () { return true; };
    var restoreLegacyReadonly = globalThis.__restoreReadonly;
    var _nasConflict = function (error) { return !!(error && /CONFLICT|CAS|VERSION/.test(String(error.code || ''))); };
  `;
  vm.runInContext(setup + FUNCTIONS, sandbox, { filename: 'app.js (NAS behavioural harness)' });
  return { sandbox, storage, vault, controller, events, timeline };
}

function waitTurn() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function makeVaultGateDocument() {
  const nodes = {};
  const makeNode = () => ({
    classList: { add() {}, remove() {}, contains() { return false; } },
    style: {},
    setAttribute() {},
    focus() {},
    clickCount: 0,
    click() { this.clickCount += 1; }
  });
  [
    'vault-gate', 'vault-unlock-form', 'vault-unlock-passphrase', 'vault-unlock-btn',
    'vault-export-btn', 'vault-import-btn', 'vault-import-input', 'vault-reset-btn'
  ].forEach((id) => { nodes[id] = makeNode(); });
  return { nodes, getElementById(id) { return nodes[id] || null; } };
}

async function test(name, fn) {
  let timer;
  try {
    await Promise.race([
      Promise.resolve().then(fn),
      new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('test timed out after 2000ms')), 2000);
      })
    ]);
    console.log(`PASS: ${name}`);
    return true;
  } catch (error) {
    console.error(`FAIL: ${name}`);
    console.error(error);
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function run() {
  let passed = 0;
  let failed = 0;

  if (await test('NAS save stays unsaved while encrypted flush is pending', async () => {
    let release;
    let blocked = true;
    const vault = {
      flush: () => blocked
        ? new Promise((resolve) => {
          release = () => { blocked = false; resolve(true); };
        })
        : Promise.resolve(true)
    };
    const stageCalls = [];
    const controller = {
      async stage(value) { stageCalls.push(clone(value)); return { operations: [{ recordId: 'a' }] }; }
    };
    const { sandbox } = makeSandbox({ vault, controller });
    sandbox._nasUserId = USER;
    sandbox.DB = { stocks: [{ id: 'a', name: 'Before' }], crypto: [], cash: [], settings: {}, _priceCache: {} };
    let settled = false;
    const saving = sandbox.saveNasLocal().then((value) => { settled = true; return value; });
    await waitTurn();
    assert.strictEqual(settled, false);
    assert.strictEqual(sandbox._hasLocalUnsaved(), true);
    assert.strictEqual(stageCalls.length, 0);
    release();
    assert.strictEqual(await saving, true);
    assert.strictEqual(sandbox._hasLocalUnsaved(), false);
    assert.strictEqual(stageCalls.length, 1);
  })) passed += 1; else failed += 1;

  if (await test('NAS save captures a deep snapshot before a queued lifecycle wait', async () => {
    let release;
    const lifecycle = new Promise((resolve) => { release = resolve; });
    const stageCalls = [];
    const controller = {
      async stage(value) { stageCalls.push(clone(value)); return { operations: [] }; }
    };
    const { sandbox } = makeSandbox({ controller });
    sandbox._nasUserId = USER;
    sandbox._nasLifecycleChain = lifecycle;
    sandbox.DB = { stocks: [{ id: 'a', name: 'Before' }], crypto: [], cash: [], settings: {}, _priceCache: {} };
    const saving = sandbox.saveNasLocal();
    sandbox.DB.stocks[0].name = 'Edited while waiting';
    release();
    assert.strictEqual(await saving, true);
    assert.strictEqual(stageCalls.length, 1);
    assert.strictEqual(stageCalls[0].stocks[0].name, 'Before');
  })) passed += 1; else failed += 1;

  if (await test('NAS stage failure retains pending-stage cache and unsaved marker', async () => {
    const controller = {
      async stage() { throw new Error('synthetic stage failure'); }
    };
    const { sandbox, storage } = makeSandbox({ controller });
    sandbox._nasUserId = USER;
    sandbox.DB = { stocks: [{ id: 'a' }], crypto: [], cash: [], settings: {}, _priceCache: {} };
    assert.strictEqual(await sandbox.saveNasLocal(), false);
    assert.strictEqual(sandbox._hasLocalUnsaved(), true);
    const raw = storage.map.get(sandbox.nasUserKey(USER, 'app-db'));
    assert.strictEqual(JSON.parse(raw).state, 'pending-stage');
  })) passed += 1; else failed += 1;

  if (await test('fresh NAS load hydrates a server baseline, then requeues pending-stage desired data', async () => {
    const timeline = [];
    const controller = {
      async pending() { timeline.push('pending'); return { count: 0, desiredDb: null }; },
      status() { return { userId: USER }; },
      async hydrate() { timeline.push('hydrate'); return { stocks: [{ id: 'server' }], crypto: [], cash: [] }; },
      async stage(value) { timeline.push('stage'); this.staged = clone(value); return { operations: [{ recordId: 'local' }] }; }
    };
    const { sandbox, storage } = makeSandbox({ controller, timeline });
    sandbox.localStorage.setItem(sandbox.LK_BACKEND_MODE || 'kjr-pf-backend-mode-v1', 'nas');
    const cached = { stocks: [{ id: 'local' }], crypto: [], cash: [], settings: {} };
    storage.map.set(sandbox.nasUserKey(USER, 'app-db'), JSON.stringify({ version: 1, state: 'pending-stage', db: cached }));
    timeline.length = 0;
    await sandbox.loadNasFinance();
    const appRead = storage.calls.findIndex((call) => call.op === 'get' && call.key.endsWith(':app-db'));
    assert.ok(appRead >= 0, 'the user-scoped app cache was not read');
    const appKey = sandbox.nasUserKey(USER, 'app-db');
    const pendingIndex = timeline.indexOf('pending');
    const appReadIndex = timeline.indexOf(`get:${appKey}`);
    const hydrateIndex = timeline.indexOf('hydrate');
    const stageIndex = timeline.indexOf('stage');
    assert.ok(pendingIndex >= 0 && pendingIndex < appReadIndex, 'owner queue check must precede app-cache read');
    assert.ok(appReadIndex < hydrateIndex && hydrateIndex < stageIndex,
      'pending-stage cache must be read before hydrate, then re-staged');
    assert.strictEqual(sandbox.DB.stocks[0].id, 'local');
    assert.strictEqual(controller.staged.stocks[0].id, 'local');
    assert.strictEqual(sandbox._nasPendingCount, 1);
    assert.strictEqual(JSON.parse(storage.map.get(sandbox.nasUserKey(USER, 'app-db'))).state, 'queued');
    assert.ok(appRead < storage.calls.findIndex((call) => call.op === 'set' && call.key.endsWith(':app-db')));
  })) passed += 1; else failed += 1;

  if (await test('NAS reload hydrate failure retains pending encrypted cache and unsaved marker', async () => {
    let stageCalls = 0;
    const controller = {
      async pending() { return { count: 0, desiredDb: null }; },
      status() { return { userId: USER }; },
      async hydrate() { throw new Error('synthetic hydrate outage'); },
      async stage() { stageCalls += 1; return { operations: [] }; }
    };
    const { sandbox, storage } = makeSandbox({ controller });
    sandbox.localStorage.setItem('kjr-pf-backend-mode-v1', 'nas');
    const appKey = sandbox.nasUserKey(USER, 'app-db');
    const cached = JSON.stringify({
      version: 1,
      state: 'pending-stage',
      db: { stocks: [{ id: 'local' }], crypto: [], cash: [], settings: {} }
    });
    storage.map.set(appKey, cached);
    storage.map.set('kjr-pf-local-unsaved-v1', '1');
    await assert.rejects(() => sandbox.loadNasFinance(), /synthetic hydrate outage/);
    assert.strictEqual(storage.map.get(appKey), cached);
    assert.strictEqual(storage.map.get('kjr-pf-local-unsaved-v1'), '1');
    assert.strictEqual(stageCalls, 0);
    assert.strictEqual(storage.calls.some((call) => call.op === 'set' && call.key === appKey), false);
  })) passed += 1; else failed += 1;

  if (await test('readonly denial returns true and reset/import stop before mutation', async () => {
    let restores = 0;
    const { sandbox } = makeSandbox({ restoreReadonly: () => { restores += 1; return false; } });
    sandbox.localStorage.setItem('kjr-pf-backend-mode-v1', 'legacy-readonly');
    assert.strictEqual(sandbox.denyReadonlyMutation('edit'), true);
    assert.strictEqual(await sandbox.resetLocalConfirm(), false);
    assert.strictEqual(await sandbox.importBackupFromFile({ value: '', files: [] }), false);
    assert.strictEqual(restores, 3);
  })) passed += 1; else failed += 1;

  if (await test('legacy read-only blocks vault chooser/reset and import confirmations before mutation', async () => {
    let restores = 0;
    let exported = 0;
    let replaced = 0;
    let reset = 0;
    const vault = {
      exportEnvelope() { exported += 1; return '{}'; },
      replaceEnvelope() { replaced += 1; },
      resetEncryptedData() { reset += 1; },
      unlock: async () => true
    };
    const document = makeVaultGateDocument();
    const { sandbox } = makeSandbox({
      vault,
      document,
      restoreReadonly: () => { restores += 1; return false; }
    });
    sandbox.localStorage.setItem('kjr-pf-backend-mode-v1', 'legacy-readonly');
    sandbox.DB = { stocks: [], stockTxns: [], insurance: [] };
    const before = clone(sandbox.DB);
    const gatePromise = sandbox.showVaultUnlockGate();
    assert.ok(gatePromise && typeof gatePromise.then === 'function');
    const input = document.nodes['vault-import-input'];
    document.nodes['vault-import-btn'].onclick();
    document.nodes['vault-reset-btn'].onclick();
    assert.strictEqual(input.clickCount, 0);
    assert.strictEqual(await sandbox._importVaultEnvelope({ files: [{}], value: 'selected' }), false);
    assert.strictEqual(await sandbox._resetEncryptedBrowserData(), false);
    assert.strictEqual(await sandbox.ibkrConfirmImport(), false);
    assert.strictEqual(await sandbox.insuranceImportConfirm(), false);
    assert.strictEqual(restores, 6);
    assert.strictEqual(exported, 0);
    assert.strictEqual(replaced, 0);
    assert.strictEqual(reset, 0);
    assert.deepStrictEqual(sandbox.DB, before);
  })) passed += 1; else failed += 1;

  if (await test('app sign-out reaches controller cancellation before its lifecycle queue resolves', async () => {
    let release;
    let lifecycleReleased = false;
    const lifecycle = new Promise((resolve) => { release = resolve; });
    let signOutCalls = 0;
    const controller = {
      async signOut() {
        signOutCalls += 1;
        assert.strictEqual(lifecycleReleased, false);
        return true;
      }
    };
    const { sandbox } = makeSandbox({ controller });
    sandbox._nasLifecycleChain = lifecycle;
    const signingOut = sandbox.signOutNas();
    await waitTurn();
    assert.strictEqual(signOutCalls, 1);
    lifecycleReleased = true;
    release();
    assert.strictEqual(await signingOut, true);
    assert.strictEqual(signOutCalls, 1);
    assert.strictEqual(sandbox.__reloaded, true);
  })) passed += 1; else failed += 1;

  if (await test('late NAS save completion cannot clear recovery data after app sign-out', async () => {
    let releaseStage;
    let stageStartedResolve;
    let stageFinished = false;
    const stageStarted = new Promise((resolve) => { stageStartedResolve = resolve; });
    const stageGate = new Promise((resolve) => { releaseStage = resolve; });
    let signOutCalls = 0;
    const controller = {
      async stage() {
        stageStartedResolve();
        await stageGate;
        stageFinished = true;
        return { operations: [{ recordId: 'late' }] };
      },
      async signOut() {
        signOutCalls += 1;
        return true;
      }
    };
    const { sandbox, storage } = makeSandbox({ controller });
    sandbox._nasUserId = USER;
    sandbox.DB = { stocks: [{ id: 'late', name: 'Recover me' }], crypto: [], cash: [], settings: {}, _priceCache: {} };
    const appKey = sandbox.nasUserKey(USER, 'app-db');
    const saving = sandbox.saveNasLocal();
    await stageStarted;
    const signingOut = sandbox.signOutNas();
    assert.strictEqual(await signingOut, true, 'sign-out must complete without waiting for the save');
    assert.strictEqual(signOutCalls, 1);
    assert.strictEqual(stageFinished, false);
    assert.strictEqual(sandbox._nasController, null);
    releaseStage();
    assert.strictEqual(await saving, false, 'late save must stay unsuccessful after sign-out');
    assert.strictEqual(stageFinished, true);
    assert.strictEqual(JSON.parse(storage.map.get(appKey)).state, 'pending-stage');
    assert.strictEqual(storage.map.get('kjr-pf-local-unsaved-v1'), '1');
    assert.strictEqual(storage.calls.filter((call) => call.op === 'set' && call.key === appKey).length, 1);
  })) passed += 1; else failed += 1;

  if (await test('pre-sign-out queued NAS save is fenced before its first cache write', async () => {
    let releaseLifecycle;
    const lifecycle = new Promise((resolve) => { releaseLifecycle = resolve; });
    let stageCalls = 0;
    const controller = {
      async stage() { stageCalls += 1; return { operations: [] }; },
      async signOut() { return true; }
    };
    const { sandbox, storage } = makeSandbox({ controller });
    sandbox._nasUserId = USER;
    sandbox.DB = { stocks: [{ id: 'queued' }], crypto: [], cash: [], settings: {}, _priceCache: {} };
    sandbox._nasLifecycleChain = lifecycle;
    const appKey = sandbox.nasUserKey(USER, 'app-db');
    const saving = sandbox.saveNasLocal();
    await waitTurn();
    const signingOut = sandbox.signOutNas();
    assert.strictEqual(await signingOut, true);
    releaseLifecycle();
    assert.strictEqual(await saving, false);
    assert.strictEqual(stageCalls, 0);
    assert.strictEqual(storage.map.has(appKey), false);
    assert.strictEqual(storage.map.get('kjr-pf-local-unsaved-v1'), '1');
  })) passed += 1; else failed += 1;

  console.log(`NAS app behavioural tests: ${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
