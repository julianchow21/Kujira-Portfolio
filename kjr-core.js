/* ═══════════════════════════════════════════════════════════════════════
   KUJIRA PORTFOLIO — kjr-core.js
   Pure, side-effect-free logic extracted from index.html so it can be unit
   tested under node with zero build step. Loaded by index.html via a plain
   <script src> (functions become globals); also require()-able from tests via
   the module.exports shim at the foot of the file.
   Keep this file PURE: no DOM, no localStorage, no fetch, no app globals.
   ═══════════════════════════════════════════════════════════════════════ */

/* True when a DB-shaped object holds any real financial data. Used to decide
   whether seeding an empty cloud sheet is safe (see seedDecision). Snapshots,
   changelog and trash are intentionally excluded — they can exist without the
   user having entered any holdings. */
function looksPopulated(db){
  if (!db || typeof db !== 'object') return false;
  var tables = ['stocks','crypto','realestate','cash','cpfHistory','income','expenses'];
  return tables.some(function(t){ return Array.isArray(db[t]) && db[t].length > 0; });
}

/* #Crit-1 seed-safety guard. boot() pulls the cloud sheet and, on first run,
   seeds an empty sheet from local. The danger: a SCHEMA version bump (or a
   malformed backend response) makes a POPULATED remote read as "wrong schema",
   and the old code would push the empty local DB over it — wiping the master
   record. This pure decision function closes that path.
     remoteData     parsed cloud response
     opts           { allowSeed } — true only on the boot pull
     expectedSchema the SCHEMA constant the client expects
   Returns:
     'ok'         schema matches — no seed branch, normal pull
     'seed'       remote is genuinely empty and seeding is allowed -> safe
     'refuse'     remote holds data under an unexpected schema -> NEVER overwrite
     'push-first' remote empty but not in seed mode -> caller shows "Push first"
*/
function seedDecision(remoteData, opts, expectedSchema){
  if (remoteData && remoteData.schema === expectedSchema) return 'ok';
  if (looksPopulated(remoteData)) return 'refuse';
  if (opts && opts.allowSeed) return 'seed';
  return 'push-first';
}

/* ─── SG public holidays ────────────────────────────────────────────────
   2026 follows the MOM gazette. 2027 covers fixed-date holidays only.
   Observed-Monday dates (when a holiday falls on a Sunday) are the entries
   that matter for payday. Top up each December for the coming year. */
const SG_HOLIDAYS = new Set([
  // 2026
  '2026-01-01', // New Year's Day
  '2026-02-17', // Chinese New Year
  '2026-02-18', // Chinese New Year
  '2026-03-20', // Hari Raya Puasa
  '2026-04-03', // Good Friday
  '2026-05-01', // Labour Day
  '2026-05-27', // Hari Raya Haji
  '2026-06-01', // Vesak Day (observed, falls Sun 31 May)
  '2026-08-10', // National Day (observed, falls Sun 9 Aug)
  '2026-11-09', // Deepavali (observed, falls Sun 8 Nov)
  '2026-12-25', // Christmas Day
  // 2027 — fixed-date only, verify and complete in Dec 2026
  '2027-01-01', // New Year's Day
  '2027-03-26', // Good Friday
  '2027-05-01', // Labour Day
  '2027-08-09', // National Day
  '2027-12-25'  // Christmas Day
]);

function _isoDate(d){
  return d.getFullYear() + '-'
    + String(d.getMonth() + 1).padStart(2, '0') + '-'
    + String(d.getDate()).padStart(2, '0');
}

/* Last working day of a month. month is 1-12. Starts at the last calendar
   day and walks backwards past Saturdays, Sundays and SG public holidays. */
function getPayday(year, month){
  const d = new Date(year, month, 0); // day 0 of next month = last day of this month
  while (true) {
    const dow = d.getDay(); // 0=Sun, 6=Sat
    if (dow !== 0 && dow !== 6 && !SG_HOLIDAYS.has(_isoDate(d))) break;
    d.setDate(d.getDate() - 1);
  }
  return _isoDate(d);
}

