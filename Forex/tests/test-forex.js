// Forex v-tests: zero-dependency Node test suite for Forex/index.html plus its two
// vendored lib engines (lib/kjr-format.js, lib/kjr-calendar.js).
// House style: plain Node, tiny assert helpers, PASS/FAIL per test, summary count,
// non-zero exit on failure, no npm dependencies. Mirrors Portfolio/tests/test-core.js.
//
// Forex/index.html holds its logic in one inline <script> with top-level DOM calls,
// so it cannot be require()'d or eval()'d wholesale. This file reads the file as text
// and slices out named, self-contained function/const declarations by brace-matching,
// then runs the extracted source in a fresh vm context. This tests the REAL shipped
// code, not a hand copy. Do not modify Forex/index.html, lib/kjr-format.js, or
// lib/kjr-calendar.js to make this suite pass.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const INDEX_PATH = path.join(__dirname, '..', 'index.html');
const SCHEMA_PATH = path.join(__dirname, '..', 'schema.sql');
const CAL_PATH = path.join(__dirname, '..', 'lib', 'kjr-calendar.js');
const FMT_PATH = path.join(__dirname, '..', 'lib', 'kjr-format.js');
const WORKER_PATH = path.join(__dirname, '..', 'Worker', 'Stripe Webhook.js');
const SW_PATH = path.join(__dirname, '..', 'sw.js');
const indexSrc = fs.readFileSync(INDEX_PATH, 'utf8');
const schemaSrc = fs.readFileSync(SCHEMA_PATH, 'utf8');
const calSrc = fs.readFileSync(CAL_PATH, 'utf8');
const workerSrc = fs.readFileSync(WORKER_PATH, 'utf8');
const swSrc = fs.readFileSync(SW_PATH, 'utf8');

/* ====================== Extraction helpers (see Trading/tests/test-trading.js for full notes) ====================== */

