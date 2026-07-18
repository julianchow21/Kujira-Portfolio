// Trading v-tests: zero-dependency Node test suite for
// "Trading/Worker/MU Yahoo Worker v3 (13 Jun).js" (the Cloudflare Worker proxy).
// House style: plain Node, tiny assert helpers, PASS/FAIL per test, summary count,
// non-zero exit on failure, no npm dependencies. Mirrors Portfolio/tests/test-core.js.
//
// The Worker file ends in `export default { fetch, scheduled }`, an ES module export
// that plain `require()`/`vm` cannot evaluate directly (and its handlers need live
// Cloudflare bindings anyway). This file reads the file as text and slices out the
// top-level PURE helpers and validation constants by brace-matching, ignoring the
// `export default` block entirely, then runs the extracted source in a fresh vm
// context. This tests the REAL shipped code, not a hand copy. Do not modify the
// Worker file to make this suite pass.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const SRC_PATH = path.join(__dirname, '..', 'Worker', 'MU Yahoo Worker v3 (13 Jun).js');
const TRADING_HTML_PATH = path.join(__dirname, '..', 'index.html');
const src = fs.readFileSync(SRC_PATH, 'utf8');
const tradingSrc = fs.readFileSync(TRADING_HTML_PATH, 'utf8');

/* ====================== Extraction helpers (see test-trading.js for full notes) ====================== */

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
  const re = new RegExp('function\\s+' + name + '\\s*\\(');
  const m = re.exec(source);
  if (!m) throw new Error('extractFunction: "' + name + '" not found in ' + fromPath);
  return sliceFromMatch(source, m.index);
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

/* ====================== Extract Worker's pure helpers + constants ====================== */
// Nested helpers `ema`/`rsiLast` inside parseAndSnap are self-contained closures pulled
// in automatically as part of parseAndSnap's own brace-matched body.
const FN_NAMES = ['isRegularSession', 'etDateKey', 'parseAndSnap', 'evalCond', 'alertDesc', 'isMarketWindow'];
const CONST_NAMES = ['INTERVALS', 'RANGES', 'SYMBOL_RE', 'CROSS_TYPES'];

let extractedCode = '';
const missing = [];
for (const n of FN_NAMES) {
  try { extractedCode += extractFunction(src, n, SRC_PATH) + '\n'; }
  catch (e) { missing.push(n + ' (function): ' + e.message); }
}
for (const n of CONST_NAMES) {
  try { extractedCode += extractConst(src, n, SRC_PATH) + '\n'; }
  catch (e) { missing.push(n + ' (const): ' + e.message); }
}
if (missing.length) {
  console.error('❌ HARNESS ERROR: could not extract the following from the Worker file:');
  missing.forEach(m => console.error('   - ' + m));
  process.exit(1);
}

extractedCode += `
var __REAL_DATE__ = Date;
var __NOW_OVERRIDE__ = null;
function __setNow__(ms){ __NOW_OVERRIDE__ = ms; }
function __clearNow__(){ __NOW_OVERRIDE__ = null; }
Date = class extends __REAL_DATE__ {
  constructor(...args) {
    if (args.length === 0 && __NOW_OVERRIDE__ != null) super(__NOW_OVERRIDE__);
    else super(...args);
  }
  static now(){ return __NOW_OVERRIDE__ != null ? __NOW_OVERRIDE__ : __REAL_DATE__.now(); }
};
`;

const sandbox = {};
const context = vm.createContext(sandbox);
vm.runInContext(extractedCode, context, { filename: 'extracted-worker.js' });

/* ====================== Also pull the frontend's evalCond, for parity checks ====================== */
let frontendCode = '';
frontendCode += extractFunction(tradingSrc, 'evalCond', TRADING_HTML_PATH) + '\n';
const frontendSandbox = {};
const frontendContext = vm.createContext(frontendSandbox);
vm.runInContext(frontendCode, frontendContext, { filename: 'extracted-trading-evalcond.js' });