/* ─── CPF contribution engine (2026) ───────────────────────────────────
   Rates are CPF Board figures. OW (Ordinary Wage) monthly ceiling S$8,000.
   Senior bands (55+) reflect the scheduled increases; verify before relying.
   Auto-CPF allocation is only generated for ages <=55 (SA still open). */
const CPF_OW_CEILING_2026 = 8000;

/* Singapore resident income-tax brackets (YA2025 = same as YA2024+).
   Each band: { from, to, rate (%), base (cumulative tax at `from`) }.
   Source: IRAS. Verified cumulative bases at band boundaries. */
const SG_TAX_BRACKETS = [
  { from:       0, to:    20000, rate:  0,   base:      0 },
  { from:   20000, to:    30000, rate:  2,   base:      0 },
  { from:   30000, to:    40000, rate:  3.5, base:    200 },
  { from:   40000, to:    80000, rate:  7,   base:    550 },
  { from:   80000, to:   120000, rate: 11.5, base:   3350 },
  { from:  120000, to:   160000, rate: 15,   base:   7950 },
  { from:  160000, to:   200000, rate: 18,   base:  13950 },
  { from:  200000, to:   240000, rate: 19,   base:  21150 },
  { from:  240000, to:   280000, rate: 19.5, base:  28750 },
  { from:  280000, to:   320000, rate: 20,   base:  36550 },
  { from:  320000, to:   500000, rate: 22,   base:  44550 },
  { from:  500000, to:  1000000, rate: 23,   base:  84150 },
  { from: 1000000, to: Infinity, rate: 24,   base: 199150 }
];

function cpfContribRatesForAge(age){
  if (age == null || age <= 55) return { employer:17.0, employee:20.0 };
  if (age <= 60) return { employer:15.5, employee:17.0 };
  if (age <= 65) return { employer:12.0, employee:11.5 };
  if (age <= 70) return { employer:9.0,  employee:7.5 };
  return { employer:7.5, employee:5.0 };
}

/* OA/SA/MA as % of wage, under 55 (2026 allocation). Returns null for 55+
   so callers know to skip auto-CPF rather than guess the OA/MA/RA split. */
function cpfAllocationForAge(age){
  if (age == null || age <= 35) return { OA:23.0, SA:6.0,  MA:8.0  };
  if (age <= 45)                return { OA:21.0, SA:7.0,  MA:9.0  };
  if (age <= 50)                return { OA:19.0, SA:8.0,  MA:10.0 };
  if (age <= 55)                return { OA:15.0, SA:11.5, MA:10.5 };
  return null; // 55+ not automated
}

const _round2 = n => Math.round((Number(n) || 0) * 100) / 100;

/* Pure CPF calc. Given gross monthly SGD and age, returns the split.
   alloc is null (and byAccount empty) for ages above 55. */
function computeCpfContribution(grossMonthly, age){
  const gross = Number(grossMonthly) || 0;
  const wage  = Math.min(gross, CPF_OW_CEILING_2026);
  const rates = cpfContribRatesForAge(age);
  const employerCPF = _round2(rates.employer / 100 * wage);
  const employeeCPF = _round2(rates.employee / 100 * wage);
  const total       = _round2(employerCPF + employeeCPF);
  const net         = _round2(gross - employeeCPF);

  const alloc = cpfAllocationForAge(age);
  let byAccount = {};
  if (alloc){
    byAccount = { OA: _round2(alloc.OA/100*wage), SA: _round2(alloc.SA/100*wage), MA: _round2(alloc.MA/100*wage) };
    // Absorb rounding remainder into OA so the split equals total.
    const splitSum = _round2(byAccount.OA + byAccount.SA + byAccount.MA);
    byAccount.OA = _round2(byAccount.OA + (total - splitSum));
  }
  return { wage, employerCPF, employeeCPF, total, net, byAccount, allocated: !!alloc };
}

