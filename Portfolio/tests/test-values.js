/*
 * Regression coverage for QA findings P1-01, P1-02 and P2-03.
 *
 * The app remains a browser global script, so this test extracts only the
 * value-producing functions and field dictionaries into a Node vm. It never
 * supplies a DOM, storage, fetch, or live price source. Synthetic values are
 * intentionally small and use a fixed USDSGD rate of 1.25.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const core = require('../Worker/kjr-core.js');

const appPath = path.join(__dirname, '..', 'Worker', 'app.js');
const appSrc = fs.readFileSync(appPath, 'utf8');

function extractFunction(name, source){
  const sig = new RegExp('function\\s+' + name.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&') + '\\s*\\(');
  const match = sig.exec(source);
  if (!match) return null;
  const start = match.index;
  let i = source.indexOf('{', start);
  if (i < 0) return null;
  let depth = 0;
  let quote = null;
  let lineComment = false;
  let blockComment = false;
  for (; i < source.length; i++){
    const ch = source[i];
    const next = source[i + 1];
    if (lineComment){ if (ch === '\n') lineComment = false; continue; }
    if (blockComment){ if (ch === '*' && next === '/'){ blockComment = false; i++; } continue; }
    if (quote){
      if (ch === '\\'){ i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '/' && next === '/'){ lineComment = true; i++; continue; }
    if (ch === '/' && next === '*'){ blockComment = true; i++; continue; }
    if (ch === '\'' || ch === '"' || ch === '`'){ quote = ch; continue; }
    if (ch === '{') depth++;
    if (ch === '}'){
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return null;
}

function extractConstObject(name, source){
  const marker = 'const ' + name;
  const start = source.indexOf(marker);
  if (start < 0) return null;
  let i = source.indexOf('{', start);
  if (i < 0) return null;
  let depth = 0;
  let quote = null;
  let lineComment = false;
  let blockComment = false;
  for (; i < source.length; i++){
    const ch = source[i];
    const next = source[i + 1];
    if (lineComment){ if (ch === '\n') lineComment = false; continue; }
    if (blockComment){ if (ch === '*' && next === '/'){ blockComment = false; i++; } continue; }
    if (quote){
      if (ch === '\\'){ i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '/' && next === '/'){ lineComment = true; i++; continue; }
    if (ch === '/' && next === '*'){ blockComment = true; i++; continue; }
    if (ch === '\'' || ch === '"' || ch === '`'){ quote = ch; continue; }
    if (ch === '{') depth++;
    if (ch === '}'){
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return null;
}

const functionNames = [
  'getFx', 'toSGD', 'sgdOrNull', 'yahooSymbol', 'coinIdFor', 'isStale',
  '_displayMoneyOrNull', '_nativeMoneyText', 'fmtSgdOrNative',
  'buildStockChartRows', '_stockMvSGDInfo', '_stockMvSGD',
  '_cashSGDInfo', '_cashSGD', '_cpfSGD', '_realestateSGDInfo', '_realestateSGD',
  '_cryptoSGDInfo', '_cryptoSGD', 'insuranceCashValueSGDInfo', 'insuranceCashValueSGD',
  '_netWorthValueInfo', '_liquidAssetValueInfo', '_netWorthClassesSGD', 'currentNetWorthSGD',
  '_allocationData', '_pbAllocRows', 'takeSnapshot'
];
const extractedFunctions = functionNames.map(name => ({ name, source: extractFunction(name, appSrc) }));
const missingFunctions = extractedFunctions.filter(part => !part.source).map(part => part.name);
const holdingFields = extractConstObject('PB_HOLDINGS_FIELDS', appSrc);
const allocationFields = extractConstObject('PB_ALLOC_FIELDS', appSrc);
if (missingFunctions.length || !holdingFields || !allocationFields){
  throw new Error('test-values.js extraction failed for: ' + [
    ...missingFunctions,
    !holdingFields ? 'PB_HOLDINGS_FIELDS' : null,
    !allocationFields ? 'PB_ALLOC_FIELDS' : null
  ].filter(Boolean).join(', '));
}

const extractedSource = [
  ...extractedFunctions.map(part => part.source),
  holdingFields,
  allocationFields,
  'globalThis.__valuesTest = { sgdOrNull, _displayMoneyOrNull, fmtSgdOrNative, buildStockChartRows, _stockMvSGDInfo, _cryptoSGDInfo, _realestateSGDInfo, _realestateSGD, insuranceCashValueSGDInfo, insuranceCashValueSGD, _netWorthValueInfo, _liquidAssetValueInfo, currentNetWorthSGD, _allocationData, _pbAllocRows, takeSnapshot, PB_HOLDINGS_FIELDS, PB_ALLOC_FIELDS };'
].join('\n\n');

function freshSandbox(db){
  const settings = Object.assign({ fxOverrides:{}, fxRates:{} }, (db && db.settings) || {});
  const sandbox = {
    DB: Object.assign({
      settings,
      stocks: [], stockTxns: [], crypto: [], cash: [], realestate: [], insurance: [],
      cpfBalances: {}, cpfHistory: [], snapshots: [], _priceCache: {}
    }, db || {}, { settings }),
    COIN_LOOKUP: {},
    roundMoney: core.roundMoney,
    safeRatio: core.safeRatio,
    _isoDateSG: core._isoDateSG,
    deriveStockPosition: () => null,
    deriveCashBalance: account => Number(account.amount) || 0,
    cpfEffectiveBalances: () => {
      const balances = sandbox.DB.cpfBalances || {};
      return { OA:Number(balances.OA)||0, SA:Number(balances.SA)||0, MA:Number(balances.MA)||0, RA:Number(balances.RA)||0 };
    },
    uid: prefix => prefix + '_test_id',
    saveData: () => true,
    renderDashboard: () => {},
    showToast: () => {},
    _dashShowCpf: false
  };
  sandbox._renderCcy = 'SGD';
  sandbox.displayCcy = () => sandbox._renderCcy;
  sandbox.kjrEscape = value => String(value);
  sandbox.fmt = (value, opts) => {
    const dp = opts && opts.dp != null ? opts.dp : 2;
    const ccy = (opts && opts.currency) || sandbox._renderCcy;
    const sign = opts && opts.signed && Number(value) > 0 ? '+' : '';
    return `${ccy} ${sign}${Number(value).toFixed(dp)}`;
  };
  vm.createContext(sandbox);
  vm.runInContext(extractedSource, sandbox, { filename:'app.js (value regressions)' });
  return sandbox;
}

function approx(actual, expected, epsilon){
  assert.ok(Math.abs(actual - expected) <= (epsilon == null ? 1e-9 : epsilon), `${actual} was not within tolerance of ${expected}`);
}

function asPlain(value){ return JSON.parse(JSON.stringify(value)); }

function loadFixture(name){
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'));
}

function chartFixture(){
  return {
    settings:{ fxOverrides:{ USDSGD:1.25 }, fxRates:{} },
    stocks:[
      { id:'stock_qa_usa', symbol:'QAAA', market:'US', currency:'USD', shares:10, avgCost:80, divPerShare:4 },
      { id:'stock_qa_sgx', symbol:'QBBB', market:'SGX', currency:'SGD', shares:100, avgCost:8, divPerShare:0.4 }
    ],
    _priceCache:{
      QAAA:{ price:100, currency:'USD', fetchedAt:'2026-09-05T23:59:59.000Z' },
      'QBBB.SI':{ price:10, currency:'SGD', fetchedAt:'2026-09-05T23:59:59.000Z' }
    }
  };
}

function allocationRows(classes, showCpf){
  const sandbox = freshSandbox();
  sandbox._netWorthClassesSGD = () => classes;
  sandbox._dashShowCpf = showCpf;
  return asPlain(sandbox.__valuesTest._pbAllocRows());
}

function runTests(){
  let passed = 0;
  let failed = 0;
  function test(name, fn){
    try {
      fn();
      console.log(`✅ PASS: ${name}`);
      passed++;
    } catch (error) {
      console.error(`❌ FAIL: ${name}`);
      console.error(error.stack || error);
      failed++;
    }
  }

  console.log('--- Testing Portfolio value regressions (P1-01, P1-02, P2-03) ---');

  test('P1-01 chart percentage fields retain the core percentage unit', () => {
    const sandbox = freshSandbox(chartFixture());
    const rows = asPlain(sandbox.__valuesTest.buildStockChartRows());
    const usa = rows.find(row => row.s.symbol === 'QAAA');
    assert.ok(usa, 'synthetic USD holding must build a chart row');
    approx(usa.plPct, 25);
    approx(usa.divYieldCur, 4);
    approx(usa.weight, 55.5555555556, 1e-8);

    const fields = sandbox.__valuesTest.PB_HOLDINGS_FIELDS;
    approx(fields.pnlPct.get(usa), 25);
    approx(fields.divYield.get(usa), 4);
    approx(fields.weightPct.get(usa), 55.5555555556, 1e-8);
    assert.strictEqual(core.kjrFmtMeasure(fields.pnlPct.get(usa), fields.pnlPct), '25%');
  });

  test('P1-01 allocation percentage field still converts its fractional row weight once', () => {
    const sandbox = freshSandbox();
    assert.strictEqual(sandbox.__valuesTest.PB_ALLOC_FIELDS.weightPct.get({ weight:0.8 }), 80);
  });

  test('P1-02 display conversion keeps its best-effort fallback while aggregate conversion remains strict', () => {
    const sandbox = freshSandbox({ settings:{ fxOverrides:{}, fxRates:{} } });
    assert.strictEqual(sandbox.toSGD(100, 'USD'), 100);
    assert.strictEqual(sandbox.sgdOrNull(100, 'USD'), null);
  });

  test('P1-02 shared money formatter protects both conversion legs and preserves native display values', () => {
    const sandbox = freshSandbox({ settings:{ fxOverrides:{}, fxRates:{} } });
    sandbox._renderCcy = 'USD';
    assert.match(sandbox.__valuesTest.fmtSgdOrNative(100, 'SGD'), /SGD 100\.00 · FX missing/);
    assert.strictEqual(sandbox.__valuesTest.fmtSgdOrNative(100, 'USD'), 'USD 100.00');
    sandbox._renderCcy = 'SGD';
    assert.match(sandbox.__valuesTest.fmtSgdOrNative(100, 'USD'), /USD 100\.00 · FX missing/);
  });

  test('P1-02 Watchlist and Board keep missing-FX values native and unavailable to SGD sorts and exports', () => {
    const stockColumnsSource = appSrc.slice(appSrc.indexOf('const STOCK_COLUMNS = ['), appSrc.indexOf('const STOCK_COL_LABEL'));
    const holdingsSource = appSrc.slice(appSrc.indexOf('function renderStocks(){'), appSrc.indexOf('function renderWatchlist(){'));
    const watchlistSource = appSrc.slice(appSrc.indexOf('function renderWatchlist(){'), appSrc.indexOf('function renderBoard(){'));
    const boardColumnsSource = appSrc.slice(appSrc.indexOf('const BOARD_COLUMNS = ['), appSrc.indexOf('const BOARD_COL_LABEL'));
    const boardSource = appSrc.slice(appSrc.indexOf('function renderBoard(){'), appSrc.indexOf('function setBoardSort('));
    const stockSortSource = appSrc.slice(appSrc.indexOf('const STOCK_SORT_VALS = {'), appSrc.indexOf('function setStockSort('));
    const exportsSource = appSrc.slice(appSrc.indexOf('function exportHoldingsCSV(){'), appSrc.indexOf('/* ─── IBKR CSV import'))
      + appSrc.slice(appSrc.indexOf('function exportInsuranceCSV(){'), appSrc.indexOf('/* Rider sub-table expansion state'));
    assert.ok(watchlistSource.includes('fmtSgdOrNative(px.price, ccy)'));
    assert.ok(watchlistSource.includes('sgdOrNull(r.px.price, r.ccy)'));
    assert.ok(stockColumnsSource.includes('fmtSgdOrNative(r.px.price, r.priceCcy || r.ccy)'));
    assert.ok(stockColumnsSource.includes("fmtSgdOrNative(r.mv, 'SGD', {dp:0})"));
    assert.ok(holdingsSource.includes("fmtSgdOrNative(totMv, 'SGD', {dp:0})"));
    assert.ok(boardColumnsSource.includes('fmtSgdOrNative(r.px.price, r.ccy)'));
    assert.ok(boardColumnsSource.includes('fmtCompactSgdOrNative'));
    assert.ok(boardSource.includes('sgdOrNull(r.px.price, r.ccy)'));
    assert.ok(stockSortSource.includes('avgCost:      r => sgdOrNull(r.avgCost, r.ccy)'));
    assert.ok(exportsSource.includes('sgdOrNull(px, ccy)'));
    assert.ok(exportsSource.includes('sgdOrNull(p.cashValue, ccy)'));
    assert.strictEqual(freshSandbox({ settings:{ fxOverrides:{}, fxRates:{} } }).__valuesTest.sgdOrNull(100, 'USD'), null);
  });

  test('P1-02 stock and crypto aggregates exclude missing-FX values and count the omission', () => {
    const sandbox = freshSandbox({
      settings:{ fxOverrides:{}, fxRates:{} },
      stocks:[{ id:'stock_missing_fx', symbol:'MISS', market:'US', currency:'USD', shares:1, avgCost:100 }],
      crypto:[{ id:'crypto_missing_fx', symbol:'MISSCOIN', coingeckoId:'misscoin', currency:'USD', amount:1, avgCost:100 }],
      _priceCache:{ MISS:{ price:100, currency:'USD', fetchedAt:'2026-09-05T23:59:59.000Z' } }
    });
    const stock = asPlain(sandbox.__valuesTest._stockMvSGDInfo());
    const crypto = asPlain(sandbox.__valuesTest._cryptoSGDInfo());
    assert.strictEqual(stock.total, 0);
    assert.strictEqual(stock.excludedCount, 1);
    assert.strictEqual(crypto.total, 0);
    assert.strictEqual(crypto.excludedCount, 1);
    const net = asPlain(sandbox.__valuesTest._netWorthValueInfo());
    assert.strictEqual(net.total, 0);
    assert.strictEqual(net.missingFxCount, 2);
    assert.strictEqual(net.incomplete, true);
  });

  test('P1-02 known FX preserves a labelled cost-basis estimate when a price is absent', () => {
    const sandbox = freshSandbox({
      settings:{ fxOverrides:{ USDSGD:1.25 }, fxRates:{} },
      stocks:[{ id:'stock_cost_estimate', symbol:'EST', market:'US', currency:'USD', shares:1, avgCost:100 }]
    });
    const stock = asPlain(sandbox.__valuesTest._stockMvSGDInfo());
    assert.strictEqual(stock.total, 125);
    assert.strictEqual(stock.estimatedCount, 1);
    assert.strictEqual(stock.estimatedAmount, 125);
    assert.strictEqual(stock.excludedCount, 0);
  });

  test('P1-02 foreign property and active insurance cash value do not enter SGD totals without FX', () => {
    const sandbox = freshSandbox({
      settings:{ fxOverrides:{}, fxRates:{} },
      realestate:[{ id:'property_missing_fx', value:100, currency:'USD' }],
      insurance:[{ id:'insurance_missing_fx', status:'Active', cashValue:100, currency:'USD' }]
    });
    assert.deepStrictEqual(asPlain(sandbox.__valuesTest._realestateSGDInfo()), { total:0, excludedCount:1 });
    assert.deepStrictEqual(asPlain(sandbox.__valuesTest.insuranceCashValueSGDInfo()), { total:0, excludedCount:1 });
    const net = asPlain(sandbox.__valuesTest._netWorthValueInfo());
    assert.strictEqual(net.total, 0);
    assert.strictEqual(net.missingFxCount, 2);
    assert.strictEqual(net.incomplete, true);
  });

  test('P2-03 allocation includes active insurance and filters CPF before calculating weights', () => {
    const classes = { stocks:100, cash:0, cpf:50, realestate:0, crypto:0, insurance:25 };
    const off = allocationRows(classes, false);
    assert.deepStrictEqual(off.map(row => row.cls), ['Stocks', 'Insurance']);
    approx(off.reduce((sum, row) => sum + row.weight, 0), 1);
    approx(off.find(row => row.cls === 'Stocks').weight, 0.8);
    approx(off.find(row => row.cls === 'Insurance').weight, 0.2);

    const on = allocationRows(classes, true);
    assert.deepStrictEqual(on.map(row => row.cls), ['Stocks', 'CPF', 'Insurance']);
    approx(on.reduce((sum, row) => sum + row.weight, 0), 1);
    approx(on.find(row => row.cls === 'Stocks').weight, 100 / 175);
    approx(on.find(row => row.cls === 'CPF').weight, 50 / 175);
    approx(on.find(row => row.cls === 'Insurance').weight, 25 / 175);
  });

  test('P2-03 allocation retains signed positive-net, zero-net and negative-net states without inventing weights', () => {
    assert.deepStrictEqual(allocationRows({ stocks:0, cash:0, cpf:0, realestate:0, crypto:0, insurance:0 }, false), []);
    const positiveNet = allocationRows({ stocks:100, cash:-20, cpf:0, realestate:0, crypto:0, insurance:0 }, false);
    assert.deepStrictEqual(positiveNet.map(row => row.cls), ['Stocks', 'Cash']);
    approx(positiveNet.reduce((sum, row) => sum + row.weight, 0), 1);
    approx(positiveNet.find(row => row.cls === 'Stocks').weight, 1.25);
    approx(positiveNet.find(row => row.cls === 'Cash').weight, -0.25);

    const zeroNet = allocationRows({ stocks:100, cash:-100, cpf:0, realestate:0, crypto:0, insurance:0 }, false);
    assert.deepStrictEqual(zeroNet.map(row => row.cls), ['Stocks', 'Cash']);
    assert.strictEqual(zeroNet.every(row => row.weight === null), true);

    const negativeNet = allocationRows({ stocks:100, cash:-200, cpf:0, realestate:0, crypto:0, insurance:0 }, false);
    assert.deepStrictEqual(negativeNet.map(row => row.cls), ['Stocks', 'Cash']);
    assert.strictEqual(negativeNet.every(row => row.weight === null), true);
    assert.strictEqual(negativeNet.find(row => row.cls === 'Stocks').weight, null);
  });

  test('P1-02 end-to-end QA fixtures preserve known totals, prices and valuation completeness', () => {
    const seed = freshSandbox(loadFixture('QA Seed v1 (05 Sep).json'));
    const priced = freshSandbox(loadFixture('QA Prices v1 (05 Sep).json'));
    const seedNet = asPlain(seed.__valuesTest._netWorthValueInfo());
    const pricedNet = asPlain(priced.__valuesTest._netWorthValueInfo());
    const seedLiquid = asPlain(seed.__valuesTest._liquidAssetValueInfo());
    const pricedLiquid = asPlain(priced.__valuesTest._liquidAssetValueInfo());

    assert.strictEqual(seedNet.incomplete, false);
    assert.strictEqual(pricedNet.incomplete, false);
    assert.strictEqual(seedNet.total, 120500);
    assert.strictEqual(pricedNet.total, 121100);
    assert.strictEqual(seedNet.total - seedNet.classes.cpf, 110500);
    assert.strictEqual(pricedNet.total - pricedNet.classes.cpf, 111100);
    assert.strictEqual(seedLiquid.total, 8500);
    assert.strictEqual(pricedLiquid.total, 9100);

    const seedStock = asPlain(seed.__valuesTest._stockMvSGDInfo());
    const pricedStock = asPlain(priced.__valuesTest._stockMvSGDInfo());
    assert.strictEqual(seedStock.total, 2250);
    assert.strictEqual(pricedStock.total, 2600);
    const seedRows = asPlain(seed.__valuesTest.buildStockChartRows());
    const pricedRows = asPlain(priced.__valuesTest.buildStockChartRows());
    assert.strictEqual(seedRows.reduce((sum, row) => sum + row.cost, 0), 1800);
    assert.strictEqual(pricedRows.reduce((sum, row) => sum + row.cost, 0), 1800);
    assert.strictEqual(seedRows.reduce((sum, row) => sum + row.divAnnualSgd, 0), 90);
    assert.strictEqual(pricedRows.reduce((sum, row) => sum + row.divAnnualSgd, 0), 90);
    assert.strictEqual(seed.__valuesTest._cryptoSGDInfo().total, 1250);
    assert.strictEqual(priced.__valuesTest._cryptoSGDInfo().total, 1500);

    const seedUsa = seedRows.find(row => row.s.symbol === 'QAAA');
    const seedSgx = seedRows.find(row => row.s.symbol === 'QBBB');
    const pricedUsa = pricedRows.find(row => row.s.symbol === 'QAAA');
    const pricedSgx = pricedRows.find(row => row.s.symbol === 'QBBB');
    approx(seedUsa.divYieldCur, 4); approx(seedSgx.divYieldCur, 4);
    approx(pricedUsa.divYieldCur, 100 / 30, 1e-8); approx(pricedSgx.divYieldCur, 40 / 11, 1e-8);
    approx(seedUsa.divYoc, 5); approx(seedSgx.divYoc, 5);
    approx(pricedUsa.divYoc, 5); approx(pricedSgx.divYoc, 5);
    approx(pricedUsa.weight, 1500 / 2600 * 100, 1e-8);
    approx(pricedSgx.weight, 1100 / 2600 * 100, 1e-8);
  });

  test('P1-02 snapshots skip incomplete asset valuations without mutating history', () => {
    const sandbox = freshSandbox({
      settings:{ fxOverrides:{}, fxRates:{} },
      stocks:[{ id:'missing_stock', symbol:'MISS', market:'US', currency:'USD', shares:1, avgCost:100 }],
      crypto:[{ id:'missing_crypto', symbol:'MISSCOIN', coingeckoId:'misscoin', currency:'USD', amount:1, avgCost:100 }]
    });
    assert.strictEqual(sandbox.__valuesTest.takeSnapshot({ noSave:true }), null);
    assert.deepStrictEqual(asPlain(sandbox.DB.snapshots), []);
  });

  test('P1-02 chart guards clear stale charts before incomplete or negative doughnut messages', () => {
    const drawInto = extractFunction('_pbDrawInto', appSrc);
    const crossSectional = extractFunction('_pbDrawCrossSectional', appSrc);
    const projections = extractFunction('renderProjections', appSrc);
    assert.ok(drawInto.includes('inst.destroy()'));
    assert.ok(crossSectional.includes("showEmpty('Allocation incomplete'"));
    assert.ok(crossSectional.includes("showEmpty('Doughnut unavailable'"));
    assert.ok(projections.includes('if (liquidInfo.incomplete)'));
    assert.ok(projections.includes('_clearProjectionChart();'));
  });

  console.log(`\nTests completed: ${passed} passed, ${failed} failed.`);
  if (failed) process.exitCode = 1;
}

runTests();