/* ====================== Cross-check INTERVALS/RANGES against what the frontend actually requests ====================== */
// Pulled straight from Trading/index.html's TIMEFRAMES / DAILY_PARAMS / RS_SYMBOL fetch,
// see Trading/CLAUDE.md "Timeframes". Kept as a literal list here (not re-extracted) since
// this is a cross-check of two independently-authored whitelists, not a re-test of one.
const FRONTEND_INTERVALS_USED = ['1m', '5m', '15m', '60m', '1d'];
const FRONTEND_RANGES_USED = ['1d', '5d', '1mo', '3mo', '6mo'];

/* ====================== Test runner ====================== */

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`✅ PASS: ${name}`); passed++; }
  catch (e) { console.error(`❌ FAIL: ${name}`); console.error(e); failed++; }
}

console.log('--- Testing Trading Worker (extracted) ---');

/* ====================== SYMBOL_RE ====================== */
test('SYMBOL_RE - accepts sane tickers', () => {
  assert.strictEqual(sandbox.SYMBOL_RE.test('MU'), true);
  assert.strictEqual(sandbox.SYMBOL_RE.test('BRK-B'), true);
  assert.strictEqual(sandbox.SYMBOL_RE.test('AAPL'), true);
  assert.strictEqual(sandbox.SYMBOL_RE.test('BRK.A'), true);
});
test('SYMBOL_RE - rejects injection-y strings, lowercase, empty, over-long input', () => {
  assert.strictEqual(sandbox.SYMBOL_RE.test(''), false);
  assert.strictEqual(sandbox.SYMBOL_RE.test('mu'), false); // lowercase not allowed
  assert.strictEqual(sandbox.SYMBOL_RE.test('MU; DROP TABLE'), false);
  assert.strictEqual(sandbox.SYMBOL_RE.test('MU OR 1=1'), false);
  assert.strictEqual(sandbox.SYMBOL_RE.test('<script>'), false);
  assert.strictEqual(sandbox.SYMBOL_RE.test('AAAAAAAAAAAAA'), false); // 13 chars, cap is 12
});

/* ====================== INTERVALS / RANGES whitelists ====================== */
test('INTERVALS - contains every interval the frontend actually requests', () => {
  for (const iv of FRONTEND_INTERVALS_USED) {
    assert.strictEqual(sandbox.INTERVALS.has(iv), true, `frontend requests interval "${iv}" but Worker INTERVALS lacks it`);
  }
});
test('RANGES - contains every range the frontend actually requests', () => {
  for (const rg of FRONTEND_RANGES_USED) {
    assert.strictEqual(sandbox.RANGES.has(rg), true, `frontend requests range "${rg}" but Worker RANGES lacks it`);
  }
});
test('INTERVALS / RANGES - reject an unlisted value', () => {
  assert.strictEqual(sandbox.INTERVALS.has('3m'), false);
  assert.strictEqual(sandbox.RANGES.has('10y'), false);
});