/* Inclusive list of 'YYYY-MM' between two 'YYYY-MM' bounds. */
function _monthsBetween(startYM, endYM){
  const out = [];
  let [y, m] = startYM.split('-').map(Number);
  const [ey, em] = endYM.split('-').map(Number);
  while (y < ey || (y === ey && m <= em)){
    out.push(y + '-' + String(m).padStart(2, '0'));
    m++; if (m > 12){ m = 1; y++; }
  }
  return out;
}

/* ─── Input sanitisation ────────────────────────────────────────────────
   Numbers: coerced to finite float; non-finite or out-of-range returns null
   (or opts.fallback). opts: { fallback, min, max }. */
function kjrSafeNumber(n, opts){
  opts = opts || {};
  if (n === '' || n == null) return opts.fallback != null ? opts.fallback : null;
  const v = Number(n);
  if (!isFinite(v)) return opts.fallback != null ? opts.fallback : null;
  if (opts.min != null && v < opts.min) return opts.fallback != null ? opts.fallback : null;
  if (opts.max != null && v > opts.max) return opts.fallback != null ? opts.fallback : null;
  return v;
}

/* ─── Money helpers (#Crit-2) ───────────────────────────────────────────
   roundMoney: general dp-aware rounding (dp=2 for SGD/USD, 4 for share
   prices, 8 for crypto). Treats NaN/null as 0 (same convention as _round2).
   safeRatio: percentage / ratio with a zero-denominator guard. Returns null
   when denom is zero, negative, or non-finite — so display code shows '—'. */
function roundMoney(v, dp){
  const scale = Math.pow(10, dp != null ? dp : 2);
  return Math.round((Number(v) || 0) * scale) / scale;
}

function safeRatio(num, denom, scale){
  const d = Number(denom);
  if (!d || d <= 0 || !isFinite(d)) return null;
  const n = Number(num);
  if (!isFinite(n)) return null;
  return n / d * (scale != null ? scale : 100);
}

/* ─── Stock P&L — average-cost method ──────────────────────────────────
   Pure version of deriveStockPosition. Takes the opening position and a
   pre-sorted (chronological) array of trade objects directly, so it can be
   tested without a DB reference.
     openingShares   manual shares field on the stock record
     openingAvgCost  manual avg-cost field on the stock record
     sortedTxns      array of { side, shares, price, fees } in date order
   Values are in the stock's own currency (price and fees in that currency).
   roundMoney(dp=2) is applied at each accumulation step to prevent float
   drift across long trade histories. */
function computeStockPosition(openingShares, openingAvgCost, sortedTxns){
  let shares    = Number(openingShares)  || 0;
  let costBasis = roundMoney(shares * (Number(openingAvgCost) || 0));
  let realisedPL = 0;
  for (const t of sortedTxns){
    const qty  = Math.abs(Number(t.shares) || 0);
    const px   = Number(t.price) || 0;
    const fees = Number(t.fees)  || 0;
    if (t.side === 'sell'){
      const avg        = shares > 0 ? costBasis / shares : 0;
      const sellQty    = Math.min(qty, shares);
      const costRemoved = roundMoney(avg * sellQty);
      realisedPL = roundMoney(realisedPL + (px * sellQty - fees) - costRemoved);
      costBasis  = roundMoney(costBasis - costRemoved);
      shares    -= sellQty;
    } else {
      costBasis = roundMoney(costBasis + px * qty + fees);
      shares   += qty;
    }
  }
  const avgCost = shares > 0 ? costBasis / shares : 0;
  return { shares, avgCost, costBasis, realisedPL, txnCount: sortedTxns.length };
}

/* node/test shim — harmless in the browser (no `module` global there). */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    looksPopulated, seedDecision,
    SG_HOLIDAYS, _isoDate, getPayday,
    CPF_OW_CEILING_2026, SG_TAX_BRACKETS,
    cpfContribRatesForAge, cpfAllocationForAge,
    _round2, computeCpfContribution,
    _monthsBetween,
    kjrSafeNumber,
    roundMoney, safeRatio,
    computeStockPosition
  };
}
