// Trading v-tests: zero-dependency Node test suite for Trading/index.html.
// House style: plain Node, tiny assert helpers, PASS/FAIL per test, summary count,
// non-zero exit on failure, no npm dependencies. Mirrors Portfolio/tests/test-core.js.
//
// Trading/index.html holds its logic in one inline <script> with top-level DOM calls,
// so it cannot be require()'d or eval()'d wholesale. This file reads the file as text
// and slices out named, self-contained function/const declarations by brace-matching,
// then runs the extracted source in a fresh vm context. This tests the REAL shipped
// code, not a hand copy, any edit to index.html's function bodies is picked up here
// automatically. Do not modify Trading/index.html to make this suite pass.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const SRC_PATH = path.join(__dirname, '..', 'index.html');
const src = fs.readFileSync(SRC_PATH, 'utf8');

/* ====================== Extraction helpers ====================== */

// From `start` (index of the first "(" of a parameter list), brace-match the
// function body and return the full function text, consuming a trailing ";" if any.
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

// Locate `function NAME(` and return the full declaration text.
function extractFunction(source, name) {
  const re = new RegExp('function\\s+' + name + '\\s*\\(');
  const m = re.exec(source);
  if (!m) throw new Error('extractFunction: "' + name + '" not found in ' + SRC_PATH);
  return sliceFromMatch(source, m.index);
}

// Locate `const NAME = ...;` or `let NAME = ...;` (tracking nested () {} [] depth,
// stopping at the first top-level ";") and rewrite the keyword to `var` so the
// binding attaches to the vm context's global object (const/let bindings at vm
// top-level do NOT become globalThis properties, unlike var/function).
function extractConst(source, name) {
  const re = new RegExp('\\b(?:const|let)\\s+' + name + '\\s*=');
  const m = re.exec(source);
  if (!m) throw new Error('extractConst: "' + name + '" not found in ' + SRC_PATH);
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

const FN_NAMES = [
  'ema', 'rsi', 'macd', 'etDateKey', 'isRegularSession', 'vwapSeries', 'vwapBandsData',
  'lastNonNull', 'atrValue', 'isHoliday', 'isHalfDay', 'regularCloseMin',
  'marketStateFromClock', 'etNow', 'etDateStr', 'parseResult',
  'fmtPx', 'fmtNum', 'fmtPct', 'fmtVol', 'fmtCap', 'evalCond', 'alertDesc', 'esc',
];
const CONST_NAMES = ['NYSE_HOLIDAYS', 'NYSE_HALF_DAYS', 'ALERT_LABELS', 'ALERT_NEEDS_VAL', 'CROSS_TYPES'];

// parseResult's company-name fallback chain ends in the module-level `SYMBOL`
// const (the IIFE-derived default ticker), which is not itself an extraction
// target (it reads location/localStorage at module load). Stub it to the app's
// documented default ("MU") so that fallback branch is exercisable, not a ReferenceError.
let extractedCode = "var SYMBOL = 'MU';\n";
const missing = [];
for (const n of FN_NAMES) {
  try { extractedCode += extractFunction(src, n) + '\n'; }
  catch (e) { missing.push(n + ' (function): ' + e.message); }
}
for (const n of CONST_NAMES) {
  try { extractedCode += extractConst(src, n) + '\n'; }
  catch (e) { missing.push(n + ' (const): ' + e.message); }
}
if (missing.length) {
  console.error('❌ HARNESS ERROR: could not extract the following from index.html:');
  missing.forEach(m => console.error('   - ' + m));
  process.exit(1);
}

// Fixed-"now" Date override so marketStateFromClock() (which reads the real clock
// via bare `new Date()`) can be exercised at chosen pre-market/regular/post/closed
// instants. Only bare `new Date()` / `Date.now()` are affected, `new Date(sec*1000)`
// with an explicit arg still uses the real conversion, unaffected by the override.
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
vm.runInContext(extractedCode, context, { filename: 'extracted-trading.js' });

// The app's own "no value" placeholder glyph, written as a unicode escape (not the
// raw character) so this source file stays plain-ASCII per house style.
const NO_VALUE_GLYPH = '\u2014';

/* ====================== Test runner ====================== */

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`✅ PASS: ${name}`); passed++; }
  catch (e) { console.error(`❌ FAIL: ${name}`); console.error(e); failed++; }
}
function closeTo(actual, expected, tol, msg) {
  assert.ok(Math.abs(actual - expected) < tol, (msg || '') + ` expected ${expected}, got ${actual}`);
}
// Values built inside the vm context are instances of that context's own realm
// (its own Array/Object prototypes), so assert.deepStrictEqual against a host-realm
// literal fails on reference identity even when the data matches. Round-trip
// through JSON to get a plain host-realm value for structural comparison.
function toPlain(x) { return JSON.parse(JSON.stringify(x)); }