/* ====================== parseAndSnap ====================== */
function mkFixtureResult(n) {
  const ts = [], closes = [], opens = [], highs = [], lows = [], vols = [];
  const base = Date.UTC(2026, 6, 15, 13, 30, 0) / 1000; // 09:30 EDT, all bars in regular session
  for (let i = 0; i < n; i++) {
    ts.push(base + i * 60);
    const c = 100 + i * 0.1;
    closes.push(c); opens.push(c - 0.05); highs.push(c + 0.1); lows.push(c - 0.1); vols.push(1000 + i);
  }
  return {
    meta: { regularMarketPrice: closes[closes.length - 1] },
    timestamp: ts,
    indicators: { quote: [{ open: opens, high: highs, low: lows, close: closes, volume: vols }] },
  };
}
test('parseAndSnap - snapshot fields present and finite on a realistic fixture', () => {
  const snap = sandbox.parseAndSnap(mkFixtureResult(30));
  assert.ok(snap, 'snap should not be null for valid input');
  assert.strictEqual(typeof snap.price, 'number'); assert.ok(Number.isFinite(snap.price));
  assert.strictEqual(typeof snap.rsi, 'number'); assert.ok(Number.isFinite(snap.rsi));
  assert.strictEqual(typeof snap.vwap, 'number'); assert.ok(Number.isFinite(snap.vwap));
  assert.strictEqual(typeof snap.ema9, 'number'); assert.ok(Number.isFinite(snap.ema9));
  assert.strictEqual(typeof snap.ema20, 'number'); assert.ok(Number.isFinite(snap.ema20));
});
test('parseAndSnap - vwap is null when there are no regular-session bars for today', () => {
  const fixture = mkFixtureResult(25);
  // shift every bar to pre-market (08:00 ET) so none qualify for the vwap accumulator
  const preMktBase = Date.UTC(2026, 6, 15, 12, 0, 0) / 1000;
  fixture.timestamp = fixture.timestamp.map((_, i) => preMktBase + i * 60);
  const snap = sandbox.parseAndSnap(fixture);
  assert.strictEqual(snap.vwap, null);
});
test('parseAndSnap - null result input returns null, does not throw', () => {
  assert.strictEqual(sandbox.parseAndSnap(null), null);
});
test('parseAndSnap - fewer bars than the RSI/EMA20 warm-up period yields null indicators, not NaN', () => {
  const snap = sandbox.parseAndSnap(mkFixtureResult(5));
  assert.strictEqual(snap.rsi, null);
  assert.strictEqual(snap.ema20, null);
  assert.strictEqual(typeof snap.price, 'number');
});

/* ====================== evalCond / alertDesc ====================== */
test('evalCond - each condition type, true and false (same semantics as the frontend)', () => {
  const snap = { price: 105, rsi: 70, vwap: 100, ema9: 12, ema20: 10 };
  assert.strictEqual(sandbox.evalCond({ type: 'price_above', value: 100 }, snap), true);
  assert.strictEqual(sandbox.evalCond({ type: 'price_above', value: 110 }, snap), false);
  assert.strictEqual(sandbox.evalCond({ type: 'price_below', value: 110 }, snap), true);
  assert.strictEqual(sandbox.evalCond({ type: 'price_below', value: 100 }, snap), false);
  assert.strictEqual(sandbox.evalCond({ type: 'rsi_above', value: 60 }, snap), true);
  assert.strictEqual(sandbox.evalCond({ type: 'rsi_below', value: 60 }, snap), false);
  assert.strictEqual(sandbox.evalCond({ type: 'price_vwap_above', value: null }, snap), true);
  assert.strictEqual(sandbox.evalCond({ type: 'price_vwap_below', value: null }, snap), false);
  assert.strictEqual(sandbox.evalCond({ type: 'ema_bull', value: null }, snap), true);
  assert.strictEqual(sandbox.evalCond({ type: 'ema_bear', value: null }, snap), false);
});
test('evalCond - parity with the frontend evalCond across a random-ish matrix of snapshots', () => {
  const types = ['price_above', 'price_below', 'rsi_above', 'rsi_below',
    'price_vwap_above', 'price_vwap_below', 'ema_bull', 'ema_bear'];
  const snaps = [
    { price: 100, rsi: 50, vwap: 100, ema9: 10, ema20: 10 },
    { price: 105, rsi: 30, vwap: 110, ema9: 12, ema20: 9 },
    { price: null, rsi: null, vwap: null, ema9: null, ema20: null },
    { price: 99.999, rsi: 70.001, vwap: 100, ema9: 5, ema20: 5 },
  ];
  for (const snap of snaps) {
    for (const type of types) {
      const alert = { type, value: 100 };
      const workerResult = sandbox.evalCond(alert, snap);
      const frontendResult = frontendSandbox.evalCond(alert, snap);
      assert.strictEqual(workerResult, frontendResult, `evalCond mismatch for type=${type} snap=${JSON.stringify(snap)}`);
    }
  }
});
test('alertDesc - non-empty description for every alert type, changes with type', () => {
  const types = ['price_above', 'price_below', 'rsi_above', 'rsi_below',
    'price_vwap_above', 'price_vwap_below', 'ema_bull', 'ema_bear'];
  const seen = new Set();
  for (const type of types) {
    const desc = sandbox.alertDesc({ type, value: 42 });
    assert.strictEqual(typeof desc, 'string');
    assert.ok(desc.length > 0);
    seen.add(desc);
  }
  assert.strictEqual(seen.size, types.length, 'every alert type should produce a distinct description');
});
test('alertDesc - exact strings (Worker format differs intentionally from the frontend rule-label format)', () => {
  assert.strictEqual(sandbox.alertDesc({ type: 'price_above', value: 150 }), 'Price >= $150.00');
  assert.strictEqual(sandbox.alertDesc({ type: 'ema_bull' }), 'EMA 9 crossed above EMA 20');
  assert.strictEqual(sandbox.alertDesc({ type: 'unknown_type' }), 'unknown_type');
});

