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
const INDEX_HTML_PATH = path.join(__dirname, '..', 'index.html');
const indexSrc = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
const APPS_SCRIPT_PATH = path.join(__dirname, '..', 'Worker', 'apps-script.gs');
const appsScriptSrc = fs.readFileSync(APPS_SCRIPT_PATH, 'utf8');

/* ─── Extraction harness ────────────────────────────────────────────────
   extractFunction: finds `function NAME(` then brace-matches to the closing
   `}` of that function body, skipping over braces inside string/template
   literals and comments so a stray `{` in a regex or a comment can't throw
   the depth counter off. Returns the exact source slice, or null if the
   function name isn't found at all (start of the search fails). */
function extractFunction(name, source){
  source = source || appSrc;
  const sigRe = new RegExp('function\\s+' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\(');
  const m = sigRe.exec(source);
  if (!m) return null;
  let start = m.index;
  const prefix = source.slice(Math.max(0, m.index - 6), m.index);
  if (/async\s$/.test(prefix)) start = m.index - 6;
  let i = source.indexOf('{', m.index);
  if (i === -1) return null;
  let depth = 0;
  let inStr = null;           // ' " ` while inside a string/template literal
  let inLineComment = false;
  let inBlockComment = false;
  for (; i < source.length; i++){
    const c = source[i];
    const next = source[i + 1];
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
      if (depth === 0) return source.slice(start, i + 1);
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

/* extractConstBlock: the navigation tables (TABS, NAV_GROUPS, MOBILE_GROUPS, ADD_MENU_ITEMS) and a few
   multi-part icon strings span several lines, so scan from `const NAME = ` to the `;` that closes the
   statement at bracket depth 0, skipping strings and comments the same way extractFunction does. */
function extractConstBlock(name){
  const idx = appSrc.indexOf('const ' + name + ' = ');
  if (idx === -1) return null;
  let depth = 0, inStr = null, inLine = false, inBlock = false;
  for (let i = idx; i < appSrc.length; i++){
    const c = appSrc[i];
    const next = appSrc[i + 1];
    if (inLine){ if (c === '\n') inLine = false; continue; }
    if (inBlock){ if (c === '*' && next === '/'){ inBlock = false; i++; } continue; }
    if (inStr){
      if (c === '\\'){ i++; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '/' && next === '/'){ inLine = true; i++; continue; }
    if (c === '/' && next === '*'){ inBlock = true; i++; continue; }
    if (c === '\'' || c === '"' || c === '`'){ inStr = c; continue; }
    if (c === '[' || c === '{' || c === '(') depth++;
    else if (c === ']' || c === '}' || c === ')') depth--;
    else if (c === ';' && depth === 0) return appSrc.slice(idx, i + 1);
  }
  return null;
}

const FUNCTION_TARGETS = [
  'kjrSafeId', 'kjrSafeString', '_isValidTicker',
  'isBrokerageAcct', 'cashMovementDelta', 'linkedTradeCurrencyMismatch',
  'crossCurrencyTransferMissingAmount', 'cashTradeFlow', 'transferInAmount', 'deriveCashBalance',
  'annualPremium', 'cashPremiumPerYear', '_insurancePremiumSchedule',
  'estimateAnnualTax', 'toSGD', 'sgdOrNull', 'getFx', '_displayMoneyOrNull', '_ageOnYear',
  '_stockMvSGDInfo', '_cryptoSGDInfo',
  '_syncDiagPath', '_syncDiagList', '_syncDiagLossy', '_syncDiagSafeCode',
  '_syncDiagRecordSafe', '_readSyncDiagnostics', '_storeSyncDiagnostics',
  '_recordSyncFailure', '_clearSyncDiagnostic', '_syncDiagReason',
  '_lossyAckReason', '_rejectLossyAck', '_isCanonicalServerTimestamp',
  '_validWriteAck', '_divergenceSnapshot', '_isMaterialDivergence', 'strictConflictsEnabled', 'lastPullSource', 'overwriteRemoteWithLocal',
  '_setConfirmedCloudTimestamp', '_confirmedCloudTimestamp', '_displaySyncTimestamp',
  '_markLocalUnsaved', '_clearLocalUnsaved', '_hasLocalUnsaved',
  '_markCloudDirty', '_clearCloudDirty', '_hasCloudDirty',
  '_stripBackupMetadata', 'localPersistPayload', 'syncPayload', 'backupExportPayload',
  '_cloneLocalValue', '_sameLocalValue', '_localIdMap', '_recordLocalConflict',
  '_mergeLocalValue', 'mergeConcurrentLocalState', '_writeLocalPayload',
  '_reconcileIncomingLocalStorage', '_handleRemovedLocalStorage',
  'backendMode', 'isNasMode', 'isLegacyReadonlyMode', 'legacyBackendAllowed', 'denyReadonlyMutation',
  '_scheduleCloudAfterLocalSave', 'saveData', '_awaitVaultFlushForRevision',
  '_persistLocalOnly', 'safeJson', 'pushToRemote',
  '_quiesceSavesBeforePull',
  '_cancelPullForUnsavedChanges', 'setLastPull', 'pullFromRemote',
  '_syncDetailsModel', 'setSyncStatus', 'updateSyncStatusPill',
  '_copySafeOwnObject', '_sanitiseList', 'normaliseEntityRow', 'entityModalSave', 'entityModalDelete',
  'restoreFromTrash', 'runReconciliation',
  '_cancelSyncForReset', 'resetLocalConfirm', '_fxPairsInUse', 'refreshFx',
  '_pbDrawInto', '_pbDrawTimeSeries',
  'pbPersistSaved', 'pbSaveChart', 'pbTogglePin', 'pbDeleteSaved', 'pbUndoDelete',
  '_salaryPayMonths', 'generateAutoSalaryEntries', 'generateAutoSalaryCashEntries', 'generateAutoCpfEntries',
  'deriveStockPosition', '_cpfAnchorDate', 'cpfEffectiveBalances',
  'annualIncomeSGD', 'annualExpensesSGD', 'derivedMonthlySavingsSGD', 'fireNumberSGD',
  'expenseAmountSgdOrNull', 'renderProjections', 'autoRefreshTick', 'ibkrConfirmImport', 'disableVaultProtection',
  // renderProjections calls these shared FIRE helpers (also used by the dashboard Financial independence tile)
  '_fireProgress', '_fireAssumptions', '_fireProjectLiquid', '_fireYearAge',
  // Dashboard rows (v2.70): layout migration, the Where it sits maths, Coming up, and the shared P&L, insurance, dividend and crypto rules
  '_migrateDashLayout', 'loadDashLayout', '_applyDashLayout', '_dashWidgetBaseName',
  '_gainPill', '_monogram', '_dayMoveSgd', '_stockDayMove', '_rebalanceThreshold', '_allocRows', '_allocInsight',
  '_whereModel', '_allocationData', '_allocRowHtml', '_dashWhereItSits',
  '_ringSvg', '_miniBars', '_nextPayday', '_comingUp',
  '_ymOf', '_cfMonthRollup', '_insuranceDueWithin', '_upcomingDividendRows', '_cryptoRow', 'isStale',
  // Hero chart (v2.71): the series and layout maths, the remembered range, and the markup builders
  '_pbHumanDate', '_heroRangeGet', 'setHeroRange', '_heroDay', '_heroSeries', '_heroNearest', '_heroNiceTicks', '_heroGeometry',
  '_heroLiveValue', '_heroWithLive', '_heroAxisLabel', '_heroRangesHtml', '_heroPointText', '_heroChartHtml',
  // Navigation shell (v2.72): group membership, the active area on the phone, sidebar counts, the + Add menu, and the sync row's age and phone dot
  '_tabLabel', '_groupTabKeys', '_mobileGroupForTab', '_navCount', '_navCountLabel', '_addMenuModel',
  '_navIcon', '_sideItemHtml', '_sheetNavRowHtml', '_sheetUtilityRowsHtml', 'renderSidebarNav', 'renderBottomBar', 'renderMoreSheet',
  'updateNavCounts', '_syncNavActive', '_syncTopbarContext', 'navLink',
  '_shellMenuItems', 'openShellMenu', 'closeShellMenus', 'toggleShellMenu', 'shellMenuKeydown', 'renderAddMenu', 'addMenuPick',
  '_syncAgeText', '_paintSyncDot', '_refreshSyncAge',
  // Mobile list rows and chip filters (v2.73): the row models and markup, the routing, the More menus, the Sort chip and the CPF chip mirror,
  // plus the formatters the table cells use, so a test can hold the list against the table
  '_plainText', '_finiteNum', '_returnCell', '_listMoney', '_stockListModel', '_cryptoListModel', '_holdingLabel', 'openHoldingDetail',
  '_holdingRowHtml', '_holdingTotalHtml', '_holdingsListHtml', '_cashListModel', '_cashRowHtml', '_cashListHtml',
  '_cashTxnView', '_ledgerRowHtml', '_cashTxnRowHtml', '_cpfRowView', '_cpfRowHtml',
  'moreMenuPick', '_moreMenuHtml', '_chipSelectHtml', '_stockSortChipOptions', 'setStockSortTo', 'stocksSortPick',
  '_chipKeep', '_chipRestore', 'cpfChipFilter', 'cpfClearFilters', '_syncCpfChips',
  'fmtSgdOrNative', '_nativeMoneyText', 'fmtPct', '_plArrow', '_moneyHtml', 'fmtDateSG', '_parseDateOnlyLocal', 'cpfTypeLabel',
  'buildStockChartRows', 'renderStocks', 'renderCrypto', 'renderCash', 'renderCashTxns', 'renderCpf',
  'fxMissingFor', 'projectedMonthlyInterest', 'hasCashActivity'
];
const CONST_TARGETS = ['APP_VERSION', 'APP_DISPLAY_VERSION', 'SCHEMA', 'SCHEMA_VERSION', 'SAFE_ID_RE', 'TICKER_RE', 'PREMIUM_PER_YEAR', 'SYNC_DEBOUNCE_MS', 'PAYLOAD_HARD_CAP', 'PAYLOAD_WARN_AT', 'LK_DB', 'LK_SYNC_URL', 'LK_SYNC_TS', 'LK_SYNC_CONFIRMED_TS', 'LK_SYNC_DIAGNOSTICS', 'LK_LAST_PULL', 'LK_LAST_PULL_SRC', 'LK_RESET_SYNC_BLOCK', 'LK_LOSSY_SYNC_BLOCK', 'LK_UNSAVED', 'LK_CLOUD_DIRTY', 'LK_PRICE_CACHE', 'LK_BACKEND_MODE', 'NAS_MODES', 'PB_PALETTE', 'PB_PERIOD_LABELS', 'MONOGRAM_CLASSES', 'LIST_DASH', 'CPF_TYPE_LABEL', 'DASH_DEFAULT_WIDGETS', 'DASH_LEGACY_WIDGETS', 'DASH_CHART_ID_RE', 'DASH_WIDGET_NAMES', 'PB_MONTHS', 'LK_HERO_RANGE', 'HERO_RANGES', 'HERO_RANGE_LABELS', '_heroState'];

const extractedFns = {};
const missingFns = [];
FUNCTION_TARGETS.forEach(name => {
  const src = extractFunction(name);
  if (!src) missingFns.push(name);
  else extractedFns[name] = src;
});
// Multi-line navigation constants (v2.72), pulled out whole.
const CONST_BLOCK_TARGETS = ['TABS', 'PHASE_2_TABS', 'NAV_GROUPS', 'MOBILE_GROUPS', 'NAV_COUNT_TABLES', 'ADD_MENU_ITEMS', 'MORE_SHEET_ICON', 'BOOK_ICON', 'TRADING_ICON', 'FOREX_ICON', 'THEME_ICONS', 'SHELL_MENUS',
  'CASH_TYPE_LABEL', 'MORE_MENU_ACTIONS', 'STOCK_SORT_CHIPS', 'STOCK_SORT_VALS', 'STOCK_COL_LABEL', 'STOCK_COLUMNS', 'GICS_SECTOR_OPTIONS'];
const extractedConstBlocks = {};
CONST_BLOCK_TARGETS.forEach(name => {
  const src = extractConstBlock(name);
  if (!src) missingFns.push(name + ' (const block)');
  else extractedConstBlocks[name] = src;
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
  appSrc.match(/const _DIVERGENCE_TABLES = \[[\s\S]*?\];/)[0],
  ...CONST_TARGETS.map(n => extractedConsts[n]),
  ...CONST_BLOCK_TARGETS.map(n => extractedConstBlocks[n]),
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
  const fakeStorage = {
    _data: new Map(),
    getItem(k){ return this._data.has(k) ? this._data.get(k) : null; },
    setItem(k,v){ this._data.set(k, String(v)); },
    removeItem(k){ this._data.delete(k); }
  };
  const sandbox = {
    DB: Object.assign({
      settings: Object.assign({
        salary: {}, tax: {}, birthYear: null,
        fxOverrides: {}, fxRates: {}
      }, (dbOverrides && dbOverrides.settings) || {}),
      stocks: [], crypto: [], _priceCache: {}
    }, dbOverrides || {}),
    // kjr-core globals estimateAnnualTax reads directly, exactly as app.js does.
    cpfContribRatesForAge: core.cpfContribRatesForAge,
    computeCpfContribution: core.computeCpfContribution,
    computeStockPosition: core.computeStockPosition,
    _monthsBetween: core._monthsBetween,
    getPayday: core.getPayday,
    incomeNet: core.incomeNet,
    CPF_OW_CEILING_2026: core.CPF_OW_CEILING_2026,
    computeSgIncomeTax: core.computeSgIncomeTax,
    _round2: core._round2,
    roundMoney: core.roundMoney,
    safeRatio: core.safeRatio,
    deriveStockPosition: () => null,
    yahooSymbol: s => s.symbol,
    coinIdFor: id => id,
    _syncTimer: null,
    _activeSyncController: null,
    _activeSyncCompletions: new Set(),
    _activeSyncLatest: null,
    _syncDiagnosticsMemory: null,
    _syncDiagnosticsStorageFailed: false,
    _syncStatusState: 'local',
    _syncStatusDetail: '',
    _nasPendingCount: 0,
    _nasState: 'local',
    _nasReady: false,
    _activeLocalSave: null,
    _localSaveRevision: 0,
    _localUnsavedInMemory: false,
    _cloudDirtyInMemory: false,
    _localBase: null,
    _vaultManager: null,
    _bloatWarned: false,
    _conflictResolvingNow: false,
    _resyncToastShown: false,
    _entitySaveInFlight: false,
    _entityDeleteInFlight: false,
    _modalState: null,
    _fxInFlight: null,
    _autoTickInFlight: false,
    _ibkrImportInFlight: false,
    _pbSaveInFlight: false,
    _pbUndoChart: null,
    _pbUndoTimer: null,
    _pbUndoInFlight: false,
    _pbCharts: {},
    _DATE_FIELDS_BY_TABLE: {},
    _sanitiseInvalidDateCount: 0,
    localStorage: fakeStorage,
    window: { localStorage: fakeStorage },
    protectedStorage: fakeStorage,
    sessionStorage: {
      _data: new Map(),
      getItem(k){ return this._data.has(k) ? this._data.get(k) : null; },
      setItem(k,v){ this._data.set(k, String(v)); },
      removeItem(k){ this._data.delete(k); }
    },
    _readStoredLocalPayload: null,
    saveLocal: () => true,
    mergeDefaults: value => JSON.parse(JSON.stringify(value)),
    _stashLocalConflicts: () => null,
    renderAll: () => {},
    renderTrash: () => {},
    pushUndo: () => {},
    loadSettingsForm: () => {},
    freshDB: () => ({ stocks:[], crypto:[], cash:[], settings:{}, _priceCache:{} }),
    getSyncUrl: () => 'https://example.invalid/sync',
    isLocalPreview: () => false,
    confirm: () => true,
    setSyncStatus: () => {},
    showToast: () => {},
    uid: table => table + '_safe_id',
    kjrValidDate: core.kjrValidDate,
    kjrSafeNumber: core.kjrSafeNumber,
    OVERSOLD_EPSILON: core.OVERSOLD_EPSILON,
    fmt: n => String(n),
    ENTITY_SCHEMAS: {},
    document: { getElementById: () => null },
    relTime: () => 'relative time',
    location: { protocol:'https:', hostname:'portfolio.example' },
    AbortController,
    AbortSignal,
    fetch: () => Promise.reject(new Error('fetch not stubbed')),
    seedDecision: () => 'refuse',
    pushToRemote: () => Promise.resolve(true),
    closeEntityModal: () => {},
    priceFor: () => ({ price:1 }),
    refreshStockPrices: () => {},
    prompt: () => 'Chart',
    pbSource: () => ({ kind:'holdings' }),
    pbFields: () => ({ symbol:{label:'Symbol'}, marketValue:{label:'Market Value'} }),
    _pbLiveConfig: () => ({ source:'holdings', mode:'crosssec', xFields:['symbol'], yFields:['marketValue'], tsSymbols:[] }),
    pbLoadSaved: () => JSON.parse(JSON.stringify(sandbox.DB.settings.savedCharts || [])),
    pbRenderAllSaved: () => {},
    _pbConfirm: (_message, onYes) => { sandbox._pbConfirmPromise = Promise.resolve(onYes()); },
    _pbStockRows: () => [],
    _pbCurSym: () => 'S$',
    _isoDateSG: core._isoDateSG,
    displayCcy: () => 'SGD',
    fetchStockHistory: async () => ({}),
    _pbMountChart: () => {},
    _pbDrawInternalSeries: () => false,
    _pbDrawCrossSectional: () => false,
    _cssVar: () => '#888',
    _privacyMaskLabel: value => value,
    kjrFmtAxis: value => String(value),
    kjrEscape: value => String(value),
    setTimeout,
    clearTimeout
  };
  sandbox._readStoredLocalPayload = () => {
    const raw = sandbox.localStorage.getItem('kjr-pf-db-v1');
    return raw ? JSON.parse(raw) : null;
  };
  vm.createContext(sandbox);
  vm.runInContext(COMBINED_SRC, sandbox, { filename: 'app.js (extracted)' });
  return sandbox;
}

function installSyncStatusDom(sb){
  const classes = new Set();
  const pill = {
    classList: {
      add: (...names) => names.forEach(name => classes.add(name)),
      remove: (...names) => names.forEach(name => classes.delete(name)),
      contains: name => classes.has(name)
    },
    attrs: {},
    setAttribute(name, value){ this.attrs[name] = String(value); },
    title: '',
    textContent: ''
  };
  const label = { textContent: '' };
  const detail = { textContent: '' };
  sb.document = {
    getElementById(id){
      if (id === 'sync-pill') return pill;
      if (id === 'sync-pill-label') return label;
      if (id === 'sync-status-detail') return detail;
      return null;
    }
  };
  return { classes, pill, label, detail };
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

/* The saved-chart helpers in a sandbox of their own. freshSandbox() stubs
   pbLoadSaved with a raw clone, so it cannot show what the real whitelist does
   to a chart. This one runs the REAL pbLoadSaved, pbPersistSaved, the dashboard
   switch helpers and the dashboard renderer against stubbed chart sources and a
   tiny fake dashboard stack, so the onDashboard rules are tested where they live.
   opts: saveResult (what saveData returns, default true), dashboardActive and
   chartLib (default true), oldCards (chart ids already drawn on the stack). */
const CHART_SANDBOX_CONSTS = ['SAFE_ID_RE', 'PB_SERIES_MODES', 'PB_CLASS_KEYS', 'PB_PERIODS'];
const CHART_SANDBOX_FNS = [
  'kjrSafeId', 'pbSource', 'pbFields', 'pbLoadSaved', 'pbPersistSaved', 'pbSetOnDashboard',
  'pbToggleOnDashboard', 'pbRemoveFromDashboard', 'pbTogglePin', 'pbSeedDefaults',
  '_pbSavedDescriptor', '_pbDestroyChart', '_pbRenderDashCharts'
];
const CHART_SANDBOX_SRC = (() => {
  const missing = [];
  const consts = CHART_SANDBOX_CONSTS.map(n => { const s = extractConstLine(n); if (!s) missing.push(n); return s; });
  const fns = CHART_SANDBOX_FNS.map(n => { const s = extractFunction(n); if (!s) missing.push(n); return s; });
  if (missing.length){
    throw new Error('test-app.js chart sandbox could not find: ' + missing.join(', ') +
      '. This is a harness bug (the function/const moved or was renamed in Worker/app.js), not a test to drop.');
  }
  return [...consts, ...fns].join('\n\n');
})();

function chartSandbox(savedCharts, opts){
  opts = opts || {};
  const calls = { saves:0, repaints:0, toasts:[], rendered:[], destroyed:[], layouts:0, selectors:[] };
  const stack = {
    cards: [],
    querySelectorAll(selector){ calls.selectors.push(selector); return this.cards.slice(); }
  };
  const addCard = id => {
    const canvas = { id:'pb-sc-canvas-' + id };
    const card = {
      dataset: { wid:'chart:' + id },
      querySelectorAll(selector){ return selector === 'canvas' ? [canvas] : []; },
      remove(){ stack.cards = stack.cards.filter(c => c !== card); }
    };
    stack.cards.push(card);
    return card;
  };
  const sandbox = {
    DB: { settings: { savedCharts } },
    PB_SOURCES: {
      holdings:   { key:'holdings',   label:'Holdings',   kind:'holdings', fields:{ symbol:{type:'dim'}, marketValue:{type:'meas'} } },
      allocation: { key:'allocation', label:'Allocation', kind:'crosssec', fields:{ assetClass:{type:'dim'}, value:{type:'meas'} } },
      cashflow:   { key:'cashflow',   label:'Cashflow',   kind:'crosssec', fields:{ month:{type:'dim'}, income:{type:'meas'}, expense:{type:'meas'} } },
      networth:   { key:'networth',   label:'Net worth',  kind:'series' },
      cpf:        { key:'cpf',        label:'CPF',        kind:'series' }
    },
    _pbCharts: {},
    saveData: () => { calls.saves++; return opts.saveResult === undefined ? true : opts.saveResult; },
    showToast: (message, kind, action) => { calls.toasts.push({ message, kind, action }); },
    pbRenderAllSaved: () => { calls.repaints++; },
    document: { getElementById: id => (id === 'dash-stack' ? stack : null) },
    _isPageActive: key => key === 'dashboard' && opts.dashboardActive !== false,
    buildStockChartRows: () => [],
    _pbRenderOneSaved: cfg => { calls.rendered.push(cfg.id); addCard(cfg.id); },
    _applyDashLayout: () => { calls.layouts++; }
  };
  if (opts.chartLib !== false) sandbox.Chart = function Chart(){};
  (opts.oldCards || []).forEach(id => {
    addCard(id);
    sandbox._pbCharts['pb-sc-canvas-' + id] = { destroy(){ calls.destroyed.push(id); } };
  });
  vm.createContext(sandbox);
  vm.runInContext(CHART_SANDBOX_SRC, sandbox, { filename: 'app.js (chart helpers)' });
  sandbox.calls = calls;
  sandbox.stack = stack;
  return sandbox;
}

async function runTests(){
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

  async function testAsync(name, fn){
    try {
      await fn();
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

  test('cash ledger - mismatched linked trade stays legacy-unconverted but reconciliation flags it', () => {
    const sb = freshSandbox({
      stocks:[{id:'s1',symbol:'USDCO',market:'US',currency:'USD',shares:0,avgCost:0}],
      cash:[{id:'c1',name:'SGD cash',account:'Brokerage',amount:1000,currency:'SGD'}],
      stockTxns:[{id:'t1',stockId:'s1',cashAccountId:'c1',side:'buy',shares:1,price:100,fees:0,date:'2026-01-01'}],
      cashTxns:[]
    });
    assert.deepStrictEqual(JSON.parse(JSON.stringify(sb.linkedTradeCurrencyMismatch(sb.DB.stockTxns[0]))), {
      stockCcy:'USD', accountCcy:'SGD', accountName:'SGD cash'
    });
    assert.strictEqual(sb.deriveCashBalance(sb.DB.cash[0]), 900);
    const rec = sb.runReconciliation();
    assert.strictEqual(rec.ok, false);
    assert.strictEqual(Array.from(rec.issues).some(x => /different currency/.test(x.msg)), true);
  });

  test('cash ledger - same-currency linked trade remains exact and clean', () => {
    const sb = freshSandbox({
      stocks:[{id:'s1',symbol:'SGDCO',market:'SGX',currency:'SGD',shares:0,avgCost:0}],
      cash:[{id:'c1',name:'SGD cash',account:'Brokerage',amount:1000,currency:'SGD'}],
      stockTxns:[{id:'t1',stockId:'s1',cashAccountId:'c1',side:'buy',shares:1,price:100,fees:5,date:'2026-01-01'}],
      cashTxns:[]
    });
    assert.strictEqual(sb.linkedTradeCurrencyMismatch(sb.DB.stockTxns[0]), null);
    assert.strictEqual(sb.deriveCashBalance(sb.DB.cash[0]), 895);
    assert.strictEqual(sb.runReconciliation().ok, true);
  });

  test('cash ledger - cross-currency transfer needs amountIn, same-currency transfer does not', () => {
    const base = {
      cash:[{id:'sgd',currency:'SGD'},{id:'usd',currency:'USD'}], stocks:[], stockTxns:[], cashTxns:[]
    };
    const sb = freshSandbox(base);
    assert.strictEqual(sb.crossCurrencyTransferMissingAmount({type:'transfer',fromAccountId:'sgd',cashAccountId:'usd',amount:100}), true);
    assert.strictEqual(sb.crossCurrencyTransferMissingAmount({type:'transfer',fromAccountId:'sgd',cashAccountId:'usd',amount:100,amountIn:75}), false);
    assert.strictEqual(sb.crossCurrencyTransferMissingAmount({type:'transfer',fromAccountId:'sgd',cashAccountId:'sgd',amount:100}), false);
    sb.DB.cashTxns = [{id:'x1',type:'transfer',fromAccountId:'sgd',cashAccountId:'usd',amount:100}];
    const rec = sb.runReconciliation();
    assert.strictEqual(rec.ok, false);
    assert.strictEqual(Array.from(rec.issues).some(x => /missing Amount received/.test(x.msg)), true);
  });

  test('entity save - new mismatched cash legs are blocked and persistence success is awaited before acknowledgement', () => {
    const src = extractFunction('entityModalSave');
    assert.ok(src.indexOf('linkedTradeCurrencyMismatch(item)') < src.indexOf('pushUndo()'));
    assert.strictEqual(src.includes('Link anyway?'), false);
    assert.ok(src.indexOf('await Promise.resolve(saveData())') < src.indexOf('closeEntityModal()'));
    assert.ok(src.indexOf('if (!saved)') < src.indexOf("showToast(rowWasGone"));
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

  /* ═══ Dashboard market-value disclosure ═══ */

  test('_stockMvSGDInfo - quantifies positions valued at cost when a live quote is missing', () => {
    const sb = freshSandbox({
      settings: { fxRates: { USDSGD: 1.35 }, fxOverrides: {} },
      stocks: [
        { id:'quoted', symbol:'AAPL', shares:2, avgCost:100, currency:'USD' },
        { id:'estimated', symbol:'MSFT', shares:3, avgCost:50, currency:'USD' }
      ],
      _priceCache: { AAPL:{ price:120, currency:'USD' } }
    });
    const info = sb._stockMvSGDInfo();
    assert.strictEqual(info.total, (2 * 120 + 3 * 50) * 1.35);
    assert.strictEqual(info.estimatedCount, 1);
    assert.strictEqual(info.estimatedAmount, 3 * 50 * 1.35);
  });

  test('_stockMvSGDInfo - zero-quantity rows do not inflate the estimate count', () => {
    const sb = freshSandbox({
      stocks: [{ id:'zero', symbol:'ZERO', shares:0, avgCost:100, currency:'USD' }],
      _priceCache: {}
    });
    const info = sb._stockMvSGDInfo();
    assert.strictEqual(info.total, 0);
    assert.strictEqual(info.estimatedCount, 0);
    assert.strictEqual(info.estimatedAmount, 0);
  });

  test('_cryptoSGDInfo - keeps headline useful and quantifies the cost-basis portion', () => {
    const sb = freshSandbox({
      settings: { fxRates: { USDSGD: 1.35 }, fxOverrides: {} },
      crypto: [
        { id:'btc', coingeckoId:'bitcoin', amount:2, avgCost:10000, currency:'USD' },
        { id:'eth', coingeckoId:'ethereum', amount:3, avgCost:1000, currency:'USD' }
      ],
      _priceCache: { bitcoin:{ sgd:20000 } }
    });
    const info = sb._cryptoSGDInfo();
    assert.strictEqual(info.total, core.roundMoney(40000 + 3 * 1000 * 1.35));
    assert.strictEqual(info.estimatedCount, 1);
    assert.strictEqual(info.estimatedAmount, core.roundMoney(3 * 1000 * 1.35));
  });

  test('_cryptoSGDInfo - zero-balance rows do not inflate the estimate count', () => {
    const sb = freshSandbox({
      crypto: [{ id:'zero', coingeckoId:'zero-coin', amount:0, avgCost:1000, currency:'USD' }],
      _priceCache: {}
    });
    const info = sb._cryptoSGDInfo();
    assert.strictEqual(info.total, 0);
    assert.strictEqual(info.estimatedCount, 0);
    assert.strictEqual(info.estimatedAmount, 0);
  });

  /* ═══ Lossless cloud acknowledgement ═══ */

  test('_lossyAckReason - rejects stripped keys and either form of truncation', () => {
    const sb = freshSandbox();
    assert.strictEqual(sb._lossyAckReason({ ok:true, savedAt:'x' }), '');
    assert.match(sb._lossyAckReason({ strippedKeys:['insurance'] }), /insurance/);
    assert.match(sb._lossyAckReason({ truncated:true }), /truncated/);
    assert.match(sb._lossyAckReason({ truncatedPaths:['insurance[0].notes'] }), /insurance\[0\]\.notes/);
  });

  test('_rejectLossyAck - fails the sync and persists a pull/write safety block', () => {
    const sb = freshSandbox();
    const states = [];
    sb.setSyncStatus = (state, detail) => states.push({ state, detail });
    assert.strictEqual(sb._rejectLossyAck({ ok:true, strippedKeys:['insurance'] }), true);
    assert.strictEqual(sb.localStorage.getItem('kjr-pf-lossy-sync-block-v1'), '1');
    assert.strictEqual(states.length, 1);
    assert.strictEqual(states[0].state, 'failed');
    assert.match(states[0].detail, /Export a backup/);
    assert.match(states[0].detail, /review field limits if current/);
    const stored = JSON.parse(sb.localStorage.getItem('kjr-pf-sync-diagnostics-v1'));
    assert.deepStrictEqual(stored.writeFailure.strippedKeys, ['insurance']);
    assert.strictEqual(stored.writeFailure.code, 'lossy_ack');
    const pushSrc = extractFunction('pushToRemote');
    const rejectAt = pushSrc.indexOf('if (_rejectLossyAck(data)) return false;');
    const acceptedStampAt = pushSrc.indexOf('const serverStamp = data.savedAt', rejectAt);
    assert.ok(rejectAt >= 0 && acceptedStampAt > rejectAt);
  });

  test('sync diagnostics - allowlisted paths stay bounded and truthy legacy truncation remains blocked', () => {
    const sb = freshSandbox();
    assert.strictEqual(sb._syncDiagPath('insurance[12].notes'), 'insurance[12].notes');
    assert.strictEqual(sb._syncDiagPath('insurance[12].privateToken'), null);
    assert.strictEqual(sb._syncDiagPath('privateTable[0].notes'), null);
    for (const marker of [true, 'true', 1]) {
      const details = sb._syncDiagLossy({ truncated: marker });
      assert.ok(details, 'truthy marker should remain a lossy acknowledgement');
      assert.strictEqual(details.truncated, true);
    }
    const details = sb._syncDiagLossy({
      strippedKeys: ['insurance', 'privateToken', 'stocks.secret', 'insurance'],
      truncatedPaths: ['insurance[0].notes', 'insurance[0].privateToken', 'cash[999].amount']
    });
    assert.deepStrictEqual(Array.from(details.strippedKeys), ['insurance', 'stocks']);
    assert.deepStrictEqual(Array.from(details.truncatedPaths), ['insurance[0].notes', 'cash[999].amount']);
    assert.strictEqual(details.counts.stripped, 4);
    assert.strictEqual(details.counts.truncated, 3);
  });

  test('sync diagnostics - stored timestamps accept canonical ISO values only', () => {
    const sb = freshSandbox();
    assert.strictEqual(sb._isCanonicalServerTimestamp('2026-09-18T12:34:56.789Z'), true);
    assert.strictEqual(sb._isCanonicalServerTimestamp('2026-09-18T12:34:56Z'), false);
    assert.strictEqual(sb._isCanonicalServerTimestamp('2026-99-99T12:34:56.789Z'), false);
    assert.strictEqual(sb._syncDiagRecordSafe({ code:'write_failed', at:'2026-09-18T12:34:56Z' }).at, undefined);
    assert.strictEqual(sb._syncDiagRecordSafe({ code:'write_failed', at:'2026-09-18T12:34:56.789Z' }).at, '2026-09-18T12:34:56.789Z');
  });

  test('sync details timestamps display as Singapore local time and reject unsafe values', () => {
    const sb = freshSandbox();
    assert.strictEqual(sb._displaySyncTimestamp('2026-09-18T00:34:56.789Z'), '18/09/2026 08:34:56 SGT');
    assert.strictEqual(sb._displaySyncTimestamp('legacy-contact'), '');
    assert.strictEqual(sb._displaySyncTimestamp('2026-09-18T00:34:56Z'), '');
  });

  test('sync diagnostics - read and write failures clear independently and retain safe detail in memory', () => {
    const sb = freshSandbox();
    sb._recordSyncFailure('write', 'backend_error', { status: 422 });
    sb._recordSyncFailure('read', 'read_failed');
    let stored = JSON.parse(sb.localStorage.getItem('kjr-pf-sync-diagnostics-v1'));
    assert.strictEqual(stored.writeFailure.code, 'backend_error');
    assert.strictEqual(stored.writeFailure.status, 422);
    assert.strictEqual(stored.readFailure.code, 'read_failed');
    assert.strictEqual(sb._clearSyncDiagnostic('write'), true);
    stored = JSON.parse(sb.localStorage.getItem('kjr-pf-sync-diagnostics-v1'));
    assert.strictEqual(stored.writeFailure, undefined);
    assert.strictEqual(stored.readFailure.code, 'read_failed');

    sb.protectedStorage.setItem = () => { throw new Error('diagnostics unavailable'); };
    sb._recordSyncFailure('write', 'payload_limit');
    assert.strictEqual(sb._syncDiagnosticsStorageFailed, true);
    assert.strictEqual(sb._readSyncDiagnostics().writeFailure.code, 'payload_limit');
    assert.strictEqual(sb._clearSyncDiagnostic('write'), false);
    assert.strictEqual(sb._readSyncDiagnostics().readFailure.code, 'read_failed');
  });

  test('sync status - pre-upgrade recorded contact stays synced while confirmed time remains unknown', () => {
    const sb = freshSandbox();
    const ui = installSyncStatusDom(sb);
    sb.localStorage.setItem('kjr-pf-sync-ts-v1', 'legacy-contact');
    sb.updateSyncStatusPill();
    assert.strictEqual(ui.label.textContent, 'Synced');
    assert.strictEqual(ui.classes.has('s-synced'), true);
    assert.strictEqual(sb._syncDetailsModel().confirmedAt, 'Unknown');
    assert.strictEqual(sb._syncDetailsModel().failureAt, 'None recorded');
  });

  test('sync status - diagnostic storage failure alone stays secondary to local status', () => {
    const sb = freshSandbox();
    const ui = installSyncStatusDom(sb);
    sb.protectedStorage = { getItem(){ throw new Error('diagnostics unavailable'); } };
    sb.updateSyncStatusPill();
    assert.strictEqual(ui.label.textContent, 'Local only');
    assert.strictEqual(ui.classes.has('s-failed'), false);
    assert.match(sb._syncDetailsModel().technical, /could not be saved/);
  });

  test('sync status - an unresolved read failure prevents a green synced pill', () => {
    const sb = freshSandbox();
    const ui = installSyncStatusDom(sb);
    sb._recordSyncFailure('read', 'read_failed');
    sb.setSyncStatus('synced');
    assert.strictEqual(ui.label.textContent, 'Sync failed');
    assert.strictEqual(ui.classes.has('s-failed'), true);
  });

  test('sync details - active syncing keeps a dirty queue in progress, idle dirty state is queued', () => {
    const sb = freshSandbox();
    const ui = installSyncStatusDom(sb);
    sb._markCloudDirty();
    sb._syncStatusState = 'syncing';
    assert.strictEqual(sb._syncDetailsModel().state, 'syncing');
    sb._syncStatusState = 'local';
    assert.strictEqual(sb._syncDetailsModel().state, 'queued');
    sb.updateSyncStatusPill();
    assert.strictEqual(ui.label.textContent, 'Queued');
    assert.strictEqual(ui.classes.has('s-queued'), true);
  });

  test('sync status and details - lossy marker exposes concise pull block labels', () => {
    const sb = freshSandbox();
    const ui = installSyncStatusDom(sb);
    sb.localStorage.setItem('kjr-pf-lossy-sync-block-v1', 'legacy-marker-without-details');
    sb.updateSyncStatusPill();
    assert.strictEqual(ui.label.textContent, 'Pull blocked');
    const model = sb._syncDetailsModel();
    assert.strictEqual(model.state, 'pull-blocked');
    assert.match(model.action, /If it is current, review the reported fields and their limits/);
  });

  test('apps-script sanitiser round-trips Insurance tables and reports array caps', () => {
    const allowed = appsScriptSrc.match(/const ALLOWED_KEYS\s*=\s*\{[\s\S]*?\n\};/);
    const arrayCap = appsScriptSrc.match(/const MAX_ARRAY_LEN\s*=\s*\d+[^\n]*;/);
    const stringCap = appsScriptSrc.match(/const MAX_STRING_LEN\s*=\s*\d+[^\n]*;/);
    assert.ok(allowed && arrayCap && stringCap, 'Apps Script sanitiser constants must stay extractable');
    const truncateFn = extractFunction('truncateStringsDeep_', appsScriptSrc);
    const sanitiseFn = extractFunction('sanitisePayload_', appsScriptSrc);
    assert.ok(truncateFn && sanitiseFn, 'Apps Script sanitiser functions must stay extractable');
    const gs = {};
    vm.createContext(gs);
    vm.runInContext([allowed[0], arrayCap[0], stringCap[0], truncateFn, sanitiseFn,
      'this.runSanitise = sanitisePayload_;'].join('\n'), gs, { filename:'apps-script.gs (extracted)' });
    const payload = {
      schema:'kujira-portfolio-v1',
      insurance:[{ id:'p1', provider:'AIA', notes:'kept' }],
      insuranceRiders:[{ id:'r1', policyId:'p1', name:'CI rider' }]
    };
    const result = gs.runSanitise(payload);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(result.clean.insurance)), payload.insurance);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(result.clean.insuranceRiders)), payload.insuranceRiders);
    assert.deepStrictEqual(Array.from(result.strippedKeys), []);
    assert.deepStrictEqual(Array.from(result.truncatedPaths), []);

    const oversized = Object.assign({}, payload, { insurance: Array.from({length:5001}, (_,i) => ({id:'p'+i})) });
    const capped = gs.runSanitise(oversized);
    assert.strictEqual(capped.clean.insurance.length, 5000);
    assert.strictEqual(Array.from(capped.truncatedPaths).includes('insurance'), true);
  });

  test('apps-script doPost fails closed before persisting a lossy sanitised payload', () => {
    const doPost = extractFunction('doPost', appsScriptSrc);
    assert.ok(doPost);
    const rejectAt = doPost.indexOf('if (strippedKeys.length || truncatedPaths.length)');
    const writeAt = doPost.indexOf('writePayloadRaw_(sh');
    assert.ok(rejectAt >= 0 && writeAt > rejectAt, 'lossy rejection must precede writePayloadRaw_');
  });

  /* ═══ Canonical backup envelope and durable local persistence ═══ */

  test('backup export-import-sync - envelope is exported but never becomes canonical data', () => {
    const sb = freshSandbox({
      stocks:[{id:'s1',symbol:'SAFE'}], settings:{salary:{},tax:{},fxOverrides:{},fxRates:{}},
      _priceCache:{SAFE:{price:10}}, futureFinancialField:{kept:true}
    });
    const exported = sb.backupExportPayload();
    assert.strictEqual(exported._backup.app, 'kujira-portfolio');
    assert.strictEqual('_priceCache' in exported, false);
    sb.DB = exported;
    const canonical = sb.localPersistPayload();
    const synced = sb.syncPayload();
    assert.strictEqual('_backup' in canonical, false);
    assert.strictEqual('_backup' in synced, false);
    assert.strictEqual('_priceCache' in synced, false);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(synced.futureFinancialField)), {kept:true});
  });

  test('saveData - native storage failure stays visibly unsaved and queues no cloud write', () => {
    const sb = freshSandbox();
    const states = [];
    let timerCalls = 0;
    sb.saveLocal = () => false;
    sb.setSyncStatus = (state, detail) => states.push({state, detail});
    sb.setTimeout = () => { timerCalls++; return 1; };
    assert.strictEqual(sb.saveData(), false);
    assert.strictEqual(sb._hasLocalUnsaved(), true);
    assert.strictEqual(sb.localStorage.getItem('kjr-pf-unsaved-v1'), '1');
    assert.strictEqual(timerCalls, 0);
    assert.strictEqual(states.at(-1).state, 'failed');
  });

  test('saveData - in-memory warning survives when even the marker storage is unavailable', () => {
    const sb = freshSandbox();
    sb.localStorage.setItem = () => { throw new Error('storage disabled'); };
    sb.localStorage.getItem = () => { throw new Error('storage disabled'); };
    sb.saveLocal = () => false;
    assert.strictEqual(sb.saveData(), false);
    assert.strictEqual(sb._hasLocalUnsaved(), true);
  });

  test('saveData - a failed newer save cancels the older cloud debounce', () => {
    const sb = freshSandbox();
    let nextTimer = 0, cancelled = null;
    sb.setTimeout = () => ++nextTimer;
    sb.clearTimeout = id => { cancelled = id; };
    assert.strictEqual(sb.saveData(), true);
    assert.strictEqual(sb._syncTimer, 1);
    sb.saveLocal = () => false;
    assert.strictEqual(sb.saveData(), false);
    assert.strictEqual(cancelled, 1);
    assert.strictEqual(sb._syncTimer, null);
    assert.strictEqual(sb._hasLocalUnsaved(), true);
  });

  await testAsync('saveData - stale vault completion cannot clear or sync a newer edit', async () => {
    const sb = freshSandbox();
    sb.getSyncUrl = () => '';
    const resolvers = [];
    sb._vaultManager = {
      isEnabled: () => true,
      flush: () => new Promise(resolve => resolvers.push(resolve))
    };
    const first = sb.saveData();
    const second = sb.saveData();
    resolvers[0](true);
    assert.strictEqual(await first, false);
    assert.strictEqual(sb._hasLocalUnsaved(), true);
    resolvers[1](true);
    assert.strictEqual(await second, true);
    assert.strictEqual(sb._hasLocalUnsaved(), false);
  });

  /* ═══ Pull serialisation against delayed and failed pushes ═══ */

  await testAsync('pushToRemote - preview guard preserves cloud-dirty state and makes no request', async () => {
    const sb = freshSandbox();
    sb._markCloudDirty();
    sb.isLocalPreview = () => true;
    let requests = 0;
    sb.fetch = async () => { requests++; throw new Error('must not fetch'); };
    assert.strictEqual(await sb.pushToRemote(), false);
    assert.strictEqual(requests, 0);
    assert.strictEqual(sb._hasCloudDirty(), true);
  });

  await testAsync('pullFromRemote - preview guard preserves dirty and lossy markers and makes no request', async () => {
    const sb = freshSandbox();
    const ui = installSyncStatusDom(sb);
    sb._markCloudDirty();
    sb.localStorage.setItem('kjr-pf-lossy-sync-block-v1', '1');
    sb.isLocalPreview = () => true;
    let requests = 0;
    sb.fetch = async () => { requests++; throw new Error('must not fetch'); };
    assert.strictEqual(await sb.pullFromRemote(), false);
    assert.strictEqual(requests, 0);
    assert.strictEqual(sb._hasCloudDirty(), true);
    assert.strictEqual(sb.localStorage.getItem('kjr-pf-lossy-sync-block-v1'), '1');
    assert.strictEqual(ui.label.textContent, 'Pull blocked');
  });

  await testAsync('pullFromRemote - a completed failed POST is retried before pull in both conflict modes', async () => {
    for (const strict of ['0','1']) {
      const sb = freshSandbox({stocks:[{id:'local',symbol:'LOCAL'}]});
      sb.localStorage.setItem('kjr-pf-strict-conflicts-v1', strict);
      sb._localSaveRevision = 1;
      sb._markCloudDirty();
      let posts = 0, gets = 0;
      let remote = {schema:'kujira-portfolio',stocks:[{id:'remote-old',symbol:'OLD'}]};
      sb.fetch = async (_url, request) => {
        if (request && request.method === 'POST') {
          posts++;
          if (posts === 1) return {status:503,text:async () => JSON.stringify({error:'offline'})};
          remote = JSON.parse(request.body);
          return {status:200,text:async () => JSON.stringify({ok:true,savedAt:'2026-10-03T00:00:02.000Z'})};
        }
        gets++;
        return {json:async () => Object.assign({}, remote, {_savedAt:'server-2'})};
      };
      assert.strictEqual(await sb.pushToRemote(), false);
      assert.strictEqual(sb._hasCloudDirty(), true);
      assert.strictEqual(await sb.pullFromRemote(), true);
      assert.strictEqual(posts, 2);
      assert.strictEqual(gets, 1);
      assert.strictEqual(sb._hasCloudDirty(), false);
      assert.strictEqual(sb.DB.stocks[0].id, 'local');
    }
  });

  await testAsync('pullFromRemote - explicit conflict discard may replace a cloud-dirty local copy', async () => {
    const sb = freshSandbox({stocks:[{id:'local',symbol:'LOCAL'}]});
    sb._markCloudDirty();
    let posts = 0, gets = 0;
    sb.fetch = async (_url, request) => {
      if (request && request.method === 'POST') { posts++; throw new Error('must not post'); }
      gets++;
      return {json:async () => ({schema:'kujira-portfolio',_savedAt:'server-3',stocks:[{id:'remote',symbol:'REMOTE'}]})};
    };
    assert.strictEqual(await sb.pullFromRemote({discardLocalChanges:true}), true);
    assert.strictEqual(posts, 0);
    assert.strictEqual(gets, 1);
    assert.strictEqual(sb._hasCloudDirty(), false);
    assert.strictEqual(sb.DB.stocks[0].id, 'remote');
  });

  await testAsync('pullFromRemote - waits for active push, then applies server-stamped data', async () => {
    const sb = freshSandbox({stocks:[{id:'local',symbol:'LOCAL'}], _priceCache:{LOCAL:{price:1}}});
    let finishPush;
    const active = new Promise(resolve => { finishPush = resolve; });
    sb._activeSyncCompletions.add(active);
    let gets = 0;
    sb.fetch = async () => {
      gets++;
      return { json:async () => ({schema:'kujira-portfolio',_savedAt:'server-2',stocks:[{id:'remote',symbol:'REMOTE'}],_priceCache:{}}) };
    };
    const pulling = sb.pullFromRemote();
    await Promise.resolve();
    assert.strictEqual(gets, 0);
    finishPush(true);
    assert.strictEqual(await pulling, true);
    assert.strictEqual(gets, 1);
    assert.strictEqual(sb.DB.stocks[0].id, 'remote');
    assert.strictEqual(sb.localStorage.getItem('kjr-pf-last-pull-v1'), 'server-2');
    assert.strictEqual(sb.localStorage.getItem('kjr-pf-last-pull-src-v1'), 'server');
  });

  await testAsync('pullFromRemote - failed active push preserves local data in both conflict modes', async () => {
    for (const strict of ['0','1']) {
      const sb = freshSandbox({stocks:[{id:'local',symbol:'LOCAL'}]});
      sb.localStorage.setItem('kjr-pf-strict-conflicts-v1', strict);
      sb._activeSyncCompletions.add(Promise.resolve(false));
      let gets = 0;
      sb.fetch = async () => { gets++; throw new Error('must not fetch'); };
      assert.strictEqual(await sb.pullFromRemote(), false);
      assert.strictEqual(gets, 0);
      assert.strictEqual(sb.DB.stocks[0].id, 'local');
    }
  });

  await testAsync('pullFromRemote - edit arriving during GET is pushed and cloud is re-read once', async () => {
    const sb = freshSandbox({stocks:[{id:'local',symbol:'LOCAL'}]});
    let finishFirstGet;
    let gets = 0, pushes = 0;
    sb.pushToRemote = async () => { pushes++; return true; };
    sb.fetch = async () => {
      gets++;
      if (gets === 1) return { json:() => new Promise(resolve => { finishFirstGet = resolve; }) };
      return { json:async () => ({schema:'kujira-portfolio',_savedAt:'server-new',stocks:[{id:'new',symbol:'NEW'}]}) };
    };
    const pulling = sb.pullFromRemote();
    while (!finishFirstGet) await Promise.resolve();
    sb._localSaveRevision++;
    sb._syncTimer = 9;
    finishFirstGet({schema:'kujira-portfolio',_savedAt:'server-old',stocks:[{id:'old',symbol:'OLD'}]});
    assert.strictEqual(await pulling, true);
    assert.strictEqual(pushes, 1);
    assert.strictEqual(gets, 2);
    assert.strictEqual(sb.DB.stocks[0].id, 'new');
    assert.strictEqual(sb.localStorage.getItem('kjr-pf-last-pull-v1'), 'server-new');
  });

  await testAsync('pullFromRemote - vault persistence is awaited and rejection cannot report synced', async () => {
    for (const reject of [false, true]) {
      const sb = freshSandbox({stocks:[{id:'local'}],_priceCache:{}});
      let finishFlush, settled = false;
      sb._vaultManager = {
        isEnabled: () => true,
        flush: () => new Promise((resolve, rejectFlush) => { finishFlush = reject ? () => rejectFlush(new Error('vault failed')) : resolve; })
      };
      const states = [];
      sb.setSyncStatus = state => states.push(state);
      sb.fetch = async () => ({json:async()=>({schema:'kujira-portfolio',_savedAt:'server-vault',stocks:[{id:'remote'}]})});
      const pulling = sb.pullFromRemote().then(result => { settled = true; return result; });
      while (!finishFlush) await Promise.resolve();
      assert.strictEqual(settled, false);
      assert.strictEqual(states.includes('synced'), false);
      finishFlush(true);
      assert.strictEqual(await pulling, !reject);
      assert.strictEqual(states.includes('synced'), !reject);
      assert.strictEqual(sb._hasLocalUnsaved(), reject);
    }
  });

  await testAsync('pullFromRemote - edit during vault flush is revision-gated and re-read once', async () => {
    const sb = freshSandbox({stocks:[{id:'local'}],_priceCache:{}});
    let finishOldFlush, flushes = 0, gets = 0;
    sb._vaultManager = {
      isEnabled: () => true,
      flush: () => {
        flushes++;
        return flushes === 1 ? new Promise(resolve => { finishOldFlush = resolve; }) : Promise.resolve(true);
      }
    };
    sb.fetch = async () => {
      gets++;
      return {json:async()=>({schema:'kujira-portfolio',_savedAt:'server-'+gets,stocks:[{id:'remote-'+gets}]})};
    };
    const pulling = sb.pullFromRemote();
    while (!finishOldFlush) await Promise.resolve();
    sb._localSaveRevision++;
    sb._markLocalUnsaved();
    let finishNewSave;
    const newerSave = new Promise(resolve => { finishNewSave = () => {
      sb._clearLocalUnsaved(sb._localSaveRevision);
      sb._activeLocalSave = null;
      resolve(true);
    }; });
    sb._activeLocalSave = newerSave;
    finishOldFlush(true);
    await Promise.resolve();
    assert.strictEqual(sb._hasLocalUnsaved(), true);
    finishNewSave();
    assert.strictEqual(await pulling, true);
    assert.strictEqual(gets, 2);
    assert.strictEqual(sb.DB.stocks[0].id, 'remote-2');
  });

  /* ═══ Trash restore schema validation ═══ */

  function installStockRestoreSchema(sb){
    sb.ENTITY_SCHEMAS = { stocks:{
      fields:[
        {key:'symbol',label:'Symbol',type:'text',required:true},
        {key:'market',label:'Market',type:'select',required:true,options:[['US','US'],['SGX','SGX']],default:'US'},
        {key:'shares',label:'Shares',type:'number',required:true,min:'0'},
        {key:'avgCost',label:'Avg cost',type:'number',required:true,min:'0'},
        {key:'notes',label:'Notes',type:'textarea'}
      ],
      afterRead:item => { item.symbol = (item.symbol || '').trim().toUpperCase(); }
    } };
  }

  test('normaliseEntityRow - rejects structural numeric values and ignores unsafe or inherited keys', () => {
    const sb = freshSandbox();
    installStockRestoreSchema(sb);
    const hostile = JSON.parse('{"id":"s1","symbol":"SAFE","market":"US","shares":[],"avgCost":10,"__proto__":{"polluted":true}}');
    assert.strictEqual(sb.normaliseEntityRow('stocks', hostile).ok, false);
    const inherited = Object.create({shares:99});
    Object.assign(inherited, {id:'s2',symbol:'SAFE',market:'US',avgCost:10});
    assert.strictEqual(sb.normaliseEntityRow('stocks', inherited).ok, false);
    assert.strictEqual({}.polluted, undefined);
  });

  test('_sanitiseList - imported trash copies only inert own data until restore', () => {
    const sb = freshSandbox();
    const hostile = JSON.parse('[{"id":"tr1","table":"stocks","data":{"id":"s1","symbol":"<img src=x onerror=alert(1)>","shares":[],"avgCost":10,"__proto__":{"polluted":true}}}]');
    const rows = sb._sanitiseList(hostile, 'trash');
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(rows[0].data, '__proto__'), false);
    assert.strictEqual(rows[0].data.symbol, '<img src=x onerror=alert(1)>');
    assert.strictEqual({}.polluted, undefined);
    assert.ok(extractFunction('renderTrash').includes('kjrEscape(trashLabel(e.table, e.data))'));
    assert.ok(appSrc.includes('${kjrEscape(r.shares)}<span class="hint"'));
  });

  await testAsync('restoreFromTrash - malformed row is rejected without consuming trash or saving', async () => {
    const sb = freshSandbox({
      stocks:[],
      trash:[{id:'tr1',table:'stocks',data:{id:'s1',symbol:'<img>',market:'US',shares:{value:1},avgCost:10}}]
    });
    installStockRestoreSchema(sb);
    let saves = 0;
    sb.saveData = () => { saves++; return true; };
    assert.strictEqual(await sb.restoreFromTrash('tr1'), false);
    assert.strictEqual(saves, 0);
    assert.strictEqual(sb.DB.stocks.length, 0);
    assert.strictEqual(sb.DB.trash.length, 1);
  });

  await testAsync('restoreFromTrash - valid row is normalised, persisted and acknowledged', async () => {
    const sb = freshSandbox({
      stocks:[],
      trash:[{id:'tr1',table:'stocks',data:{id:'s1',symbol:'safe',market:'US',shares:'2',avgCost:'10',notes:'<b>literal</b>',legacyCode:'kept'}}]
    });
    installStockRestoreSchema(sb);
    const toasts = [];
    sb.saveData = () => true;
    sb.showToast = (message, kind) => toasts.push({message, kind});
    assert.strictEqual(await sb.restoreFromTrash('tr1'), true);
    assert.strictEqual(sb.DB.trash.length, 0);
    assert.strictEqual(sb.DB.stocks[0].symbol, 'SAFE');
    assert.strictEqual(sb.DB.stocks[0].shares, 2);
    assert.strictEqual(sb.DB.stocks[0].notes, '<b>literal</b>');
    assert.strictEqual(sb.DB.stocks[0].legacyCode, 'kept');
    assert.deepStrictEqual(toasts.at(-1), {message:'Restored',kind:'success'});
  });

  await testAsync('entityModalSave - pending save blocks duplicates and failed persistence stays retryable', async () => {
    const sb = freshSandbox({stocks:[],trash:[]});
    installStockRestoreSchema(sb);
    const values = {symbol:'safe',market:'US',shares:'2',avgCost:'10',notes:'note'};
    sb.document = { getElementById:id => id === 'em-body' ? {
      querySelector: selector => {
        const match = selector.match(/data-fkey="([^"]+)"/);
        return match ? {value:values[match[1]] == null ? '' : values[match[1]]} : null;
      }
    } : null };
    sb._modalState = {table:'stocks',item:{id:'s1'},isNew:true};
    let resolveSave;
    sb.saveData = () => new Promise(resolve => { resolveSave = resolve; });
    const first = sb.entityModalSave();
    assert.strictEqual(await sb.entityModalSave(), false);
    assert.strictEqual(sb.DB.stocks.length, 1);
    resolveSave(false);
    assert.strictEqual(await first, false);
    assert.strictEqual(sb.DB.stocks.length, 1);
    assert.strictEqual(sb._modalState.isNew, false);
    sb.saveData = () => true;
    assert.strictEqual(await sb.entityModalSave(), true);
    assert.strictEqual(sb.DB.stocks.length, 1);
  });

  await testAsync('entityModalDelete - pending delete blocks duplicates and cannot close a newer modal', async () => {
    const sb = freshSandbox({stocks:[{id:'s1'}],stockTxns:[],cashTxns:[],trash:[]});
    const oldModal = {table:'stocks',item:{id:'s1'},isNew:false};
    const newModal = {table:'cash',item:{id:'c1'},isNew:true};
    sb._modalState = oldModal;
    let finishDelete, deletes = 0, closes = 0;
    sb.sendToTrash = () => { deletes++; return new Promise(resolve => { finishDelete = resolve; }); };
    sb.closeEntityModal = () => { closes++; sb._modalState = null; };
    const deleting = sb.entityModalDelete();
    assert.strictEqual(await sb.entityModalDelete(), false);
    assert.strictEqual(deletes, 1);
    sb._modalState = newModal;
    finishDelete(true);
    assert.strictEqual(await deleting, true);
    assert.strictEqual(closes, 0);
    assert.strictEqual(sb._modalState, newModal);
  });

  test('mutation handlers - false persistence cannot reach Saved, Deleted or Imported acknowledgements', () => {
    ['entityModalSave','entityModalDelete','restoreFromTrash','purgeTrashItem','emptyTrash','ibkrConfirmImport','insuranceImportConfirm'].forEach(name => {
      const src = extractFunction(name);
      assert.ok(src.includes('await Promise.resolve('), name + ' must await persistence');
    });
    const importSrc = extractFunction('importBackupFromFile');
    assert.ok(importSrc.includes('const saved = await Promise.resolve(saveData())'));
    assert.ok(importSrc.indexOf('if (!saved)') < importSrc.indexOf("showToast('Backup imported"));
  });

  await testAsync('Chart Builder - persistence keeps current state across failed and interleaved saves', async () => {
    const sb = freshSandbox({settings:{savedCharts:[],salary:{},tax:{},fxOverrides:{},fxRates:{}}});
    const toasts = [];
    sb.showToast = (message, kind) => toasts.push({message, kind});
    let finishSave, saves = 0;
    sb.saveData = () => { saves++; return new Promise(resolve => { finishSave = resolve; }); };
    const adding = sb.pbSaveChart();
    assert.strictEqual(await sb.pbSaveChart(), false);
    assert.strictEqual(saves, 1);
    assert.strictEqual(sb.DB.settings.savedCharts.length, 1);
    finishSave(false);
    assert.strictEqual(await adding, false);
    assert.strictEqual(toasts.some(t => t.message === 'Chart added to dashboard'), false);

    sb.DB.settings.savedCharts = [{id:'c1',title:'One',pinned:false}];
    sb.prompt = () => 'Added during pin';
    let finishPin;
    saves = 0;
    sb.saveData = () => ++saves === 1 ? new Promise(resolve => { finishPin = resolve; }) : true;
    const pinning = sb.pbTogglePin('c1');
    assert.strictEqual(await sb.pbSaveChart(), true);
    finishPin(false);
    assert.strictEqual(await pinning, false);
    assert.strictEqual(sb.DB.settings.savedCharts.find(c => c.id === 'c1').pinned, true);
    assert.strictEqual(sb.DB.settings.savedCharts.some(c => c.title === 'Added during pin'), true);
    assert.strictEqual(toasts.some(t => /pinned|unpinned/.test(t.message)), false);

    sb.DB.settings.savedCharts = [{id:'c2',title:'Two',pinned:false}];
    let confirmDelete;
    sb._pbConfirm = (_message, onYes) => { confirmDelete = onYes; };
    sb.pbDeleteSaved('c2');
    sb.prompt = () => 'Added before confirm';
    sb.saveData = () => true;
    assert.strictEqual(await sb.pbSaveChart(), true);
    assert.strictEqual(await confirmDelete(), true);
    assert.strictEqual(sb.DB.settings.savedCharts.some(c => c.id === 'c2'), false);
    assert.strictEqual(sb.DB.settings.savedCharts.some(c => c.title === 'Added before confirm'), true);
    clearTimeout(sb._pbUndoTimer); sb._pbUndoTimer = null;

    sb.DB.settings.savedCharts = [{id:'c3',title:'Three',pinned:false}];
    sb._pbConfirm = (_message, onYes) => { sb._pbConfirmPromise = Promise.resolve(onYes()); };
    let finishDelete;
    saves = 0;
    sb.saveData = () => ++saves === 1 ? new Promise(resolve => { finishDelete = resolve; }) : true;
    const deletedToastCount = toasts.filter(t => t.message === 'Chart deleted').length;
    sb.pbDeleteSaved('c3');
    sb.prompt = () => 'Added during delete';
    assert.strictEqual(await sb.pbSaveChart(), true);
    finishDelete(false);
    assert.strictEqual(await sb._pbConfirmPromise, false);
    assert.strictEqual(sb.DB.settings.savedCharts.some(c => c.id === 'c3'), false);
    assert.strictEqual(sb.DB.settings.savedCharts.some(c => c.title === 'Added during delete'), true);
    assert.strictEqual(toasts.filter(t => t.message === 'Chart deleted').length, deletedToastCount);

    const oldUndo = {id:'c4',title:'Old undo',pinned:false};
    const newerDelete = {id:'c5',title:'Newer delete',pinned:false};
    sb.DB.settings.savedCharts = [newerDelete];
    sb._pbUndoChart = oldUndo;
    let finishUndo;
    saves = 0;
    sb.saveData = () => ++saves === 1 ? new Promise(resolve => { finishUndo = resolve; }) : true;
    const undoing = sb.pbUndoDelete();
    sb.pbDeleteSaved('c5');
    assert.strictEqual(await sb._pbConfirmPromise, true);
    const restoredToastCount = toasts.filter(t => t.message === 'Chart restored').length;
    finishUndo(true);
    assert.strictEqual(await undoing, true);
    assert.strictEqual(sb._pbUndoChart.id, 'c5');
    assert.strictEqual(toasts.filter(t => t.message === 'Chart restored').length, restoredToastCount);
    clearTimeout(sb._pbUndoTimer); sb._pbUndoTimer = null;

    sb.DB.settings.savedCharts = [];
    sb._pbUndoChart = oldUndo;
    sb.saveData = () => false;
    assert.strictEqual(await sb.pbUndoDelete(), false);
    assert.strictEqual(sb.DB.settings.savedCharts.length, 1);
    assert.strictEqual(sb._pbUndoChart.id, 'c4');
    assert.strictEqual(toasts.some(t => t.message === 'Chart restored'), false);
    sb.saveData = () => true;
    assert.strictEqual(await sb.pbUndoDelete(), true);
    assert.strictEqual(sb.DB.settings.savedCharts.length, 1);
    assert.strictEqual(sb._pbUndoChart, null);
    assert.strictEqual(toasts.at(-1).message, 'Chart restored');
  });

  await testAsync('Chart Builder history - missing FX clears stale charts and same-currency values render', async () => {
    async function drawHistory(display, rowCcy, historyCcy, showAvgCost){
      const sb = freshSandbox({settings:{savedCharts:[],salary:{},tax:{},fxOverrides:{},fxRates:{}}});
      const symbol = rowCcy + '-TEST';
      sb.displayCcy = () => display;
      sb._pbCurSym = () => display === 'USD' ? 'US$' : 'S$';
      sb._pbStockRows = () => [{
        s:{symbol,market:'TEST'}, ysym:symbol, shares:2, avgCost:80,
        ccy:rowCcy, priceCcy:rowCcy
      }];
      sb.fetchStockHistory = async () => ({
        [symbol]:{ccy:historyCcy,points:[{t:Date.UTC(2026, 8, 5, 4),c:100}]}
      });
      let mounted = null, destroyed = 0;
      sb._pbMountChart = (canvasId, spec) => { mounted = {canvasId, spec}; };
      sb._pbCharts.history = {destroy(){ destroyed++; }};
      const host = {
        canvasId:'history', wrapEl:{style:{}}, emptyEl:{style:{},innerHTML:''}, summaryEl:{innerHTML:''}
      };
      const ok = await sb._pbDrawInto(host, {
        source:'holdings', mode:'timeseries', tsSymbols:[symbol], range:'SIX_MONTHS',
        tsValue:'price', tsAvgCost:showAvgCost
      });
      return {sb, host, ok, mounted, destroyed};
    }

    for (const [display, source] of [['SGD','USD'], ['USD','SGD']]){
      const result = await drawHistory(display, source, source, false);
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.mounted, null);
      assert.strictEqual(result.destroyed, 1);
      assert.strictEqual(result.sb._pbCharts.history, undefined);
      assert.strictEqual(result.host.emptyEl.innerHTML.includes('FX rate missing'), true);
      assert.strictEqual(result.host.emptyEl.innerHTML.includes(source), true);
    }

    const missingCost = await drawHistory('SGD', 'USD', 'SGD', true);
    assert.strictEqual(missingCost.ok, false);
    assert.strictEqual(missingCost.mounted, null);
    assert.strictEqual(missingCost.destroyed, 1);
    assert.strictEqual(missingCost.host.emptyEl.innerHTML.includes('USD'), true);

    for (const currency of ['SGD','USD']){
      const result = await drawHistory(currency, currency, currency, true);
      assert.strictEqual(result.ok, true);
      assert.ok(result.mounted);
      assert.deepStrictEqual(Array.from(result.mounted.spec.data.datasets[0].data), [100]);
      assert.deepStrictEqual(Array.from(result.mounted.spec.data.datasets[1].data), [80]);
      assert.strictEqual(result.host.wrapEl.style.display, 'block');
      assert.strictEqual(result.host.emptyEl.style.display, 'none');
    }
  });

  /* ═══ Explore page, saved charts and the dashboard switch (onDashboard) ═══ */

  test('pbLoadSaved - onDashboard defaults on read: off for the two seeded charts the dashboard already covers (Allocation, Net worth over time), on for every other, and the DB is never written', () => {
    const raw = [
      { id:'def_alloc', title:'Allocation', source:'allocation', xFields:['assetClass'], yFields:['value'], chartType:'doughnut', pinned:true, order:1 },
      { id:'def_networth', title:'Net worth over time', source:'networth', pinned:true, order:0 },
      { id:'def_cashflow', title:'Cashflow', source:'cashflow', xFields:['month'], yFields:['income'], pinned:true, order:2 },
      { id:'sc_mine', title:'Mine', source:'holdings', xFields:['symbol'], yFields:['marketValue'], order:5 }
    ];
    const sb = chartSandbox(raw);
    const loaded = sb.pbLoadSaved();
    const byId = id => loaded.find(c => c.id === id);
    assert.strictEqual(byId('def_alloc').onDashboard, false);
    assert.strictEqual(byId('def_networth').onDashboard, false);
    assert.strictEqual(byId('def_cashflow').onDashboard, true);
    assert.strictEqual(byId('sc_mine').onDashboard, true);
    assert.deepStrictEqual(Array.from(loaded.map(c => c.id)), ['def_networth', 'def_alloc', 'def_cashflow', 'sc_mine']);
    // Read-time default only: the stored records still carry no onDashboard field.
    raw.forEach(c => assert.strictEqual('onDashboard' in c, false));
    assert.strictEqual(sb.calls.saves, 0);
  });

  test('pbLoadSaved - an explicit onDashboard is kept, a non-boolean value falls back to the default', () => {
    const keep = chartSandbox([
      { id:'def_alloc', source:'allocation', xFields:['assetClass'], yFields:['value'], onDashboard:true, order:1 },
      { id:'def_networth', source:'networth', onDashboard:true, order:0 },
      { id:'sc_off', source:'holdings', xFields:['symbol'], yFields:['marketValue'], onDashboard:false, order:2 }
    ]).pbLoadSaved();
    assert.strictEqual(keep.find(c => c.id === 'def_alloc').onDashboard, true);
    // an explicit true on Net worth over time (a v2.70 install seeded it on) is never overridden by the new default
    assert.strictEqual(keep.find(c => c.id === 'def_networth').onDashboard, true);
    assert.strictEqual(keep.find(c => c.id === 'sc_off').onDashboard, false);

    const junk = chartSandbox([
      { id:'def_alloc', source:'allocation', xFields:['assetClass'], yFields:['value'], onDashboard:'yes', order:1 },
      { id:'def_networth', source:'networth', onDashboard:'yes', order:0 },
      { id:'sc_a', source:'holdings', xFields:['symbol'], yFields:['marketValue'], onDashboard:'false', order:2 },
      { id:'sc_b', source:'holdings', xFields:['symbol'], yFields:['marketValue'], onDashboard:0, order:3 },
      { id:'sc_c', source:'holdings', xFields:['symbol'], yFields:['marketValue'], onDashboard:null, order:4 }
    ]).pbLoadSaved();
    assert.strictEqual(junk.find(c => c.id === 'def_alloc').onDashboard, false);
    assert.strictEqual(junk.find(c => c.id === 'def_networth').onDashboard, false);
    ['sc_a', 'sc_b', 'sc_c'].forEach(id => assert.strictEqual(junk.find(c => c.id === id).onDashboard, true, id));
  });

  await testAsync('pbSaveChart - a newly saved chart is on the dashboard, whatever the builder config says, and the toast text is unchanged', async () => {
    const sb = freshSandbox({settings:{savedCharts:[],salary:{},tax:{},fxOverrides:{},fxRates:{}}});
    const toasts = [];
    sb.showToast = (message, kind) => toasts.push({message, kind});
    sb.saveData = () => true;
    sb.prompt = () => 'Mine';
    assert.strictEqual(await sb.pbSaveChart(), true);
    assert.strictEqual(sb.DB.settings.savedCharts.length, 1);
    assert.strictEqual(sb.DB.settings.savedCharts[0].onDashboard, true);
    assert.strictEqual(sb.DB.settings.savedCharts[0].title, 'Mine');
    assert.deepStrictEqual(toasts.at(-1), {message:'Chart added to dashboard', kind:'success'});

    sb._pbLiveConfig = () => ({ source:'holdings', mode:'crosssec', xFields:['symbol'], yFields:['marketValue'], tsSymbols:[], onDashboard:false });
    sb.prompt = () => 'Second';
    assert.strictEqual(await sb.pbSaveChart(), true);
    assert.strictEqual(sb.DB.settings.savedCharts.find(c => c.title === 'Second').onDashboard, true);
  });

  await testAsync('pbSetOnDashboard and pbToggleOnDashboard - persist the switch, repaint, and leave unknown ids and a never-seeded list alone', async () => {
    const sb = chartSandbox([
      { id:'def_alloc', title:'Allocation', source:'allocation', xFields:['assetClass'], yFields:['value'], pinned:true, order:1 },
      { id:'sc_1', title:'One', source:'holdings', xFields:['symbol'], yFields:['marketValue'], pinned:true, order:2 }
    ]);
    assert.strictEqual(await sb.pbSetOnDashboard('def_alloc', true), true);
    const stored = () => sb.DB.settings.savedCharts;
    assert.strictEqual(stored().find(c => c.id === 'def_alloc').onDashboard, true);
    // The write makes the other chart's read-time default explicit, and keeps its other fields.
    assert.strictEqual(stored().find(c => c.id === 'sc_1').onDashboard, true);
    assert.strictEqual(stored().find(c => c.id === 'sc_1').pinned, true);
    assert.strictEqual(sb.calls.saves, 1);
    assert.strictEqual(sb.calls.repaints, 1);

    assert.strictEqual(await sb.pbToggleOnDashboard('def_alloc'), true);
    assert.strictEqual(stored().find(c => c.id === 'def_alloc').onDashboard, false);
    assert.strictEqual(await sb.pbToggleOnDashboard('def_alloc'), true);
    assert.strictEqual(stored().find(c => c.id === 'def_alloc').onDashboard, true);

    const savesBefore = sb.calls.saves;
    assert.strictEqual(await sb.pbSetOnDashboard('missing', false), false);
    assert.strictEqual(await sb.pbToggleOnDashboard('missing'), false);
    assert.strictEqual(sb.calls.saves, savesBefore);

    // null means "never seeded": a switch call must not turn it into [].
    const fresh = chartSandbox(null);
    assert.strictEqual(await fresh.pbSetOnDashboard('def_alloc', true), false);
    assert.strictEqual(fresh.DB.settings.savedCharts, null);
    assert.strictEqual(fresh.calls.saves, 0);
  });

  await testAsync('pbRemoveFromDashboard - hides the chart without deleting it, offers Undo, and says nothing when the save fails', async () => {
    const charts = () => [{ id:'sc_1', title:'One', source:'holdings', xFields:['symbol'], yFields:['marketValue'], order:1 }];
    const sb = chartSandbox(charts());
    assert.strictEqual(await sb.pbRemoveFromDashboard('sc_1'), true);
    assert.strictEqual(sb.DB.settings.savedCharts.length, 1);
    assert.strictEqual(sb.DB.settings.savedCharts[0].onDashboard, false);
    const toast = sb.calls.toasts.at(-1);
    assert.strictEqual(toast.message, 'Removed from dashboard, still on Explore');
    assert.strictEqual(toast.action.label, 'Undo');
    assert.strictEqual(await toast.action.fn(), true);
    assert.strictEqual(sb.DB.settings.savedCharts[0].onDashboard, true);

    const failing = chartSandbox(charts(), { saveResult:false });
    assert.strictEqual(await failing.pbRemoveFromDashboard('sc_1'), false);
    assert.strictEqual(failing.calls.toasts.length, 0);
  });

  await testAsync('pbTogglePin - pinning keeps the onDashboard setting through the real load and persist round trip', async () => {
    const sb = chartSandbox([{ id:'sc_1', title:'One', source:'holdings', xFields:['symbol'], yFields:['marketValue'], onDashboard:false, order:1 }]);
    await sb.pbTogglePin('sc_1');
    assert.strictEqual(sb.DB.settings.savedCharts[0].pinned, true);
    assert.strictEqual(sb.DB.settings.savedCharts[0].onDashboard, false);
    await sb.pbTogglePin('sc_1');
    assert.strictEqual(sb.DB.settings.savedCharts[0].pinned, false);
    assert.strictEqual(sb.DB.settings.savedCharts[0].onDashboard, false);
  });

  test('pbSeedDefaults - seeds the three defaults once with Net worth over time and Allocation off the dashboard, and never re-seeds an empty list', () => {
    const sb = chartSandbox(null);
    sb.pbSeedDefaults();
    const seeded = sb.DB.settings.savedCharts;
    assert.deepStrictEqual(Array.from(seeded.map(c => c.id)), ['def_networth', 'def_alloc', 'def_cashflow']);
    assert.deepStrictEqual(Array.from(seeded.map(c => c.onDashboard)), [false, false, true]);
    // seeded off yet still listed: the read-back keeps the explicit false
    assert.deepStrictEqual(Array.from(sb.pbLoadSaved().map(c => c.onDashboard)), [false, false, true]);
    assert.deepStrictEqual(Array.from(seeded.map(c => c.pinned)), [true, true, true]);
    const once = JSON.stringify(seeded);
    sb.pbSeedDefaults();
    assert.strictEqual(JSON.stringify(sb.DB.settings.savedCharts), once);
    assert.strictEqual(sb.calls.saves, 1);

    const emptied = chartSandbox([]);
    emptied.pbSeedDefaults();
    assert.strictEqual(emptied.DB.settings.savedCharts.length, 0);
    assert.strictEqual(emptied.calls.saves, 0);
  });

  await testAsync('pbToggleOnDashboard - Net worth over time, seeded off because the hero chart covers it, can be switched on and off again from Explore', async () => {
    const sb = chartSandbox(null);
    sb.pbSeedDefaults();
    const stored = () => sb.DB.settings.savedCharts.find(c => c.id === 'def_networth');
    assert.strictEqual(stored().onDashboard, false);
    assert.strictEqual(await sb.pbToggleOnDashboard('def_networth'), true);
    assert.strictEqual(stored().onDashboard, true);
    assert.strictEqual(await sb.pbToggleOnDashboard('def_networth'), true);
    assert.strictEqual(stored().onDashboard, false);
    // the other two seeded charts are untouched by the switch
    assert.deepStrictEqual(Array.from(sb.DB.settings.savedCharts.map(c => c.onDashboard)), [false, false, true]);
  });

  test('_pbSavedDescriptor - names the chart type and source, as a line for net worth, CPF and price history', () => {
    const sb = chartSandbox([]);
    assert.strictEqual(sb._pbSavedDescriptor({ source:'allocation', mode:'crosssec', chartType:'doughnut' }), 'Doughnut · Allocation');
    assert.strictEqual(sb._pbSavedDescriptor({ source:'holdings', mode:'crosssec', chartType:'scatter' }), 'Scatter · Holdings');
    assert.strictEqual(sb._pbSavedDescriptor({ source:'networth', mode:'crosssec', chartType:'bar' }), 'Line · Net worth');
    assert.strictEqual(sb._pbSavedDescriptor({ source:'cpf', mode:'crosssec', chartType:'bar' }), 'Line · CPF');
    assert.strictEqual(sb._pbSavedDescriptor({ source:'holdings', mode:'timeseries', chartType:'bar' }), 'Line · Holdings price history');
    assert.strictEqual(sb._pbSavedDescriptor({ source:'cashflow', mode:'crosssec', chartType:'weird' }), 'Bar · Cashflow');
  });

  test('_pbRenderDashCharts - draws only charts switched on, clears every old chart card and its Chart instance, never touches other widgets', () => {
    const sb = chartSandbox([
      { id:'on1', source:'networth', onDashboard:true, order:0 },
      { id:'off1', source:'networth', onDashboard:false, order:1 },
      { id:'on2', source:'networth', onDashboard:true, order:2 }
    ], { oldCards:['off1', 'gone'] });
    sb._pbRenderDashCharts();
    assert.deepStrictEqual(Array.from(sb.calls.rendered), ['on1', 'on2']);
    assert.deepStrictEqual(Array.from(sb.stack.cards.map(c => c.dataset.wid)), ['chart:on1', 'chart:on2']);
    assert.deepStrictEqual(Array.from(sb.calls.destroyed).sort(), ['gone', 'off1']);
    assert.deepStrictEqual(Object.keys(sb._pbCharts), []);
    assert.strictEqual(sb.calls.layouts, 1);
    // Only chart cards are ever matched, so the fixed widgets stay put.
    assert.deepStrictEqual(Array.from(sb.calls.selectors), [':scope > [data-wid^="chart:"]']);
  });

  test('_pbRenderDashCharts - a hidden dashboard or a missing chart library draws nothing but still clears stale cards and settles the layout', () => {
    const charts = [{ id:'on1', source:'networth', onDashboard:true, order:0 }];
    const hidden = chartSandbox(charts, { oldCards:['on1'], dashboardActive:false });
    hidden._pbRenderDashCharts();
    assert.deepStrictEqual(Array.from(hidden.calls.rendered), []);
    assert.strictEqual(hidden.stack.cards.length, 0);
    assert.deepStrictEqual(Array.from(hidden.calls.destroyed), ['on1']);
    assert.strictEqual(hidden.calls.layouts, 1);

    const noLib = chartSandbox(charts, { oldCards:['on1'], chartLib:false });
    noLib._pbRenderDashCharts();
    assert.deepStrictEqual(Array.from(noLib.calls.rendered), []);
    assert.strictEqual(noLib.stack.cards.length, 0);
    assert.strictEqual(noLib.calls.layouts, 1);
  });

  test('Explore - tab sits right after Projections in the sidebar order and the Overview group, sits in the phone More sheet (not a bottom-bar destination), and routes through showPage, renderAll and the theme redraw', () => {
    const tabsBlock = appSrc.slice(appSrc.indexOf('const TABS = ['), appSrc.indexOf('const PHASE_2_TABS'));
    const keys = Array.from(tabsBlock.matchAll(/key:'([a-z0-9]+)'/g)).map(m => m[1]);
    assert.strictEqual(keys[keys.indexOf('projections') + 1], 'explore');
    assert.strictEqual(keys[keys.length - 1], 'settings');
    assert.strictEqual(keys.filter(k => k === 'explore').length, 1);
    // MOBILE_BOTTOM_TABS is gone: the bottom bar is five areas (MOBILE_GROUPS), and Explore lives in More
    assert.strictEqual(appSrc.includes('MOBILE_BOTTOM_TABS'), false);
    const sb = freshSandbox();
    const overview = JSON.parse(JSON.stringify(vm.runInContext('NAV_GROUPS', sb))).find(g => g.key === 'overview');
    assert.deepStrictEqual(overview.tabs, ['dashboard', 'projections', 'explore']);
    assert.strictEqual(sb._mobileGroupForTab('explore'), 'more');
    assert.ok(extractFunction('showPage').includes("if (key === 'explore') renderExplore();"));
    assert.ok(extractFunction('renderAll').includes("if (_isPageActive('explore')) renderExplore();"));
    assert.ok(extractFunction('applyTheme').includes("_currentTab === 'explore'"));
    assert.ok(extractFunction('toggleDashCpf').includes('renderExplore();'));
  });

  test('Explore - the Chart Builder host and saved list live on the Explore page, the dashboard no longer renders the builder', () => {
    const dash = indexSrc.slice(indexSrc.indexOf('id="page-dashboard"'), indexSrc.indexOf('id="page-stocks"'));
    const explore = indexSrc.slice(indexSrc.indexOf('id="page-explore"'), indexSrc.indexOf('id="page-settings"'));
    assert.strictEqual(dash.includes('id="stocks-builder"'), false);
    assert.strictEqual((indexSrc.match(/id="stocks-builder"/g) || []).length, 1);
    assert.ok(explore.includes('id="stocks-builder"'));
    assert.ok(explore.includes('id="explore-saved"'));
    assert.ok(explore.includes('<h2 class="page-title">Explore</h2>'));
    assert.ok(/id="explore-cpf-switch" role="switch" aria-checked="false" data-click="toggleDashCpf"/.test(explore));
    const dashboardSrc = extractFunction('renderDashboard');
    assert.strictEqual(dashboardSrc.includes('renderChartBuilder('), false);
    assert.ok(dashboardSrc.includes('pbSeedDefaults();'));
    assert.ok(dashboardSrc.includes('_pbRenderDashCharts();'));
  });

  test('Saved chart controls - dashboard cards remove from the dashboard instead of deleting, Explore rows carry switch, pin and delete with names', () => {
    const card = extractFunction('_pbRenderOneSaved');
    assert.ok(card.includes('data-click="pbRemoveFromDashboard"'));
    assert.strictEqual(card.includes('data-click="pbDeleteSaved"'), false);
    assert.ok(card.includes('title="Remove from dashboard"'));
    const list = extractFunction('_pbRenderSavedList');
    assert.ok(list.includes('role="switch"'));
    assert.ok(list.includes('data-click="pbToggleOnDashboard"'));
    assert.ok(list.includes('aria-labelledby="pb-sl-t-${id} pb-sl-s-${id}"'));
    assert.ok(list.includes('Show on dashboard'));
    assert.ok(list.includes('data-click="pbTogglePin"'));
    assert.ok(list.includes('data-click="pbDeleteSaved"'));
    assert.ok(list.includes('kjrEscape(cfg.title)'));
    assert.ok(list.includes('Charts you add appear here.'));
    assert.ok(appSrc.includes('pbToggleOnDashboard:') && appSrc.includes('pbRemoveFromDashboard:'));
  });

  test('Asset-class ink tokens - six light values and six dark aliases sit beside the class colours', () => {
    assert.ok(indexSrc.includes('--c-stocks-ink:#375BD2;--c-cash-ink:#5A6778;--c-cpf-ink:#6E4CD0;--c-re-ink:#845F22;--c-crypto-ink:#A74629;--c-insurance-ink:#984981;'));
    ['stocks', 'cash', 'cpf', 're', 'crypto', 'insurance'].forEach(name => {
      assert.ok(indexSrc.includes('--c-' + name + '-ink:var(--c-' + name + ')'), name + ' dark ink must alias the class colour');
    });
  });

  /* ═══ Dashboard rows (v2.70): layout migration, monogram, Where it sits, Health, Coming up ═══ */

  /* kjrEscape carries quote characters inside regex literals, which the brace-matching extractor cannot skip, so it is sliced by its own shape (three lines, closing brace in column 0). */
  const realEscape = sb => { vm.runInContext(/function kjrEscape\(s\)\{[\s\S]*?\n\}/.exec(appSrc)[0], sb); return sb; };
  const arr = list => Array.from(list);

  test('_migrateDashLayout - the documented example, an empty layout and an already current one', () => {
    const sb = freshSandbox();
    const m = ids => arr(sb._migrateDashLayout(ids));
    assert.deepStrictEqual(m(['movers', 'assets', 'chart:def_networth', 'ef']), ['activity', 'overview', 'chart:def_networth', 'networth', 'cpf']);
    assert.deepStrictEqual(m([]), ['networth', 'overview', 'activity', 'cpf']);
    assert.deepStrictEqual(m(null), ['networth', 'overview', 'activity', 'cpf']);
    assert.deepStrictEqual(m(['cpf', 'chart:b', 'networth', 'activity', 'chart:a', 'overview']), ['cpf', 'chart:b', 'networth', 'activity', 'chart:a', 'overview']);
    // a legacy layout saved by Arrange (every widget and chart id) keeps its order of charts and gains the rows
    assert.deepStrictEqual(m(['networth', 'assets', 'ef', 'targets', 'movers', 'cpf', 'chart:def_networth', 'chart:def_alloc', 'chart:def_cashflow']),
      ['networth', 'overview', 'activity', 'cpf', 'chart:def_networth', 'chart:def_alloc', 'chart:def_cashflow']);
  });

  test('_migrateDashLayout - duplicates keep the first, unknown and unsafe ids are dropped, chart order is kept', () => {
    const sb = freshSandbox();
    const m = ids => arr(sb._migrateDashLayout(ids));
    assert.deepStrictEqual(m(['assets', 'overview', 'targets', 'ef', 'overview']), ['overview', 'networth', 'activity', 'cpf']);
    assert.deepStrictEqual(m(['movers', 'activity', 'movers']), ['activity', 'networth', 'overview', 'cpf']);
    assert.deepStrictEqual(m(['bogus', '__proto__', 'constructor', 'toString', 'hasOwnProperty', 'chart']), ['networth', 'overview', 'activity', 'cpf']);
    assert.deepStrictEqual(m([1, null, undefined, {}, ['cpf'], 'networth']), ['networth', 'overview', 'activity', 'cpf']);
    // a chart id that is not a safe chart:<id> could never match a card, and would break the attribute selector
    assert.deepStrictEqual(m(['chart:"]', 'chart:', 'chart:a b', 'chart:' + 'x'.repeat(65), 'chart:ok_1', 'chart:a"b', 'chart:ok_1']), ['chart:ok_1', 'networth', 'overview', 'activity', 'cpf']);
    assert.deepStrictEqual(m(['chart:c', 'chart:a', 'chart:b']), ['chart:c', 'chart:a', 'chart:b', 'networth', 'overview', 'activity', 'cpf']);
  });

  test('loadDashLayout - read-time migration only: an empty or missing layout stays empty and the stored layout is never rewritten', () => {
    const sb = freshSandbox({settings:{dashLayout:[]}});
    assert.deepStrictEqual(arr(sb.loadDashLayout()), []);
    sb.DB.settings.dashLayout = null;
    assert.deepStrictEqual(arr(sb.loadDashLayout()), []);
    const legacy = ['networth', 'assets', 'ef', 'targets', 'movers', 'cpf', 'chart:def_networth'];
    sb.DB.settings.dashLayout = legacy.slice();
    assert.deepStrictEqual(arr(sb.loadDashLayout()), ['networth', 'overview', 'activity', 'cpf', 'chart:def_networth']);
    assert.deepStrictEqual(arr(sb.DB.settings.dashLayout), legacy);
  });

  test('_applyDashLayout - orders by the migrated layout and puts a widget the order does not name after the named ones', () => {
    const sb = freshSandbox({settings:{dashLayout:['movers', 'assets', 'chart:def_networth', 'ef']}});
    const stack = {
      kids: ['networth', 'overview', 'activity', 'cpf', 'chart:def_networth', 'chart:def_cashflow'].map(id => ({ id, getAttribute: () => id })),
      querySelectorAll(){ return this.kids.slice(); },
      querySelector(selector){ const match = /\[data-wid="([^"]*)"\]/.exec(selector); return this.kids.find(k => k.id === match[1]) || null; },
      appendChild(el){ this.kids = this.kids.filter(k => k !== el); this.kids.push(el); }
    };
    sb.document = { getElementById: () => stack };
    sb._dashDecorate = () => {};
    sb._dashSortable = null;
    sb._dashArrange = false;
    sb._applyDashLayout();
    assert.deepStrictEqual(stack.kids.map(k => k.id), ['activity', 'overview', 'chart:def_networth', 'networth', 'cpf', 'chart:def_cashflow']);
    assert.deepStrictEqual(arr(sb.DB.settings.dashLayout), ['movers', 'assets', 'chart:def_networth', 'ef']);

    // never saved: the markup order stands
    const fresh = freshSandbox({settings:{dashLayout:[]}});
    const stack2 = { kids: ['networth', 'overview'].map(id => ({ id, getAttribute: () => id })),
      querySelectorAll(){ return this.kids.slice(); }, querySelector(){ return null; }, appendChild(el){ throw new Error('must not reorder'); } };
    fresh.document = { getElementById: () => stack2 }; fresh._dashDecorate = () => {}; fresh._dashSortable = null; fresh._dashArrange = false;
    fresh._applyDashLayout();
    assert.deepStrictEqual(stack2.kids.map(k => k.id), ['networth', 'overview']);
  });

  test('_dashWidgetBaseName - fixed rows use their names, a chart card uses its title text without the info-tip popover', () => {
    const sb = freshSandbox();
    const widget = id => ({ getAttribute: () => id, querySelector: () => null });
    assert.strictEqual(sb._dashWidgetBaseName(widget('overview')), 'Where it sits and Health');
    assert.strictEqual(sb._dashWidgetBaseName(widget('activity')), 'Holdings and Today');
    assert.strictEqual(sb._dashWidgetBaseName(widget('networth')), 'Net worth');
    assert.strictEqual(sb._dashWidgetBaseName(widget('cpf')), 'CPF breakdown');
    const names = vm.runInContext('DASH_WIDGET_NAMES', sb);
    ['assets', 'ef', 'targets', 'movers'].forEach(id => assert.strictEqual(id in names, false, id + ' is retired'));
    const chart = title => {
      const clone = { textContent: title + 'About this chartX: Sector · Y: Market Value',
        querySelectorAll(){ return [{ remove(){ clone.textContent = title; } }]; } };
      return { getAttribute: () => 'chart:def_networth', querySelector: () => ({ cloneNode: () => clone }) };
    };
    assert.strictEqual(sb._dashWidgetBaseName(chart('Net worth over time')), 'Net worth over time');
    const noTitle = { getAttribute: () => 'chart:x', querySelector: () => null };
    assert.strictEqual(sb._dashWidgetBaseName(noTitle), 'Dashboard card');
  });

  test('_monogram - first letter in the class ink on its soft tint, BTC and ETH glyphs, hostile symbols escaped', () => {
    const sb = realEscape(freshSandbox());
    assert.strictEqual(sb._monogram('AAPL', 'stocks'),
      '<span class="mono" style="background:var(--c-stocks-soft);color:var(--c-stocks-ink)" aria-hidden="true">A</span>');
    assert.ok(sb._monogram('d05', 'stocks').includes('>D</span>'));
    assert.ok(sb._monogram('BTC', 'crypto').includes('>₿</span>'));
    assert.ok(sb._monogram(' btc ', 'crypto').includes('>₿</span>'));
    assert.ok(sb._monogram('ETH', 'crypto').includes('>Ξ</span>'));
    assert.ok(sb._monogram('SOL', 'crypto').includes('background:var(--c-crypto-soft);color:var(--c-crypto-ink)'));
    ['cash', 'cpf', 're', 'insurance'].forEach(k => assert.ok(sb._monogram('X', k).includes('var(--c-' + k + '-soft);color:var(--c-' + k + '-ink)'), k));
    assert.ok(sb._monogram('', 'stocks').includes('>?</span>'));
    assert.ok(sb._monogram(null, 'stocks').includes('>?</span>'));
    assert.ok(sb._monogram('😀X', 'stocks').includes('>😀</span>'));
    const hostile = sb._monogram('<img src=x onerror=alert(1)>', 'stocks');
    assert.strictEqual(hostile.includes('<img'), false);
    assert.ok(hostile.includes('>&lt;</span>'));
    assert.strictEqual(sb._monogram('"><script>', 'stocks').includes('<script>'), false);
    // an unknown class key never reaches the style attribute
    const unknown = sb._monogram('Q', 'x;background:url(evil)');
    assert.strictEqual(unknown.includes('evil'), false);
    assert.ok(unknown.includes('background:var(--bg3);color:var(--text2)'));
    assert.strictEqual(sb._monogram('Q', undefined).includes('var(--c-undefined'), false);
  });

  test('_dayMoveSgd - value x pct / (100 + pct), null when it cannot be derived', () => {
    const sb = freshSandbox();
    assert.strictEqual(sb._dayMoveSgd(38000, 1.8), 671.91);
    assert.strictEqual(sb._dayMoveSgd(10071, -2.11), -217.08);
    assert.strictEqual(sb._dayMoveSgd(1000, 0), 0);
    assert.strictEqual(sb._dayMoveSgd(1000, -100), null);
    assert.strictEqual(sb._dayMoveSgd(1000, -150), null);
    assert.strictEqual(sb._dayMoveSgd(NaN, 1), null);
    assert.strictEqual(sb._dayMoveSgd(1000, 'x'), null);
    assert.strictEqual(sb._dayMoveSgd(null, 5), 0);
  });

  test('_stockDayMove - the row own change first, then price less previous close, then value and percentage', () => {
    const sb = freshSandbox();
    const move = r => { const m = sb._stockDayMove(r); return { pct: m.pct, sgd: m.sgd }; };
    // quote with its own change fields
    assert.deepStrictEqual(move({ px:{ price:254.3, changePct:1.24 }, changeSgd:84.5, mv:6866, shares:20, priceSgd:343.3, prevCloseSgd:339.1 }), { pct:1.24, sgd:84.5 });
    // synthetic seed style quote: previous close only
    const seed = move({ px:{ price:186.5, previousClose:190.52, changePct:-2.11 }, changeSgd:null, mv:10071, shares:40, priceSgd:251.775, prevCloseSgd:257.202 });
    assert.strictEqual(seed.pct, -2.11);
    assert.strictEqual(seed.sgd, sb.roundMoney((251.775 - 257.202) * 40));
    // percentage derived from the previous close when changePct is missing
    assert.ok(Math.abs(move({ px:{ price:110, previousClose:100 }, changeSgd:null, priceSgd:110, prevCloseSgd:100, shares:2, mv:220 }).pct - 10) < 1e-9);
    // only a value and a percentage
    assert.strictEqual(move({ px:{ price:110, changePct:10 }, changeSgd:null, priceSgd:null, prevCloseSgd:null, mv:110, shares:1 }).sgd, 10);
    // a zero change is a zero move, not missing
    assert.strictEqual(move({ px:{ price:100, previousClose:100, changePct:0 }, changeSgd:0, mv:100, shares:1 }).sgd, 0);
    // no price, no quote
    assert.deepStrictEqual(move({ px:null }), { pct:null, sgd:null });
    assert.deepStrictEqual(move({ px:{ price:null, changePct:5 } }), { pct:null, sgd:null });
    assert.deepStrictEqual(move(null), { pct:null, sgd:null });
  });

  test('_rebalanceThreshold - 5 by default, an explicit 0 is kept, junk falls back', () => {
    const sb = freshSandbox();
    assert.strictEqual(sb._rebalanceThreshold(), 5);
    sb.DB.settings.rebalanceThreshold = 0; assert.strictEqual(sb._rebalanceThreshold(), 0);
    sb.DB.settings.rebalanceThreshold = 3; assert.strictEqual(sb._rebalanceThreshold(), 3);
    sb.DB.settings.rebalanceThreshold = '7'; assert.strictEqual(sb._rebalanceThreshold(), 7);
    sb.DB.settings.rebalanceThreshold = null; assert.strictEqual(sb._rebalanceThreshold(), 5);
    sb.DB.settings.rebalanceThreshold = 'abc'; assert.strictEqual(sb._rebalanceThreshold(), 5);
  });

  test('_allocRows - biggest first, share of the net passed in, target and drift only where a target applies', () => {
    const sb = freshSandbox();
    const classes = [
      { key:'Cash', val:52708, color:'--c-cash' }, { key:'Real Estate', val:500000, color:'--c-re' },
      { key:'Stocks', val:30727, color:'--c-stocks' }, { key:'Insurance', val:1000, color:'--c-insurance' }
    ];
    const net = 584435;
    const targets = { stocks:40, cash:20, cpf:30, realestate:10, crypto:0 };
    const out = sb._allocRows(classes, net, targets, 5);
    assert.strictEqual(out.hasTargets, true);
    assert.deepStrictEqual(arr(out.rows.map(r => r.key)), ['Real Estate', 'Cash', 'Stocks', 'Insurance']);
    const by = key => out.rows.find(r => r.key === key);
    assert.ok(Math.abs(by('Real Estate').share - 500000 / net * 100) < 1e-9);
    assert.strictEqual(by('Real Estate').target, 10);
    assert.ok(Math.abs(by('Real Estate').drift - (500000 / net * 100 - 10)) < 1e-9);
    assert.strictEqual(by('Real Estate').off, true);
    assert.strictEqual(by('Cash').off, true);          // 9.0 against 20
    assert.strictEqual(by('Insurance').target, null);  // no target setting exists for insurance
    assert.strictEqual(by('Insurance').drift, null);
    assert.strictEqual(by('Insurance').off, false);
    // classes sum to the net they were given
    assert.ok(Math.abs(out.rows.reduce((s, r) => s + r.val, 0) - net) < 1e-9);
    assert.ok(Math.abs(out.rows.reduce((s, r) => s + r.share, 0) - 100) < 1e-9);
    // a zero target is a target (hold none), not a missing one
    const withCrypto = sb._allocRows([{ key:'Crypto', val:38000, color:'--c-crypto' }, { key:'Cash', val:62000, color:'--c-cash' }], 100000, targets, 5);
    assert.strictEqual(withCrypto.rows.find(r => r.key === 'Crypto').target, 0);
    assert.ok(Math.abs(withCrypto.rows.find(r => r.key === 'Crypto').drift - 38) < 1e-9);
    // no target anywhere: no targets, no drift, nothing off
    const none = sb._allocRows(classes, net, { stocks:0, cash:0, cpf:0, realestate:0, crypto:0 }, 5);
    assert.strictEqual(none.hasTargets, false);
    none.rows.forEach(r => { assert.strictEqual(r.target, null); assert.strictEqual(r.drift, null); assert.strictEqual(r.off, false); });
    assert.strictEqual(sb._allocRows(classes, net, undefined, 5).hasTargets, false);
    // the tolerance is strict: exactly on it is not off, and 0 flags any drift
    const edge = sb._allocRows([{ key:'Stocks', val:45, color:'--c-stocks' }, { key:'Cash', val:55, color:'--c-cash' }], 100, { stocks:40, cash:55 }, 5);
    assert.strictEqual(edge.rows.find(r => r.key === 'Stocks').off, false);
    assert.strictEqual(sb._allocRows([{ key:'Stocks', val:45, color:'--c-stocks' }], 100, { stocks:40 }, 4.9).rows[0].off, true);
    assert.strictEqual(sb._allocRows([{ key:'Stocks', val:40.2, color:'--c-stocks' }], 100, { stocks:40 }, 0).rows[0].off, true);
    assert.strictEqual(sb._allocRows([{ key:'Stocks', val:40, color:'--c-stocks' }], 100, { stocks:40 }, 0).rows[0].off, false);
    // no net, no shares
    assert.strictEqual(sb._allocRows([{ key:'Cash', val:5, color:'--c-cash' }], 0, targets, 5).rows[0].share, null);
  });

  test('_allocInsight - names the most over and most under class beyond tolerance, adapts, and stays silent when nothing is off', () => {
    const sb = freshSandbox();
    const row = (key, share, drift, off) => ({ key, share, drift, off });
    const rows = [row('Real Estate', 69.1, 59.1, true), row('Stocks', 4.2, -35.8, true), row('CPF', 14.1, -15.9, true), row('Cash', 7.3, -12.7, true), row('Crypto', 5.3, 5.3, true)];
    assert.strictEqual(sb._allocInsight(rows),
      'Real Estate carries 69% of your net worth, 59 points over target. New savings would close the gap fastest in Stocks, which sits 36 points under.');
    assert.strictEqual(sb._allocInsight([row('Real Estate', 69.1, 39.4, true), row('Cash', 7.3, -1.2, false)]),
      'Real Estate carries 69% of your net worth, 39 points over target.');
    assert.strictEqual(sb._allocInsight([row('Stocks', 4.2, -25.8, true), row('Cash', 7.3, 1.2, false)]),
      'Stocks holds 4% of your net worth, 26 points under target. New savings would close the gap fastest there.');
    assert.strictEqual(sb._allocInsight([row('Cash', 7.3, -1.2, false), row('Stocks', 4.2, 0.4, false)]), null);
    assert.strictEqual(sb._allocInsight([]), null);
    assert.strictEqual(sb._allocInsight([row('Insurance', 1, null, false)]), null);
    // singular and sub-point wording, for a tight tolerance
    assert.ok(sb._allocInsight([row('Cash', 10, 1.2, true)]).includes('1 point over target'));
    assert.ok(sb._allocInsight([row('Cash', 10, 0.3, true)]).includes('less than a point over target'));
  });

  /* Where it sits is always the full CPF-inclusive picture, whatever the Include CPF switch says. These are the QA seed with CPF counted
     (S$723,075), the basis the old target allocation card used at HEAD: Stocks -36, Cash -13, CPF -16, Real Estate +59, Crypto +5. */
  const whereSeed = () => ({ classes:{ stocks:30727.1, cash:52708.25, cpf:101640, realestate:500000, crypto:38000, insurance:0 }, total:723075.35, incomplete:false, missingFxCount:0 });
  const whereTargets = { stocks:40, cash:20, cpf:30, realestate:10, crypto:0 };
  const whereSandbox = targets => {
    const sb = freshSandbox({ settings:{ targets: targets || whereTargets } });
    sb.assetClassColor = key => ({ Stocks:'--c-stocks', Cash:'--c-cash', CPF:'--c-cpf', 'Real Estate':'--c-re', Crypto:'--c-crypto', Insurance:'--c-insurance' })[key] || '--text3';
    sb._moneyHtml = s => s;
    sb._emptyIcon = () => '<svg></svg>';
    sb.ALERT_ICON = '<svg></svg>';
    sb.fmt = n => 'S$' + Math.round(n).toLocaleString('en-US');
    return sb;
  };
  const whereNone = { classes:{ stocks:0, cash:0, cpf:0, realestate:0, crypto:0, insurance:0 }, total:0, incomplete:false, missingFxCount:0 };

  test('_whereModel - the CPF-inclusive basis gives the HEAD drifts for the seed, and the rows sum to the CPF-inclusive net worth', () => {
    const sb = whereSandbox();
    const v = whereSeed();
    const m = sb._whereModel(v, whereTargets, 5);
    assert.strictEqual(m.state, 'ok');
    assert.strictEqual(m.hasTargets, true);
    assert.deepStrictEqual(arr(m.rows.map(r => r.key)), ['Real Estate', 'CPF', 'Cash', 'Crypto', 'Stocks']);
    const sign = n => (n >= 0 ? '+' : '') + n.toFixed(0);
    assert.deepStrictEqual(arr(m.rows.map(r => sign(r.drift))), ['+59', '-16', '-13', '+5', '-36']);
    assert.deepStrictEqual(arr(m.rows.map(r => r.share.toFixed(0) + '%')), ['69%', '14%', '7%', '5%', '4%']);
    assert.ok(m.rows.every(r => r.off));
    assert.ok(Math.abs(m.rows.reduce((s, r) => s + r.val, 0) - v.total) < 0.01);
    assert.ok(Math.abs(m.rows.reduce((s, r) => s + r.share, 0) - 100) < 1e-9);
    assert.strictEqual(m.insight, 'Real Estate carries 69% of your net worth, 59 points over target. New savings would close the gap fastest in Stocks, which sits 36 points under.');
    assert.strictEqual(m.note, '');
  });

  test('_dashWhereItSits - Include CPF off and on give identical markup, the CPF row and the HEAD drifts included', () => {
    const v = whereSeed();
    const html = showCpf => { const sb = whereSandbox(); sb._dashShowCpf = showCpf; return sb._dashWhereItSits(v); };
    const off = html(false), on = html(true);
    assert.strictEqual(off, on);
    ['+59 pts', '-16 pts', '-13 pts', '+5 pts', '-36 pts'].forEach(label => assert.ok(off.includes(label), label));
    assert.ok(off.includes('</span>CPF</div>') && off.includes('S$101,640') && off.includes('S$500,000'));
    assert.ok(off.includes('Share incl. CPF · marker shows your target') && off.includes('<span class="dash-hint-short">Share incl. CPF</span>'));
    assert.ok(off.includes('Real Estate carries 69% of your net worth, 59 points over target.') && off.includes('Review targets'));
    // neither function can see the switch, and the dashboard hands over the valuation alone
    ['_dashWhereItSits', '_whereModel'].forEach(name => assert.strictEqual(extractFunction(name).includes('_dashShowCpf'), false, name));
    const dashboardSrc = extractFunction('renderDashboard');
    assert.ok(dashboardSrc.includes('_dashWhereItSits(valuation)') && !dashboardSrc.includes('displayClasses'));
    // the hero and the Holdings shares keep following the switch
    assert.ok(dashboardSrc.includes('_allocationData(valuation.classes, _dashShowCpf)') && dashboardSrc.includes('_dashHoldings(holdingRows, displayNet)'));
    // with no target in use the hint drops the marker clause and the target column goes
    const bare = whereSandbox({ stocks:0, cash:0, cpf:0, realestate:0, crypto:0 })._dashWhereItSits(v);
    assert.ok(bare.includes('Share incl. CPF') && !bare.includes('marker shows') && bare.includes('no-target'));
    assert.ok(!bare.includes('dash-adrift') && !bare.includes('dash-insight') && !bare.includes('<i style'));
  });

  test('_whereModel - a class is skipped only when it has no target and no balance, and Insurance never has a target', () => {
    const sb = whereSandbox();
    const base = { classes:{ stocks:60000, cash:40000, cpf:0, realestate:0, crypto:0, insurance:0 }, total:100000, incomplete:false, missingFxCount:0 };
    const keys = (v, t) => arr(sb._whereModel(v, t, 5).rows.map(r => r.key));
    // a target with no balance still shows, so a missing class reads as under target
    assert.deepStrictEqual(keys(base, whereTargets), ['Stocks', 'Cash', 'CPF', 'Real Estate']);
    const cpf = sb._whereModel(base, whereTargets, 5).rows.find(r => r.key === 'CPF');
    assert.strictEqual(cpf.val, 0); assert.strictEqual(cpf.share, 0); assert.strictEqual(cpf.target, 30);
    assert.strictEqual(cpf.drift, -30); assert.strictEqual(cpf.off, true);
    // no target and no balance is skipped (Crypto above), and with no targets in use only held classes show
    assert.deepStrictEqual(keys(base, { stocks:0, cash:0, cpf:0, realestate:0, crypto:0 }), ['Stocks', 'Cash']);
    // Insurance appears once it has a value, with no target setting, so no drift and never off
    const withIns = { classes:Object.assign({}, base.classes, { insurance:5000 }), total:105000, incomplete:false, missingFxCount:0 };
    const ins = sb._whereModel(withIns, whereTargets, 5).rows.find(r => r.key === 'Insurance');
    assert.ok(ins && ins.target === null && ins.drift === null && ins.off === false);
    assert.strictEqual(sb._whereModel(base, whereTargets, 5).rows.some(r => r.key === 'Insurance'), false);
  });

  test('_whereModel - when a share would mislead, the rows keep their signed values and one line replaces targets, drift and insight', () => {
    const sb = whereSandbox();
    const noDrift = m => {
      assert.strictEqual(m.insight, null);
      m.rows.forEach(r => { assert.strictEqual(r.share, null); assert.strictEqual(r.target, null); assert.strictEqual(r.drift, null); assert.strictEqual(r.off, false); });
    };
    // missing FX with targets in use: the old target guard copy
    const missing = Object.assign(whereSeed(), { incomplete:true, missingFxCount:2 });
    const a = sb._whereModel(missing, whereTargets, 5);
    assert.strictEqual(a.state, 'incomplete');
    assert.strictEqual(a.note, 'Set FX rates for 2 assets before comparing against targets.');
    assert.deepStrictEqual(arr(a.rows.map(r => r.key + ':' + Math.round(r.val))), ['Real Estate:500000', 'CPF:101640', 'Cash:52708', 'Crypto:38000', 'Stocks:30727']);
    noDrift(a);
    assert.strictEqual(sb._whereModel(Object.assign(whereSeed(), { incomplete:true, missingFxCount:1 }), whereTargets, 5).note, 'Set FX rates for 1 asset before comparing against targets.');
    // missing FX with no target in use: it is the percentages that are unavailable
    assert.strictEqual(sb._whereModel(Object.assign(whereSeed(), { incomplete:true, missingFxCount:1 }), {}, 5).note,
      'Known values exclude 1 asset with missing FX. Set rates in Settings before calculating percentages.');
    // a negative class balance: listed signed even with no target, and no share anywhere
    const negative = { classes:{ stocks:50000, cash:-2000, cpf:0, realestate:0, crypto:-300, insurance:0 }, total:47700, incomplete:false, missingFxCount:0 };
    const b = sb._whereModel(negative, whereTargets, 5);
    assert.strictEqual(b.state, 'unavailable');
    assert.strictEqual(b.note, 'Net allocation is zero, negative, or contains a negative class balance. Signed values remain visible above.');
    assert.deepStrictEqual(arr(b.rows.map(r => r.key + ':' + r.val)), ['Stocks:50000', 'Crypto:-300', 'Cash:-2000']);
    noDrift(b);
    // a net that is below zero, and a total that rounds to zero, are not a net to share against
    const underwater = { classes:{ stocks:1000, cash:-5000, cpf:0, realestate:0, crypto:0, insurance:0 }, total:-4000, incomplete:false, missingFxCount:0 };
    assert.strictEqual(sb._whereModel(underwater, whereTargets, 5).state, 'unavailable');
    const dust = { classes:{ stocks:0.004, cash:0, cpf:0, realestate:0, crypto:0, insurance:0 }, total:0, incomplete:false, missingFxCount:0 };
    assert.strictEqual(sb._whereModel(dust, whereTargets, 5).state, 'unavailable');
    // nothing held is an empty state, nothing known with FX missing is incomplete with no rows
    const none = sb._whereModel(whereNone, whereTargets, 5);
    assert.strictEqual(none.state, 'empty'); assert.strictEqual(none.rows.length, 0);
    const unknown = sb._whereModel(Object.assign({}, whereNone, { incomplete:true, missingFxCount:3 }), whereTargets, 5);
    assert.strictEqual(unknown.state, 'incomplete'); assert.strictEqual(unknown.rows.length, 0);
  });

  test('_dashWhereItSits - the guard state is signed rows and one --text3 line with no marker, drift, bar or insight, and the empty state is designed', () => {
    const sb = whereSandbox();
    const negative = sb._dashWhereItSits({ classes:{ stocks:50000, cash:-2000, cpf:0, realestate:0, crypto:0, insurance:0 }, total:48000, incomplete:false, missingFxCount:0 });
    assert.ok(negative.includes('<p class="dash-note">Net allocation is zero, negative, or contains a negative class balance. Signed values remain visible above.</p>'));
    assert.ok(negative.includes('signed balance') && negative.includes('S$-2,000') && negative.includes('S$50,000') && negative.includes('Values incl. CPF'));
    ['dash-adrift', 'dash-insight', 'dash-split', '<i style', 'target'].forEach(part => assert.strictEqual(negative.includes(part), false, part));
    const missing = sb._dashWhereItSits(Object.assign(whereSeed(), { incomplete:true, missingFxCount:2 }));
    assert.ok(missing.includes('<p class="dash-note">Set FX rates for 2 assets before comparing against targets.</p>'));
    assert.ok(missing.includes('known value') && missing.includes('S$101,640'));
    ['dash-adrift', 'dash-insight', 'dash-split', '<i style'].forEach(part => assert.strictEqual(missing.includes(part), false, part));
    // the line sits below the rows, so "visible above" reads true, in the quiet text colour
    assert.ok(negative.indexOf('dash-arows') < negative.indexOf('dash-note'));
    assert.ok(indexSrc.includes('.dash-note{margin:12px 0 0;font-size:12.5px;line-height:1.5;color:var(--text3)}'));
    const empty = sb._dashWhereItSits(whereNone);
    assert.ok(empty.includes('No holdings yet') && empty.includes('Add stocks, cash, CPF, or property'));
    assert.strictEqual(empty.includes('NaN') || empty.includes('undefined'), false);
  });

  test('_gainPill - arrow carries the sign, amount in a money chip, flat for no change', () => {
    const sb = freshSandbox();
    sb.fmt = n => 'S$' + Math.round(n).toLocaleString('en-US');
    assert.strictEqual(sb._gainPill(14698.6, 2.24), '<span class="dash-pill up">▲ <span class="money-chip">S$14,699</span> · 2.2%</span>');
    assert.strictEqual(sb._gainPill(-57765, -8.5), '<span class="dash-pill down">▼ <span class="money-chip">S$57,765</span> · 8.5%</span>');
    assert.strictEqual(sb._gainPill(0, 0), '<span class="dash-pill flat"><span class="money-chip">S$0</span> · 0.0%</span>');
  });

  test('_ringSvg - fill as a dash length of the 40px circle, empty and out-of-range inputs draw safely', () => {
    const sb = freshSandbox();
    const circumference = 2 * Math.PI * 16;
    const half = sb._ringSvg(0.5, 'var(--gain)');
    assert.ok(half.includes('stroke="var(--gain)"'));
    assert.ok(half.includes('stroke-dasharray="' + (circumference / 2).toFixed(2) + ' ' + circumference.toFixed(2) + '"'));
    assert.ok(half.includes('aria-hidden="true"') && half.includes('viewBox="0 0 40 40"'));
    assert.strictEqual(sb._ringSvg(0, 'var(--gain)').includes('dash-ring-fg'), false);
    assert.strictEqual(sb._ringSvg(-1, 'var(--gain)').includes('dash-ring-fg'), false);
    assert.strictEqual(sb._ringSvg(NaN, 'var(--gain)').includes('dash-ring-fg'), false);
    assert.ok(sb._ringSvg(7, 'var(--accent)').includes('stroke-dasharray="' + circumference.toFixed(2) + ' ' + circumference.toFixed(2) + '"'));
  });

  test('_miniBars - six bars scale to the percentage, the last one is the highlighted current bar, labels are escaped', () => {
    const sb = realEscape(freshSandbox());
    const html = sb._miniBars([{ pct:30, label:'a' }, { pct:60, label:'b' }, { pct:null, label:'<x>' }, { pct:-5, label:'d' }, { pct:45, label:'e' }, { pct:50, label:'Sep 2026: 50%' }]);
    assert.strictEqual((html.match(/<span/g) || []).length, 6);
    assert.strictEqual((html.match(/class="cur"/g) || []).length, 1);
    assert.ok(html.indexOf('class="cur"') > html.indexOf('title="e"'));
    assert.ok(html.includes('style="height:100.0%" title="b"'));
    assert.ok(html.includes('style="height:50.0%" title="a"'));
    assert.ok(html.includes('style="height:0.0%" title="&lt;x&gt;"'));   // no data draws a stub through min-height
    assert.ok(html.includes('style="height:0.0%" title="d"'));          // a negative rate draws no height
    assert.ok(html.includes('aria-hidden="true"'));
    // a rate above the 60 floor lifts the ceiling to the next ten
    assert.ok(sb._miniBars([{ pct:95, label:'a' }, { pct:50, label:'b' }]).includes('style="height:95.0%" title="a"'));
  });

  test('_nextPayday - the engine rule (last working day of a month), month by month, bounded by start and end', () => {
    const sb = freshSandbox();
    const sal = { grossMonthly:8000, startDate:'2026-01-01', endDate:null };
    const next = (s, today) => { const p = sb._nextPayday(s, today); return p && { y:p.y, m:p.m, payday:p.payday }; };
    assert.deepStrictEqual(next(sal, '2026-10-07'), { y:2026, m:10, payday:'2026-10-30' });
    assert.deepStrictEqual(next(sal, '2026-10-30'), { y:2026, m:10, payday:'2026-10-30' });   // on the day still counts
    assert.deepStrictEqual(next(sal, '2026-10-31'), { y:2026, m:11, payday:'2026-11-30' });   // after it, the next month
    assert.deepStrictEqual(next(sal, '2026-12-31'), { y:2026, m:12, payday:'2026-12-31' });
    assert.deepStrictEqual(next(sal, '2027-01-02'), { y:2027, m:1, payday:'2027-01-29' });
    assert.deepStrictEqual(next({ grossMonthly:8000, startDate:'2026-12-15' }, '2026-10-07'), { y:2026, m:12, payday:'2026-12-31' });
    assert.strictEqual(next({ grossMonthly:8000, startDate:'2027-06-01' }, '2026-10-07'), null);
    assert.strictEqual(next({ grossMonthly:8000, startDate:'2026-01-01', endDate:'2026-09-30' }, '2026-10-07'), null);
    assert.deepStrictEqual(next({ grossMonthly:8000, startDate:'2026-01-01', endDate:'2026-11-15' }, '2026-10-31'), { y:2026, m:11, payday:'2026-11-30' });
    assert.strictEqual(next(null, '2026-10-07'), null);
    assert.strictEqual(next({ grossMonthly:0, startDate:'2026-01-01' }, '2026-10-07'), null);
    assert.strictEqual(next({ grossMonthly:8000 }, '2026-10-07'), null);
  });

  test('_comingUp - payday and CPF on the same day, dividend and premium by their rules, soonest first, four at most', () => {
    const sb = freshSandbox({settings:{fxOverrides:{USDSGD:1.35},fxRates:{}}});
    const money = n => 'S$' + n.toFixed(2);
    const base = {
      salary: { employer:'Acme Pte Ltd', grossMonthly:8000, startDate:'2026-01-01', endDate:null },
      ageOf: () => 31, cpfAnchor: '2025-12-31',
      policies: [
        { status:'Active', insurer:'Seed Life', plan:'Term 65', type:'Term Life', premiumFreq:'Annual', premium:1200, premiumDue:'2026-10-28' },
        { status:'Lapsed', insurer:'Old', plan:'Gone', premium:100, premiumDue:'2026-10-10' },
        { status:'Active', insurer:'Far', plan:'Away', premium:100, premiumDue:'2027-03-01' }
      ],
      dividendRows: [
        { s:{ symbol:'D05', divPerShare:0.55, divExDate:'2026-10-20', divPayDate:'2026-11-05' }, shares:300, ccy:'SGD' },
        { s:{ symbol:'AAPL', divPerShare:1, divExDate:'2027-06-01' }, shares:20, ccy:'USD' }
      ],
      money
    };
    const items = list => arr(list.map(i => i.date + ' ' + i.kind));
    const all = sb._comingUp('2026-10-07', '2027-01-05', base);
    assert.deepStrictEqual(items(all), ['2026-10-28 insurance', '2026-10-30 payday', '2026-10-30 cpf', '2026-11-05 dividend']);
    const byKind = k => all.find(i => i.kind === k);
    assert.strictEqual(byKind('payday').title, 'Payday, Acme Pte Ltd');
    assert.strictEqual(byKind('payday').amount, null);               // no deposit maths repeated on the dashboard
    assert.strictEqual(byKind('cpf').amount, 2960);                  // computeCpfContribution total for S$8,000 gross
    assert.strictEqual(byKind('cpf').line, 'OA, SA and MA from Acme Pte Ltd');
    assert.strictEqual(byKind('insurance').title, 'Seed Life Term 65 premium');
    assert.strictEqual(byKind('insurance').line, 'Term Life, Annual');
    assert.strictEqual(byKind('insurance').amount, 1200);
    assert.strictEqual(byKind('dividend').title, 'D05 dividend');
    assert.strictEqual(byKind('dividend').line, '300 shares at S$0.55');
    assert.strictEqual(byKind('dividend').amount, 165);
    // a dividend with no pay date is dated by its ex-date and says so
    const exOnly = sb._comingUp('2026-10-07', '2027-01-05', Object.assign({}, base, { salary:null, policies:[], dividendRows:[{ s:{ symbol:'D05', divPerShare:0.55, divExDate:'2026-10-20' }, shares:300, ccy:'SGD' }] }));
    assert.deepStrictEqual(items(exOnly), ['2026-10-20 dividend']);
    assert.strictEqual(exOnly[0].line, '300 shares at S$0.55, ex-date');
    // only the next dividend is listed, however many are due
    const two = sb._comingUp('2026-10-07', '2027-01-05', Object.assign({}, base, { salary:null, policies:[], dividendRows:[
      { s:{ symbol:'LATER', divPerShare:1, divExDate:'2026-12-01' }, shares:10, ccy:'SGD' },
      { s:{ symbol:'SOONER', divPerShare:1, divExDate:'2026-10-15' }, shares:10, ccy:'SGD' }] }));
    assert.deepStrictEqual(arr(two.map(i => i.title)), ['SOONER dividend']);
    // a pay date beyond the window falls back to the ex-date, so nothing is listed outside the 90 days
    const lateDiv = sb._comingUp('2026-10-07', '2026-11-01', Object.assign({}, base, { salary:null, policies:[] }));
    assert.deepStrictEqual(items(lateDiv), ['2026-10-20 dividend']);
    assert.strictEqual(lateDiv[0].line, '300 shares at S$0.55, ex-date');
    // 55 and over: the engine adds no CPF entries, so the list does not promise one
    assert.deepStrictEqual(items(sb._comingUp('2026-10-07', '2027-01-05', Object.assign({}, base, { ageOf: () => 56 }))).filter(x => x.endsWith('cpf')), []);
    // a payday on or before the CPF anchor is already inside the opening figure
    assert.deepStrictEqual(items(sb._comingUp('2026-10-07', '2027-01-05', Object.assign({}, base, { cpfAnchor:'2026-10-30' }))).filter(x => x.endsWith('cpf')), []);
    // no salary: only the other items
    assert.deepStrictEqual(items(sb._comingUp('2026-10-07', '2027-01-05', Object.assign({}, base, { salary:null }))), ['2026-10-28 insurance', '2026-11-05 dividend']);
    // nothing in the window
    assert.deepStrictEqual(arr(sb._comingUp('2026-10-07', '2026-10-19', Object.assign({}, base, { salary:null }))), []);
    // the window ends inclusively and four is the cap
    const many = Object.assign({}, base, { policies: [1, 2, 3, 4, 5, 6].map(i => ({ status:'Active', insurer:'P' + i, plan:'', premium:10, premiumDue:'2026-10-1' + i })) });
    const capped = sb._comingUp('2026-10-07', '2026-10-30', many);
    assert.strictEqual(capped.length, 4);
    assert.deepStrictEqual(arr(capped.map(i => i.title)), ['P1 premium', 'P2 premium', 'P3 premium', 'P4 premium']);
    assert.strictEqual(sb._comingUp('2026-10-07', '2026-10-28', Object.assign({}, base, { salary:null, dividendRows:[] })).length, 1);
    assert.strictEqual(sb._comingUp('2026-10-07', '2026-10-27', Object.assign({}, base, { salary:null, dividendRows:[] })).length, 0);
    // a zero premium is shown without an amount, a missing insurer or plan does not print "undefined"
    const bare = sb._comingUp('2026-10-07', '2026-12-01', { salary:null, ageOf:()=>null, cpfAnchor:'', dividendRows:[], money, policies:[{ status:'Active', premiumDue:'2026-10-20' }] });
    assert.strictEqual(bare[0].title, 'Insurance premium');
    assert.strictEqual(bare[0].amount, null);
    assert.strictEqual(/undefined|NaN/.test(JSON.stringify(bare)), false);
  });

  test('_insuranceDueWithin and _upcomingDividendRows - the shared rules behind the register cards and the Coming up list', () => {
    const sb = freshSandbox();
    const policies = [
      { id:'late', status:'Active', premiumDue:'2026-11-30' }, { id:'edge', status:'Active', premiumDue:'2026-10-07' },
      { id:'lapsed', status:'Lapsed', premiumDue:'2026-10-20' }, { id:'past', status:'Active', premiumDue:'2026-10-06' },
      { id:'none', status:'Active' }, { id:'end', status:'Active', premiumDue:'2027-01-05' }, { id:'after', status:'Active', premiumDue:'2027-01-06' }
    ];
    assert.deepStrictEqual(arr(sb._insuranceDueWithin(policies, '2026-10-07', '2027-01-05').map(p => p.id)), ['edge', 'late', 'end']);
    assert.deepStrictEqual(arr(sb._insuranceDueWithin(null, '2026-10-07', '2027-01-05')), []);
    const rows = [
      { s:{ symbol:'B', divPerShare:1, divExDate:'2026-12-01' } }, { s:{ symbol:'A', divPerShare:1, divExDate:'2026-10-07' } },
      { s:{ symbol:'C', divPerShare:0, divExDate:'2026-10-10' } }, { s:{ symbol:'D', divPerShare:1, divExDate:'' } },
      { s:{ symbol:'E', divPerShare:1, divExDate:'2026-10-06' } }, { s:{ symbol:'F', divPerShare:1, divExDate:'2027-01-05' } },
      { s:{ symbol:'G', divPerShare:1, divExDate:'2027-01-06' } }
    ];
    assert.deepStrictEqual(arr(sb._upcomingDividendRows(rows, '2026-10-07', '2027-01-05').map(r => r.s.symbol)), ['A', 'B', 'F']);
    assert.deepStrictEqual(arr(sb._upcomingDividendRows(undefined, '2026-10-07', '2027-01-05')), []);
    assert.ok(extractFunction('renderInsurance').includes('_insuranceDueWithin(list, todayISO, horizonISO)'));
    assert.ok(extractFunction('renderDividendTimeline').includes('_upcomingDividendRows(rows, today, cutoff)'));
  });

  test('_cfMonthRollup - the Income & spending month definition: take-home, expenses (unconvertible ones count 0), net and savings rate', () => {
    const sb = freshSandbox({settings:{fxOverrides:{USDSGD:1.35},fxRates:{}}});
    const income = [{ date:'2026-09-30', gross:8000, net:6400 }, { date:'2026-09-10', gross:1000, employeeCPF:200 }, { date:'2026-08-31', gross:8000, net:6400 }];
    const expenses = [{ date:'2026-09-30', amount:3200, currency:'SGD' }, { date:'2026-09-15', amount:1000, currency:'JPY' }, { date:'2026-09-02', amount:100, currency:'USD' }];
    const sep = sb._cfMonthRollup(income, expenses, '2026-09');
    assert.strictEqual(sep.gross, 9000);
    assert.strictEqual(sep.net, 6400 + 800);                         // typed net wins, else gross less employee CPF
    assert.ok(Math.abs(sep.exp - (3200 + 100 * 1.35)) < 1e-9);       // the JPY expense has no rate, so it counts 0
    assert.ok(Math.abs(sep.ne - (7200 - 3335)) < 1e-9);
    assert.ok(Math.abs(sep.rate - (3865 / 7200 * 100)) < 1e-9);
    assert.strictEqual(sep.txns, 2 + 3);
    const none = sb._cfMonthRollup(income, expenses, '2026-07');
    assert.deepStrictEqual({ gross:none.gross, net:none.net, exp:none.exp, ne:none.ne, rate:none.rate, txns:none.txns }, { gross:0, net:0, exp:0, ne:0, rate:null, txns:0 });
    assert.strictEqual(sb._cfMonthRollup([], [{ date:'2026-09-30', amount:50, currency:'SGD' }], '2026-09').rate, null);  // expenses with no take-home: no rate
    assert.strictEqual(sb._cfMonthRollup([{ date:'2026-09-30', gross:0, net:0 }], [], '2026-09').rate, null);
    assert.strictEqual(sb._cfMonthRollup([{ date:'2026-09-30', net:100 }], [{ date:'2026-09-30', amount:150, currency:'SGD' }], '2026-09').rate, -50);
    // one definition: the Income & spending monthly table and the dashboard tile both read it
    assert.ok(extractFunction('renderCashflow').includes('_cfMonthRollup(income, expenses, ym)'));
    assert.ok(appSrc.includes('_cfMonthRollup(income, expenses, ym)'));
    assert.ok(appSrc.slice(appSrc.indexOf('function _savingsTile')).includes('_cfMonthRollup(income, expenses, ym)'));
  });

  test('_fireYearAge and _fireProgress - the shared FIRE figures the Projections page and the dashboard tile both quote', () => {
    const sb = freshSandbox({settings:{fireTarget:720000,fxOverrides:{USDSGD:1.35},fxRates:{}}});
    assert.strictEqual(sb._fireYearAge(null, 31), null);
    stubNow(sb, '2026-10-07T04:00:00.000Z');
    assert.deepStrictEqual({ ...sb._fireYearAge(0, 31) }, { year:2026, age:31 });
    assert.deepStrictEqual({ ...sb._fireYearAge(172, 31) }, { year:2040, age:45 });
    assert.deepStrictEqual({ ...sb._fireYearAge(11, null) }, { year:2026, age:0 });
    sb._liquidAssetValueInfo = () => ({ total:121435, incomplete:false });
    const p = sb._fireProgress();
    assert.strictEqual(p.fireNumber, 720000);
    assert.strictEqual(p.liquidNow, 121435);
    assert.strictEqual(p.progressPct, 17);
    sb._liquidAssetValueInfo = () => ({ total:900000, incomplete:false });
    assert.strictEqual(sb._fireProgress().progressPct, 100);          // capped
    sb.DB.settings.fireTarget = null; sb.DB.expenses = [];
    const none = sb._fireProgress();
    assert.strictEqual(none.fireNumber, null);
    assert.strictEqual(none.progressPct, 0);
    assert.ok(extractFunction('renderProjections').includes('const progressPct = fire.progressPct;'));
    assert.ok(appSrc.slice(appSrc.indexOf('function _fireTile')).includes('_fireProgress()'));
  });

  test('_cryptoRow - the Crypto tab rows: SGD value and cost, P&L only with a price, a missing FX rate leaves cost null', () => {
    const sb = freshSandbox({settings:{fxOverrides:{USDSGD:1.35},fxRates:{}},_priceCache:{ bitcoin:{ sgd:152000, change24h:1.8, fetchedAt:new Date().toISOString() } }});
    sb.coinIdFor = (id) => String(id).toLowerCase();
    const row = c => sb._cryptoRow(c);
    const btc = row({ id:'c1', symbol:'BTC', coingeckoId:'bitcoin', amount:0.25, avgCost:60000, currency:'USD' });
    assert.strictEqual(btc.mv, 38000);
    assert.strictEqual(btc.cost, sb.roundMoney(0.25 * 60000 * 1.35));
    assert.strictEqual(btc.pl, sb.roundMoney(38000 - btc.cost));
    assert.ok(Math.abs(btc.plPct - 17750 / 20250 * 100) < 1e-9);
    assert.strictEqual(btc.priceSgd, 152000);
    assert.strictEqual(btc.stale, false);
    const noPrice = row({ id:'c2', symbol:'FOO', amount:5, avgCost:10, currency:'USD' });
    assert.strictEqual(noPrice.mv, null); assert.strictEqual(noPrice.pl, null); assert.strictEqual(noPrice.plPct, null);
    assert.strictEqual(noPrice.stale, true); assert.strictEqual(noPrice.cost, sb.roundMoney(5 * 10 * 1.35));
    assert.strictEqual(row({ id:'c3', symbol:'BTC', coingeckoId:'bitcoin', amount:1, avgCost:5, currency:'JPY' }).cost, null);   // no JPY rate
    assert.strictEqual(row({ id:'c4', symbol:'BTC', coingeckoId:'bitcoin', amount:1, avgCost:0, currency:'JPY' }).cost, 0);      // nothing to convert
    assert.ok(extractFunction('renderCrypto').includes('_cryptoRow(c)'));
  });

  test('Dashboard rows - the retired widgets, code and styles are gone, the two row widgets and the Settings anchor exist', () => {
    ['dash-assets', 'dash-ef', 'dash-targets', 'dash-movers'].forEach(id => assert.strictEqual(indexSrc.includes('id="' + id + '"'), false, id));
    ['dash-overview', 'dash-activity', 'dash-cpf', 'dash-networth'].forEach(id => assert.ok(indexSrc.includes('id="' + id + '"'), id));
    assert.ok(indexSrc.includes('<div id="dash-overview" data-wid="overview"></div>') && indexSrc.includes('<div id="dash-activity" data-wid="activity"></div>'));
    assert.ok(indexSrc.includes('id="settings-targets"'));
    ['renderEmergencyFund', 'renderTargetAllocation', 'renderTopMovers', 'rebal-alert', 'dash-hero-chip', 'dash-class-card', 'movers-grid', 'mover-sym', 'alloc-legend-amt', 'mover-px'].forEach(name => {
      assert.strictEqual(appSrc.includes(name), false, name + ' in app.js');
      assert.strictEqual(indexSrc.includes(name), false, name + ' in index.html');
    });
    // shared by the Stocks sector card, so it must stay
    assert.ok(indexSrc.includes('.alloc-seg{display:flex'));
    assert.ok(indexSrc.includes('.alloc-legend{display:flex;flex-wrap:wrap;gap:5px 14px'));
    const dashboardSrc = extractFunction('renderDashboard');
    ['_gainPill(change.diff, change.pct)', '_dashWhereItSits(', '_dashHealth(', '_dashHoldings(', '_dashToday('].forEach(call => assert.ok(dashboardSrc.includes(call), call));
    assert.ok(dashboardSrc.includes('past month'));
    assert.deepStrictEqual(arr(Object.keys(vm.runInContext('DASH_WIDGET_NAMES', freshSandbox()))), ['networth', 'overview', 'activity', 'cpf']);
    assert.ok(indexSrc.includes('.dash-row{display:grid;grid-template-columns:minmax(0,1fr);gap:16px'));
    assert.ok(indexSrc.includes('@media (min-width:1024px){.dash-row{grid-template-columns:minmax(0,1.55fr) minmax(0,1fr)}}'));
  });

  test('Tab icons - every tab has its own icon, Explore no longer reuses the Stocks line chart', () => {
    const tabsBlock = appSrc.slice(appSrc.indexOf('const TABS = ['), appSrc.indexOf('const PHASE_2_TABS'));
    const icons = Array.from(tabsBlock.matchAll(/key:'([a-z0-9]+)'[^\n]*?icon:'(<svg[^']*)'/g)).map(m => [m[1], m[2]]);
    assert.strictEqual(icons.length, 12);
    assert.strictEqual(new Set(icons.map(i => i[1])).size, icons.length, 'duplicate tab icon');
    const explore = icons.find(i => i[0] === 'explore')[1];
    assert.strictEqual(explore.includes('M3 17l6-6 4 4 8-8'), false);
  });

  /* ═══ Navigation shell (v2.72): sidebar groups, phone areas, counts, the + Add menu, the sync row, the rename ═══ */

  const navPlain = x => JSON.parse(JSON.stringify(x));
  const NAV_TAB_KEYS = ['dashboard', 'projections', 'explore', 'stocks', 'crypto', 'cash', 'cpf', 'realestate', 'insurance', 'cashflow', 'board', 'settings'];
  const NAV_PHONE_AREA = { dashboard:'overview', projections:'plan', explore:'more', stocks:'assets', crypto:'assets', cash:'assets', cpf:'assets', realestate:'assets', insurance:'assets', cashflow:'money', board:'money', settings:'more' };
  const navPark = (sb, keys) => vm.runInContext(keys.map(k => 'PHASE_2_TABS.add(' + JSON.stringify(k) + ')').join(';'), sb);

  /* A small stand-in for the DOM nodes the navigation code touches: attributes, classes, hidden, focus and click. */
  function fakeEl(attrs, extra){
    const a = Object.assign({}, attrs);
    const classes = new Set(String(a.class || '').split(/\s+/).filter(Boolean));
    const el = Object.assign({
      innerHTML: '', textContent: '', hidden: false, title: '', clicks: 0,
      classList: {
        add: (...names) => names.forEach(n => classes.add(n)), remove: (...names) => names.forEach(n => classes.delete(n)), contains: n => classes.has(n),
        toggle: (n, on) => { const want = on === undefined ? !classes.has(n) : !!on; if (want) classes.add(n); else classes.delete(n); return want; }
      },
      getAttribute: n => (n in a ? a[n] : null),
      setAttribute: (n, v) => { a[n] = String(v); },
      removeAttribute: n => { delete a[n]; },
      hasAttribute: n => n in a,
      click(){ this.clicks++; }
    }, extra || {});
    el.attrs = a;
    el.classes = classes;
    return el;
  }

  test('nav groups - TABS is in display order, every tab sits in exactly one sidebar group (Settings aside) and one phone area', () => {
    const sb = freshSandbox();
    const tabs = navPlain(vm.runInContext('TABS', sb)).map(t => t.key);
    const side = navPlain(vm.runInContext('NAV_GROUPS', sb));
    const phone = navPlain(vm.runInContext('MOBILE_GROUPS', sb));
    assert.deepStrictEqual(side.map(g => g.label), ['Overview', 'Assets', 'Money']);
    assert.deepStrictEqual(phone.map(g => g.label), ['Overview', 'Assets', 'Money', 'Plan', 'More']);
    // TABS lists the tabs in the order the sidebar shows them, Settings last
    assert.deepStrictEqual(tabs, side.flatMap(g => g.tabs).concat('settings'));
    assert.deepStrictEqual(tabs, NAV_TAB_KEYS);
    const owners = (groups, key) => groups.filter(g => g.tabs.includes(key)).length;
    tabs.forEach(key => {
      assert.strictEqual(owners(phone, key), 1, key + ' phone areas');
      assert.strictEqual(owners(side, key), key === 'settings' ? 0 : 1, key + ' sidebar groups');
    });
    // Overview and Plan go straight to a page, Assets, Money and More open a sheet, and only More always stays
    assert.deepStrictEqual(phone.map(g => g.goes || ''), ['dashboard', '', '', 'projections', '']);
    phone.filter(g => g.goes).forEach(g => assert.ok(g.tabs.includes(g.goes), g.key));
    assert.deepStrictEqual(phone.filter(g => g.always).map(g => g.key), ['more']);
  });

  test('tab labels - the sidebar, sheets and top bar read Real estate, Watchlist and Income & spending', () => {
    const sb = freshSandbox();
    assert.deepStrictEqual(NAV_TAB_KEYS.map(k => sb._tabLabel(k)),
      ['Dashboard', 'Projections', 'Explore', 'Stocks', 'Crypto', 'Cash', 'CPF', 'Real estate', 'Insurance', 'Income & spending', 'Watchlist', 'Settings']);
    assert.strictEqual(sb._tabLabel('ghost'), 'ghost');
  });

  test('_groupTabKeys - keeps the group order and drops unknown and parked tabs', () => {
    const sb = freshSandbox();
    const assets = navPlain(vm.runInContext('NAV_GROUPS', sb)).find(g => g.key === 'assets');
    assert.deepStrictEqual(arr(sb._groupTabKeys(assets)), ['stocks', 'crypto', 'cash', 'cpf', 'realestate', 'insurance']);
    assert.deepStrictEqual(arr(sb._groupTabKeys({ tabs:['stocks', 'ghost', 'cash'] })), ['stocks', 'cash']);
    assert.deepStrictEqual(arr(sb._groupTabKeys(null)), []);
    assert.deepStrictEqual(arr(sb._groupTabKeys({})), []);
    navPark(sb, ['crypto', 'insurance']);
    assert.deepStrictEqual(arr(sb._groupTabKeys(assets)), ['stocks', 'cash', 'cpf', 'realestate']);
  });

  test('_mobileGroupForTab - the phone area that owns each page, empty for an unknown one', () => {
    const sb = freshSandbox();
    const owner = {};
    NAV_TAB_KEYS.forEach(k => { owner[k] = sb._mobileGroupForTab(k); });
    assert.deepStrictEqual(owner, NAV_PHONE_AREA);
    assert.strictEqual(sb._mobileGroupForTab('ghost'), '');
    assert.strictEqual(sb._mobileGroupForTab(undefined), '');
  });

  test('_navCount and _navCountLabel - a count for the five lists only, hidden at zero, deleted rows never counted', () => {
    const sb = freshSandbox({ stocks:[{}, {}, {}], crypto:[{}], cash:[{}, {}], realestate:[], insurance:[{}], cpfHistory:[{}, {}], watchlist:[{}], trash:[{}, {}, {}, {}] });
    assert.deepStrictEqual(['stocks', 'crypto', 'cash', 'realestate', 'insurance'].map(k => sb._navCount(k)), [3, 1, 2, 0, 1]);
    // CPF has no list of its own, Watchlist and the rest carry no count, and the trash store is separate
    ['cpf', 'board', 'cashflow', 'dashboard', 'projections', 'explore', 'settings'].forEach(k => assert.strictEqual(sb._navCount(k), 0, k));
    assert.deepStrictEqual([0, 1, 12, 150, '7', 2.9, -3, NaN, null, undefined, 'x'].map(n => sb._navCountLabel(n)), ['', '1', '12', '150', '7', '2', '', '', '', '', '']);
    sb.DB.stocks = null;
    assert.strictEqual(sb._navCount('stocks'), 0);
  });

  test('updateNavCounts - fills each badge from its list, empties it at zero, and runs on every renderAll', () => {
    const sb = freshSandbox({ stocks:[{}, {}], crypto:[], cash:[{}] });
    const badges = ['stocks', 'crypto', 'cash', 'realestate', 'insurance'].map(k => fakeEl({ 'data-count-for':k }));
    sb.document = { querySelectorAll: sel => (sel === '[data-count-for]' ? badges : []) };
    sb.updateNavCounts();
    assert.deepStrictEqual(badges.map(b => b.textContent), ['2', '', '1', '', '']);
    sb.DB.crypto.push({}, {}, {});
    sb.updateNavCounts();
    assert.strictEqual(badges[1].textContent, '3');
    assert.ok(extractFunction('renderAll').includes('updateNavCounts();'));
  });

  test('_addMenuModel - the eight existing flows in order, Record trade waits for a stock, a flow with no schema is left out', () => {
    const sb = freshSandbox();
    const tables = ['stocks', 'stockTxns', 'crypto', 'cash', 'realestate', 'insurance', 'income', 'expenses'];
    sb.ENTITY_SCHEMAS = Object.fromEntries(tables.map(t => [t, { title:t, fields:[] }]));
    const model = () => navPlain(sb._addMenuModel());
    assert.deepStrictEqual(model().map(i => i.table), tables);
    assert.deepStrictEqual(model().map(i => i.label), ['Add stock', 'Record trade', 'Add coin', 'Add cash account', 'Add property', 'Add policy', 'Add income', 'Add expense']);
    assert.deepStrictEqual(model().map(i => i.group), ['assets', 'assets', 'assets', 'assets', 'assets', 'assets', 'money', 'money']);
    assert.deepStrictEqual(model().filter(i => i.disabled).map(i => i.table), ['stockTxns']);
    sb.DB.stocks = [{ id:'s1', symbol:'AAPL' }];
    assert.deepStrictEqual(model().filter(i => i.disabled).map(i => i.table), []);
    delete sb.ENTITY_SCHEMAS.crypto;
    assert.strictEqual(model().length, 7);
    assert.strictEqual(model().some(i => i.table === 'crypto'), false);
    // a parked page takes its add flows with it: Stocks owns Add stock and Record trade, Income & spending owns both money flows
    sb.ENTITY_SCHEMAS.crypto = {};
    navPark(sb, ['stocks', 'cashflow']);
    assert.deepStrictEqual(model().map(i => i.table), ['crypto', 'cash', 'realestate', 'insurance']);
    navPark(sb, ['insurance']);
    assert.deepStrictEqual(model().map(i => i.table), ['crypto', 'cash', 'realestate']);
    // every flow the menu offers has a real schema in ENTITY_SCHEMAS
    const schemas = appSrc.slice(appSrc.indexOf('const ENTITY_SCHEMAS = {'), appSrc.indexOf('function normaliseEntityRow'));
    tables.forEach(t => assert.ok(new RegExp('^  ' + t + '\\s*:\\s*\\{', 'm').test(schemas), t + ' has no entity schema'));
  });

  test('renderAddMenu - menu items with roles, a divider between assets and money, Record trade disabled with its reason until a stock exists', () => {
    const sb = freshSandbox();
    sb.ENTITY_SCHEMAS = Object.fromEntries(['stocks', 'stockTxns', 'crypto', 'cash', 'realestate', 'insurance', 'income', 'expenses'].map(t => [t, {}]));
    const menu = fakeEl({});
    sb.document = { getElementById: id => (id === 'add-menu' ? menu : null) };
    sb.renderAddMenu();
    const html = menu.innerHTML;
    assert.strictEqual((html.match(/role="menuitem"/g) || []).length, 8);
    assert.strictEqual((html.match(/role="separator"/g) || []).length, 1);
    assert.ok(html.indexOf('data-a0="insurance"') < html.indexOf('role="separator"') && html.indexOf('role="separator"') < html.indexOf('data-a0="income"'));
    assert.ok(html.includes('data-a0="stockTxns" aria-disabled="true"><span>Record trade</span><span class="menu-hint">Add a stock first</span>'));
    assert.strictEqual((html.match(/aria-disabled/g) || []).length, 1);
    assert.strictEqual((html.match(/tabindex="-1"/g) || []).length, 8);
    sb.DB.stocks = [{ id:'s1' }];
    sb.renderAddMenu();
    assert.strictEqual(menu.innerHTML.includes('aria-disabled'), false);
    assert.strictEqual(/\son[a-z]+="/i.test(menu.innerHTML), false);
  });

  test('addMenuPick - opens only a flow the menu offers, after the menu closes and focus is back on + Add, and a trade without a stock explains itself', () => {
    const sb = freshSandbox();
    const calls = [];
    sb.ENTITY_SCHEMAS = { stocks:{}, stockTxns:{}, income:{} };
    sb.closeShellMenus = back => calls.push('close:' + back);
    sb.openEntityModal = table => calls.push('open:' + table);
    sb.showToast = (msg, kind) => calls.push('toast:' + kind);
    sb.addMenuPick('stocks');
    assert.deepStrictEqual(calls, ['close:true', 'open:stocks']);
    calls.length = 0;
    sb.addMenuPick('stockTxns');
    assert.deepStrictEqual(calls, ['close:true', 'toast:error']);
    calls.length = 0;
    sb.DB.stocks = [{ id:'s1' }];
    sb.addMenuPick('stockTxns');
    assert.deepStrictEqual(calls, ['close:true', 'open:stockTxns']);
    calls.length = 0;
    sb.addMenuPick('cash');       // offered by the menu in the app, but this stub has no schema for it
    sb.addMenuPick('cpfHistory'); // never on the menu
    sb.addMenuPick('ghost');
    sb.addMenuPick(undefined);
    assert.deepStrictEqual(calls, []);
  });

  test('_navIcon and _sideItemHtml - a real link with a hidden icon, the label and a count slot only for the five counted tabs', () => {
    const sb = freshSandbox();
    sb.kjrEscape = v => '{' + v + '}';
    const stocks = sb._sideItemHtml('stocks');
    assert.ok(stocks.startsWith('<li><a class="side-item" href="#{stocks}" data-click="navLink" data-a0="{stocks}" data-tab="{stocks}"><svg aria-hidden="true" focusable="false" '));
    assert.ok(stocks.includes('<span class="side-text">{Stocks}</span>'));
    assert.ok(stocks.includes('<span class="side-count" data-count-for="{stocks}"></span>'));
    assert.ok(stocks.endsWith('</a></li>'));
    ['stocks', 'crypto', 'cash', 'realestate', 'insurance'].forEach(k => assert.ok(sb._sideItemHtml(k).includes('data-count-for'), k));
    ['cpf', 'cashflow', 'board', 'dashboard', 'projections', 'explore'].forEach(k => assert.strictEqual(sb._sideItemHtml(k).includes('side-count'), false, k));
    assert.ok(sb._sideItemHtml('cashflow').includes('<span class="side-text">{Income & spending}</span>'));
    assert.strictEqual(sb._sideItemHtml('ghost'), '');
    assert.strictEqual(sb._navIcon('ghost'), '');
    assert.ok(sb._navIcon('cpf').startsWith('<svg aria-hidden="true" focusable="false" viewBox'));
    assert.strictEqual(/\son[a-z]+="/i.test(stocks), false);
  });

  test('renderSidebarNav - three labelled groups in order, a parked page drops out, a group with none left disappears, Settings hides when parked', () => {
    const sb = freshSandbox();
    const host = fakeEl({});
    const settings = fakeEl({ id:'side-settings' });
    sb.document = { getElementById: id => (id === 'side-nav' ? host : (id === 'side-settings' ? settings : null)) };
    sb.renderSidebarNav();
    const labels = html => Array.from(html.matchAll(/class="side-label" id="[^"]+">([^<]+)</g)).map(m => m[1]);
    const tabsOf = html => Array.from(html.matchAll(/data-tab="([a-z]+)"/g)).map(m => m[1]);
    assert.deepStrictEqual(labels(host.innerHTML), ['Overview', 'Assets', 'Money']);
    assert.deepStrictEqual(tabsOf(host.innerHTML), ['dashboard', 'projections', 'explore', 'stocks', 'crypto', 'cash', 'cpf', 'realestate', 'insurance', 'cashflow', 'board']);
    assert.ok(host.innerHTML.includes('id="side-group-assets">Assets</p><ul class="side-list" aria-labelledby="side-group-assets">'));
    assert.strictEqual(settings.hidden, false);
    navPark(sb, ['cashflow', 'board', 'settings', 'crypto']);
    sb.renderSidebarNav();
    assert.deepStrictEqual(labels(host.innerHTML), ['Overview', 'Assets']);
    assert.strictEqual(tabsOf(host.innerHTML).includes('crypto'), false);
    assert.strictEqual(tabsOf(host.innerHTML).includes('cashflow'), false);
    assert.strictEqual(settings.hidden, true);
  });

  test('renderBottomBar - five areas in order, Overview and Plan go straight to a page, the others open a sheet, a parked page removes its area but More stays', () => {
    const sb = freshSandbox();
    const host = fakeEl({});
    sb.document = { getElementById: id => (id === 'bottom-nav' ? host : null) };
    sb.renderBottomBar();
    const rows = html => Array.from(html.matchAll(/<button type="button" class="bb-item" data-group="([a-z]+)" ([^>]*)><svg.*?<\/svg><span>([^<]+)<\/span><\/button>/g)).map(m => [m[1], m[3], m[2]]);
    const bar = rows(host.innerHTML);
    assert.deepStrictEqual(bar.map(r => r[0]), ['overview', 'assets', 'money', 'plan', 'more']);
    assert.deepStrictEqual(bar.map(r => r[1]), ['Overview', 'Assets', 'Money', 'Plan', 'More']);
    assert.strictEqual(bar[0][2], 'data-click="navigate" data-a0="dashboard"');
    assert.strictEqual(bar[3][2], 'data-click="navigate" data-a0="projections"');
    assert.strictEqual(bar[1][2], 'data-click="openMoreSheet" data-a0="assets" aria-haspopup="dialog"');
    assert.strictEqual(bar[2][2], 'data-click="openMoreSheet" data-a0="money" aria-haspopup="dialog"');
    assert.strictEqual(bar[4][2], 'data-click="openMoreSheet" data-a0="more" aria-haspopup="dialog"');
    assert.strictEqual(/\son[a-z]+="/i.test(host.innerHTML), false);
    navPark(sb, ['projections', 'cashflow', 'board', 'explore', 'settings']);
    sb.renderBottomBar();
    assert.deepStrictEqual(rows(host.innerHTML).map(r => r[0]), ['overview', 'assets', 'more']);
    navPark(sb, ['dashboard']);
    sb.renderBottomBar();
    assert.deepStrictEqual(rows(host.innerHTML).map(r => r[0]), ['assets', 'more']);
  });

  test('_syncNavActive - one sidebar item and one phone area are current on every page, a sheet takes the highlight while aria-current keeps following the page', () => {
    const sb = freshSandbox();
    const side = NAV_TAB_KEYS.map(k => fakeEl({ 'data-tab':k }));
    const bottom = navPlain(vm.runInContext('MOBILE_GROUPS', sb)).map(g => fakeEl(Object.assign({ 'data-group':g.key }, g.goes ? {} : { 'aria-haspopup':'dialog' })));
    sb.document = { querySelectorAll: sel => (sel === '.side-item[data-tab]' ? side : (sel === '#bottom-nav .bb-item' ? bottom : [])) };
    NAV_TAB_KEYS.forEach(key => {
      sb._currentTab = key;
      sb._syncNavActive(key);
      assert.deepStrictEqual(side.filter(e => e.classes.has('active')).map(e => e.attrs['data-tab']), [key], key + ' sidebar active');
      assert.deepStrictEqual(side.filter(e => e.attrs['aria-current']).map(e => e.attrs['data-tab'] + ':' + e.attrs['aria-current']), [key + ':page'], key + ' sidebar aria-current');
      assert.deepStrictEqual(bottom.filter(e => e.classes.has('active')).map(e => e.attrs['data-group']), [NAV_PHONE_AREA[key]], key + ' phone area');
      const current = bottom.filter(e => e.attrs['aria-current']);
      assert.strictEqual(current.length, 1, key);
      assert.strictEqual(current[0].attrs['data-group'], NAV_PHONE_AREA[key], key);
      assert.strictEqual(current[0].attrs['aria-current'], current[0].hasAttribute('aria-haspopup') ? 'true' : 'page', key);
    });
    // Money's sheet open over Stocks: Money takes the tap highlight, aria-current still says Assets
    sb._currentTab = 'stocks';
    sb._syncNavActive('stocks', 'money');
    assert.deepStrictEqual(bottom.filter(e => e.classes.has('active')).map(e => e.attrs['data-group']), ['money']);
    assert.deepStrictEqual(bottom.filter(e => e.attrs['aria-current']).map(e => e.attrs['data-group']), ['assets']);
    // no arguments: the current page decides
    sb._currentTab = 'projections';
    sb._syncNavActive();
    assert.deepStrictEqual(bottom.filter(e => e.classes.has('active')).map(e => e.attrs['data-group']), ['plan']);
    assert.deepStrictEqual(side.filter(e => e.classes.has('active')).map(e => e.attrs['data-tab']), ['projections']);
  });

  test('renderMoreSheet - Assets lists six pages with counts, Money two, More has Explore, Settings, the theme switch, the guide, Trading, Forex and the version', () => {
    const sb = freshSandbox({ stocks:[{}, {}, {}, {}], crypto:[{}], cash:[{}, {}], realestate:[{}], insurance:[{}] });
    const body = fakeEl({});
    const title = fakeEl({});
    sb.document = { getElementById: id => (id === 'more-sheet-body' ? body : (id === 'more-sheet-title' ? title : null)) };
    let themeSynced = 0;
    sb.updateThemeUI = () => { themeSynced++; };
    sb._currentTab = 'cash';
    const rows = html => Array.from(html.matchAll(/data-click="navigate" data-a0="([a-z]+)"[^>]*><svg.*?<\/svg><span class="msr-text">([^<]+)<\/span>(?:<span class="msr-count">(\d+)<\/span>)?/g)).map(m => [m[1], m[2], m[3] || '']);
    sb.renderMoreSheet('assets');
    assert.strictEqual(title.textContent, 'Assets');
    assert.deepStrictEqual(rows(body.innerHTML), [['stocks', 'Stocks', '4'], ['crypto', 'Crypto', '1'], ['cash', 'Cash', '2'], ['cpf', 'CPF', ''], ['realestate', 'Real estate', '1'], ['insurance', 'Insurance', '1']]);
    assert.ok(body.innerHTML.includes('class="btn more-sheet-row active" data-click="navigate" data-a0="cash" aria-current="page"'));
    assert.strictEqual((body.innerHTML.match(/aria-current="page"/g) || []).length, 1);
    assert.strictEqual(body.innerHTML.includes('sheet-version'), false);
    sb.renderMoreSheet('money');
    assert.strictEqual(title.textContent, 'Money');
    assert.deepStrictEqual(rows(body.innerHTML), [['cashflow', 'Income & spending', ''], ['board', 'Watchlist', '']]);
    assert.strictEqual(body.innerHTML.includes('aria-current'), false);
    assert.strictEqual(themeSynced, 0);
    sb.renderMoreSheet('more');
    const more = body.innerHTML;
    assert.strictEqual(title.textContent, 'More');
    assert.deepStrictEqual(rows(more), [['explore', 'Explore', ''], ['settings', 'Settings', '']]);
    assert.ok(more.includes('data-click="toggleTheme" data-theme-switch'));
    assert.ok(more.includes('<span class="tt-light">Switch to light theme</span><span class="tt-dark">Switch to dark theme</span>'));
    assert.ok(more.includes('href="https://kujira-journal.pages.dev" target="_blank" rel="noopener noreferrer"'));
    assert.ok(more.includes('<span class="sr-only">(opens in a new tab)</span>'));
    assert.ok(more.includes('href="../Trading/"') && more.includes('href="../Forex/"'));
    assert.ok(more.includes('<p class="sheet-version">Portfolio ' + vm.runInContext('APP_DISPLAY_VERSION', sb) + '</p>'));
    assert.strictEqual(themeSynced, 1);
    assert.strictEqual(/\son[a-z]+="/i.test(more), false);
    // parked pages leave the sheets, an unknown area opens More
    navPark(sb, ['crypto', 'explore']);
    sb.renderMoreSheet('assets');
    assert.strictEqual(rows(body.innerHTML).some(r => r[0] === 'crypto'), false);
    sb.renderMoreSheet('more');
    assert.deepStrictEqual(rows(body.innerHTML), [['settings', 'Settings', '']]);
    sb.renderMoreSheet('ghost');
    assert.strictEqual(title.textContent, 'More');
  });

  test('shell menus - opening focuses the first item, arrows wrap, Escape returns focus to the button, Tab closes, one menu is open at a time', () => {
    const sb = freshSandbox();
    const focus = { on:null };
    const el = (attrs, extra) => fakeEl(attrs, Object.assign({ focus(){ focus.on = this; } }, extra));
    let addItems = [];
    const wsItems = [0, 1, 2].map(() => el({ role:'menuitem' }));
    const wsBtn = el({ id:'ws-btn', 'data-menu-btn':'ws' });
    const addBtn = el({ id:'add-btn', 'data-menu-btn':'add' });
    const wsMenu = el({ id:'ws-menu' }, { hidden:true, querySelectorAll: () => wsItems });
    const addMenu = el({ id:'add-menu' }, { hidden:true, querySelectorAll: () => addItems });
    sb.renderAddMenu = () => { addItems = [el({ role:'menuitem' }), el({ role:'menuitem' }), el({ role:'menuitem' })]; };
    const byId = { 'ws-btn':wsBtn, 'ws-menu':wsMenu, 'add-btn':addBtn, 'add-menu':addMenu };
    sb.document = { getElementById: id => byId[id] || null, get activeElement(){ return focus.on; } };
    const press = (key, target) => { let prevented = false; sb.shellMenuKeydown({ key, target, preventDefault(){ prevented = true; } }); return prevented; };
    const inside = menu => ({ closest: sel => (sel === '.shell-menu' ? menu : null) });
    const onButton = btn => ({ closest: sel => (sel === '[data-menu-btn]' ? btn : null) });
    // open: first item focused, the button says expanded
    sb.openShellMenu('ws');
    assert.strictEqual(wsMenu.hidden, false);
    assert.strictEqual(wsBtn.attrs['aria-expanded'], 'true');
    assert.strictEqual(focus.on, wsItems[0]);
    // arrows wrap, Home and End jump
    assert.strictEqual(press('ArrowDown', inside(wsMenu)), true);
    assert.strictEqual(focus.on, wsItems[1]);
    press('ArrowDown', inside(wsMenu)); press('ArrowDown', inside(wsMenu));
    assert.strictEqual(focus.on, wsItems[0]);
    press('ArrowUp', inside(wsMenu));
    assert.strictEqual(focus.on, wsItems[2]);
    press('Home', inside(wsMenu));
    assert.strictEqual(focus.on, wsItems[0]);
    press('End', inside(wsMenu));
    assert.strictEqual(focus.on, wsItems[2]);
    // Escape closes and returns focus to the button
    assert.strictEqual(press('Escape', inside(wsMenu)), true);
    assert.strictEqual(wsMenu.hidden, true);
    assert.strictEqual(wsBtn.attrs['aria-expanded'], 'false');
    assert.strictEqual(focus.on, wsBtn);
    // one at a time: opening Add closes the switcher without stealing focus back
    sb.openShellMenu('ws');
    sb.openShellMenu('add');
    assert.strictEqual(wsMenu.hidden, true);
    assert.strictEqual(wsBtn.attrs['aria-expanded'], 'false');
    assert.strictEqual(addMenu.hidden, false);
    assert.strictEqual(addBtn.attrs['aria-expanded'], 'true');
    assert.strictEqual(focus.on, addItems[0]);
    // Tab closes the menu and puts focus on its button, so the browser carries on from there
    press('Tab', inside(addMenu));
    assert.strictEqual(addMenu.hidden, true);
    assert.strictEqual(focus.on, addBtn);
    // arrow keys on the button open it, ArrowUp lands on the last item
    assert.strictEqual(press('ArrowUp', onButton(addBtn)), true);
    assert.strictEqual(addMenu.hidden, false);
    assert.strictEqual(focus.on, addItems[2]);
    // Space on a link item follows it, a link ignores Space natively
    addItems[2].tagName = 'A';
    assert.strictEqual(press(' ', inside(addMenu)), true);
    assert.strictEqual(addItems[2].clicks, 1);
    // toggle closes and returns focus, then opens again
    sb.toggleShellMenu('add');
    assert.strictEqual(addMenu.hidden, true);
    assert.strictEqual(focus.on, addBtn);
    sb.toggleShellMenu('add');
    assert.strictEqual(addMenu.hidden, false);
    // Escape with the menu open but focus elsewhere (opened by mouse) still closes it
    press('Escape', { closest: () => null });
    assert.strictEqual(addMenu.hidden, true);
    assert.strictEqual(focus.on, addBtn);
    // an unknown menu name does nothing
    sb.openShellMenu('ghost');
    sb.toggleShellMenu('ghost');
    assert.strictEqual(wsMenu.hidden && addMenu.hidden, true);
  });

  test('navLink - a plain click routes inside the app, a modified click is left to the browser', () => {
    const sb = freshSandbox();
    const routed = [];
    sb.navigate = key => routed.push(key);
    const link = fakeEl({ 'data-a0':'stocks' });
    let prevented = 0;
    const click = mods => Object.assign({ preventDefault(){ prevented++; } }, mods);
    sb.navLink(link, click({}));
    assert.deepStrictEqual(routed, ['stocks']);
    assert.strictEqual(prevented, 1);
    ['metaKey', 'ctrlKey', 'shiftKey', 'altKey'].forEach(m => sb.navLink(link, click({ [m]:true })));
    assert.deepStrictEqual(routed, ['stocks']);
    assert.strictEqual(prevented, 1);
    sb.navLink(link);
    assert.deepStrictEqual(routed, ['stocks', 'stocks']);
  });

  test('_syncTopbarContext - the top bar shows the TABS label and the page\'s own status or sub line', () => {
    const sb = freshSandbox();
    const title = fakeEl({});
    const sub = fakeEl({});
    const pages = {
      'page-dashboard': { querySelector: sel => (sel.includes('.page-status') ? { textContent:'  Thursday 8 October · prices just now  ' } : null) },
      'page-stocks': { querySelector: () => null },
      'page-cashflow': { querySelector: () => ({ textContent:'Monthly income, per-transaction expenses, savings rate.' }) }
    };
    sb.document = { getElementById: id => (id === 'tb-title' ? title : (id === 'tb-sub' ? sub : (pages[id] || null))) };
    sb._currentTab = 'dashboard';
    sb._syncTopbarContext();
    assert.strictEqual(title.textContent, 'Dashboard');
    assert.strictEqual(sub.textContent, 'Thursday 8 October · prices just now');
    sb._currentTab = 'stocks';
    sb._syncTopbarContext();
    assert.deepStrictEqual([title.textContent, sub.textContent], ['Stocks', '']);
    sb._currentTab = 'cashflow';
    sb._syncTopbarContext();
    assert.deepStrictEqual([title.textContent, sub.textContent], ['Income & spending', 'Monthly income, per-transaction expenses, savings rate.']);
    sb._currentTab = 'cpf';   // a page missing from the DOM leaves the line empty
    sb._syncTopbarContext();
    assert.deepStrictEqual([title.textContent, sub.textContent], ['CPF', '']);
    // the line is read from the page head's own text block, never from a card further down
    assert.ok(extractFunction('_syncTopbarContext').includes("'.page-head .ph-text .page-status, .page-head .ph-text .page-sub'"));
    // the dashboard hands its live status line over each time it redraws it
    assert.ok(extractFunction('renderDashboard').includes('_syncTopbarContext();'));
    assert.ok(extractFunction('showPage').includes('_syncTopbarContext();'));
  });

  test('sync row - Synced shows its age in words, the phone dot mirrors the state, and no other state shows an age', () => {
    const sb = freshSandbox();
    const ui = installSyncStatusDom(sb);
    const age = fakeEl({});
    const dot = fakeEl({ id:'sync-dot', class:'icon-btn sync-dot s-local' });
    const words = fakeEl({});
    const base = sb.document.getElementById;
    sb.document.getElementById = id => (id === 'sync-pill-age' ? age : (id === 'sync-dot' ? dot : (id === 'sync-dot-label' ? words : base(id))));
    sb.relTime = () => '2m ago';
    const stamp = '2026-10-08T10:00:00.000Z';
    sb.localStorage.setItem('kjr-pf-sync-ts-v1', stamp);
    sb.localStorage.setItem('kjr-pf-sync-confirmed-ts-v1', stamp);
    sb.updateSyncStatusPill();
    assert.strictEqual(ui.label.textContent, 'Synced');
    assert.strictEqual(age.textContent, '2m ago');
    assert.strictEqual(ui.pill.attrs['aria-label'], 'Sync status: Synced, 2m ago');
    assert.strictEqual(words.textContent, 'Sync status: Synced, 2m ago');
    assert.strictEqual(dot.classes.has('s-synced'), true);
    assert.strictEqual(dot.classes.has('s-local'), false);
    // an unconfirmed time: the word alone, no invented age
    sb.localStorage.removeItem('kjr-pf-sync-confirmed-ts-v1');
    sb.updateSyncStatusPill();
    assert.strictEqual(ui.label.textContent, 'Synced');
    assert.strictEqual(age.textContent, '');
    assert.strictEqual(ui.pill.attrs['aria-label'], 'Sync status: Synced');
    // other states never carry an age, the dot follows them in words too
    sb.localStorage.setItem('kjr-pf-sync-confirmed-ts-v1', stamp);
    sb._recordSyncFailure('read', 'read_failed');
    sb.updateSyncStatusPill();
    assert.strictEqual(ui.label.textContent, 'Sync failed');
    assert.strictEqual(age.textContent, '');
    assert.strictEqual(ui.pill.attrs['aria-label'], 'Sync status: Sync failed');
    assert.strictEqual(words.textContent, 'Sync status: Sync failed');
    assert.strictEqual(dot.classes.has('s-failed'), true);
    assert.strictEqual(dot.classes.has('s-synced'), false);
  });

  test('_syncAgeText and _refreshSyncAge - the age comes from the server-confirmed time, none in NAS mode, and the minute tick never repaints another state as synced', () => {
    const sb = freshSandbox();
    const ui = installSyncStatusDom(sb);
    const age = fakeEl({});
    const words = fakeEl({});
    const base = sb.document.getElementById;
    sb.document.getElementById = id => (id === 'sync-pill-age' ? age : (id === 'sync-dot-label' ? words : base(id)));
    sb.relTime = () => '5m ago';
    assert.strictEqual(sb._syncAgeText(), '');
    sb.localStorage.setItem('kjr-pf-sync-confirmed-ts-v1', 'not-a-timestamp');
    assert.strictEqual(sb._syncAgeText(), '');
    const stamp = '2026-10-08T10:00:00.000Z';
    sb.localStorage.setItem('kjr-pf-sync-confirmed-ts-v1', stamp);
    assert.strictEqual(sb._syncAgeText(), '5m ago');
    sb.isNasMode = () => true;
    assert.strictEqual(sb._syncAgeText(), '');
    sb.isNasMode = () => false;
    ui.classes.add('s-failed');
    sb._refreshSyncAge();
    assert.strictEqual(age.textContent, '');
    assert.strictEqual(ui.pill.attrs['aria-label'], undefined);
    ui.classes.delete('s-failed');
    ui.classes.add('s-synced');
    sb._refreshSyncAge();
    assert.strictEqual(age.textContent, '5m ago');
    assert.strictEqual(ui.pill.attrs['aria-label'], 'Sync status: Synced, 5m ago');
    assert.strictEqual(words.textContent, 'Sync status: Synced, 5m ago');
    sb.relTime = () => '6m ago';
    sb._refreshSyncAge();
    assert.strictEqual(age.textContent, '6m ago');
    // boot starts the once-a-minute tick
    assert.ok(extractFunction('boot').includes('setInterval(_refreshSyncAge, 60000)'));
  });

  test('shell markup - skeleton, switcher links, + Add, sync row and phone dot are in place and wired through data-click, the old nav is gone', () => {
    ['class="shell"', 'class="sidebar" id="sidebar"', 'id="side-nav"', 'aria-label="Portfolio"', 'class="side-foot"', 'class="content-col"', 'class="topbar" id="topbar"',
      'id="tb-title"', 'id="tb-sub"', 'id="bottom-nav"', 'id="more-sheet-title"', 'id="logo-version"', 'id="privacy-toggle"', 'class="ccy-toggle"', 'id="side-settings"', 'id="main"'
    ].forEach(frag => assert.ok(indexSrc.includes(frag), frag));
    // the switcher: a menu button and real links, Portfolio marked current
    const ws = indexSrc.slice(indexSrc.indexOf('id="ws-btn"'), indexSrc.indexOf('id="side-nav"'));
    assert.ok(ws.includes('aria-haspopup="menu" aria-expanded="false" aria-controls="ws-menu"'));
    assert.ok(ws.includes('role="menu"') && ws.includes('hidden'));
    assert.deepStrictEqual(Array.from(ws.matchAll(/<a class="menu-item"[^>]*href="([^"]+)"/g)).map(m => m[1]), ['../Trading/', '../Forex/', './']);
    assert.strictEqual((ws.match(/aria-current="page"/g) || []).length, 1);
    assert.ok(/<a class="menu-item"[^>]*href="\.\/" aria-current="page">Portfolio/.test(ws));
    // + Add
    assert.ok(indexSrc.includes('id="add-btn" data-menu-btn="add" data-click="toggleShellMenu" data-a0="add" aria-haspopup="menu" aria-expanded="false" aria-controls="add-menu"'));
    assert.ok(indexSrc.includes('id="add-menu" role="menu" aria-label="Add" hidden'));
    // the sync row keeps the three ids the status code reads, and the phone dot has its own
    ['id="sync-pill"', 'id="sync-pill-label"', 'id="sync-pill-age"', 'id="sync-dot"', 'id="sync-dot-label"'].forEach(frag => assert.ok(indexSrc.includes(frag), frag));
    assert.ok(indexSrc.includes('id="sync-pill" class="sync-pill s-local" data-click="openSyncDetails"'));
    assert.ok(indexSrc.includes('id="sync-dot" class="icon-btn sync-dot s-local" data-click="openSyncDetails"'));
    // theme switch has an accessible name, the guide link points at the Journal
    assert.ok(indexSrc.includes('data-click="toggleTheme" data-theme-switch title="Switch to light theme" aria-label="Switch to light theme"'));
    assert.ok(indexSrc.includes('<a class="icon-btn docs-link" href="https://kujira-journal.pages.dev" target="_blank" rel="noopener noreferrer"'));
    // no inline handlers anywhere in the shell (CSP)
    const shell = indexSrc.slice(indexSrc.indexOf('<div class="shell">'), indexSrc.indexOf('<main class="main"'));
    assert.strictEqual(/\son[a-z]+="/i.test(shell), false);
    // the old strip, dropdown, switcher pill and logo block are gone from markup, styles and code
    ['nav-host', 'nav-more', 'tb-tab', 'topbar-actions', 'icon-btn-group', 'logo-whale', 'logo-name', 'nav-btn', 'phase-chip-mini'].forEach(name => assert.strictEqual(indexSrc.includes(name), false, name + ' in index.html'));
    ['_layoutDesktopNav', 'toggleNavMore', 'openNavMore', 'closeNavMore', '_updateNavMoreActive', 'nav-more', 'nav-host', 'MOBILE_BOTTOM_TABS', '_phase2LabelFor'].forEach(name => assert.strictEqual(appSrc.includes(name), false, name + ' in app.js'));
    // the delegated actions
    const actions = extractFunction('installEventDelegation');
    ['navLink:', 'toggleShellMenu:', 'addMenuPick:', 'openMoreSheet:       (el) => openMoreSheet(A(el)[0])'].forEach(frag => assert.ok(actions.includes(frag), frag));
    assert.strictEqual(actions.includes('toggleNavMore'), false);
    assert.ok(actions.includes("document.addEventListener('keydown', shellMenuKeydown);"));
    assert.ok(actions.includes("if (!e.target.closest('.menu-wrap')) closeShellMenus(false);"));
    // showPage no longer lays out a strip, it marks the current page, closes menus and the sheet, and fills the top bar
    const page = extractFunction('showPage');
    ['closeMoreSheet();', 'closeShellMenus(false);', '_syncNavActive(key);', '_syncTopbarContext();'].forEach(frag => assert.ok(page.includes(frag), frag));
  });

  test('shell styles - the --sidebar token in both themes, a solid sidebar with a hairline, the 224px column, and the 768px split', () => {
    assert.ok(indexSrc.includes('--sidebar:#EFECE4;'));
    assert.ok(indexSrc.includes('--sidebar:#080D19;'));
    assert.ok(/html\.dark\{[^}]*--sidebar:#080D19;/.test(indexSrc));
    assert.ok(indexSrc.includes('.shell{display:grid;grid-template-columns:224px minmax(0,1fr)'));
    assert.ok(/\.sidebar\{[^}]*background:var\(--sidebar\);border-right:1px solid var\(--border\)\}/.test(indexSrc));
    assert.strictEqual(/\.sidebar\{[^}]*backdrop-filter/.test(indexSrc), false);   // the sidebar is solid, glass is for floating elements
    assert.ok(indexSrc.includes('.side-label{margin:0;padding:12px 10px 6px;font-size:11px;line-height:14px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:var(--sidebar-dim)}'));
    assert.ok(indexSrc.includes('.side-item.active{background:var(--accent-soft);color:var(--accent);font-weight:700}'));
    assert.ok(indexSrc.includes('@media (min-width:769px){\n  .page-head .ph-text{position:absolute'));
    assert.ok(indexSrc.includes('@media (max-width: 768px){\n  .shell{display:block}\n  .sidebar{display:none}'));
    assert.ok(indexSrc.includes('.icon-btn{width:44px;height:44px}'));
    assert.ok(indexSrc.includes('.bb-item{flex:1 1 0;min-width:0;min-height:44px;'));
  });

  test('shell contrast - --sidebar-dim exists in both themes and carries the sidebar small text, and every small text on the shell clears 4.5:1 on its own surface', () => {
    const block = start => { const i = indexSrc.indexOf(start); assert.ok(i > -1, start); return indexSrc.slice(i, indexSrc.indexOf('\n}', i)); };
    const light = block(':root{');
    const dark = block('html.dark{');
    const token = (blk, name) => {
      const m = new RegExp('--' + name + ':([^;]+);').exec(blk);
      assert.ok(m, '--' + name + ' missing');
      const ref = /^var\(--([a-z0-9-]+)\)$/.exec(m[1].trim());
      return ref ? token(blk, ref[1]) : m[1].trim();
    };
    // the token is declared per theme, light steps up to --text2, dark keeps --text3
    assert.ok(/--sidebar-dim:var\(--text2\);/.test(light));
    assert.ok(/--sidebar-dim:var\(--text3\);/.test(dark));
    // the sidebar's small text uses it, and none of it still reaches for --text3 directly
    const rule = sel => {
      const m = new RegExp('(?:^|\\n)' + sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\{([^}]*)\\}').exec(indexSrc);
      assert.ok(m, sel + ' rule missing');
      return m[1];
    };
    ['.ws-sub', '.side-label', '.side-count', '.side-version', '.sync-age'].forEach(sel => {
      assert.ok(rule(sel).includes('color:var(--sidebar-dim)'), sel + ' must use --sidebar-dim');
      assert.strictEqual(rule(sel).includes('--text3'), false, sel + ' still uses --text3');
    });
    // the top bar status line, the idle currency segment and the sheet counts move to --text2, the version is --text2 in dark and --text in light
    ['.tb-sub', '.ccy-toggle button', '.more-sheet-row .msr-count,.more-sheet-row .msr-ext', '.sheet-version'].forEach(sel => assert.ok(rule(sel).includes('color:var(--text2)'), sel));
    assert.ok(rule('html:not(.dark) .sheet-version').includes('color:var(--text)'));
    // hovered or open, the 6 to 7% tint under the dim text lowers its contrast, so the count, the sub and the age follow their label to --text
    ['.side-item:hover .side-count{color:var(--text)}', '.sync-pill:hover .sync-age{color:var(--text)}', '.ws-btn:hover .ws-sub{color:var(--text)}', '.ws-btn[aria-expanded="true"] .ws-sub{color:var(--text)}']
      .forEach(frag => assert.ok(indexSrc.includes(frag), frag));
    // WCAG ratios from the declared tokens, composited the way the browser stacks them
    const rgb = h => { h = h.replace('#', ''); return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)); };
    const lin = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    const lum = c => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
    const ratio = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
    const over = (top, alpha, bottom) => top.map((v, i) => v * alpha + bottom[i] * (1 - alpha));
    const rgba = v => { const m = /rgba\((\d+),(\d+),(\d+),([\d.]+)\)/.exec(v); assert.ok(m, v); return { c:[+m[1], +m[2], +m[3]], a:+m[4] }; };
    const scrim = +/\.overlay\{[^}]*background:rgba\(0,0,0,([\d.]+)\)/.exec(indexSrc)[1];
    [['light', light, 'text2'], ['dark', dark, 'text2']].forEach(([name, blk, textToken]) => {
      const t2 = rgb(token(blk, textToken)), dim = rgb(token(blk, 'sidebar-dim')), sidebar = rgb(token(blk, 'sidebar'));
      assert.ok(ratio(dim, sidebar) >= 4.5, name + ' --sidebar-dim on --sidebar ' + ratio(dim, sidebar).toFixed(2));
      const tint = over(rgb(token(blk, 'text')), 0.07, sidebar);
      assert.ok(ratio(rgb(token(blk, 'text')), tint) >= 4.5, name + ' --text on the 7% hover tint ' + ratio(rgb(token(blk, 'text')), tint).toFixed(2));
      // the glass top bar over the page background and over a card, the two surfaces that scroll behind it
      const glass = rgba(token(blk, 'glass'));
      [['--bg', rgb(token(blk, 'bg'))], ['--bg2', rgb(token(blk, 'bg2'))]].forEach(([surface, base]) => {
        const bar = over(glass.c, glass.a, base);
        assert.ok(ratio(t2, bar) >= 4.5, name + ' top bar status line over ' + surface + ' ' + ratio(t2, bar).toFixed(2));
      });
      // the sheet is glass over a dark scrim: rows are one glass layer above the sheet surface
      const sheet = over(rgba(token(blk, 'glass-strong')).c, rgba(token(blk, 'glass-strong')).a, over([0, 0, 0], scrim, rgb(token(blk, 'bg'))));
      const row = over(glass.c, glass.a, sheet);
      assert.ok(ratio(t2, row) >= 4.5, name + ' sheet counts on a row ' + ratio(t2, row).toFixed(2));
      const versionInk = name === 'light' ? rgb(token(blk, 'text')) : t2;
      assert.ok(ratio(versionInk, sheet) >= 4.5, name + ' sheet version on the sheet ' + ratio(versionInk, sheet).toFixed(2));
    });
  });

  test('Income & spending - the cashflow tab carries the new name where it is shown, the Stocks P&L columns and the CSV export keep theirs', () => {
    const sb = freshSandbox();
    assert.strictEqual(sb._tabLabel('cashflow'), 'Income & spending');
    assert.ok(indexSrc.includes('<h2 class="page-title">Income &amp; spending</h2>'));
    assert.ok(indexSrc.includes('(holdings, cash, CPF, Income &amp; spending, settings)'));
    assert.ok(extractFunction('renderCashflow').includes('No income or spending data yet'));
    assert.ok(extractFunction('_savingsTile').includes('Add income on Income &amp; spending'));
    assert.ok(appSrc.includes('Log income on the Income &amp; spending tab') && appSrc.includes('Log expenses on the Income &amp; spending tab'));
    assert.ok(appSrc.includes('Phase 1 focus is Stocks, Real estate, Cash, CPF, Income &amp; spending, and Settings.'));
    ['No P&L data yet', 'Add income on P&amp;L', 'on the P&amp;L tab', 'CPF, P&amp;L, and Settings'].forEach(old => assert.strictEqual(appSrc.includes(old), false, old));
    assert.strictEqual(/key:'cashflow',\s+label:'P&L'/.test(appSrc), false);
    assert.strictEqual(indexSrc.includes('page-title">P&amp;L'), false);
    // the Stocks and Crypto columns, the holdings CSV header and the Chart Builder fields are a different P&L and keep their names
    ['label:dc=>`Realised P&L (${dc})`', "label:()=>'P&L %'", "'Market Value (SGD)','P&L (SGD)','P&L %'", "unrealPnl:  { label:'Unrealised P&L'"].forEach(keep => assert.ok(appSrc.includes(keep), keep));
  });

  test('Monogram and money markup - symbols and sectors reach the dashboard only through kjrEscape', () => {
    const holdings = extractFunction('_dashHoldings'), today = extractFunction('_dashToday'), rows = extractFunction('_dashHoldingRows');
    assert.ok(holdings.includes('kjrEscape(r.sym)') && holdings.includes('kjrEscape(r.sub)'));
    assert.ok(today.includes('kjrEscape(r.sym)') && today.includes('kjrEscape(r.name)') && today.includes('kjrEscape(it.title)') && today.includes('kjrEscape(it.line)'));
    assert.ok(holdings.includes('_monogram(r.sym, r.cls)') && today.includes('_monogram(r.sym, r.cls)'));
    assert.ok(rows.includes('_cryptoRow(c)') && rows.includes('_stockDayMove(r)') && rows.includes('_dayMoveSgd('));
    assert.ok(extractFunction('_allocRowHtml').includes('kjrEscape(r.key)'));
    // every amount on the new cards sits in a .money-chip, so privacy mode blurs it
    assert.ok(holdings.includes('dash-hval money-chip') && today.includes('money-chip'));
    assert.ok(indexSrc.includes('html.privacy .money-chip,'));
  });

  /* ═══ Hero chart (v2.71): series, ranges, geometry, the remembered range, markup and wiring ═══ */

  // The vm sandbox has its own Object and Array, so results are copied to plain host objects before a deep compare.
  const plain = x => JSON.parse(JSON.stringify(x));
  const heroDay = iso => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 86400000;
  const heroIso = day => new Date(day * 86400000).toISOString().slice(0, 10);
  // One snapshot a day for `days` days ending on endIso, valued f(i) with i 0 at the oldest.
  const dailySnaps = (endIso, days, f, cpf) => Array.from({ length:days }, (_, i) => ({
    id:'s' + i, date:heroIso(heroDay(endIso) - (days - 1 - i)), net:f(i),
    byClass:{ stocks:0, cash:0, cpf:cpf == null ? 0 : cpf, realestate:0, crypto:0, insurance:0 }
  }));
  const HERO_TODAY = '2026-10-08';
  const HERO_RANGES = ['1M', '3M', 'YTD', '1Y', 'ALL'];

  test('_heroSeries - each range cuts its own window: 1M is 30 days counting today, 3M 91, 1Y 365, YTD from 1 January, ALL everything', () => {
    const sb = freshSandbox();
    const snaps = dailySnaps(HERO_TODAY, 400, i => 600000 + i * 100);
    const run = range => sb._heroSeries(snaps, range, true, HERO_TODAY);
    const len = range => run(range).points.length;
    assert.deepStrictEqual(['1M', '3M', 'YTD', '1Y', 'ALL'].map(len), [30, 91, 281, 365, 400]);
    assert.strictEqual(run('1M').points[0].date, '2026-09-09');
    assert.strictEqual(run('3M').points[0].date, '2026-07-10');
    assert.strictEqual(run('1Y').points[0].date, '2025-10-09');
    assert.strictEqual(run('YTD').points[0].date, '2026-01-01');
    assert.strictEqual(run('ALL').points[0].date, '2025-09-04');
    HERO_RANGES.forEach(range => {
      const s = run(range);
      assert.strictEqual(s.state, 'ok'); assert.strictEqual(s.range, range); assert.strictEqual(s.total, 400);
      assert.strictEqual(s.last.date, HERO_TODAY);
    });
    // the boundary day itself is in, the day before is out
    const edge = (day, range) => sb._heroSeries([{ date:day, net:1 }, { date:HERO_TODAY, net:2 }], range, true, HERO_TODAY).state;
    assert.strictEqual(edge('2026-09-09', '1M'), 'ok');   assert.strictEqual(edge('2026-09-08', '1M'), 'sparse');
    assert.strictEqual(edge('2026-07-10', '3M'), 'ok');   assert.strictEqual(edge('2026-07-09', '3M'), 'sparse');
    assert.strictEqual(edge('2025-10-09', '1Y'), 'ok');   assert.strictEqual(edge('2025-10-08', '1Y'), 'sparse');
    assert.strictEqual(edge('2026-01-01', 'YTD'), 'ok');  assert.strictEqual(edge('2025-12-31', 'YTD'), 'sparse');
  });

  test('_heroSeries - 0 snapshots is empty, 1 is single in every range, 2 draw a line, and a non-list reads as empty', () => {
    const sb = freshSandbox();
    HERO_RANGES.forEach(range => {
      const none = plain(sb._heroSeries([], range, false, HERO_TODAY));
      assert.deepStrictEqual(none, { state:'empty', range, total:0, points:[], first:null, last:null, change:null, changePct:null, up:true });
      [null, undefined, 'nope', 42, {}].forEach(bad => assert.strictEqual(sb._heroSeries(bad, range, false, HERO_TODAY).state, 'empty'));
      const one = plain(sb._heroSeries(dailySnaps(HERO_TODAY, 1, () => 650000), range, false, HERO_TODAY));
      assert.strictEqual(one.state, 'single'); assert.strictEqual(one.total, 1); assert.strictEqual(one.points.length, 1);
      assert.strictEqual(one.first, null); assert.strictEqual(one.change, null);
      // a lone old row is still single, and just sits outside every window but ALL
      const old = plain(sb._heroSeries(dailySnaps('2024-01-15', 1, () => 650000), range, false, HERO_TODAY));
      assert.strictEqual(old.state, 'single'); assert.strictEqual(old.points.length, range === 'ALL' ? 1 : 0);
      const two = plain(sb._heroSeries(dailySnaps(HERO_TODAY, 2, i => 650000 + i * 1000), range, false, HERO_TODAY));
      assert.strictEqual(two.state, 'ok'); assert.strictEqual(two.points.length, 2);
      assert.strictEqual(two.first.value, 650000); assert.strictEqual(two.last.value, 651000);
      assert.strictEqual(two.change, 1000); assert.ok(Math.abs(two.changePct - 1000 / 650000 * 100) < 1e-12); assert.strictEqual(two.up, true);
    });
  });

  test('_heroSeries - a range with under 2 points is sparse while the history has more, and stays selectable', () => {
    const sb = freshSandbox();
    const rows = [{ date:'2025-01-01', net:600000 }, { date:'2026-07-20', net:640000 }, { date:HERO_TODAY, net:650000 }];
    const state = (list, range) => sb._heroSeries(list, range, true, HERO_TODAY).state;
    assert.deepStrictEqual(HERO_RANGES.map(r => state(rows, r)), ['sparse', 'ok', 'ok', 'ok', 'ok']);
    // a year-old first row and today: only All has two points, every shorter range stays selectable and reads sparse
    assert.deepStrictEqual(HERO_RANGES.map(r => state([rows[0], rows[2]], r)), ['sparse', 'sparse', 'sparse', 'sparse', 'ok']);
    const oneInWindow = plain(sb._heroSeries(rows, '1M', true, HERO_TODAY));
    assert.strictEqual(oneInWindow.points.length, 1); assert.strictEqual(oneInWindow.total, 3);
    assert.strictEqual(oneInWindow.first, null); assert.strictEqual(oneInWindow.last, null);
    assert.strictEqual(oneInWindow.change, null); assert.strictEqual(oneInWindow.changePct, null);
    // nothing at all in the window is sparse too, not empty
    const gap = plain(sb._heroSeries([{ date:'2026-05-01', net:1 }, { date:'2026-05-02', net:2 }], '1M', true, HERO_TODAY));
    assert.strictEqual(gap.state, 'sparse'); assert.strictEqual(gap.points.length, 0); assert.strictEqual(gap.total, 2);
  });

  test('_heroSeries - 400 daily snapshots: every range gives its change, percentage and direction', () => {
    const sb = freshSandbox();
    const snaps = dailySnaps(HERO_TODAY, 400, i => 600000 + i * 100);
    const m = sb._heroSeries(snaps, '1M', true, HERO_TODAY);
    assert.strictEqual(m.first.value, 637000); assert.strictEqual(m.last.value, 639900);
    assert.strictEqual(m.change, 2900); assert.ok(Math.abs(m.changePct - 2900 / 637000 * 100) < 1e-12); assert.strictEqual(m.up, true);
    const all = sb._heroSeries(snaps, 'ALL', true, HERO_TODAY);
    assert.strictEqual(all.first.value, 600000); assert.strictEqual(all.change, 39900);
    // a falling series reads down, with a negative change and percentage
    const falling = sb._heroSeries(dailySnaps(HERO_TODAY, 400, i => 700000 - i * 100), '3M', true, HERO_TODAY);
    assert.strictEqual(falling.up, false); assert.ok(falling.change < 0 && falling.changePct < 0);
    assert.strictEqual(falling.change, -9000);
    // level is not a loss: last equal to first reads up, with a zero change
    const level = sb._heroSeries(dailySnaps(HERO_TODAY, 40, () => 650000), '1M', true, HERO_TODAY);
    assert.strictEqual(level.up, true); assert.strictEqual(level.change, 0); assert.strictEqual(level.changePct, 0);
    // a first value of 0 gives a change but no percentage
    const fromZero = sb._heroSeries([{ date:'2026-10-07', net:0 }, { date:HERO_TODAY, net:100 }], '1M', true, HERO_TODAY);
    assert.strictEqual(fromZero.state, 'ok'); assert.strictEqual(fromZero.change, 100); assert.strictEqual(fromZero.changePct, null);
  });

  test('_heroSeries - YTD on 1 January is that day alone, on 31 December the whole year, 366 days in a leap year', () => {
    const sb = freshSandbox();
    const jan1 = sb._heroSeries(dailySnaps('2026-01-01', 10, i => 600000 + i), 'YTD', true, '2026-01-01');
    assert.strictEqual(jan1.state, 'sparse'); assert.strictEqual(jan1.points.length, 1);
    assert.strictEqual(jan1.points[0].date, '2026-01-01'); assert.strictEqual(jan1.total, 10);
    const jan2 = sb._heroSeries(dailySnaps('2026-01-02', 10, i => 600000 + i), 'YTD', true, '2026-01-02');
    assert.strictEqual(jan2.state, 'ok'); assert.strictEqual(jan2.points.length, 2); assert.strictEqual(jan2.first.date, '2026-01-01');
    const dec31 = sb._heroSeries(dailySnaps('2026-12-31', 400, i => 600000 + i), 'YTD', true, '2026-12-31');
    assert.strictEqual(dec31.points.length, 365); assert.strictEqual(dec31.first.date, '2026-01-01'); assert.strictEqual(dec31.last.date, '2026-12-31');
    assert.strictEqual(sb._heroSeries(dailySnaps('2028-12-31', 400, i => 600000 + i), 'YTD', true, '2028-12-31').points.length, 366);
    // 1M across a year boundary counts calendar days, not months
    const across = sb._heroSeries(dailySnaps('2026-01-10', 60, i => 600000 + i), '1M', true, '2026-01-10');
    assert.strictEqual(across.points.length, 30); assert.strictEqual(across.first.date, '2025-12-12');
  });

  test('_heroSeries - Include CPF off takes the CPF class out of every row, on keeps the whole net, a missing or unreadable CPF figure counts as 0', () => {
    const sb = freshSandbox();
    const rows = [
      { date:'2026-10-01', net:700000, byClass:{ cpf:100000 } },
      { date:'2026-10-02', net:710000, byClass:{ cpf:101000 } },
      { date:'2026-10-03', net:720000 },
      { date:'2026-10-04', net:730000, byClass:{ cpf:null } },
      { date:'2026-10-05', net:740000, byClass:{ cpf:'abc' } },
      { date:'2026-10-06', net:750000, byClass:{ cpf:Infinity } }
    ];
    const on = plain(sb._heroSeries(rows, 'ALL', true, '2026-10-06'));
    const off = plain(sb._heroSeries(rows, 'ALL', false, '2026-10-06'));
    assert.deepStrictEqual(on.points.map(p => p.value), [700000, 710000, 720000, 730000, 740000, 750000]);
    assert.deepStrictEqual(off.points.map(p => p.value), [600000, 609000, 720000, 730000, 740000, 750000]);
    assert.strictEqual(on.change, 50000); assert.strictEqual(off.change, 150000);
    assert.ok(Math.abs(off.changePct - 150000 / 600000 * 100) < 1e-12);
    // the switch can flip the result: CPF falling away makes the ex-CPF line the loser
    const flip = [{ date:'2026-10-01', net:700000, byClass:{ cpf:50000 } }, { date:'2026-10-02', net:701000, byClass:{ cpf:60000 } }];
    assert.strictEqual(sb._heroSeries(flip, 'ALL', true, '2026-10-02').up, true);
    assert.strictEqual(sb._heroSeries(flip, 'ALL', false, '2026-10-02').up, false);
  });

  test('_heroSeries - malformed rows are ignored, a repeated date keeps its later row, order does not matter, and the input is never changed', () => {
    const sb = freshSandbox();
    const good = [
      { id:'a', date:'2026-10-03', net:630000, byClass:{ cpf:0 } },
      { id:'b', date:'2026-10-01', net:610000, byClass:{ cpf:0 } },
      { id:'c', date:'2026-10-02', net:620000, byClass:{ cpf:0 } }
    ];
    const junk = [
      null, undefined, 7, 'row', [], {}, { date:'2026-10-04' }, { net:1 },
      { date:'2026-02-30', net:1 }, { date:'2026-13-01', net:1 }, { date:'20261004', net:1 }, { date:'2026-10-4', net:1 }, { date:'2026-10-04T00:00:00', net:1 },
      { date:20261004, net:1 }, { date:'2026-10-04', net:NaN }, { date:'2026-10-04', net:Infinity }, { date:'2026-10-04', net:-Infinity },
      { date:'2026-10-04', net:'650000' }, { date:'2026-10-04', net:null }, { date:'2026-10-04', net:{} }
    ];
    const mixed = [junk[0], good[0], junk[1], junk[8], good[1], junk[14], junk[17], good[2]].concat(junk);
    const out = plain(sb._heroSeries(mixed, 'ALL', true, '2026-10-03'));
    assert.strictEqual(out.total, 3);
    assert.deepStrictEqual(out.points, [{ date:'2026-10-01', value:610000 }, { date:'2026-10-02', value:620000 }, { date:'2026-10-03', value:630000 }]);
    // a repeated date keeps the later row in the list
    const dup = plain(sb._heroSeries([{ date:'2026-10-01', net:1 }, { date:'2026-10-01', net:5 }, { date:'2026-10-02', net:9 }], 'ALL', true, '2026-10-02'));
    assert.deepStrictEqual(dup.points, [{ date:'2026-10-01', value:5 }, { date:'2026-10-02', value:9 }]);
    // nothing readable is empty, whatever the junk
    assert.strictEqual(sb._heroSeries(junk, 'ALL', true, '2026-10-03').state, 'empty');
    // the input is never changed: a deep-frozen copy would throw on sort, and the JSON is identical after
    const frozen = mixed.map(r => r && typeof r === 'object' ? Object.freeze(Object.assign(Array.isArray(r) ? [] : {}, r)) : r);
    Object.freeze(frozen);
    const before = JSON.stringify(frozen);
    sb._heroSeries(frozen, '1M', false, '2026-10-03');
    sb._heroSeries(frozen, 'ALL', true, '2026-10-03');
    assert.strictEqual(JSON.stringify(frozen), before);
    const live = JSON.parse(JSON.stringify(good)); const liveBefore = JSON.stringify(live);
    sb._heroSeries(live, '3M', false, '2026-10-03');
    assert.strictEqual(JSON.stringify(live), liveBefore);
    assert.deepStrictEqual(live.map(r => r.id), ['a', 'b', 'c']);
  });

  test('_heroSeries - an unknown range reads as 1M, a bad todayIso falls back to the newest row, and future rows stay in', () => {
    const sb = freshSandbox();
    const snaps = dailySnaps(HERO_TODAY, 60, i => 600000 + i);
    assert.strictEqual(sb._heroSeries(snaps, 'bogus', true, HERO_TODAY).points.length, 30);
    assert.strictEqual(sb._heroSeries(snaps, 'bogus', true, HERO_TODAY).range, '1M');
    assert.strictEqual(sb._heroSeries(snaps, undefined, true, HERO_TODAY).range, '1M');
    ['', null, undefined, '2026-02-30', 'today', 20261008].forEach(bad => {
      const s = sb._heroSeries(snaps, '1M', true, bad);
      assert.strictEqual(s.points.length, 30, String(bad)); assert.strictEqual(s.last.date, HERO_TODAY);
    });
    // a row dated after today (a device clock that ran ahead) is shown, not hidden
    const ahead = sb._heroSeries([{ date:HERO_TODAY, net:1 }, { date:'2026-10-09', net:2 }], '1M', true, HERO_TODAY);
    assert.strictEqual(ahead.state, 'ok'); assert.strictEqual(ahead.last.date, '2026-10-09');
  });

  /* ═══ Hero chart, live point: today's row swapped for the headline figure, display only ═══ */

  test('_heroWithLive - replaces the row dated today or appends one when there is none, and the chart then ends on the live figure in every range and both CPF states', () => {
    const sb = freshSandbox();
    const live = 641250.5;
    // history ends today at 659,000 net with 100,000 of CPF in every row, and the headline has since moved to the live figure
    const stored = dailySnaps(HERO_TODAY, 60, i => 600000 + i * 1000, 100000);
    const replaced = sb._heroWithLive(stored, HERO_TODAY, live);
    assert.strictEqual(replaced.length, 60);   // replaced, not added
    assert.deepStrictEqual(replaced.filter(r => r.date === HERO_TODAY).map(r => [r.net, r.byClass.cpf]), [[live, 0]]);
    assert.ok(replaced.slice(0, 59).every((r, i) => r === stored[i]), 'earlier rows are the same objects');
    // no row for today yet (the first paint of a new day, before the boot snapshot is written): one is appended
    const yesterday = heroIso(heroDay(HERO_TODAY) - 1);
    const dated = dailySnaps(yesterday, 60, i => 600000 + i * 1000, 100000);
    const appended = sb._heroWithLive(dated, HERO_TODAY, live);
    assert.strictEqual(appended.length, 61);
    assert.deepStrictEqual(appended.slice(0, 60).map(r => r.date), dated.map(r => r.date));
    assert.deepStrictEqual([appended[60].date, appended[60].net, appended[60].byClass.cpf], [HERO_TODAY, live, 0]);
    // in every range and with the switch either way the last point is the live figure, and the change is measured from the first point in view to it
    [replaced, appended].forEach(rows => HERO_RANGES.forEach(range => [true, false].forEach(cpf => {
      const s = sb._heroSeries(rows, range, cpf, HERO_TODAY);
      const where = range + (cpf ? ' with CPF' : ' without CPF');
      assert.strictEqual(s.state, 'ok', where);
      assert.strictEqual(s.last.date, HERO_TODAY, where); assert.strictEqual(s.last.value, live, where);
      assert.strictEqual(s.points[s.points.length - 1].value, live, where);
      assert.strictEqual(s.change, live - s.first.value, where);
      assert.ok(Math.abs(s.changePct - (live - s.first.value) / Math.abs(s.first.value) * 100) < 1e-12, where);
      assert.strictEqual(s.up, live >= s.first.value, where);
    })));
    // the stored figure that was on the end of the chart (659,000 net, 559,000 ex-CPF) is what the headline had before a price refresh moved it
    assert.strictEqual(sb._heroSeries(stored, '1M', true, HERO_TODAY).last.value, 659000);
    assert.strictEqual(sb._heroSeries(stored, '1M', false, HERO_TODAY).last.value, 559000);
    // a date that appears twice for today leaves exactly one row, the live one
    const twice = stored.concat([Object.assign({}, stored[59], { id:'twin', net:1 })]);
    assert.deepStrictEqual(sb._heroWithLive(twice, HERO_TODAY, live).filter(r => r.date === HERO_TODAY).map(r => r.net), [live]);
    // rows dated after today are left alone (a clock that ran ahead is shown, never hidden), so only then does the chart not end on the live figure
    const ahead = sb._heroWithLive(stored.concat([{ date:'2026-10-09', net:1, byClass:{ cpf:0 } }]), HERO_TODAY, live);
    assert.ok(ahead.some(r => r.date === '2026-10-09') && ahead.filter(r => r.date === HERO_TODAY).length === 1);
    // a live figure of 0 is a figure (only CPF held, CPF off): it is used, not skipped
    assert.strictEqual(sb._heroSeries(sb._heroWithLive(stored, HERO_TODAY, 0), '1M', false, HERO_TODAY).last.value, 0);
    // a negative one too
    assert.strictEqual(sb._heroSeries(sb._heroWithLive(stored, HERO_TODAY, -250), '1M', true, HERO_TODAY).last.value, -250);
  });

  test('_heroWithLive - a live figure that is not a finite number, or a date that is not a date, changes nothing, and a non-list reads as empty', () => {
    const sb = freshSandbox();
    const stored = dailySnaps(HERO_TODAY, 5, i => 600000 + i * 1000, 100000);
    [null, undefined, NaN, Infinity, -Infinity, '641250', '', {}, [], true, () => 1].forEach(bad => {
      const out = sb._heroWithLive(stored, HERO_TODAY, bad);
      assert.notStrictEqual(out, stored, 'a new list even when nothing changes');
      assert.strictEqual(out.length, stored.length, String(bad)); assert.ok(out.every((r, i) => r === stored[i]), String(bad));
    });
    ['', null, undefined, '2026-02-30', '2026-13-01', 'today', '20261008', '2026-10-08T00:00:00', 20261008, {}].forEach(bad => {
      const out = sb._heroWithLive(stored, bad, 641250);
      assert.strictEqual(out.length, stored.length, String(bad)); assert.ok(out.every((r, i) => r === stored[i]), String(bad));
    });
    // not a list: treated as no rows, like _heroSeries does
    [null, undefined, 'rows', 7, {}].forEach(bad => {
      assert.deepStrictEqual(plain(sb._heroWithLive(bad, HERO_TODAY, NaN)), []);
      assert.deepStrictEqual(plain(sb._heroWithLive(bad, HERO_TODAY, 650000)), [{ id:'live', date:HERO_TODAY, net:650000, byClass:{ cpf:0 } }]);
    });
    // a malformed row dated today is replaced all the same, and malformed rows elsewhere pass through for _heroSeries to ignore
    const junk = [null, 5, { date:HERO_TODAY, net:NaN }, { date:'2026-10-07', net:'x' }];
    const out = sb._heroWithLive(junk, HERO_TODAY, 650000);
    assert.strictEqual(out.length, 4); assert.deepStrictEqual(plain(out.slice(0, 3)), [null, 5, { date:'2026-10-07', net:'x' }]);
    assert.strictEqual(sb._heroSeries(out, 'ALL', true, HERO_TODAY).total, 1);
  });

  test('_heroWithLive - never changes its input: a deep-frozen list and rows, the JSON and the row objects stay as they were, so DB.snapshots is never written', () => {
    const sb = freshSandbox();
    const stored = dailySnaps(HERO_TODAY, 40, i => 600000 + i * 100, 100000);
    const frozen = stored.map(r => Object.freeze(Object.assign({}, r, { byClass:Object.freeze(Object.assign({}, r.byClass)) })));
    Object.freeze(frozen);
    const before = JSON.stringify(frozen), todayRow = frozen[39], todayNet = todayRow.net;
    const out = sb._heroWithLive(frozen, HERO_TODAY, 123456.78);
    sb._heroWithLive(frozen, HERO_TODAY, NaN);
    sb._heroWithLive(frozen, '2026-02-30', 5);
    sb._heroSeries(out, '3M', false, HERO_TODAY);
    assert.strictEqual(JSON.stringify(frozen), before);
    assert.strictEqual(todayRow.net, todayNet); assert.strictEqual(frozen.length, 40);
    assert.ok(!frozen.some(r => r.net === 123456.78) && !frozen.some(r => r.id === 'live'));
    // and the live row is a fresh object each call, never shared
    assert.notStrictEqual(sb._heroWithLive(frozen, HERO_TODAY, 1).at(-1), sb._heroWithLive(frozen, HERO_TODAY, 1).at(-1));
    // the same holds with a plain, unfrozen list: the order, the ids and the stored figure are as they were
    const live = JSON.parse(JSON.stringify(stored)); const liveBefore = JSON.stringify(live);
    sb._heroWithLive(live, HERO_TODAY, 99);
    assert.strictEqual(JSON.stringify(live), liveBefore);
  });

  test('_heroLiveValue - the headline figure, unless the valuation is incomplete or has nothing to record (the cases autoSnapshot skips) or the figure is not finite', () => {
    const sb = freshSandbox();
    const ok = { incomplete:false, total:723075.35 };
    assert.strictEqual(sb._heroLiveValue(ok, 621435.35), 621435.35);   // CPF off: the headline is the ex-CPF figure, not the total
    assert.strictEqual(sb._heroLiveValue(ok, 723075.35), 723075.35);
    assert.strictEqual(sb._heroLiveValue(ok, 0), 0);                   // only CPF held, CPF off: 0 is a real figure
    assert.strictEqual(sb._heroLiveValue(ok, -10), -10);
    // incomplete (a missing FX rate): no live point, whatever the figure
    assert.strictEqual(sb._heroLiveValue({ incomplete:true, total:723075.35, missingFxCount:1 }, 621435.35), null);
    // nothing to record: autoSnapshot writes no row at a total of 0 or less, so the chart adds none either
    [0, -1, NaN, undefined, null, '5', {}].forEach(total => assert.strictEqual(sb._heroLiveValue({ incomplete:false, total }, 100), null, String(total)));
    // a figure that is not a finite number
    [NaN, Infinity, -Infinity, null, undefined, '621435', {}, [], true].forEach(bad => assert.strictEqual(sb._heroLiveValue(ok, bad), null, String(bad)));
    // no valuation at all
    [null, undefined, 0, 'x'].forEach(v => assert.strictEqual(sb._heroLiveValue(v, 100), null, String(v)));
  });

  test('Hero live point - the empty, single and sparse states count it: nothing stored plus a live figure is one point, a lone old row plus it is a line, a short range stays short', () => {
    const sb = freshSandbox();
    const live = 650000, T = HERO_TODAY;
    const run = (rows, range, cpf) => sb._heroSeries(sb._heroWithLive(rows, T, live), range, cpf == null ? true : cpf, T);
    HERO_RANGES.forEach(range => {
      // no stored row yet: today's live figure alone is one point, "One snapshot so far", not the empty line
      const none = run([], range);
      assert.strictEqual(none.state, 'single', range); assert.strictEqual(none.total, 1); assert.strictEqual(none.first, null);
      // no live figure (nothing to record) leaves the empty state exactly as _heroSeries gives it
      assert.strictEqual(sb._heroSeries(sb._heroWithLive([], T, sb._heroLiveValue({ incomplete:false, total:0 }, 0)), range, true, T).state, 'empty', range);
      // yesterday's row alone plus the live figure draws a two point line in every range, instead of "One snapshot so far"
      const prev = run(dailySnaps(heroIso(heroDay(T) - 1), 1, () => 648000), range);
      assert.strictEqual(prev.state, 'ok', range); assert.strictEqual(prev.points.length, 2);
      assert.strictEqual(prev.change, live - 648000); assert.strictEqual(prev.last.value, live);
    });
    // a lone old row: the live point makes All a line, but a short range has only the live point in view and stays sparse
    const old = dailySnaps('2025-01-15', 1, () => 600000);
    assert.deepStrictEqual(HERO_RANGES.map(r => run(old, r).state), ['sparse', 'sparse', 'sparse', 'sparse', 'ok']);
    // the QA seed shape: monthly rows and today's boot row, 1M holds only today, so it stays sparse after the swap too
    const seed = [{ date:'2026-08-01', net:672000 }, { date:'2026-09-01', net:679200 }, { date:T, net:723075.35, byClass:{ cpf:101640 } }];
    assert.strictEqual(run(seed, '1M', false).state, 'sparse');
    const threeM = run(seed, '3M', false);
    assert.strictEqual(threeM.last.value, live); assert.strictEqual(threeM.change, live - 672000);
  });

  test('_heroNearest - the closest point to x by distance, the earlier one on a tie, clamped at both ends, -1 for no points', () => {
    const sb = freshSandbox();
    assert.strictEqual(sb._heroNearest([], 0.5), -1);
    assert.strictEqual(sb._heroNearest([0], 0.9), 0);
    const xs = [0, 0.1, 0.2, 0.9, 1];
    assert.deepStrictEqual([-5, 0, 0.04, 0.06, 0.1, 0.16, 0.5, 0.54, 0.56, 0.94, 0.96, 1, 7].map(x => sb._heroNearest(xs, x)), [0, 0, 0, 1, 1, 2, 2, 2, 3, 3, 4, 4, 4]);
    assert.strictEqual(sb._heroNearest([0, 1], 0.5), 0);   // exact tie keeps the earlier
    // every point is its own nearest, on a long series too
    const long = Array.from({ length:1800 }, (_, i) => i / 1799);
    for (let i = 0; i < long.length; i += 37) assert.strictEqual(sb._heroNearest(long, long[i]), i);
    assert.strictEqual(sb._heroNearest(long, 0.4996), 899);
    assert.strictEqual(sb._heroNearest(long, 0.5004), 900);
  });

  test('_heroNiceTicks - round-number lines clear of the edges, three or four for a net-worth sized domain, and only lines a label can show exactly', () => {
    const sb = freshSandbox();
    const at = (lo, hi) => plain(sb._heroNiceTicks(lo, hi));
    assert.deepStrictEqual(at(600000, 700000).map(t => t.value), [625000, 650000, 675000]);
    assert.deepStrictEqual(at(590000, 700000).map(t => t.value), [600000, 625000, 650000, 675000]);
    assert.deepStrictEqual(at(603260, 621240).map(t => t.value), [605000, 610000, 615000]);
    assert.deepStrictEqual(at(0, 1).map(t => t.value), [0.25, 0.5, 0.75]);
    assert.deepStrictEqual(at(-5000, 3000).map(t => t.value), [-4000, -2000, 0, 2000]);
    // y is 0 at the top (hi) and 1 at the bottom (lo), and never inside the label bands at the edges
    const t = at(590000, 700000);
    assert.ok(Math.abs(t[0].y - (700000 - 600000) / 110000) < 1e-12);
    t.forEach((tick, i) => { assert.ok(tick.y >= 0.12 && tick.y <= 0.96); if (i) assert.ok(tick.y < t[i - 1].y); });
    // from a million up a line is a multiple of 10,000, so S$1.05M is never rounded to S$1.1M
    assert.deepStrictEqual(at(950000, 1150000).map(v => v.value), [1000000, 1050000, 1100000]);
    assert.deepStrictEqual(at(1020000, 1080000).map(v => v.value), [1030000, 1040000, 1050000, 1060000, 1070000]);
    // a span too small for any label to tell the lines apart draws none, rather than lines that all read the same
    assert.deepStrictEqual(at(621000, 621010), []);
    // across 3000 domains the size of a real net worth (S$10k to S$2m, moving 1% to 40%): at most 5 lines, all inside the domain, all exactly labelable,
    // and three or four for most of them
    let seed = 7; const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
    let threeOrFour = 0;
    for (let n = 0; n < 3000; n++) {
      const level = 10000 + rnd() * 1990000, width = level * (0.01 + rnd() * 0.39);
      const lo = level - width / 2, hi = level + width / 2, unit = hi >= 1e6 ? 1e4 : 100;
      const ticks = at(lo, hi);
      assert.ok(ticks.length <= 5, lo + '..' + hi + ' gave ' + ticks.length);
      if (ticks.length === 3 || ticks.length === 4) threeOrFour++;
      ticks.forEach(k => { assert.ok(k.value >= lo && k.value <= hi); assert.ok(Math.abs(k.value / unit - Math.round(k.value / unit)) < 1e-9, 'tick ' + k.value + ' not a multiple of ' + unit); });
    }
    assert.ok(threeOrFour > 2300, 'three or four lines for most domains, got ' + threeOrFour + ' of 3000');
    // small figures (under 1,000) have no label-precision limit, and a domain from 0.001 to 1e9 wide always gives 2 to 5 lines
    for (let n = 0; n < 1500; n++) {
      const mag = Math.pow(10, Math.floor(rnd() * 3) - 3), lo = rnd() * 100 * mag, hi = lo + (0.05 + rnd() * 5) * mag;
      if (hi >= 1000) continue;
      const ticks = at(lo, hi);
      assert.ok(ticks.length >= 1 && ticks.length <= 5, lo + '..' + hi + ' gave ' + ticks.length);
    }
    // no span, an inverted or unreadable one: no lines
    [[5, 5], [10, 5], [NaN, 5], [0, Infinity]].forEach(([lo, hi]) => assert.deepStrictEqual(at(lo, hi), []));
  });

  test('_heroAxisLabel - kjrFmtAxis below a million, up to two decimals from a million so a round line is never misstated', () => {
    const sb = freshSandbox();
    sb.kjrFmtAxis = core.kjrFmtAxis;
    const label = v => sb._heroAxisLabel(v, 'S$');
    assert.deepStrictEqual([0, 500, 650000, 612500, 999000].map(label), ['S$0', 'S$500', 'S$650k', 'S$612.5k', 'S$999k']);
    assert.deepStrictEqual([1000000, 1100000, 1050000, 1250000, 1750000, 2000000, 12340000].map(label), ['S$1M', 'S$1.1M', 'S$1.05M', 'S$1.25M', 'S$1.75M', 'S$2M', 'S$12.34M']);
    assert.strictEqual(label(-1250000), '-S$1.25M');
    assert.strictEqual(sb._heroAxisLabel(1500000, 'US$'), 'US$1.5M');
    // the plain formatter would round the same lines
    assert.strictEqual(core.kjrFmtAxis(1250000, { unit:'money' }, 'S$'), 'S$1.3M');
  });

  test('_heroGeometry - x by time so a gap reads as a gap, y inside a 12% padded domain, ticks at equal times with day labels up to ~100 days', () => {
    const sb = freshSandbox();
    const pts = [{ date:'2026-09-09', value:100 }, { date:'2026-09-10', value:150 }, { date:'2026-09-24', value:110 }, { date:'2026-10-08', value:200 }];
    const g = plain(sb._heroGeometry(pts));
    assert.deepStrictEqual(g.xs, [0, 1 / 29, 15 / 29, 1]);
    // data runs 100 to 200: domain 38 either side of the middle, so the lowest point sits at 0.9032 and the highest at 0.0968
    assert.ok(Math.abs(g.ys[0] - 1.12 / 1.24) < 1e-12 && Math.abs(g.ys[3] - 0.12 / 1.24) < 1e-12);
    g.ys.forEach(y => assert.ok(y > 0.09 && y < 0.91));
    assert.ok(Math.abs(g.lo - (150 - 62)) < 1e-9 && Math.abs(g.hi - (150 + 62)) < 1e-9);
    assert.strictEqual(g.style, 'short'); assert.strictEqual(g.spanDays, 29);
    assert.deepStrictEqual(g.dates.map(d => d.iso), ['2026-09-09', '2026-09-16', '2026-09-24', '2026-10-01', '2026-10-08']);
    assert.deepStrictEqual(g.dates.map(d => d.x), [0, 0.25, 0.5, 0.75, 1]);
    // a flat series is drawn mid-height with a domain 1% of the level wide, not zoomed into nothing
    const flat = plain(sb._heroGeometry([{ date:'2026-10-01', value:650000 }, { date:'2026-10-02', value:650000 }]));
    assert.deepStrictEqual(flat.ys, [0.5, 0.5]);
    assert.ok(Math.abs((flat.hi - flat.lo) - 650000 * 0.01 * 1.24) < 1e-6);
    // a near-flat series (0.001% moves) keeps that 1% floor too, so noise stays small
    const noise = plain(sb._heroGeometry([{ date:'2026-10-01', value:650000 }, { date:'2026-10-02', value:650006 }]));
    assert.ok(noise.ys[0] - noise.ys[1] < 0.01 && noise.ys[0] > noise.ys[1]);
    // all-zero data and a negative level still give finite numbers
    [[0, 0], [-5000, -4000]].forEach(([a, b]) => {
      const z = plain(sb._heroGeometry([{ date:'2026-10-01', value:a }, { date:'2026-10-03', value:b }]));
      z.ys.concat(z.xs, [z.lo, z.hi]).forEach(n => assert.ok(Number.isFinite(n)));
    });
  });

  test('_heroGeometry - tick count and label style follow the span: a day each for short spans, months beyond 100 days, never a repeated month', () => {
    const sb = freshSandbox();
    const geo = days => plain(sb._heroGeometry([{ date:'2026-01-01', value:1 }, { date:heroIso(heroDay('2026-01-01') + days), value:2 }]));
    const shape = days => { const g = geo(days); return [g.style, g.dates.length]; };
    assert.deepStrictEqual([1, 2, 3, 4, 29, 30, 100].map(shape), [['short', 2], ['short', 3], ['short', 4], ['short', 5], ['short', 5], ['short', 5], ['short', 5]]);
    assert.deepStrictEqual([101, 127, 128, 200, 364, 1400].map(shape), [['month', 4], ['month', 4], ['month', 5], ['month', 5], ['month', 5], ['month', 5]]);
    // first and last ticks sit on the ends, ticks are in order and 1 to 5 days or more apart
    [1, 2, 30, 101, 364, 1400].forEach(days => {
      const g = geo(days);
      assert.strictEqual(g.dates[0].x, 0); assert.strictEqual(g.dates[g.dates.length - 1].x, 1);
      assert.strictEqual(g.dates[0].iso, '2026-01-01'); assert.strictEqual(g.dates[g.dates.length - 1].iso, heroIso(heroDay('2026-01-01') + days));
      for (let i = 1; i < g.dates.length; i++) assert.ok(g.dates[i].iso > g.dates[i - 1].iso);
      if (g.style === 'month') {
        const months = g.dates.map(d => d.iso.slice(0, 7));
        assert.strictEqual(new Set(months).size, months.length, days + ' days repeats a month');
      }
    });
  });

  test('_heroRangeGet and setHeroRange - 1M by default, the stored range when valid, and a blocked or full store never throws', () => {
    const sb = freshSandbox();
    assert.strictEqual(sb._heroRangeGet(), '1M');
    // read once, then served from memory
    sb.localStorage.setItem('kjr-pf-hero-range-v1', 'YTD');
    assert.strictEqual(sb._heroRangeGet(), '1M');
    const stored = freshSandbox();
    stored.localStorage.setItem('kjr-pf-hero-range-v1', '3M');
    assert.strictEqual(stored._heroRangeGet(), '3M');
    ['', 'all', '5Y', '1m', 'undefined', '{}'].forEach(bad => {
      const s = freshSandbox(); s.localStorage.setItem('kjr-pf-hero-range-v1', bad);
      assert.strictEqual(s._heroRangeGet(), '1M', JSON.stringify(bad));
    });
    // a store that throws on read (private mode, blocked cookies)
    const blocked = freshSandbox();
    blocked.localStorage = { getItem(){ throw new Error('blocked'); }, setItem(){ throw new Error('quota'); }, removeItem(){} };
    assert.strictEqual(blocked._heroRangeGet(), '1M');
    // setHeroRange: remembers, redraws the hero alone, and refuses an unknown range
    const calls = [];
    const set = freshSandbox();
    set.renderDashboard = opts => calls.push(plain(opts));
    assert.strictEqual(set.setHeroRange('1Y'), true);
    assert.strictEqual(set.localStorage.getItem('kjr-pf-hero-range-v1'), '1Y');
    assert.strictEqual(set._heroRangeGet(), '1Y');
    assert.deepStrictEqual(calls, [{ heroOnly:true }]);
    ['3m', 'week', '', null, undefined, 5].forEach(bad => assert.strictEqual(set.setHeroRange(bad), false));
    assert.strictEqual(set._heroRangeGet(), '1Y'); assert.strictEqual(calls.length, 1);
    assert.strictEqual(set.localStorage.getItem('kjr-pf-hero-range-v1'), '1Y');
    // a failing write still changes the range for this session and redraws
    const full = freshSandbox();
    const redraws = [];
    full.renderDashboard = () => redraws.push(1);
    full.localStorage = { getItem(){ return null; }, setItem(){ throw new Error('quota'); }, removeItem(){} };
    assert.strictEqual(full.setHeroRange('ALL'), true);
    assert.strictEqual(full._heroRangeGet(), 'ALL'); assert.strictEqual(redraws.length, 1);
  });

  test('_heroRangesHtml - five tabs in a tablist, one selected and the only tab stop, each wired to setHeroRange', () => {
    const sb = freshSandbox();
    const html = sb._heroRangesHtml('YTD');
    assert.ok(html.startsWith('<div class="hero-ranges" role="tablist" aria-label="Chart range">'));
    const tabs = html.match(/<button[^>]*>[^<]*<\/button>/g);
    assert.strictEqual(tabs.length, 5);
    assert.deepStrictEqual(tabs.map(t => />([^<]*)</.exec(t)[1]), ['1M', '3M', 'YTD', '1Y', 'All']);
    tabs.forEach(t => assert.ok(t.includes('role="tab"') && t.includes('data-click="setHeroRange"') && t.includes('aria-controls="hero-chart"')));
    assert.deepStrictEqual(tabs.map(t => /aria-selected="(\w+)"/.exec(t)[1]), ['false', 'false', 'true', 'false', 'false']);
    assert.deepStrictEqual(tabs.map(t => /tabindex="(-?\d)"/.exec(t)[1]), ['-1', '-1', '0', '-1', '-1']);
    assert.deepStrictEqual(tabs.map(t => /data-a0="(\w+)"/.exec(t)[1]), ['1M', '3M', 'YTD', '1Y', 'ALL']);
    assert.deepStrictEqual(tabs.map(t => /id="(hero-tab-\w+)"/.exec(t)[1]), ['hero-tab-1M', 'hero-tab-3M', 'hero-tab-YTD', 'hero-tab-1Y', 'hero-tab-ALL']);
  });

  /* The chart markup in a sandbox with the app's real axis formatter, date labels and escaping. */
  const heroMarkupSandbox = privacy => {
    const sb = realEscape(freshSandbox());
    sb.kjrFmtAxis = core.kjrFmtAxis;
    sb.toDisplay = v => v;
    sb.privacyOn = () => !!privacy;
    sb.fmt = (n, o) => 'S$' + Math.round(n).toLocaleString('en-SG');
    return sb;
  };
  const heroChart = (sb, snaps, range, cpf) => {
    const hero = sb._heroSeries(snaps, range, cpf == null ? true : cpf, HERO_TODAY);
    return sb._heroChartHtml(hero, hero.state === 'ok' ? sb._heroGeometry(hero.points) : null, range, 'past month');
  };

  test('_heroChartHtml - the three degraded states show one quiet line and no chart, and the empty ones keep no tab to point at', () => {
    const sb = heroMarkupSandbox();
    const empty = heroChart(sb, [], '1M');
    assert.strictEqual(empty, '<p class="hero-note compact">Your history starts with today\'s snapshot</p>');
    const single = heroChart(sb, dailySnaps(HERO_TODAY, 1, () => 650000), '1M');
    assert.strictEqual(single, '<p class="hero-note compact">One snapshot so far, the chart fills in from tomorrow</p>');
    const sparse = heroChart(sb, [{ date:'2025-01-01', net:1 }, { date:HERO_TODAY, net:2 }], '3M');
    assert.strictEqual(sparse, '<p class="hero-note" id="hero-chart" role="tabpanel" aria-labelledby="hero-tab-3M">Not enough history for this range</p>');
    [empty, single, sparse].forEach(html => assert.ok(!html.includes('<svg') && !html.includes('role="slider"') && !html.includes('hero-dot')));
    // a lone row far outside the window is still "one snapshot so far", not "not enough for this range"
    assert.strictEqual(heroChart(sb, dailySnaps('2024-01-15', 1, () => 650000), '1M'), single);
  });

  test('_heroChartHtml - a drawn chart: gain or loss colour, one path point per snapshot, a pulsing end dot, labelled gridlines and ticks, and a slider overlay', () => {
    const sb = heroMarkupSandbox();
    const up = heroChart(sb, dailySnaps(HERO_TODAY, 40, i => 600000 + i * 500), '1M');
    assert.ok(up.startsWith('<div class="hero-chart up" id="hero-chart" role="tabpanel" aria-labelledby="hero-tab-1M">'));
    const down = heroChart(sb, dailySnaps(HERO_TODAY, 40, i => 700000 - i * 500), '1M');
    assert.ok(down.startsWith('<div class="hero-chart down" '));
    // preserveAspectRatio none, a constant-width stroke and a gradient fill: the SVG carries paths only, never text
    assert.ok(up.includes('viewBox="0 0 1000 300" preserveAspectRatio="none"') && up.includes('vector-effect="non-scaling-stroke"'));
    assert.ok(up.includes('fill="url(#hero-fill)"') && !/<text/.test(up));
    const line = /<path d="(M[^"]*)" fill="none"/.exec(up)[1];
    assert.strictEqual(line.split('L').length, 30);   // 30 days in 1M
    assert.ok(line.startsWith('M0.0 ') && /L1000\.0 \d+\.\d$/.test(line));
    assert.ok(up.includes('L1000 300L0 300Z'));
    // end dot pulses, the cross line starts at the last point
    assert.ok(up.includes('<i class="hero-dot end" id="hero-dot" style="left:100.000%;'));
    assert.ok(up.includes('<i class="hero-cross" id="hero-cross" style="left:100.000%"></i>'));
    // labelled with the compact currency format, blurred under Hide amounts through .money-chip
    const labels = Array.from(up.matchAll(/<b class="money-chip">([^<]*)<\/b>/g)).map(m => m[1]);
    assert.ok(labels.length >= 2 && labels.length <= 5);
    labels.forEach(l => assert.ok(/^S\$\d+(\.\d)?k$/.test(l), l));
    assert.strictEqual(new Set(labels).size, labels.length);
    assert.deepStrictEqual(Array.from(up.matchAll(/<span style="left:[\d.]+%">([^<]*)<\/span>/g)).map(m => m[1]), ['9 Sep', '16 Sep', '24 Sep', '1 Oct', '8 Oct']);
    // the overlay is the one tab stop: a labelled slider that starts at the latest point
    const slider = /<div class="hero-scrub"[^>]*>/.exec(up)[0];
    assert.ok(slider.includes('role="slider"') && slider.includes('tabindex="0"') && slider.includes('aria-orientation="horizontal"'));
    assert.ok(slider.includes('aria-valuemin="0"') && slider.includes('aria-valuemax="29"') && slider.includes('aria-valuenow="29"'));
    assert.ok(slider.includes('aria-label="Net worth, past month, up 2.4%"'), slider);
    assert.ok(slider.includes('aria-valuetext="8 Oct 2026, S$619,500, up 2.4% from the start of the range"'), slider);
    assert.ok(heroChart(sb, dailySnaps(HERO_TODAY, 40, i => 700000 - i * 500), '1M').includes('aria-label="Net worth, past month, down 2.1%"'));
    // 400 daily snapshots on All: one path point each, month labels
    const all = heroChart(sb, dailySnaps(HERO_TODAY, 400, i => 600000 + i * 100), 'ALL');
    assert.strictEqual(/<path d="(M[^"]*)" fill="none"/.exec(all)[1].split('L').length, 400);
    assert.deepStrictEqual(Array.from(all.matchAll(/<span style="left:[\d.]+%">([^<]*)<\/span>/g)).map(m => m[1]), ['Sep 2025', 'Dec 2025', 'Mar 2026', 'Jun 2026', 'Oct 2026']);
  });

  test('_heroChartHtml - past a million the gridline labels keep two decimals, and no two lines read the same', () => {
    const sb = heroMarkupSandbox();
    const labels = html => Array.from(html.matchAll(/<b class="money-chip">([^<]*)<\/b>/g)).map(m => m[1]);
    assert.deepStrictEqual(labels(heroChart(sb, dailySnaps(HERO_TODAY, 40, i => 1000000 + i * 3000), '1M')), ['S$1.04M', 'S$1.06M', 'S$1.08M', 'S$1.1M']);
    // across the S$1m line the labels move from k to M and stay exact
    const across = labels(heroChart(sb, dailySnaps(HERO_TODAY, 40, i => 960000 + i * 3000), '1M'));
    assert.ok(across.length >= 2 && new Set(across).size === across.length, across.join());
    across.forEach(l => assert.ok(/^S\$(\d+k|\d+(\.\d+)?M)$/.test(l), l));
  });

  test('_heroChartHtml - amounts stay out of the label and the spoken value in Hide amounts, the percentage stays', () => {
    const open = heroMarkupSandbox(false), hidden = heroMarkupSandbox(true);
    const snaps = dailySnaps(HERO_TODAY, 40, i => 600000 + i * 500);
    const a = heroChart(open, snaps, '1M'), b = heroChart(hidden, snaps, '1M');
    assert.ok(a.includes('S$619,500') && !b.includes('S$619,500'));
    assert.ok(b.includes('aria-valuetext="8 Oct 2026, amount hidden, up 2.4% from the start of the range"'));
    assert.ok(b.includes('aria-label="Net worth, past month, up 2.4%"'));
    // the plain-text helper gives the same words for any point
    const hero = hidden._heroSeries(snaps, '1M', true, HERO_TODAY);
    assert.strictEqual(hidden._heroPointText(hero, 0), '9 Sep 2026, amount hidden, start of the range');
    assert.strictEqual(open._heroPointText(open._heroSeries(snaps, '1M', true, HERO_TODAY), 0), '9 Sep 2026, S$605,000, start of the range');
    const level = open._heroSeries(dailySnaps(HERO_TODAY, 40, () => 650000), '1M', true, HERO_TODAY);
    assert.strictEqual(open._heroPointText(level, 5), '14 Sep 2026, S$650,000, level with the start of the range');
    const fromZero = open._heroSeries([{ date:'2026-10-07', net:0 }, { date:HERO_TODAY, net:100 }], '1M', true, HERO_TODAY);
    assert.strictEqual(open._heroPointText(fromZero, 1), '8 Oct 2026, S$100, up from the start of the range');
  });

  test('Hero chart wiring - renderDashboard reads the range, redraws on heroOnly, restores focus and keeps scrub state outside the DOM', () => {
    const dash = extractFunction('renderDashboard');
    ['_heroRangeGet()', '_heroSeries(_heroWithLive(DB.snapshots, todayIso, _heroLiveValue(valuation, displayNet)), heroRange, _dashShowCpf, todayIso)', 'const todayIso = _isoDateSG(new Date());', '_heroGeometry(hero.points)', '_heroRangesHtml(heroRange)', '_heroChartHtml(hero, geo, heroRange, whenLabels[heroRange])'].forEach(call => assert.ok(dash.includes(call), call));
    // the label map names the five ranges, "past month" first
    assert.ok(dash.includes("'1M':'past month', '3M':'past 3 months', YTD:'this year', '1Y':'past year', ALL:'all time'"));
    assert.ok(dash.includes('opts && opts.heroOnly') && dash.includes('_dashDecorate()'));
    assert.ok(dash.includes('document.activeElement') && dash.includes('preventScroll'));
    assert.ok(dash.includes('_heroView = heroOk ?'));
    // an incomplete valuation draws no history
    assert.ok(dash.includes('valuation.incomplete ? null : _heroSeries('));
    // the old sparkline and its monthly change are gone, along with their style
    ['_heroSparkline', '_heroMonthlyChange', 'dash-hero-spark'].forEach(name => { assert.strictEqual(appSrc.includes(name), false, name + ' in app.js'); assert.strictEqual(indexSrc.includes(name), false, name + ' in index.html'); });
    // one delegated set of handlers, installed once from installEventDelegation
    assert.ok(extractFunction('installEventDelegation').includes('installHeroEvents();'));
    assert.ok(extractFunction('installEventDelegation').includes('setHeroRange:        (el) => setHeroRange(A(el)[0])'));
    const events = extractFunction('installHeroEvents');
    ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'pointerleave', 'setPointerCapture', 'focusout', 'focusin', "'ArrowLeft'", "'ArrowRight'", "'Home'", "'End'", "'Escape'"].forEach(name => assert.ok(events.includes(name), name));
    assert.ok(events.includes("document.addEventListener('pointerleave', e => { if (scrubOf(e)) _heroEndScrub(); }, true)"));
    // handlers look elements up by id at call time, never closing over a node from an old render
    ['_heroSetScrub', '_heroEndScrub', '_heroPlaceDot', '_heroSyncSlider'].forEach(name => assert.ok(extractFunction(name).includes('document.getElementById('), name));
    // the delegation's key handler skips modified keys, so browser shortcuts such as Alt+Left still work
    assert.ok(events.includes('e.altKey || e.ctrlKey || e.metaKey'));
  });

  test('Hero chart styles - 230px on desktop, edge to edge and 180px on a phone, pan-y touch, a pulse that stops under reduced motion, tokens only', () => {
    const css = indexSrc.slice(indexSrc.indexOf('/* Dashboard hero: solid card'), indexSrc.indexOf('/* DASHBOARD ROWS.'));
    assert.ok(css.includes('.hero-chart{grid-area:chart;position:relative;height:230px;'));
    assert.ok(css.includes('touch-action:pan-y') && css.includes('.hero-scrub{') && /\.hero-scrub\{[^}]*touch-action:pan-y/.test(css));
    assert.ok(css.includes('.hero-chart{height:180px;margin-left:-22px;margin-right:-22px;'));
    assert.ok(css.includes('.hero-chart.up{color:var(--gain)}') && css.includes('.hero-chart.down{color:var(--loss)}'));
    assert.ok(css.includes('@keyframes hero-pulse') && /@media \(prefers-reduced-motion:reduce\)\{\.hero-dot\.end::after\{animation:none/.test(css));
    // the selected range segment sits on --bg3, the dashed grid on the border token
    assert.ok(css.includes('.hero-range[aria-selected="true"]{background:var(--bg3)'));
    assert.ok(css.includes('.hero-grid i{position:absolute;left:0;right:0;border-top:1px dashed var(--border)}'));
    // tabs at the top right on desktop, chips under the chart on a phone
    assert.ok(css.includes('grid-template-areas:"head ranges" "chart chart"') && css.includes('grid-template-areas:"head" "chart" "ranges"'));
    // no raw colour: every colour in the hero block is a token or currentColor
    assert.strictEqual(/#[0-9a-fA-F]{3,8}\b|rgba?\(/.test(css), false);
    // the gridline labels blur in Hide amounts through the existing .money-chip rule
    assert.ok(indexSrc.includes('html.privacy .money-chip,') && extractFunction('_heroChartHtml').includes('class="money-chip"'));
  });

  await testAsync('refreshFx - native and vault persistence failures suppress success', async () => {
    for (const mode of ['native','vault']) {
      const initialRate = mode === 'native' ? 1.2 : 1.3;
      const sb = freshSandbox({settings:{salary:{},tax:{},fxOverrides:{},fxRates:{USDSGD:initialRate}},cash:[],expenses:[]});
      const toasts = [];
      sb.showToast = (message, kind) => toasts.push({message, kind});
      sb.fetch = async () => ({json:async()=>({rates:{USDSGD:{rate:1.3}}})});
      if (mode === 'native') sb.saveData = () => false;
      else {
        sb.saveLocal = () => true;
        sb._vaultManager = {isEnabled:()=>true,flush:()=>Promise.reject(new Error('vault failed'))};
      }
      assert.strictEqual(await sb.refreshFx({silent:false}), false);
      assert.strictEqual(toasts.some(t => /^FX refreshed:/.test(t.message)), false);
    }
  });

  /* ═══ Same-origin full-blob concurrency ═══ */

  test('mergeConcurrentLocalState - distinct record edits from two tabs both survive', () => {
    const sb = freshSandbox();
    const base = { stocks:[{id:'s1',name:'Alpha'},{id:'s2',name:'Beta'}], cash:[{id:'c1',name:'Bank',balance:10}] };
    const local = { stocks:[{id:'s1',name:'Alpha local'},{id:'s2',name:'Beta'}], cash:[{id:'c1',name:'Bank',balance:10}] };
    const incoming = { stocks:[{id:'s1',name:'Alpha'},{id:'s2',name:'Beta'}], cash:[{id:'c1',name:'Bank',balance:20}] };
    const result = sb.mergeConcurrentLocalState(base, local, incoming, true);
    assert.strictEqual(result.value.stocks[0].name, 'Alpha local');
    assert.strictEqual(result.value.cash[0].balance, 20);
    assert.strictEqual(result.conflicts.length, 0);
  });

  test('mergeConcurrentLocalState - same-field conflict follows later-operation rule and records loser', () => {
    const sb = freshSandbox();
    const base = { stocks:[{id:'s1',name:'Base'}] };
    const local = { stocks:[{id:'s1',name:'Local'}] };
    const incoming = { stocks:[{id:'s1',name:'Incoming'}] };
    const saveResult = sb.mergeConcurrentLocalState(base, local, incoming, true);
    assert.strictEqual(saveResult.value.stocks[0].name, 'Local');
    assert.strictEqual(saveResult.conflicts.length, 1);
    assert.strictEqual(saveResult.conflicts[0].losingValue, 'Incoming');
    const eventResult = sb.mergeConcurrentLocalState(base, local, incoming, false);
    assert.strictEqual(eventResult.value.stocks[0].name, 'Incoming');
    assert.strictEqual(eventResult.conflicts[0].losingValue, 'Local');
  });

  test('mergeConcurrentLocalState - deletion merges with an unrelated edit and deletion-vs-edit is recoverable', () => {
    const sb = freshSandbox();
    const base = { stocks:[{id:'s1',name:'Delete me'},{id:'s2',name:'Base'}] };
    const local = { stocks:[{id:'s2',name:'Base'}] };
    const incoming = { stocks:[{id:'s1',name:'Delete me'},{id:'s2',name:'Changed elsewhere'}] };
    const distinct = sb.mergeConcurrentLocalState(base, local, incoming, true);
    assert.deepStrictEqual(Array.from(distinct.value.stocks, r => r.id), ['s2']);
    assert.strictEqual(distinct.value.stocks[0].name, 'Changed elsewhere');
    assert.strictEqual(distinct.conflicts.length, 0);

    const editedDeleted = { stocks:[{id:'s1',name:'Edited elsewhere'},{id:'s2',name:'Base'}] };
    const conflict = sb.mergeConcurrentLocalState(base, local, editedDeleted, true);
    assert.deepStrictEqual(Array.from(conflict.value.stocks, r => r.id), ['s2']);
    assert.strictEqual(conflict.conflicts.length, 1);
    assert.strictEqual(conflict.conflicts[0].losingValue.name, 'Edited elsewhere');
  });

  test('mergeConcurrentLocalState - storage-event arrival preserves this tab\'s distinct unsaved edit', () => {
    const sb = freshSandbox();
    const base = { stocks:[{id:'s1',name:'Base'}], cash:[{id:'c1',balance:10}] };
    const localUnsaved = { stocks:[{id:'s1',name:'Typing'}], cash:[{id:'c1',balance:10}] };
    const storageEvent = { stocks:[{id:'s1',name:'Base'}], cash:[{id:'c1',balance:25}] };
    const result = sb.mergeConcurrentLocalState(base, localUnsaved, storageEvent, false);
    assert.strictEqual(result.value.stocks[0].name, 'Typing');
    assert.strictEqual(result.value.cash[0].balance, 25);
  });

  await testAsync('_reconcileIncomingLocalStorage - storage event immediately persists both tabs and does not echo canonical state', async () => {
    const sb = freshSandbox();
    const base = { stocks:[{id:'s1',name:'Base'}], cash:[{id:'c1',balance:10}], settings:{} };
    const localUnsaved = { stocks:[{id:'s1',name:'Typing'}], cash:[{id:'c1',balance:10}], settings:{}, _priceCache:{} };
    const incoming = { stocks:[{id:'s1',name:'Base'}], cash:[{id:'c1',balance:25}], settings:{} };
    sb.DB = localUnsaved;
    sb._localBase = JSON.parse(JSON.stringify(base));
    let primaryWrites = 0;
    const realSet = sb.localStorage.setItem.bind(sb.localStorage);
    sb.localStorage.setItem = (key, value) => {
      if (key === 'kjr-pf-db-v1') primaryWrites++;
      realSet(key, value);
    };
    realSet('kjr-pf-db-v1', JSON.stringify(incoming));
    const result = await sb._reconcileIncomingLocalStorage(JSON.stringify(incoming));
    assert.strictEqual(result.persisted, true);
    assert.strictEqual(primaryWrites, 1);
    const persisted = JSON.parse(sb.localStorage.getItem('kjr-pf-db-v1'));
    assert.strictEqual(persisted.stocks[0].name, 'Typing');
    assert.strictEqual(persisted.cash[0].balance, 25);

    const echo = await sb._reconcileIncomingLocalStorage(JSON.stringify(persisted));
    assert.strictEqual(echo.persisted, false);
    assert.strictEqual(primaryWrites, 1);
  });

  await testAsync('_reconcileIncomingLocalStorage - stale active ACK cannot clear a newer external revision', async () => {
    const oldDb = {stocks:[{id:'s1',name:'Old'}],cash:[],settings:{},_priceCache:{}};
    const incoming = {stocks:[{id:'s1',name:'New'}],cash:[],settings:{}};
    const sb = freshSandbox(oldDb);
    sb._localBase = JSON.parse(JSON.stringify(sb.localPersistPayload()));
    sb._localSaveRevision = 1;
    sb._markCloudDirty();
    const queued = [];
    sb.setTimeout = fn => { queued.push(fn); return queued.length; };
    sb.clearTimeout = () => {};
    let releaseOld;
    const posted = [];
    sb.fetch = async (_url, request) => {
      posted.push(JSON.parse(request.body));
      if (posted.length === 1) return new Promise(resolve => { releaseOld = () => resolve({status:200,text:async()=>JSON.stringify({ok:true,savedAt:'2026-10-03T00:00:01.000Z'})}); });
      return {status:200,text:async()=>JSON.stringify({ok:true,savedAt:'2026-10-03T00:00:02.000Z'})};
    };
    const oldPush = sb.pushToRemote();
    while (!releaseOld) await Promise.resolve();
    sb.localStorage.setItem('kjr-pf-db-v1', JSON.stringify(incoming));
    const merged = await sb._reconcileIncomingLocalStorage(JSON.stringify(incoming));
    assert.strictEqual(merged.changed, true);
    assert.strictEqual(sb._localSaveRevision, 2);
    assert.strictEqual(sb._hasCloudDirty(), true);
    assert.strictEqual(sb._syncTimer, 1);
    releaseOld();
    assert.strictEqual(await oldPush, true);
    assert.strictEqual(sb._hasCloudDirty(), true);
    queued[0]();
    const followUp = sb._activeSyncLatest;
    assert.ok(followUp);
    assert.strictEqual(await followUp, true);
    assert.strictEqual(posted[0].stocks[0].name, 'Old');
    assert.strictEqual(posted[1].stocks[0].name, 'New');
    assert.strictEqual(sb._hasCloudDirty(), false);
  });

  await testAsync('_reconcileIncomingLocalStorage - vault merge waits for encryption and fails dirty on rejection', async () => {
    for (const reject of [false, true]) {
      const sb = freshSandbox({
        stocks:[{id:'s1',name:'Typing'}], cash:[{id:'c1',balance:10}], settings:{}, _priceCache:{}
      });
      sb._localBase = {stocks:[{id:'s1',name:'Base'}],cash:[{id:'c1',balance:10}],settings:{}};
      const incoming = {stocks:[{id:'s1',name:'Base'}],cash:[{id:'c1',balance:25}],settings:{}};
      sb.localStorage.setItem('kjr-pf-db-v1', JSON.stringify(incoming));
      let finishFlush;
      sb._vaultManager = {
        isEnabled: () => true,
        flush: () => new Promise((resolve, rejectFlush) => { finishFlush = reject ? () => rejectFlush(new Error('vault failed')) : resolve; })
      };
      let settled = false;
      const merging = sb._reconcileIncomingLocalStorage(JSON.stringify(incoming)).then(result => { settled = true; return result; });
      while (!finishFlush) await Promise.resolve();
      assert.strictEqual(settled, false);
      finishFlush(true);
      const result = await merging;
      assert.strictEqual(result.persisted, !reject);
      assert.strictEqual(sb._hasLocalUnsaved(), reject);
      assert.strictEqual(sb.DB.stocks[0].name, 'Typing');
      assert.strictEqual(sb.DB.cash[0].balance, 25);
    }
  });

  /* ═══ Reset vs queued and active sync ═══ */

  await testAsync('_cancelSyncForReset - cancels the exact 800ms debounce before it can push', async () => {
    const sb = freshSandbox();
    let timer = null;
    let pushCount = 0;
    sb.setTimeout = (fn, ms) => { timer = { id:41, fn, ms, cancelled:false }; return timer.id; };
    sb.clearTimeout = id => { if (timer && timer.id === id) timer.cancelled = true; };
    sb.pushToRemote = () => { pushCount++; return Promise.resolve(true); };
    sb.saveData();
    assert.strictEqual(timer.ms, 800);
    await sb._cancelSyncForReset();
    if (!timer.cancelled) timer.fn(); // deterministic fake-clock advance to 800ms
    assert.strictEqual(timer.cancelled, true);
    assert.strictEqual(pushCount, 0);
    assert.strictEqual(sb.localStorage.getItem('kjr-pf-reset-sync-block-v1'), '1');
  });

  await testAsync('_cancelSyncForReset - aborts and waits for an active request before reset may continue', async () => {
    const sb = freshSandbox();
    let aborted = false;
    sb._activeSyncController = { abort(){ aborted = true; } };
    let finishRequest;
    const fakeFetch = () => new Promise(resolve => { finishRequest = resolve; });
    const activeRequest = fakeFetch();
    sb._activeSyncCompletions.add(activeRequest);
    let resetMayContinue = false;
    const waiting = sb._cancelSyncForReset().then(() => { resetMayContinue = true; });
    await Promise.resolve();
    assert.strictEqual(aborted, true);
    assert.strictEqual(resetMayContinue, false);
    finishRequest();
    await waiting;
    assert.strictEqual(resetMayContinue, true);
  });

  test('resetLocalConfirm - waits, snapshots, then clears local DB without discarding the cloud token', () => {
    const src = extractFunction('resetLocalConfirm');
    const waitAt = src.indexOf('await _cancelSyncForReset()');
    const snapshotAt = src.indexOf('LK_DB_PRE_RESET_');
    const clearAt = src.indexOf('protectedStorage.removeItem(LK_DB)');
    assert.ok(waitAt >= 0 && snapshotAt > waitAt && clearAt > snapshotAt);
    assert.strictEqual(src.includes('removeItem(LK_LAST_PULL)'), false);
    assert.strictEqual(src.includes('removeItem(LK_LAST_PULL_SRC)'), false);
  });

  await testAsync('resetLocalConfirm - local-only reset clears the write block and reports a local outcome', async () => {
    const sb = freshSandbox({ stocks:[{id:'s1',name:'Local only'}], cash:[] });
    let confirmation = '', status = null, toast = null, localSaveCount = 0;
    sb.getSyncUrl = () => '';
    sb.confirm = message => { confirmation = message; return true; };
    sb.setSyncStatus = (state, detail) => { status = { state, detail }; };
    sb.showToast = (message, kind) => { toast = { message, kind }; };
    sb.saveLocal = () => { localSaveCount++; return true; };

    await sb.resetLocalConfirm();

    assert.ok(confirmation.includes('No cloud sync is configured'));
    assert.strictEqual(confirmation.includes('cloud writes will pause'), false);
    assert.strictEqual(sb.localStorage.getItem('kjr-pf-reset-sync-block-v1'), null);
    assert.strictEqual(localSaveCount, 1);
    assert.deepStrictEqual(status, { state:'local', detail:'Local data reset. No cloud sync is configured.' });
    assert.strictEqual(toast.kind, 'success');
    assert.strictEqual(toast.message.includes('cloud writes'), false);
  });

  await testAsync('resetLocalConfirm - synced reset retains the write block and reports recovery choices', async () => {
    const sb = freshSandbox({ stocks:[{id:'s1',name:'Synced'}], cash:[] });
    let confirmation = '', status = null, toast = null, localSaveCount = 0;
    sb.confirm = message => { confirmation = message; return true; };
    sb.setSyncStatus = (state, detail) => { status = { state, detail }; };
    sb.showToast = (message, kind) => { toast = { message, kind }; };
    sb.saveLocal = () => { localSaveCount++; return true; };

    await sb.resetLocalConfirm();

    assert.ok(confirmation.includes('Automatic cloud writes will pause'));
    assert.strictEqual(sb.localStorage.getItem('kjr-pf-reset-sync-block-v1'), '1');
    assert.strictEqual(localSaveCount, 0);
    assert.strictEqual(status.state, 'failed');
    assert.ok(status.detail.includes('Pull from cloud'));
    assert.ok(status.detail.includes('explicit Push to cloud'));
    assert.strictEqual(toast.kind, 'success');
    assert.ok(toast.message.includes('automatic cloud writes are paused'));
  });

  await testAsync('resetLocalConfirm - failed local persistence restores prior in-memory data and has no success claim', async () => {
    const sb = freshSandbox({stocks:[{id:'s1',name:'Keep me'}],cash:[],crypto:[],settings:{},_priceCache:{}});
    const toasts = [];
    sb.getSyncUrl = () => '';
    sb.saveLocal = () => false;
    sb.showToast = (message, kind) => toasts.push({message, kind});
    assert.strictEqual(await sb.resetLocalConfirm(), false);
    assert.strictEqual(sb.DB.stocks[0].name, 'Keep me');
    assert.strictEqual(toasts.some(t => t.kind === 'success'), false);
    assert.strictEqual(toasts.at(-1).kind, 'error');
  });

 test('Portfolio dynamic filters and chart controls keep accessible names', () => {
   const expected = {
      'sf-market':'Filter stocks by market',
      'sf-sector':'Filter stocks by sector',
      'pb-source-select':'Chart data source',
      'pb-chart-type':'Chart type',
      'pb-topn':'Number of chart results',
      'pb-sort':'Chart sort order'
    };
    Object.entries(expected).forEach(([id, name]) => {
      const select = new RegExp('<select[^>]*id="' + id + '"[^>]*>');
      const match = appSrc.match(select);
      assert.ok(match, id + ' select must exist');
      assert.ok(match[0].includes('aria-label="' + name + '"'), id + ' must expose the expected accessible name');
   });
 });

  test('Portfolio modal lifecycle and dynamically inserted inputs retain accessible focus and names', () => {
    ['openModalFocus', 'closeModalFocus', '_modalFocusable', '_modalFocusVisible'].forEach(name => {
      assert.ok(extractFunction(name), name + ' must remain an app helper');
    });
    assert.ok(appSrc.includes("openModalFocus(overlay, closeSetupWizard)"));
    assert.ok(appSrc.includes("openModalFocus(ov);"));
    assert.ok(appSrc.includes("openModalFocus(_overlay, closeEntityModal)"));
    assert.strictEqual(appSrc.includes('_modalKeyTrap'), false);
    assert.strictEqual(appSrc.includes('_modalOpener'), false);
    assert.ok(appSrc.includes('for="sw-url-input"'));
    assert.ok(appSrc.includes('aria-describedby="sw-url-help"'));
    assert.ok(appSrc.includes('id="pb-palette-search" class="fi fi-sm" placeholder="Search fields..." data-input="pbFilterPalette" aria-label="Search available fields"'));
    assert.ok(appSrc.includes('id="pb-kw" class="cb-drop-zone"'));
    assert.ok(appSrc.includes('aria-label="Filter holdings by symbol or sector"'));
  });

  test('Portfolio sortable headers use native buttons once and restore keyboard focus after render', () => {
    ['data-sort-key', 'data-wl-sort-key', 'data-board-sort-key', 'data-ins-sort-key'].forEach(attribute => {
      assert.ok(appSrc.includes(attribute + '="${key}"'), attribute + ' header must be rendered');
    });
    assert.ok(appSrc.includes('class="sortable sortable-button${extraCls'));
    assert.ok(appSrc.includes('<button type="button" class="sort-button"'));
    assert.ok(appSrc.includes('aria-sort="${ariaSort}"'));
    assert.ok(appSrc.includes('function _activateSortButton'));
    assert.ok(appSrc.includes('function _restoreSortableFocus'));
    assert.strictEqual(appSrc.includes('Keyboard sort: sortable headers are tabbable'), false);
  });

  test('Dashboard arrange controls provide bounded named move buttons and an announcement', () => {
    ['_dashArrangeItems', '_dashWidgetName', '_announceDashArrange', 'moveDashWidget'].forEach(name => {
      assert.ok(extractFunction(name), name + ' must remain an app helper');
    });
    assert.ok(appSrc.includes("button.setAttribute('data-click', 'moveDashWidget')"));
    assert.ok(appSrc.includes("button.setAttribute('data-dash-move', placement)"));
    assert.ok(appSrc.includes("button.setAttribute('aria-label', 'Move ' + name + ' ' + placement)"));
    assert.ok(appSrc.includes("button.disabled = direction < 0 ? index === 0 : index === items.length - 1;"));
    assert.ok(appSrc.includes("_announceDashArrange('Dashboard order saved.')"));
    assert.ok(indexSrc.includes('id="dash-arrange-status" class="sr-only" role="status" aria-live="polite"'));
  });

  test('setup wizard links to the active Apps Script source path', () => {
    assert.ok(appSrc.includes('/blob/main/Portfolio/Worker/apps-script.gs'));
    assert.strictEqual(appSrc.includes('/blob/main/Portfolio/apps-script.gs'), false);
  });

  test('NAS candidate stays behind its explicit local release gate', () => {
    assert.ok(/const NAS_RELEASE_ENABLED\s*=\s*false\s*;/.test(appSrc));
    assert.ok(appSrc.includes('NAS activation is held pending local release review'));
  });

  test('Cash account names expose full wrapped text at touch-mobile width', () => {
    assert.ok(indexSrc.includes('table.holdings td.name-clamp{min-width:150px;max-width:180px}'));
    assert.ok(indexSrc.includes('display:block;-webkit-line-clamp:unset;overflow:visible;text-overflow:clip'));
  });

  await testAsync('_handleRemovedLocalStorage - synced tab retains the block and existing recovery wording', async () => {
    const sb = freshSandbox({
      stocks:[{id:'unsaved',name:'Unsaved tab edit'}],
      cash:[], crypto:[], settings:{}, _priceCache:{}
    });
    let status = null, toast = null;
    sb.setSyncStatus = (state, detail) => { status = { state, detail }; };
    sb.showToast = (message, kind) => { toast = { message, kind }; };
    sb.localStorage.setItem('kjr-pf-db-v1', JSON.stringify({ stocks:[{id:'old',name:'Old'}] }));
    sb.localStorage.removeItem('kjr-pf-db-v1'); // browser has already applied the other tab's reset
    const result = await sb._handleRemovedLocalStorage();
    assert.strictEqual(sb.localStorage.getItem('kjr-pf-db-v1'), null);
    assert.strictEqual(sb.localStorage.getItem('kjr-pf-reset-sync-block-v1'), '1');
    assert.ok(result.recoveryKey && result.recoveryKey.startsWith('LK_DB_PRE_REMOTE_RESET_'));
    const recovery = JSON.parse(sb.localStorage.getItem(result.recoveryKey));
    assert.strictEqual(recovery.stocks[0].name, 'Unsaved tab edit');
    assert.deepStrictEqual(Array.from(sb.DB.stocks), []);
    assert.deepStrictEqual(status, {
      state:'failed',
      detail:'Another tab reset local data. Cloud writes remain paused until a pull or explicit push.'
    });
    assert.deepStrictEqual(toast, {
      message:'Another tab reset local data. This tab followed the reset. A technical snapshot was retained for support recovery.',
      kind:'success'
    });
    sb.DB = { stocks:[{id:'stale',name:'Stale resurrection'}], cash:[], crypto:[], settings:{}, _priceCache:{} };
    assert.strictEqual(sb._writeLocalPayload(sb.localPersistPayload(), []), false);
    assert.strictEqual(sb.localStorage.getItem('kjr-pf-db-v1'), null);
  });

  await testAsync('_handleRemovedLocalStorage - local-only tab clears the block and reports a local outcome', async () => {
    const sb = freshSandbox({
      stocks:[{id:'unsaved',name:'Unsaved local tab edit'}],
      cash:[], crypto:[], settings:{}, _priceCache:{}
    });
    let status = null, toast = null, localSaveCount = 0;
    sb.getSyncUrl = () => '';
    sb.setSyncStatus = (state, detail) => { status = { state, detail }; };
    sb.showToast = (message, kind) => { toast = { message, kind }; };
    sb.saveLocal = () => { localSaveCount++; return true; };
    sb.localStorage.setItem('kjr-pf-db-v1', JSON.stringify({ stocks:[{id:'old',name:'Old'}] }));
    sb.localStorage.removeItem('kjr-pf-db-v1');

    const result = await sb._handleRemovedLocalStorage();

    assert.strictEqual(sb.localStorage.getItem('kjr-pf-reset-sync-block-v1'), null);
    assert.strictEqual(localSaveCount, 1);
    assert.ok(result.recoveryKey && result.recoveryKey.startsWith('LK_DB_PRE_REMOTE_RESET_'));
    assert.deepStrictEqual(status, {
      state:'local',
      detail:'Another tab reset local data. No cloud sync is configured.'
    });
    assert.strictEqual(status.detail.includes('Cloud writes remain paused'), false);
    assert.deepStrictEqual(toast, {
      message:'Another tab reset local data. This local-only tab followed the reset. A technical snapshot was retained for support recovery.',
      kind:'success'
    });
    assert.strictEqual(toast.message.includes('cloud writes'), false);
  });

  await testAsync('_handleRemovedLocalStorage - local persistence failure cannot report reset success', async () => {
    const sb = freshSandbox({stocks:[{id:'s1'}],cash:[],crypto:[],settings:{},_priceCache:{}});
    let status = null, toast = null;
    sb.getSyncUrl = () => '';
    sb.saveLocal = () => false;
    sb.setSyncStatus = (state, detail) => { status = {state, detail}; };
    sb.showToast = (message, kind) => { toast = {message, kind}; };
    const result = await sb._handleRemovedLocalStorage();
    assert.strictEqual(result.persisted, false);
    assert.strictEqual(status.state, 'failed');
    assert.strictEqual(toast.kind, 'error');
    assert.strictEqual(toast.message.includes('reset') && toast.message.includes('could not be stored'), true);
  });

  test('cloud metadata is stripped and current CPF defaults preserve explicit saved overrides', () => {
    const sb = freshSandbox();
    Object.assign(sb, {defaultStockColumns:()=>[],defaultCols:()=>[],BOARD_COLUMNS:[],reconcileStockColumns:x=>x||[],reconcileCols:x=>x||[],_runMigrations:x=>x,_LIST_TABLES:[]});
    vm.runInContext(appSrc.match(/const CPF_DEFAULTS = \{[\s\S]*?\n\};/)[0]+'\n'+extractFunction('freshDB')+'\n'+extractFunction('mergeDefaults'), sb);
    assert.strictEqual(sb.freshDB().settings.cpfRates.SA, 4);
    assert.strictEqual(sb.freshDB().settings.cpfRates.MA, 4);
    assert.strictEqual(sb.freshDB().settings.cpfRates.RA, 4);
    sb.DB = sb.mergeDefaults({_savedAt:'2026-10-03T00:00:00.000Z',lastSeenRemoteAt:'obsolete',cash:[{id:'cash',amount:7}],settings:{cpfRates:{SA:4.08,MA:3}}});
    assert.strictEqual(sb.DB.settings.cpfRates.SA, 4.08);
    assert.strictEqual(sb.DB.settings.cpfRates.MA, 3);
    assert.strictEqual('_savedAt' in sb.DB, false);
    sb.setLastPull('2026-10-03T00:00:01.000Z', 'server');
    assert.strictEqual('lastSeenRemoteAt' in sb.localPersistPayload(), false);
    assert.strictEqual('_savedAt' in sb.syncPayload(), false);
    assert.strictEqual(sb.syncPayload().lastSeenRemoteAt, '2026-10-03T00:00:01.000Z');
    assert.strictEqual(sb.syncPayload().cash[0].amount, 7);
  });

  await testAsync('ordinary and explicit overwrite writes reject HTTP failures and malformed acknowledgements', async () => {
    const valid = {ok:true,savedAt:'2026-10-03T00:00:00.000Z'};
    const cases = [[503,valid],[503,{message:'Unavailable'}],[200,{}],[200,null],[200,[]],
      [200,{ok:false,savedAt:valid.savedAt}],[200,{ok:true,savedAt:'2026-02-31T00:00:00.000Z'}],[200,{savedAt:valid.savedAt}]];
    for (const action of ['pushToRemote','overwriteRemoteWithLocal']) {
      for (const [status, data] of cases) {
        const sb = freshSandbox(); sb._markCloudDirty();
        sb.fetch = async () => ({status,text:async()=>JSON.stringify(data)});
        assert.strictEqual(await sb[action](), false, action+JSON.stringify({status,data}));
        assert.strictEqual(sb._hasCloudDirty(), true);
        assert.strictEqual(sb._confirmedCloudTimestamp(), '');
      }
      const sb = freshSandbox(); sb._markCloudDirty();
      sb.fetch = async () => ({status:200,text:async()=>JSON.stringify(valid)});
      assert.strictEqual(await sb[action](), true);
      assert.strictEqual(sb._hasCloudDirty(), false);
      assert.strictEqual(sb._confirmedCloudTimestamp(), valid.savedAt);
    }
  });

  await testAsync('explicit overwrite uses edits present at the click and keeps newer in-flight edits dirty', async () => {
    const sb = freshSandbox({cash:[{id:'cash',amount:1}],cpfHistory:[],income:[],expenses:[]});
    vm.runInContext(extractFunction('showConflictModal'), sb);
    const controls = {'cf-force':{},'cf-pull':{}};
    const wrap = {remove(){},addEventListener(){},querySelector:()=>({focus(){}})};
    sb.document = {getElementById:id=>controls[id]||null,createElement:()=>wrap,body:{appendChild(){}}};
    sb.showConflictModal({stashedBody:JSON.stringify(sb.syncPayload())});
    sb.DB.cash[0].amount = 42; sb._localSaveRevision = 2; sb._markCloudDirty();
    let sent;
    sb.fetch = async (_url, request) => {
      sent = JSON.parse(request.body);
      sb.DB.cash[0].amount = 43; sb._localSaveRevision = 3;
      return {status:200,text:async()=>JSON.stringify({ok:true,savedAt:'2026-10-03T00:00:00.000Z'})};
    };
    assert.strictEqual(await controls['cf-force'].onclick(), true);
    assert.strictEqual(sent.cash[0].amount, 42);
    assert.strictEqual(sb._hasCloudDirty(), true);
    sb.isLocalPreview = () => true;
    sb.fetch = () => { throw new Error('Preview must not write'); };
    assert.strictEqual(await sb.overwriteRemoteWithLocal(), false);
    assert.strictEqual(sb._hasCloudDirty(), true);
  });

  await testAsync('identical-data conflict recovery preserves an intervening writer through conditional retry', async () => {
    for (const interleave of [false, true]) {
      const sb = freshSandbox({cash:[{id:'base',amount:1}]}); sb._markCloudDirty();
      sb.setLastPull('2026-10-02T00:00:00.000Z', 'server');
      let remote = JSON.parse(JSON.stringify(sb.syncPayload())), revision = '2026-10-03T00:00:00.000Z';
      let writes = 0, conflicts = 0;
      sb.showConflictModal = () => { conflicts++; };
      sb.fetch = async (_url, request) => {
        let result;
        if (request.method === 'GET') {
          result = {...remote,_savedAt:revision};
          if (interleave) { remote = {...remote,cash:[...remote.cash,{id:'concurrent',amount:2}]}; revision = '2026-10-03T00:00:01.000Z'; }
        } else {
          writes++; const proposed = JSON.parse(request.body);
          assert.ok(Object.hasOwn(proposed, 'lastSeenRemoteAt'));
          if (writes === 2) assert.strictEqual(proposed.lastSeenRemoteAt, '2026-10-03T00:00:00.000Z');
          if (proposed.lastSeenRemoteAt !== revision) result = {conflict:true,remoteAt:revision};
          else { remote = proposed; revision = '2026-10-03T00:00:02.000Z'; result = {ok:true,savedAt:revision}; }
        }
        return {status:200,text:async()=>JSON.stringify(result)};
      };
      assert.strictEqual(await sb.pushToRemote(), !interleave);
      assert.strictEqual(writes, 2); assert.strictEqual(sb._hasCloudDirty(), interleave);
      assert.strictEqual(conflicts, interleave ? 1 : 0);
      assert.strictEqual(remote.cash.some(row=>row.id==='concurrent'), interleave);
    }
  });

  test('vault transition rejects saves without clearing the unsaved warning', () => {
    const sb = freshSandbox(); let saves = 0, message = '';
    sb._vaultManager = {isBusy:()=>true,isEnabled:()=>false};
    sb.saveLocal = () => { saves++; return true; }; sb.showToast = value => { message = value; };
    assert.strictEqual(sb.saveData(), false); assert.strictEqual(saves, 0);
    assert.strictEqual(sb._hasLocalUnsaved(), true); assert.match(message, /save again/);
  });

  await testAsync('vault disable failure does not falsely claim that plaintext is protected', async () => {
    const sb = freshSandbox(); let message = '';
    sb._vaultManager = {isUnlocked:()=>true,disable:async()=>{throw Object.assign(new Error('Some plaintext may remain'),{code:'cleanup-failed'});}};
    sb.showToast = value => { message = value; };
    await sb.disableVaultProtection();
    assert.match(message, /Could not finish disabling encryption/); assert.match(message, /Some plaintext may remain/);
    assert.doesNotMatch(message, /Encryption stayed on/);
  });

  function salarySandbox(){
    const sb = freshSandbox({settings:{birthYear:1996,salary:{grossMonthly:1000,startDate:'2026-09-01',endDate:'2026-09-30'},salaryAccountId:'cash_sgd',salaryCashEnabledAt:'2026-09-01',salarySavePct:50,fxRates:{},fxOverrides:{}},income:[],cash:[{id:'cash_sgd',currency:'SGD',amount:0}],cashTxns:[],expenses:[],cpfHistory:[]});
    stubNow(sb, '2026-10-03T12:00:00+08:00'); let serial = 0; sb.uid = table => table + '_' + (++serial); return sb;
  }

  await testAsync('salary modal corrections survive salary regeneration', async () => {
    const sb = salarySandbox(); sb.generateAutoSalaryEntries(); const original = sb.DB.income[0];
    sb.GICS_SECTOR_OPTIONS = []; sb.SG_INSURERS = [];
    const start = appSrc.indexOf('const ENTITY_SCHEMAS = '), end = appSrc.indexOf('/* Normalise one externally', start);
    vm.runInContext(appSrc.slice(start,end).replace('const ENTITY_SCHEMAS =','ENTITY_SCHEMAS ='), sb);
    const values = {...original,net:'777',notes:'Manual correction'};
    sb._modalState = {table:'income',item:{...original},isNew:false};
    sb.document = {getElementById:id=>id==='em-body'?{querySelector:selector=>({value:String(values[/data-fkey="([^"]+)"/.exec(selector)[1]]??'')})}:null};
    sb.saveData = () => true;
    assert.strictEqual(await sb.entityModalSave(), true); assert.strictEqual(sb.DB.income[0].manualOverride, true);
    sb.generateAutoSalaryEntries(); assert.strictEqual(sb.DB.income[0].net, 777); assert.strictEqual(sb.DB.income[0].notes, 'Manual correction');
  });

  test('salary savings at 100% prune obsolete expenses while keeping manual overrides', () => {
    for (const manual of [false,true]) {
      const sb = salarySandbox(); sb.generateAutoSalaryCashEntries(); assert.strictEqual(sb.DB.expenses[0].amount, 400);
      sb.DB.expenses[0].manualOverride = manual; sb.DB.settings.salarySavePct = 100; sb.generateAutoSalaryCashEntries();
      assert.strictEqual(sb.DB.cashTxns[0].amount, 800); assert.strictEqual(sb.DB.expenses.length, manual ? 1 : 0);
      sb.DB.settings.salarySavePct = 0; sb.generateAutoSalaryCashEntries();
      assert.strictEqual(sb.DB.cashTxns.length, 0); assert.strictEqual(sb.DB.expenses[0].amount, manual ? 400 : 800);
    }
  });

  test('age 55 CPF generation stops unsupported allocation and preserves previous rows', () => {
    const sb = salarySandbox(); sb.DB.settings.birthYear = 1971;
    sb.DB.cpfHistory = [{id:'manual',account:'RA',date:'2026-09-01',amount:7},{id:'existing',auto:'cpf',period:'2026-09',account:'OA',date:'2026-09-25',amount:8}];
    const before = JSON.stringify(sb.DB.cpfHistory), result = sb.generateAutoCpfEntries();
    assert.strictEqual(result.skippedSenior, true); assert.strictEqual(result.changed, 0);
    assert.strictEqual(JSON.stringify(sb.DB.cpfHistory), before);
  });

  test('tax relief uses low-wage CPF and combines the annual bonus payout before rounding', () => {
    const sb = freshSandbox({settings:{salary:{grossMonthly:600,annualBonus:300},tax:{},birthYear:1996}});
    stubNow(sb, '2026-10-03T12:00:00+08:00'); assert.strictEqual(sb.estimateAnnualTax().annualEmpCpf, 840);
    sb.DB.settings.salary = {grossMonthly:400,annualBonus:0}; assert.strictEqual(sb.estimateAnnualTax().annualEmpCpf, 0);
  });

  await testAsync('IBKR blocks currency mismatches before mutation and still imports matching currency', async () => {
    for (const currency of ['USD','SGD']) {
      const sb = freshSandbox({stocks:[{id:'stock',symbol:'SYN',market:'US',currency:'SGD',shares:0,avgCost:0}],stockTxns:[]});
      const matched = [{stockId:'stock',symbol:'SYN',market:'US',currency,status:'new',date:'2026-09-01',side:'buy',shares:1,price:100,fees:0}];
      const overlay = {dataset:{matched:JSON.stringify(matched)},querySelectorAll:()=>[],classList:{remove(){}}};
      sb.document = {getElementById:()=>overlay}; sb.saveData = () => true;
      let undo = 0, message = ''; sb.pushUndo = () => { undo++; }; sb.showToast = value => { message = value; };
      assert.strictEqual(await sb.ibkrConfirmImport(), currency === 'SGD');
      assert.strictEqual(sb.DB.stockTxns.length, currency === 'SGD' ? 1 : 0); assert.strictEqual(undo, currency === 'SGD' ? 1 : 0);
      assert.strictEqual(sb._ibkrImportInFlight, false); if (currency === 'USD') assert.match(message, /USD.*SGD.*No trades were added/);
    }
    const sb = freshSandbox({stocks:[],stockTxns:[]});
    const trades = ['USD','SGD'].map(currency=>({symbol:'SYN',market:'US',currency,status:'new-stock',date:'2026-09-01',side:'buy',shares:1,price:100,fees:0}));
    sb.document = {getElementById:()=>({dataset:{matched:JSON.stringify(trades)},querySelectorAll:()=>[]})};
    assert.strictEqual(await sb.ibkrConfirmImport(), false); assert.strictEqual(sb.DB.stocks.length, 0);
  });

  test('current totals stop at Singapore today across the UTC-to-SGT midnight boundary', () => {
    const sb = freshSandbox({settings:{fxRates:{},fxOverrides:{}},cash:[{id:'cash',amount:100,currency:'SGD',asOf:'2026-01-01'}],
      cashTxns:[{cashAccountId:'cash',type:'deposit',date:'2026-10-04',amount:20},{cashAccountId:'cash',type:'deposit',date:'2026-10-05',amount:50}],
      stocks:[{id:'stock',shares:1,avgCost:100}],stockTxns:[{stockId:'stock',date:'2026-10-04',side:'buy',shares:1,price:100,fees:0},{stockId:'stock',cashAccountId:'cash',date:'2026-10-05',side:'buy',shares:1,price:100,fees:0}],
      cpfBalances:{OA:100,anchorDate:'2026-01-01'},cpfHistory:[{account:'OA',date:'2026-10-04',amount:20},{account:'OA',date:'2026-10-05',amount:50}],
      income:[{date:'2026-10-04',gross:400,net:400},{date:'2026-10-05',gross:1000,net:1000}],expenses:[{date:'2026-10-04',amount:50,currency:'SGD'},{date:'2026-10-05',amount:900,currency:'SGD'}]});
    stubNow(sb, '2026-10-03T16:30:00.000Z');
    assert.strictEqual(sb.deriveCashBalance(sb.DB.cash[0]), 120); assert.strictEqual(sb.deriveStockPosition('stock').shares, 2);
    assert.strictEqual(sb.cpfEffectiveBalances().OA, 120); assert.strictEqual(sb.annualIncomeSGD(), 400);
    assert.strictEqual(sb.annualExpensesSGD().annual, 50); assert.strictEqual(sb.derivedMonthlySavingsSGD(), 350 / 12);
    sb.DB.income = sb.DB.income.filter(row=>row.date==='2026-10-05'); sb.DB.expenses = sb.DB.expenses.filter(row=>row.date==='2026-10-05');
    assert.strictEqual(sb.annualIncomeSGD(), 0); assert.strictEqual(sb.annualExpensesSGD().annual, 0); assert.strictEqual(sb.derivedMonthlySavingsSGD(), 0);
    sb.DB.stockTxns = sb.DB.stockTxns.filter(row=>row.date==='2026-10-05'); assert.strictEqual(sb.deriveStockPosition('stock'), null);
  });

  test('missing expense FX blocks FIRE verdicts even when the target is manual', () => {
    for (const fireTarget of [null,100000]) {
      const sb = freshSandbox({settings:{birthYear:1990,salary:{},fireTarget,fireMultiple:25,fxRates:{},fxOverrides:{}},expenses:[{date:'2026-10-01',amount:1,currency:'SGD'},{date:'2026-10-01',amount:1000,currency:'EUR'}],income:[{date:'2026-10-01',net:500,gross:500}]});
      stubNow(sb, '2026-10-03T12:00:00+08:00'); if (fireTarget == null) assert.strictEqual(sb.fireNumberSGD(), null);
      assert.strictEqual(sb.derivedMonthlySavingsSGD(), null); const root = {innerHTML:''};
      sb.document = {getElementById:()=>root}; sb.setRenderCcy = () => {}; sb._liquidAssetValueInfo = () => ({total:100000,incomplete:false}); sb._clearProjectionChart = () => {}; sb._emptyIcon = () => '';
      sb.renderProjections(); assert.match(root.innerHTML, /Projection unavailable/); assert.match(root.innerHTML, /Set FX rates for expenses/); assert.doesNotMatch(root.innerHTML, /On track|reach it around/);
    }
  });

  await testAsync('auto refresh includes watchlist-only quotes and each unpinned foreign currency', async () => {
    const sb = freshSandbox({stocks:[],watchlist:[{symbol:'SYN',market:'US'}],cash:[],crypto:[],expenses:[],settings:{fxOverrides:{USDSGD:1.4},fxRates:{}}});
    sb.document = {hidden:false}; sb.autoRefreshEnabled = () => true; sb.isStockMarketDaySGT = () => true;
    let quotes = 0, fx = 0; sb.refreshStockPrices = async () => { quotes++; }; sb.refreshFx = async () => { fx++; };
    await sb.autoRefreshTick(); assert.strictEqual(quotes, 1); assert.strictEqual(fx, 0);
    sb.DB.watchlist = []; sb.DB.cash = [{currency:'EUR',amount:1}]; await sb.autoRefreshTick(); assert.strictEqual(fx, 1);
    sb.DB.cash = []; sb.DB.expenses = [{currency:'JPY',amount:1}]; await sb.autoRefreshTick(); assert.strictEqual(fx, 2);
    sb.DB.expenses = []; await sb.autoRefreshTick(); assert.strictEqual(fx, 2);
  });

  await testAsync('actual app and vault reject a save during enable, then retain the retried edit after reopen', async () => {
    const {webcrypto} = require('node:crypto');
    const {createManager} = require('../Worker/kjr-vault.js');
    const sb = freshSandbox({cash:[{id:'synthetic',amount:1}],settings:{},_priceCache:{}});
    const storage = sb.localStorage;
    Object.defineProperty(storage, 'length', {get:()=>storage._data.size});
    storage.key = index => Array.from(storage._data.keys())[index] ?? null;
    const dbKey = 'kjr-pf-db-v1';
    storage.setItem(dbKey, JSON.stringify(sb.DB));
    let release, entered;
    const gate = new Promise(resolve=>{release=resolve;});
    const started = new Promise(resolve=>{entered=resolve;});
    const delayedCrypto = {getRandomValues:array=>webcrypto.getRandomValues(array),subtle:{
      importKey:(...args)=>webcrypto.subtle.importKey(...args),
      deriveKey:async(...args)=>{entered();await gate;return webcrypto.subtle.deriveKey(...args);},
      encrypt:(...args)=>webcrypto.subtle.encrypt(...args),decrypt:(...args)=>webcrypto.subtle.decrypt(...args)
    }};
    const options = {storage,crypto:delayedCrypto,envelopeKey:'synthetic-vault',sensitiveKeys:[dbKey,vm.runInContext('LK_PRICE_CACHE',sb)]};
    const vault = createManager(options);
    sb._vaultManager = vault; sb.protectedStorage = vault.storage; sb.getSyncUrl = () => '';
    vm.runInContext(extractFunction('saveLocal')+'\n'+extractFunction('_readStoredLocalPayload'), sb);
    const enabling = vault.enable('synthetic integration passphrase');
    await started;
    sb.DB.cash[0].amount = 42;
    assert.strictEqual(await sb.saveData(), false);
    assert.strictEqual(sb._hasLocalUnsaved(), true);
    assert.strictEqual(JSON.parse(storage.getItem(dbKey)).cash[0].amount, 1);
    release(); await enabling;
    assert.strictEqual(sb._hasLocalUnsaved(), true);
    assert.strictEqual(await sb.saveData(), true);
    await vault.flush();
    assert.strictEqual(sb._hasLocalUnsaved(), false);
    assert.strictEqual(storage.getItem(dbKey), null);
    vault.lock();
    const reopened = createManager({...options,crypto:webcrypto});
    await reopened.unlock('synthetic integration passphrase');
    assert.strictEqual(JSON.parse(reopened.storage.getItem(dbKey)).cash[0].amount, 42);
  });

  await testAsync('older encrypted-save completion cannot clear an edit refused during a vault transition', async () => {
    const sb = freshSandbox(); let busy = false, release;
    const pending = new Promise(resolve=>{release=resolve;});
    sb._vaultManager = {isBusy:()=>busy,isEnabled:()=>true,flush:()=>pending};
    sb.getSyncUrl = () => '';
    const first = sb.saveData();
    busy = true;
    const oldRevision = sb._localSaveRevision;
    assert.strictEqual(sb.saveData(), false);
    assert.strictEqual(sb._localSaveRevision, oldRevision + 1);
    release();
    assert.strictEqual(await first, false);
    assert.strictEqual(sb._hasLocalUnsaved(), true);
  });

  /* ═══════════════════════════════════════════════════════════════════════
     v2.73 mobile list rows, chip filters and More menus.
     The phone list and the desktop table must read the same rows, so most of
     these run the REAL render functions against a small fake DOM and hold the
     list's text against the table's cells and against the column registry.
     ═══════════════════════════════════════════════════════════════════════ */
  const DASH = '–';
  const TODAY_ISO = new Date().toISOString();

  /* A fresh sandbox with the real formatter (fmt and toDisplay) and the real kjrEscape in place of the identity stubs,
     a fixed USDSGD of 1.25 and a chosen render currency. */
  function listSandbox(db, ccy){
    const base = Object.assign({ settings:{ fxOverrides:{ USDSGD:1.25 }, fxRates:{} } }, db || {});
    const sb = realEscape(freshSandbox(base));
    vm.runInContext(extractFunction('fmt') + '\n' + extractFunction('toDisplay'), sb);
    sb.displayCcy = () => ccy || 'SGD';
    sb.coinIdFor = id => String(id).toLowerCase();
    return sb;
  }

  /* Fake elements by id (innerHTML, textContent and value are plain properties) and the stubs every render function needs. */
  function renderBox(sb, ids){
    const els = {};
    ids.forEach(id => {
      els[id] = { id, innerHTML:'', textContent:'', value:'', className:'', hidden:false, querySelector: () => null, contains: () => false,
        classList:{ on:new Set(), toggle(n, force){ if (force) this.on.add(n); else this.on.delete(n); return !!force; }, add(n){ this.on.add(n); }, remove(n){ this.on.delete(n); }, contains(n){ return this.on.has(n); } } };
    });
    sb.document = { getElementById: id => els[id] || null, activeElement:null };
    sb.setRenderCcy = () => {};
    sb.renderSummary = () => '';
    sb._emptyIcon = () => '';
    sb.priceFreshnessText = () => 'Prices just now';
    sb.fxFreshnessText = () => 'FX just now';
    sb.relTime = () => 'just now';
    return els;
  }

  function stocksBox(sb){
    const els = renderBox(sb, ['stocks-body', 'stocks-summary']);
    vm.runInContext("var _stocksFilter = { sector:'', market:'' }; var _stocksPage = 0; var STOCKS_PAGE_SIZE = 50; var _sfText = ''; var _sfCls = ''; var _lastStockRows = []; var _stockChartRows = [];", sb);
    sb.renderSectorAllocation = () => '';
    sb._infoTip = () => '';
    sb.renderWatchlist = () => {}; sb.renderBoard = () => {}; sb.renderDividendTimeline = () => {}; sb.renderStockTxns = () => {};
    sb.orderedStockCols = () => vm.runInContext('STOCK_COLUMNS', sb).map(c => Object.assign({}, c, { visible: !!c.defVis }));
    return els;
  }

  const stockCols = sb => { const cols = {}; vm.runInContext('STOCK_COLUMNS', sb).forEach(c => { cols[c.key] = c; }); return cols; };
  const listRowsOf = html => Array.from(html.matchAll(/<button type="button" class="dash-hrow hl-row"[^>]*>[\s\S]*?<\/button>/g)).map(m => m[0]);
  const stockFixture = () => ({
    stocks:[
      { id:'s_aapl', symbol:'AAPL', market:'US', sector:'Information Technology', shares:10, avgCost:80, currency:'USD' },
      { id:'s_d05', symbol:'D05', market:'SGX', sector:'Financials', shares:100, avgCost:30, currency:'SGD' },
      { id:'s_nopx', symbol:'NOPX', market:'US', shares:5, avgCost:10, currency:'USD' },
      { id:'s_o39', symbol:'O39', market:'SGX', sector:'Financials', shares:200, avgCost:12, currency:'SGD' }
    ],
    _priceCache:{
      AAPL:{ price:100, currency:'USD', fetchedAt:TODAY_ISO },
      D05:{ price:35, currency:'SGD', fetchedAt:TODAY_ISO },
      O39:{ price:9, currency:'SGD', fetchedAt:TODAY_ISO }
    }
  });

  test('_plainText - the words of a formatter result, tags dropped and the five escapes undone once', () => {
    const sb = freshSandbox();
    assert.strictEqual(sb._plainText('<span class="price-stale">SGD 5,240 · FX missing</span>'), 'SGD 5,240 · FX missing');
    assert.strictEqual(sb._plainText('A &amp; B &lt;b&gt; &quot;q&quot; &#39;s&#39;'), 'A & B <b> "q" \'s\'');
    assert.strictEqual(sb._plainText('&amp;lt;'), '&lt;');
    assert.strictEqual(sb._plainText(null), '');
    assert.strictEqual(sb._plainText(undefined), '');
    assert.strictEqual(sb._plainText(12), '12');
  });

  test('_returnCell - percentage over amount, the arrow and sign on the percentage, an amount with no percentage carries its own arrow, nothing known gives dashes', () => {
    const sb = freshSandbox();
    const cell = (...a) => navPlain(sb._returnCell(...a));
    assert.deepStrictEqual(cell(12, 5.5, '+S$12'), { dir:'up', pct:'▲ +5.50%', amount:'+S$12' });
    assert.deepStrictEqual(cell(-3, -2, '-S$3'), { dir:'down', pct:'▼ -2.00%', amount:'-S$3' });
    assert.deepStrictEqual(cell(0, 0, 'S$0'), { dir:'up', pct:'+0.00%', amount:'S$0' });          // zero reads as the table does: gain colour, no arrow
    assert.deepStrictEqual(cell(null, null, ''), { dir:'', pct:DASH, amount:'' });
    assert.deepStrictEqual(cell(50, null, '+S$50'), { dir:'up', pct:DASH, amount:'▲ +S$50' });   // a cost of zero has no percentage
    assert.deepStrictEqual(cell(-50, null, '-S$50'), { dir:'down', pct:DASH, amount:'▼ -S$50' });
  });

  test('_stockListModel - the phone row reads the same figures as the table cells (value, return, share), a missing price shows dashes', () => {
    const sb = listSandbox(stockFixture(), 'USD');
    const rows = sb.buildStockChartRows();
    const cols = stockCols(sb);
    assert.strictEqual(rows.length, 4);
    rows.forEach(r => {
      const m = navPlain(sb._stockListModel(r));
      assert.strictEqual(m.table, 'stocks'); assert.strictEqual(m.id, r.s.id); assert.strictEqual(m.sym, r.s.symbol); assert.strictEqual(m.cls, 'stocks');
      assert.strictEqual(m.sub, [r.s.market, r.s.sector].filter(Boolean).join(' · '));
      // value, return percentage and share: the very strings the table's Market value, P&L %, and Weight % cells print
      assert.strictEqual(m.value, r.mv != null ? cols.mv.render(r) : DASH, r.s.symbol + ' value');
      assert.strictEqual(m.pct, r.plPct != null ? sb._plainText(cols.plPct.render(r)) : DASH, r.s.symbol + ' return %');
      assert.strictEqual(m.share, r.weight != null ? cols.weight.render(r) : DASH, r.s.symbol + ' share');
      // the amount: the P&L cell is arrow plus amount, the list keeps the arrow on the percentage
      if (r.pl != null) assert.strictEqual(sb._plainText(cols.pl.render(r)), sb._plArrow(r.pl) + sb._plainText(m.amount), r.s.symbol + ' return amount');
      else assert.strictEqual(m.amount, '');
      assert.strictEqual(m.dir, r.pl == null ? '' : (r.pl >= 0 ? 'up' : 'down'));
      assert.strictEqual(m.fx, false);
    });
    const aapl = navPlain(sb._stockListModel(rows[0]));
    assert.ok(aapl.value.startsWith('US$'), aapl.value);                       // the Stocks tab shows US$ by default
    assert.ok(aapl.pct.startsWith('▲ +') && aapl.pct.endsWith('%'));
    assert.strictEqual(aapl.shareOf, 'of stocks');
    // a holding with no price: dashes everywhere, never NaN or undefined
    const nopx = navPlain(sb._stockListModel(rows[2]));
    assert.deepStrictEqual({ value:nopx.value, share:nopx.share, pct:nopx.pct, amount:nopx.amount, dir:nopx.dir }, { value:DASH, share:DASH, pct:DASH, amount:'', dir:'' });
    // the shares of all four add to 100
    const total = rows.reduce((s, r) => s + (r.weight || 0), 0);
    assert.ok(Math.abs(total - 100) < 1e-9);
  });

  test('_stockListModel - a figure with no FX rate keeps its native amount without the long tail, and the row says FX missing once', () => {
    const sb = listSandbox(Object.assign(stockFixture(), { settings:{ fxOverrides:{}, fxRates:{} } }), 'USD');   // SGD to USD has no rate
    const rows = sb.buildStockChartRows();
    const d05 = rows.find(r => r.s.symbol === 'D05');
    assert.strictEqual(d05.mv, 3500);
    const m = navPlain(sb._stockListModel(d05));
    assert.strictEqual(m.fx, true);
    assert.strictEqual(m.value, '<span class="price-stale">SGD 3,500</span>');
    assert.strictEqual(sb._plainText(m.amount), 'SGD +500');
    assert.ok(!m.value.includes('FX missing') && !m.amount.includes('FX missing'));
    // the table still says it in full, in every cell
    assert.ok(stockCols(sb).mv.render(d05).includes('FX missing'));
    const html = sb._holdingRowHtml(m);
    assert.strictEqual((html.match(/FX missing/g) || []).length, 1);
    assert.ok(html.includes('<span class="dash-sub"><span class="price-stale">FX missing</span></span>'));
    assert.ok(sb._holdingLabel(m).includes('FX rate missing'));
    // the AAPL row cannot price at all without USDSGD, so it is dashes
    assert.strictEqual(navPlain(sb._stockListModel(rows[0])).value, DASH);
  });

  test('_cryptoListModel - value, return and share read the same figures as the Crypto table, the share is of the coin list', () => {
    const sb = listSandbox({ crypto:[
      { id:'c_btc', symbol:'BTC', coingeckoId:'bitcoin', amount:0.25, avgCost:60000, currency:'USD' },
      { id:'c_eth', symbol:'ETH', coingeckoId:'ethereum', amount:2, avgCost:2000, currency:'USD' },
      { id:'c_foo', symbol:'FOO', amount:5, avgCost:10, currency:'USD' }
    ], _priceCache:{ bitcoin:{ sgd:152000, change24h:1.8, fetchedAt:TODAY_ISO }, ethereum:{ sgd:4000, change24h:-0.5, fetchedAt:TODAY_ISO } } });
    const rows = sb.DB.crypto.map(c => sb._cryptoRow(c));
    const totMv = rows.reduce((s, r) => s + (r.mv || 0), 0);
    assert.strictEqual(totMv, 38000 + 8000);
    const btc = navPlain(sb._cryptoListModel(rows[0], totMv));
    assert.deepStrictEqual({ table:btc.table, id:btc.id, sym:btc.sym, cls:btc.cls, sub:btc.sub }, { table:'crypto', id:'c_btc', sym:'BTC', cls:'crypto', sub:'Crypto' });
    assert.strictEqual(btc.value, sb.fmt(rows[0].mv, { dp:0 }));
    assert.strictEqual(btc.share, (38000 / 46000 * 100).toFixed(1) + '%');
    assert.strictEqual(btc.shareOf, 'of coins');
    assert.strictEqual(btc.pct, sb.fmtPct(rows[0].plPct));
    assert.strictEqual(btc.amount, sb.fmt(rows[0].pl, { dp:0, signed:true }));
    assert.strictEqual(btc.dir, 'up');
    const none = navPlain(sb._cryptoListModel(rows[2], totMv));
    assert.deepStrictEqual({ value:none.value, share:none.share, pct:none.pct, amount:none.amount, dir:none.dir }, { value:DASH, share:DASH, pct:DASH, amount:'', dir:'' });
    // an empty coin list has no share to give
    assert.strictEqual(navPlain(sb._cryptoListModel(rows[0], 0)).share, DASH);
  });

  test('_holdingRowHtml - one button per holding, routed through openHolding, a monogram, amounts in .money-chip, no inline handlers', () => {
    const sb = listSandbox(stockFixture(), 'USD');
    const r = sb.buildStockChartRows()[0];
    const html = sb._holdingRowHtml(sb._stockListModel(r));
    assert.ok(html.startsWith('<button type="button" class="dash-hrow hl-row" data-click="openHolding" data-a0="stocks" data-a1="s_aapl" aria-haspopup="dialog" aria-label="AAPL, US · Information Technology, value US$'));
    assert.ok(html.endsWith('</button>'));
    assert.ok(html.includes('class="mono" style="background:var(--c-stocks-soft);color:var(--c-stocks-ink)" aria-hidden="true">A</span>'));
    assert.ok(html.includes('<b>AAPL</b><span>US · Information Technology</span>'));
    assert.strictEqual((html.match(/money-chip/g) || []).length, 2);              // the value and the return amount
    assert.ok(html.includes('<span class="dash-chg up">▲ +'));                  // percentage: arrow, sign, gain class
    assert.ok(/<span class="hl-of"> of stocks<\/span>/.test(html));
    assert.strictEqual(/\son[a-z]+="/i.test(html), false);
    assert.strictEqual((html.match(/<button/g) || []).length, 1);
    // a loss reads ▼ and the loss class
    r.pl = -30; r.plPct = -3.5;
    const down = sb._holdingRowHtml(sb._stockListModel(r));
    assert.ok(down.includes('<span class="dash-chg down">▼ -3.50%</span>'));
    assert.ok(/aria-label="[^"]*return -3\.50%/.test(down));
    // a crypto row says Crypto and opens the crypto record
    const coin = sb._holdingRowHtml({ table:'crypto', id:'c_btc', sym:'BTC', cls:'crypto', sub:'Crypto', value:'S$38,000', share:'82.6%', shareOf:'of coins', fx:false, dir:'up', pct:'▲ +87.65%', amount:'+S$17,750' });
    assert.ok(coin.includes('data-a0="crypto" data-a1="c_btc"') && coin.includes('>₿</span>') && coin.includes('<span>Crypto</span>'));
  });

  test('_holdingLabel - the spoken form: name, market and sector, value, share, return in words without arrows', () => {
    const sb = freshSandbox();
    const m = { sym:'AAPL', sub:'US · Information Technology', value:'US$1,000', share:'26.3%', shareOf:'of stocks', pct:'▲ +25.00%', amount:'+US$200', fx:false };
    assert.strictEqual(sb._holdingLabel(m), 'AAPL, US · Information Technology, value US$1,000, 26.3% of stocks, return +25.00% +US$200');
    assert.strictEqual(sb._holdingLabel(Object.assign({}, m, { pct:'▼ -2.00%', amount:'-US$5' })), 'AAPL, US · Information Technology, value US$1,000, 26.3% of stocks, return -2.00% -US$5');
    assert.strictEqual(sb._holdingLabel({ sym:'NOPX', sub:'US', value:DASH, share:DASH, shareOf:'of stocks', pct:DASH, amount:'', fx:false }), 'NOPX, US, value not available, return not available');
    assert.ok(sb._holdingLabel(Object.assign({}, m, { value:'<span class="price-stale">SGD 3,500</span>', fx:true })).endsWith('FX rate missing'));
    assert.strictEqual(sb._holdingLabel({ sym:'X', sub:'', value:DASH, share:DASH, shareOf:'', pct:DASH, amount:'+S$4', fx:false }), 'X, value not available, return +S$4');
  });

  test('openHoldingDetail - the one place a holding row goes, today the edit form, only for a stock or a coin with a safe id', () => {
    const sb = freshSandbox();
    const calls = [];
    sb.openEntityModal = (table, id) => calls.push(['open', table, id]);
    sb.showToast = (msg, kind) => calls.push(['toast', kind]);
    assert.strictEqual(sb.openHoldingDetail('stocks', 'stock_seed_aapl'), true);
    assert.strictEqual(sb.openHoldingDetail('crypto', 'c-btc_1'), true);
    assert.deepStrictEqual(calls, [['open', 'stocks', 'stock_seed_aapl'], ['open', 'crypto', 'c-btc_1']]);
    calls.length = 0;
    ['cash', 'cpfHistory', 'realestate', '', null, undefined, 'constructor', '__proto__'].forEach(t => assert.strictEqual(sb.openHoldingDetail(t, 'x1'), false, String(t)));
    assert.deepStrictEqual(calls, []);
    ['', null, undefined, 'a b', 'x"y', '<img>', 'a'.repeat(65)].forEach(id => assert.strictEqual(sb.openHoldingDetail('stocks', id), false, String(id)));
    assert.deepStrictEqual(calls.map(c => c[0] + ':' + c[1]), Array(7).fill('toast:error'));
    // the rows and the delegated action go through it, nothing else opens a holding
    const actions = extractFunction('installEventDelegation');
    assert.ok(actions.includes('openHolding:         (el) => { const [a0, a1] = A(el); openHoldingDetail(a0, a1); },'));
    assert.ok(extractFunction('_holdingRowHtml').includes('data-click="openHolding"'));
    assert.ok(extractFunction('openHoldingDetail').includes('openEntityModal(table, id)'));
  });

  test('renderStocks - the phone list and the desktop table come from the same rows: same symbols in the same order, same values, same totals, under a filter and a sort', () => {
    const sb = listSandbox(stockFixture(), 'USD');
    const els = stocksBox(sb);
    const cols = stockCols(sb);
    const run = () => { sb.renderStocks(); return els['stocks-body'].innerHTML; };
    const tableSyms = html => Array.from(html.matchAll(/cell-sym sticky-col">([^<]*)</g)).map(m => m[1]);
    const listSyms = html => listRowsOf(html).map(r => /<b>([^<]*)<\/b>/.exec(r)[1]);
    const parity = (html, label) => {
      assert.deepStrictEqual(listSyms(html), tableSyms(html), label + ' order');
      const rows = vm.runInContext('_lastStockRows', sb);
      assert.strictEqual(listRowsOf(html).length, rows.length, label + ' count');
      rows.forEach((r, i) => {
        const rowHtml = listRowsOf(html)[i];
        if (r.mv != null){
          assert.ok(html.includes('<td class="num">' + cols.mv.render(r) + '</td>'), label + ' table value ' + r.s.symbol);
          assert.ok(rowHtml.includes(sb._moneyHtml(cols.mv.render(r))), label + ' list value ' + r.s.symbol);
        } else {
          assert.ok(rowHtml.includes('<span class="dash-hval money-chip">' + DASH + '</span>'), label + ' list dash ' + r.s.symbol);
        }
        if (r.plPct != null) {
          assert.ok(html.includes(cols.plPct.render(r)), label + ' table return % ' + r.s.symbol);
          assert.ok(rowHtml.includes('>' + sb._plainText(cols.plPct.render(r)) + '</span>'), label + ' list return % ' + r.s.symbol);
        }
        assert.ok(rowHtml.includes('data-a1="' + r.s.id + '"'));
      });
      // the totals line is the footer row's figure, for the filtered set
      const foot = /<tfoot>[\s\S]*<\/tfoot>/.exec(html)[0];
      const fMv = rows.filter(r => r.mv != null).reduce((s, r) => s + r.mv, 0);
      if (rows.some(r => r.mv != null)) {
        const text = sb.fmtSgdOrNative(sb.roundMoney(fMv), 'SGD', { dp:0 });
        assert.ok(foot.includes('<td class="num">' + text + '</td>'), label + ' footer total');
        assert.ok(/<div class="hl-total">[\s\S]*<\/div>/.exec(html)[0].includes(sb._moneyHtml(text)), label + ' list total');
      }
    };
    let html = run();
    assert.deepStrictEqual(tableSyms(html), ['AAPL', 'D05', 'NOPX', 'O39']);
    parity(html, 'default');
    // a sort, set the way the table headers set it
    sb.DB.settings.stocksSort = { key:'mv', dir:'desc' };
    html = run();
    assert.deepStrictEqual(listSyms(html), ['D05', 'O39', 'AAPL', 'NOPX']);        // no price sorts last
    parity(html, 'sorted');
    sb.DB.settings.stocksSort = { key:'symbol', dir:'asc' };
    parity(run(), 'by symbol');
    // a filter, the way the market select sets it
    vm.runInContext("_stocksFilter.market = 'SGX'", sb);
    html = run();
    assert.deepStrictEqual(listSyms(html), tableSyms(html));
    assert.deepStrictEqual(tableSyms(html), ['O39', 'D05'].sort((a, b) => a.localeCompare(b)));
    parity(html, 'filtered');
    // a filter with nothing in it keeps the chips and Clear on the empty state
    vm.runInContext("_stocksFilter.market = 'SGX'; _stocksFilter.sector = 'Energy'", sb);
    html = run();
    assert.ok(html.includes('No holdings match your filter.') && html.includes('id="sfm-clear"') && html.includes('class="chip-row"') && html.includes('class="m-actions"'));
    assert.strictEqual(listRowsOf(html).length, 0);
  });

  test('renderStocks - the phone controls: chips bound to the same handlers and state, Clear first while a filter is on, + Add and a More menu, the desktop controls untouched', () => {
    const sb = listSandbox(stockFixture(), 'USD');
    const els = stocksBox(sb);
    sb.renderStocks();
    let html = els['stocks-body'].innerHTML;
    // desktop controls: the same ids, handlers and labels as before, now inside .hd-actions
    assert.ok(html.includes('<div class="hd-actions">'));
    ['id="sf-market" class="fi fi-sm" data-change="stocksFilterMarket" aria-label="Filter stocks by market"', 'id="sf-sector" class="fi fi-sm" data-change="stocksFilterSector" aria-label="Filter stocks by sector"',
      'data-click="exportHoldingsCSV">Export CSV', 'data-click="refreshStockPrices" id="btn-refresh-stocks">↻ Refresh prices', 'data-click="openStockColumns" id="btn-stock-cols">⚙ Columns', 'id="freshness-stocks"']
      .forEach(frag => assert.ok(html.includes(frag), frag));
    assert.strictEqual(/<div class="card-head"><h3>Holdings[^]*?style="display:flex/.test(html), false);   // the inline flex style became the class
    // chips: a native select each, the same ACTIONS the desktop selects use, and a Sort chip on its own action
    assert.ok(html.includes('<div class="chip-row" role="group" aria-label="Filter and sort holdings">'));
    assert.ok(html.includes('<select id="sfm-market" class="chip-sel" data-change="stocksFilterMarket" aria-label="Filter stocks by market">'));
    assert.ok(html.includes('<select id="sfm-sector" class="chip-sel chip-sector" data-change="stocksFilterSector" aria-label="Filter stocks by sector">'));
    assert.ok(html.includes('<select id="sfm-sort" class="chip-sel" data-change="stocksSortPick" aria-label="Sort holdings">'));
    assert.strictEqual(html.includes('id="sfm-clear"'), false);                    // no filter, no Clear
    assert.strictEqual((html.match(/ is-on/g) || []).length, 0);
    // + Add and More: the menu holds Export CSV then Refresh prices, wired through moreMenuPick
    assert.ok(html.includes('<button type="button" class="btn btn-primary m-act" data-click="openEntity" data-a0="stocks"><span>＋ Add<span class="add-sfx"> stock</span></span></button>'));
    assert.ok(html.includes('id="more-btn-stocks" data-menu-btn="more-stocks" data-click="toggleShellMenu" data-a0="more-stocks" aria-haspopup="menu" aria-expanded="false" aria-controls="more-menu-stocks" aria-label="More actions"'));
    assert.ok(html.indexOf('data-a0="exportHoldingsCSV"') < html.indexOf('data-a0="refreshStockPrices"') && html.includes('id="more-menu-stocks" role="menu" aria-label="More actions" hidden'));
    assert.strictEqual((html.match(/data-click="moreMenuPick"/g) || []).length, 2);
    // a filter and a sort light their chips and bring Clear in first
    vm.runInContext("_stocksFilter.market = 'US'; _stocksFilter.sector = 'Information Technology'", sb);
    sb.DB.settings.stocksSort = { key:'plPct', dir:'desc' };
    sb.renderStocks();
    html = els['stocks-body'].innerHTML;
    assert.ok(html.indexOf('id="sfm-clear"') > -1 && html.indexOf('id="sfm-clear"') < html.indexOf('id="sfm-market"'));
    assert.ok(html.includes('<button type="button" class="chip-btn" id="sfm-clear" data-click="stocksClearFilter" aria-label="Clear filters">Clear</button>'));
    assert.strictEqual((html.match(/chip-sel[^"]* is-on/g) || []).length, 3);
    assert.ok(html.includes('<option value="US" selected>US</option>') && html.includes('<option value="plPct:desc" selected>Sort: Return, high to low</option>'));
    // no inline handlers, and the chips and the list reach the page only through data attributes
    assert.strictEqual(/\son[a-z]+="/i.test(html), false);
  });

  test('renderStocks - 120 holdings page together: the list shows the same 50 rows as the table, then the next 50 and the last 20', () => {
    const many = { stocks:[], _priceCache:{} };
    for (let i = 0; i < 120; i++){
      many.stocks.push({ id:'s_' + i, symbol:'T' + String(i).padStart(3, '0'), market:'US', shares:1, avgCost:1, currency:'USD' });
      many._priceCache['T' + String(i).padStart(3, '0')] = { price:2 + i, currency:'USD', fetchedAt:TODAY_ISO };
    }
    const sb = listSandbox(many, 'USD');
    const els = stocksBox(sb);
    const tableSyms = html => Array.from(html.matchAll(/cell-sym sticky-col">([^<]*)</g)).map(m => m[1]);
    const listSyms = html => listRowsOf(html).map(r => /<b>([^<]*)<\/b>/.exec(r)[1]);
    [[0, 50], [1, 50], [2, 20]].forEach(([page, count]) => {
      vm.runInContext('_stocksPage = ' + page, sb);
      sb.renderStocks();
      const html = els['stocks-body'].innerHTML;
      assert.strictEqual(listRowsOf(html).length, count, 'page ' + page);
      assert.deepStrictEqual(listSyms(html), tableSyms(html), 'page ' + page + ' order');
      assert.ok(html.includes('Page ' + (page + 1) + ' of 3 · showing ' + count + ' of 120'));
      assert.strictEqual(listSyms(html)[0], 'T' + String(page * 50).padStart(3, '0'));
    });
    // the pager sits after both, so it drives the list as it drives the table
    const html = els['stocks-body'].innerHTML;
    assert.ok(html.indexOf('class="hl"') < html.indexOf('class="tbl-pager"'));
  });

  test('renderStocks - hostile symbols, sectors and long names reach the page only as escaped text, in the row, its label and the chips', () => {
    const evil = '<img src=x onerror="window.__x=1">';
    const sb = listSandbox({ stocks:[
      { id:'s_evil', symbol:evil, market:'US', sector:'"><script>alert(1)</script>', shares:1, avgCost:1, currency:'USD' },
      { id:'s_long', symbol:'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', market:'SGX', sector:'Financials', shares:1, avgCost:1, currency:'SGD' },
      { id:'s_"><b>x</b>', symbol:'IDX', market:'US', sector:'Financials', shares:1, avgCost:1, currency:'USD' }
    ], _priceCache:{ [evil]:{ price:5, currency:'USD', fetchedAt:TODAY_ISO } } }, 'USD');
    const els = stocksBox(sb);
    sb.renderStocks();
    const list = listRowsOf(els['stocks-body'].innerHTML).join('');
    assert.strictEqual(/<img|<script/i.test(list), false, 'raw markup in the list');
    assert.ok(list.includes('&lt;img src=x onerror=&quot;window.__x=1&quot;&gt;'));
    assert.ok(list.includes('&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;'));
    // an attribute can not be broken out of: every aria-label stays one quoted value
    listRowsOf(els['stocks-body'].innerHTML).forEach(r => assert.strictEqual(/aria-label="[^"]*"[^>]*aria-label=/.test(r), false));
    assert.ok(list.includes('ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'));
    // the monogram takes the first character, escaped
    assert.ok(list.includes('>&lt;</span>'));
    // an id with markup in it stays inside its attribute (and the click handler would refuse it, see openHoldingDetail)
    assert.ok(list.includes('data-a1="s_&quot;&gt;&lt;b&gt;x&lt;/b&gt;"'));
    assert.strictEqual(list.includes('<b>x</b>'), false);
  });

  test('row builders never print NaN, undefined, null or Infinity, whatever the row holds', () => {
    const sb = listSandbox({}, 'SGD');
    const odd = [null, undefined, NaN, Infinity, -Infinity, 0, 5, -5];
    const stockSyms = [{ id:'s1', symbol:'AAA', market:'US', sector:'' }, { id:'s1' }, { id:'s1', symbol:null, market:undefined, sector:undefined }];
    let n = 0;
    stockSyms.forEach(s => odd.forEach(mv => odd.forEach(pl => odd.forEach(pct => [null, NaN, 0, 55.5].forEach(weight => {
      const html = sb._holdingRowHtml(sb._stockListModel({ s, mv, pl, plPct:pct, weight }));
      assert.strictEqual(/NaN|undefined|null|Infinity/.test(html), false, JSON.stringify({ s, mv, pl, pct, weight }) + ' -> ' + html);
      n++;
    })))));
    assert.ok(n > 1000);
    const coinSyms = [{ id:'c1', symbol:'BTC' }, { id:'c1' }];
    coinSyms.forEach(c => odd.forEach(mv => odd.forEach(pl => odd.forEach(pct => [0, 10, NaN, undefined].forEach(tot => {
      const html = sb._holdingRowHtml(sb._cryptoListModel({ c, mv, pl, plPct:pct }, tot));
      assert.strictEqual(/NaN|undefined|null|Infinity/.test(html), false, JSON.stringify({ c, mv, pl, pct, tot }) + ' -> ' + html);
    })))));
    odd.forEach(v => {
      assert.strictEqual(/NaN|undefined|null|Infinity/.test(sb._cashRowHtml(sb._cashListModel({ c:{ id:'a1' }, ccy:'USD', sgd:v, bal:v, apy:v }))), false, 'cash ' + v);
      assert.strictEqual(/NaN|undefined|null|Infinity/.test(sb._cpfRowHtml(sb._cpfRowView({ id:'h1', amount:v }))), false, 'cpf ' + v);
      assert.strictEqual(/NaN|undefined|null|Infinity/.test(sb._cashTxnRowHtml(sb._cashTxnView({ id:'t1', type:'deposit', amount:v }, () => undefined, () => 'SGD'))), false, 'txn ' + v);
    });
    // _finiteNum is the one test: only a real number counts
    assert.deepStrictEqual([0, 1, -1, 2.5, NaN, Infinity, -Infinity, null, undefined, '5', '', {}, []].map(v => sb._finiteNum(v)), [true, true, true, true, false, false, false, false, false, false, false, false, false]);
  });

  test('renderCrypto - the list and the table read the same coins: same order, value, return and share, a coin with no price is dashes in both', () => {
    const sb = listSandbox({ crypto:[
      { id:'c_btc', symbol:'BTC', coingeckoId:'bitcoin', amount:0.25, avgCost:60000, currency:'USD' },
      { id:'c_foo', symbol:'FOO', amount:5, avgCost:10, currency:'USD' },
      { id:'c_eth', symbol:'ETH', coingeckoId:'ethereum', amount:2, avgCost:5000, currency:'USD' }
    ], _priceCache:{ bitcoin:{ sgd:152000, change24h:1.8, fetchedAt:TODAY_ISO }, ethereum:{ sgd:4000, change24h:-0.5, fetchedAt:TODAY_ISO } } });
    const els = renderBox(sb, ['crypto-body', 'crypto-summary', 'freshness-crypto']);
    sb.renderCrypto();
    const html = els['crypto-body'].innerHTML;
    const tableSyms = Array.from(html.matchAll(/<td class="tl cell-sym">([^<]*)</g)).map(m => m[1]);
    const rows = listRowsOf(html);
    assert.deepStrictEqual(tableSyms, ['BTC', 'FOO', 'ETH']);
    assert.deepStrictEqual(rows.map(r => /<b>([^<]*)<\/b>/.exec(r)[1]), tableSyms);
    const coinRows = sb.DB.crypto.map(c => sb._cryptoRow(c));
    coinRows.forEach((r, i) => {
      if (r.mv != null){
        assert.ok(html.includes('<td class="num">' + sb.fmt(r.mv, { dp:0 }) + '</td>'), 'table value ' + i);
        assert.ok(rows[i].includes(sb._moneyHtml(sb.fmt(r.mv, { dp:0 }))), 'list value ' + i);
        assert.ok(html.includes(sb.fmtPct(r.plPct)) && rows[i].includes(sb.fmtPct(r.plPct)), 'return % ' + i);
        assert.ok(html.includes(sb._plArrow(r.pl) + sb.fmt(r.pl, { dp:0, signed:true })) && rows[i].includes(sb.fmt(r.pl, { dp:0, signed:true })), 'return amount ' + i);
      } else {
        assert.ok(rows[i].includes('<span class="dash-hval money-chip">' + DASH + '</span>') && rows[i].includes('<span class="dash-chg">' + DASH + '</span>'));
      }
    });
    // BTC is 152000 x 0.25 = 38000 of 46000
    assert.ok(rows[0].includes('82.6%<span class="hl-of"> of coins</span>'));
    assert.ok(html.includes('class="tbl-wrap hd-only"') && html.includes('<div class="hl" role="group" aria-label="Coins">'));
    // the empty state is the one it was, no list, no table
    sb.DB.crypto = [];
    sb.renderCrypto();
    assert.ok(els['crypto-body'].innerHTML.includes('No coins yet') && !els['crypto-body'].innerHTML.includes('hl-row'));
  });

  test('renderCash - the account list reads the same rows as the table: S$ value, native balance for a foreign account, APY when set, FX missing without a rate', () => {
    const sb = listSandbox({ cash:[
      { id:'a_dbs', name:'DBS Multiplier', account:'Savings', amount:20000, asOf:'2025-12-31', currency:'SGD', apy:1.8 },
      { id:'a_ibkr', name:'IBKR USD', account:'Brokerage', amount:2895, currency:'USD' },
      { id:'a_jpy', name:'Yen jar', account:'Cash', amount:100000, currency:'JPY' },
      { id:'a_neg', name:'Card', account:'Credit', amount:-250.5, currency:'SGD' }
    ], cashTxns:[], stockTxns:[] });
    const els = renderBox(sb, ['cash-body', 'cash-summary', 'freshness-fx', 'cash-ledger']);
    sb.renderCash();
    const html = els['cash-body'].innerHTML;
    const rows = listRowsOf(html);
    assert.strictEqual(rows.length, 4);
    const tableNames = Array.from(html.matchAll(/class="name-clamp-inner">([^<]*)</g)).map(m => m[1]);
    assert.deepStrictEqual(rows.map(r => /<span class="hl-t">([^<]*)</.exec(r)[1]), tableNames);
    // the S$ value is the table's, to the cent
    assert.ok(html.includes('<td class="num ">S$20,000.00</td>') && rows[0].includes('S$20,000.00'));
    assert.ok(rows[0].includes('<span class="hl-s">Savings · SGD · 1.80% APY</span>'));
    assert.strictEqual(rows[0].includes('dash-sub'), false);                     // a Singapore account has no native line
    assert.ok(html.includes('S$3,618.75') && rows[1].includes('S$3,618.75'));      // 2895 x 1.25
    assert.ok(rows[1].includes('<span class="dash-sub money-chip">USD 2,895</span>') && rows[1].includes('Brokerage · USD'));
    assert.ok(html.includes('— FX missing') && rows[2].includes('<span class="price-stale">' + DASH + ' FX missing</span>') && rows[2].includes('JPY 100,000'));
    // an overdrawn account shows its minus and the loss class
    assert.ok(html.includes('<td class="num neg">-S$250.50</td>') && rows[3].includes('class="hl-amt money-chip down">-S$250.50<'));
    // the row edits the account, as the table's Edit button does
    assert.ok(rows[0].includes('data-edit-table="cash" data-edit-id="a_dbs"') && rows[0].includes('aria-label="Edit DBS Multiplier, Savings · SGD · 1.80% APY, balance S$20,000.00"'));
    assert.ok(html.includes('class="tbl-wrap hd-only"') && html.includes('<div class="hl hl-2" role="group" aria-label="Cash accounts">'));
  });

  test('renderCashTxns - the movements list reads the same view as the ledger table: date, account and type over the note, a signed amount, a transfer keeps both legs', () => {
    const sb = listSandbox({ cash:[
      { id:'a_sgd', name:'DBS', currency:'SGD' }, { id:'a_usd', name:'IBKR USD', currency:'USD' }
    ], cashTxns:[
      { id:'t1', type:'deposit', cashAccountId:'a_sgd', date:'2026-09-30', amount:3200, notes:'Salary' },
      { id:'t2', type:'withdrawal', cashAccountId:'a_sgd', date:'2026-09-15', amount:120.5, notes:'' },
      { id:'t3', type:'transfer', fromAccountId:'a_sgd', cashAccountId:'a_usd', date:'2026-09-10', amount:2700, amountIn:2000, notes:'Top up' },
      { id:'t4', type:'transfer', fromAccountId:'a_sgd', cashAccountId:'a_sgd', date:'2026-09-09', amount:50, notes:'' },
      { id:'t5', type:'deposit', cashAccountId:'a_sgd', date:'2026-09-01', amount:1, notes:'<b>x</b> "q" & co' }
    ], stockTxns:[] });
    const els = renderBox(sb, ['cash-ledger']);
    sb.renderCashTxns();
    const html = els['cash-ledger'].innerHTML;
    const rows = listRowsOf(html);
    assert.strictEqual(rows.length, 5);
    const tableDates = Array.from(html.matchAll(/<tr>\s*<td class="tl">([^<]*)</g)).map(m => m[1]);
    assert.deepStrictEqual(tableDates, ['30/09/2026', '15/09/2026', '10/09/2026', '09/09/2026', '01/09/2026']);
    rows.forEach((r, i) => assert.ok(r.includes(tableDates[i]), 'date in row ' + i));
    // deposit and withdrawal: the signed S$ effect, arrow and sign, gain and loss class
    assert.ok(html.includes('<td class="num pos">+S$3,200.00</td>') && rows[0].includes('class="hl-amt money-chip up">▲ +S$3,200.00<'));
    assert.ok(html.includes('<td class="num neg">-S$120.50</td>') && rows[1].includes('class="hl-amt money-chip down">▼ -S$120.50<'));
    assert.ok(rows[0].includes('<span class="hl-t">DBS <span class="hl-k">· Deposit</span></span><span class="hl-s">30/09/2026 · Salary</span>'));
    // a cross-currency transfer shows both legs, native, in the table and as two lines in the list
    assert.ok(html.includes('<td class="num">S$2,700.00 → US$2,000.00</td>'));
    assert.ok(rows[2].includes('class="hl-amt money-chip">S$2,700.00<') && rows[2].includes('<span class="dash-sub money-chip">→ US$2,000.00</span>'));
    assert.ok(rows[2].includes('DBS → IBKR USD <span class="hl-k">· Transfer</span>'));
    // a same-currency transfer is one amount
    assert.ok(html.includes('<td class="num">S$50.00</td>') && rows[3].includes('S$50.00') && !rows[3].includes('→ S$'));
    // notes are escaped
    assert.ok(rows[4].includes('&lt;b&gt;x&lt;/b&gt; &quot;q&quot; &amp; co'));
    assert.strictEqual(/<b>x<\/b>/.test(rows[4]), false);
    assert.ok(rows[0].includes('data-edit-table="cashTxns" data-edit-id="t1"') && html.includes('class="tbl-wrap hd-only"'));
    // the table rows are exactly what they were: one Edit button per row, the same column order
    assert.strictEqual((html.match(/class="btn btn-sm btn-ghost btn-edit" data-edit-table="cashTxns"/g) || []).length, 5);
    assert.ok(html.includes('<th class="tl">Date</th><th class="tl">Account</th><th class="tl">Type</th><th>Amount</th><th class="tl">Notes</th>'));
    // no movements: the empty state, no list
    sb.DB.cashTxns = [];
    sb.renderCashTxns();
    assert.ok(els['cash-ledger'].innerHTML.includes('No cash movements') && !els['cash-ledger'].innerHTML.includes('hl-row'));
  });

  test('_cashTxnView - one definition of a movement for the table and the list, an unknown account is blank not "undefined", an unconvertible currency code is escaped', () => {
    const sb = listSandbox({ cash:[] });
    const nameOf = id => ({ a:'Alpha', b:'<i>Beta</i>' })[id];
    const ccyOf = id => ({ a:'SGD', b:'<b>XXX' })[id] || 'SGD';
    const t = sb._cashTxnView({ id:'t', type:'transfer', fromAccountId:'a', cashAccountId:'b', amount:10, amountIn:20, date:'2026-01-02' }, nameOf, ccyOf);
    assert.strictEqual(t.title, 'Alpha → <i>Beta</i>');                            // raw, escaped at the point of printing
    assert.strictEqual(/<b>XXX/.test(t.amtTxt), false);                               // fmt() prints a code it can not format as typed, so the view escapes it
    assert.ok(t.amtTxt.includes('&lt;b&gt;XXX 20.00'));
    const lost = sb._cashTxnView({ id:'t', type:'deposit', cashAccountId:'zzz', amount:5, date:'2026-01-02' }, nameOf, ccyOf);
    assert.strictEqual(lost.title, '');
    assert.strictEqual(lost.kind, 'Deposit');
    assert.strictEqual(sb._cashTxnView({ id:'t', type:'mystery', cashAccountId:'a', amount:5 }, nameOf, ccyOf).kind, 'mystery');
    assert.strictEqual(sb._cashTxnView({ id:'t', type:'withdrawal', cashAccountId:'a', amount:5 }, nameOf, ccyOf).cls, 'neg');
  });

  test('renderCpf - the history list reads the same filtered entries as the table, and the phone chips mirror the three selects that hold the filter', () => {
    const sb = listSandbox({ cpfBalances:{ OA:1000, SA:500, MA:300, RA:0, anchorDate:'2025-01-01' }, cpfHistory:[
      { id:'h1', date:'2026-09-30', type:'contribution', account:'OA', amount:1840.23, source:'Acme', notes:'Sep' },
      { id:'h2', date:'2026-09-30', type:'contribution', account:'SA', amount:479.82, source:'Acme', notes:'' },
      { id:'h3', date:'2025-12-31', type:'interest', account:'OA', amount:123.45, source:'CPF Board', notes:'Year-end' },
      { id:'h4', date:'2025-06-15', type:'withdrawal', account:'MA', amount:-500, source:'', notes:'' }
    ] });
    sb.DB.settings.cpfRates = { OA:2.5, SA:4, MA:4, RA:4 };
    const els = renderBox(sb, ['cpf-balances', 'cpf-history-body', 'cpf-balances-meta', 'cpf-filter-year', 'cpf-filter-type', 'cpf-filter-account', 'cpf-chips', 'cpfm-filter-year', 'cpfm-filter-type', 'cpfm-filter-account', 'cpfm-clear']);
    sb.loadCpfBalancesForm = () => {};
    const run = () => { sb.renderCpf(); return els['cpf-history-body'].innerHTML; };
    const tableDates = html => Array.from(html.matchAll(/<tr>\s*<td class="tl">([^<]*)</g)).map(m => m[1]);
    const listDates = html => listRowsOf(html).map(r => /<span class="hl-s">(\d\d\/\d\d\/\d{4})/.exec(r)[1]);
    let html = run();
    assert.deepStrictEqual(tableDates(html), ['30/09/2026', '30/09/2026', '31/12/2025', '15/06/2025']);
    assert.deepStrictEqual(listDates(html), tableDates(html));
    assert.ok(html.includes('<td class="num pos">+S$1,840.23</td>') && listRowsOf(html)[0].includes('▲ +S$1,840.23'));
    assert.ok(html.includes('<td class="num neg">-S$500.00</td>') && listRowsOf(html)[3].includes('▼ -S$500.00'));
    assert.ok(listRowsOf(html)[0].includes('<span class="hl-t">OA <span class="hl-k">· Contribution</span></span><span class="hl-s">30/09/2026 · Acme · Sep</span>'));
    assert.ok(listRowsOf(html)[0].includes('data-edit-table="cpfHistory" data-edit-id="h1"'));
    // chips start on All, no Clear, the row visible because there is history
    assert.strictEqual(els['cpfm-filter-year'].value, '');
    assert.strictEqual(els['cpfm-clear'].hidden, true);
    assert.strictEqual(els['cpf-chips'].hidden, false);
    assert.ok(els['cpfm-filter-year'].innerHTML.includes('<option value="2026">2026</option><option value="2025">2025</option>'));
    // a filter set on the desktop select reaches the chips, the list and the table together
    els['cpf-filter-year'].value = '2025'; els['cpf-filter-type'].value = 'interest';
    html = run();
    assert.deepStrictEqual(tableDates(html), ['31/12/2025']);
    assert.deepStrictEqual(listDates(html), ['31/12/2025']);
    assert.strictEqual(els['cpfm-filter-year'].value, '2025'); assert.strictEqual(els['cpfm-filter-type'].value, 'interest'); assert.strictEqual(els['cpfm-filter-account'].value, '');
    assert.strictEqual(els['cpfm-filter-year'].classList.contains('is-on'), true);
    assert.strictEqual(els['cpfm-filter-account'].classList.contains('is-on'), false);
    assert.strictEqual(els['cpfm-clear'].hidden, false);
    // a chip writes its twin and repaints, Clear empties all three
    els['cpfm-filter-account'] = Object.assign(els['cpfm-filter-account'], { value:'OA' });
    assert.strictEqual(sb.cpfChipFilter(els['cpfm-filter-account']), true);
    assert.strictEqual(els['cpf-filter-account'].value, 'OA');
    assert.deepStrictEqual(tableDates(els['cpf-history-body'].innerHTML), ['31/12/2025']);
    sb.cpfClearFilters();
    assert.deepStrictEqual(['cpf-filter-year', 'cpf-filter-type', 'cpf-filter-account'].map(id => els[id].value), ['', '', '']);
    assert.strictEqual(tableDates(els['cpf-history-body'].innerHTML).length, 4);
    assert.strictEqual(els['cpfm-clear'].hidden, true);
    // a chip that is not one of ours, or whose twin is missing, does nothing
    assert.strictEqual(sb.cpfChipFilter({ id:'evil', value:'x' }), false);
    assert.strictEqual(sb.cpfChipFilter(null), false);
    assert.strictEqual(sb.cpfChipFilter({ id:'cpfm-filter-ghost', value:'x' }), false);
    // no history at all: the empty state and no chip row
    sb.DB.cpfHistory = [];
    html = run();
    assert.ok(html.includes('No history yet') && listRowsOf(html).length === 0);
    assert.strictEqual(els['cpf-chips'].hidden, true);
  });

  test('renderCpf - hostile account, source and note text is escaped in the list and the table', () => {
    const sb = listSandbox({ cpfBalances:{ OA:0, SA:0, MA:0, RA:0 }, cpfHistory:[
      { id:'h1', date:'2026-01-02', type:'<b>t</b>', account:'<img src=x onerror=window.__x=1>', amount:-1, source:'<script>1</script>', notes:'"quote" & more' }
    ] });
    sb.DB.settings.cpfRates = { OA:2.5, SA:4, MA:4, RA:4 };
    const els = renderBox(sb, ['cpf-balances', 'cpf-history-body', 'cpf-balances-meta', 'cpf-filter-year', 'cpf-filter-type', 'cpf-filter-account', 'cpf-chips', 'cpfm-filter-year', 'cpfm-filter-type', 'cpfm-filter-account', 'cpfm-clear']);
    sb.loadCpfBalancesForm = () => {};
    sb.renderCpf();
    const html = els['cpf-history-body'].innerHTML;
    assert.strictEqual(/<img|<script|<b>t/i.test(html), false);
    assert.ok(html.includes('&lt;img src=x onerror=window.__x=1&gt;') && html.includes('&lt;script&gt;1&lt;/script&gt;') && html.includes('&quot;quote&quot; &amp; more'));
    assert.strictEqual(/aria-label="[^"]*"[^>]*aria-label=/.test(listRowsOf(html)[0]), false);
  });

  test('moreMenuPick - runs only a whitelisted action, closes the menu first so focus is back on More, and ignores anything else', () => {
    const sb = freshSandbox();
    const calls = [];
    sb.closeShellMenus = back => calls.push('close:' + back);
    sb.exportHoldingsCSV = () => calls.push('export holdings');
    sb.refreshStockPrices = () => calls.push('refresh stocks');
    sb.refreshCryptoPrices = () => calls.push('refresh crypto');
    sb.exportCryptoCSV = () => calls.push('export crypto');
    sb.refreshFx = () => calls.push('refresh fx');
    ['exportHoldingsCSV', 'refreshStockPrices', 'refreshCryptoPrices', 'exportCryptoCSV', 'refreshFx'].forEach(name => sb.moreMenuPick(name));
    assert.deepStrictEqual(calls, ['close:true', 'export holdings', 'close:true', 'refresh stocks', 'close:true', 'refresh crypto', 'close:true', 'export crypto', 'close:true', 'refresh fx']);
    calls.length = 0;
    ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'openEntity', 'exportBackup', '', null, undefined, 42].forEach(name => sb.moreMenuPick(name));
    assert.deepStrictEqual(calls, Array(10).fill('close:true'));                  // the menu still closes, nothing runs
    assert.deepStrictEqual(Object.keys(vm.runInContext('MORE_MENU_ACTIONS', sb)).sort(), ['exportCryptoCSV', 'exportHoldingsCSV', 'refreshCryptoPrices', 'refreshFx', 'refreshStockPrices']);
  });

  test('More menus - Stocks builds one, Crypto and Cash carry the same markup in index.html, every item is a whitelisted action and every menu is registered with the shell menu code', () => {
    const sb = realEscape(freshSandbox());
    const built = sb._moreMenuHtml('stocks', [{ label:'Export CSV', action:'exportHoldingsCSV' }, { label:'Refresh <prices>', action:'refreshStockPrices' }]);
    assert.ok(built.startsWith('<div class="menu-wrap"><button type="button" class="btn m-act" id="more-btn-stocks" data-menu-btn="more-stocks" data-click="toggleShellMenu" data-a0="more-stocks" aria-haspopup="menu" aria-expanded="false" aria-controls="more-menu-stocks" aria-label="More actions"><span aria-hidden="true">⋯</span> More</button>'));
    assert.ok(built.includes('<div class="shell-menu more-menu" id="more-menu-stocks" role="menu" aria-label="More actions" hidden>'));
    assert.ok(built.includes('role="menuitem" tabindex="-1" data-click="moreMenuPick" data-a0="exportHoldingsCSV"><span>Export CSV</span>'));
    assert.ok(built.includes('<span>Refresh &lt;prices&gt;</span>'));
    // the registry the open, close and Escape code reads
    const menus = navPlain(vm.runInContext('SHELL_MENUS', sb));
    assert.deepStrictEqual(menus['more-stocks'], ['more-btn-stocks', 'more-menu-stocks']);
    assert.deepStrictEqual(menus['more-crypto'], ['more-btn-crypto', 'more-menu-crypto']);
    assert.deepStrictEqual(menus['more-cash'], ['more-btn-cash', 'more-menu-cash']);
    assert.deepStrictEqual(menus.ws, ['ws-btn', 'ws-menu']); assert.deepStrictEqual(menus.add, ['add-btn', 'add-menu']);
    // the static ones: ids, roles, a hidden menu, and items that name an action the whitelist holds
    const allowed = Object.keys(vm.runInContext('MORE_MENU_ACTIONS', sb));
    const expected = { crypto:['refreshCryptoPrices', 'exportCryptoCSV'], cash:['refreshFx'] };
    Object.keys(expected).forEach(page => {
      const menu = new RegExp('<div class="shell-menu more-menu" id="more-menu-' + page + '" role="menu" aria-label="More actions" hidden>([\\s\\S]*?)</div>').exec(indexSrc);
      assert.ok(menu, page + ' menu');
      assert.deepStrictEqual(Array.from(menu[1].matchAll(/data-click="moreMenuPick" data-a0="([A-Za-z]+)"/g)).map(m => m[1]), expected[page]);
      expected[page].forEach(a => assert.ok(allowed.includes(a), a));
      assert.ok(indexSrc.includes('id="more-btn-' + page + '" data-menu-btn="more-' + page + '" data-click="toggleShellMenu" data-a0="more-' + page + '" aria-haspopup="menu" aria-expanded="false" aria-controls="more-menu-' + page + '" aria-label="More actions"'));
    });
    // the desktop buttons are still there, marked as the part the phone hides, with their ids and handlers
    ['<button class="btn hd-only" data-click="refreshCryptoPrices" id="btn-refresh-crypto">↻ Refresh prices</button>', '<button class="btn btn-sm hd-only" data-click="exportCryptoCSV">Export CSV</button>',
      '<button class="btn hd-only" data-click="refreshFx" id="btn-refresh-fx">↻ Refresh FX</button>'].forEach(frag => assert.ok(indexSrc.includes(frag), frag));
    // the Add buttons keep their full label for screen readers and desktop, and read "+ Add" on the phone
    ['coin', 'account', 'entry'].forEach(w => assert.ok(indexSrc.includes('<span>＋ Add<span class="add-sfx"> ' + w + '</span></span>'), w));
    // the menu code is the shared one: the keyboard model is registered once and covers every menu
    assert.ok(extractFunction('closeShellMenus').includes('Object.keys(SHELL_MENUS).forEach'));
  });

  test('Sort chip - it writes the state the sortable headers write, validates the key and the direction, saves and repaints once, and shows a desktop-set sort it has no choice for', () => {
    const sb = realEscape(freshSandbox({ settings:{ stocksSort:{ key:null, dir:null } } }));
    const calls = [];
    sb.saveData = () => { calls.push('save'); return true; };
    sb.renderStocks = () => calls.push('render');
    vm.runInContext('var _stocksPage = 3;', sb);
    assert.strictEqual(sb.stocksSortPick('mv:desc'), true);
    assert.deepStrictEqual(navPlain(sb.DB.settings.stocksSort), { key:'mv', dir:'desc' });
    assert.deepStrictEqual(calls, ['save', 'render']);
    assert.strictEqual(vm.runInContext('_stocksPage', sb), 0);
    calls.length = 0;
    assert.strictEqual(sb.stocksSortPick('mv:desc'), false);                       // no change, no save
    assert.deepStrictEqual(calls, []);
    assert.strictEqual(sb.stocksSortPick('plPct:asc'), true);
    assert.deepStrictEqual(navPlain(sb.DB.settings.stocksSort), { key:'plPct', dir:'asc' });
    calls.length = 0;
    // anything else clears: the empty choice, an unknown key, a bad direction, an inherited name
    ['', 'nonsense:asc', 'mv', 'mv:sideways', 'constructor:asc', '__proto__:desc', ':asc'].forEach(v => {
      sb.DB.settings.stocksSort = { key:'mv', dir:'desc' };
      assert.strictEqual(sb.stocksSortPick(v), true, v);
      assert.deepStrictEqual(navPlain(sb.DB.settings.stocksSort), { key:null, dir:null }, v);
    });
    assert.strictEqual(sb.stocksSortPick(undefined), false);                       // already clear
    // every choice on the chip is a key the table sorts by, in a direction it understands
    const chips = navPlain(vm.runInContext('STOCK_SORT_CHIPS', sb));
    const sortKeys = Object.keys(navPlain(Object.fromEntries(Object.keys(vm.runInContext('STOCK_SORT_VALS', sb)).map(k => [k, 1]))));
    chips.forEach(([value]) => { if (value) { const [k, d] = value.split(':'); assert.ok(sortKeys.includes(k) && (d === 'asc' || d === 'desc'), value); } });
    assert.strictEqual(chips[0][0], '');
    assert.strictEqual(new Set(chips.map(c => c[0])).size, chips.length);
    // the options: the current choice selected, a sort the chip has no choice for gets its own, named from the column
    const opts = pref => sb._stockSortChipOptions(pref);
    assert.strictEqual(opts({ key:null, dir:null }).cur, '');
    assert.ok(opts({ key:null, dir:null }).html.includes('<option value="" selected>Sort: Default</option>'));
    assert.ok(opts({ key:'mv', dir:'desc' }).html.includes('<option value="mv:desc" selected>Sort: Value, high to low</option>'));
    const odd = opts({ key:'volume', dir:'asc' });
    assert.strictEqual(odd.cur, 'volume:asc');
    assert.ok(odd.html.includes('<option value="volume:asc" selected>Sort: Volume, ascending</option>'));
    assert.strictEqual((odd.html.match(/selected/g) || []).length, 1);
    assert.strictEqual(opts({ key:'constructor', dir:'asc' }).cur, '');
    assert.strictEqual(opts({ key:'mv', dir:'sideways' }).cur, '');
    assert.strictEqual(opts(undefined).cur, '');
    assert.ok(opts({ key:'mv', dir:'desc' }).html.includes('Sort: P&amp;L, high to low'));          // escaped on the way out
  });

  test('chip focus - a repaint keeps the chip in use focused and the row where it was scrolled, and only for our own controls', () => {
    const sb = freshSandbox();
    const focused = [];
    const row = { scrollLeft:120, getBoundingClientRect: () => ({ left:0, right:300 }) };
    const mk = id => ({ id, focus: opts => focused.push([id, opts && opts.preventScroll]), getBoundingClientRect: () => ({ left:310, right:420 }) });
    const host = { querySelector: sel => (sel === '.chip-row' ? row : null), contains: el => el.inHost === true };
    const sort = Object.assign(mk('sfm-sort'), { inHost:true });
    sb.document = { activeElement:sort, getElementById: id => (id === 'sfm-sort' ? sort : null) };
    assert.deepStrictEqual(navPlain(sb._chipKeep(host)), { id:'sfm-sort', left:120 });
    row.scrollLeft = 0;
    sb._chipRestore(host, { id:'sfm-sort', left:120 });
    assert.deepStrictEqual(focused, [['sfm-sort', true]]);
    assert.strictEqual(row.scrollLeft, 120 + (420 - 300) + 18);                     // nudged back inside, sideways only
    // More keeps focus too, anything else does not
    sb.document.activeElement = Object.assign(mk('more-btn-stocks'), { inHost:true });
    assert.strictEqual(sb._chipKeep(host).id, 'more-btn-stocks');
    sb.document.activeElement = Object.assign(mk('sf-market'), { inHost:true });
    assert.strictEqual(sb._chipKeep(host).id, '');
    sb.document.activeElement = Object.assign(mk('sfm-market'), { inHost:false });   // focus outside this body
    assert.strictEqual(sb._chipKeep(host).id, '');
    sb.document.activeElement = null;
    assert.deepStrictEqual(navPlain(sb._chipKeep(host)), { id:'', left:120 + 138 });
    // nothing to restore: a missing element or no chip row never throws
    sb._chipRestore({ querySelector: () => null }, { id:'sfm-gone', left:0 });
    sb._chipRestore(host, { id:'', left:0 });
    assert.ok(extractFunction('renderStocks').includes('const keepUi = _chipKeep(bodyEl);') && extractFunction('renderStocks').includes('_chipRestore(bodyEl, keepUi);'));
  });

  test('mobile list markup - the table stays in the page marked hd-only, the list and chips sit beside it, and there are no inline handlers', () => {
    // every table the list replaces is wrapped as the part the phone hides
    const hidden = (appSrc.match(/<div class="tbl-wrap hd-only">/g) || []).length;
    assert.strictEqual(hidden, 5);                                                 // Stocks, Crypto, Cash accounts, Cash movements, CPF history
    ['renderStocks', 'renderCrypto', 'renderCash', 'renderCashTxns', 'renderCpf'].forEach(fn => {
      const src = extractFunction(fn);
      assert.ok(src.includes('tbl-wrap hd-only'), fn);
      assert.ok(/_holdingsListHtml|_cashListHtml|class="hl hl-2"/.test(src), fn + ' builds the list');
      assert.strictEqual(/\son[a-z]+="/i.test(src.replace(/\bon[A-Z]\w+\s*=/g, '')), false, fn + ' has an inline handler');
    });
    // the renderers keep the calls the older tests and the CSV export depend on
    assert.ok(extractFunction('renderCrypto').includes('_cryptoRow(c)'));
    assert.ok(extractFunction('renderStocks').includes('buildStockChartRows()') && extractFunction('renderStocks').includes('_lastStockRows = filteredRows;'));
    // the new static markup (Crypto, Cash, CPF heads and the CPF chips) has no inline handler either
    const pages = indexSrc.slice(indexSrc.indexOf('<section class="page" id="page-crypto">'), indexSrc.indexOf('<section class="page" id="page-cashflow">'));
    assert.strictEqual(/\son[a-z]+="/i.test(pages), false);
    ['id="cpf-chips" role="group" aria-label="Filter transaction history" hidden', 'id="cpfm-filter-year" data-change="cpfChipFilter" aria-label="Filter by year"',
      'id="cpfm-filter-type" data-change="cpfChipFilter" aria-label="Filter by transaction type"', 'id="cpfm-filter-account" data-change="cpfChipFilter" aria-label="Filter by CPF account"',
      'id="cpfm-clear" data-click="cpfClearFilters" hidden>Clear</button>', '<div class="cpf-tools">'].forEach(frag => assert.ok(pages.includes(frag), frag));
    // the three desktop CPF selects still hold the filter state, with the labels and handlers they had
    ['id="cpf-filter-year"', 'id="cpf-filter-type"', 'id="cpf-filter-account"'].forEach(frag => assert.ok(pages.includes(frag), frag));
    assert.strictEqual((pages.match(/data-change="renderCpf"/g) || []).length, 3);
    // the delegated actions
    const actions = extractFunction('installEventDelegation');
    ['stocksSortPick:      (el) => stocksSortPick(el.value),', 'cpfChipFilter:       (el) => cpfChipFilter(el),', 'cpfClearFilters:     () => cpfClearFilters(),', 'moreMenuPick:        (el) => moreMenuPick(A(el)[0]),']
      .forEach(frag => assert.ok(actions.includes(frag), frag));
  });

  test('mobile list styles - one 640px block that hides the desktop pieces, builds the chip row and the list grid, and fixes the 320px sector card', () => {
    const start = indexSrc.indexOf('/* MOBILE LIST ROWS, CHIP FILTERS AND ACTIONS (v2.73)');
    assert.ok(start > -1);
    const css = indexSrc.slice(start, indexSrc.indexOf('</style>', start));
    // above 640px the phone pieces are off and the desktop controls keep the layout they had as inline styles
    assert.ok(css.includes('.hd-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}'));
    assert.ok(css.includes('.cpf-tools{display:flex;gap:6px;align-items:center;flex-wrap:wrap}'));
    assert.ok(css.includes('.m-actions,.m-more,.chip-row,.hl,.m-fresh{display:none}'));
    assert.ok(css.includes('@media (max-width:640px){'));
    const phone = css.slice(css.indexOf('@media (max-width:640px){'));
    assert.ok(phone.includes('.hd-only,.hd-actions,.cpf-tools{display:none}'));
    // the sector card no longer overflows at 320px
    assert.ok(phone.includes('.sum-row .alloc-card{flex:1 1 100%;min-width:0;max-width:none}'));
    // the chip row scrolls inside itself with no visible scrollbar, chips are 44px, 16px text so iOS does not zoom on focus
    const row = /\.chip-row\{([^}]*)\}/.exec(phone)[1];
    assert.ok(row.includes('overflow-x:auto') && row.includes('scrollbar-width:none'));
    assert.ok(phone.includes('.chip-row::-webkit-scrollbar{display:none}'));
    const chip = /\.chip-sel,\.chip-btn\{([^}]*)\}/.exec(phone)[1];
    assert.ok(chip.includes('min-height:44px') && chip.includes('font-size:16px') && chip.includes('border-radius:999px'));
    assert.ok(/\.chip-sel\.is-on\{[^}]*color:var\(--accent\)/.test(phone));
    assert.ok(phone.includes('.chip-row[hidden],.chip-btn[hidden]{display:none}'));
    // the list is a grid with subgrid rows (the value and return columns line up), a plain-grid fallback, 56px rows
    assert.ok(phone.includes('.hl{display:grid;grid-template-columns:minmax(0,1fr) auto auto;'));
    assert.ok(phone.includes('@supports (grid-template-columns:subgrid){.hl > *{grid-template-columns:subgrid}}'));
    assert.ok(phone.includes('.hl-row{min-height:56px;padding:8px}'));
    // the share loses its words at 360px and below, the table's own rules stay where they were
    const narrow = css.slice(css.indexOf('@media (max-width:360px){\n  .hl-of{display:none}'));
    assert.ok(narrow.includes('@media (max-width:360px){\n  .hl-of{display:none}'));
    assert.ok(narrow.includes('#page-crypto .h-toolbar .freshness,#page-cash .h-toolbar .freshness{order:3;flex:0 0 100%;justify-content:center}'));
    assert.ok(indexSrc.includes('table.holdings td.name-clamp{min-width:150px;max-width:180px}') && indexSrc.includes('.sum-row .alloc-card{flex-shrink:0;min-width:220px;max-width:320px;margin-bottom:0}'));
    // tokens only: no raw colour anywhere in the new block
    assert.strictEqual(/#[0-9a-fA-F]{3,8}\b|rgba?\(/.test(css), false);
    // the block is last in the stylesheet, so its equal-specificity rules win
    assert.strictEqual(indexSrc.slice(start).includes('\n.btn{'), false);
  });

  test('mobile list contrast - the dim row text, the accent chip and the hover colour clear 4.5:1 in both themes', () => {
    const block = s => { const i = indexSrc.indexOf(s); assert.ok(i > -1, s); return indexSrc.slice(i, indexSrc.indexOf('\n}', i)); };
    const light = block(':root{'), dark = block('html.dark{');
    const token = (blk, name) => {
      const m = new RegExp('--' + name + ':([^;]+);').exec(blk);
      assert.ok(m, '--' + name + ' missing');
      const ref = /^var\(--([a-z0-9-]+)\)$/.exec(m[1].trim());
      return ref ? token(blk, ref[1]) : m[1].trim();
    };
    const rgb = h => { h = h.replace('#', ''); return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)); };
    const lin = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    const lum = c => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
    const ratio = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
    const over = (top, alpha, bottom) => top.map((v, i) => v * alpha + bottom[i] * (1 - alpha));
    [['light', light], ['dark', dark]].forEach(([name, blk]) => {
      const bg2 = rgb(token(blk, 'bg2')), bg3 = rgb(token(blk, 'bg3')), t2 = rgb(token(blk, 'text2')), t3 = rgb(token(blk, 'text3')), text = rgb(token(blk, 'text'));
      const accent = rgb(token(blk, 'accent'));
      const soft = token(blk, 'accent-soft');
      // the dim text of a row (--text3) on the card, and --text2 on the hover tint that replaces it
      assert.ok(ratio(t3, bg2) >= 4.5, name + ' --text3 on --bg2 ' + ratio(t3, bg2).toFixed(2));
      assert.ok(ratio(t2, bg3) >= 4.5, name + ' --text2 on --bg3 (hover) ' + ratio(t2, bg3).toFixed(2));
      assert.ok(ratio(text, bg3) >= 4.5, name + ' --text on a chip (--bg3) ' + ratio(text, bg3).toFixed(2));
      assert.ok(ratio(accent, rgb(soft)) >= 4.5, name + ' --accent on --accent-soft ' + ratio(accent, rgb(soft)).toFixed(2));
      ['gain', 'loss'].forEach(t => assert.ok(ratio(rgb(token(blk, t)), bg2) >= 4.5, name + ' --' + t + ' on --bg2 ' + ratio(rgb(token(blk, t)), bg2).toFixed(2)));
      ['stocks', 'crypto'].forEach(c => {
        const ink = rgb(token(blk, 'c-' + c + '-ink'));
        const tint = over(rgb(token(blk, 'c-' + c)), 0.16, bg2);
        assert.ok(ratio(ink, tint) >= 4.5, name + ' --c-' + c + '-ink monogram letter on its tint ' + ratio(ink, tint).toFixed(2));
      });
    });
    // the hover rule really moves the dim text up a step
    assert.ok(indexSrc.includes('@media (hover:hover){.hl-row:hover .dash-sub,.hl-row:hover .dash-who-t span,.hl-row:hover .hl-s,.hl-row:hover .price-stale{color:var(--text2)}}'));
  });

  test('v2.73 release strings - the display version, the cache name and every script tag agree', () => {
    assert.strictEqual(vm.runInContext('APP_VERSION', freshSandbox()), 'v2.73');
    assert.strictEqual(vm.runInContext('APP_DISPLAY_VERSION', freshSandbox()), 'v2.73 (09 Oct)');
    const sw = fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8');
    assert.ok(sw.includes("const CACHE_NAME = 'kjr-portfolio-v2.73';"));
    assert.strictEqual((indexSrc.match(/\.js\?v=2\.73"/g) || []).length, 7);
    assert.strictEqual((sw.match(/\.js\?v=2\.73'/g) || []).length, 7);
    assert.strictEqual(/\?v=2\.72/.test(indexSrc + sw), false);
  });

  console.log(`\nTests completed: ${passed} passed, ${failed} failed.`);
  if (failed > 0) process.exit(1);
}

runTests().catch(err => {
  console.error(err);
  process.exit(1);
});
