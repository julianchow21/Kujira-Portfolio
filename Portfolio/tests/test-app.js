/* Node, zero dependencies, same ✅/❌/summary style as test-core.js.
   Worker/app.js is 8700+ lines of mostly DOM-driven UI code, so this file
   does NOT require() it (that would need a browser). Instead it extracts a
   small set of genuinely pure/near-pure named function declarations out of
   the file AS TEXT and runs them in a fresh vm sandbox with the minimal
   stubs they need (a DB object, and a handful of kjr-core globals the way
   app.js itself expects them to be present as globals from the earlier
   <script src="kjr-core.js"> tag). This never touches or requires app.js's
   DOM code, so nothing here can accidentally exercise browser globals.

   If a target function cannot be found by the extractor, that is a HARNESS
   bug (the function moved/renamed) and this file throws loudly at startup
   rather than silently skipping coverage. */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const core = require('../Worker/kjr-core.js');

const APP_JS_PATH = path.join(__dirname, '..', 'Worker', 'app.js');
const appSrc = fs.readFileSync(APP_JS_PATH, 'utf8');

/* ─── Extraction harness ────────────────────────────────────────────────
   extractFunction: finds `function NAME(` then brace-matches to the closing
   `}` of that function body, skipping over braces inside string/template
   literals and comments so a stray `{` in a regex or a comment can't throw
   the depth counter off. Returns the exact source slice, or null if the
   function name isn't found at all (start of the search fails). */