console.log('--- Testing Trading/index.html (extracted) ---');

/* ====================== ema ====================== */
test('ema - seed is the simple average of the first `period` values', () => {
  const out = sandbox.ema([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 3);
  assert.strictEqual(out[0], null);
  assert.strictEqual(out[1], null);
  assert.strictEqual(out[2], 2); // avg(1,2,3)
});
test('ema - known series matches hand-computed EMA(3) values', () => {
  // linear series, k=0.5: seed=2 at idx2, then EMA collapses onto the line exactly
  const out = sandbox.ema([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 3);
  assert.deepStrictEqual(toPlain(out), [null, null, 2, 3, 4, 5, 6, 7, 8, 9]);
});
test('ema - period longer than data returns an all-null array of input length', () => {
  const out = sandbox.ema([1, 2, 3], 5);
  assert.strictEqual(out.length, 3);
  assert.ok(out.every(v => v === null));
});

/* ====================== rsi ====================== */
test('rsi - Wilder smoothing matches hand-computed values (period 3)', () => {
  const out = sandbox.rsi([10, 12, 11, 13, 12, 14], 3);
  assert.strictEqual(out[0], null); assert.strictEqual(out[1], null); assert.strictEqual(out[2], null);
  assert.strictEqual(out[3], 80); // ag=4/3, al=1/3, ag/al=4 -> 100-100/5
  closeTo(out[4], 800 / 13, 1e-9); // 61.538461538...
  closeTo(out[5], 850 / 11, 1e-9); // 77.272727272...
});
test('rsi - all-gains series is RSI 100 throughout', () => {
  const out = sandbox.rsi([1, 2, 3, 4, 5, 6, 7], 3);
  for (let i = 3; i < out.length; i++) assert.strictEqual(out[i], 100);
});
test('rsi - flat series has zero avg loss, code path returns 100 (al===0 short-circuit)', () => {
  const out = sandbox.rsi([5, 5, 5, 5, 5, 5], 3);
  assert.strictEqual(out[3], 100);
  assert.strictEqual(out[4], 100);
});
test('rsi - fewer values than period+1 returns all-null', () => {
  const out = sandbox.rsi([1, 2, 3], 5);
  assert.ok(out.every(v => v === null));
});

/* ====================== macd ====================== */
test('macd - line[last] equals ema12[last] - ema26[last] (12/26 relationship)', () => {
  const values = Array.from({ length: 40 }, (_, i) => 100 + i * 0.7 + (i % 5));
  const { line, sig, hist } = sandbox.macd(values);
  const e12 = sandbox.ema(values, 12), e26 = sandbox.ema(values, 26);
  const last = values.length - 1;
  closeTo(line[last], e12[last] - e26[last], 1e-9);
  assert.strictEqual(hist[last], sig[last] != null ? line[last] - sig[last] : null);
  assert.ok(Number.isFinite(sig[last]), 'signal should be finite by the final point given 40 inputs');
});
test('macd - line is null wherever ema26 has not warmed up yet', () => {
  const values = Array.from({ length: 30 }, (_, i) => 50 + i);
  const { line } = sandbox.macd(values);
  for (let i = 0; i < 25; i++) assert.strictEqual(line[i], null); // ema26 needs 26 points (idx 0..24 null)
  assert.notStrictEqual(line[25], null);
});

/* ====================== etDateKey / isRegularSession ====================== */
test('etDateKey - returns YYYY-MM-DD in America/New_York', () => {
  const sec = Date.UTC(2026, 6, 15, 13, 30, 0) / 1000; // 09:30 EDT
  assert.strictEqual(sandbox.etDateKey(sec), '2026-07-15');
});
test('isRegularSession - EDT (summer) boundaries: 09:30 open inclusive, 16:00 close exclusive', () => {
  const open = Date.UTC(2026, 6, 15, 13, 30, 0) / 1000;      // 09:30:00 EDT, Wed
  const beforeOpen = Date.UTC(2026, 6, 15, 13, 29, 0) / 1000; // 09:29:00 EDT
  const beforeClose = Date.UTC(2026, 6, 15, 19, 59, 0) / 1000; // 15:59:00 EDT
  const close = Date.UTC(2026, 6, 15, 20, 0, 0) / 1000;        // 16:00:00 EDT
  assert.strictEqual(sandbox.isRegularSession(open), true);
  assert.strictEqual(sandbox.isRegularSession(beforeOpen), false);
  assert.strictEqual(sandbox.isRegularSession(beforeClose), true);
  assert.strictEqual(sandbox.isRegularSession(close), false);
});
test('isRegularSession - EST (winter) boundaries: 09:30 open inclusive, 16:00 close exclusive', () => {
  const open = Date.UTC(2026, 1, 4, 14, 30, 0) / 1000;       // 09:30:00 EST, Wed 04 Feb 2026
  const beforeOpen = Date.UTC(2026, 1, 4, 14, 29, 0) / 1000; // 09:29:00 EST
  const beforeClose = Date.UTC(2026, 1, 4, 20, 59, 0) / 1000; // 15:59:00 EST
  const close = Date.UTC(2026, 1, 4, 21, 0, 0) / 1000;        // 16:00:00 EST
  assert.strictEqual(sandbox.isRegularSession(open), true);
  assert.strictEqual(sandbox.isRegularSession(beforeOpen), false);
  assert.strictEqual(sandbox.isRegularSession(beforeClose), true);
  assert.strictEqual(sandbox.isRegularSession(close), false);
});
test('isRegularSession - weekend is never a regular session, even at 12:00 ET', () => {
  const satNoon = Date.UTC(2026, 6, 18, 16, 0, 0) / 1000; // Sat 18 Jul 2026, 12:00 EDT
  assert.strictEqual(sandbox.isRegularSession(satNoon), false);
});

/* ====================== vwapSeries / vwapBandsData ====================== */
function mkBar(time, high, low, close, volume) { return { time, open: close, high, low, close, volume }; }
test('vwapSeries - single-session hand-computed VWAP', () => {
  const t930 = Date.UTC(2026, 6, 15, 13, 30, 0) / 1000;
  const t931 = t930 + 60, t932 = t930 + 120;
  const bars = [
    mkBar(t930, 101, 99, 100, 1000),  // tp=100, cumPV=100000, cumV=1000, vwap=100
    mkBar(t931, 103, 101, 102, 2000), // tp=102, cumPV=304000, cumV=3000, vwap=101.333...
    mkBar(t932, 105, 103, 104, 1000), // tp=104, cumPV=408000, cumV=4000, vwap=102
  ];
  const out = sandbox.vwapSeries(bars);
  assert.strictEqual(out[0], 100);
  closeTo(out[1], 304000 / 3000, 1e-9);
  assert.strictEqual(out[2], 102);
});
test('vwapSeries - pre-market bars are null and do not pollute the session accumulator', () => {
  const preMkt = Date.UTC(2026, 6, 15, 12, 0, 0) / 1000; // 08:00 ET, pre-market
  const t930 = Date.UTC(2026, 6, 15, 13, 30, 0) / 1000;
  const bars = [mkBar(preMkt, 50, 48, 49, 999999), mkBar(t930, 101, 99, 100, 1000)];
  const out = sandbox.vwapSeries(bars);
  assert.strictEqual(out[0], null);
  assert.strictEqual(out[1], 100); // unaffected by the huge pre-market volume
});
test('vwapSeries - resets at each new ET trading day, even with an intervening pre-market bar', () => {
  const t930 = Date.UTC(2026, 6, 15, 13, 30, 0) / 1000; // day 1 regular
  const day2Pre = Date.UTC(2026, 6, 16, 12, 0, 0) / 1000; // day 2 pre-market (out of session)
  const day2Reg = Date.UTC(2026, 6, 16, 13, 30, 0) / 1000; // day 2 regular, new session
  const bars = [
    mkBar(t930, 101, 99, 100, 1000),   // day1 vwap=100
    mkBar(day2Pre, 500, 500, 500, 1),  // out of session, ignored
    mkBar(day2Reg, 201, 199, 200, 500), // day2 tp=200, should reset (not blend with day1's 100000/1000)
  ];
  const out = sandbox.vwapSeries(bars);
  assert.strictEqual(out[0], 100);
  assert.strictEqual(out[1], null);
  assert.strictEqual(out[2], 200); // pure reset, proves no cross-day contamination
});
test('vwapBandsData - bands widen from the VWAP by the running population stdev', () => {
  const t930 = Date.UTC(2026, 6, 15, 13, 30, 0) / 1000;
  const bars = [mkBar(t930, 101, 99, 100, 1000), mkBar(t930 + 60, 103, 101, 102, 2000)];
  const { vwap, up1, dn1, up2, dn2 } = sandbox.vwapBandsData(bars);
  assert.strictEqual(vwap[0], 100);
  assert.strictEqual(up1[0], 100); assert.strictEqual(dn1[0], 100); // single point, sd=0
  const sd1 = up1[1] - vwap[1];
  closeTo(up2[1] - vwap[1], sd1 * 2, 1e-9);
  closeTo(vwap[1] - dn1[1], sd1, 1e-9);
});

/* ====================== atrValue ====================== */
test('atrValue - hand-computed true range including a gap-up bar', () => {
  const bars = [
    { high: 100, low: 100, close: 100 },
    { high: 105, low: 102, close: 104 }, // TR=max(3,5,2)=5
    { high: 108, low: 106, close: 107 }, // TR=max(2,4,2)=4
    { high: 130, low: 125, close: 128 }, // gap: TR=max(5,23,18)=23 (dominated by prior close, not h-l)
    { high: 131, low: 127, close: 129 }, // TR=max(4,3,1)=4
  ];
  const atr = sandbox.atrValue(bars, 3);
  // seed=avg(5,4,23)=32/3; next=(32/3*2+4)/3=76/9
  closeTo(atr, 76 / 9, 1e-9);
});
test('atrValue - fewer than period+1 bars returns null', () => {
  assert.strictEqual(sandbox.atrValue([{ high: 1, low: 1, close: 1 }], 3), null);
});

/* ====================== isHoliday / isHalfDay / regularCloseMin ====================== */
test('isHoliday - known 2026 NYSE holiday', () => {
  assert.strictEqual(sandbox.isHoliday('2026-01-01'), true);
  assert.strictEqual(sandbox.regularCloseMin('2026-01-01'), 960);
});
test('isHalfDay - known half day closes at 13:00 ET (780 min)', () => {
  assert.strictEqual(sandbox.isHalfDay('2026-07-02'), true);
  assert.strictEqual(sandbox.regularCloseMin('2026-07-02'), 780);
});
test('isHoliday / isHalfDay - a normal trading day is neither, closes at 16:00', () => {
  assert.strictEqual(sandbox.isHoliday('2026-07-15'), false);
  assert.strictEqual(sandbox.isHalfDay('2026-07-15'), false);
  assert.strictEqual(sandbox.regularCloseMin('2026-07-15'), 960);
});

/* ====================== marketStateFromClock ====================== */
test('marketStateFromClock - pre-market (08:00 ET, weekday)', () => {
  sandbox.__setNow__(Date.UTC(2026, 6, 15, 12, 0, 0)); // 08:00 EDT, Wed
  assert.strictEqual(sandbox.marketStateFromClock(), 'PRE');
  sandbox.__clearNow__();
});
test('marketStateFromClock - regular session (12:00 ET, weekday)', () => {
  sandbox.__setNow__(Date.UTC(2026, 6, 15, 16, 0, 0)); // 12:00 EDT
  assert.strictEqual(sandbox.marketStateFromClock(), 'REGULAR');
  sandbox.__clearNow__();
});
test('marketStateFromClock - after-hours (18:00 ET, weekday)', () => {
  sandbox.__setNow__(Date.UTC(2026, 6, 15, 22, 0, 0)); // 18:00 EDT
  assert.strictEqual(sandbox.marketStateFromClock(), 'POST');
  sandbox.__clearNow__();
});
test('marketStateFromClock - closed on a weekend (Saturday noon ET)', () => {
  sandbox.__setNow__(Date.UTC(2026, 6, 18, 16, 0, 0)); // Sat 18 Jul 2026, 12:00 EDT
  assert.strictEqual(sandbox.marketStateFromClock(), 'CLOSED');
  sandbox.__clearNow__();
});
test('marketStateFromClock - closed on a known NYSE holiday during would-be regular hours', () => {
  sandbox.__setNow__(Date.UTC(2026, 0, 1, 16, 0, 0)); // Thu 01 Jan 2026 12:00 EST, New Year's Day
  assert.strictEqual(sandbox.marketStateFromClock(), 'CLOSED');
  sandbox.__clearNow__();
});

/* ====================== parseResult ====================== */
test('parseResult - normalises null gaps, drops all-null-close bars, fills missing keys', () => {
  const t930 = Date.UTC(2026, 6, 15, 13, 30, 0) / 1000;
  const result = {
    meta: { previousClose: 95, shortName: 'Widget Co' }, // no chartPreviousClose, no regularMarketPrice, sparse
    timestamp: [t930, t930 + 30, t930 + 60, t930 + 90],
    indicators: {
      quote: [{
        open: [99, null, null, 103],
        high: [101, null, null, 104],
        low: [98, null, null, 102],
        close: [100, null, 102, 103], // index 1 has a null close -> whole bar dropped
        volume: [1000, null, null, 500],
      }],
    },
  };
  const r = sandbox.parseResult(result);
  assert.strictEqual(r.bars.length, 3, 'the null-close bar must be dropped, not kept as a null bar');
  // bar for original index 2: open/high/low fall back to close since they were null
  const midBar = r.bars[1];
  assert.strictEqual(midBar.close, 102);
  assert.strictEqual(midBar.open, 102);
  assert.strictEqual(midBar.high, 102);
  assert.strictEqual(midBar.low, 102);
  assert.strictEqual(midBar.volume, 0); // null volume falls back to 0
  assert.strictEqual(r.prevClose, 95); // chartPreviousClose missing -> falls back to previousClose
  assert.strictEqual(r.price, 103); // regularMarketPrice missing -> falls back to last bar's close
  assert.strictEqual(r.sessionOpen, 99); // first regular-session bar's open (all 3 bars are in RTH here)
  assert.strictEqual(r.dayHigh, undefined); // no fallback defined in parseResult for this field
  assert.strictEqual(r.volume, 1500); // regularMarketVolume missing -> summed from bars (1000+0+500)
  assert.strictEqual(r.marketState, undefined);
  assert.strictEqual(r.name, 'Widget Co'); // shortName present
  assert.strictEqual(r.fiftyTwoWeekHigh, null); // missing key normalises to null, not undefined
  assert.strictEqual(r.fiftyTwoWeekLow, null);
});
test('parseResult - empty timestamp array yields zero bars, no throw', () => {
  const r = sandbox.parseResult({ meta: {}, timestamp: [], indicators: { quote: [{}] } });
  assert.strictEqual(r.bars.length, 0);
  assert.strictEqual(r.price, null);
  assert.strictEqual(r.sessionOpen, null);
});

/* ====================== fmt* ====================== */
test('fmtPx - rounds to 2dp, handles zero/negative/null', () => {
  assert.strictEqual(sandbox.fmtPx(1234.567), '$1234.57');
  assert.strictEqual(sandbox.fmtPx(0), '$0.00');
  assert.strictEqual(sandbox.fmtPx(-5.678), '$-5.68');
  assert.strictEqual(sandbox.fmtPx(null), NO_VALUE_GLYPH); // the app's own "no value" glyph
  assert.strictEqual(sandbox.fmtPx(NaN), NO_VALUE_GLYPH);
});
test('fmtNum - thousands separators, negatives, zero, null', () => {
  assert.strictEqual(sandbox.fmtNum(1234567), '1,234,567');
  assert.strictEqual(sandbox.fmtNum(-1234), '-1,234');
  assert.strictEqual(sandbox.fmtNum(0), '0');
  assert.strictEqual(sandbox.fmtNum(null), NO_VALUE_GLYPH);
});
test('fmtPct - signed with +, 2dp, empty string (not the no-value glyph) for null', () => {
  assert.strictEqual(sandbox.fmtPct(5.678), '+5.68%');
  assert.strictEqual(sandbox.fmtPct(-3.2), '-3.20%');
  assert.strictEqual(sandbox.fmtPct(0), '+0.00%');
  assert.strictEqual(sandbox.fmtPct(null), '');
});
test('fmtVol - K/M/B thresholds, negative volume, zero', () => {
  assert.strictEqual(sandbox.fmtVol(2500000000), '2.50B');
  assert.strictEqual(sandbox.fmtVol(1500000), '1.50M');
  assert.strictEqual(sandbox.fmtVol(2500), '2.5K');
  assert.strictEqual(sandbox.fmtVol(500), '500');
  assert.strictEqual(sandbox.fmtVol(-1500000), '-1.50M');
  assert.strictEqual(sandbox.fmtVol(0), '0');
  assert.strictEqual(sandbox.fmtVol(null), NO_VALUE_GLYPH);
});
test('fmtCap - T/B/M thresholds, null', () => {
  assert.strictEqual(sandbox.fmtCap(2.5e12), '$2.50T');
  assert.strictEqual(sandbox.fmtCap(1.5e9), '$1.5B');
  assert.strictEqual(sandbox.fmtCap(500e6), '$500M');
  assert.strictEqual(sandbox.fmtCap(null), NO_VALUE_GLYPH);
});

/* ====================== evalCond / alertDesc ====================== */
test('evalCond - each condition type, true and false', () => {
  const snap = { price: 105, rsi: 70, vwap: 100, ema9: 12, ema20: 10 };
  assert.strictEqual(sandbox.evalCond({ type: 'price_above', value: 100 }, snap), true);
  assert.strictEqual(sandbox.evalCond({ type: 'price_above', value: 110 }, snap), false);
  assert.strictEqual(sandbox.evalCond({ type: 'price_below', value: 110 }, snap), true);
  assert.strictEqual(sandbox.evalCond({ type: 'price_below', value: 100 }, snap), false);
  assert.strictEqual(sandbox.evalCond({ type: 'rsi_above', value: 60 }, snap), true);
  assert.strictEqual(sandbox.evalCond({ type: 'rsi_above', value: 80 }, snap), false);
  assert.strictEqual(sandbox.evalCond({ type: 'rsi_below', value: 80 }, snap), true);
  assert.strictEqual(sandbox.evalCond({ type: 'rsi_below', value: 60 }, snap), false);
  assert.strictEqual(sandbox.evalCond({ type: 'price_vwap_above', value: null }, snap), true);
  assert.strictEqual(sandbox.evalCond({ type: 'price_vwap_below', value: null }, snap), false);
  assert.strictEqual(sandbox.evalCond({ type: 'ema_bull', value: null }, snap), true);
  assert.strictEqual(sandbox.evalCond({ type: 'ema_bear', value: null }, snap), false);
});
test('evalCond - null snapshot fields return false rather than throwing', () => {
  const snap = { price: null, rsi: null, vwap: null, ema9: null, ema20: null };
  assert.strictEqual(sandbox.evalCond({ type: 'price_above', value: 100 }, snap), false);
  assert.strictEqual(sandbox.evalCond({ type: 'ema_bull', value: null }, snap), false);
});
test('alertDesc - describes each alert type using its rule value', () => {
  assert.strictEqual(sandbox.alertDesc({ type: 'price_above', value: 150 }), 'Price rises above $150');
  assert.strictEqual(sandbox.alertDesc({ type: 'price_below', value: 100 }), 'Price falls below $100');
  assert.strictEqual(sandbox.alertDesc({ type: 'rsi_above', value: 70 }), 'RSI rises above 70');
  assert.strictEqual(sandbox.alertDesc({ type: 'rsi_below', value: 30 }), 'RSI falls below 30');
  assert.strictEqual(sandbox.alertDesc({ type: 'price_vwap_above' }), 'Price crosses above VWAP');
  assert.strictEqual(sandbox.alertDesc({ type: 'ema_bull' }), 'EMA 9 crosses above EMA 20');
  assert.strictEqual(sandbox.alertDesc({ type: 'unknown_type' }), 'unknown_type'); // falls back to raw type
});

/* ====================== esc ====================== */
test('esc - escapes HTML metacharacters', () => {
  assert.strictEqual(sandbox.esc('<script>alert("x")&\'</script>'),
    '&lt;script&gt;alert(&quot;x&quot;)&amp;&#39;&lt;/script&gt;');
});
test('esc - null/undefined become empty string, not "null"/"undefined"', () => {
  assert.strictEqual(sandbox.esc(null), '');
  assert.strictEqual(sandbox.esc(undefined), '');
});

console.log(`\nTests completed: ${passed} passed, ${failed} failed.`);
if (failed > 0) process.exit(1);
