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
const CAL_PATH = path.join(__dirname, '..', 'lib', 'kjr-calendar.js');
const FMT_PATH = path.join(__dirname, '..', 'lib', 'kjr-format.js');
const indexSrc = fs.readFileSync(INDEX_PATH, 'utf8');
const calSrc = fs.readFileSync(CAL_PATH, 'utf8');

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
  const re = new RegExp('function\\s+' + name + '\\s*\\(');
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
  'tradeTags', 'parseTags', 'allTags', 'entitlement'];
const CONST_NAMES = ['PLAN', 'ENTITLEMENTS'];

// allTags() reads the module-level `DB.trades` array; stub the minimal shape it needs
// (a plain data global, not app behaviour) so the function is callable in isolation.
let extractedCode = 'var DB = { trades: [] };\n';
const missing = [];
for (const n of FN_NAMES) {
  try { extractedCode += extractFunction(indexSrc, n, INDEX_PATH) + '\n'; }
  catch (e) { missing.push(n + ' (function, index.html): ' + e.message); }
}
for (const n of CONST_NAMES) {
  try { extractedCode += extractConst(indexSrc, n, INDEX_PATH) + '\n'; }
  catch (e) { missing.push(n + ' (const, index.html): ' + e.message); }
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

const calSandbox = {};
const calContext = vm.createContext(calSandbox);
vm.runInContext(calCode, calContext, { filename: 'extracted-kjr-calendar.js' });

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

console.log(`\nTests completed: ${passed} passed, ${failed} failed.`);
if (failed > 0) process.exit(1);
