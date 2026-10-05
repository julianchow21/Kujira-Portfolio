// Account-isolation regression tests for the real Forex/index.html functions.
// The harness uses synthetic users and deferred promises only. It never opens
// a browser, reads personal storage, or calls a network service.
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const INDEX_PATH = path.join(__dirname, '..', 'index.html');
const indexSrc = fs.readFileSync(INDEX_PATH, 'utf8');

function sliceFromMatch(source, start) {
  let i = source.indexOf('(', start);
  if (i === -1) throw new Error('sliceFromMatch: no opening parenthesis');
  let depth = 1;
  i++;
  while (depth > 0) {
    if (source[i] === '(') depth++;
    else if (source[i] === ')') depth--;
    i++;
  }
  while (source[i] !== '{') i++;
  let braces = 0;
  for (; i < source.length; i++) {
    if (source[i] === '{') braces++;
    else if (source[i] === '}') {
      braces--;
      if (braces === 0) { i++; break; }
    }
  }
  if (source[i] === ';') i++;
  return source.slice(start, i);
}

function extractFunction(source, name) {
  const match = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(').exec(source);
  if (!match) throw new Error(`function ${name} was not found`);
  return sliceFromMatch(source, match.index);
}

const FUNCTION_NAMES = [
  'scopeForUser', 'storageKeyForScope', 'scopeSnapshot', 'scopeIsCurrent',
  'setStorageScope', 'currentUser', 'isLocalOwner', 'isHostedMode',
  'isHostedAuthenticated', 'resetRuntimeState', 'defaultAccountState', 'applyAuthUser',
  'sbConfigured', 'sbHeaders', 'sbRpc', 'isValidStoredId', 'assertStoredId',
  'assertSyncTable', 'splitValidRows', 'sbSyncRow', 'sbFetchAll', 'mergeTable',
  'loadData', 'normaliseAccountState', 'loadAccountState', '_loadDirty', '_persistDirty',
  'rowRevision', 'markDirty', '_daysInMonth', '_localDate', 'parseCSV', 'parseImportDate', 'stableImportId', 'finitePositive', 'finiteNonNegative', 'validTradeSide', 'validTradeSymbol', 'validInputDate', 'parseTags', 'upsertTrade', 'upsertTradeSilent',
  '_queueDelete', '_unqueueDelete', 'sbDelete', 'flushPendingDeletes', '_acceptServerRevision',
  'readSyncConflicts', 'writeSyncConflicts', '_hasOpenConflict', '_recordConflict', '_dropSyncConflict', 'openConflictManager', 'resolveSyncConflict', '_flushDirty', '_flushDirtyOnce', 'importCSV', 'closeModal', 'saveTradeModal',
];

const extractedFunctions = FUNCTION_NAMES.map((name) => extractFunction(indexSrc, name)).join('\n');
const harnessPrefix = `
var APP={storageKey:'test_forex'}, FREE_TRADE_CAP=50;
var TABLES=['trades'], STORED_ID_MAX=64, SB_PAGE_SIZE=1000;
var FOREX_CONFIG={mode:'hosted'};
var FOREX_AUTH={headers:async function(){return {'Content-Type':'application/json',Authorization:'Bearer token-A'};}};
var _authUser={id:null,email:null,local:false,hosted:true,authenticated:false,scope:'hosted-anonymous'};
var _authEpoch=0, _scopeEpoch=0, _activeScope='', _syncAbortController=null, _saveTimer=null;
var _flushPromise=null, _flushQueued=false, _flushScope=null;
var STORAGE_KEY='', DIRTY_KEY='', PDEL_KEY='', QUARANTINE_KEY='', CONFLICT_KEY='';
var TAG_UNDO_KEY='', CHART_PROXY_KEY='', THEME_KEY='', ANTHROPIC_KEY='';
var DB={trades:[]}, _dirty={trades:new Set()}, _rowRev={trades:new Map()};
var _accountState={plan:'free',trade_count:0,trade_cap:50,entitlements:{}}, _accountStateError='';
var _page=1, _view='journal', _filter={q:'',status:'all'};
var _sim={excl:new Set(),only:new Set(),side:'all'}, _simMis=[], _simSet=[], _tagList=[];
var ENTITLEMENTS={unlimited_trades:true,simulator:true,advanced_analytics:true,ai_coach:true,chart_markers:true,csv_import:true};
var TAG_CATS=[{key:'setupTags'},{key:'mistakeTags'},{key:'emotionTags'},{key:'marketTags'}];
var _modalKeyTrap=null, _tradeChart=null, currentReader=null;
var _cloudReachable=true, _syncState='idle';
var SB_URL='https://mock.supabase.test', SB_ANON_KEY='anon-A', SB_HDR={'Content-Type':'application/json'};
var uid=function(){return 'csv-id';};
var escapeHtml=function(value){return String(value==null?'':value);};
function updateAccountUI(){}
function renderApp(){}
function saveData(){}
function toast(){}
function wireModal(){}
function setSync(){}
function isLocalhostPreview(){return false;}
function quarantineRows(){}
function authoriseFeature(){return Promise.resolve(true);}
function canCreateTrade(){return Promise.resolve(true);}
function _acceptServerRevision(){ return true; }
function _reapDeletedDuringFlush(){ return Promise.resolve(); }
function sbBatchUpsert(){ return Promise.resolve([]); }
var FileReader=class{
  constructor(){ currentReader=this; this.result=''; this.onload=null; }
  readAsText(file){ this.file=file; }
}
`;

function node() {
  return {
    innerHTML: '',
    textContent: '',
    style: {},
    dataset: {},
    classList: { add(){}, remove(){}, toggle(){} },
    setAttribute(name, value){ this[name] = String(value); },
    getAttribute(name){ return this[name] === undefined ? null : this[name]; },
    addEventListener(){},
    removeEventListener(){},
    querySelector(){ return null; },
  };
}

function user(id) {
  return { id, email: `${id}@synthetic.test`, local: false, hosted: true, authenticated: true, scope: `user-${id}` };
}

function response(payload, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(payload), json: async () => payload };
}

