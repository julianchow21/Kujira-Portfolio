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
  'rowRevision', 'markDirty', 'parseCSV', 'parseImportDate', 'upsertTradeSilent',
  '_queueDelete', '_unqueueDelete', 'sbDelete', 'flushPendingDeletes',
  '_flushDirtyOnce', 'importCSV', 'closeModal',
];

const extractedFunctions = FUNCTION_NAMES.map((name) => extractFunction(indexSrc, name)).join('\n');
const harnessPrefix = `
var APP={storageKey:'test_forex'}, FREE_TRADE_CAP=50;
var TABLES=['trades'], STORED_ID_MAX=64, SB_PAGE_SIZE=1000;
var FOREX_CONFIG={mode:'hosted'};
var FOREX_AUTH={headers:async function(){return {'Content-Type':'application/json',Authorization:'Bearer token-A'};}};
var _authUser={id:null,email:null,local:false,hosted:true,authenticated:false,scope:'hosted-anonymous'};
var _authEpoch=0, _scopeEpoch=0, _activeScope='', _syncAbortController=null, _saveTimer=null;
var STORAGE_KEY='', DIRTY_KEY='', PDEL_KEY='', QUARANTINE_KEY='', CONFLICT_KEY='';
var TAG_UNDO_KEY='', CHART_PROXY_KEY='', THEME_KEY='', ANTHROPIC_KEY='';
var DB={trades:[]}, _dirty={trades:new Set()}, _rowRev={trades:new Map()};
var _accountState={plan:'free',trade_count:0,trade_cap:50,entitlements:{}}, _accountStateError='';
var _page=1, _view='journal', _filter={q:'',status:'all'};
var _sim={excl:new Set(),only:new Set(),side:'all'}, _simMis=[], _simSet=[], _tagList=[];
var ENTITLEMENTS={unlimited_trades:true,simulator:true,advanced_analytics:true,ai_coach:true,chart_markers:true,csv_import:true};
var _modalKeyTrap=null, _tradeChart=null, currentReader=null;
var _cloudReachable=true, _syncState='idle';
var SB_URL='https://mock.supabase.test', SB_ANON_KEY='anon-A', SB_HDR={'Content-Type':'application/json'};
var uid=function(){return 'csv-id';};
function updateAccountUI(){}
function renderApp(){}
function saveData(){}
function toast(){}
function wireModal(){}
function setSync(){}
function isLocalhostPreview(){return false;}
function quarantineRows(){}
function authoriseFeature(){return Promise.resolve(true);}
function _acceptServerRevision(){ return true; }
function _reapDeletedDuringFlush(){ return Promise.resolve(); }
function _recordConflict(){}
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
