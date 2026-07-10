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

  console.log(`\nTests completed: ${passed} passed, ${failed} failed.`);
  if (failed > 0) process.exit(1);
}

runTests();