function sliceFromMatch(source, start) {
  let i = source.indexOf('(', start);
  if (i === -1) throw new Error('sliceFromMatch: no "(" found from index ' + start);
  let depth = 1; i++;
  while (depth > 0) {
    if (source[i] === '(') depth++;
    else if (source[i] === ')') depth--;
    i++;
  }
  while (source[i] !== '{') i++;
  let braceDepth = 0;
  for (; i < source.length; i++) {
    if (source[i] === '{') braceDepth++;
    else if (source[i] === '}') { braceDepth--; if (braceDepth === 0) { i++; break; } }
  }
  if (source[i] === ';') i++;
  return source.slice(start, i);
}
function extractFunction(source, name, fromPath) {
  const re = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(');
  const m = re.exec(source);
  if (!m) throw new Error('extractFunction: "' + name + '" not found in ' + fromPath);
  return sliceFromMatch(source, m.index);
}
function extractAssignedFunction(source, matchStr, fromPath) {
  // e.g. matchStr = "Cal.prototype._computeCells = function"
  const idx = source.indexOf(matchStr);
  if (idx === -1) throw new Error('extractAssignedFunction: "' + matchStr + '" not found in ' + fromPath);
  return sliceFromMatch(source, idx);
}
function extractConst(source, name, fromPath) {
  const re = new RegExp('\\b(?:const|let)\\s+' + name + '\\s*=');
  const m = re.exec(source);
  if (!m) throw new Error('extractConst: "' + name + '" not found in ' + fromPath);
  const start = m.index;
  let i = m.index + m[0].length;
  let depth = 0;
  for (; i < source.length; i++) {
    const c = source[i];
    if (c === '{' || c === '(' || c === '[') depth++;
    else if (c === '}' || c === ')' || c === ']') depth--;
    else if (c === ';' && depth === 0) { i++; break; }
  }
  return source.slice(start, i).replace(/^(const|let)\s+/, 'var ');
}
function toPlain(x) { return JSON.parse(JSON.stringify(x)); }

/* ====================== Extract Forex/index.html functions + consts ====================== */

const FN_NAMES = ['deriveTrade', 'computeStats', 'mergeTable', 'parseCSV', 'sortVal',
  'tradeTags', 'parseTags', 'allTags', 'entitlement', 'isValidStoredId',
  'splitValidRows', 'field'];
const CONST_NAMES = ['PLAN', 'ENTITLEMENTS', 'STORED_ID_MAX'];

// allTags() reads the module-level `DB.trades` array; stub the minimal shape it needs
// (a plain data global, not app behaviour) so the function is callable in isolation.
let extractedCode = 'var DB = { trades: [] }; function isLocalOwner(){ return true; }\n';
const missing = [];
for (const n of FN_NAMES) {
  try { extractedCode += extractFunction(indexSrc, n, INDEX_PATH) + '\n'; }
  catch (e) { missing.push(n + ' (function, index.html): ' + e.message); }
}
for (const n of CONST_NAMES) {
  try { extractedCode += extractConst(indexSrc, n, INDEX_PATH) + '\n'; }
  catch (e) { missing.push(n + ' (const, index.html): ' + e.message); }
}

/* Sync contract sandbox. It supplies inert local dependencies and a mocked
   fetch per test, so no network or live Supabase data can be touched. */
const SYNC_FN_NAMES = ['isValidStoredId', 'splitValidRows', 'assertStoredId',
  'assertSyncTable', 'sbSyncRow', 'sbPageUrl', 'sbFetchAll', 'rowRevision',
  '_acceptServerRevision', '_flushDirty', '_queueDelete', '_unqueueDelete',
  '_recordConflict', 'readSyncConflicts', '_hasOpenConflict', 'sbDelete', 'flushPendingDeletes'];
let syncCode = [
  "var TABLES=['trades'];",
  'var STORED_ID_MAX=64, SB_PAGE_SIZE=1000;',
  "var SB_URL='https://mock.supabase.test', SB_HDR={'Content-Type':'application/json'};",
  'var DB={trades:[]}, _dirty={trades:new Set()}, _rowRev={trades:new Map()};',
  "var APP={storageKey:'test_forex'}, STORAGE_KEY='test_forex', persistedStore={};",
  "var PDEL_KEY='test_pending_deletes', CONFLICT_KEY='test_sync_conflicts';",
  "var localStorage={setItem:(k,v)=>{persistedStore[k]=v;},getItem:(k)=>persistedStore[k]||null};",
  'function toast(){}',
  'function isLocalhostPreview(){return false;} function sbConfigured(){return true;} function setSync(){}',
  "var _activeScope='test', _scopeEpoch=0, _authEpoch=0, _syncAbortController=null;",
  'function scopeSnapshot(){return {scope:_activeScope,epoch:_scopeEpoch,authEpoch:_authEpoch,key:STORAGE_KEY,userId:currentUser().id||null};}',
  "function scopeIsCurrent(s){return !!s&&s.scope===_activeScope&&s.epoch===_scopeEpoch&&s.authEpoch===_authEpoch&&(s.userId||null)===(currentUser().id||null);}",
  'async function sbHeaders(){return SB_HDR;}',
  'var _flushPromise=null, _flushQueued=false, _flushScope=null, flushCalls=0, flushGate=null;',
  'async function _flushDirtyOnce(){ flushCalls++; if(flushGate) await flushGate; }',
  "function currentUser(){ return {id:'00000000-0000-0000-0000-000000000001'}; }",
  'function quarantineRows(source,table,rows){ quarantined.push({source,table,rows}); }',
  'var quarantined=[];',
].join('\n') + '\n';
for (const n of SYNC_FN_NAMES) {
  try { syncCode += extractFunction(indexSrc, n, INDEX_PATH) + '\n'; }
  catch (e) { missing.push(n + ' (sync function, index.html): ' + e.message); }
}

/* ====================== Extract kjr-calendar.js's internal Cal._computeCells ====================== */
// require('../lib/kjr-calendar.js') returns { KjrCalendar: { mount, esc, VERSION } }
// (verified below), the internal `Cal` constructor and `_computeCells` grid maths are
// NOT exposed on that surface, so they need the same brace-matching extraction technique.
let calCode = 'var F;\n'; // KjrFmt not loaded in this sandbox; pad()/isoFromYMD() fallback branches run instead
try { calCode += extractFunction(calSrc, 'pad', CAL_PATH) + '\n'; }
catch (e) { missing.push('pad (function, kjr-calendar.js): ' + e.message); }
try { calCode += extractFunction(calSrc, 'isoFromYMD', CAL_PATH) + '\n'; }
catch (e) { missing.push('isoFromYMD (function, kjr-calendar.js): ' + e.message); }
calCode += 'function Cal(){}\n'; // stub constructor; _computeCells is invoked via .call(fakeThis), never `new Cal()`
try { calCode += extractAssignedFunction(calSrc, 'Cal.prototype._computeCells = function', CAL_PATH) + '\n'; }
catch (e) { missing.push('Cal.prototype._computeCells (kjr-calendar.js): ' + e.message); }

if (missing.length) {
  console.error('❌ HARNESS ERROR: could not extract the following:');
  missing.forEach(m => console.error('   - ' + m));
  process.exit(1);
}

const sandbox = {};
const context = vm.createContext(sandbox);
vm.runInContext(extractedCode, context, { filename: 'extracted-forex-index.js' });

const syncSandbox = {};
const syncContext = vm.createContext(syncSandbox);
vm.runInContext(syncCode, syncContext, { filename: 'extracted-forex-sync.js' });

const calSandbox = {};
const calContext = vm.createContext(calSandbox);
vm.runInContext(calCode, calContext, { filename: 'extracted-kjr-calendar.js' });

/* ====================== Evaluate the dormant Stripe Worker seam ====================== */
// The Worker is loaded from its real source with only its ESM wrapper adapted
// for vm. Its fetch is replaced per test, so no network or live Supabase data
// can be touched.
const { webcrypto } = require('crypto');
const { TextEncoder } = require('util');
const workerCode = workerSrc.replace('export default {', 'const workerDefault = {')
  + '\nthis.workerDefault = workerDefault;\n';
const WORKER_NOW_SECONDS = 1770000000;
class FixedDate extends Date {
  static now() { return WORKER_NOW_SECONDS * 1000; }
}
class TestResponse {
  constructor(body = '', init = {}) {
    this._body = String(body);
    this.status = init.status === undefined ? 200 : init.status;
    this.ok = this.status >= 200 && this.status < 300;
    const headerMap = new Map(Object.entries(init.headers || {})
      .map(([key, value]) => [String(key).toLowerCase(), String(value)]));
    this.headers = {
      get(name) {
        const key = String(name).toLowerCase();
        return headerMap.has(key) ? headerMap.get(key) : null;
      }
    };
  }
  async text() { return this._body; }
  async json() { return JSON.parse(this._body); }
}
const workerSandbox = {
  crypto: webcrypto,
  TextEncoder,
  URL,
  Response: TestResponse,
  Date: FixedDate,
};
const workerContext = vm.createContext(workerSandbox);
vm.runInContext(workerCode, workerContext, { filename: WORKER_PATH });

function makeWebhookRequest(body, signatureHeader) {
  return {
    method: 'POST',
    url: 'https://forex-worker.test/webhook',
    headers: {
      get(name) {
        return String(name).toLowerCase() === 'stripe-signature' ? signatureHeader : null;
      }
    },
    text: async () => body,
  };
}
async function hmacHex(timestamp, rawBody, secret) {
  const key = await webcrypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await webcrypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${timestamp}.${rawBody}`)
  );
  return Buffer.from(new Uint8Array(signature)).toString('hex');
}

/* ====================== Test runner ====================== */

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`✅ PASS: ${name}`); passed++; }
  catch (e) { console.error(`❌ FAIL: ${name}`); console.error(e); failed++; }
}
function closeTo(actual, expected, tol, msg) {
  assert.ok(Math.abs(actual - expected) < tol, (msg || '') + ` expected ${expected}, got ${actual}`);
}

console.log('--- Testing Forex/index.html (extracted) ---');

/* ====================== deriveTrade ====================== */
test('deriveTrade - long win: gross/net/rMultiple/returnPct hand-computed', () => {
  const t = { side: 'long', entryPrice: 100, exitPrice: 110, quantity: 10, fees: 5, stopPrice: 95,
    contractMultiplier: 1, entryAt: '2026-01-01T09:00:00Z', exitAt: '2026-01-01T10:30:00Z' };
  const d = sandbox.deriveTrade(t);
  assert.strictEqual(d.status, 'closed');
  assert.strictEqual(d.gross, 100); // (110-100)*10
  assert.strictEqual(d.net, 95);    // 100-5 fees
  assert.strictEqual(d.rMultiple, 1.9); // risk=|100-95|*10=50, 95/50
  assert.strictEqual(d.holdingMs, 90 * 60 * 1000);
  assert.strictEqual(d.returnPct, 10); // (100/1000)*100
});
test('deriveTrade - long loss: gross/net/rMultiple negative, returnPct negative', () => {
  const t = { side: 'long', entryPrice: 100, exitPrice: 90, quantity: 10, fees: 5, stopPrice: 95,
    entryAt: '2026-01-01T09:00:00Z', exitAt: '2026-01-01T10:00:00Z' };
  const d = sandbox.deriveTrade(t);
  assert.strictEqual(d.gross, -100);
  assert.strictEqual(d.net, -105);
  assert.strictEqual(d.rMultiple, -2.1); // -105/50
  assert.strictEqual(d.returnPct, -10);
});
test('deriveTrade - short: net P&L direction is correct (price fell, short profits)', () => {
  const t = { side: 'short', entryPrice: 100, exitPrice: 90, quantity: 10, fees: 5, stopPrice: 105,
    entryAt: '2026-01-01T09:00:00Z', exitAt: '2026-01-01T10:00:00Z' };
  const d = sandbox.deriveTrade(t);
  assert.strictEqual(d.sign, -1);
  assert.strictEqual(d.gross, 100); // (90-100)*10*(-1)
  assert.strictEqual(d.net, 95);
  assert.strictEqual(d.rMultiple, 1.9); // risk=|100-105|*10=50, 95/50
});
test('deriveTrade - short: rMultiple sign matches the (winning) net P&L direction', () => {
  // A winning short (net=95, positive) should have a positive rMultiple, since risk is unsigned.
  const t = { side: 'short', entryPrice: 100, exitPrice: 90, quantity: 10, fees: 5, stopPrice: 105,
    entryAt: '2026-01-01T09:00:00Z', exitAt: '2026-01-01T10:00:00Z' };
  const d = sandbox.deriveTrade(t);
  assert.strictEqual(Math.sign(d.net), Math.sign(d.rMultiple), 'rMultiple sign should track net P&L sign');
});
test('deriveTrade - short: returnPct sign matches net P&L for both winning and losing shorts', () => {
  // gross already carries the short/long sign, so returnPct is simply (gross/basis)*100.
  const win = { side: 'short', entryPrice: 100, exitPrice: 90, quantity: 10, fees: 5, stopPrice: 105,
    entryAt: '2026-01-01T09:00:00Z', exitAt: '2026-01-01T10:00:00Z' };
  const dWin = sandbox.deriveTrade(win);
  assert.strictEqual(dWin.net, 95); // sanity: genuinely a winning trade
  assert.strictEqual(dWin.returnPct, 10); // (100/1000)*100, positive like the win

  const loss = { side: 'short', entryPrice: 100, exitPrice: 110, quantity: 10, fees: 5, stopPrice: 105,
    entryAt: '2026-01-01T09:00:00Z', exitAt: '2026-01-01T10:00:00Z' };
  const dLoss = sandbox.deriveTrade(loss);
  assert.strictEqual(dLoss.net, -105); // sanity: genuinely a losing trade
  assert.strictEqual(dLoss.returnPct, -10); // (-100/1000)*100, negative like the loss
});
test('deriveTrade - fees are subtracted from gross to produce net', () => {
  const t = { side: 'long', entryPrice: 100, exitPrice: 105, quantity: 1, fees: 2.5,
    entryAt: '2026-01-01T09:00:00Z', exitAt: '2026-01-01T10:00:00Z' };
  const d = sandbox.deriveTrade(t);
  assert.strictEqual(d.gross, 5);
  assert.strictEqual(d.net, 2.5);
});
test('deriveTrade - contractMultiplier scales gross/net/returnPct proportionally', () => {
  const t = { side: 'long', entryPrice: 100, exitPrice: 102, quantity: 2, fees: 0, contractMultiplier: 50,
    entryAt: '2026-01-01T09:00:00Z', exitAt: '2026-01-01T10:00:00Z' };
  const d = sandbox.deriveTrade(t);
  assert.strictEqual(d.gross, 200); // (102-100)*2*50
  assert.strictEqual(d.mult, 50);
  assert.strictEqual(d.returnPct, 2); // (200/(100*2*50))*100
});
test('deriveTrade - open trade (no exit) is status "open" with every derived field null', () => {
  const t = { side: 'long', entryPrice: 100, quantity: 10 };
  const d = sandbox.deriveTrade(t);
  assert.strictEqual(d.status, 'open');
  assert.strictEqual(d.gross, null);
  assert.strictEqual(d.net, null);
  assert.strictEqual(d.rMultiple, null);
  assert.strictEqual(d.holdingMs, null);
  assert.strictEqual(d.returnPct, null);
});
test('deriveTrade - zero stop distance guards the R-multiple division, stays null (not Infinity)', () => {
  const t = { side: 'long', entryPrice: 100, exitPrice: 110, quantity: 10, fees: 0, stopPrice: 100,
    entryAt: '2026-01-01T09:00:00Z', exitAt: '2026-01-01T10:00:00Z' };
  const d = sandbox.deriveTrade(t);
  assert.strictEqual(d.rMultiple, null);
});
test('deriveTrade - absent stopPrice also leaves rMultiple null', () => {
  const t = { side: 'long', entryPrice: 100, exitPrice: 110, quantity: 10, fees: 0,
    entryAt: '2026-01-01T09:00:00Z', exitAt: '2026-01-01T10:00:00Z' };
  const d = sandbox.deriveTrade(t);
  assert.strictEqual(d.rMultiple, null);
});
test('deriveTrade - zero entry price guards the returnPct division, stays null (not Infinity/NaN)', () => {
  const t = { side: 'long', entryPrice: 0, exitPrice: 10, quantity: 10, fees: 0,
    entryAt: '2026-01-01T09:00:00Z', exitAt: '2026-01-01T10:00:00Z' };
  const d = sandbox.deriveTrade(t);
  assert.strictEqual(d.returnPct, null);
  assert.strictEqual(d.gross, 100); // gross math itself is still well-defined
});

/* ====================== computeStats ====================== */
test('computeStats - empty list returns the documented zero-state shape', () => {
  const s = sandbox.computeStats([]);
  assert.deepStrictEqual(toPlain(s), {
    n: 0, openCount: 0, netPnl: 0, winRate: null, wins: 0, losses: 0, be: 0,
    profitFactor: null, avgWin: 0, avgLoss: 0, payoff: null, expCcy: null, expR: null,
    maxDD: 0, avgHoldMs: null, equity: [0], largestWin: null, largestLoss: null,
  });
});
test('computeStats - single trade', () => {
  const t = { side: 'long', entryPrice: 100, exitPrice: 105, quantity: 10, fees: 0,
    entryAt: '2026-01-01T09:00:00Z', exitAt: '2026-01-01T10:00:00Z' };
  const s = sandbox.computeStats([t]);
  assert.strictEqual(s.n, 1);
  assert.strictEqual(s.netPnl, 50);
  assert.strictEqual(s.winRate, 100);
  assert.strictEqual(s.wins, 1);
  assert.strictEqual(s.losses, 0);
  assert.strictEqual(s.profitFactor, Infinity); // no losers, gp>0 -> Infinity divide-by-zero guard
  assert.deepStrictEqual(toPlain(s.equity), [0, 50]);
});
test('computeStats - all winners: profitFactor is Infinity (divide-by-zero guard), avgLoss is 0', () => {
  const mk = (net, day) => ({ side: 'long', entryPrice: 100, exitPrice: 100 + net / 10, quantity: 10, fees: 0,
    entryAt: `2026-01-0${day}T09:00:00Z`, exitAt: `2026-01-0${day}T10:00:00Z` });
  const s = sandbox.computeStats([mk(50, 1), mk(30, 2)]);
  assert.strictEqual(s.profitFactor, Infinity);
  assert.strictEqual(s.avgLoss, 0);
  assert.strictEqual(s.losses, 0);
  assert.strictEqual(s.maxDD, 0); // monotonically increasing equity curve
});
test('computeStats - all losers: profitFactor is 0 (not an error), avgWin is 0', () => {
  const mk = (net, day) => ({ side: 'long', entryPrice: 100, exitPrice: 100 + net / 10, quantity: 10, fees: 0,
    entryAt: `2026-01-0${day}T09:00:00Z`, exitAt: `2026-01-0${day}T10:00:00Z` });
  const s = sandbox.computeStats([mk(-40, 1), mk(-20, 2)]);
  assert.strictEqual(s.profitFactor, 0);
  assert.strictEqual(s.avgWin, 0);
  assert.strictEqual(s.wins, 0);
});
test('computeStats - known 5-trade sequence: maxDD, expectancy, equity curve all hand-verified', () => {
  // net P&L in exit order: +100, -50, +30, -80, +60 -> equity [0,100,50,80,0,60]
  const trades = [
    { side: 'long', entryPrice: 100, exitPrice: 110, quantity: 10, fees: 0, entryAt: '2026-01-01T09:00:00Z', exitAt: '2026-01-01T10:00:00Z' },
    { side: 'long', entryPrice: 100, exitPrice: 95, quantity: 10, fees: 0, entryAt: '2026-01-02T09:00:00Z', exitAt: '2026-01-02T10:00:00Z' },
    { side: 'long', entryPrice: 100, exitPrice: 103, quantity: 10, fees: 0, entryAt: '2026-01-03T09:00:00Z', exitAt: '2026-01-03T10:00:00Z' },
    { side: 'long', entryPrice: 100, exitPrice: 92, quantity: 10, fees: 0, entryAt: '2026-01-04T09:00:00Z', exitAt: '2026-01-04T10:00:00Z' },
    { side: 'long', entryPrice: 100, exitPrice: 106, quantity: 10, fees: 0, entryAt: '2026-01-05T09:00:00Z', exitAt: '2026-01-05T10:00:00Z' },
  ];
  const s = sandbox.computeStats(trades);
  assert.strictEqual(s.n, 5);
  assert.strictEqual(s.netPnl, 60);
  assert.strictEqual(s.wins, 3);
  assert.strictEqual(s.losses, 2);
  assert.strictEqual(s.winRate, 60);
  closeTo(s.profitFactor, 190 / 130, 1e-9);
  closeTo(s.avgWin, 190 / 3, 1e-9);
  assert.strictEqual(s.avgLoss, 65);
  closeTo(s.payoff, (190 / 3) / 65, 1e-9);
  assert.strictEqual(s.expCcy, 12);
  assert.strictEqual(s.maxDD, 100); // peak 100 at trade 1, trough 0 at trade 4 -> dd 100
  assert.strictEqual(s.avgHoldMs, 3600000); // every trade held exactly 1 hour
  assert.deepStrictEqual(toPlain(s.equity), [0, 100, 50, 80, 0, 60]);
  assert.strictEqual(s.largestWin, 100);
  assert.strictEqual(s.largestLoss, -80);
});

/* ====================== mergeTable ====================== */
test('mergeTable - dirty local row beats cloud row for the same id', () => {
  const cloud = [{ id: 1, v: 'cloud1' }];
  const local = [{ id: 1, v: 'local1-dirty' }];
  const out = sandbox.mergeTable(cloud, local, new Set([1]));
  assert.deepStrictEqual(toPlain(out), [{ id: 1, v: 'local1-dirty' }]);
});
test('mergeTable - clean (non-dirty) local row loses to cloud', () => {
  const cloud = [{ id: 1, v: 'cloud1' }];
  const local = [{ id: 1, v: 'local1-stale' }];
  const out = sandbox.mergeTable(cloud, local, new Set()); // nothing dirty
  assert.deepStrictEqual(toPlain(out), [{ id: 1, v: 'cloud1' }]);
});
test('mergeTable - a row only present in cloud appears in the result', () => {
  const cloud = [{ id: 1, v: 'cloud1' }, { id: 2, v: 'cloud2' }];
  const local = [{ id: 1, v: 'local1-dirty' }];
  const out = sandbox.mergeTable(cloud, local, new Set([1]));
  const ids = toPlain(out).map(r => r.id).sort();
  assert.deepStrictEqual(ids, [1, 2]);
});
test('mergeTable - a row only local-and-dirty (never synced) survives the merge', () => {
  const cloud = [{ id: 1, v: 'cloud1' }];
  const local = [{ id: 1, v: 'local1-dirty' }, { id: 99, v: 'brand-new-local' }];
  const out = sandbox.mergeTable(cloud, local, new Set([1, 99]));
  const byId = new Map(out.map(r => [r.id, r]));
  assert.strictEqual(byId.get(99).v, 'brand-new-local');
});
test('mergeTable - empty cloud and local inputs return an empty array', () => {
  assert.deepStrictEqual(toPlain(sandbox.mergeTable([], [], new Set())), []);
  assert.deepStrictEqual(toPlain(sandbox.mergeTable([], [], new Set(['x']))), []);
});
test('mergeTable - an empty cloud never erases existing local rows', () => {
  const local = [{ id: 'local_1', v: 'kept' }];
  assert.deepStrictEqual(toPlain(sandbox.mergeTable([], local, new Set())), local);
});
test('mergeTable - cloud tombstones remove clean local rows', () => {
  const cloud = [{ id: 'trade_1', _deletedAt: '2026-08-29T00:00:00Z' }];
  const local = [{ id: 'trade_1', v: 'old local' }];
  assert.deepStrictEqual(toPlain(sandbox.mergeTable(cloud, local, new Set())), []);
});
test('mergeTable - a fast client clock does not outrank a server version', () => {
  const cloud = [{ id: 'trade_1', v: 'server wins', _updatedAt: '2026-01-01T00:00:00Z' }];
  const local = [{ id: 'trade_1', v: 'fast client', updatedAt: '2099-01-01T00:00:00Z' }];
  assert.strictEqual(sandbox.mergeTable(cloud, local, new Set())[0].v, 'server wins');
});

/* ====================== stored IDs + form accessibility ====================== */
test('isValidStoredId - accepts generated and UUID-style IDs within the cap', () => {
  assert.strictEqual(sandbox.isValidStoredId('abc123'), true);
  assert.strictEqual(sandbox.isValidStoredId('550e8400-e29b-41d4-a716-446655440000'), true);
  assert.strictEqual(sandbox.isValidStoredId('trade_01'), true);
});
test('isValidStoredId - rejects quote/script payloads, whitespace and overlong IDs', () => {
  assert.strictEqual(sandbox.isValidStoredId("x');alert(1)//"), false);
  assert.strictEqual(sandbox.isValidStoredId('<script>alert(1)</script>'), false);
  assert.strictEqual(sandbox.isValidStoredId('trade 01'), false);
  assert.strictEqual(sandbox.isValidStoredId('a'.repeat(65)), false);
});
test('splitValidRows - quarantinable rows are separated from valid stored rows', () => {
  const out = sandbox.splitValidRows([{ id: 'ok_1' }, { id: "bad'id" }, null]);
  assert.deepStrictEqual(toPlain(out.valid), [{ id: 'ok_1' }]);
  assert.deepStrictEqual(toPlain(out.rejected), [{ id: "bad'id" }, null]);
});
test('field - programme-links label, input and validation error', () => {
  const html = sandbox.field('symbol', 'Symbol', true, '<input id="f-symbol" type="text">');
  assert.match(html, /<label for="f-symbol">/);
  assert.match(html, /aria-describedby="e-symbol"/);
  assert.match(html, /aria-invalid="false"/);
  assert.match(html, /id="e-symbol" aria-live="polite"/);
});

/* ====================== parseCSV ====================== */
test('parseCSV - quoted field with an embedded comma', () => {
  const rows = sandbox.parseCSV('a,"b,c",d\n');
  assert.deepStrictEqual(toPlain(rows), [['a', 'b,c', 'd']]);
});
test('parseCSV - doubled-quote escape inside a quoted field', () => {
  const rows = sandbox.parseCSV('a,"he said ""hi""",c\n');
  assert.deepStrictEqual(toPlain(rows), [['a', 'he said "hi"', 'c']]);
});
test('parseCSV - CRLF line endings', () => {
  const rows = sandbox.parseCSV('a,b,c\r\nd,e,f\r\n');
  assert.deepStrictEqual(toPlain(rows), [['a', 'b', 'c'], ['d', 'e', 'f']]);
});
test('parseCSV - trailing newline does not create a phantom empty row', () => {
  const withNl = sandbox.parseCSV('a,b,c\nd,e,f\n');
  const withoutNl = sandbox.parseCSV('a,b,c\nd,e,f');
  assert.deepStrictEqual(toPlain(withNl), [['a', 'b', 'c'], ['d', 'e', 'f']]);
  assert.deepStrictEqual(toPlain(withoutNl), [['a', 'b', 'c'], ['d', 'e', 'f']]);
});
test('parseCSV - a fully empty-cell row is dropped, a row with any content is kept', () => {
  const rows = sandbox.parseCSV('a,b,c\n,,\nd,e,f\n');
  assert.deepStrictEqual(toPlain(rows), [['a', 'b', 'c'], ['d', 'e', 'f']]);
});
test('parseCSV - a row with at least one non-empty cell is kept even if others are blank', () => {
  const rows = sandbox.parseCSV('a,,c\n,,\n');
  assert.deepStrictEqual(toPlain(rows), [['a', '', 'c']]);
});

/* ====================== sortVal ====================== */
test('sortVal - each sort key returns a comparable value for a closed trade', () => {
  const t = { symbol: 'eurusd', side: 'long', entryAt: '2026-01-01T09:00:00Z', quantity: 5,
    entryPrice: 1.1, exitPrice: 1.2, exitAt: '2026-01-01T10:00:00Z', fees: 0 };
  assert.strictEqual(sandbox.sortVal(t, 'symbol'), 'eurusd');
  assert.strictEqual(sandbox.sortVal(t, 'side'), 'long');
  assert.strictEqual(typeof sandbox.sortVal(t, 'entryAt'), 'number');
  assert.strictEqual(sandbox.sortVal(t, 'qty'), 5);
  assert.strictEqual(sandbox.sortVal(t, 'entryPrice'), 1.1);
  assert.strictEqual(sandbox.sortVal(t, 'exitPrice'), 1.2);
  assert.strictEqual(typeof sandbox.sortVal(t, 'net'), 'number');
  assert.strictEqual(sandbox.sortVal(t, 'status'), 'closed');
  assert.strictEqual(sandbox.sortVal(t, 'unknown-key'), 0); // default branch
});
test('sortVal - an open trade never throws and sorts to the -Infinity end for closed-only fields', () => {
  const t = { symbol: 'gbpusd', side: 'short', entryAt: '2026-01-01T09:00:00Z', quantity: 5, entryPrice: 1.3 };
  assert.strictEqual(sandbox.sortVal(t, 'exitPrice'), -Infinity);
  assert.strictEqual(sandbox.sortVal(t, 'net'), -Infinity);
  assert.strictEqual(sandbox.sortVal(t, 'r'), -Infinity);
  assert.strictEqual(sandbox.sortVal(t, 'status'), 'open');
});

/* ====================== tradeTags / parseTags / allTags ====================== */
test('tradeTags - returns the array for a known category, empty array when absent/malformed', () => {
  assert.deepStrictEqual(toPlain(sandbox.tradeTags({ setupTags: ['a', 'b'] }, 'setupTags')), ['a', 'b']);
  assert.deepStrictEqual(toPlain(sandbox.tradeTags({}, 'setupTags')), []);
  assert.deepStrictEqual(toPlain(sandbox.tradeTags({ setupTags: 'not-an-array' }, 'setupTags')), []);
});
test('parseTags - trims whitespace, collapses internal runs, dedupes case-insensitively (first casing kept)', () => {
  const out = sandbox.parseTags(' AAA, bbb ,AAA, ccc  dd ');
  assert.deepStrictEqual(toPlain(out), ['AAA', 'bbb', 'ccc dd']);
});
test('parseTags - empty / blank input returns an empty array', () => {
  assert.deepStrictEqual(toPlain(sandbox.parseTags('')), []);
  assert.deepStrictEqual(toPlain(sandbox.parseTags(undefined)), []);
  assert.deepStrictEqual(toPlain(sandbox.parseTags('   ,  ,  ')), []);
});
test('allTags - counts and dedupes case-insensitively across trades, sorted by count desc then alpha', () => {
  sandbox.DB.trades = [
    { setupTags: ['Breakout', 'Range'] },
    { setupTags: ['breakout'] },
    { setupTags: [] },
  ];
  const out = sandbox.allTags('setupTags');
  assert.deepStrictEqual(toPlain(out), [{ tag: 'Breakout', count: 2 }, { tag: 'Range', count: 1 }]);
});
test('allTags - empty trade set returns an empty array', () => {
  sandbox.DB.trades = [];
  assert.deepStrictEqual(toPlain(sandbox.allTags('setupTags')), []);
});

/* ====================== entitlement ====================== */
test('entitlement - returns true for every feature while PLAN is "owner" (single-user phase)', () => {
  assert.strictEqual(sandbox.PLAN, 'owner');
  for (const feature of Object.keys(sandbox.ENTITLEMENTS)) {
    assert.strictEqual(sandbox.entitlement(feature), true, `expected entitlement(${feature}) to be true under PLAN=owner`);
  }
  assert.strictEqual(sandbox.entitlement('some_future_feature_not_in_the_map'), true, 'owner bypasses the map entirely');
});

/* ====================== lib/kjr-format.js (plain require, has module.exports) ====================== */
const KjrFmt = require(FMT_PATH);

test('KjrFmt.pad - two-digit zero pad', () => {
  assert.strictEqual(KjrFmt.pad(3), '03');
  assert.strictEqual(KjrFmt.pad(0), '00');
  assert.strictEqual(KjrFmt.pad(15), '15');
});
test('KjrFmt.todayISO - shape is YYYY-MM-DD', () => {
  assert.match(KjrFmt.todayISO(), /^\d{4}-\d{2}-\d{2}$/);
});
test('KjrFmt.isoFromYMD - 0-based month matches Date.getMonth convention', () => {
  assert.strictEqual(KjrFmt.isoFromYMD(2026, 0, 5), '2026-01-05');
  assert.strictEqual(KjrFmt.isoFromYMD(2026, 11, 31), '2026-12-31');
});
test('KjrFmt.fmtDate - happy path ISO -> DD/MM/YYYY', () => {
  assert.strictEqual(KjrFmt.fmtDate('2026-07-15'), '15/07/2026');
});
test('KjrFmt.fmtDate - malformed input (not 3 dash-separated parts) is returned unchanged, not thrown', () => {
  assert.strictEqual(KjrFmt.fmtDate('not-iso'), 'not-iso');
  assert.strictEqual(KjrFmt.fmtDate('2026-07'), '2026-07');
});
test('KjrFmt.fmtDate - falsy input returns the no-value glyph', () => {
  assert.strictEqual(KjrFmt.fmtDate(''), '\u2014');
  assert.strictEqual(KjrFmt.fmtDate(null), '\u2014');
});
test('KjrFmt.fmtLongDate - valid ISO date produces a long-form date containing the weekday, day and month', () => {
  const out = KjrFmt.fmtLongDate('2026-07-15'); // a Wednesday
  assert.ok(out.includes('Wednesday'), `expected weekday in "${out}"`);
  assert.ok(out.includes('15'), `expected day-of-month in "${out}"`);
  assert.ok(out.includes('July'), `expected month name in "${out}"`);
});
test('KjrFmt.fmtLongDate - invalid date falls back to fmtDate (unchanged raw input for a non-ISO string)', () => {
  assert.strictEqual(KjrFmt.fmtLongDate('bogus'), 'bogus');
});
test('KjrFmt.esc - null/undefined become empty string', () => {
  assert.strictEqual(KjrFmt.esc(null), '');
  assert.strictEqual(KjrFmt.esc(undefined), '');
});
test('KjrFmt.esc - escapes HTML metacharacters', () => {
  assert.strictEqual(KjrFmt.esc('<script>&"\''), '&lt;script&gt;&amp;&quot;&#39;');
});
test('KjrFmt.uid - shape is base36-ish (digits and lowercase letters only), non-empty', () => {
  const id = KjrFmt.uid();
  assert.match(id, /^[0-9a-z]+$/);
  assert.ok(id.length > 0);
});
test('KjrFmt.uid - 10,000-run uniqueness sanity check', () => {
  const seen = new Set();
  for (let i = 0; i < 10000; i++) seen.add(KjrFmt.uid());
  assert.strictEqual(seen.size, 10000);
});

/* ====================== lib/kjr-calendar.js ====================== */
test('kjr-calendar.js require() shape: returns { KjrCalendar: { mount, esc, VERSION } }', () => {
  const mod = require(CAL_PATH);
  assert.deepStrictEqual(Object.keys(mod), ['KjrCalendar']);
  assert.strictEqual(typeof mod.KjrCalendar.mount, 'function');
  assert.strictEqual(typeof mod.KjrCalendar.esc, 'function');
  assert.strictEqual(typeof mod.KjrCalendar.VERSION, 'string');
  // Confirms the internal Cal constructor / _computeCells is NOT on this surface,
  // which is why the extraction technique below is needed to test the grid maths.
  assert.strictEqual(mod.KjrCalendar.Cal, undefined);
});

function computeCells(y, m0, weekStart) {
  const fakeThis = { month: new Date(y, m0, 1), weekStart };
  return calSandbox.Cal.prototype._computeCells.call(fakeThis);
}
test('_computeCells - Feb 2024 (leap year, 29 days, starts Thursday), weekStart=1 (Monday)', () => {
  const cells = computeCells(2024, 1, 1);
  assert.strictEqual(cells.length, 35); // lead(3) + dim(29) + trail(3), padded to a multiple of 7
  assert.strictEqual(cells.length % 7, 0);
  const leadCount = cells.filter(c => c.out && c.d < new Date(2024, 1, 1)).length;
  assert.strictEqual(leadCount, 3);
  assert.strictEqual(cells[3].iso, '2024-02-01'); // first in-month cell
  assert.strictEqual(cells[3].out, false);
  assert.strictEqual(cells[3 + 29 - 1].iso, '2024-02-29'); // last in-month cell (leap day present)
});
test('_computeCells - Feb 2026 (28 days, starts Sunday), weekStart=0 (Sunday) needs zero padding', () => {
  const cells = computeCells(2026, 1, 0);
  assert.strictEqual(cells.length, 28); // starts exactly on the week-start day, 28 = 4 exact weeks
  assert.strictEqual(cells.length % 7, 0);
  assert.strictEqual(cells.every(c => !c.out), true); // no lead/trail padding needed at all
  assert.strictEqual(cells[0].iso, '2026-02-01');
  assert.strictEqual(cells[27].iso, '2026-02-28');
});
test('_computeCells - Feb 2026 (starts Sunday) with weekStart=1 (Monday) needs 6 lead cells', () => {
  const cells = computeCells(2026, 1, 1);
  assert.strictEqual(cells.length, 35); // lead(6) + dim(28) + trail(1)
  assert.strictEqual(cells.length % 7, 0);
  const lead = cells.slice(0, 6);
  assert.ok(lead.every(c => c.out === true));
  assert.strictEqual(cells[6].iso, '2026-02-01');
  assert.strictEqual(cells[6].out, false);
});
test('_computeCells - March 2027 (31 days, starts Monday): weekStart=1 needs zero lead, weekStart=0 needs 1', () => {
  const ws1 = computeCells(2027, 2, 1);
  assert.strictEqual(ws1.length, 35); // lead(0) + dim(31) + trail(4)
  assert.strictEqual(ws1[0].iso, '2027-03-01');
  assert.strictEqual(ws1[0].out, false);

  const ws0 = computeCells(2027, 2, 0);
  assert.strictEqual(ws0.length, 35); // lead(1) + dim(31) + trail(3)
  assert.strictEqual(ws0[0].out, true); // Sunday 28 Feb padding cell, since the month starts on Monday
  assert.strictEqual(ws0[1].iso, '2027-03-01');
  assert.strictEqual(ws0[1].out, false);
});
test('_computeCells - lead + trail padding always totals a multiple of 7, across weekStart 0 and 1', () => {
  const months = [[2024, 1], [2026, 1], [2026, 6], [2027, 2], [2027, 5], [2027, 8]];
  for (const [y, m0] of months) {
    for (const weekStart of [0, 1]) {
      const cells = computeCells(y, m0, weekStart);
      assert.strictEqual(cells.length % 7, 0, `${y}-${m0 + 1} weekStart=${weekStart}: ${cells.length} not a multiple of 7`);
    }
  }
});

/* ====================== static safety contracts ====================== */
test('stored trade IDs never enter inline JavaScript handlers', () => {
  assert.doesNotMatch(indexSrc, /onclick="openTradeModal\([^"\n]*\.id/);
  assert.doesNotMatch(indexSrc, /onclick="confirmDeleteTrade\([^"\n]*\.id/);
  assert.doesNotMatch(indexSrc, /onclick="deleteTrade\([^"\n]*\+id/);
  assert.match(indexSrc, /<tr data-trade-id=/);
  assert.match(indexSrc, /addEventListener\('click',\(\)=>openTradeModal\(id\)\)/);
});
test('trade validation updates both visual and programme state', () => {
  assert.match(indexSrc, /f\.setAttribute\('aria-invalid',m\?'true':'false'\)/);
  assert.match(indexSrc, /function finitePositive\(value\)/);
  assert.match(indexSrc, /function validTradeSide\(side\)/);
  assert.match(indexSrc, /function stableImportId\(seed,index\)/);
  assert.match(indexSrc, /_updatedAt:\(prev&&prev\._updatedAt\)\|\|null/);
  assert.match(indexSrc, /aria-label="Close trade form"/);
  assert.match(indexSrc, /aria-label="Toggle colour theme"/);
  assert.match(indexSrc, /aria-label="Open settings"/);
});
test('hosted sync conflicts are durable, reviewable, and stop blind retries', () => {
  assert.match(indexSrc, /function readSyncConflicts\(\)/);
  assert.match(indexSrc, /function resolveSyncConflict\(index,choice\)/);
  assert.match(indexSrc, /if\(_hasOpenConflict\(t,id,'upsert'\)\) continue/);
  assert.match(indexSrc, /need conflict resolution in Settings/);
});
// Step 6b: the pill switcher (.tb-tabs) is replaced by a workspace menu. The sidebar copy (desktop) and the header copy (phone) must
// list the same three real anchors in the fixed order, with this app marked current, and the phone rules must keep the theme switch.
test('375px mobile rules shrink the topbar without removing app links or theme, and the sidebar keeps showView gating', () => {
  assert.match(indexSrc, /@media\(max-width:640px\)\{[\s\S]*?\.topbar\{gap:6px;/);
  assert.match(indexSrc, /@media \(max-width:768px\)\{[\s\S]*?\.sidebar\{display:none\}[\s\S]*?\.ws-m\{display:block\}/);
  assert.match(indexSrc, /@media \(max-width:768px\)\{[\s\S]*?#theme-btn-m\{display:flex\}/);
  assert.doesNotMatch(indexSrc, /class="tb-tab/);
  for (const id of ['ws-menu', 'ws-menu-m']) {
    const block = new RegExp('id="' + id + '" role="menu"[^>]*>([\\s\\S]*?)</div>').exec(indexSrc);
    assert.ok(block, id + ' menu exists');
    const links = [...block[1].matchAll(/<a class="menu-item" role="menuitem" tabindex="-1" href="([^"]+)"([^>]*)>\s*(Trading|Forex|Portfolio)/g)];
    assert.deepStrictEqual(links.map((l) => l[3]), ['Trading', 'Forex', 'Portfolio'], id + ' order');
    assert.deepStrictEqual(links.map((l) => l[1]), ['../Trading/', './', '../Portfolio/'], id + ' hrefs');
    assert.deepStrictEqual(links.map((l) => /aria-current="page"/.test(l[2])), [false, true, false], id + ' current app');
  }
  for (const id of ['ws-btn', 'ws-btn-m']) assert.match(indexSrc, new RegExp('id="' + id + '"[^>]*aria-haspopup="menu" aria-expanded="false"'));
  assert.match(indexSrc, /id="theme-btn"/);
  assert.match(indexSrc, /id="theme-btn-m"/);
  // The sidebar views still go through showView(), so authoriseFeature() gating is kept.
  assert.match(indexSrc, /<nav class="side-nav" id="side-nav" aria-label="Forex">/);
  for (const v of ['journal', 'reports', 'simulator', 'coach']) assert.match(indexSrc, new RegExp('class="side-item[^"]*" data-v="' + v + '"[^>]*onclick="showView\\(\'' + v + '\'\\)"'));
  assert.match(indexSrc, /onclick="openTagManager\(\)"><svg/);
  // the lock reads the same keys showView() hands to authoriseFeature
  assert.match(indexSrc, /VIEW_FEATURES=\{ reports:'advanced_analytics', simulator:'simulator', coach:'ai_coach' \}/);
  for (const [v, f] of [['simulator', 'simulator'], ['reports', 'advanced_analytics'], ['coach', 'ai_coach']]) {
    assert.match(indexSrc, new RegExp("v==='" + v + "' && !await authoriseFeature\\('" + f + "'"));
  }
  assert.strictEqual((indexSrc.match(/<span class="side-lock" hidden>/g) || []).length, 3, 'one lock per gated view');
});
test('schema defines authenticated read-only tables, trusted CAS and durable tombstones', () => {
  assert.match(schemaSrc, /^begin;\s*$/m);
  assert.match(schemaSrc, /^commit;\s*$/m);
  assert.match(schemaSrc, /deleted_at\s+timestamptz/);
  assert.match(schemaSrc, /create or replace function public\.sync_trade/);
  assert.match(schemaSrc, /create or replace function public\.trade_data_is_valid/);
  assert.match(schemaSrc, /if not public\.trade_data_is_valid\(v_data\)/);
  assert.match(schemaSrc, /security definer/);
  assert.match(schemaSrc, /set search_path = ''/);
  assert.match(schemaSrc, /alter function public\.sync_trade[^\n]+owner to postgres/);
  assert.match(schemaSrc, /for update;/);
  assert.match(schemaSrc, /auth\.uid\(\)/);
  assert.match(schemaSrc, /revoke all on function public\.sync_trade[^\n]+from anon/);
  assert.match(schemaSrc, /grant execute on function public\.sync_trade[^\n]+to authenticated/);
  assert.strictEqual((schemaSrc.match(/drop policy if exists/g) || []).length, 4);
  assert.match(schemaSrc, /create unique index if not exists profiles_stripe_customer_id_uidx/);
  assert.match(schemaSrc, /stripe_customer_id is not null/);
  assert.match(schemaSrc, /create policy "own profile read"/);
  assert.doesNotMatch(schemaSrc, /create policy "own profile write"/);
  assert.match(schemaSrc, /revoke all on table profiles from anon, authenticated, public/);
  assert.match(schemaSrc, /grant select on table profiles to authenticated/);
  assert.match(schemaSrc, /revoke all on table profiles from service_role/);
  assert.match(schemaSrc, /grant execute on function public\.apply_stripe_event\([^\n]+to service_role/);
  assert.doesNotMatch(schemaSrc, /create policy "own trades write"/);
  assert.match(schemaSrc, /revoke all on table trades from anon, authenticated, public/);
  assert.match(schemaSrc, /grant select on table trades to authenticated/);
  assert.match(schemaSrc, /grant select, insert, update, delete on table trades to service_role/);
  const syncTradeStart = schemaSrc.indexOf('create or replace function public.sync_trade');
  const syncTradeEnd = schemaSrc.indexOf('alter function public.sync_trade', syncTradeStart);
  assert.ok(syncTradeStart >= 0 && syncTradeEnd > syncTradeStart, 'sync_trade function section is present');
  const syncTradeSrc = schemaSrc.slice(syncTradeStart, syncTradeEnd);
  assert.match(syncTradeSrc, /on conflict \(user_id, id\) do nothing/);
  assert.match(syncTradeSrc, /if not p_delete and not public\.trade_data_is_valid\(p_data\)/);
  assert.doesNotMatch(syncTradeSrc, /on conflict \(id\) do nothing/);
  assert.match(schemaSrc, /v_is_scoped_pk/);
  assert.doesNotMatch(schemaSrc, /drop constraint[^;]+cascade/i);
  assert.match(schemaSrc, /pg_catalog\.clock_timestamp\(\)/);
  assert.match(schemaSrc, /old\.updated_at \+ interval '1 microsecond'/);
  assert.match(schemaSrc, /create table if not exists stripe_webhook_events/);
  assert.match(schemaSrc, /stripe_subscription_id/);
  assert.match(schemaSrc, /profiles_stripe_subscription_id_uidx/);
  assert.match(schemaSrc, /last_billing_subscription_id/);
  assert.match(schemaSrc, /subscription_id text not null/);
  assert.match(schemaSrc, /last_billing_event_created/);
  assert.match(schemaSrc, /create or replace function public\.apply_stripe_event/);
  assert.match(schemaSrc, /p_subscription_id text/);
  assert.match(schemaSrc, /lock table public\.profiles in share row exclusive mode/);
  assert.match(schemaSrc, /alter function public\.apply_stripe_event\([^\n]+owner to postgres/);
  assert.match(schemaSrc, /grant execute on function public\.apply_stripe_event\([^\n]+to service_role/);
  assert.match(schemaSrc, /revoke all on function public\.apply_stripe_event\([^\n]+from authenticated/);
  assert.match(schemaSrc, /on conflict \(event_id\) do nothing/);
  assert.match(schemaSrc, /billing subscription fence uninitialised/);
  assert.match(schemaSrc, /billing subscription fence mismatch/);
  assert.match(workerSrc, /STRIPE_BILLING_ENABLED=true/);
  assert.match(workerSrc, /checkout entitlement is disabled/);
  assert.match(workerSrc, /p_subscription_id/);
  assert.match(workerSrc, /items\.has_more === true/);
  assert.match(workerSrc, /payload\.length !== 1/);
  assert.doesNotMatch(workerSrc, /method:\s*['"]PATCH['"]/);
  assert.doesNotMatch(schemaSrc, /grant (?:all|insert|update|delete|truncate)[^\n]*profiles[^\n]*authenticated/i);
});
test('Forex service worker deletes only its own versioned caches', () => {
  assert.match(swSrc, /const CACHE_PREFIX\s*=\s*['"]kjr-forex-['"]/);
  assert.match(swSrc, /keys\.filter\(k\s*=>\s*k\.startsWith\(CACHE_PREFIX\)\s*&&\s*k\s*!==\s*CACHE\)/);
  assert.doesNotMatch(swSrc, /keys\.filter\(k\s*=>\s*k\s*!==\s*CACHE\)/);
});
test('Stripe signature parser preserves timestamp text and rejects ambiguous or whitespace timestamps', () => {
  const timestamp = '001770000000';
  const validV1 = 'a'.repeat(64);
  const parsed = workerContext.parseStripeSignature(
    ` t=${timestamp},v1=malformed,v0=${validV1},v1=${validV1},foo=ignored`
  );
  assert.deepStrictEqual(toPlain(parsed), {
    timestamp,
    timestampSeconds: WORKER_NOW_SECONDS,
    v1Values: [validV1],
  });
  assert.strictEqual(workerContext.parseStripeSignature(`t=${timestamp} ,v1=${validV1}`), null);
  assert.strictEqual(workerContext.parseStripeSignature(`t=${timestamp},t=${timestamp},v1=${validV1}`), null);
  assert.strictEqual(workerContext.parseStripeSignature(`t=${WORKER_NOW_SECONDS}oops,v1=${validV1}`), null);
  assert.strictEqual(workerContext.parseStripeSignature(`t=${timestamp},v1=not-hex`), null);
});
test('dashboard emits exactly one Profit factor stat card', () => {
  const source = extractFunction(indexSrc, 'renderDashboard', INDEX_PATH);
  assert.strictEqual((source.match(/statCard\('Profit factor'/g) || []).length, 1);
});

async function testAsync(name, fn) {
  try { await fn(); console.log(`✅ PASS: ${name}`); passed++; }
  catch (e) { console.error(`❌ FAIL: ${name}`); console.error(e); failed++; }
}

async function runWorkerContractTests() {
  const secret = 'whsec_synthetic';
  const env = {
    STRIPE_WEBHOOK_SECRET: secret,
    SB_URL: 'https://forex-legacy-synthetic.supabase.co',
    SB_PUBLISHABLE_KEY: 'sb_publishable_synthetic',
    SB_SERVICE_ROLE_KEY: 'service-role-synthetic',
    STRIPE_BILLING_ENABLED: 'true',
    STRIPE_PRO_PRICE_ID: 'price_synthetic',
    STRIPE_PRO_PRODUCT_ID: 'prod_synthetic',
    STRIPE_SECRET_KEY: 'sk_test_synthetic',
    STRIPE_API_VERSION: '2026-09-30.endive',
    STRIPE_SUCCESS_URL: 'https://forex.synthetic.test/Forex/?billing=success',
    STRIPE_CANCEL_URL: 'https://forex.synthetic.test/Forex/?billing=cancel',
    STRIPE_PORTAL_RETURN_URL: 'https://forex.synthetic.test/Forex/settings',
    BILLING_ALLOWED_ORIGINS: 'https://forex.synthetic.test',
  };
  function priceItem(overrides = {}) {
    return {
      price: {
        id: 'price_synthetic',
        type: 'recurring',
        product: 'prod_synthetic',
        ...overrides,
      }
    };
  }
  function subscriptionEvent(id, overrides = {}) {
    return {
      id,
      created: WORKER_NOW_SECONDS,
      type: 'customer.subscription.updated',
      data: { object: {
        id: 'sub_synthetic',
        customer: 'cus_synthetic',
        status: 'active',
        livemode: false,
        items: { data: [priceItem()] },
        ...overrides,
      } }
    };
  }
  function checkoutEvent(id, overrides = {}) {
    return {
      id,
      created: WORKER_NOW_SECONDS,
      type: 'checkout.session.completed',
      data: { object: {
        id: 'cs_synthetic',
        mode: 'subscription',
        payment_status: 'paid',
        subscription: 'sub_synthetic',
        customer: 'cus_synthetic',
        livemode: false,
        line_items: { data: [priceItem()] },
        ...overrides,
      } }
    };
  }
  async function signedRequest(event, signatureTimestamp = String(WORKER_NOW_SECONDS)) {
    const body = JSON.stringify(event);
    const validV1 = await hmacHex(signatureTimestamp, body, secret);
    return makeWebhookRequest(body, `t=${signatureTimestamp},v1=${validV1}`);
  }

  await testAsync('Stripe Worker sends verified events to the atomic RPC and accepts the 300-second boundary', async () => {
    const event = subscriptionEvent('evt_rotated');
    const body = JSON.stringify(event);
    const validV1 = await hmacHex('001770000000', body, secret);
    const calls = [];
    const rpcCalls = [];
    let providerStatus = 'active';
    workerSandbox.fetch = async (url, options) => {
      calls.push({ url, options });
      if (url.includes('/v1/subscriptions/')) {
        return new TestResponse(JSON.stringify({
          id: 'sub_synthetic', customer: 'cus_synthetic', status: providerStatus,
          livemode: false, items: { data: [priceItem()] },
        }), { status: 200 });
      }
      rpcCalls.push({ url, options });
      return new TestResponse(JSON.stringify([{
        applied: true, duplicate: false, matched: 1, reason: 'applied'
      }]), { status: 200 });
    };
    const response = await workerContext.workerDefault.fetch(
      makeWebhookRequest(
        body,
        `t=001770000000,v1=not-hex,v1=${'0'.repeat(64)},v1=${validV1},v0=${validV1}`
      ),
      env
    );
    assert.strictEqual(response.status, 200);
    assert.deepStrictEqual(toPlain(await response.json()), {
      received: true, synced: true, status: 200, matched: 1, reason: 'applied'
    });
    assert.strictEqual(calls.length, 2);
    assert.strictEqual(rpcCalls.length, 1);
    assert.strictEqual(rpcCalls[0].options.method, 'POST');
    assert.strictEqual(rpcCalls[0].url, `${env.SB_URL}/rest/v1/rpc/apply_stripe_event`);
    assert.strictEqual(rpcCalls[0].options.headers.Prefer, 'return=representation');
    assert.deepStrictEqual(JSON.parse(rpcCalls[0].options.body), {
      p_event_id: 'evt_rotated',
      p_event_type: 'customer.subscription.updated',
      p_event_created: WORKER_NOW_SECONDS,
      p_customer_id: 'cus_synthetic',
      p_subscription_id: 'sub_synthetic',
      p_plan: 'pro',
    });

    const deletedEvent = subscriptionEvent('evt_deleted', { status: 'canceled' });
    deletedEvent.type = 'customer.subscription.deleted';
    providerStatus = 'canceled';
    const deletedResponse = await workerContext.workerDefault.fetch(
      await signedRequest(deletedEvent), env
    );
    assert.strictEqual(deletedResponse.status, 200);
    assert.strictEqual(JSON.parse(rpcCalls[1].options.body).p_plan, 'free');
    assert.strictEqual(JSON.parse(rpcCalls[1].options.body).p_subscription_id, 'sub_synthetic');

    const boundaryEvent = subscriptionEvent('evt_boundary');
    providerStatus = 'active';
    const boundaryRequest = await signedRequest(
      boundaryEvent, String(WORKER_NOW_SECONDS - 300)
    );
    const boundaryResponse = await workerContext.workerDefault.fetch(boundaryRequest, env);
    assert.strictEqual(boundaryResponse.status, 200);
    assert.strictEqual(rpcCalls.length, 3);
    assert.strictEqual(calls.length, 6);
  });

  await testAsync('Stripe Worker keeps billing disabled without explicit configuration', async () => {
    const disabledEnv = { ...env };
    delete disabledEnv.STRIPE_BILLING_ENABLED;
    delete disabledEnv.STRIPE_PRO_PRICE_ID;
    delete disabledEnv.STRIPE_PRO_PRODUCT_ID;
    workerSandbox.fetch = async () => { throw new Error('unexpected Supabase call'); };
    const response = await workerContext.workerDefault.fetch(
      await signedRequest(subscriptionEvent('evt_disabled')), disabledEnv
    );
    assert.strictEqual(response.status, 503);
    assert.match((await response.json()).reason, /billing writes are disabled/);

    const incompleteEnv = { ...env, STRIPE_PRO_PRODUCT_ID: '' };
    const incompleteResponse = await workerContext.workerDefault.fetch(
      await signedRequest(subscriptionEvent('evt_incomplete_config')), incompleteEnv
    );
    assert.strictEqual(incompleteResponse.status, 503);
    assert.match((await incompleteResponse.json()).reason, /explicit STRIPE_PRO_PRICE_ID/);
  });

  await testAsync('Stripe Worker rejects non-paid or wrong-plan checkout and subscription events', async () => {
    const cases = [
      ['checkout payment mode', checkoutEvent('evt_payment_mode', { mode: 'payment' })],
      ['checkout unpaid', checkoutEvent('evt_unpaid', { payment_status: 'unpaid' })],
      ['checkout no payment required', checkoutEvent('evt_no_payment', { payment_status: 'no_payment_required' })],
      ['checkout missing subscription', checkoutEvent('evt_no_subscription', { subscription: null })],
      ['checkout missing customer', checkoutEvent('evt_no_customer', { customer: null })],
      ['checkout wrong price', checkoutEvent('evt_wrong_price', {
        line_items: { data: [priceItem({ id: 'price_other' })] }
      })],
      ['checkout wrong product', checkoutEvent('evt_wrong_product', {
        line_items: { data: [priceItem({ product: 'prod_other' })] }
      })],
      ['checkout one-time price', checkoutEvent('evt_one_time', {
        line_items: { data: [priceItem({ type: 'one_time' })] }
      })],
      ['checkout mixed wrong item', checkoutEvent('evt_mixed_items', {
        line_items: { data: [priceItem(), priceItem({ id: 'price_other' })] }
      })],
      ['checkout missing line items', checkoutEvent('evt_no_line_items', { line_items: null })],
      ['subscription unsupported status', subscriptionEvent('evt_bad_status', { status: 'past_due_pending' })],
      ['subscription wrong product', subscriptionEvent('evt_sub_wrong_product', {
        items: { data: [priceItem({ product: 'prod_other' })] }
      })],
      ['subscription missing items', subscriptionEvent('evt_sub_no_items', { items: null })],
      ['subscription truncated items', subscriptionEvent('evt_sub_truncated', {
        items: { has_more: true, data: [priceItem()] }
      })],
      ['deleted subscription with active status', (() => {
        const event = subscriptionEvent('evt_deleted_active', { status: 'active' });
        event.type = 'customer.subscription.deleted';
        return event;
      })()],
    ];
    workerSandbox.fetch = async () => { throw new Error('unexpected Supabase call'); };
    for (const [label, event] of cases) {
      const response = await workerContext.workerDefault.fetch(await signedRequest(event), env);
      assert.strictEqual(response.status, 400, label);
      const payload = await response.json();
      assert.strictEqual(payload.received, true, label);
      assert.strictEqual(payload.synced, false, label);
    }
    workerSandbox.fetch = async (url, options) => {
      if (url.includes('/v1/checkout/sessions/')) {
        return new TestResponse(JSON.stringify({
          id: 'cs_synthetic', customer: 'cus_synthetic', subscription: 'sub_synthetic',
          mode: 'subscription', status: 'complete', payment_status: 'paid', livemode: false,
          line_items: { data: [priceItem()] },
        }), { status: 200 });
      }
      if (url.includes('/v1/subscriptions/')) {
        return new TestResponse(JSON.stringify({
          id: 'sub_synthetic', customer: 'cus_synthetic', status: 'active', livemode: false,
          items: { data: [priceItem()] },
        }), { status: 200 });
      }
      return new TestResponse(JSON.stringify([{
        applied: true, duplicate: false, matched: 1, reason: 'applied',
      }]), { status: 200 });
    };
    const validCheckoutResponse = await workerContext.workerDefault.fetch(
      await signedRequest(checkoutEvent('evt_valid_checkout')), env
    );
    assert.strictEqual(validCheckoutResponse.status, 200, 'valid checkout is proved by the provider fixtures');
    assert.deepStrictEqual(await validCheckoutResponse.json(), {
      received: true, synced: true, status: 200, matched: 1, reason: 'applied',
    });
    const missingId = subscriptionEvent('evt_missing_id');
    delete missingId.id;
    const missingCreated = subscriptionEvent('evt_missing_created');
    delete missingCreated.created;
    for (const [label, event] of [['missing event ID', missingId], ['missing event timestamp', missingCreated]]) {
      const response = await workerContext.workerDefault.fetch(await signedRequest(event), env);
      assert.strictEqual(response.status, 400, label);
    }
  });

  await testAsync('Stripe Worker rejects missing or non-exact RPC attribution proofs', async () => {
    const cases = [
      { label: 'duplicate event', result: { applied: false, duplicate: true, matched: 1, reason: 'duplicate' }, status: 200, duplicate: true },
      { label: 'stale event', result: { applied: false, duplicate: false, matched: 1, reason: 'stale event' }, status: 200, ignored: 'stale' },
      { label: 'ambiguous equal-time event', result: { applied: false, duplicate: false, matched: 1, reason: 'ambiguous event ordering' }, status: 503 },
      { label: 'zero profiles', result: { applied: false, duplicate: false, matched: 0, reason: 'customer attribution failed' }, status: 503 },
      { label: 'multiple profiles', result: { applied: false, duplicate: false, matched: 2, reason: 'customer attribution failed' }, status: 503 },
      { label: 'missing count', result: { applied: true, duplicate: false, reason: 'applied' }, status: 503 },
      { label: 'string count', result: { applied: true, duplicate: false, matched: '1', reason: 'applied' }, status: 503 },
      { label: 'invalid result', result: { applied: true }, status: 503 },
      { label: 'applied and duplicate together', result: { applied: true, duplicate: true, matched: 1, reason: 'applied' }, status: 503 },
      { label: 'empty RPC array', payload: [], status: 503 },
      { label: 'multiple RPC rows', payload: [
        { applied: true, duplicate: false, matched: 1, reason: 'applied' },
        { applied: true, duplicate: false, matched: 1, reason: 'applied' },
      ], status: 503 },
      { label: 'object RPC row', payload: { applied: true, duplicate: false, matched: 1, reason: 'applied' }, status: 503 },
    ];
    for (const [index, item] of cases.entries()) {
      let rpcRequest;
      workerSandbox.fetch = async (url, options) => {
        if (url.includes('/v1/subscriptions/')) {
          return new TestResponse(JSON.stringify({
            id: 'sub_synthetic', customer: 'cus_synthetic', status: 'active', livemode: false,
            items: { data: [priceItem()] },
          }), { status: 200 });
        }
        rpcRequest = { url, options };
        const payload = Object.prototype.hasOwnProperty.call(item, 'payload')
          ? item.payload : [item.result];
        return new TestResponse(JSON.stringify(payload), { status: 200 });
      };
      const event = subscriptionEvent(`evt_rpc_${index}`);
      const response = await workerContext.workerDefault.fetch(await signedRequest(event), env);
      assert.strictEqual(response.status, item.status, item.label);
      const payload = await response.json();
      assert.strictEqual(payload.received, true, item.label);
      assert.strictEqual(payload.synced, item.status === 200, item.label);
      if (item.duplicate) assert.strictEqual(payload.duplicate, true, item.label);
      if (item.ignored) assert.strictEqual(payload.ignored, item.ignored, item.label);
      assert.strictEqual(rpcRequest.url, `${env.SB_URL}/rest/v1/rpc/apply_stripe_event`, item.label);
    }
  });

  await testAsync('Stripe Worker rejects missing, malformed, stale, future and changed-body signatures', async () => {
    const event = subscriptionEvent('evt_signature');
    const body = JSON.stringify(event);
    const timestamp = '001770000000';
    const validV1 = await hmacHex(timestamp, body, secret);
    const staleTimestamp = String(WORKER_NOW_SECONDS - 301);
    const futureTimestamp = String(WORKER_NOW_SECONDS + 301);
    const staleV1 = await hmacHex(staleTimestamp, body, secret);
    const futureV1 = await hmacHex(futureTimestamp, body, secret);
    const cases = [
      ['missing signature', null, body],
      ['malformed timestamp', `t=not-a-number,v1=${validV1}`, body],
      ['partial numeric timestamp', `t=${WORKER_NOW_SECONDS}oops,v1=${validV1}`, body],
      ['malformed v1', `t=${timestamp},v1=not-hex`, body],
      ['duplicate timestamp', `t=${timestamp},t=${timestamp},v1=${validV1}`, body],
      ['stale timestamp', `t=${staleTimestamp},v1=${staleV1}`, body],
      ['future timestamp', `t=${futureTimestamp},v1=${futureV1}`, body],
      ['changed raw body', `t=${timestamp},v1=${validV1}`, body.replace('active', 'trialing')],
    ];
    workerSandbox.fetch = async () => { throw new Error('unexpected Supabase call'); };
    for (const [label, signature, requestBody] of cases) {
      const response = await workerContext.workerDefault.fetch(
        makeWebhookRequest(requestBody, signature), env
      );
      assert.strictEqual(response.status, 400, label);
      assert.strictEqual((await response.json()).error, 'invalid signature', label);
    }
  });
}

async function runSyncContractTests() {
  await testAsync('Forex service worker activate preserves sibling caches', async () => {
    const deleted = [];
    let activation;
    const currentCache = /const CACHE = '([^']+)';/.exec(swSrc)[1];
    const swSandbox = {
      Promise,
      self: {
        listeners: {},
        addEventListener(type, listener) { this.listeners[type] = listener; },
        skipWaiting() {},
        clients: { claim: () => Promise.resolve() },
      },
      caches: {
        keys: async () => ['kjr-forex-v0.14', currentCache, 'kjr-portfolio-v0.9', 'other-cache'],   // the current cache is read from sw.js, so a release needs no edit here
        delete: async (key) => { deleted.push(key); return true; },
      },
    };
    vm.runInNewContext(swSrc, swSandbox, { filename: SW_PATH });
    swSandbox.self.listeners.activate({ waitUntil(promise) { activation = promise; } });
    await activation;
    assert.deepStrictEqual(deleted, ['kjr-forex-v0.14']);
  });

  await testAsync('sbSyncRow - stale server version is rejected and returned for recovery', async () => {
    syncSandbox.fetch = async () => ({ ok: true, json: async () => [{
      applied: false, row_id: 'trade_1', row_data: { symbol: 'EURUSD' },
      server_updated_at: '2026-08-29T01:00:00Z', server_deleted_at: null,
    }] });
    await assert.rejects(
      () => syncSandbox.sbSyncRow('trades', { id: 'trade_1', symbol: 'GBPUSD', _updatedAt: '2026-08-29T00:00:00Z' }, false),
      (err) => err.code === 'STALE_WRITE' && err.serverRow.symbol === 'EURUSD'
    );
  });

  await testAsync('sbSyncRow - delete uses the same CAS RPC and sends a tombstone intent', async () => {
    let request;
    syncSandbox.fetch = async (url, options) => {
      request = { url, options };
      return { ok: true, json: async () => [{
        applied: true, row_id: 'trade_2', row_data: { symbol: 'USDJPY' },
        server_updated_at: '2026-08-29T02:00:00Z', server_deleted_at: '2026-08-29T02:00:00Z',
      }] };
    };
    const out = await syncSandbox.sbSyncRow('trades', { id: 'trade_2', symbol: 'USDJPY', _updatedAt: '2026-08-29T01:00:00Z' }, true);
    const body = JSON.parse(request.options.body);
    assert.ok(request.url.endsWith('/rest/v1/rpc/sync_trade'));
    assert.strictEqual(body.p_expected_updated_at, '2026-08-29T01:00:00Z');
    assert.strictEqual(body.p_delete, true);
    assert.strictEqual(body.p_data, null);
    assert.strictEqual(out._deletedAt, '2026-08-29T02:00:00Z');
  });

  await testAsync('sbDelete - stale immediate delete is queued and audited once with both row versions', async () => {
    syncSandbox.persistedStore = {};
    syncSandbox.fetch = async () => ({ ok: true, json: async () => [{
      applied: false, row_id: 'trade_delete_1', row_data: { symbol: 'SERVER' },
      server_updated_at: '2026-08-29T03:00:00Z', server_deleted_at: null,
    }] });
    const local = { id: 'trade_delete_1', symbol: 'LOCAL', _updatedAt: '2026-08-29T02:00:00Z' };
    assert.strictEqual(await syncSandbox.sbDelete('trades', local.id, local._updatedAt, local), false);
    assert.strictEqual(await syncSandbox.sbDelete('trades', local.id, local._updatedAt, local), false);
    const queued = JSON.parse(syncSandbox.persistedStore.test_forex_pendingdel);
    const conflicts = JSON.parse(syncSandbox.persistedStore.test_sync_conflicts);
    assert.strictEqual(queued.length, 1);
    assert.strictEqual(conflicts.length, 1);
    assert.strictEqual(conflicts[0].operation, 'delete');
    assert.strictEqual(conflicts[0].local.symbol, 'LOCAL');
    assert.strictEqual(conflicts[0].server.symbol, 'SERVER');
  });

  await testAsync('flushPendingDeletes - stale queued delete remains durable and does not duplicate its audit', async () => {
    syncSandbox.persistedStore = {
      test_forex_pendingdel: JSON.stringify([{
        table: 'trades', id: 'trade_delete_2', expectedUpdatedAt: '2026-08-29T02:00:00Z',
        data: { id: 'trade_delete_2', symbol: 'QUEUED LOCAL', _updatedAt: '2026-08-29T02:00:00Z' },
      }]),
    };
    syncSandbox.fetch = async () => ({ ok: true, json: async () => [{
      applied: false, row_id: 'trade_delete_2', row_data: { symbol: 'QUEUED SERVER' },
      server_updated_at: '2026-08-29T04:00:00Z', server_deleted_at: null,
    }] });
    await syncSandbox.flushPendingDeletes();
    await syncSandbox.flushPendingDeletes();
    const queued = JSON.parse(syncSandbox.persistedStore.test_forex_pendingdel);
    const conflicts = JSON.parse(syncSandbox.persistedStore.test_sync_conflicts);
    assert.strictEqual(queued.length, 1);
    assert.strictEqual(conflicts.length, 1);
    assert.strictEqual(conflicts[0].operation, 'delete');
    assert.strictEqual(conflicts[0].local.symbol, 'QUEUED LOCAL');
    assert.strictEqual(conflicts[0].server.symbol, 'QUEUED SERVER');
  });

  await testAsync('sbFetchAll - keyset pagination reads beyond 1,000 rows completely', async () => {
    const first = Array.from({ length: 1000 }, (_, i) => ({
      id: 'id' + String(i).padStart(4, '0'), data: { n: i }, updated_at: '2026-08-29T00:00:00Z', deleted_at: null,
    }));
    const second = [{ id: 'id1000', data: { n: 1000 }, updated_at: '2026-08-29T00:00:01Z', deleted_at: null }];
    const urls = [];
    syncSandbox.fetch = async (url) => { urls.push(url); return { ok: true, json: async () => (urls.length === 1 ? first : second) }; };
    const out = await syncSandbox.sbFetchAll('trades');
    assert.strictEqual(out.length, 1001);
    assert.strictEqual(urls.length, 2);
    assert.match(urls[1], /updated_at\.gt\./);
    assert.match(urls[1], /id\.gt\.id0999/);
  });

  await testAsync('sbFetchAll - malicious cloud IDs fail closed and are quarantined', async () => {
    syncSandbox.quarantined.length = 0;
    syncSandbox.fetch = async () => ({ ok: true, json: async () => [{
      id: "x');alert(1)//", data: {}, updated_at: '2026-08-29T00:00:00Z', deleted_at: null,
    }] });
    await assert.rejects(() => syncSandbox.sbFetchAll('trades'), /invalid stored trade ID/i);
    assert.strictEqual(syncSandbox.quarantined.length, 1);
  });

  await testAsync('dirty revision - edit during an in-flight upload stays dirty', async () => {
    syncSandbox.persistedStore = {};
    syncSandbox.DB.trades = [{ id: 'trade_3', symbol: 'newer edit', _updatedAt: 'old-server-time' }];
    syncSandbox._dirty.trades = new Set(['trade_3']);
    syncSandbox._rowRev.trades = new Map([['trade_3', 2]]);
    const cleared = syncSandbox._acceptServerRevision('trades', 'trade_3', 1, { _updatedAt: 'new-server-time' });
    assert.strictEqual(cleared, false);
    assert.strictEqual(syncSandbox._dirty.trades.has('trade_3'), true);
    assert.strictEqual(syncSandbox.DB.trades[0].symbol, 'newer edit');
    assert.strictEqual(syncSandbox.DB.trades[0]._updatedAt, 'new-server-time');
    const persisted = JSON.parse(syncSandbox.persistedStore.test_forex);
    assert.strictEqual(persisted.trades[0].symbol, 'newer edit');
    assert.strictEqual(persisted.trades[0]._updatedAt, 'new-server-time');
  });

  await testAsync('accepted server revision - persists before the dirty flag clears', async () => {
    syncSandbox.persistedStore = {};
    syncSandbox.DB.trades = [{ id: 'trade_4', symbol: 'stable edit', _updatedAt: 'old-server-time' }];
    syncSandbox._dirty.trades = new Set(['trade_4']);
    syncSandbox._rowRev.trades = new Map([['trade_4', 1]]);
    const cleared = syncSandbox._acceptServerRevision('trades', 'trade_4', 1, { _updatedAt: 'accepted-server-time' });
    assert.strictEqual(cleared, true);
    assert.strictEqual(syncSandbox._dirty.trades.has('trade_4'), false);
    assert.strictEqual(JSON.parse(syncSandbox.persistedStore.test_forex).trades[0]._updatedAt, 'accepted-server-time');
  });

  await testAsync('flush coordinator - overlapping calls coalesce and never run concurrently', async () => {
    syncSandbox._flushPromise = null; syncSandbox._flushQueued = false; syncSandbox.flushCalls = 0;
    let release;
    syncSandbox.flushGate = new Promise(resolve => { release = resolve; });
    const first = syncSandbox._flushDirty();
    const second = syncSandbox._flushDirty();
    assert.strictEqual(first, second);
    assert.strictEqual(syncSandbox.flushCalls, 1);
    release();
    await Promise.all([first, second]);
    assert.strictEqual(syncSandbox.flushCalls, 2);
    assert.strictEqual(syncSandbox._flushPromise, null);
    syncSandbox.flushGate = null;
  });
}

/* ====================== Shell contracts ======================
   Dialog focus (F2), chart proxy (F1), Tag manager (F3), account dialog title (O1), view switch (O2) and the service worker (O5).
   The real functions are extracted from index.html and sw.js and run in vm contexts against small fakes, nothing touches a
   browser, storage or the network. */

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body), json: async () => body };
}
const DAY = 86400;

/* A tiny DOM that models the one browser behaviour F2 is about: when the element holding focus is destroyed by an
   innerHTML replacement, focus falls to <body>. Only the dialog's own chart region is built. */
function makeChartEnv({ proxy = '', fetchImpl = null, libLoad = null } = {}) {
  const storage = new Map(proxy ? [['kjr_test_chartProxy', proxy]] : []);
  const doc = { activeElement: null };
  class El {
    constructor(name, parent) { this.name = name; this.parent = parent || null; this.children = []; this.attrs = {}; this._html = ''; this.isConnected = true; if (parent) parent.children.push(this); }
    contains(node) { for (let n = node; n; n = n.parent) if (n === this) return true; return false; }
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    focus() { if (this.isConnected) doc.activeElement = this; }
    get innerHTML() { return this._html; }
    set innerHTML(value) {
      const gone = this.children.splice(0);
      gone.forEach((child) => { child.isConnected = false; });
      if (doc.activeElement && gone.some((child) => child.contains(doc.activeElement))) doc.activeElement = doc.body;
      this._html = String(value);
    }
  }
  doc.body = new El('BODY');
  doc.activeElement = doc.body;
  const modalRoot = new El('modal-root', doc.body);
  const modal = new El('modal', modalRoot);
  const wrap = new El('trade-chart-wrap', modal);
  const button = new El('trade-chart-load-btn', wrap);
  const byId = { 'modal-root': modalRoot, 'trade-chart-wrap': wrap };
  doc.getElementById = (id) => byId[id] || null;
  const now = Math.floor(Date.now() / 1000);
  const calls = { fetch: [], loadLib: 0, render: 0, wire: 0 };
  const context = vm.createContext({
    URL, Promise, JSON, Date, Math, Error, Number, String, Object, Array,
    CHART_PROXY_KEY: 'kjr_test_chartProxy',
    localStorage: { getItem: (k) => (storage.has(k) ? storage.get(k) : null), setItem: (k, v) => storage.set(k, String(v)), removeItem: (k) => storage.delete(k) },
    document: doc,
    escapeHtml: KjrFmt.esc,
    DB: { trades: [{ id: 't1', symbol: 'DEMO-EURUSD', entryAt: new Date((now - 30 * DAY) * 1000).toISOString(), exitAt: new Date((now - 20 * DAY) * 1000).toISOString(), entryPrice: 1.1, exitPrice: 1.11 }] },
    isValidStoredId: () => true,
    scopeSnapshot: () => ({ n: 1 }),
    scopeIsCurrent: () => true,
    authoriseFeature: async () => true,
    deriveTrade: () => ({ status: 'closed' }),
    loadLightweightCharts: async () => { calls.loadLib++; if (libLoad) await libLoad({ wrap }); },
    renderTradeChart: () => { calls.render++; },
    wireChartLoadButton: () => { calls.wire++; },
    fetch: async (url) => { calls.fetch.push(url); return fetchImpl ? fetchImpl(url) : jsonResponse({ chart: { result: null, error: { description: 'No data found' } } }, 404); },
    _tradeChart: null,
  });
  let code = extractConst(indexSrc, 'WORKER_RANGES', INDEX_PATH) + '\n';
  for (const name of ['holdModalFocus', 'getChartProxy', 'chartProxyKind', 'resolveProxyUrl', 'workerRangeFor', 'workerChartUrl',
    'chartProxyProblem', 'chartHttpError', 'fetchCandles', 'chartErrorHtml', 'tradeChartSectionHtml', 'loadTradeChart']) {
    code += extractFunction(indexSrc, name, INDEX_PATH) + '\n';
  }
  vm.runInContext(code, context, { filename: 'extracted-forex-chart.js' });
  return { context, doc, modalRoot, wrap, button, calls, storage, now };
}
function yahooBody(stamps) {
  const flat = (v) => stamps.map(() => v);
  return { chart: { result: [{ timestamp: stamps, indicators: { quote: [{ open: flat(1.1), high: flat(1.2), low: flat(1.0), close: flat(1.15) }] } }], error: null } };
}

/* A tiny DOM for the shared modal helper (wireModal, closeModal, restoreModalFocus) and the real dialog builders that sit on it. It models the two browser behaviours
   S1 is about: an innerHTML replacement destroys the focused control so focus falls to <body>, and a control that is not rendered (the sidebar on a phone) cannot take
   focus. The helper block is sliced out of index.html whole, so the test runs whatever helper is shipped, not a hand copy. */
function modalHelperSource() {
  const start = indexSrc.indexOf('let _modalKeyTrap=null;'), end = indexSrc.indexOf('function openConflictManager(');
  assert.ok(start > 0 && end > start, 'the shared modal helper block is in index.html');
  return indexSrc.slice(start, end).replace(/^let /, 'var ');
}
const focusName = (env) => (env.doc.activeElement ? env.doc.activeElement.name : null);   // compare by name, a failure then prints a word instead of the element graph
function makeDialogEnv({ conflicts = 2 } = {}) {
  const doc = { activeElement: null, selectors: {} };
  const detach = (el) => { el.isConnected = false; el.children.forEach(detach); };
  class El {
    constructor(name, parent, opts = {}) {
      this.name = name; this.parent = parent || null; this.children = []; this.attrs = {}; this.listeners = {};
      this.rendered = opts.rendered !== false; this.control = !!opts.control; this.isConnected = true;
      if (parent) parent.children.push(this);
    }
    get offsetParent() { return this.rendered ? (this.parent || {}) : null; }
    contains(node) { for (let n = node; n; n = n.parent) if (n === this) return true; return false; }
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    focus(options) { if (this.isConnected && this.rendered) { doc.activeElement = this; this.focusOptions = options; } }
    addEventListener(type, fn) { this.listeners[type] = fn; }
    removeEventListener(type, fn) { if (this.listeners[type] === fn) delete this.listeners[type]; }
    querySelectorAll() { const out = []; const walk = (el) => el.children.forEach((c) => { if (c.control) out.push(c); walk(c); }); walk(this); return out; }
    querySelector(sel) { return /\.modal\b/.test(sel) ? (this.children.find((c) => c.name === 'modal') || null) : null; }
  }
  const control = (name, parent, opts) => new El(name, parent, { ...opts, control: true });
  const body = new El('BODY'); doc.body = body; doc.activeElement = body;
  const root = new El('modal-root', body); root._html = '';
  Object.defineProperty(root, 'innerHTML', {
    get() { return this._html; },
    set(value) {
      const gone = this.children.splice(0); gone.forEach(detach);
      if (doc.activeElement && gone.some((child) => child.contains(doc.activeElement))) doc.activeElement = body;
      this._html = String(value);
      if (this._html) { const modal = new El('modal', this); control('close', modal); control('action', modal); }   // a dialog: its first control is the close button
    },
  });
  const controls = {
    tagsBtn: control('tags-btn', body), settingsBtn: control('settings-btn', body), row: control('trade-row', body),
    nav: control('nav-journal', body), phoneNav: control('phone-nav-journal', body), heading: new El('h1', body),
  };
  doc.selectors['#side-nav [data-v].active'] = controls.nav; doc.selectors['#subnav .seg button.active'] = controls.phoneNav; doc.selectors.h1 = controls.heading;
  doc.querySelector = (sel) => doc.selectors[sel] || null;
  doc.getElementById = (id) => (id === 'modal-root' ? root : (/^ren-\d+$/.test(id) ? { value: 'Renamed' } : null));
  const context = vm.createContext({
    JSON, document: doc, escapeHtml: KjrFmt.esc,
    TAG_CATS: vm.runInNewContext(extractConst(indexSrc, 'TAG_CATS', INDEX_PATH).replace(/^var TAG_CATS\s*=\s*/, '(').replace(/;$/, ')')),
    allTags: (cat) => (cat === 'setupTags' ? [{ tag: 'Breakout', count: 3 }, { tag: 'Pullback', count: 2 }] : []),
    TAG_UNDO_KEY: 'undo', localStorage: { getItem: () => null },
    renameTag() {}, deleteTag() {}, renderApp() {}, toast() {},
    isValidStoredId: () => true, DB: { trades: [{ id: 'syn-1', symbol: 'EURUSD' }] }, deleteTrade() {},
    readSyncConflicts: () => Array.from({ length: conflicts }, (_, i) => ({ id: 'syn-' + i, operation: 'upsert', local: { symbol: 'LOCAL' }, server: { symbol: 'CLOUD' }, message: 'A newer cloud version exists.' })),
  });
  vm.runInContext('var _tagList=[];\n' + modalHelperSource() + '\n'
    + ['openTagManager', 'renameTagUI', 'deleteTagUI', 'confirmDeleteTrade', 'openConflictManager'].map((n) => extractFunction(indexSrc, n, INDEX_PATH)).join('\n'),
  context, { filename: 'extracted-forex-dialogs.js' });
  return {
    doc, root, context, controls, control,
    // What every dialog builder does: replace the markup in place, then wire it.
    show(label) { root.innerHTML = '<div class="modal">' + label + '</div>'; context.wireModal(label); },
    dialog() { return root.children.find((c) => c.name === 'modal') || null; },
    escape() { const handler = root.listeners.keydown; assert.ok(handler, 'a dialog is wired'); handler({ key: 'Escape', preventDefault() {} }); },
  };
}

async function runShellContractTests() {
  /* ---- F2: focus never falls to <body> while a dialog is open ---- */
  await testAsync('F2 - loading the chart parks focus on the chart region, so Escape and the Tab trap still reach #modal-root', async () => {
    const env = makeChartEnv({ proxy: 'https://forex-qa.workers.dev', fetchImpl: () => jsonResponse({ chart: { result: null, error: null } }, 401) });
    env.button.focus();
    assert.strictEqual(env.doc.activeElement, env.button, 'the user clicked the button');
    await env.context.loadTradeChart('t1');
    assert.ok(env.modalRoot.contains(env.doc.activeElement), 'focus must stay inside the dialog, the key handler is bound to #modal-root');
    assert.strictEqual(env.doc.activeElement, env.wrap);
    assert.strictEqual(env.wrap.getAttribute('tabindex'), '-1');
    // Retry replaces the button the same way, and is covered by the same call.
    const retry = new env.button.constructor('retry', env.wrap);
    retry.focus();
    await env.context.loadTradeChart('t1');
    assert.strictEqual(env.doc.activeElement, env.wrap, 'Retry must not drop focus either');
    assert.ok(env.calls.wire >= 2, 'the Retry button is re-wired after each failure');
  });
  await testAsync('F2 - control: without holdModalFocus the same click drops focus to <body> (the bug this test guards)', async () => {
    const env = makeChartEnv({ proxy: 'https://forex-qa.workers.dev', fetchImpl: () => jsonResponse({}, 401) });
    env.context.holdModalFocus = () => {};
    env.button.focus();
    await env.context.loadTradeChart('t1');
    assert.strictEqual(env.doc.activeElement, env.doc.body);
    assert.ok(!env.modalRoot.contains(env.doc.activeElement));
  });
  await testAsync('F2 - holdModalFocus also covers a browser that never focuses a clicked button, and leaves a control that stays alone', async () => {
    const env = makeChartEnv({ proxy: 'https://forex-qa.workers.dev' });
    env.doc.activeElement = env.doc.body;     // Safari and Firefox on macOS do not focus a clicked button
    env.context.holdModalFocus(env.wrap);
    assert.strictEqual(env.doc.activeElement, env.wrap);
    const notes = new env.button.constructor('notes', env.modalRoot.children[0]);   // a field elsewhere in the dialog that stays
    notes.focus();
    env.context.holdModalFocus(env.wrap);
    assert.strictEqual(env.doc.activeElement, notes, 'focus on a control that is not being replaced is left alone');
    env.context.holdModalFocus(null);          // no region, no dialog: a no-op, never a throw
    env.context.holdModalFocus({ contains: () => false });
  });
  await testAsync('F2 - a dialog closed while the chart loads is left alone (Escape now works during loading)', async () => {
    const env = makeChartEnv({ proxy: 'https://forex-qa.workers.dev', libLoad: ({ wrap }) => { wrap.isConnected = false; } });
    env.button.focus();
    await env.context.loadTradeChart('t1');
    assert.strictEqual(env.calls.render, 0, 'nothing is drawn into a detached region');
    assert.strictEqual(env.calls.fetch.length, 0, 'no data request once the dialog is gone');
    assert.match(env.wrap.innerHTML, /Loading chart/);
  });
  test('F2 - the chart region is a focusable, named group inside the dialog', () => {
    const html = makeChartEnv().context.tradeChartSectionHtml({ symbol: 'X' });
    assert.match(html, /<div id="trade-chart-wrap" role="group" aria-label="Price chart" aria-live="polite" tabindex="-1">/);
    assert.match(html, /<button class="btn" id="trade-chart-load-btn">Load price chart<\/button>/);
    assert.match(indexSrc, /holdModalFocus\(wrap\);/);
    assert.match(indexSrc, /_modalKeyTrap=function\(e\)\{\s*if\(e\.key==='Escape'\)\{ e\.preventDefault\(\); closeModal\(\); return; \}/, 'the key handler stays on the dialog root');
  });

  /* ---- S1: closing a dialog returns focus to the control that opened it, also after the dialog re-rendered in place ---- */
  test('S1 - control: replacing a dialog in place drops focus to <body>, the mechanism the bug rests on', () => {
    const env = makeDialogEnv();
    env.controls.tagsBtn.focus();
    env.show('Manage tags');
    env.control('save', env.dialog()).focus();
    env.show('Manage tags');
    assert.ok(env.dialog().children.every((c) => c.name !== 'save'), 'the old controls are gone');
    // wireModal then moves focus into the new dialog, but at the moment it runs, document.activeElement was <body>.
    assert.strictEqual(env.doc.activeElement.name, 'close');
  });
  test('S1 - the opener is captured once: a re-render keeps it, Escape returns to it, the next dialog starts a new session', () => {
    const env = makeDialogEnv(), { tagsBtn, row } = env.controls;
    tagsBtn.focus();
    env.show('Manage tags');                                  // first open, activeElement is still the opener
    assert.ok(env.root.contains(env.doc.activeElement), 'focus moves into the dialog');
    env.control('save', env.dialog()).focus();
    env.show('Manage tags');                                  // re-render in place, the focused control is destroyed
    env.show('Manage tags');                                  // and again, the opener must survive any number of re-renders
    env.escape();
    assert.strictEqual(focusName(env), tagsBtn.name, 'Escape lands on the opener, not <body>');
    assert.strictEqual(env.root.listeners.keydown, undefined, 'the key handler is removed on close');
    row.focus();
    env.show('Edit trade');
    env.context.closeModal();
    assert.strictEqual(focusName(env), row.name, 'a later dialog does not inherit the old opener');
  });
  test('S1 - Tag manager: a rename or delete re-renders it in place and Escape and Close still return to the control that opened it', () => {
    const env = makeDialogEnv(), { tagsBtn } = env.controls;
    tagsBtn.focus();
    env.context.openTagManager();
    assert.strictEqual(env.dialog().getAttribute('aria-label'), 'Manage tags');
    for (const action of ['renameTagUI', 'deleteTagUI', 'renameTagUI']) {
      env.control('clicked-' + action, env.dialog()).focus();   // the Save or delete button that was clicked
      env.context[action](0);                                   // renderApp(), then openTagManager() again in place
      assert.strictEqual(env.dialog().getAttribute('aria-label'), 'Manage tags');
    }
    env.escape();
    assert.strictEqual(focusName(env), tagsBtn.name, 'Escape');
    tagsBtn.focus();
    env.context.openTagManager();
    env.control('clicked', env.dialog()).focus();
    env.context.renameTagUI(0);
    env.context.closeModal();                                   // the footer Close and the header cross call this
    assert.strictEqual(focusName(env), tagsBtn.name, 'Close');
  });
  test('S1 - delete confirm: opened over the trade form it returns to the trade row, whether cancelled or dismissed', () => {
    const env = makeDialogEnv(), { row } = env.controls;
    for (const leave of [() => env.escape(), () => env.context.closeModal()]) {
      row.focus();
      env.show('Edit trade');
      env.control('trade-delete-btn', env.dialog()).focus();
      env.context.confirmDeleteTrade('syn-1');                  // replaces the trade form in place, the focused Delete button is destroyed
      assert.strictEqual(env.dialog().getAttribute('aria-label'), 'Delete trade');
      leave();
      assert.strictEqual(focusName(env), row.name);
    }
  });
  test('S1 - delete confirm: once the trade is deleted its row is gone, focus falls back to the nav item instead of <body>', () => {
    const env = makeDialogEnv(), { nav } = env.controls;
    const row = env.control('row-to-delete', env.doc.body);
    row.focus();
    env.show('Edit trade');
    env.control('trade-delete-btn', env.dialog()).focus();
    env.context.confirmDeleteTrade('syn-1');
    row.isConnected = false;                                    // deleteTrade() re-renders the table
    env.context.closeModal();
    assert.strictEqual(focusName(env), nav.name);
  });
  test('S1 - conflict manager: opened from Settings, and re-rendered after a choice, it returns to the control that opened Settings', () => {
    const env = makeDialogEnv(), { settingsBtn } = env.controls;
    settingsBtn.focus();
    env.show('Settings');
    env.control('review-conflicts', env.dialog()).focus();
    env.context.openConflictManager();                          // Settings -> conflict manager, in place
    assert.strictEqual(env.dialog().getAttribute('aria-label'), 'Sync conflicts');
    env.control('keep-cloud', env.dialog()).focus();
    env.context.openConflictManager();                          // resolveSyncConflict() ends with this call, after the choice
    env.context.closeModal();                                   // the footer Close
    assert.strictEqual(focusName(env), settingsBtn.name, 'Close');
    settingsBtn.focus();
    env.show('Settings');
    env.control('review-conflicts', env.dialog()).focus();
    env.context.openConflictManager();
    env.escape();
    assert.strictEqual(focusName(env), settingsBtn.name, 'Escape');
  });
  test('S1 - when the opener is gone or cannot take focus, focus falls back to the nav item, then the phone view switch, then the page heading, never <body>', () => {
    const closeFrom = (env, hide) => {
      const opener = env.control('opener', env.doc.body);
      opener.focus();
      env.show('Edit trade');
      hide(opener);
      env.context.closeModal();
      return focusName(env);
    };
    const gone = (o) => { o.isConnected = false; }, notRendered = (o) => { o.rendered = false; };
    let env = makeDialogEnv();
    assert.strictEqual(closeFrom(env, gone), env.controls.nav.name, 'the current view nav item');
    assert.strictEqual(env.controls.nav.focusOptions && env.controls.nav.focusOptions.preventScroll, true, 'a fallback never scrolls the page');
    env = makeDialogEnv();
    assert.strictEqual(closeFrom(env, notRendered), env.controls.nav.name, 'a connected opener that is not shown (sidebar after a resize) is skipped the same way');
    env = makeDialogEnv(); env.controls.nav.rendered = false;
    assert.strictEqual(closeFrom(env, gone), env.controls.phoneNav.name, 'on a phone the sidebar is hidden, so the view switch takes it');
    env = makeDialogEnv(); env.controls.nav.rendered = false; env.controls.phoneNav.rendered = false;
    assert.strictEqual(closeFrom(env, gone), env.controls.heading.name, 'with no nav shown (signed out on a phone) the page heading takes it');
    assert.strictEqual(env.controls.heading.getAttribute('tabindex'), '-1', 'the heading is made focusable without joining the Tab order');
    assert.strictEqual(env.controls.heading.focusOptions.preventScroll, true);
    env = makeDialogEnv(); env.doc.selectors = {};
    assert.strictEqual(closeFrom(env, gone), env.doc.body.name, 'nothing to return to is a quiet no-op, never a throw');
  });
  test('S1 - an opener that was never focused (a clicked button in Safari or Firefox on macOS) falls back to the nav item too', () => {
    const env = makeDialogEnv();
    assert.strictEqual(focusName(env), env.doc.body.name);
    env.show('Manage tags');
    env.context.closeModal();
    assert.strictEqual(focusName(env), env.controls.nav.name);
  });
  test('S1 - closing with no dialog open never moves focus (resetRuntimeState calls closeModal on every account switch)', () => {
    const env = makeDialogEnv();
    env.controls.row.focus();
    env.context.closeModal();
    assert.strictEqual(focusName(env), env.controls.row.name);
    env.doc.activeElement = env.doc.body;
    env.context.closeModal();
    assert.strictEqual(focusName(env), env.doc.body.name);
  });
  test('S1 - source: wireModal carries the open dialog opener over instead of reading activeElement after the render', () => {
    assert.match(indexSrc, /const previousFocus=_modalKeyTrap\?_modalKeyTrap\.__previousFocus:document\.activeElement;/);
    assert.match(indexSrc, /_modalKeyTrap\.__previousFocus=previousFocus;/);
    assert.match(indexSrc, /function restoreModalFocus\(opener\)\{/);
    assert.match(indexSrc, /if\(wasOpen\) restoreModalFocus\(previous\);/);
  });

  /* ---- F1: chart data proxy ---- */
  test('F1 - proxy kinds: none, template and the workers.dev Worker', () => {
    const kind = makeChartEnv().context.chartProxyKind;
    for (const empty of ['', '   ', null, undefined]) assert.strictEqual(kind(empty), 'none');
    assert.strictEqual(kind('https://my-worker.acct.workers.dev'), 'worker');
    assert.strictEqual(kind('  https://my-worker.acct.workers.dev/  '), 'worker');
    assert.strictEqual(kind('https://my-worker.workers.dev?key=1'), 'worker');
    assert.strictEqual(kind('https://corsproxy.io/?url={url}'), 'template');
    assert.strictEqual(kind('https://my-worker.acct.workers.dev/?url={url}'), 'template', 'an explicit {url} wins, even on workers.dev');
    assert.strictEqual(kind('https://p.example/raw?u='), 'template');
    assert.strictEqual(kind('http://my-worker.workers.dev'), 'template', 'plain http is never taken for the Worker');
    assert.strictEqual(kind('https://workers.dev'), 'template');
    assert.strictEqual(kind('https://evilworkers.dev'), 'template');
    assert.strictEqual(kind('https://workers.dev.evil.example'), 'template');
    assert.strictEqual(kind('not a url'), 'template');
  });
  test('F1 - the Worker range is the smallest one that reaches back far enough', () => {
    const range = makeChartEnv().context.workerRangeFor, now = 1800000000;
    assert.strictEqual(range(now - 45 * DAY, now), '3mo');
    assert.strictEqual(range(now - 88 * DAY, now), '3mo');
    assert.strictEqual(range(now - 89 * DAY, now), '6mo');
    assert.strictEqual(range(now - 175 * DAY, now), '6mo');
    assert.strictEqual(range(now - 200 * DAY, now), '1y');
    assert.strictEqual(range(now - 400 * DAY, now), '2y');
    assert.strictEqual(range(now - 800 * DAY, now), '5y');
    assert.strictEqual(range(now - 3000 * DAY, now), 'max');
    assert.strictEqual(range(now + 5 * DAY, now), '3mo', 'a future entry date still gets a valid range');
  });
  test('F1 - the Worker URL is built the way Trading builds it', () => {
    const url = makeChartEnv().context.workerChartUrl;
    assert.strictEqual(url('https://w.workers.dev', 'EURUSD', '6mo'), 'https://w.workers.dev?symbol=EURUSD&interval=1d&range=6mo&includePrePost=false');
    assert.strictEqual(url('https://w.workers.dev/', 'BRK.B', '1y'), 'https://w.workers.dev/?symbol=BRK.B&interval=1d&range=1y&includePrePost=false');
    assert.strictEqual(url('https://w.workers.dev/?k=1', 'A B', '3mo'), 'https://w.workers.dev/?k=1&symbol=A%20B&interval=1d&range=3mo&includePrePost=false');
  });
  await testAsync('F1 - a workers.dev proxy is called the Worker way and its bars are cut to the trade window', async () => {
    const now = Math.floor(Date.now() / 1000), from = now - 100 * DAY, to = now - 10 * DAY;
    const stamps = [from - 5 * DAY, from + DAY, from + 20 * DAY, to - DAY, to + DAY, to + 30 * DAY];
    const env = makeChartEnv({ proxy: 'https://forex-qa.workers.dev', fetchImpl: () => jsonResponse(yahooBody(stamps)) });
    const bars = await env.context.fetchCandles('DEMO-EURUSD', from, to);
    assert.deepStrictEqual(env.calls.fetch, ['https://forex-qa.workers.dev?symbol=DEMO-EURUSD&interval=1d&range=6mo&includePrePost=false']);
    assert.strictEqual(bars.length, 3, 'only the bars inside [from, to] are kept');
    assert.match(bars[0].time, /^\d{4}-\d{2}-\d{2}$/);
    assert.deepStrictEqual(Object.keys(bars[0]).sort(), ['close', 'high', 'low', 'open', 'time']);
  });
  await testAsync('F1 - any other proxy keeps the existing template path, with no cutting', async () => {
    const now = Math.floor(Date.now() / 1000), from = now - 100 * DAY, to = now - 10 * DAY;
    const stamps = [from - 5 * DAY, from + DAY, to + 30 * DAY];
    const yahoo = 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent('DEMO-EURUSD') + '?period1=' + from + '&period2=' + to + '&interval=1d&includePrePost=false';
    let env = makeChartEnv({ proxy: 'https://p.example/get?url={url}&k=1', fetchImpl: () => jsonResponse(yahooBody(stamps)) });
    const bars = await env.context.fetchCandles('DEMO-EURUSD', from, to);
    assert.deepStrictEqual(env.calls.fetch, ['https://p.example/get?url=' + encodeURIComponent(yahoo) + '&k=1']);
    assert.strictEqual(bars.length, 3, 'the proxy already honours period1 and period2, so nothing is cut here');
    env = makeChartEnv({ proxy: 'https://p.example/raw?u=', fetchImpl: () => jsonResponse(yahooBody(stamps)) });
    await env.context.fetchCandles('DEMO-EURUSD', from, to);
    assert.deepStrictEqual(env.calls.fetch, ['https://p.example/raw?u=' + encodeURIComponent(yahoo)], 'with no {url} the encoded Yahoo URL is appended');
  });
  await testAsync('F1 - no proxy set means no request and a message that points at Settings', async () => {
    const env = makeChartEnv({ proxy: '' });
    env.button.focus();
    await env.context.loadTradeChart('t1');
    assert.strictEqual(env.calls.fetch.length, 0, 'nothing is sent to a third party');
    assert.strictEqual(env.calls.loadLib, 0, 'the chart library is not fetched for nothing either');
    assert.match(env.wrap.innerHTML, /Chart data proxy not set/);
    assert.match(env.wrap.innerHTML, /Set the Chart data CORS proxy in Settings/);
    assert.match(env.wrap.innerHTML, /Worker URL, the same one Trading uses/);
    assert.doesNotMatch(env.wrap.innerHTML, /trade-chart-load-btn/, 'there is nothing to retry until a proxy is set');
    assert.doesNotMatch(env.wrap.innerHTML, /HTTP 401/);
    assert.strictEqual(env.doc.activeElement, env.wrap, 'focus is parked in the dialog here as well');
    await assert.rejects(() => env.context.fetchCandles('X', 1, 2), (err) => err.kind === 'setup', 'fetchCandles refuses on its own too');
  });
  await testAsync('F1 - a proxy that answers 401 or 403 gets the Settings message, not the raw HTTP text alone', async () => {
    for (const status of [401, 403]) {
      const env = makeChartEnv({ proxy: 'https://corsproxy.io/?url={url}', fetchImpl: () => jsonResponse({ error: 'A valid API key is required.' }, status) });
      await assert.rejects(() => env.context.fetchCandles('DEMO-EURUSD', 1, 2), (err) => err.kind === 'auth' && err.message === 'The proxy refused the request (HTTP ' + status + ').');
      env.button.focus();
      await env.context.loadTradeChart('t1');
      assert.match(env.wrap.innerHTML, /The chart data proxy refused the request/);
      assert.match(env.wrap.innerHTML, /HTTP 40[13]/);
      assert.match(env.wrap.innerHTML, /Set the Chart data CORS proxy in Settings \(⚙\) to your Worker URL/);
      assert.match(env.wrap.innerHTML, /trade-chart-load-btn">Retry</);
      assert.doesNotMatch(env.wrap.innerHTML, /The proxy returned HTTP/);
    }
  });
  await testAsync('F1 - other failures keep their kinds: symbol, Worker symbol rule, rate limit, server error, no answer', async () => {
    const run = (proxy, response) => makeChartEnv({ proxy, fetchImpl: response }).context.fetchCandles('EURUSD=X', 1, 2);
    const yahoo404 = () => jsonResponse({ chart: { result: null, error: { description: 'No data found, symbol may be delisted' } } }, 404);
    await assert.rejects(() => run('https://p.example/?u={url}', yahoo404), (err) => err.kind === 'symbol' && /No data found/.test(err.message));
    const workerBad = () => jsonResponse({ chart: { result: null, error: { description: 'bad params' } } }, 400);
    await assert.rejects(() => run('https://w.workers.dev', workerBad), (err) => err.kind === 'symbol' && /bad params/.test(err.message) && /letters, dots and dashes/.test(err.message));
    await assert.rejects(() => run('https://p.example/?u={url}', workerBad), (err) => err.kind === 'symbol' && err.message === 'bad params', 'the Worker wording is for the Worker only');
    await assert.rejects(() => run('https://w.workers.dev', () => jsonResponse({ chart: { result: null, error: { description: 'rate limited' } } }, 429)), (err) => err.kind === 'proxy' && /rate limiting/.test(err.message));
    await assert.rejects(() => run('https://w.workers.dev', () => jsonResponse('oops', 500)), (err) => err.kind === 'proxy' && err.message === 'The proxy returned HTTP 500.');
    await assert.rejects(() => run('https://w.workers.dev', () => { throw new TypeError('Failed to fetch'); }), (err) => err.kind === 'proxy' && err.message === 'The proxy did not respond.');
    await assert.rejects(() => run('https://w.workers.dev', () => jsonResponse({ chart: { result: [], error: null } })), (err) => err.kind === 'symbol' && /No price data/.test(err.message));
  });
  test('F1 - the chart error panel escapes its text and offers Retry only when a retry can help', () => {
    const html = makeChartEnv().context.chartErrorHtml;
    const evil = html({ symbol: '"><img src=x onerror=alert(1)>' }, { kind: 'symbol', message: '<b>boom</b>' });
    assert.doesNotMatch(evil, /<img|<b>/);
    assert.match(evil, /Symbol not found/);
    assert.match(html({ symbol: 'X' }, { kind: 'proxy', message: 'The proxy did not respond.' }), /Could not reach the data proxy[\s\S]*Retry/);
    assert.match(html({ symbol: 'X' }, null), /Could not reach the data proxy/);
    assert.doesNotMatch(html({ symbol: 'X' }, { kind: 'setup' }), /Retry/);
  });
  test('F1 - proxy settings are validated before anything is saved', () => {
    const problem = makeChartEnv().context.chartProxyProblem;
    for (const fine of ['', '   ', 'https://my-worker.acct.workers.dev', 'https://p.example/get?url={url}&k=1', 'https://p.example/raw?u=']) assert.strictEqual(problem(fine), '', fine);
    for (const bad of ['http://my-worker.workers.dev', 'ftp://p.example', 'my-worker.workers.dev', 'javascript:alert(1)', 'https://user:pw@p.example/', 'https://' + 'a'.repeat(501)]) assert.notStrictEqual(problem(bad), '', bad);
  });
  test('F1 - the Settings help text matches what now works', () => {
    assert.match(indexSrc, /placeholder="https:\/\/your-worker\.workers\.dev"/);
    assert.match(indexSrc, /Paste your Cloudflare Worker URL, the same one Trading uses \(it ends in \.workers\.dev\)\. Charts load through it\. Any other proxy needs \{url\} in its address/);
    assert.match(indexSrc, /Leave it empty and charts stay off\./);
    assert.doesNotMatch(indexSrc, /can be flaky|can go here later/);
    assert.doesNotMatch(indexSrc, /CHART_PROXY_DEFAULT|corsproxy\.io\/\?url=\{url\}'/, 'no hidden default proxy is left');
  });
  await testAsync('F1 - saving Settings with a bad proxy keeps the dialog open and writes nothing, a good one saves both fields', async () => {
    const store = new Map(), calls = { closed: 0, toasts: [] }, nodes = {};
    const input = (value) => ({ value, classes: new Set(), attrs: {}, focused: false, classList: { toggle(name, on) { if (on) nodes.cp.classes.add(name); else nodes.cp.classes.delete(name); } }, setAttribute(k, v) { this.attrs[k] = v; }, focus() { this.focused = true; } });
    nodes.cp = input(''); nodes.key = input('synthetic-test-key'); nodes.err = { textContent: '' };
    const context = vm.createContext({
      URL, Number, String, Object,
      document: { getElementById: (id) => ({ 'f-chartproxy': nodes.cp, 'f-akey': nodes.key, 'e-chartproxy': nodes.err }[id] || null) },
      localStorage: { setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k), getItem: (k) => (store.has(k) ? store.get(k) : null) },
      CHART_PROXY_KEY: 'cp', ANTHROPIC_KEY: 'ak', isLocalOwner: () => true, _view: 'journal',
      closeModal: () => { calls.closed++; }, toast: (m) => calls.toasts.push(m), renderCoachIdle: () => {},
    });
    vm.runInContext(extractFunction(indexSrc, 'chartProxyProblem', INDEX_PATH) + '\n' + extractFunction(indexSrc, 'saveSettings', INDEX_PATH), context);
    nodes.cp.value = 'http://insecure.workers.dev';
    context.saveSettings();
    assert.strictEqual(calls.closed, 0);
    assert.strictEqual(store.size, 0, 'neither the key nor the proxy is written on a failed save');
    assert.ok(nodes.err.textContent.length > 0);
    assert.strictEqual(nodes.cp.attrs['aria-invalid'], 'true');
    assert.ok(nodes.cp.classes.has('invalid'));
    assert.ok(nodes.cp.focused);
    nodes.cp.value = ' https://forex-qa.workers.dev ';
    context.saveSettings();
    assert.strictEqual(calls.closed, 1);
    assert.strictEqual(store.get('cp'), 'https://forex-qa.workers.dev');
    assert.strictEqual(store.get('ak'), 'synthetic-test-key');
    assert.strictEqual(nodes.err.textContent, '');
    assert.strictEqual(nodes.cp.attrs['aria-invalid'], 'false');
    nodes.cp.value = '';
    context.saveSettings();
    assert.ok(!store.has('cp'), 'an empty field turns charts off');
  });

  /* ---- F3: Tag manager with a very long tag ---- */
  test('F3 - the Tag manager keeps a long tag inside its row (chip truncates, full name in the title) and escapes it', () => {
    const LONG = 'LONGTAG' + 'abcdefghij'.repeat(10) + 'XY', EVIL = '"><img src=x onerror=alert(1)>';
    const modalRoot = { innerHTML: '' }, state = { wired: null };
    const context = vm.createContext({
      TAG_CATS: vm.runInNewContext(extractConst(indexSrc, 'TAG_CATS', INDEX_PATH).replace(/^var TAG_CATS\s*=\s*/, '(').replace(/;$/, ')')),
      allTags: (cat) => (cat === 'setupTags' ? [{ tag: LONG, count: 2 }, { tag: 'Calm', count: 1 }, { tag: EVIL, count: 1 }] : []),
      escapeHtml: KjrFmt.esc, JSON, TAG_UNDO_KEY: 'undo',
      localStorage: { getItem: () => JSON.stringify({ tag: LONG, rows: [{ id: 'a' }] }) },
      document: { getElementById: (id) => (id === 'modal-root' ? modalRoot : null) },
      wireModal: (label) => { state.wired = label; },
    });
    vm.runInContext('var _tagList=[];\n' + extractFunction(indexSrc, 'openTagManager', INDEX_PATH), context);
    context.openTagManager();
    const html = modalRoot.innerHTML;
    assert.strictEqual(state.wired, 'Manage tags');
    assert.ok(html.includes('<span class="tag setup" title="' + LONG + '">' + LONG + '</span>'), 'the chip carries the full name as its title');
    assert.ok(html.includes('<span class="tag setup" title="Calm">Calm</span>'));
    assert.ok(html.includes('<button class="btn btn-sm undo-btn" title="Undo delete &quot;' + LONG + '&quot;" onclick="undoDeleteTag()"><span>Undo delete "' + LONG + '"</span></button>'));
    assert.doesNotMatch(html, /<img/, 'a hostile tag name never becomes markup');
    assert.ok(html.includes('title="&quot;&gt;&lt;img src=x onerror=alert(1)&gt;"'));
    assert.strictEqual((html.match(/<div class="tag-row">/g) || []).length, 3);
  });
  test('F3 - CSS: the chip may shrink and truncate, the rename box keeps its minimum, the Undo label truncates', () => {
    assert.match(indexSrc, /\.tag-row \.tag\{flex:0 1 auto;min-width:0;max-width:45%;overflow:hidden;text-overflow:ellipsis\}/);
    assert.match(indexSrc, /\.modal-foot \.undo-btn\{min-width:0;max-width:100%\}/);
    assert.match(indexSrc, /\.modal-foot \.undo-btn span\{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap\}/);
    assert.match(indexSrc, /id="ren-'\+idx\+'"[^>]*style="flex:1;min-width:70px"/, 'the 70px minimum the chip cap is sized against');
    assert.match(indexSrc, /\.tag\{display:inline-block;[^}]*white-space:nowrap\}/, 'the base chip rule is unchanged, only the Tag manager row overrides it');
    assert.doesNotMatch(indexSrc, /function parseTags\([^)]*\)\{[^}]*\.(slice|substring|substr)\(/, 'no length limit was added to parseTags');
  });

  /* ---- S3: Undo refreshes the Tag manager whenever it is open, whatever the current view ---- */
  const runUndo = ({ view, dialog, snapshot }) => {
    const calls = { render: 0, reopen: 0, saved: 0, toasts: [] };
    const store = new Map(snapshot === null ? [] : [['undo', JSON.stringify(snapshot || { ts: 1, cat: 'setupTags', tag: 'Breakout', rows: [{ id: 'a', setupTags: ['Breakout'] }, { id: 'b', setupTags: ['Breakout'] }] })]]);
    const modal = dialog ? { getAttribute: (k) => (k === 'aria-label' ? dialog : null) } : null;
    // Answers any way the code asks for the dialog on screen: the root's .modal, or one selector naming the label.
    const find = (sel) => { const m = /aria-label="([^"]*)"/.exec(sel); return modal && (!m || m[1] === dialog) ? modal : null; };
    const context = vm.createContext({
      JSON, Array, Date, TAG_UNDO_KEY: 'undo', _view: view,
      DB: { trades: [{ id: 'a', setupTags: [] }] },
      localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), removeItem: (k) => store.delete(k) },
      markDirty: () => {}, saveData: () => { calls.saved++; }, renderApp: () => { calls.render++; },
      openTagManager: () => { calls.reopen++; }, toast: (m, err) => calls.toasts.push([m, !!err]),
      document: { querySelector: find, getElementById: (id) => (id === 'modal-root' ? { querySelector: find } : null) },
    });
    vm.runInContext(extractFunction(indexSrc, 'undoDeleteTag', INDEX_PATH), context);
    context.undoDeleteTag();
    return { calls, store, DB: context.DB };
  };
  test('S3 - Undo refreshes an open Tag manager in every view, not only the journal (the journal re-render stays)', () => {
    for (const view of ['journal', 'reports', 'simulator', 'coach']) {
      const r = runUndo({ view, dialog: 'Manage tags' });
      assert.strictEqual(r.calls.reopen, 1, view + ': the open Tag manager is rebuilt so the restored tag and the Undo button are current');
      assert.strictEqual(r.calls.render, 1, view + ': the page behind is re-rendered as before');
      assert.strictEqual(r.calls.saved, 1);
      assert.deepStrictEqual(r.calls.toasts, [['Restored "Breakout" on 2 trades', false]]);
      assert.strictEqual(r.store.has('undo'), false, 'the one-shot snapshot is consumed');
      assert.deepStrictEqual(r.DB.trades.map((t) => t.id).sort(), ['a', 'b']);
      assert.deepStrictEqual(r.DB.trades.find((t) => t.id === 'a').setupTags, ['Breakout']);
    }
  });
  test('S3 - Undo never opens the Tag manager over another dialog or on its own, and a missing snapshot changes nothing', () => {
    for (const dialog of [null, 'Settings', 'Edit trade']) {
      const r = runUndo({ view: 'journal', dialog });
      assert.strictEqual(r.calls.reopen, 0, String(dialog) + ': not the Tag manager, so it is left alone');
      assert.strictEqual(r.calls.render, 1);
    }
    const none = runUndo({ view: 'reports', dialog: 'Manage tags', snapshot: null });
    assert.deepStrictEqual([none.calls.render, none.calls.reopen, none.calls.saved], [0, 0, 0]);
    assert.deepStrictEqual(none.calls.toasts, [['Nothing to undo', true]]);
  });
  test('S3 - source: the refresh asks for the dialog by the label openTagManager gives it, not by the current view', () => {
    const undo = extractFunction(indexSrc, 'undoDeleteTag', INDEX_PATH), label = /wireModal\('([^']+)'\)/.exec(extractFunction(indexSrc, 'openTagManager', INDEX_PATH))[1];
    assert.doesNotMatch(undo, /_view\s*===/, 'no view test is left in undoDeleteTag');
    assert.ok(undo.includes('aria-label="' + label + '"'), 'the check and the dialog agree on the name ' + label);
  });

  /* ---- S2: a long message wraps inside the viewport instead of running off it ---- */
  test('S2 - CSS: a toast breaks long unbroken text, its text span stops at six lines, and it stays inside its 90vw container', () => {
    const rule = /\n\.toast\{([^}]*)\}/.exec(indexSrc)[1], span = /\n\.toast>span\{([^}]*)\}/.exec(indexSrc);
    assert.match(rule, /overflow-wrap:anywhere/, 'a long tag name has no space to wrap at');
    assert.match(rule, /word-break:break-word/, 'the fallback for engines without overflow-wrap:anywhere, as .account-email does');
    assert.match(rule, /padding:10px 16px/, 'the padded pill is unchanged');
    assert.doesNotMatch(rule, /line-clamp|overflow:hidden/, 'the cap is not on the padded pill, a clamp there shows the top of the next line in the padding');
    assert.ok(span, 'the inner text span has its own rule');
    assert.strictEqual(span[1], 'display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:6;overflow:hidden', 'a runaway message stops at six lines');
    assert.doesNotMatch(rule + span[1], /(^|;)\s*--[\w-]+\s*:/, 'existing tokens only: no custom property is defined');
    assert.match(indexSrc, /#toasts\{[^}]*width:max-content;max-width:90vw\}/, 'the container still caps a toast at 90vw');
    assert.match(indexSrc, /#toasts\{left:calc\(224px \+ \(100% - 224px\) \/ 2\);max-width:calc\(100vw - 224px - 32px\)\}/, 'and beside the sidebar at 769px and up');
    assert.ok(indexSrc.indexOf('.toast.err{') > indexSrc.indexOf('\n.toast{'), 'the error variant still follows the base rule');
  });
  test('S2 - toast() keeps the whole message, in a span inside the pill and as the pill title, and keeps its timing', () => {
    const LONG = 'Restored "LONGTAG' + 'abcdefghij'.repeat(60) + 'XY" on 2 trades', timers = [], appended = [];
    const context = vm.createContext({
      document: {
        createElement: (tag) => ({ tag, className: '', textContent: '', title: '', style: {}, children: [], appendChild(child) { this.children.push(child); }, remove() {} }),
        getElementById: (id) => (id === 'toasts' ? { appendChild: (el) => appended.push(el) } : null),
      },
      setTimeout: (fn, ms) => { timers.push(ms); },
    });
    vm.runInContext(extractFunction(indexSrc, 'toast', INDEX_PATH), context);
    context.toast(LONG);
    context.toast('Could not save', true);
    assert.strictEqual(appended[0].tag, 'div');
    assert.deepStrictEqual(appended[0].children.map((c) => c.tag), ['span'], 'the text is in one span, the element the six-line cap applies to');
    assert.strictEqual(appended[0].children[0].textContent, LONG, 'the text is never shortened in script, the screen reader gets all of it');
    assert.strictEqual(appended[0].title, LONG, 'the full text is also the title, for the part the line cap hides');
    assert.strictEqual(appended[0].className, 'toast');
    assert.strictEqual(appended[1].className, 'toast err');
    assert.strictEqual(appended[1].children[0].textContent, 'Could not save');
    assert.strictEqual(appended[1].title, 'Could not save');
    assert.deepStrictEqual(timers, [2500, 5000], 'a message stays 2.5 s, an error 5 s, as before');
  });

  /* ---- O1: the account dialog title matches what it shows ---- */
  test('O1 - "Create account" and "Sign in" only title a dialog that shows the form', () => {
    const run = ({ id = null, local = false, broken = false, mode }) => {
      const modalRoot = { innerHTML: '' }, state = {};
      const context = vm.createContext({
        currentUser: () => ({ id }), isLocalOwner: () => local, isHostedBroken: () => broken, setBillingError: () => {},
        accountModalHtml: () => '<div class="modal-body"></div>', wireModal: (label) => { state.label = label; },
        document: { getElementById: () => modalRoot },
      });
      vm.runInContext(extractFunction(indexSrc, 'openAccountSettings', INDEX_PATH), context);
      context.openAccountSettings(mode);
      return { title: (/<h3>([^<]*)<\/h3>/.exec(modalRoot.innerHTML) || [])[1], label: state.label, close: (/aria-label="(Close [^"]*)"/.exec(modalRoot.innerHTML) || [])[1] };
    };
    assert.deepStrictEqual(run({ local: true, mode: 'signup' }), { title: 'Account', label: 'Account', close: 'Close account' }, 'local mode shows a message, no form');
    assert.strictEqual(run({ local: true, mode: 'signin' }).title, 'Account');
    assert.strictEqual(run({ local: true }).title, 'Account');
    assert.strictEqual(run({ broken: true, mode: 'signup' }).title, 'Account', 'a broken hosted setup shows a message too');
    assert.strictEqual(run({ id: 'user-a', mode: 'signup' }).title, 'Account');
    assert.strictEqual(run({ mode: 'signup' }).title, 'Create account', 'the hosted signed-out form keeps its titles');
    assert.strictEqual(run({ mode: 'signin' }).title, 'Sign in');
    assert.strictEqual(run({}).title, 'Account');
  });

  /* ---- O2: the view switch fits a 320px phone ---- */
  test('O2 - CSS: at 360px and below the four view buttons tighten and spread, after the base and 640px rules', () => {
    const block = /@media\(max-width:360px\)\{\s*\.subnav \.seg\{width:100%\}\s*\.subnav \.seg button\{flex:1 1 auto;padding:6px 8px\}\s*\}/.exec(indexSrc);
    assert.ok(block, 'the 360px view switch block');
    assert.ok(block.index > indexSrc.indexOf('.subnav .seg button{padding:6px 14px'), 'later than the base padding rule, so it wins at equal specificity');
    assert.ok(block.index > indexSrc.indexOf('@media(max-width:640px)'), 'later than the 640px rules');
    assert.match(indexSrc, /\.subnav \.seg\{max-width:100%;overflow-x:auto\}/, 'the scroll fallback for narrower screens stays');
  });

  /* ---- O5: the service worker stores only exact shell URLs ---- */
  const shellEntries = [...(/SHELL\s*=\s*\[([\s\S]*?)\];/.exec(swSrc)[1]).matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]);
  const firstUseEntries = [...((/FIRST_USE\s*=\s*\[([\s\S]*?)\];/.exec(swSrc) || [])[1] || '').matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]);
  const BASE = 'https://forex.synthetic.test/Forex/';
  function makeSwEnv() {
    const store = new Map(), listeners = {}, puts = [], state = { online: true, status: 200 };
    const swUrl = BASE + 'sw.js';
    class FakeResponse {
      constructor(body, init = {}) { this.body = body; this.status = init.status === undefined ? 200 : init.status; this.ok = this.status >= 200 && this.status < 300; }
      clone() { return this; }
      static error() { const r = new FakeResponse('', { status: 0 }); r.networkError = true; return r; }
    }
    class FakeRequest {
      constructor(input, init = {}) { const base = typeof input === 'string' ? { url: new URL(input, swUrl).href, method: 'GET', mode: 'cors' } : input; this.url = base.url; this.method = base.method || 'GET'; this.mode = init.mode || base.mode || 'cors'; this.cache = init.cache || base.cache || 'default'; }
    }
    // The real Cache API ignores URL fragments, so the fake does too.
    const abs = (input) => (typeof input === 'string' ? new URL(input, swUrl).href : input.url).split('#')[0];
    const bare = (href) => href.split('#')[0].split('?')[0];
    const caches = {
      async open() {
        return {
          async put(req, res) { puts.push(req.url); store.set(req.url.split('#')[0], res); },
          async addAll(list) { list.forEach((p) => store.set(new URL(p, swUrl).href, new FakeResponse('precached:' + p))); },
        };
      },
      async match(input, options = {}) {
        const url = abs(input);
        if (options.ignoreSearch) { for (const [key, value] of store) if (bare(key) === bare(url)) return value; return undefined; }
        return store.get(url);
      },
      async keys() { return ['kjr-forex-v0.15']; },
      async delete() { return true; },
    };
    const context = {
      Promise, Set, Map, URL, Request: FakeRequest, Response: FakeResponse, caches,
      location: { origin: 'https://forex.synthetic.test', href: swUrl },
      fetch: async (request) => { if (!state.online) throw new TypeError('Failed to fetch'); return new FakeResponse('net:' + request.url, { status: state.status }); },
      self: { location: { href: swUrl }, addEventListener(type, fn) { listeners[type] = fn; }, skipWaiting() {}, clients: { claim: async () => {} } },
    };
    vm.runInNewContext(swSrc, context, { filename: SW_PATH });
    const visit = async (url, { navigate = false, method = 'GET' } = {}) => {
      let answer;
      listeners.fetch({ request: { url, method, mode: navigate ? 'navigate' : 'cors', cache: 'default' }, respondWith(p) { answer = p; } });
      return answer;
    };
    const install = async () => { let p; listeners.install({ waitUntil(x) { p = x; } }); await p; };
    return { store, puts, state, visit, install };
  }
  await testAsync('O5 - cache-busted visits are shown but never stored, so the cache stays at the shell entries', async () => {
    const sw = makeSwEnv();
    await sw.install();
    assert.strictEqual(sw.store.size, shellEntries.length, 'the install precaches the shell');
    for (let i = 1; i <= 6; i++) {
      const page = await sw.visit(BASE + 'index.html?v=' + i, { navigate: true });
      assert.strictEqual((await page).body, 'net:' + BASE + 'index.html?v=' + i, 'the visit is answered from the network');
    }
    for (const url of [BASE + '?v=99', BASE + 'pricing.html?v=1793000730', BASE + 'index.html?v=3#signup', BASE + 'lib/kjr-format.js?v=1.9', BASE + 'config.js?v=2.0']) {
      await (await sw.visit(url, { navigate: !/\.js\?/.test(url) }));
    }
    assert.strictEqual(sw.puts.length, 0, 'nothing off the shell list is stored');
    // A fragment is not part of the stored URL: index.html#signup is the shell entry index.html.
    await (await sw.visit(BASE + 'index.html#signup', { navigate: true }));
    assert.strictEqual(sw.puts.length, 1, 'a hashed visit of a shell page refreshes that page in place');
    assert.strictEqual(sw.store.size, shellEntries.length, 'the entry count did not move');
  });
  await testAsync('O5 - exact shell URLs are refreshed in place, and the shared whale icon is stored once', async () => {
    const sw = makeSwEnv();
    await sw.install();
    for (const [url, navigate] of [[BASE, true], [BASE + 'index.html', true], [BASE + 'lib/kjr-format.js?v=1.2', false], [BASE + 'config.js?v=1.0', false], [BASE + 'lib/auth-client.js?v=1.0', false]]) {
      await sw.visit(url, { navigate });
      assert.ok(sw.puts.includes(url), url + ' is a shell entry and is stored');
      assert.strictEqual(sw.store.get(url).body, 'net:' + url, 'the stored copy is the fresh one');
    }
    assert.strictEqual(sw.store.size, shellEntries.length, 'refreshing replaces entries, it never adds');
    const icon = 'https://forex.synthetic.test/Portfolio/Worker/whale-icon.png';
    await sw.visit(icon);
    await sw.visit(icon);
    assert.strictEqual(sw.store.size, shellEntries.length + 1);
    await sw.visit('https://forex.synthetic.test/Portfolio/Worker/other.png');
    await sw.visit('https://forex.synthetic.test/Portfolio/Worker/whale-icon.png?v=2');
    assert.strictEqual(sw.store.size, shellEntries.length + 1, 'only the listed shared file, at its exact URL');
  });
  /* ---- S4: the Supabase SDK (218 KB) is stored the first time Auth loads it, never by the install ---- */
  const SDK = BASE + (firstUseEntries[0] || '').replace(/^\.\//, '');
  await testAsync('S4 - a local-owner install never downloads the SDK: the install stores the shell and nothing from supabase', async () => {
    const sw = makeSwEnv();
    await sw.install();
    assert.strictEqual(sw.store.size, shellEntries.length, 'the install precaches the shell only');
    assert.ok(![...sw.store.keys()].some((url) => /supabase/i.test(url)), 'no SDK entry after an install');
    assert.ok(!shellEntries.some((entry) => /supabase/i.test(entry)), 'the SDK is not listed in SHELL');
    assert.strictEqual(firstUseEntries.length, 1, 'one first-use entry');
    assert.match(SDK, /\/lib\/supabase-[\d.]+\.umd\.js\?v=[\d.]+$/, 'it is the SDK, at its exact URL with its ?v= string');
  });
  await testAsync('S4 - the first Auth-on load stores the SDK at its exact URL, later loads refresh it in place, other URLs are never stored', async () => {
    assert.strictEqual(firstUseEntries.length, 1, 'sw.js has a FIRST_USE list holding the SDK');
    const sw = makeSwEnv();
    await sw.install();
    const before = sw.store.size;
    assert.strictEqual((await (await sw.visit(SDK))).body, 'net:' + SDK, 'the page gets the fresh network copy');
    assert.ok(sw.puts.includes(SDK), 'and the worker keeps a copy for offline');
    assert.strictEqual(sw.store.size, before + 1);
    await sw.visit(SDK);
    assert.strictEqual(sw.store.size, before + 1, 'a second load replaces the entry, it never adds one');
    for (const other of [SDK.split('?')[0], SDK.replace(/\?v=.*/, '?v=0.0.1'), SDK + '&x=1', BASE + 'lib/supabase-9.9.9.umd.js?v=9.9.9', BASE + 'lib/supabase-2.117.2.LICENSE']) {
      await sw.visit(other);
    }
    assert.strictEqual(sw.store.size, before + 1, 'only the listed URL is stored, a cache-busted or renamed copy is not');
  });
  await testAsync('S4 - a failed SDK response is never stored, and offline a stored SDK is served while a never-loaded one is a network error', async () => {
    assert.strictEqual(firstUseEntries.length, 1, 'sw.js has a FIRST_USE list holding the SDK');
    const failing = makeSwEnv();
    await failing.install();
    failing.state.status = 404;
    assert.strictEqual((await (await failing.visit(SDK))).status, 404);
    assert.ok(!failing.store.has(SDK), 'a 404 is shown, never kept');
    const sw = makeSwEnv();
    await sw.install();
    sw.state.online = false;
    const never = await (await sw.visit(SDK));
    assert.strictEqual(never.networkError, true, 'never loaded and offline: an error, never index.html standing in for a script');
    sw.state.online = true;
    await sw.visit(SDK);
    sw.state.online = false;
    assert.strictEqual((await (await sw.visit(SDK))).body, 'net:' + SDK, 'loaded once, then served offline');
  });
  test('S4 - source: sw.js lists the SDK as first-use with the URL index.html references, and storage honours the list', () => {
    const tag = /<script id="supabase-sdk"[^>]*\bsrc="([^"]+)"/.exec(indexSrc)[1];
    assert.deepStrictEqual(firstUseEntries, ['./' + tag], 'FIRST_USE is the inert tag src, path and ?v= string');
    assert.match(swSrc, /new Set\(SHELL\.concat\(SHARED, FIRST_USE\)\.map/, 'isStorable accepts the first-use list');
    assert.match(swSrc, /c\.addAll\(SHELL\)/, 'and the install still takes the shell alone');
    assert.doesNotMatch(swSrc, /addAll\([^)]*FIRST_USE/, 'the install never reads the first-use list');
  });
  await testAsync('O5 - a failed response is shown but never stored over a good entry', async () => {
    const sw = makeSwEnv();
    await sw.install();
    sw.state.status = 404;
    const answer = await (await sw.visit(BASE + 'pricing.html', { navigate: true }));
    assert.strictEqual(answer.status, 404);
    assert.strictEqual(sw.puts.length, 0);
    assert.strictEqual(sw.store.get(BASE + 'pricing.html').body, 'precached:./pricing.html');
  });
  await testAsync('O5 - offline, a navigation is served from the shell and anything else that is missing is a network error', async () => {
    const sw = makeSwEnv();
    await sw.install();
    sw.state.online = false;
    assert.strictEqual((await (await sw.visit(BASE + 'index.html?v=555', { navigate: true }))).body, 'precached:./index.html');
    assert.strictEqual((await (await sw.visit(BASE + 'pricing.html?v=5', { navigate: true }))).body, 'precached:./pricing.html', 'the stored page of the same path, not the app');
    assert.strictEqual((await (await sw.visit(BASE + '?v=7', { navigate: true }))).body, 'precached:./');
    assert.strictEqual((await (await sw.visit(BASE + 'nope.html', { navigate: true }))).body, 'precached:./index.html', 'an unknown page opens the app shell');
    assert.strictEqual((await (await sw.visit(BASE + 'lib/kjr-format.js?v=1.2'))).body, 'precached:./lib/kjr-format.js?v=1.2', 'a stored script is served offline');
    const missing = await (await sw.visit(BASE + 'lib/kjr-format.js?v=9.9'));
    assert.strictEqual(missing.networkError, true, 'a missing script is an error, never index.html standing in for JavaScript');
  });
  await testAsync('O5 - cross-origin and non-GET requests are left to the browser', async () => {
    const sw = makeSwEnv();
    await sw.install();
    assert.strictEqual(await sw.visit('https://api.anthropic.com/v1/messages'), undefined);
    assert.strictEqual(await sw.visit('https://abc.supabase.co/rest/v1/trades'), undefined);
    assert.strictEqual(await sw.visit(BASE + 'index.html', { method: 'POST' }), undefined);
  });
  test('O5 - the worker keeps the pieces the other checks rely on', () => {
    assert.match(swSrc, /if \(res\.ok && isStorable\(req\.url\)\)/);
    assert.match(swSrc, /const SHARED = \['\.\.\/Portfolio\/Worker\/whale-icon\.png'\];/);
    assert.match(swSrc, /ignoreSearch: true/);
    assert.match(swSrc, /c\.addAll\(SHELL\)/, 'the install still precaches the whole shell');
    assert.ok(shellEntries.includes('./') && shellEntries.includes('./index.html'));
    assert.doesNotMatch(swSrc, /c\.put\(req, copy\)\)\.catch\(\(\)=>\{\}\);\s*return res;\s*\}\)\.catch\(\(\) => caches\.match\(req\)\.then\(r => r \|\| caches\.match\('\.\/index\.html'\)\)\)/, 'the unconditional put is gone');
  });
}

(async () => {
  await runWorkerContractTests();
  await runSyncContractTests();
  await runShellContractTests();
  console.log(`\nTests completed: ${passed} passed, ${failed} failed.`);
  if (failed > 0) process.exit(1);
})().catch((e) => { console.error(e); process.exit(1); });