function extractFunction(name){
  const sigRe = new RegExp('function\\s+' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\(');
  const m = sigRe.exec(appSrc);
  if (!m) return null;
  let i = appSrc.indexOf('{', m.index);
  if (i === -1) return null;
  let depth = 0;
  let inStr = null;           // ' " ` while inside a string/template literal
  let inLineComment = false;
  let inBlockComment = false;
  for (; i < appSrc.length; i++){
    const c = appSrc[i];
    const next = appSrc[i + 1];
    if (inLineComment){ if (c === '\n') inLineComment = false; continue; }
    if (inBlockComment){ if (c === '*' && next === '/'){ inBlockComment = false; i++; } continue; }
    if (inStr){
      if (c === '\\'){ i++; continue; }        // skip escaped char, including \" \\ etc
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '/' && next === '/'){ inLineComment = true; i++; continue; }
    if (c === '/' && next === '*'){ inBlockComment = true; i++; continue; }
    if (c === '\'' || c === '"' || c === '`'){ inStr = c; continue; }
    if (c === '{') depth++;
    else if (c === '}'){
      depth--;
      if (depth === 0) return appSrc.slice(m.index, i + 1);
    }
  }
  return null; // unbalanced braces, should never happen on well-formed source
}

/* extractConstLine: these three supporting constants are simple, single
   physical-line declarations (a regex literal or a small object literal),
   so a full statement-parser is overkill; grab from `const NAME` to the end
   of that line. */
function extractConstLine(name){
  const idx = appSrc.indexOf('const ' + name);
  if (idx === -1) return null;
  const nl = appSrc.indexOf('\n', idx);
  return appSrc.slice(idx, nl === -1 ? undefined : nl);
}

const FUNCTION_TARGETS = [
  'kjrSafeId', 'kjrSafeString', '_isValidTicker',
  'isBrokerageAcct', 'cashMovementDelta', 'cashTradeFlow', 'transferInAmount',
  'annualPremium', 'cashPremiumPerYear', '_insurancePremiumSchedule',
  'estimateAnnualTax', 'toSGD', 'sgdOrNull', 'getFx', '_ageOnYear'
];
const CONST_TARGETS = ['SAFE_ID_RE', 'TICKER_RE', 'PREMIUM_PER_YEAR'];

const extractedFns = {};
const missingFns = [];
FUNCTION_TARGETS.forEach(name => {
  const src = extractFunction(name);
  if (!src) missingFns.push(name);
  else extractedFns[name] = src;
});
const extractedConsts = {};
const missingConsts = [];
CONST_TARGETS.forEach(name => {
  const src = extractConstLine(name);
  if (!src) missingConsts.push(name);
  else extractedConsts[name] = src;
});

if (missingFns.length || missingConsts.length){
  throw new Error(
    'test-app.js extraction harness could not find: ' +
    [...missingFns, ...missingConsts].join(', ') +
    '. This is a harness bug (the function/const moved or was renamed in Worker/app.js), not a test to drop.'
  );
}

/* All extracted pieces run together as ONE script per sandbox, so function
   bodies close over the const bindings (SAFE_ID_RE, TICKER_RE,
   PREMIUM_PER_YEAR) exactly as they do in the real file, and functions that
   call each other (cashPremiumPerYear -> annualPremium) resolve correctly. */
const COMBINED_SRC = [
  ...CONST_TARGETS.map(n => extractedConsts[n]),
  ...FUNCTION_TARGETS.map(n => extractedFns[n])
].join('\n\n');

/* Builds a fresh vm sandbox, populated with the extracted app.js functions
   plus the minimal globals they read: a mutable DB stub (app.js's real
   module-level DB, here just a plain object with a `settings` shape callers
   can mutate per test) and the kjr-core functions/consts estimateAnnualTax
   needs, wired the same way app.js consumes them in the browser (as plain
   globals from the earlier <script src="kjr-core.js"> tag, not a require()).
   Math/Number/isFinite/Date/JSON etc. are intrinsic to any new V8 context,
   no need to inject them. */
function freshSandbox(dbOverrides){
  const sandbox = {
    DB: Object.assign({
      settings: Object.assign({
        salary: {}, tax: {}, birthYear: null,
        fxOverrides: {}, fxRates: {}
      }, (dbOverrides && dbOverrides.settings) || {})
    }, dbOverrides || {}),
    // kjr-core globals estimateAnnualTax reads directly, exactly as app.js does.
    cpfContribRatesForAge: core.cpfContribRatesForAge,
    CPF_OW_CEILING_2026: core.CPF_OW_CEILING_2026,
    computeSgIncomeTax: core.computeSgIncomeTax,
    _round2: core._round2
  };
  vm.createContext(sandbox);
  vm.runInContext(COMBINED_SRC, sandbox, { filename: 'app.js (extracted)' });
  return sandbox;
}

/* Stubs Date inside an already-built sandbox so _insurancePremiumSchedule's
   only impurity (`new Date()` for "today") is pinned to a known instant.
   Runs INSIDE the vm context so the subclass extends that context's own
   intrinsic Date (not the Node host's), keeping everything in one realm.
   Multi-arg `new Date(y,m,d)` and single-arg `new Date(dateString)` calls
   pass straight through untouched; only the zero-arg "now" form is fixed. */
function stubNow(sandbox, isoInstant){
  vm.runInContext(`
    (function(){
      const _RealDate = Date;
      Date = class extends _RealDate {
        constructor(...a){
          if (a.length === 0) super(${JSON.stringify(isoInstant)});
          else super(...a);
        }
      };
    })();
  `, sandbox);
}

function runTests(){
  let passed = 0;
  let failed = 0;

  function test(name, fn){
    try {
      fn();
      console.log(`✅ PASS: ${name}`);
      passed++;
    } catch (e) {
      console.error(`❌ FAIL: ${name}`);
      console.error(e);
      failed++;
    }
  }

  console.log('--- Testing Worker/app.js (extracted pure helpers) ---');
  console.log(`(extraction harness resolved all ${FUNCTION_TARGETS.length} function targets and ${CONST_TARGETS.length} const targets)`);

  /* ═══ kjrSafeId, kjrSafeString, _isValidTicker (~line 871-894) ═══ */

  test('kjrSafeId - valid alnum/underscore/hyphen ids pass through unchanged', () => {
    const sb = freshSandbox();
    assert.strictEqual(sb.kjrSafeId('abc_123-XYZ'), 'abc_123-XYZ');
    assert.strictEqual(sb.kjrSafeId(123), '123'); // numbers coerced to string first
  });

  test('kjrSafeId - length caps at 64 chars, boundary exact-64 passes, 65 fails', () => {
    const sb = freshSandbox();
    const at64 = 'a'.repeat(64);
    const at65 = 'a'.repeat(65);
    assert.strictEqual(sb.kjrSafeId(at64), at64);
    assert.strictEqual(sb.kjrSafeId(at65), null);
  });

  test('kjrSafeId - junk (invalid chars, empty, null, undefined) all rejected to null', () => {
    const sb = freshSandbox();
    assert.strictEqual(sb.kjrSafeId('bad id!'), null); // space + punctuation
    assert.strictEqual(sb.kjrSafeId(''), null);
    assert.strictEqual(sb.kjrSafeId(null), null);
    assert.strictEqual(sb.kjrSafeId(undefined), null);
  });

  test('kjrSafeString - strips ASCII control chars but preserves tab/newline/CR', () => {
    const sb = freshSandbox();
    assert.strictEqual(sb.kjrSafeString('hello\x00world'), 'helloworld');
    assert.strictEqual(sb.kjrSafeString('a\tb\nc\rd'), 'a\tb\nc\rd');
  });

  test('kjrSafeString - length caps at default 500, or a custom maxLen', () => {
    const sb = freshSandbox();
    const long = 'x'.repeat(600);
    assert.strictEqual(sb.kjrSafeString(long).length, 500);
    assert.strictEqual(sb.kjrSafeString('1234567890', 5), '12345');
  });

  test('kjrSafeString - null/undefined return empty string, other types coerce', () => {
    const sb = freshSandbox();
    assert.strictEqual(sb.kjrSafeString(null), '');
    assert.strictEqual(sb.kjrSafeString(undefined), '');
    assert.strictEqual(sb.kjrSafeString(123), '123');
  });

  test('_isValidTicker - valid tickers (plain, SGX code, dotted share class), boundary length 10', () => {
    const sb = freshSandbox();
    assert.strictEqual(sb._isValidTicker('AAPL'), true);
    assert.strictEqual(sb._isValidTicker('D05'), true);
    assert.strictEqual(sb._isValidTicker('BRK.B'), true);
    assert.strictEqual(sb._isValidTicker('A'.repeat(10)), true); // exactly 10 chars
  });

  test('_isValidTicker - invalid tickers (too long, bad chars, empty, null)', () => {
    const sb = freshSandbox();
    assert.strictEqual(sb._isValidTicker('A'.repeat(11)), false); // 11 chars, over cap
    assert.strictEqual(sb._isValidTicker('BAD TICK'), false);     // space not allowed
    assert.strictEqual(sb._isValidTicker(''), false);
    assert.strictEqual(sb._isValidTicker(null), false);
  });

  /* ═══ cashMovementDelta, cashTradeFlow, transferInAmount, isBrokerageAcct (~7243-7264) ═══ */

  test('isBrokerageAcct - true only for account === "Brokerage", falsy on null', () => {
    const sb = freshSandbox();
    assert.strictEqual(sb.isBrokerageAcct({ account: 'Brokerage' }), true);
    assert.strictEqual(sb.isBrokerageAcct({ account: 'Savings' }), false);
    assert.strictEqual(!!sb.isBrokerageAcct(null), false);
  });

  test('cashMovementDelta - adjustment keeps the signed amount as entered', () => {
    const sb = freshSandbox();
    assert.strictEqual(sb.cashMovementDelta({ type: 'adjustment', amount: -50 }), -50);
    assert.strictEqual(sb.cashMovementDelta({ type: 'adjustment', amount: 50 }), 50);
  });

  test('cashMovementDelta - withdrawal and fee are always forced negative', () => {
    const sb = freshSandbox();
    assert.strictEqual(sb.cashMovementDelta({ type: 'withdrawal', amount: 100 }), -100);
    assert.strictEqual(sb.cashMovementDelta({ type: 'withdrawal', amount: -100 }), -100); // idempotent
    assert.strictEqual(sb.cashMovementDelta({ type: 'fee', amount: 20 }), -20);
  });

  test('cashMovementDelta - deposit/dividend/interest (default branch) are always forced positive', () => {
    const sb = freshSandbox();
    assert.strictEqual(sb.cashMovementDelta({ type: 'deposit', amount: 75 }), 75);
    assert.strictEqual(sb.cashMovementDelta({ type: 'dividend', amount: 30 }), 30);
    assert.strictEqual(sb.cashMovementDelta({ type: 'interest', amount: -5 }), 5); // forced positive even if entered negative
  });

  test('cashMovementDelta - missing/non-numeric amount treated as 0', () => {
    const sb = freshSandbox();
    assert.strictEqual(sb.cashMovementDelta({ type: 'deposit' }), 0);
    assert.strictEqual(sb.cashMovementDelta({ type: 'adjustment', amount: 'junk' }), 0);
  });

  test('cashTradeFlow - buy debits (price*qty + fees), sell credits (price*qty - fees)', () => {
    const sb = freshSandbox();
    assert.strictEqual(sb.cashTradeFlow({ side: 'buy', shares: 10, price: 50, fees: 5 }), -505);
    assert.strictEqual(sb.cashTradeFlow({ side: 'sell', shares: 10, price: 50, fees: 5 }), 495);
  });

  test('cashTradeFlow - negative shares input is absolute-valued, missing fields default to 0', () => {
    const sb = freshSandbox();
    assert.strictEqual(sb.cashTradeFlow({ side: 'buy', shares: -10, price: 50, fees: 5 }), -505);
    assert.strictEqual(sb.cashTradeFlow({ side: 'buy', shares: 10, price: 50 }), -500); // no fees field
  });

  test('transferInAmount - uses amountIn when present, including a genuine zero', () => {
    const sb = freshSandbox();
    assert.strictEqual(sb.transferInAmount({ amount: 100, amountIn: 80 }), 80); // cross-currency leg
    assert.strictEqual(sb.transferInAmount({ amount: 100, amountIn: 0 }), 0);   // zero is honoured, not treated as missing
  });

  test('transferInAmount - falls back to abs(amount) when amountIn is missing or blank', () => {
    const sb = freshSandbox();
    assert.strictEqual(sb.transferInAmount({ amount: -100 }), 100);
    assert.strictEqual(sb.transferInAmount({ amount: 100, amountIn: '' }), 100);
    assert.strictEqual(sb.transferInAmount({ amount: 100, amountIn: null }), 100);
  });

  /* ═══ annualPremium, cashPremiumPerYear (~6642) ═══ */

  test('annualPremium - every payment frequency', () => {
    const sb = freshSandbox();
    assert.strictEqual(sb.annualPremium({ premium: 100, premiumFreq: 'Monthly' }), 1200);
    assert.strictEqual(sb.annualPremium({ premium: 100, premiumFreq: 'Quarterly' }), 400);
    assert.strictEqual(sb.annualPremium({ premium: 100, premiumFreq: 'Semi-annual' }), 200);
    assert.strictEqual(sb.annualPremium({ premium: 100, premiumFreq: 'Annual' }), 100);
    assert.strictEqual(sb.annualPremium({ premium: 100, premiumFreq: 'Single' }), 0);
  });

  test('annualPremium - unrecognised frequency falls back to an Annual-like x1 multiplier, missing fields are 0', () => {
    const sb = freshSandbox();
    assert.strictEqual(sb.annualPremium({ premium: 100, premiumFreq: 'Unknown' }), 100);
    assert.strictEqual(sb.annualPremium({ premiumFreq: 'Monthly' }), 0); // no premium field
    assert.strictEqual(sb.annualPremium({}), 0);
  });

  test('cashPremiumPerYear - only Cash/Card payment modes count, everything else is 0', () => {
    const sb = freshSandbox();
    assert.strictEqual(sb.cashPremiumPerYear({ premium: 100, premiumFreq: 'Monthly', premiumMode: 'Cash' }), 1200);
    assert.strictEqual(sb.cashPremiumPerYear({ premium: 100, premiumFreq: 'Monthly', premiumMode: 'Card' }), 1200);
    assert.strictEqual(sb.cashPremiumPerYear({ premium: 100, premiumFreq: 'Monthly', premiumMode: 'GIRO' }), 0);
    assert.strictEqual(sb.cashPremiumPerYear({ premium: 100, premiumFreq: 'Monthly' }), 0); // missing premiumMode
  });

  /* ═══ _insurancePremiumSchedule (~6991) ═══
     Date is stubbed to a fixed "today" (2026-01-15) so the 12-month window
     (Jan-Dec 2026) and every anchor-date offset below is fully deterministic,
     never drifting with the real calendar. */

  test('_insurancePremiumSchedule - schedule shape over a small mixed policy list, Date pinned to 2026-01-15', () => {
    const sb = freshSandbox();
    stubNow(sb, '2026-01-15T00:00:00');
    const policies = [
      { status: 'Active', premium: 100, premiumFreq: 'Monthly',      premiumMode: 'Cash' },                              // every month
      { status: 'Active', premium: 300, premiumFreq: 'Quarterly',    premiumMode: 'Cash', premiumDue: '2026-03-15' },    // future anchor, Mar/Jun/Sep/Dec
      { status: 'Active', premium: 500, premiumFreq: 'Semi-annual',  premiumMode: 'Card', premiumDue: '2025-10-01' },    // past anchor, wraps to Apr/Oct
      { status: 'Active', premium: 200, premiumFreq: 'Annual',       premiumMode: 'GIRO' },                              // wrong payment mode, excluded silently (not counted)
      { status: 'Active', premium: 50,  premiumFreq: 'Quarterly',    premiumMode: 'Cash', premiumDue: null },            // no due date, counted in `excluded`
      { status: 'Lapsed', premium: 999, premiumFreq: 'Monthly',      premiumMode: 'Cash' },                              // inactive, ignored entirely
      { status: 'Active', premium: 0,   premiumFreq: 'Monthly',      premiumMode: 'Cash' },                              // zero premium, ignored
      { status: 'Active', premium: 1000, premiumFreq: 'Single',      premiumMode: 'Cash' }                               // Single never recurs
    ];
    const schedule = sb._insurancePremiumSchedule(policies);
    assert.strictEqual(schedule.series.length, 12);
    assert.strictEqual(schedule.labels.length, 12);
    assert.strictEqual(schedule.excluded, 1); // only the no-premiumDue Quarterly policy
    // index: 0=Jan .. 11=Dec 2026. Array.from copies the vm-realm array into a plain
    // Node-realm array first: deepStrictEqual treats cross-realm Array instances as
    // not reference-equal even when every element matches, so compare on element
    // values via a same-realm copy rather than the raw vm-context array.
    assert.deepStrictEqual(Array.from(schedule.series), [100, 100, 400, 600, 100, 400, 100, 100, 400, 600, 100, 400]);
  });

  test('_insurancePremiumSchedule - empty list returns a full-length zero series, no excluded', () => {
    const sb = freshSandbox();
    stubNow(sb, '2026-01-15T00:00:00');
    const schedule = sb._insurancePremiumSchedule([]);
    assert.strictEqual(schedule.series.length, 12);
    assert.strictEqual(schedule.series.every(v => v === 0), true);
    assert.strictEqual(schedule.excluded, 0);
  });

  /* ═══ estimateAnnualTax (~2149) ═══
     Financially critical; previously zero coverage. Depends on DB.settings
     (salary, tax, birthYear) and four kjr-core globals (cpfContribRatesForAge,
     CPF_OW_CEILING_2026, computeSgIncomeTax, _round2), all wired into the
     sandbox exactly as app.js consumes them (as plain globals, kjr-core is
     loaded as a prior <script src> in the browser). birthYear is left null
     in these tests (age -> null -> the <=55 CPF rate band), which sidesteps
     _ageOnYear's own dependence on "this calendar year" while still
     exercising estimateAnnualTax's real CPF-relief and tax-banding logic. */

  test('estimateAnnualTax - zero income (no grossMonthly configured) returns null', () => {
    const sb = freshSandbox({ settings: { salary: {}, tax: {} } });
    assert.strictEqual(sb.estimateAnnualTax(), null);
  });

  test('estimateAnnualTax - plain salary-only year matches hand-computed IRAS tax and CPF relief', () => {
    const sb = freshSandbox({ settings: { salary: { grossMonthly: 6000 }, tax: {}, birthYear: null } });
    const est = sb.estimateAnnualTax();
    // annualGross = 6000*12 = 72000. OW ceiling 8000/mo not hit, so owForCpf = 72000,
    // AW leg is 0 (no bonus). age null -> employee rate 20% -> annualEmpCpf = 72000*0.20 = 14400.
    assert.strictEqual(est.annualGross, 72000);
    assert.strictEqual(est.annualEmpCpf, 14400);
    assert.strictEqual(est.reliefs, 0);
    assert.strictEqual(est.chargeableIncome, 57600); // 72000 - 14400
    // Hand IRAS calc at 57600 (40k-80k band, base 550, rate 7%): 550 + 17600*0.07 = 1782.
    assert.strictEqual(est.annualTax, 1782);
    assert.strictEqual(est.monthlyProvision, 148.5); // 1782/12
    assert.strictEqual(est.residency, 'resident');
    assert.strictEqual(est.isManual, false);
    // Cross-check against kjr-core's own computeCpfContribution at the same monthly
    // wage and age: with no bonus, annualEmpCpf/12 must equal the monthly employeeCPF.
    const monthlyCpf = core.computeCpfContribution(6000, null);
    assert.strictEqual(est.annualEmpCpf / 12, monthlyCpf.employeeCPF);
  });

  test('estimateAnnualTax - bonus above the AW ceiling earns no further CPF relief on the excess', () => {
    const sb = freshSandbox({ settings: { salary: { grossMonthly: 9000, annualBonus: 150000 }, tax: {}, birthYear: null } });
    const est = sb.estimateAnnualTax();
    // Monthly wage capped at the 8000 OW ceiling -> owForCpf = 96000.
    // awCeiling = 102000 - 96000 = 6000, so only 6000 of the 150000 bonus attracts CPF
    // (the other 144000 gets no CPF relief at all).
    // annualEmpCpf = (96000+6000)*0.20 = 20400.
    assert.strictEqual(est.annualGross, 9000 * 12 + 150000); // 258000
    assert.strictEqual(est.annualEmpCpf, 20400);
    assert.strictEqual(est.chargeableIncome, 258000 - 20400); // 237600
    // Hand IRAS calc at 237600 (200k-240k band, base 21150, rate 19%): 21150 + 37600*0.19 = 28294.
    assert.strictEqual(est.annualTax, 28294);
    assert.strictEqual(est.monthlyProvision, core._round2(28294 / 12));
    // Cross-check: the OW leg alone (96000*0.20=19200) plus the capped AW leg
    // (6000*0.20=1200) must sum to annualEmpCpf, confirming the AW-ceiling cap fired.
    const owLegEmployeeCpf = core.computeCpfContribution(8000, null).employeeCPF * 12;
    assert.strictEqual(owLegEmployeeCpf + 6000 * 0.20, est.annualEmpCpf);
  });

  test('estimateAnnualTax - manual override and non-resident flat-vs-graduated comparison', () => {
    const sbManual = freshSandbox({ settings: { salary: { grossMonthly: 6000 }, tax: { manualAnnualTax: 5000 }, birthYear: null } });
    const estManual = sbManual.estimateAnnualTax();
    assert.strictEqual(estManual.annualTax, 5000);
    assert.strictEqual(estManual.isManual, true);

    // Non-resident: higher of 15% flat on gross vs graduated on chargeable income.
    // At 72000 gross with 57600 chargeable, flat = 72000*0.15 = 10800, graduated (from
    // the test above) = 1782, so the flat leg must win.
    const sbNr = freshSandbox({ settings: { salary: { grossMonthly: 6000 }, tax: { residency: 'non-resident' }, birthYear: null } });
    const estNr = sbNr.estimateAnnualTax();
    assert.strictEqual(estNr.residency, 'non-resident');
    assert.strictEqual(estNr.annualTax, 10800);
  });

  /* ═══ toSGD vs sgdOrNull (~2851-2865) ═══
     Missing-FX-rate semantics: toSGD falls back 1:1 (best-effort), sgdOrNull
     returns null (strict, so aggregate totals can exclude the unconvertible
     row rather than silently understate/overstate it). Pinned here so any
     future change to either fallback behaviour is loud. */

  test('toSGD - SGD or no currency passes through 1:1, no FX lookup needed', () => {
    const sb = freshSandbox();
    assert.strictEqual(sb.toSGD(100, 'SGD'), 100);
    assert.strictEqual(sb.toSGD(100, null), 100);
  });

  test('toSGD - missing FX rate falls back to the raw amount 1:1 (best-effort)', () => {
    const sb = freshSandbox({ settings: { fxRates: {}, fxOverrides: {} } });
    assert.strictEqual(sb.toSGD(100, 'USD'), 100); // no USDSGD rate on file -> falls back, does NOT return null
  });

  test('toSGD - converts using fxRates, with fxOverrides taking priority', () => {
    const sb = freshSandbox({ settings: { fxRates: { USDSGD: 1.35 }, fxOverrides: {} } });
    assert.strictEqual(sb.toSGD(100, 'USD'), 135);
    const sbOverride = freshSandbox({ settings: { fxRates: { USDSGD: 1.35 }, fxOverrides: { USDSGD: 1.4 } } });
    assert.strictEqual(sbOverride.toSGD(100, 'USD'), 140); // override wins over the fetched rate
  });

  test('sgdOrNull - SGD or no currency passes through 1:1', () => {
    const sb = freshSandbox();
    assert.strictEqual(sb.sgdOrNull(100, 'SGD'), 100);
    assert.strictEqual(sb.sgdOrNull(100, null), 100);
  });

  test('sgdOrNull - missing FX rate returns null, the strict opposite of toSGD', () => {
    const sb = freshSandbox({ settings: { fxRates: {}, fxOverrides: {} } });
    assert.strictEqual(sb.sgdOrNull(100, 'USD'), null); // caller can exclude this row from a total
  });

  test('sgdOrNull - converts using fxRates the same way toSGD does when a rate is present', () => {
    const sb = freshSandbox({ settings: { fxRates: { USDSGD: 1.35 }, fxOverrides: {} } });
    assert.strictEqual(sb.sgdOrNull(100, 'USD'), 135);
  });

  test('toSGD and sgdOrNull - both treat a non-finite amount as 0, even with a missing FX rate', () => {
    const sb = freshSandbox({ settings: { fxRates: {}, fxOverrides: {} } });
    assert.strictEqual(sb.toSGD('junk', 'USD'), 0);
    assert.strictEqual(sb.sgdOrNull('junk', 'USD'), 0); // isFinite guard fires before the FX lookup, so this is 0, not null
  });

  console.log(`\nTests completed: ${passed} passed, ${failed} failed.`);
  if (failed > 0) process.exit(1);
}

runTests();