/* ====================== isRegularSession / etDateKey ====================== */
test('isRegularSession - 09:30 open inclusive, 16:00 close exclusive (EDT)', () => {
  const open = Date.UTC(2026, 6, 15, 13, 30, 0) / 1000;
  const beforeOpen = Date.UTC(2026, 6, 15, 13, 29, 0) / 1000;
  const close = Date.UTC(2026, 6, 15, 20, 0, 0) / 1000;
  const beforeClose = Date.UTC(2026, 6, 15, 19, 59, 0) / 1000;
  assert.strictEqual(sandbox.isRegularSession(open), true);
  assert.strictEqual(sandbox.isRegularSession(beforeOpen), false);
  assert.strictEqual(sandbox.isRegularSession(beforeClose), true);
  assert.strictEqual(sandbox.isRegularSession(close), false);
});
test('etDateKey - matches the frontend format (YYYY-MM-DD, America/New_York)', () => {
  const sec = Date.UTC(2026, 6, 15, 13, 30, 0) / 1000;
  assert.strictEqual(sandbox.etDateKey(sec), '2026-07-15');
});

/* ====================== isMarketWindow ====================== */
test('isMarketWindow - true inside the 09:25-16:05 ET scheduled-check window (boundaries inclusive)', () => {
  sandbox.__setNow__(Date.UTC(2026, 6, 15, 13, 25, 0)); // 09:25 ET
  assert.strictEqual(sandbox.isMarketWindow(), true);
  sandbox.__clearNow__();
  sandbox.__setNow__(Date.UTC(2026, 6, 15, 20, 5, 0)); // 16:05 ET
  assert.strictEqual(sandbox.isMarketWindow(), true);
  sandbox.__clearNow__();
});
test('isMarketWindow - false one minute outside either boundary', () => {
  sandbox.__setNow__(Date.UTC(2026, 6, 15, 13, 24, 0)); // 09:24 ET
  assert.strictEqual(sandbox.isMarketWindow(), false);
  sandbox.__clearNow__();
  sandbox.__setNow__(Date.UTC(2026, 6, 15, 20, 6, 0)); // 16:06 ET
  assert.strictEqual(sandbox.isMarketWindow(), false);
  sandbox.__clearNow__();
});
test('isMarketWindow - false on a weekend regardless of time of day', () => {
  sandbox.__setNow__(Date.UTC(2026, 6, 18, 16, 0, 0)); // Sat 18 Jul 2026, 12:00 EDT
  assert.strictEqual(sandbox.isMarketWindow(), false);
  sandbox.__clearNow__();
});

console.log(`\nTests completed: ${passed} passed, ${failed} failed.`);
if (failed > 0) process.exit(1);