function createSandbox() {
  const store = Object.create(null);
  const nodes = {
    'modal-root': node(),
    'coach-body': node(),
    'f-csv': node(),
    'e-csv': node(),
  };
  const fetchCalls = [];
  const context = vm.createContext({
    console,
    Promise,
    Set,
    Map,
    JSON,
    Date,
    Error,
    Number,
    String,
    Object,
    Array,
    RegExp,
    Math,
    URL,
    AbortController,
    setTimeout,
    clearTimeout,
    localStorage: {
      setItem(key, value){ store[key] = String(value); },
      getItem(key){ return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null; },
      removeItem(key){ delete store[key]; },
    },
    document: {
      getElementById(id){ return nodes[id] || (nodes[id] = node()); },
    },
    KjrFmt: { uid: () => 'csv-id', esc: (value) => String(value) },
    fetch: async (...args) => {
      fetchCalls.push(args);
      return response([]);
    },
  });
  vm.runInContext(harnessPrefix + extractedFunctions, context, { filename: 'extracted-account.js' });
  context.setStorageScope('local-owner');
  context.applyAuthUser(user('A'));
  return { context, store, nodes, fetchCalls, localKeys: {
    storage: 'test_forex',
    dirty: 'test_forex_dirty',
    pending: 'test_forex_pendingdel',
    quarantine: 'test_forex_quarantine',
    conflicts: 'test_forex_syncconflicts',
  } };
}

function installDynamicWriteProvider(h) {
  h.context.FOREX_AUTH.headers = async () => {
    return { 'Content-Type': 'application/json', Authorization: `Bearer token-${h.context.currentUser().id}` };
  };
  h.context.fetch = async (...args) => {
    h.fetchCalls.push(args);
    return response([{
      applied: true,
      row_id: 'a-row',
      row_data: { symbol: 'EURUSD' },
      server_updated_at: 'server-time',
      server_deleted_at: null,
    }]);
  };
}

