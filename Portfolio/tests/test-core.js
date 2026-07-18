const assert = require('assert');
const core = require('../Worker/kjr-core.js');

function runTests() {
  let passed = 0;
  let failed = 0;

  function test(name, fn) {
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

  console.log('--- Testing kjr-core.js ---');

  // 1. Testing roundMoney
  test('roundMoney - typical', () => {
    assert.strictEqual(core.roundMoney(123.456), 123.46);
    assert.strictEqual(core.roundMoney(123.454), 123.45);
    assert.strictEqual(core.roundMoney(-123.456), -123.46);
    assert.strictEqual(core.roundMoney('123.456'), 123.46); // string conversion
  });

  test('roundMoney - edge cases', () => {
    assert.strictEqual(core.roundMoney(null), 0);
    assert.strictEqual(core.roundMoney(undefined), 0);
    assert.strictEqual(core.roundMoney(NaN), 0);
    assert.strictEqual(core.roundMoney('', 2), 0);
  });

  // 2. Testing safeRatio
  test('safeRatio - typical', () => {
    assert.strictEqual(core.safeRatio(50, 100), 50); // 50%
    assert.strictEqual(core.safeRatio(1, 4), 25);    // 25%
    assert.strictEqual(core.safeRatio(1, 4, 1), 0.25); // custom scale
  });

  test('safeRatio - edge cases', () => {
    assert.strictEqual(core.safeRatio(50, 0), null);
    assert.strictEqual(core.safeRatio(50, -10), null); // negative denom returns null per design
    assert.strictEqual(core.safeRatio(NaN, 10), null);
    assert.strictEqual(core.safeRatio(10, NaN), null);
    assert.strictEqual(core.safeRatio(null, null), null);
  });

  // 3. Testing computeStockPosition
  test('computeStockPosition - empty', () => {
    const pos = core.computeStockPosition(0, 0, []);
    assert.deepStrictEqual(pos, { shares: 0, avgCost: 0, costBasis: 0, realisedPL: 0, txnCount: 0, oversold: 0 });
  });

  test('computeStockPosition - oversell flags the excess', () => {
    const txns = [
      { side: 'buy',  shares: 5,  price: 100, fees: 0 },
      { side: 'sell', shares: 10, price: 150, fees: 0 }  // sells 5 more than held
    ];
    const pos = core.computeStockPosition(0, 0, txns);
    assert.strictEqual(pos.shares, 0);      // capped, never negative
    assert.strictEqual(pos.oversold, 5);    // the 5-share excess is surfaced
  });

  test('computeStockPosition - buys only', () => {
    const txns = [
      { side: 'buy', shares: 10, price: 100, fees: 5 },
      { side: 'buy', shares: 5, price: 120, fees: 2 }
    ];
    // 10 * 100 + 5 = 1005
    // 5 * 120 + 2 = 602
    // total cost basis = 1607, shares = 15, avgCost = 1607 / 15 = 107.1333...
    const pos = core.computeStockPosition(0, 0, txns);
    assert.strictEqual(pos.shares, 15);
    assert.strictEqual(pos.costBasis, 1607);
    assert.strictEqual(pos.realisedPL, 0);
    assert.strictEqual(Math.abs(pos.avgCost - 107.1333) < 0.001, true);
  });

  test('computeStockPosition - buy and partial sell', () => {
    const txns = [
      { side: 'buy', shares: 10, price: 100, fees: 5 }, // avgCost = 100.5
      { side: 'sell', shares: 5, price: 150, fees: 10 }
    ];
    // sell 5 shares at 150 = 750
    // fees = 10, net proceeds = 740
    // cost removed = 5 * 100.5 = 502.5
    // realised P&L = 740 - 502.5 = 237.5
    // remaining shares = 5, remaining costBasis = 1005 - 502.5 = 502.5
    const pos = core.computeStockPosition(0, 0, txns);
    assert.strictEqual(pos.shares, 5);
    assert.strictEqual(pos.costBasis, 502.5);
    assert.strictEqual(pos.realisedPL, 237.5);
    assert.strictEqual(pos.avgCost, 100.5);
  });

  // 4. Testing computeCpfContribution (Age <= 55, <= 8000 OW ceiling)
  test('computeCpfContribution - typical (< 55 age, < 8000 ceiling)', () => {
    const res = core.computeCpfContribution(5000, 30);
    // rates: employer 17%, employee 20%
    // wage = 5000
    // employer = 850
    // employee = 1000
    // total = 1850
    // net = 4000
    // alloc: OA 23%, SA 6%, MA 8%
    assert.strictEqual(res.wage, 5000);
    assert.strictEqual(res.employerCPF, 850);
    assert.strictEqual(res.employeeCPF, 1000);
    assert.strictEqual(res.total, 1850);
    assert.strictEqual(res.net, 4000);
    assert.strictEqual(res.byAccount.OA, 1150); // 23% of 5000
    assert.strictEqual(res.byAccount.SA, 300);  // 6% of 5000
    assert.strictEqual(res.byAccount.MA, 400);  // 8% of 5000
  });

  test('computeCpfContribution - above ceiling (8000)', () => {
    const res = core.computeCpfContribution(10000, 30);
    // capped at 8000
    // employer = 17% of 8000 = 1360
    // employee = 20% of 8000 = 1600
    // total = 2960
    // net = 10000 - 1600 = 8400
    assert.strictEqual(res.wage, 8000);
    assert.strictEqual(res.employerCPF, 1360);
    assert.strictEqual(res.employeeCPF, 1600);
    assert.strictEqual(res.net, 8400);
  });

  test('computeCpfContribution - age 60 (2026 rates)', () => {
    const res = core.computeCpfContribution(5000, 60);
    // age 55<60 band, 2026: employer 16%, employee 18%
    assert.strictEqual(res.employerCPF, 800); // 5000 * 16%
    assert.strictEqual(res.employeeCPF, 900); // 5000 * 18%
    assert.strictEqual(res.allocated, false);
  });

  test('computeCpfContribution - age 62 (2026 rates)', () => {
    const res = core.computeCpfContribution(5000, 62);
    // age 60<65 band, 2026: employer 12.5%, employee 12.5%
    assert.strictEqual(res.employerCPF, 625); // 5000 * 12.5%
    assert.strictEqual(res.employeeCPF, 625); // 5000 * 12.5%
    assert.strictEqual(res.allocated, false);
  });

  // 4b. Direct boundary tests for the CPF age seams via the exported pure
  // rate/allocation lookups, locking in each `<=` cutoff exactly at the
  // boundary age and the first age past it (35/45/50/55/60/65/70).
  test('cpfContribRatesForAge - boundary ages 55/56, 60/61, 65/66, 70/71', () => {
    assert.deepStrictEqual(core.cpfContribRatesForAge(55), { employer:17.0, employee:20.0 }); // <=55 band
    assert.deepStrictEqual(core.cpfContribRatesForAge(56), { employer:16.0, employee:18.0 }); // 55<age<=60
    assert.deepStrictEqual(core.cpfContribRatesForAge(60), { employer:16.0, employee:18.0 }); // <=60 band
    assert.deepStrictEqual(core.cpfContribRatesForAge(61), { employer:12.5, employee:12.5 }); // 60<age<=65
    assert.deepStrictEqual(core.cpfContribRatesForAge(65), { employer:12.5, employee:12.5 }); // <=65 band
    assert.deepStrictEqual(core.cpfContribRatesForAge(66), { employer:9.0,  employee:7.5  }); // 65<age<=70
    assert.deepStrictEqual(core.cpfContribRatesForAge(70), { employer:9.0,  employee:7.5  }); // <=70 band
    assert.deepStrictEqual(core.cpfContribRatesForAge(71), { employer:7.5,  employee:5.0  }); // >70 band
  });

  test('cpfContribRatesForAge - null/undefined age treated as <=55 band', () => {
    assert.deepStrictEqual(core.cpfContribRatesForAge(null), { employer:17.0, employee:20.0 });
    assert.deepStrictEqual(core.cpfContribRatesForAge(undefined), { employer:17.0, employee:20.0 });
  });

  test('cpfAllocationForAge - boundary ages 35/36, 45/46, 50/51, 55/56', () => {
    assert.deepStrictEqual(core.cpfAllocationForAge(35), { OA:23.0, SA:6.0,  MA:8.0  }); // <=35 band
    assert.deepStrictEqual(core.cpfAllocationForAge(36), { OA:21.0, SA:7.0,  MA:9.0  }); // 35<age<=45
    assert.deepStrictEqual(core.cpfAllocationForAge(45), { OA:21.0, SA:7.0,  MA:9.0  }); // <=45 band
    assert.deepStrictEqual(core.cpfAllocationForAge(46), { OA:19.0, SA:8.0,  MA:10.0 }); // 45<age<=50
    assert.deepStrictEqual(core.cpfAllocationForAge(50), { OA:19.0, SA:8.0,  MA:10.0 }); // <=50 band
    assert.deepStrictEqual(core.cpfAllocationForAge(51), { OA:15.0, SA:11.5, MA:10.5 }); // 50<age<=55
    assert.deepStrictEqual(core.cpfAllocationForAge(55), { OA:15.0, SA:11.5, MA:10.5 }); // <=55 band
    assert.strictEqual(core.cpfAllocationForAge(56), null); // >55, not automated
  });

  test('cpfAllocationForAge - null age treated as <=35 band, no allocation past 55', () => {
    assert.deepStrictEqual(core.cpfAllocationForAge(null), { OA:23.0, SA:6.0, MA:8.0 });
    assert.strictEqual(core.cpfAllocationForAge(60), null);
  });

  // 5. Testing incomeNet
  test('incomeNet - uses typed net when present', () => {
    assert.strictEqual(core.incomeNet({ net: 6400, gross: 8000, employeeCPF: 1600 }), 6400);
  });

  test('incomeNet - zero net is kept, not treated as blank', () => {
    assert.strictEqual(core.incomeNet({ net: 0, gross: 8000, employeeCPF: 1600 }), 0);
  });

  test('incomeNet - blank net falls back to gross minus employee CPF', () => {
    assert.strictEqual(core.incomeNet({ net: null, gross: 8000, employeeCPF: 1600 }), 6400);
    assert.strictEqual(core.incomeNet({ gross: 8000, employeeCPF: 1600 }), 6400);
    assert.strictEqual(core.incomeNet({ net: '', gross: 8000, employeeCPF: 1600 }), 6400);
  });

  test('incomeNet - blank net and no employeeCPF falls back to gross', () => {
    assert.strictEqual(core.incomeNet({ gross: 8000 }), 8000);
  });

  test('incomeNet - fully empty entry returns 0', () => {
    assert.strictEqual(core.incomeNet({}), 0);
  });

  // 6. Testing OVERSOLD_EPSILON (D2: single constant, both call sites consume it)
  test('OVERSOLD_EPSILON - exported and sane', () => {
    assert.strictEqual(core.OVERSOLD_EPSILON, 1e-6);
    assert.strictEqual(core.OVERSOLD_EPSILON > 0, true);
  });

  // 7. Testing kjrValidDate (D3: shape regex + real calendar round-trip)
  test('kjrValidDate - rejects calendar-impossible dates', () => {
    assert.strictEqual(core.kjrValidDate('2026-02-30'), false); // Feb has 28/29 days
    assert.strictEqual(core.kjrValidDate('2026-13-01'), false); // month 13
    assert.strictEqual(core.kjrValidDate('2023-02-29'), false); // 2023 not a leap year
  });

  test('kjrValidDate - accepts valid calendar dates', () => {
    assert.strictEqual(core.kjrValidDate('2024-02-29'), true);  // 2024 is a leap year
    assert.strictEqual(core.kjrValidDate('2026-01-01'), true);
    assert.strictEqual(core.kjrValidDate('2026-12-31'), true);
  });

  test('kjrValidDate - rejects malformed shapes and non-strings', () => {
    assert.strictEqual(core.kjrValidDate(''), false);
    assert.strictEqual(core.kjrValidDate('2026-1-1'), false);   // not zero-padded
    assert.strictEqual(core.kjrValidDate('not-a-date'), false);
    assert.strictEqual(core.kjrValidDate(null), false);
    assert.strictEqual(core.kjrValidDate(undefined), false);
  });

  // 8. Testing seedDecision (D5: full matrix for the #Crit-1 guard)
  test('seedDecision - ok when remote schema matches expected', () => {
    assert.strictEqual(core.seedDecision({ schema: 5, stocks: [] }, {}, 5), 'ok');
    assert.strictEqual(core.seedDecision({ schema: 5, stocks: [{ id: 1 }] }, {}, 5), 'ok');
  });

  test('seedDecision - refuse when remote is populated under a wrong schema', () => {
    assert.strictEqual(core.seedDecision({ schema: 4, stocks: [{ id: 1 }] }, {}, 5), 'refuse');
    assert.strictEqual(core.seedDecision({ schema: 4, expenses: [{ id: 1 }] }, { allowSeed: true }, 5), 'refuse'); // populated wins even with allowSeed
  });

  test('seedDecision - seed when remote is empty and allowSeed is set', () => {
    assert.strictEqual(core.seedDecision({ schema: 4, stocks: [] }, { allowSeed: true }, 5), 'seed');
    assert.strictEqual(core.seedDecision(null, { allowSeed: true }, 5), 'seed'); // no remote at all, still safe to seed
  });

  test('seedDecision - push-first when remote is empty without allowSeed', () => {
    assert.strictEqual(core.seedDecision({ schema: 4, stocks: [] }, {}, 5), 'push-first');
    assert.strictEqual(core.seedDecision(null, {}, 5), 'push-first');
    assert.strictEqual(core.seedDecision(null, undefined, 5), 'push-first');
  });

  test('looksPopulated - true when any tracked table has rows', () => {
    assert.strictEqual(core.looksPopulated({ stocks: [{ id: 1 }] }), true);
    assert.strictEqual(core.looksPopulated({ expenses: [{ id: 1 }] }), true);
    assert.strictEqual(core.looksPopulated({ cpfHistory: [{ id: 1 }] }), true);
  });

  test('looksPopulated - false for empty, malformed or snapshot-only data', () => {
    assert.strictEqual(core.looksPopulated({ stocks: [] }), false);
    assert.strictEqual(core.looksPopulated({}), false);
    assert.strictEqual(core.looksPopulated(null), false);
    assert.strictEqual(core.looksPopulated({ snapshots: [{ id: 1 }], trash: [{ id: 1 }] }), false); // excluded tables
  });

  // 9. Testing getPayday (D5: SG public holiday walk-back, 2026)
  test('getPayday - walks back over a weekend and Chinese New Year (Jan 2026)', () => {
    // 2026-01-31 is a Saturday; 2026-01-30 (Fri) is the last working day.
    assert.strictEqual(core.getPayday(2026, 1), '2026-01-30');
  });

  test('getPayday - walks back over a weekend (Feb 2026)', () => {
    // 2026-02-28 is a Saturday; 2026-02-27 (Fri) is the last working day.
    assert.strictEqual(core.getPayday(2026, 2), '2026-02-27');
  });

  test('getPayday - walks back over Vesak Day observed + weekend (May 2026)', () => {
    // 2026-05-31 is a Sunday, 2026-05-30 (Sat) is a weekend too, 2026-05-29 (Fri) is the last working day.
    assert.strictEqual(core.getPayday(2026, 5), '2026-05-29');
  });

  test('getPayday - plain month needs no walk-back (Mar 2026)', () => {
    // 2026-03-31 is a Tuesday, not a holiday, so it is its own payday.
    assert.strictEqual(core.getPayday(2026, 3), '2026-03-31');
  });

  // 10. Testing computeSgIncomeTax (D5: moved from app.js, IRAS worked examples)
  test('computeSgIncomeTax - IRAS worked examples at known chargeable-income points', () => {
    assert.strictEqual(core.computeSgIncomeTax(40000), 550);
    assert.strictEqual(core.computeSgIncomeTax(80000), 3350);
    assert.strictEqual(core.computeSgIncomeTax(120000), 7950);
  });

  test('computeSgIncomeTax - edge cases', () => {
    assert.strictEqual(core.computeSgIncomeTax(0), 0);
    assert.strictEqual(core.computeSgIncomeTax(-100), 0); // negative clamps to 0
    assert.strictEqual(core.computeSgIncomeTax(20000), 0); // first band is 0%, at the boundary
  });

  // 11. Testing parseCSV (D5: RFC 4180 quoting edge cases)
  test('parseCSV - quoted field with an embedded comma', () => {
    const rows = core.parseCSV('a,"b,c",d\n');
    assert.deepStrictEqual(rows, [['a', 'b,c', 'd']]);
  });

  test('parseCSV - doubled-quote escape inside a quoted field', () => {
    const rows = core.parseCSV('a,"he said ""hi""",c\n');
    assert.deepStrictEqual(rows, [['a', 'he said "hi"', 'c']]);
  });

  test('parseCSV - CRLF line endings', () => {
    const rows = core.parseCSV('a,b,c\r\nd,e,f\r\n');
    assert.deepStrictEqual(rows, [['a', 'b', 'c'], ['d', 'e', 'f']]);
  });

  test('parseCSV - mixed quoting, embedded comma and CRLF together', () => {
    const rows = core.parseCSV('sym,note\r\nAAPL,"Q3 ""beat"", raised guidance"\r\nD05,plain\r\n');
    assert.deepStrictEqual(rows, [
      ['sym', 'note'],
      ['AAPL', 'Q3 "beat", raised guidance'],
      ['D05', 'plain']
    ]);
  });

  test('parseCSV - legitimate embedded newline inside a properly-closed quote is preserved, not flagged malformed', () => {
    const rows = core.parseCSV('sym,note\na,"line one\nline two",b\n');
    assert.deepStrictEqual(rows, [['sym', 'note'], ['a', 'line one\nline two', 'b']]);
    assert.strictEqual(rows.malformed, undefined);
  });

  test('parseCSV - unterminated quote at end of input is detected and closes the field', () => {
    // The quote on the last cell is never closed. Before the fix this silently
    // swallowed the rest of the (in this case, nonexistent) file into one cell.
    const rows = core.parseCSV('a,b,"unterminated\nstill-in-the-quote');
    // Still returns a plain array (backward compatible with existing app.js callers)...
    assert.strictEqual(Array.isArray(rows), true);
    assert.deepStrictEqual(rows, [['a', 'b', 'unterminated\nstill-in-the-quote']]);
    // ...but the caller can now detect the file was malformed via the marker.
    assert.strictEqual(rows.malformed, true);
  });

  test('parseCSV - unterminated quote marker is non-enumerable (invisible to JSON/iteration)', () => {
    const rows = core.parseCSV('a,"b\n');
    assert.strictEqual(rows.malformed, true);
    assert.strictEqual(JSON.stringify(rows), '[["a","b\\n"]]'); // marker never serialises
    assert.deepStrictEqual(Object.keys(rows), ['0']); // marker never shows up via for..in/Object.keys
  });

  test('parseCSV - well-formed input never sets the malformed marker', () => {
    const rows = core.parseCSV('a,b,c\n');
    assert.strictEqual(rows.malformed, undefined);
  });

  test('parseCSV - all-empty-cells rows are dropped, a row with any content is kept', () => {
    const rows = core.parseCSV('a,b,c\n,,\nd,e,f\n\n');
    assert.deepStrictEqual(rows, [['a', 'b', 'c'], ['d', 'e', 'f']]);
  });

  test('parseCSV - a row with at least one non-empty cell is kept even if others are blank', () => {
    const rows = core.parseCSV('a,,c\n,,\n');
    assert.deepStrictEqual(rows, [['a', '', 'c']]);
  });

  test('ibkrExtractTrades - surfaces truncated:true when fed a malformed parseCSV result', () => {
    const rows = core.parseCSV('Trades,Header,DataDiscriminator,Asset Category,Symbol,Currency,Date/Time,Quantity,T. Price,Comm/Fee\nTrades,Data,"Order,Stocks,AAPL,USD,2024-01-15');
    const { trades, skipped, truncated } = core.ibkrExtractTrades(rows);
    assert.strictEqual(truncated, true);
    assert.strictEqual(Array.isArray(trades), true);
    assert.strictEqual(typeof skipped, 'number');
  });

  test('ibkrExtractTrades - truncated is false on well-formed input', () => {
    const rows = core.parseCSV('Trades,Header,DataDiscriminator,Asset Category,Symbol,Currency,Date/Time,Quantity,T. Price,Comm/Fee\n');
    const { truncated } = core.ibkrExtractTrades(rows);
    assert.strictEqual(truncated, false);
  });

  // 12. Testing CONSTANTS_VERIFIED_FOR (D6: ageing signal)
  test('CONSTANTS_VERIFIED_FOR - exported and matches the reviewed year', () => {
    assert.strictEqual(core.CONSTANTS_VERIFIED_FOR, 2026);
  });

  // 13. Testing kjrProjectLiquid (Phase 6: FIRE liquid-assets projection)
  test('kjrProjectLiquid - hand-computable crossover (0% real return)', () => {
    // 100k now, +1k/mo, 0% real return -> pure linear growth, hits 112k at month 12
    const r = core.kjrProjectLiquid({ liquidNow:100000, monthlySavings:1000, annualReturnPct:0, annualInflationPct:0, months:24, fireNumber:112000 });
    assert.strictEqual(r.series.length, 25);
    assert.strictEqual(r.series[0], 100000);
    assert.strictEqual(r.series[12], 112000);
    assert.strictEqual(r.crossoverMonth, 12);
  });

  test('kjrProjectLiquid - zero savings still projects (flat, no crossover if below target)', () => {
    const r = core.kjrProjectLiquid({ liquidNow:50000, monthlySavings:0, annualReturnPct:0, annualInflationPct:0, months:12, fireNumber:100000 });
    assert.strictEqual(r.series[12], 50000);
    assert.strictEqual(r.crossoverMonth, null);
  });

  test('kjrProjectLiquid - negative savings projects honestly (declining line)', () => {
    const r = core.kjrProjectLiquid({ liquidNow:50000, monthlySavings:-500, annualReturnPct:0, annualInflationPct:0, months:12, fireNumber:100000 });
    assert.strictEqual(r.series[12], 44000);
    assert.strictEqual(r.crossoverMonth, null); // declining, never reaches target
  });

  test('kjrProjectLiquid - fireNumber <= 0 disables crossover entirely', () => {
    const r0 = core.kjrProjectLiquid({ liquidNow:100000, monthlySavings:1000, annualReturnPct:5, annualInflationPct:2, months:12, fireNumber:0 });
    assert.strictEqual(r0.crossoverMonth, null);
    const rNeg = core.kjrProjectLiquid({ liquidNow:100000, monthlySavings:1000, annualReturnPct:5, annualInflationPct:2, months:12, fireNumber:-5 });
    assert.strictEqual(rNeg.crossoverMonth, null);
  });

  test('kjrProjectLiquid - real-rate sanity: return == inflation grows only from savings', () => {
    // 5% nominal return, 5% inflation -> 0% real, so growth is savings only, no compounding
    const r = core.kjrProjectLiquid({ liquidNow:10000, monthlySavings:100, annualReturnPct:5, annualInflationPct:5, months:3, fireNumber:0 });
    assert.deepStrictEqual(r.series, [10000, 10100, 10200, 10300]);
  });

  test('kjrProjectLiquid - non-finite inputs treated as 0, months capped at 1200', () => {
    const r = core.kjrProjectLiquid({ liquidNow:NaN, monthlySavings:undefined, annualReturnPct:6, annualInflationPct:3, months:5000, fireNumber:null });
    assert.strictEqual(r.series.length, 1201);
    assert.strictEqual(r.series[0], 0);
    assert.strictEqual(r.crossoverMonth, null);
  });

  // 14. Testing kjrProjectCpf (Phase 6: CPF nominal-SGD projection)
  test('kjrProjectCpf - balances grow from interest and contributions', () => {
    const c = core.kjrProjectCpf({
      balances: { OA:20000, SA:10000, MA:10000 }, grossMonthly:5000, currentAge:50, months:120,
      rates: { OA:2.5, SA:4.08, MA:4.08, RA:4.08, extraFirst60k:1, extraFirst30kAge55:1 }
    });
    assert.strictEqual(c.series.length, 121);
    assert.strictEqual(c.series[0], 40000);
    assert.strictEqual(c.series[120] > c.series[0], true);
    assert.strictEqual(c.series[60], 170712.91);
  });

  test('kjrProjectCpf - contributions stop once age exceeds 55, interest keeps accruing', () => {
    // currentAge 50, zero interest so growth is contributions only: age hits 56
    // (cpfAllocationForAge stops allocating above 55) at month 73 = (56-50)*12+1.
    const c = core.kjrProjectCpf({
      balances: { OA:0, SA:0, MA:0 }, grossMonthly:5000, currentAge:50, months:90,
      rates: { OA:0, SA:0, MA:0, RA:0, extraFirst60k:0, extraFirst30kAge55:0 }
    });
    assert.strictEqual(c.series[71] - c.series[70], 1850); // still contributing at age 55
    assert.strictEqual(c.series[73] - c.series[72], 0);    // age 56, contributions stopped
    assert.strictEqual(c.series[90] - c.series[73], 0);    // stays flat with zero interest
  });

  test('kjrProjectCpf - zero grossMonthly means interest-only growth, series length matches months', () => {
    const c = core.kjrProjectCpf({
      balances: { OA:10000, SA:5000, MA:5000 }, grossMonthly:0, currentAge:40, months:24,
      rates: { OA:2.5, SA:4.08, MA:4.08, RA:4.08, extraFirst60k:1, extraFirst30kAge55:1 }
    });
    assert.strictEqual(c.series.length, 25);
    assert.strictEqual(c.series[0], 20000);
    assert.strictEqual(c.series[24] > c.series[0], true); // interest still accrued
  });

  // 15. Testing kjrSafeNumber
  test('kjrSafeNumber - junk string falls back to null (or opts.fallback)', () => {
    assert.strictEqual(core.kjrSafeNumber('abc'), null);
    assert.strictEqual(core.kjrSafeNumber('abc', { fallback: 0 }), 0);
  });

  test("kjrSafeNumber - '' vs null vs undefined all treated as blank", () => {
    assert.strictEqual(core.kjrSafeNumber(''), null);
    assert.strictEqual(core.kjrSafeNumber('', { fallback: -1 }), -1);
    assert.strictEqual(core.kjrSafeNumber(null), null);
    assert.strictEqual(core.kjrSafeNumber(undefined), null);
  });

  test('kjrSafeNumber - zero is a real value, not treated as blank', () => {
    assert.strictEqual(core.kjrSafeNumber(0, { fallback: 99 }), 0);
  });

  test('kjrSafeNumber - min/max reject (not clamp) out-of-range values in both directions', () => {
    assert.strictEqual(core.kjrSafeNumber(5, { min: 10 }), null);           // below min
    assert.strictEqual(core.kjrSafeNumber(5, { min: 10, fallback: 10 }), 10);
    assert.strictEqual(core.kjrSafeNumber(25, { max: 20 }), null);          // above max
    assert.strictEqual(core.kjrSafeNumber(15, { min: 10, max: 20 }), 15);   // inside range, passes through
  });

  test('kjrSafeNumber - NaN and Infinity are non-finite, fall back to null (or opts.fallback)', () => {
    assert.strictEqual(core.kjrSafeNumber(NaN), null);
    assert.strictEqual(core.kjrSafeNumber(Infinity), null);
    assert.strictEqual(core.kjrSafeNumber(-Infinity, { fallback: 0 }), 0);
  });

  // 16. Testing rangePosition
  test('rangePosition - price at low/high/mid of the band', () => {
    assert.strictEqual(core.rangePosition(50, 50, 100), 0);
    assert.strictEqual(core.rangePosition(100, 50, 100), 1);
    assert.strictEqual(core.rangePosition(75, 50, 100), 0.5);
  });

  test('rangePosition - price outside the band clamps into 0..1', () => {
    assert.strictEqual(core.rangePosition(40, 50, 100), 0);   // below low
    assert.strictEqual(core.rangePosition(120, 50, 100), 1);  // above high
  });

  test('rangePosition - zero-width band (low === high) is null, never divide-by-zero', () => {
    assert.strictEqual(core.rangePosition(50, 50, 50), null);
  });

  test('rangePosition - missing/null inputs return null', () => {
    assert.strictEqual(core.rangePosition(null, 50, 100), null);
    assert.strictEqual(core.rangePosition(75, null, 100), null);
    assert.strictEqual(core.rangePosition(75, 50, null), null);
  });

  // 17. Testing vsBaseline
  test('vsBaseline - above/below/equal baseline', () => {
    assert.strictEqual(core.vsBaseline(120, 100), 0.2);
    assert.strictEqual(core.vsBaseline(80, 100), -0.2);
    assert.strictEqual(core.vsBaseline(100, 100), 0);
  });

  test('vsBaseline - zero or negative baseline is null (no divide-by-zero, no sign-flip trap)', () => {
    assert.strictEqual(core.vsBaseline(100, 0), null);
    assert.strictEqual(core.vsBaseline(100, -50), null);
  });

  // 18. Testing sectorClass + SECTOR_CLASS
  test('sectorClass - one known sector from each bucket', () => {
    assert.strictEqual(core.sectorClass('Financials'), 'cyclical');
    assert.strictEqual(core.sectorClass('Consumer Staples'), 'defensive');
    assert.strictEqual(core.sectorClass('Information Technology'), 'sensitive');
  });

  test('sectorClass - unknown sector, null, and empty string all return null', () => {
    assert.strictEqual(core.sectorClass('Unknown Sector'), null);
    assert.strictEqual(core.sectorClass(null), null);
    assert.strictEqual(core.sectorClass(''), null);
  });

  // 19. Testing ibkrNum
  test('ibkrNum - plain numbers, thousands commas, negatives', () => {
    assert.strictEqual(core.ibkrNum(1234.56), 1234.56);
    assert.strictEqual(core.ibkrNum('1,234.56'), 1234.56);
    assert.strictEqual(core.ibkrNum('-500.25'), -500.25);
  });

  test('ibkrNum - junk and empty return null', () => {
    assert.strictEqual(core.ibkrNum('abc'), null);
    assert.strictEqual(core.ibkrNum(''), null);
    assert.strictEqual(core.ibkrNum(null), null);
    assert.strictEqual(core.ibkrNum(undefined), null);
  });

  // 20. Testing ibkrExtractTrades behaviour paths on a mixed fixture
  test('ibkrExtractTrades - ClosedLot rows and non-Stocks asset classes filtered, buy/sell sign inferred, skipped count correct', () => {
    const csv = 'Trades,Header,DataDiscriminator,Asset Category,Symbol,Currency,Date/Time,Quantity,T. Price,Comm/Fee\n' +
      'Trades,Data,Order,Stocks,AAPL,USD,2024-01-15,10,150.25,-1.5\n' +      // buy, kept
      'Trades,Data,Order,Stocks,MSFT,USD,2024-01-16,-5,300.50,-1.2\n' +     // sell, kept
      'Trades,Data,ClosedLot,Stocks,AAPL,USD,2024-01-15,10,150.25,-1.5\n' + // ClosedLot -> skipped
      'Trades,Data,Order,Options,AAPLC,USD,2024-01-15,1,2.5,-1\n';          // non-Stocks -> skipped
    const rows = core.parseCSV(csv);
    const { trades, skipped, truncated } = core.ibkrExtractTrades(rows);
    assert.strictEqual(truncated, false);
    assert.strictEqual(skipped, 2);
    assert.strictEqual(trades.length, 2);
    assert.strictEqual(trades[0].symbol, 'AAPL');
    assert.strictEqual(trades[0].side, 'buy');
    assert.strictEqual(trades[0].shares, 10);
    assert.strictEqual(trades[1].symbol, 'MSFT');
    assert.strictEqual(trades[1].side, 'sell');
    assert.strictEqual(trades[1].shares, 5); // sign stripped, side carries direction
  });

  // 21. Testing ibkrMatchTrades
  test('ibkrMatchTrades - symbol match is case-insensitive against existing stocks', () => {
    const trades = [{ symbol: 'AAPL', currency: 'USD', date: '2024-01-15', side: 'buy', shares: 10, price: 150.25, fees: 1.5 }];
    const stocks = [{ id: 's1', symbol: 'aapl' }]; // lowercase in DB, trade symbol is uppercase from extraction
    const matched = core.ibkrMatchTrades(trades, stocks, []);
    assert.strictEqual(matched[0].stockId, 's1');
    assert.strictEqual(matched[0].status, 'new'); // no matching existing txn -> new, not dup
  });

  test('ibkrMatchTrades - new-stock tagging and market inference from currency', () => {
    const trades = [
      { symbol: 'D05', currency: 'SGD', date: '2024-01-15', side: 'buy', shares: 100, price: 30, fees: 0 },
      { symbol: 'MSFT', currency: 'USD', date: '2024-01-16', side: 'sell', shares: 5, price: 300.5, fees: 1.2 }
    ];
    const matched = core.ibkrMatchTrades(trades, [], []); // no stocks in DB at all
    assert.strictEqual(matched[0].status, 'new-stock');
    assert.strictEqual(matched[0].market, 'SGX'); // SGD -> SGX
    assert.strictEqual(matched[1].status, 'new-stock');
    assert.strictEqual(matched[1].market, 'US'); // non-SGD -> US
  });

  test('ibkrMatchTrades - duplicate detection against existing trades, shares tolerance boundary', () => {
    const stocks = [{ id: 's1', symbol: 'AAPL' }];
    const existingTxns = [{ stockId: 's1', date: '2024-01-15', side: 'buy', shares: 10, price: 150.25 }];
    // Just inside the 0.0001 shares tolerance (float diff ~9.9999...e-5 < 0.0001) -> dup
    const insideShares = { symbol: 'AAPL', currency: 'USD', date: '2024-01-15', side: 'buy', shares: 10.0001, price: 150.25 };
    // Clearly outside the shares tolerance -> not dup
    const outsideShares = { symbol: 'AAPL', currency: 'USD', date: '2024-01-15', side: 'buy', shares: 10.0002, price: 150.25 };
    const [m1, m2] = core.ibkrMatchTrades([insideShares, outsideShares], stocks, existingTxns);
    assert.strictEqual(m1.status, 'dup');
    assert.strictEqual(m2.status, 'new');
  });

  test('ibkrMatchTrades - duplicate detection against existing trades, price tolerance boundary', () => {
    const stocks = [{ id: 's1', symbol: 'AAPL' }];
    const existingTxns = [{ stockId: 's1', date: '2024-01-15', side: 'buy', shares: 10, price: 150.25 }];
    // Just inside the 0.001 price tolerance -> dup
    const insidePrice = { symbol: 'AAPL', currency: 'USD', date: '2024-01-15', side: 'buy', shares: 10, price: 150.2509 };
    // Just outside (float diff ~0.0010000...048 >= 0.001) -> not dup
    const outsidePrice = { symbol: 'AAPL', currency: 'USD', date: '2024-01-15', side: 'buy', shares: 10, price: 150.251 };
    const [m1, m2] = core.ibkrMatchTrades([insidePrice, outsidePrice], stocks, existingTxns);
    assert.strictEqual(m1.status, 'dup');
    assert.strictEqual(m2.status, 'new');
  });

  // 22. Testing kjrChartAggregate
  const CHART_ITEMS = [
    { cat: 'A', val: 10 },
    { cat: 'A', val: 20 },
    { cat: 'B', val: 5 },
    { cat: 'C', val: 100 }
  ];
  const CHART_FIELDS = {
    cat:    { get: i => i.cat },
    sumVal: { agg: 'sum', get: i => i.val },
    avgVal: { agg: 'avg', get: i => i.val }
  };

  test('kjrChartAggregate - sum aggregation, default sort is by x-key ascending', () => {
    const out = core.kjrChartAggregate(CHART_ITEMS, ['cat'], ['sumVal'], CHART_FIELDS);
    assert.deepStrictEqual(out, [['A', { sumVal: 30 }], ['B', { sumVal: 5 }], ['C', { sumVal: 100 }]]);
  });

  test('kjrChartAggregate - avg aggregation', () => {
    const out = core.kjrChartAggregate(CHART_ITEMS, ['cat'], ['avgVal'], CHART_FIELDS);
    assert.deepStrictEqual(out, [['A', { avgVal: 15 }], ['B', { avgVal: 5 }], ['C', { avgVal: 100 }]]);
  });

  test('kjrChartAggregate - sort desc and asc by the first measure', () => {
    const desc = core.kjrChartAggregate(CHART_ITEMS, ['cat'], ['sumVal'], CHART_FIELDS, 'desc');
    assert.deepStrictEqual(desc.map(e => e[0]), ['C', 'A', 'B']);
    const asc = core.kjrChartAggregate(CHART_ITEMS, ['cat'], ['sumVal'], CHART_FIELDS, 'asc');
    assert.deepStrictEqual(asc.map(e => e[0]), ['B', 'A', 'C']);
  });

  test('kjrChartAggregate - topN slices after sort', () => {
    const out = core.kjrChartAggregate(CHART_ITEMS, ['cat'], ['sumVal'], CHART_FIELDS, 'desc', 2);
    assert.deepStrictEqual(out.map(e => e[0]), ['C', 'A']);
  });

  test('kjrChartAggregate - empty input returns empty array', () => {
    assert.deepStrictEqual(core.kjrChartAggregate([], ['cat'], ['sumVal'], CHART_FIELDS), []);
  });

  // 23. Testing kjrFmtMeasure / kjrFmtAxis
  test('kjrFmtMeasure - currency, count, negative, and zero', () => {
    assert.strictEqual(core.kjrFmtMeasure(1234, { unit: 'money' }, 'S$'), 'S$1,234');
    assert.strictEqual(core.kjrFmtMeasure(0, { unit: 'money' }), '$0');
    assert.strictEqual(core.kjrFmtMeasure(-500, { unit: 'money' }, 'US$'), '-US$500');
    assert.strictEqual(core.kjrFmtMeasure(1000, { unit: 'count' }), '1,000');
    assert.strictEqual(core.kjrFmtMeasure(50, { unit: 'pct' }), '50%');
    assert.strictEqual(core.kjrFmtMeasure(50.5, { unit: 'pct' }), '50.5%');
  });

  test('kjrFmtAxis - k/M abbreviation thresholds', () => {
    assert.strictEqual(core.kjrFmtAxis(999, { unit: 'money' }, 'S$'), 'S$999');       // just under k
    assert.strictEqual(core.kjrFmtAxis(1000, { unit: 'money' }, 'S$'), 'S$1k');       // k threshold
    assert.strictEqual(core.kjrFmtAxis(2500000, { unit: 'money' }, 'S$'), 'S$2.5M');
    assert.strictEqual(core.kjrFmtAxis(1000000, { unit: 'money' }, 'S$'), 'S$1M');    // M threshold
  });

  test('kjrFmtAxis - negatives and zero', () => {
    assert.strictEqual(core.kjrFmtAxis(-1500, { unit: 'money' }, 'S$'), '-S$1.5k');
    assert.strictEqual(core.kjrFmtAxis(0, { unit: 'count' }), '0');
  });

  // 24. Testing computeSgIncomeTax upper bands, expected values hand-computed from
  // SG_TAX_BRACKETS itself (base + (ci - from) * rate / 100 at the applicable band),
  // NOT by calling computeSgIncomeTax.
  test('computeSgIncomeTax - upper-band boundary values hand-computed from SG_TAX_BRACKETS', () => {
    const b = core.SG_TAX_BRACKETS;
    // 160,000 falls in the 120k-160k band (index 5): base 7950 + (160000-120000)*15%
    assert.strictEqual(b[5].base + (160000 - b[5].from) * b[5].rate / 100, 13950);
    assert.strictEqual(core.computeSgIncomeTax(160000), 13950);
    // 200,000 falls in the 160k-200k band (index 6): base 13950 + (200000-160000)*18%
    assert.strictEqual(b[6].base + (200000 - b[6].from) * b[6].rate / 100, 21150);
    assert.strictEqual(core.computeSgIncomeTax(200000), 21150);
    // 240,000 falls in the 200k-240k band (index 7): base 21150 + (240000-200000)*19%
    assert.strictEqual(b[7].base + (240000 - b[7].from) * b[7].rate / 100, 28750);
    assert.strictEqual(core.computeSgIncomeTax(240000), 28750);
    // 280,000 falls in the 240k-280k band (index 8): base 28750 + (280000-240000)*19.5%
    assert.strictEqual(b[8].base + (280000 - b[8].from) * b[8].rate / 100, 36550);
    assert.strictEqual(core.computeSgIncomeTax(280000), 36550);
    // 320,000 falls in the 280k-320k band (index 9): base 36550 + (320000-280000)*20%
    assert.strictEqual(b[9].base + (320000 - b[9].from) * b[9].rate / 100, 44550);
    assert.strictEqual(core.computeSgIncomeTax(320000), 44550);
    // 500,000 falls in the 320k-500k band (index 10): base 44550 + (500000-320000)*22%
    assert.strictEqual(b[10].base + (500000 - b[10].from) * b[10].rate / 100, 84150);
    assert.strictEqual(core.computeSgIncomeTax(500000), 84150);
    // 1,000,000 falls in the 500k-1M band (index 11): base 84150 + (1000000-500000)*23%
    assert.strictEqual(b[11].base + (1000000 - b[11].from) * b[11].rate / 100, 199150);
    assert.strictEqual(core.computeSgIncomeTax(1000000), 199150);
    // Above 1M, the top band's own 24% marginal rate applies (index 12): base 199150 + (1100000-1000000)*24%
    assert.strictEqual(b[12].base + (1100000 - b[12].from) * b[12].rate / 100, 223150);
    assert.strictEqual(core.computeSgIncomeTax(1100000), 223150);
  });

  // 25. Testing computeCpfContribution (age boundary, rounding absorption, null age)
  test('computeCpfContribution - exact age 55 vs 56 boundary rates', () => {
    const at55 = core.computeCpfContribution(5000, 55); // <=55 band: 17%/20% + OA/SA/MA allocation
    assert.strictEqual(at55.employerCPF, 850);
    assert.strictEqual(at55.employeeCPF, 1000);
    assert.strictEqual(at55.allocated, true);
    assert.deepStrictEqual(at55.byAccount, { OA: 750, SA: 575, MA: 525 });

    const at56 = core.computeCpfContribution(5000, 56); // 55<age<=60 band: 16%/18%, no allocation
    assert.strictEqual(at56.employerCPF, 800);
    assert.strictEqual(at56.employeeCPF, 900);
    assert.strictEqual(at56.allocated, false);
    assert.deepStrictEqual(at56.byAccount, {});
  });

  test('computeCpfContribution - rounding remainder absorbed into OA so the split sums exactly to total', () => {
    const res = core.computeCpfContribution(4321.99, 42); // awkward wage, deliberately not a round number
    const splitSum = core._round2(res.byAccount.OA + res.byAccount.SA + res.byAccount.MA);
    assert.strictEqual(splitSum, res.total);
  });

  test('computeCpfContribution - null age treated as <=55 band with allocation', () => {
    const res = core.computeCpfContribution(6000, null);
    assert.strictEqual(res.employerCPF, 1020); // 17% of 6000
    assert.strictEqual(res.employeeCPF, 1200); // 20% of 6000
    assert.strictEqual(res.allocated, true);
    assert.deepStrictEqual(res.byAccount, { OA: 1380, SA: 360, MA: 480 });
  });

  // 26. Testing kjrProjectCpf (extra pool cap, null-age contributions, zero months)
  test('kjrProjectCpf - extraFirst60k pool caps OA contribution to the pool at S$20k when OA > 20k', () => {
    const c = core.kjrProjectCpf({
      balances: { OA: 30000, SA: 0, MA: 0 }, grossMonthly: 0, currentAge: null, months: 12,
      rates: { OA: 0, SA: 0, MA: 0, RA: 0, extraFirst60k: 1, extraFirst30kAge55: 0 }
    });
    // OA's own rate is 0 and there are no contributions, so all growth comes from the
    // OA-pool's extra 1%, capped at min(OA,20000)=20000, credited into SA at year-end.
    assert.strictEqual(c.series[0], 30000);
    assert.strictEqual(c.series[12], 30200.04);
  });

  test('kjrProjectCpf - currentAge null means contributions never stop (age never advances)', () => {
    const c = core.kjrProjectCpf({
      balances: { OA: 0, SA: 0, MA: 0 }, grossMonthly: 5000, currentAge: null, months: 120,
      rates: { OA: 0, SA: 0, MA: 0, RA: 0, extraFirst60k: 0, extraFirst30kAge55: 0 }
    });
    // Still contributing at month 119/120, ten years in, a finite age would have
    // stopped allocation once it crossed 55.
    assert.strictEqual(c.series[119] - c.series[118], 1850);
    assert.strictEqual(c.series[120], 222000);
  });

  test('kjrProjectCpf - months = 0 returns only the opening balance, no loop iterations', () => {
    const c = core.kjrProjectCpf({
      balances: { OA: 1000, SA: 2000, MA: 3000 }, grossMonthly: 5000, currentAge: 30, months: 0,
      rates: { OA: 2.5, SA: 4.08, MA: 4.08, RA: 4.08, extraFirst60k: 1, extraFirst30kAge55: 1 }
    });
    assert.deepStrictEqual(c.series, [6000]);
  });

  // 27. Testing _monthsBetween
  test('_monthsBetween - same month returns a single entry', () => {
    assert.deepStrictEqual(core._monthsBetween('2026-03', '2026-03'), ['2026-03']);
  });

  test('_monthsBetween - year rollover walks through December into January', () => {
    assert.deepStrictEqual(core._monthsBetween('2025-11', '2026-02'), ['2025-11', '2025-12', '2026-01', '2026-02']);
  });

  test('_monthsBetween - start after end returns empty, never loops backwards', () => {
    assert.deepStrictEqual(core._monthsBetween('2026-05', '2026-01'), []);
  });

  // 28. Testing _isoDate / _isoDateSG
  test('_isoDate - formats a local-time Date as YYYY-MM-DD', () => {
    assert.strictEqual(core._isoDate(new Date(2026, 0, 5)), '2026-01-05');    // Jan (month index 0)
    assert.strictEqual(core._isoDate(new Date(2026, 11, 31)), '2026-12-31'); // Dec
  });

  test('_isoDateSG - a UTC evening timestamp lands on the next SGT calendar day', () => {
    // 2026-01-05 20:00 UTC + 8h = 2026-01-06 04:00 SGT
    assert.strictEqual(core._isoDateSG(new Date('2026-01-05T20:00:00Z')), '2026-01-06');
  });

  test('_isoDateSG - a UTC morning timestamp stays on the same SGT calendar day', () => {
    // 2026-01-05 10:00 UTC + 8h = 2026-01-05 18:00 SGT, same day
    assert.strictEqual(core._isoDateSG(new Date('2026-01-05T10:00:00Z')), '2026-01-05');
  });

  // 29. Testing _round2
  test('_round2 - ties round half towards +Infinity (JS Math.round semantics), including negatives', () => {
    assert.strictEqual(core._round2(0.125), 0.13);   // positive tie rounds up
    assert.strictEqual(core._round2(-0.125), -0.12);  // negative tie rounds towards +Infinity, i.e. up (less negative)
  });

  test('_round2 - ordinary negative rounding', () => {
    assert.strictEqual(core._round2(-123.456), -123.46);
  });

  console.log(`\nTests completed: ${passed} passed, ${failed} failed.`);

  // Non-fatal constants-freshness reminder (does not affect pass/fail or exit code):
  // SG_HOLIDAYS only lists fixed-date holidays for 2027 today. Warn once next year's
  // table looks thin so the December constants review (see kjr-core.js header comment
  // on SG_HOLIDAYS) doesn't get missed.
  (function checkHolidayFreshness(){
    const nextYear = new Date().getFullYear() + 1;
    let count = 0;
    core.SG_HOLIDAYS.forEach(d => { if (d.startsWith(String(nextYear))) count++; });
    if (count < 8){
      console.warn(`\n⚠️  SG_HOLIDAYS has only ${count} entries for ${nextYear} (expect ~11 once the full gazette lands). Constants review due, see kjr-core.js SG_HOLIDAYS comment.`);
    }
  })();

  if (failed > 0) process.exit(1);
}

runTests();