async function switchAfterHeaders(kind) {
  const h = createSandbox();
  let release;
  h.context.FOREX_AUTH.headers = () => new Promise((resolve) => { release = resolve; });
  const pending = kind === 'sync'
    ? h.context.sbSyncRow('trades', { id: 'a-trade', symbol: 'EURUSD' }, false)
    : h.context.sbRpc('get_account_state', { owner: 'A' }, h.context.scopeSnapshot());
  await Promise.resolve();
  h.context.applyAuthUser(user('B'));
  release({ 'Content-Type': 'application/json', Authorization: 'Bearer token-B' });
  await assert.rejects(pending, /session changed/i);
  assert.strictEqual(h.fetchCalls.length, 0, `${kind} issued a request after the account switched`);
}

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`PASS: ${name}`);
  } catch (error) {
    failed++;
    console.error(`FAIL: ${name}`);
    console.error(error);
  }
}

(async () => {
  await test('local initial storage keys are non-empty', async () => {
    const h = createSandbox();
    Object.values(h.localKeys).forEach((key) => assert.ok(key));
    assert.ok(h.store[h.localKeys.storage] === undefined || typeof h.store[h.localKeys.storage] === 'string');
    assert.ok(h.context.STORAGE_KEY.startsWith('test_forex_user-A'));
  });

  await test('sbSyncRow does not fetch after A headers resume in B', async () => {
    await switchAfterHeaders('sync');
  });

  await test('sbRpc does not fetch after A headers resume in B', async () => {
    await switchAfterHeaders('rpc');
  });

  await test('flushDirtyOnce does not send an A row with B credentials after the account switches', async () => {
    const h = createSandbox();
    installDynamicWriteProvider(h);
    h.context.DB.trades = [{ id: 'a-row', symbol: 'EURUSD', _updatedAt: null }];
    h.context._dirty.trades = new Set(['a-row']);
    h.context._rowRev.trades = new Map([['a-row', 1]]);
    const realSyncRow = h.context.sbSyncRow;
    h.context.sbBatchUpsert = async (table, items, scope) => {
      h.context.applyAuthUser(user('B'));
      return realSyncRow(table, items[0], false, scope).then((row) => [row]);
    };
    h.context.flushPendingDeletes = async () => {};
    await h.context._flushDirtyOnce(h.context.scopeSnapshot());
    assert.strictEqual(h.fetchCalls.length, 0, 'A dirty row was sent after the session switched to B');
  });

  await test('flush coordinator starts B independently while A is still in flight', async () => {
    const h = createSandbox();
    const calls = [];
    let releaseA;
    h.context._flushDirtyOnce = async (snap) => {
      calls.push(snap.userId);
      if (snap.userId === 'A') await new Promise(resolve => { releaseA = resolve; });
    };
    const a = h.context._flushDirty(h.context.scopeSnapshot());
    await Promise.resolve();
    assert.deepStrictEqual(calls, ['A']);
    h.context.applyAuthUser(user('B'));
    const b = h.context._flushDirty(h.context.scopeSnapshot());
    await Promise.race([b, new Promise((_, reject) => setTimeout(() => reject(new Error('B flush did not start independently')), 1000))]);
    assert.deepStrictEqual(calls, ['A', 'B'], 'B flush was stranded behind A promise');
    releaseA();
    await a;
    assert.notStrictEqual(a, b, 'account switch must not reuse A promise');
  });

  await test('flush coordinator lets A return before the original A run settles', async () => {
    const h = createSandbox();
    const calls = [];
    let releaseOriginalA;
    h.context._flushDirtyOnce = async (snap) => {
      calls.push(`${snap.userId}:${snap.epoch}`);
      if (snap.userId === 'A' && calls.length === 1) await new Promise(resolve => { releaseOriginalA = resolve; });
    };
    const originalA = h.context._flushDirty(h.context.scopeSnapshot());
    await Promise.resolve();
    h.context.applyAuthUser(user('B'));
    const b = h.context._flushDirty(h.context.scopeSnapshot());
    await b;
    h.context.applyAuthUser(user('A'));
    const returnedA = h.context._flushDirty(h.context.scopeSnapshot());
    await Promise.race([returnedA, new Promise((_, reject) => setTimeout(() => reject(new Error('returned A flush did not start')), 1000))]);
    assert.strictEqual(calls.length, 3, 'A→B→A created fewer than three scoped runs');
    assert.match(calls[0], /^A:/); assert.match(calls[1], /^B:/); assert.match(calls[2], /^A:/);
    assert.notStrictEqual(originalA, returnedA);
    releaseOriginalA();
    await originalA;
  });

  await test('flushPendingDeletes does not send an A delete with B credentials after the account switches', async () => {
    const h = createSandbox();
    installDynamicWriteProvider(h);
    const oldKey = h.context.PDEL_KEY;
    h.store[oldKey] = JSON.stringify([{ table: 'trades', id: 'a-row', expectedUpdatedAt: null, data: { symbol: 'EURUSD' } }]);
    const realValidId = h.context.isValidStoredId;
    let switched = false;
    h.context.isValidStoredId = (id) => {
      if (!switched) {
        switched = true;
        h.context.applyAuthUser(user('B'));
      }
      return realValidId(id);
    };
    await h.context.flushPendingDeletes(h.context.scopeSnapshot());
    assert.strictEqual(switched, true, 'queued delete did not reach its validation boundary');
    assert.strictEqual(h.fetchCalls.length, 0, 'A queued delete was sent after the session switched to B');
    assert.deepStrictEqual(JSON.parse(h.store[oldKey]).map((row) => row.id), ['a-row']);
  });

  await test('sbDelete does not send an A delete with B credentials after the account switches', async () => {
    const h = createSandbox();
    installDynamicWriteProvider(h);
    const oldKey = h.context.PDEL_KEY;
    const originalSetItem = h.context.localStorage.setItem;
    let switched = false;
    h.context.localStorage.setItem = (key, value) => {
      originalSetItem(key, value);
      if (key === oldKey && !switched) {
        switched = true;
        h.context.applyAuthUser(user('B'));
      }
    };
    await h.context.sbDelete('trades', 'a-row', null, { symbol: 'EURUSD' });
    assert.strictEqual(switched, true, 'direct delete did not reach its queue boundary');
    assert.strictEqual(h.fetchCalls.length, 0, 'A delete was sent after the session switched to B');
    assert.deepStrictEqual(JSON.parse(h.store[oldKey]).map((row) => row.id), ['a-row']);
  });

  await test('late A loadData cannot merge rows into B state', async () => {
    const h = createSandbox();
    let release;
    h.context.sbFetchAll = () => new Promise((resolve) => { release = resolve; });
    const pending = h.context.loadData();
    await Promise.resolve();
    h.context.applyAuthUser(user('B'));
    h.context.DB.trades = [{ id: 'b-only', symbol: 'USDJPY' }];
    h.context._dirty.trades = new Set(['b-dirty']);
    release([{ id: 'a-only', data: { symbol: 'EURUSD' }, updated_at: 'a-time', deleted_at: null }]);
    await pending;
    assert.deepStrictEqual(h.context.DB.trades, [{ id: 'b-only', symbol: 'USDJPY' }]);
    assert.deepStrictEqual([...h.context._dirty.trades], ['b-dirty']);
  });

  await test('boot load retries a queued row and refuses to report clean while it remains dirty', async () => {
    const h = createSandbox();
    h.context.sbFetchAll = async () => [];
    const row = { id: 'boot-row', symbol: 'EURUSD', side: 'long', quantity: 1, entryPrice: 1.1 };
    h.context.localStorage.setItem(h.context.STORAGE_KEY, JSON.stringify({ trades: [row] }));
    h.context._dirty.trades = new Set(['boot-row']);
    h.context._rowRev.trades = new Map([['boot-row', 1]]);
    let calls = 0;
    h.context._flushDirtyOnce = async () => { calls++; };
    const first = await h.context.loadData();
    assert.strictEqual(calls, 1, 'boot did not retry the durable dirty row');
    assert.strictEqual(first, false, 'boot claimed success while the row was still dirty');
    h.context._dirty.trades.clear();
    const second = await h.context.loadData();
    assert.strictEqual(second, true);
  });

  await test('late A loadAccountState cannot replace B plan', async () => {
    const h = createSandbox();
    let release;
    h.context.sbRpc = () => new Promise((resolve) => { release = resolve; });
    const pending = h.context.loadAccountState(h.context.scopeSnapshot());
    await Promise.resolve();
    h.context.applyAuthUser(user('B'));
    h.context._accountState = { plan: 'free', trade_count: 1, trade_cap: 50, entitlements: {} };
    release({ plan: 'pro', trade_count: 99, trade_cap: null, entitlements: { unlimited_trades: true } });
    await pending;
    assert.strictEqual(h.context._accountState.plan, 'free');
    assert.strictEqual(h.context._accountState.trade_count, 1);
  });

  await test('pending CSV reader from A refuses to import after switching to B', async () => {
    const h = createSandbox();
    h.nodes['f-csv'].files = [{ name: 'a.csv' }];
    const pending = h.context.importCSV();
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(h.context.currentReader, 'CSV reader was not created');
    h.context.applyAuthUser(user('B'));
    h.context.currentReader.result = 'symbol,quantity,entry price\nEURUSD,1,1.2\n';
    await h.context.currentReader.onload();
    assert.match(h.nodes['e-csv'].textContent, /Account changed/);
    assert.strictEqual(h.context.DB.trades.length, 0);
    await pending;
  });

  await test('CSV row IDs stay stable so a committed import can be retried safely', async () => {
    const h = createSandbox();
    h.nodes['f-csv'].files = [{ name: 'synthetic.csv' }];
    const csv = 'symbol,side,quantity,entry date,entry price\nEURUSD,long,1,2026-10-01,1.2\n';
    const rpcRows = [];
    let refreshOk = false;
    h.context.sbRpc = async (name, params) => { rpcRows.push(params.p_rows); return refreshOk ? { imported: 0, skipped_existing: 1 } : { imported: 1, skipped_existing: 0 }; };
    h.context.loadAccountState = async () => {};
    h.context.loadData = async () => refreshOk;
    h.context.toast = (message) => { h.lastToast = message; };
    h.context.importCSV();
    await new Promise(resolve => setImmediate(resolve));
    h.context.currentReader.result = csv;
    await h.context.currentReader.onload();
    assert.match(h.nodes['e-csv'].textContent, /Import committed/);
    assert.strictEqual(rpcRows.length, 1);
    const firstId = rpcRows[0][0].id;
    refreshOk = true;
    h.nodes['f-csv'].files = [{ name: 'synthetic.csv' }];
    h.context.importCSV();
    await new Promise(resolve => setImmediate(resolve));
    h.context.currentReader.result = csv;
    await h.context.currentReader.onload();
    assert.strictEqual(rpcRows.length, 2);
    assert.strictEqual(rpcRows[1][0].id, firstId, 'retry generated a new server row ID');
    assert.match(h.lastToast, /Imported 0 trade/);
  });

  await test('CSV/domain helpers reject non-finite values and impossible dates', async () => {
    const h = createSandbox();
    assert.strictEqual(h.context.finitePositive(Infinity), false);
    assert.strictEqual(h.context.finitePositive(0), false);
    assert.strictEqual(h.context.finiteNonNegative(-1), false);
    assert.strictEqual(h.context.validTradeSide('sideways'), false);
    assert.strictEqual(h.context.validTradeSide('short'), true);
    assert.strictEqual(h.context.validTradeSymbol('EUR\u0000USD'), false);
    assert.strictEqual(h.context.parseImportDate('2026-02-31'), null);
    assert.strictEqual(h.context.validInputDate('2026-02-31T10:00'), null);
    assert.ok(h.context.validInputDate('2026-02-28T10:00'));
    assert.ok(h.context.parseImportDate('2026-02-28T12:30:00Z'));
    assert.strictEqual(h.context.stableImportId('same-file', 2), h.context.stableImportId('same-file', 2));
    assert.notStrictEqual(h.context.stableImportId('same-file', 2), h.context.stableImportId('same-file', 3));
  });

  await test('saveTradeModal rejects an impossible UI calendar date', async () => {
    const h = createSandbox();
    h.context.DB.trades = [{ id: 'bad-date-row', _updatedAt: 'server-rev', symbol: 'EURUSD', side: 'long', quantity: 1, entryAt: '2026-02-28T09:00:00.000Z', entryPrice: 1.1 }];
    const values = {
      symbol: 'EURUSD', side: 'long', quantity: '2', entryAt: '2026-02-31T10:00', entryPrice: '1.2',
      exitAt: '', exitPrice: '', stopPrice: '', fees: '0', notes: '', setupTags: '', mistakeTags: '', emotionTags: '', marketTags: '',
    };
    for (const [key, value] of Object.entries(values)) {
      h.nodes['f-' + key] = node();
      h.nodes['f-' + key].value = value;
      h.nodes['e-' + key] = node();
    }
    await h.context.saveTradeModal('bad-date-row');
    assert.strictEqual(h.context.DB.trades[0].entryAt, '2026-02-28T09:00:00.000Z');
    assert.strictEqual(h.nodes['f-entryAt']['aria-invalid'], 'true');
  });

  await test('saveTradeModal preserves the server revision through upsert and CAS RPC', async () => {
    const h = createSandbox();
    const prior = { id: 'edit-row', _updatedAt: 'server-rev-A', symbol: 'EURUSD', side: 'long', quantity: 1, entryAt: '2026-10-01T09:00:00.000Z', entryPrice: 1.1, exitAt: '', exitPrice: '', stopPrice: '', fees: 0, notes: '', contractMultiplier: 1, createdAt: '2026-10-01T09:00:00.000Z' };
    h.context.DB.trades = [prior];
    h.context._rowRev.trades = new Map([['edit-row', 0]]);
    const values = {
      symbol: 'EURUSD', side: 'long', quantity: '2', entryAt: '2026-10-01T10:00', entryPrice: '1.2',
      exitAt: '', exitPrice: '', stopPrice: '', fees: '0', notes: '', setupTags: '', mistakeTags: '', emotionTags: '', marketTags: '',
    };
    for (const [key, value] of Object.entries(values)) {
      h.nodes['f-' + key] = node();
      h.nodes['f-' + key].value = value;
      h.nodes['e-' + key] = node();
    }
    let request;
    h.context.fetch = async (url, options) => {
      request = { url, options };
      return response([{ applied: true, row_id: 'edit-row', row_data: { symbol: 'EURUSD', side: 'long', quantity: 2 }, server_updated_at: 'server-rev-B', server_deleted_at: null }]);
    };
    await h.context.saveTradeModal('edit-row');
    const edited = h.context.DB.trades.find(row => row.id === 'edit-row');
    assert.strictEqual(edited._updatedAt, 'server-rev-A', 'edit dropped the CAS revision before upsert');
    const server = await h.context.sbSyncRow('trades', edited, false, h.context.scopeSnapshot());
    assert.strictEqual(JSON.parse(request.options.body).p_expected_updated_at, 'server-rev-A');
    assert.strictEqual(server._updatedAt, 'server-rev-B');
  });

  await test('successful unrelated sync cannot report clean while a conflict remains', async () => {
    const h = createSandbox();
    const conflicted = { id: 'conflict-row', symbol: 'LOCAL-CONFLICT', side: 'long', quantity: 1, _updatedAt: 'local-conflict' };
    const unrelated = { id: 'clean-row', symbol: 'LOCAL-CLEAN', side: 'long', quantity: 2, _updatedAt: 'local-clean' };
    h.context.DB.trades = [conflicted, unrelated];
    h.context._dirty.trades = new Set([conflicted.id, unrelated.id]);
    h.context._rowRev.trades = new Map([[conflicted.id, 1], [unrelated.id, 1]]);
    h.store[h.context.CONFLICT_KEY] = JSON.stringify([{
      table: 'trades', id: conflicted.id, operation: 'upsert', local: conflicted,
      server: { ...conflicted, symbol: 'SERVER-CONFLICT', _updatedAt: 'server-conflict' },
      message: 'stale write',
    }]);
    const uploads = [];
    h.context.sbBatchUpsert = async (table, rows) => { uploads.push({ table, rows }); return [{ id: unrelated.id, _updatedAt: 'server-clean' }]; };
    const realAccept = h.context._acceptServerRevision;
    h.context._acceptServerRevision = (...args) => {
      h.accepted = args;
      return realAccept(...args);
    };
    h.context.flushPendingDeletes = async () => {};
    let state = null;
    h.context.setSync = (next, message) => { state = { next, message }; };
    await h.context._flushDirtyOnce(h.context.scopeSnapshot());
    assert.strictEqual(uploads.length, 1, 'the unrelated dirty row was not dispatched');
    assert.strictEqual(h.accepted[1], unrelated.id, 'the wrong row was accepted');
    assert.strictEqual(h.context._dirty.trades.has(unrelated.id), false, 'unrelated row did not clear after its successful upload');
    assert.strictEqual(h.context._dirty.trades.has(conflicted.id), true, 'conflicted row was silently cleared');
    assert.strictEqual(state.next, 'error', 'sync reported success while a conflict remained');
    assert.match(state.message, /conflict/i);
  });

  await test('conflict resolver keeps a live cloud row for a delete conflict', async () => {
    const h = createSandbox();
    const local = { id: 'delete-live', symbol: 'LOCAL', side: 'long', quantity: 1 };
    const server = { id: 'delete-live', symbol: 'SERVER', side: 'long', quantity: 2, _updatedAt: 'server-live', _deletedAt: null };
    h.store[h.context.CONFLICT_KEY] = JSON.stringify([{ table: 'trades', id: local.id, operation: 'delete', local, server, message: 'stale delete' }]);
    h.store[h.context.PDEL_KEY] = JSON.stringify([{ table: 'trades', id: local.id, expectedUpdatedAt: 'local-rev', data: local }]);
    await h.context.resolveSyncConflict(0, 'cloud');
    assert.strictEqual(h.context.DB.trades[0].symbol, 'SERVER');
    assert.deepStrictEqual(JSON.parse(h.store[h.context.PDEL_KEY]), []);
    assert.deepStrictEqual(JSON.parse(h.store[h.context.CONFLICT_KEY]), []);
    assert.strictEqual(h.context._dirty.trades.has(local.id), false);
  });

  await test('conflict resolver drops only missing or tombstoned cloud rows', async () => {
    for (const server of [null, { id: 'delete-gone', symbol: 'SERVER', _updatedAt: 'server-deleted', _deletedAt: 'server-deleted' }]) {
      const h = createSandbox();
      const local = { id: 'delete-gone', symbol: 'LOCAL', side: 'long', quantity: 1 };
      h.context.DB.trades = [local];
      h.store[h.context.CONFLICT_KEY] = JSON.stringify([{ table: 'trades', id: local.id, operation: 'delete', local, server, message: 'stale delete' }]);
      h.store[h.context.PDEL_KEY] = JSON.stringify([{ table: 'trades', id: local.id, expectedUpdatedAt: 'local-rev', data: local }]);
      await h.context.resolveSyncConflict(0, 'cloud');
      assert.deepStrictEqual(h.context.DB.trades, []);
      assert.deepStrictEqual(JSON.parse(h.store[h.context.PDEL_KEY]), []);
      assert.deepStrictEqual(JSON.parse(h.store[h.context.CONFLICT_KEY]), []);
    }
  });

  await test('local conflict choice preserves data when a second stale write is recorded', async () => {
    const h = createSandbox();
    const local = { id: 'edit-conflict', symbol: 'LOCAL', side: 'long', quantity: 1, _updatedAt: 'local-rev' };
    const firstServer = { id: local.id, symbol: 'SERVER-1', _updatedAt: 'server-rev-1', _deletedAt: null };
    const secondServer = { id: local.id, symbol: 'SERVER-2', _updatedAt: 'server-rev-2', _deletedAt: null };
    h.context.DB.trades = [local];
    h.context._dirty.trades = new Set([local.id]);
    h.context._rowRev.trades = new Map([[local.id, 1]]);
    h.store[h.context.CONFLICT_KEY] = JSON.stringify([{ table: 'trades', id: local.id, operation: 'upsert', local, server: firstServer, message: 'stale write' }]);
    h.context._flushDirty = async (snap) => {
      assert.strictEqual(snap.userId, 'A');
      h.context._recordConflict('trades', local.id, secondServer, 'second stale write', 'upsert', h.context.DB.trades[0], snap);
    };
    await h.context.resolveSyncConflict(0, 'local');
    assert.strictEqual(h.context.DB.trades[0].symbol, 'LOCAL');
    assert.strictEqual(h.context.DB.trades[0]._updatedAt, 'server-rev-1');
    assert.strictEqual(h.context._dirty.trades.has(local.id), true);
    const conflicts = JSON.parse(h.store[h.context.CONFLICT_KEY]);
    assert.strictEqual(conflicts.length, 1);
    assert.strictEqual(conflicts[0].server.symbol, 'SERVER-2');
  });

  await test('account switch closes the old modal and clears derived state', async () => {
    const h = createSandbox();
    h.nodes['modal-root'].innerHTML = 'A modal';
    h.nodes['coach-body'].dataset.done = '1';
    h.nodes['coach-body'].innerHTML = 'A response';
    h.context.DB.trades = [{ id: 'a-trade' }];
    h.context._dirty.trades = new Set(['a-trade']);
    h.context._accountState = { plan: 'pro', trade_count: 1, trade_cap: null, entitlements: { simulator: true } };
    h.context._accountStateError = 'old account error';
    h.context.applyAuthUser(user('B'));
    assert.strictEqual(h.nodes['modal-root'].innerHTML, '');
    assert.strictEqual(h.nodes['coach-body'].dataset.done, '');
    assert.strictEqual(h.nodes['coach-body'].innerHTML, '');
    assert.strictEqual(h.context.DB.trades.length, 0);
    assert.strictEqual(h.context._dirty.trades.size, 0);
    assert.strictEqual(h.context._accountState.plan, 'free');
    assert.strictEqual(h.context._accountStateError, '');
  });

  await test('queued dirty rows survive sign-out in the old account scope', async () => {
    const h = createSandbox();
    h.context._dirty.trades = new Set(['a-dirty']);
    h.context._rowRev.trades = new Map([['a-dirty', 1]]);
    h.context._persistDirty();
    const oldKey = h.context.storageKeyForScope('user-A') + '_dirty';
    assert.deepStrictEqual(JSON.parse(h.store[oldKey]).trades, ['a-dirty']);
    h.context.applyAuthUser({ id: null, email: null, local: false, hosted: true, authenticated: false });
    assert.deepStrictEqual(JSON.parse(h.store[oldKey]).trades, ['a-dirty']);
    assert.strictEqual(h.context._dirty.trades.size, 0);
  });

  console.log(`Tests completed: ${passed} passed, ${failed} failed.`);
  if (failed) process.exitCode = 1;
})().catch((error) => { console.error(error); process.exitCode = 1; });
