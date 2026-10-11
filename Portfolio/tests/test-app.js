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
  // The body opens at the first brace after the parameter list, so a default value that holds a brace (opts = {}) belongs to the signature.
  let p = m.index + m[0].length, parens = 1;
  for (; p < source.length && parens > 0; p++){
    const c = source[p];
    if (c === '(') parens++;
    else if (c === ')') parens--;
    else if (c === '\'' || c === '"' || c === '`'){ for (p++; p < source.length && source[p] !== c; p++){ if (source[p] === '\\') p++; } }
  }
  let i = source.indexOf('{', p);
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
  'pbPersistSaved', 'pbSaveChart', 'pbTogglePin', 'pbDeleteSaved', '_pbDeletedText', '_pbOrderWith', '_pbUndoSlot', '_pbRestoreFor', '_pbDestroyChart',
  '_salaryPayMonths', 'generateAutoSalaryEntries', 'generateAutoSalaryCashEntries', 'generateAutoCpfEntries',
  'deriveStockPosition', '_cpfAnchorDate', 'cpfEffectiveBalances',
  'annualIncomeSGD', 'annualExpensesSGD', 'derivedMonthlySavingsSGD', 'fireNumberSGD',
  'expenseAmountSgdOrNull', 'renderProjections', 'autoRefreshTick', 'refreshCryptoPrices', 'ibkrConfirmImport', 'disableVaultProtection',
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
  // Stocks page ledgers on the phone (v2.76): the Watchlist, Upcoming dividends and Trade history views and rows, and the three real renderers
  '_wlListModel', '_wlLabel', '_wlRowHtml', '_dividendView', '_dividendRowHtml', '_stockTxnView', '_stockTxnRowHtml', '_stockPositionView', '_stockPositionRowHtml', '_stockGroupHtml',
  'renderWatchlist', 'renderDividendTimeline', 'renderStockTxns',
  'moreMenuPick', '_moreMenuHtml', '_chipSelectHtml', '_stockSortChipOptions', 'setStockSortTo', 'stocksSortPick',
  '_chipKeep', '_chipRestore', 'cpfChipFilter', 'cpfClearFilters', '_syncCpfChips',
  'fmtSgdOrNative', '_nativeMoneyText', 'fmtPct', '_plArrow', '_moneyHtml', 'fmtDateSG', '_parseDateOnlyLocal', 'cpfTypeLabel',
  'buildStockChartRows', 'renderStocks', 'renderCrypto', 'renderCash', 'renderCashTxns', 'renderCpf',
  'fxMissingFor', 'projectedMonthlyInterest', 'hasCashActivity',
  // Holding side panel and command palette (Step 8a): the model and markup builders, the open, close and repaint of the panel, the history start, the
  // palette's model, matching and markup, its keys and shortcut, and the dashboard Holdings card that now opens the panel
  '_hpMoney', '_hpDp', '_hpQty', '_hpShare', '_hpShareText', '_hpNetWorth', '_hpDay', '_hpTrades', '_hpStockModel', '_hpCryptoModel', '_holdingPanelModel',
  '_hpSeries', '_hpCcySym', '_hpAxisDp', '_hpScale', '_hpAxisLabel', '_hpAmountHtml', '_hpHeadHtml', '_hpPriceHtml', '_hpSeriesHtml', '_hpChartHtml', '_hpStatHtml',
  '_hpTradeHtml', '_hpTradesHtml', '_hpFootHtml', '_holdingPanelHtml', '_hpRender', '_hpStartHistory', 'openHoldingPanel', '_hpRestoreFocus', 'closeHoldingPanel',
  'refreshHoldingPanel', 'holdingPanelAction', '_emptyIcon', '_modalFocusElement',
  '_isApplePlatform', '_paletteHint', '_syncPaletteHint', '_paletteModel', '_paletteRank', '_paletteResults', '_paletteMark', '_paletteActionIcon',
  '_paletteOptHtml', '_paletteHtml', '_paletteSyncActive', '_paletteRender', '_commandPaletteBlocked', 'openCommandPalette', 'closeCommandPalette',
  'paletteQuery', '_paletteMove', '_paletteIndex', 'paletteHover', '_paletteRunAction', 'runPaletteItem', 'paletteKeydown', '_isPaletteShortcut', 'paletteShortcut',
  '_dashHoldingRows', '_dashHoldings',
  // Motion and feedback (Step 8b): the reduced-motion check, the hero roll maths and runner, the price diff and flash, the loading skeletons, and Undo on a delete toast
  '_reducedMotion', '_easeOutCubic', '_rollValue', '_heroRollPlan', '_heroValueHtml', '_heroRollCancel', '_heroRollStart',
  '_quotePrice', '_priceSnapshot', '_priceDiff', '_pxFlashNote', '_pxFlashPaint', '_pxAttr', '_skeletonOn', '_skelIf', '_pricesLoading',
  '_deletedText', 'undoDeleteToast', 'sendToTrash', 'cleanOrphanedTrades', '_chipAmounts', 'trashLabel',
  // Orphaned trades in Recently deleted: the batch move and the trim that keeps a trade's stock and account, the label, the plan, the guards and the compound restore
  'sharesHeldAsOf', '_moveToTrash', '_trashParentIds', '_trimTrash', '_trashParentEntry', '_trashTradeSymbol', '_tradeRestorePlan', '_tradeRestoreGuard',
  '_placeRestoredRow', '_trashStage', '_prepareTrashRestore', 'renderTrash'
];
const CONST_TARGETS = ['APP_VERSION', 'APP_DISPLAY_VERSION', 'SCHEMA', 'SCHEMA_VERSION', 'SAFE_ID_RE', 'TICKER_RE', 'PREMIUM_PER_YEAR', 'SYNC_DEBOUNCE_MS', 'PAYLOAD_HARD_CAP', 'PAYLOAD_WARN_AT', 'LK_DB', 'LK_SYNC_URL', 'LK_SYNC_TS', 'LK_SYNC_CONFIRMED_TS', 'LK_SYNC_DIAGNOSTICS', 'LK_LAST_PULL', 'LK_LAST_PULL_SRC', 'LK_RESET_SYNC_BLOCK', 'LK_LOSSY_SYNC_BLOCK', 'LK_UNSAVED', 'LK_CLOUD_DIRTY', 'LK_PRICE_CACHE', 'LK_BACKEND_MODE', 'NAS_MODES', 'PB_PALETTE', 'PB_PERIOD_LABELS', 'MONOGRAM_CLASSES', 'LIST_DASH', 'CPF_TYPE_LABEL', 'DASH_DEFAULT_WIDGETS', 'DASH_LEGACY_WIDGETS', 'DASH_CHART_ID_RE', 'DASH_WIDGET_NAMES', 'PB_MONTHS', 'LK_HERO_RANGE', 'HERO_RANGES', 'HERO_RANGE_LABELS', '_heroState',
  'HP_HISTORY_RANGE', 'HP_TRADES_SHOWN', 'HP_ACTIONS', 'PALETTE_CAP', 'PALETTE_GROUPS', 'CP_PLUS_ICON', 'CP_REFRESH_ICON', 'EYE_SVG', 'EYE_OFF_SVG',
  'HERO_ROLL_MS', 'PX_FLASH_MS', 'SKEL_BAR', 'SKEL_STATUS', 'DELETED_NOUNS', 'TRASH_MAX', 'TRASH_AMOUNT_TABLES', 'TRASH_TABLE_NAMES', 'PB_ORDER_MEMO_MAX'];

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
    rangePosition: core.rangePosition,
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
    _stockRefreshInFlight: false,
    _cryptoRefreshInFlight: false,
    _cryptoMissingToasted: '',
    _pbOrderMemo: [],
    _pxFlashes: new Map(),
    _heroShown: null,
    _heroRoll: null,
    _renderCcy: 'SGD',
    _ibkrImportInFlight: false,
    _pbSaveInFlight: false,
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
const CHART_SANDBOX_CONSTS = ['SAFE_ID_RE', 'PB_SERIES_MODES', 'PB_CLASS_KEYS', 'PB_PERIODS', 'PB_ORDER_MEMO_MAX'];
const CHART_SANDBOX_FNS = [
  'kjrSafeId', 'pbSource', 'pbFields', 'pbLoadSaved', 'pbPersistSaved', 'pbSetOnDashboard',
  'pbToggleOnDashboard', 'pbRemoveFromDashboard', 'pbTogglePin', 'pbSeedDefaults',
  '_pbSavedDescriptor', '_pbDestroyChart', '_pbRenderDashCharts',
  'pbDeleteSaved', '_pbDeletedText', '_pbOrderWith', '_pbUndoSlot', '_pbRestoreFor'
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
    _pbOrderMemo: [],
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

    // a delete is immediate (no dialog), and a chart added while its save is pending is kept, the delete failing keeps the change in memory and says nothing
    sb.DB.settings.savedCharts = [{id:'c3',title:'Three',pinned:false}];
    let finishDelete;
    saves = 0;
    sb.saveData = () => ++saves === 1 ? new Promise(resolve => { finishDelete = resolve; }) : true;
    const deletedToastCount = toasts.filter(t => /^Deleted /.test(t.message)).length;
    const deleting = sb.pbDeleteSaved('c3');
    sb.prompt = () => 'Added during delete';
    assert.strictEqual(await sb.pbSaveChart(), true);
    finishDelete(false);
    assert.strictEqual(await deleting, false);
    assert.strictEqual(sb.DB.settings.savedCharts.some(c => c.id === 'c3'), false);
    assert.strictEqual(sb.DB.settings.savedCharts.some(c => c.title === 'Added during delete'), true);
    assert.strictEqual(toasts.filter(t => /^Deleted /.test(t.message)).length, deletedToastCount);
  });

  /* Chart delete is immediate and offers Undo (v2.76): no confirm dialog, the toast's Undo carries the chart and where it sat. These run the REAL load and persist in the chart sandbox. */
  const pbChart = (id, order) => ({ id, title:'Chart ' + id, source:'networth', pinned:false, onDashboard:true, order });
  const pbIds = sb => Array.from(sb.DB.settings.savedCharts.map(c => c.id));

  await testAsync('pbDeleteSaved - deletes at once with no dialog, destroys the chart, names it on an Undo toast, and Undo puts it back at its original index', async () => {
    const sb = chartSandbox([pbChart('a', 999), pbChart('b', 999), pbChart('c', 999), pbChart('d', 999)], { oldCards:['b'] });
    assert.strictEqual(await sb.pbDeleteSaved('b'), true);
    assert.deepStrictEqual(pbIds(sb), ['a', 'c', 'd']);
    assert.strictEqual(sb.calls.saves, 1);
    assert.strictEqual(sb.calls.repaints, 1);
    assert.deepStrictEqual(Array.from(sb.calls.destroyed), ['b']);              // the Chart instance is freed, then the list repaints
    assert.deepStrictEqual(Object.keys(sb._pbCharts), []);
    const toast = sb.calls.toasts.at(-1);
    assert.strictEqual(toast.message, 'Deleted "Chart b"');
    assert.strictEqual(toast.kind, 'success');
    assert.strictEqual(toast.action.label, 'Undo');
    assert.strictEqual(typeof toast.action.fn, 'function');
    assert.strictEqual(await toast.action.fn(), true);
    assert.deepStrictEqual(pbIds(sb), ['a', 'b', 'c', 'd']);                    // index 1 again
    assert.strictEqual(sb.calls.saves, 2);
    assert.strictEqual(sb.calls.repaints, 2);
    assert.deepStrictEqual(sb.calls.toasts.at(-1), { message:'Chart restored', kind:'success', action:undefined });
    // the first and the last place come back as well
    for (const [id, expected] of [['a', ['a', 'b', 'c', 'd']], ['d', ['a', 'b', 'c', 'd']]]) {
      assert.strictEqual(await sb.pbDeleteSaved(id), true);
      assert.strictEqual(pbIds(sb).includes(id), false);
      assert.strictEqual(await sb.calls.toasts.at(-1).action.fn(), true);
      assert.deepStrictEqual(pbIds(sb), expected);
    }
    // the config comes back whole
    assert.strictEqual(sb.DB.settings.savedCharts.find(c => c.id === 'b').title, 'Chart b');
    assert.strictEqual(sb.DB.settings.savedCharts.find(c => c.id === 'b').source, 'networth');
  });

  await testAsync('pbDeleteSaved - two quick deletes each keep their own Undo, so both come back, and a stack undone newest first restores the exact order', async () => {
    const sb = chartSandbox([pbChart('a', 999), pbChart('b', 999), pbChart('c', 999), pbChart('d', 999)]);
    assert.strictEqual(await sb.pbDeleteSaved('b'), true);
    const undoB = sb.calls.toasts.at(-1).action.fn;
    assert.strictEqual(await sb.pbDeleteSaved('a'), true);
    const undoA = sb.calls.toasts.at(-1).action.fn;
    assert.notStrictEqual(undoA, undoB);                                           // one Undo per delete, not one shared slot
    assert.deepStrictEqual(pbIds(sb), ['c', 'd']);
    assert.strictEqual(await undoA(), true);                                       // newest first: its own place
    assert.deepStrictEqual(pbIds(sb), ['a', 'c', 'd']);
    assert.strictEqual(await undoB(), true);
    assert.deepStrictEqual(pbIds(sb), ['a', 'b', 'c', 'd']);

    // oldest first: the same exact order, because each delete also remembers the neighbour that was deleted just before it
    const sb2 = chartSandbox([pbChart('a', 999), pbChart('b', 999), pbChart('c', 999), pbChart('d', 999)]);
    await sb2.pbDeleteSaved('b'); const first = sb2.calls.toasts.at(-1).action.fn;
    await sb2.pbDeleteSaved('a'); const second = sb2.calls.toasts.at(-1).action.fn;
    assert.strictEqual(await first(), true);
    assert.deepStrictEqual(pbIds(sb2), ['b', 'c', 'd']);
    assert.strictEqual(await second(), true);
    assert.deepStrictEqual(pbIds(sb2), ['a', 'b', 'c', 'd']);
    // three in a row, adjacent, undone in every order: always the original order
    for (const order of [[0, 1, 2], [2, 1, 0], [1, 0, 2], [1, 2, 0], [0, 2, 1], [2, 0, 1]]) {
      const sb6 = chartSandbox([pbChart('a', 999), pbChart('b', 999), pbChart('c', 999), pbChart('d', 999), pbChart('e', 999)]);
      const undos = [];
      for (const id of ['b', 'c', 'd']) { await sb6.pbDeleteSaved(id); undos.push(sb6.calls.toasts.at(-1).action.fn); }
      assert.deepStrictEqual(pbIds(sb6), ['a', 'e']);
      for (const i of order) assert.strictEqual(await undos[i](), true);
      assert.deepStrictEqual(pbIds(sb6), ['a', 'b', 'c', 'd', 'e'], 'order ' + order.join(''));
    }

    // two deletes that are not neighbours land exactly, in either order, even though the list changed under each Undo
    for (const order of [[0, 1], [1, 0]]) {
      const sb3 = chartSandbox([pbChart('a', 999), pbChart('b', 999), pbChart('c', 999), pbChart('d', 999)]);
      await sb3.pbDeleteSaved('b'); const undoB3 = sb3.calls.toasts.at(-1).action.fn;
      await sb3.pbDeleteSaved('d'); const undoD3 = sb3.calls.toasts.at(-1).action.fn;
      assert.deepStrictEqual(pbIds(sb3), ['a', 'c']);
      const undos = [undoB3, undoD3];
      for (const i of order) assert.strictEqual(await undos[i](), true);
      assert.deepStrictEqual(pbIds(sb3), ['a', 'b', 'c', 'd']);
    }
    // a chart added after the delete does not move it: the Undo still lands beside its old neighbour
    const sb4 = chartSandbox([pbChart('a', 999), pbChart('b', 999), pbChart('c', 999)]);
    await sb4.pbDeleteSaved('b');
    sb4.DB.settings.savedCharts = sb4.DB.settings.savedCharts.concat([pbChart('z', 999)]);
    assert.strictEqual(await sb4.calls.toasts.at(-1).action.fn(), true);
    assert.deepStrictEqual(pbIds(sb4), ['a', 'b', 'c', 'z']);
    // the charts' own order key still decides the listing, a seeded chart comes back where its order says
    const sb5 = chartSandbox([pbChart('def_networth', 0), pbChart('def_alloc', 1), pbChart('sc_1', 999)]);
    await sb5.pbDeleteSaved('def_alloc');
    assert.strictEqual(await sb5.calls.toasts.at(-1).action.fn(), true);
    assert.deepStrictEqual(Array.from(sb5.pbLoadSaved().map(c => c.id)), ['def_networth', 'def_alloc', 'sc_1']);
  });

  await testAsync('pbDeleteSaved - the order memo stays bounded however many charts are deleted, and the newest Undo still lands in its place', async () => {
    const many = Array.from({ length:90 }, (_, i) => pbChart('c' + String(i).padStart(2, '0'), 999));
    const sb = chartSandbox(many);
    const undos = {};
    for (const c of many.slice(0, 80)) { await sb.pbDeleteSaved(c.id); undos[c.id] = sb.calls.toasts.at(-1).action.fn; }
    assert.strictEqual(pbIds(sb).length, 10);
    assert.ok(sb._pbOrderMemo.length <= vm.runInContext('PB_ORDER_MEMO_MAX', sb), 'memo ' + sb._pbOrderMemo.length);
    assert.strictEqual(await undos.c79(), true);                                     // the newest delete sat just before c80, and goes back there
    assert.deepStrictEqual(pbIds(sb).slice(0, 2), ['c79', 'c80']);
    assert.strictEqual(await undos.c00(), true);                                     // an old one, whatever the memo kept of it, is still restored (its neighbours are long gone)
    assert.strictEqual(pbIds(sb).includes('c00'), true);
    assert.strictEqual(sb.DB.settings.savedCharts.length, 12);
  });

  await testAsync('pbDeleteSaved - a pinned chart refuses with the same hint, an unknown id does nothing, and a failed save repaints with no toast and no Undo', async () => {
    const sb = chartSandbox([Object.assign(pbChart('p', 999), { pinned:true }), pbChart('q', 999)]);
    assert.strictEqual(await sb.pbDeleteSaved('p'), false);
    assert.deepStrictEqual(pbIds(sb), ['p', 'q']);
    assert.deepStrictEqual(sb.calls.toasts.map(t => t.message), ['Pinned \u2014 unpin first to delete']);   // the existing hint, kept as it was
    assert.strictEqual(sb.calls.saves, 0);
    assert.strictEqual(await sb.pbDeleteSaved('nope'), false);
    assert.strictEqual(sb.calls.saves, 0);
    assert.strictEqual(sb.calls.toasts.length, 1);

    const failing = chartSandbox([pbChart('a', 999), pbChart('b', 999)], { saveResult:false });
    assert.strictEqual(await failing.pbDeleteSaved('a'), false);
    assert.strictEqual(failing.calls.toasts.length, 0);                            // saveData tells the person about a failed save, this adds nothing
    assert.strictEqual(failing.calls.repaints, 1);
    assert.deepStrictEqual(pbIds(failing), ['b']);

    // a save that throws is caught, repainted and reported as not deleted, never an unhandled rejection
    const throwing = chartSandbox([pbChart('a', 999)]);
    throwing.saveData = () => { throw new Error('quota'); };
    const errors = [];
    throwing.console = { error: (...a) => errors.push(a.join(' ')), warn(){}, log(){} };
    assert.strictEqual(await throwing.pbDeleteSaved('a'), false);
    assert.strictEqual(throwing.calls.repaints, 1);
    assert.strictEqual(throwing.calls.toasts.length, 0);
    assert.strictEqual(errors.length, 1);
  });

  await testAsync('pbDeleteSaved Undo - skips a chart that is already saved, does one restore at a time, and a failed save repaints with no restored toast', async () => {
    const sb = chartSandbox([pbChart('a', 999), pbChart('b', 999)]);
    await sb.pbDeleteSaved('a');
    const undo = sb.calls.toasts.at(-1).action.fn;
    // a chart with that id is already back (another device, an earlier Undo): nothing is written, nothing is said
    sb.DB.settings.savedCharts = sb.DB.settings.savedCharts.concat([pbChart('a', 999)]);
    const saves = sb.calls.saves, toasts = sb.calls.toasts.length, repaints = sb.calls.repaints;
    assert.strictEqual(await undo(), false);
    assert.strictEqual(sb.calls.saves, saves); assert.strictEqual(sb.calls.toasts.length, toasts); assert.strictEqual(sb.calls.repaints, repaints);
    assert.deepStrictEqual(pbIds(sb), ['b', 'a']);

    // a double tap while the first restore is saving: the second returns at once, one save, one chart
    const sb2 = chartSandbox([pbChart('a', 999), pbChart('b', 999)]);
    await sb2.pbDeleteSaved('a');
    const undo2 = sb2.calls.toasts.at(-1).action.fn;
    let finish, saves2 = 0;
    sb2.saveData = () => { saves2++; return new Promise(resolve => { finish = resolve; }); };
    const first = undo2();
    assert.strictEqual(await undo2(), false);
    assert.strictEqual(saves2, 1);
    finish(true);
    assert.strictEqual(await first, true);
    assert.deepStrictEqual(pbIds(sb2), ['a', 'b']);
    assert.strictEqual(sb2.calls.toasts.filter(t => t.message === 'Chart restored').length, 1);
    assert.strictEqual(await undo2(), false);                                      // a third tap later finds it saved
    assert.deepStrictEqual(pbIds(sb2), ['a', 'b']);

    // the restore fails to save: the chart is back in memory, repainted, with no restored toast, and the next try finds it there
    const sb3 = chartSandbox([pbChart('a', 999), pbChart('b', 999)]);
    await sb3.pbDeleteSaved('a');
    const undo3 = sb3.calls.toasts.at(-1).action.fn;
    sb3.saveData = () => false;
    const repaints3 = sb3.calls.repaints;
    assert.strictEqual(await undo3(), false);
    assert.strictEqual(sb3.calls.repaints, repaints3 + 1);
    assert.strictEqual(sb3.calls.toasts.some(t => t.message === 'Chart restored'), false);
    assert.deepStrictEqual(pbIds(sb3), ['a', 'b']);

    // a restore that throws is caught too, and the busy flag clears so a later tap can try again
    const sb4 = chartSandbox([pbChart('a', 999), pbChart('b', 999)]);
    await sb4.pbDeleteSaved('a');
    const undo4 = sb4.calls.toasts.at(-1).action.fn;
    sb4.console = { error(){}, warn(){}, log(){} };
    sb4.saveData = () => { throw new Error('quota'); };
    assert.strictEqual(await undo4(), false);
    sb4.DB.settings.savedCharts = [pbChart('b', 999)];
    sb4.saveData = () => true;
    assert.strictEqual(await undo4(), true);
    assert.deepStrictEqual(pbIds(sb4), ['a', 'b']);
  });

  test('_pbUndoSlot and _pbDeletedText - a chart goes back beside its nearest surviving neighbour or at its old index kept in range, and the toast words are quoted, capped and plain', () => {
    const sb = chartSandbox([]);
    const ids = (...a) => a.map(id => ({ id }));
    assert.strictEqual(sb._pbUndoSlot(ids('a', 'c', 'd'), 1, ['a'], ['c', 'd']), 1);       // after its old predecessor
    assert.strictEqual(sb._pbUndoSlot(ids('c', 'd'), 0, ['a'], ['c', 'd']), 0);             // predecessor gone: before its old successor
    assert.strictEqual(sb._pbUndoSlot(ids('x', 'y'), 1, ['a'], ['c']), 1);                  // no neighbour left: the old index
    assert.strictEqual(sb._pbUndoSlot(ids('x'), 7, [], []), 1);                             // kept inside the list
    assert.strictEqual(sb._pbUndoSlot([], 3, ['a'], ['c']), 0);
    assert.strictEqual(sb._pbUndoSlot(ids('a', 'b'), -2, [], []), 0);
    assert.strictEqual(sb._pbUndoSlot(ids('a', 'b'), 'junk', [], []), 0);
    assert.strictEqual(sb._pbUndoSlot(ids('a', 'b', 'c'), 2, ['b', 'a'], ['c']), 2);        // nearest predecessor first
    // the memo: the list with the deleted ids put back beside the neighbour the memo had them after
    const w = (ids, memo) => Array.from(sb._pbOrderWith(ids, memo));
    assert.deepStrictEqual(w(['c', 'd'], ['a', 'b', 'c', 'd']), ['a', 'b', 'c', 'd']);
    assert.deepStrictEqual(w(['a', 'c'], ['a', 'b', 'c']), ['a', 'b', 'c']);
    assert.deepStrictEqual(w(['a', 'c', 'z'], ['a', 'b', 'c']), ['a', 'b', 'c', 'z']);        // a chart added since goes where the list has it
    assert.deepStrictEqual(w(['c', 'b', 'a'], ['a', 'b', 'c']), ['c', 'b', 'a']);              // the list is the authority for what it holds
    assert.deepStrictEqual(w(['x'], ['a', 'b']), ['a', 'b', 'x']);                             // nothing in common: the old ids first
    assert.deepStrictEqual(w(['x', 'y'], []), ['x', 'y']);
    assert.deepStrictEqual(w([], ['a', 'b']), ['a', 'b']);
    assert.deepStrictEqual(w(['a'], undefined), ['a']);
    const ids0 = ['a', 'b']; w(ids0, ['z']); assert.deepStrictEqual(ids0, ['a', 'b']);         // never changes what it was given
    assert.strictEqual(sb._pbDeletedText({ title:'Allocation' }), 'Deleted "Allocation"');
    assert.strictEqual(sb._pbDeletedText({ title:'  Net worth  ' }), 'Deleted "Net worth"');
    assert.strictEqual(sb._pbDeletedText({ title:'<b>x</b> & "q"' }), 'Deleted "<b>x</b> & "q""');   // plain text: the toast sets textContent
    const long = sb._pbDeletedText({ title:'N'.repeat(200) });
    assert.strictEqual(long, 'Deleted "' + 'N'.repeat(39) + '…"');
    assert.strictEqual(sb._pbDeletedText({ title:'' }), 'Deleted chart');
    assert.strictEqual(sb._pbDeletedText({}), 'Deleted chart');
    assert.strictEqual(sb._pbDeletedText(null), 'Deleted chart');
  });

  test('Chart delete - the confirm dialog and the single Undo slot are gone, and the Delete button still reaches pbDeleteSaved through the dispatcher', () => {
    ['_pbConfirm', 'pb-confirm-ov', '_pbUndoChart', '_pbUndoTimer', '_pbUndoInFlight', 'pbUndoDelete', 'pb-cf-yes', 'pb-cf-no'].forEach(name => {
      assert.strictEqual(appSrc.includes(name), false, name + ' in app.js');
      assert.strictEqual(indexSrc.includes(name), false, name + ' in index.html');
    });
    assert.ok(appSrc.includes('pbDeleteSaved:       (el) => pbDeleteSaved(A(el)[0]),'));
    assert.ok(extractFunction('_pbRenderSavedList').includes('data-click="pbDeleteSaved"'));
    const del = extractFunction('pbDeleteSaved');
    assert.ok(del.includes("showToast(_pbDeletedText(cfg), 'success', { label:'Undo', fn: _pbRestoreFor(cfg, idx, before, after) })"));
    assert.ok(del.indexOf('await Promise.resolve(pbPersistSaved(') < del.indexOf('_pbDestroyChart(') && del.indexOf('_pbDestroyChart(') < del.indexOf('pbRenderAllSaved();'));
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
    assert.ok(dashboardSrc.includes('_allocationData(valuation.classes, _dashShowCpf)') && dashboardSrc.includes('_dashHoldings(holdingRows, displayNet, '));
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
    // the top bar status line, the idle currency segment, the sheet counts and the sheet version are all --text2 (v2.77: light --text2 clears the grey sheet, so the version no longer needs the --text override it had in v2.76)
    ['.tb-sub', '.ccy-toggle button', '.more-sheet-row .msr-count,.more-sheet-row .msr-ext', '.sheet-version'].forEach(sel => assert.ok(rule(sel).includes('color:var(--text2)'), sel));
    assert.strictEqual(indexSrc.includes('html:not(.dark) .sheet-version'), false);
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
      assert.ok(ratio(t2, sheet) >= 4.5, name + ' sheet version on the sheet ' + ratio(t2, sheet).toFixed(2));
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

  await testAsync('auto refresh asks for a silent crypto refresh, and nothing else in the app calls it with an argument', async () => {
    const sb = freshSandbox({stocks:[],watchlist:[],cash:[],crypto:[{id:'c1',symbol:'BTC'}],expenses:[],settings:{fxOverrides:{USDSGD:1.4},fxRates:{}}});
    sb.document = {hidden:false}; sb.autoRefreshEnabled = () => true; sb.isStockMarketDaySGT = () => false;
    const asked = []; sb.refreshCryptoPrices = async (...args) => { asked.push(args); };
    await sb.autoRefreshTick();
    assert.deepStrictEqual(JSON.parse(JSON.stringify(asked)), [[{ silent:true }]]);
    // every other call in the app is a plain refreshCryptoPrices(): the buttons, the More menu, the dashboard refresh. None can hand it a click event.
    const calls = (appSrc.match(/refreshCryptoPrices\([^)]*\)/g) || []).filter(c => c !== 'refreshCryptoPrices(opts = {})');
    assert.deepStrictEqual(calls.slice().sort(), ['refreshCryptoPrices()', 'refreshCryptoPrices()', 'refreshCryptoPrices()', 'refreshCryptoPrices({ silent: true })']);
    assert.ok(appSrc.includes('  refreshCryptoPrices: () => refreshCryptoPrices(),') && appSrc.includes('    refreshCryptoPrices: () => refreshCryptoPrices(),'));
    assert.ok(appSrc.includes('if (hasCoins) jobs.push(refreshCryptoPrices());'));
    assert.ok(indexSrc.includes('data-click="refreshCryptoPrices" id="btn-refresh-crypto"') && indexSrc.includes('data-a0="refreshCryptoPrices"'));
  });

  /* A crypto refresh in a sandbox of its own: the real refreshCryptoPrices against a fake CoinGecko answer (sb.reply), counting the toasts and console warnings. */
  function cryptoSandbox(opts){
    opts = opts || {};
    const sb = freshSandbox({ crypto:opts.crypto || [{ id:'c1', symbol:'BTC' }, { id:'c2', symbol:'ETH' }], _priceCache:{} });
    sb.toasts = []; sb.warns = [];
    sb.showToast = (message, kind) => sb.toasts.push({ message, kind });
    sb.console = { warn: (...a) => sb.warns.push(a.join(' ')), log(){}, error(){} };
    sb.renderCrypto = () => {}; sb.refreshHoldingPanel = () => {}; sb._repaintDashAfterPrices = () => {}; sb._repaintPriceSurfaces = () => {};
    sb.reply = { prices:{ BTC:{ sgd:1, usd:1 }, ETH:{ sgd:2, usd:2 } } };
    sb.fetches = 0;
    sb.fetch = async () => { sb.fetches++; return { json: async () => sb.reply }; };
    return sb;
  }
  const BOTH = { BTC:{ sgd:1, usd:1 }, ETH:{ sgd:2, usd:2 } };

  test('extractFunction - a default parameter that holds a brace belongs to the signature, so refreshStockPrices and refreshCryptoPrices can be read whole', () => {
    ['refreshStockPrices', 'refreshCryptoPrices'].forEach(name => {
      const src = extractFunction(name);
      assert.ok(src.startsWith('async function ' + name + '(opts = {}){'), name);
      assert.ok(src.endsWith('\n}'), name);
      assert.ok(new vm.Script(src), name + ' parses');
    });
    const tricky = 'function f(a = ")", b = {x:1}, c = (1 + (2))){ return "}" + a; }';
    assert.strictEqual(extractFunction('f', tricky), tricky);
    assert.strictEqual(extractFunction('f', 'function f(a){ return a; }'), 'function f(a){ return a; }');
  });

  await testAsync('refreshCryptoPrices - a silent refresh says nothing when it works, a manual one keeps its toast', async () => {
    const sb = cryptoSandbox();
    await sb.refreshCryptoPrices({ silent:true });
    assert.deepStrictEqual(sb.toasts, []);
    assert.strictEqual(sb.fetches, 1);
    assert.strictEqual(sb.DB._priceCache.BTC.sgd, 1);                                // the prices still land
    assert.strictEqual(sb._cryptoMissingToasted, '');
    assert.strictEqual(sb._cryptoRefreshInFlight, false);
    await sb.refreshCryptoPrices();
    assert.deepStrictEqual(JSON.parse(JSON.stringify(sb.toasts)), [{ message:'Crypto: 2 refreshed', kind:'success' }]);
    // an empty options object, null and a click event are manual refreshes, never silent
    sb.toasts.length = 0;
    await sb.refreshCryptoPrices({});
    await sb.refreshCryptoPrices(null);
    await sb.refreshCryptoPrices({ type:'click', target:{} });
    assert.strictEqual(sb.toasts.length, 3);
    assert.ok(sb.toasts.every(t => t.message === 'Crypto: 2 refreshed' && t.kind === 'success'));
  });

  await testAsync('refreshCryptoPrices - a silent refresh that fails still toasts the error, and the in-flight flag clears', async () => {
    const sb = cryptoSandbox();
    sb.reply = { error:'rate limited' };
    await sb.refreshCryptoPrices({ silent:true });
    assert.deepStrictEqual(JSON.parse(JSON.stringify(sb.toasts)), [{ message:'Crypto refresh failed: rate limited', kind:'error' }]);
    assert.strictEqual(sb._cryptoRefreshInFlight, false);
    sb.fetch = async () => { throw new Error('offline'); };
    await sb.refreshCryptoPrices({ silent:true });
    assert.strictEqual(sb.toasts.at(-1).message, 'Crypto refresh failed: offline');
    assert.strictEqual(sb.toasts.at(-1).kind, 'error');
    // the manual refresh reports it the same way
    await sb.refreshCryptoPrices();
    assert.strictEqual(sb.toasts.at(-1).message, 'Crypto refresh failed: offline');
    assert.strictEqual(sb.toasts.length, 3);
    // a failure leaves the missing-coin memory alone
    sb._cryptoMissingToasted = 'ETH';
    await sb.refreshCryptoPrices({ silent:true });
    assert.strictEqual(sb._cryptoMissingToasted, 'ETH');
  });

  await testAsync('refreshCryptoPrices - the same set of missing coins toasts once in silent mode, a different set toasts again, and a clean refresh resets it', async () => {
    const sb = cryptoSandbox();
    const toastsOf = () => JSON.parse(JSON.stringify(sb.toasts));
    sb.reply = { prices:{ BTC:BOTH.BTC } };                                           // ETH comes back with no price
    await sb.refreshCryptoPrices({ silent:true });
    assert.deepStrictEqual(toastsOf(), [{ message:'Crypto: 1 refreshed, 1 missing', kind:'error' }]);
    assert.strictEqual(sb._cryptoMissingToasted, 'ETH');
    await sb.refreshCryptoPrices({ silent:true });
    await sb.refreshCryptoPrices({ silent:true });
    assert.strictEqual(sb.toasts.length, 1);                                           // the same gap does not toast again
    sb.reply = { prices:{ ETH:BOTH.ETH } };                                           // now BTC is the one missing: a different set
    await sb.refreshCryptoPrices({ silent:true });
    assert.strictEqual(sb.toasts.length, 2);
    assert.strictEqual(sb._cryptoMissingToasted, 'BTC');
    sb.reply = { prices:{} };                                                          // both missing: a third set, in sorted order
    await sb.refreshCryptoPrices({ silent:true });
    assert.strictEqual(sb.toasts.length, 3);
    assert.strictEqual(sb.toasts.at(-1).message, 'Crypto: 0 refreshed, 2 missing');
    assert.strictEqual(sb._cryptoMissingToasted, 'BTC,ETH');
    sb.reply = { prices:BOTH };                                                        // all back: quiet, and the memory resets
    await sb.refreshCryptoPrices({ silent:true });
    assert.strictEqual(sb.toasts.length, 3);
    assert.strictEqual(sb._cryptoMissingToasted, '');
    sb.reply = { prices:{ BTC:BOTH.BTC } };                                           // the old gap returns after a clean run: it toasts again
    await sb.refreshCryptoPrices({ silent:true });
    assert.strictEqual(sb.toasts.length, 4);
    // the missing set is of coin ids, whatever order the coins are listed in
    const rev = cryptoSandbox({ crypto:[{ id:'c2', symbol:'ETH' }, { id:'c1', symbol:'BTC' }] });
    rev.reply = { prices:{} };
    await rev.refreshCryptoPrices({ silent:true });
    assert.strictEqual(rev._cryptoMissingToasted, 'BTC,ETH');
    // a manual refresh toasts every time, the same gap or not, and leaves the silent memory alone
    const man = cryptoSandbox();
    man.reply = { prices:{ BTC:BOTH.BTC } };
    await man.refreshCryptoPrices(); await man.refreshCryptoPrices();
    assert.deepStrictEqual(JSON.parse(JSON.stringify(man.toasts)), [{ message:'Crypto: 1 refreshed, 1 missing', kind:'error' }, { message:'Crypto: 1 refreshed, 1 missing', kind:'error' }]);
    assert.strictEqual(man._cryptoMissingToasted, '');
  });

  await testAsync('refreshCryptoPrices - the early exits are quiet in silent mode (a console warning for the two that need one) and keep their toasts when manual', async () => {
    const pairs = list => Array.from(list.map(t => [t.message, t.kind || '']));
    const quiet = async (setup, silentWarns, manualToast) => {
      const sb = cryptoSandbox(); setup(sb);
      await sb.refreshCryptoPrices({ silent:true });
      assert.deepStrictEqual(pairs(sb.toasts), [], 'silent toasts');
      assert.strictEqual(sb.warns.length, silentWarns, 'silent warnings');
      assert.strictEqual(sb.fetches, 0);
      const man = cryptoSandbox(); setup(man);
      await man.refreshCryptoPrices();
      assert.deepStrictEqual(pairs(man.toasts), [manualToast]);
      assert.strictEqual(man.fetches, 0);
    };
    await quiet(sb => { sb._cryptoRefreshInFlight = true; }, 1, ['Crypto refresh already running', '']);
    await quiet(sb => { sb.coinIdFor = () => ''; }, 1, ['No valid coin ids', 'error']);
    await quiet(sb => { sb.DB.crypto = []; }, 0, ['No coins to refresh', '']);
    await quiet(sb => { sb.getSyncUrl = () => ''; }, 0, ['Set the Apps Script URL first', 'error']);
    // an early exit leaves the in-flight flag as it found it, and a skipped refresh does not clear a running one
    const run = cryptoSandbox(); run._cryptoRefreshInFlight = true;
    await run.refreshCryptoPrices({ silent:true });
    assert.strictEqual(run._cryptoRefreshInFlight, true);
    const ids = cryptoSandbox(); ids.coinIdFor = () => '';
    await ids.refreshCryptoPrices({ silent:true });
    assert.strictEqual(ids._cryptoRefreshInFlight, false);
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

  /* Step 8a changed this test: openHoldingDetail used to open the edit modal (the v2.73 stand-in) and now opens the side panel, which holds Edit holding. The
     routing guards, the toasts and the delegated action line are asserted exactly as before. */
  test('openHoldingDetail - the one place a holding row goes, now the side panel, only for a stock or a coin with a safe id', () => {
    const sb = freshSandbox();
    const calls = [];
    sb.openHoldingPanel = (table, id) => { calls.push(['panel', table, id]); return true; };
    sb.openEntityModal = (table, id) => calls.push(['modal', table, id]);   // a row no longer opens the edit form itself
    sb.showToast = (msg, kind) => calls.push(['toast', kind]);
    assert.strictEqual(sb.openHoldingDetail('stocks', 'stock_seed_aapl'), true);
    assert.strictEqual(sb.openHoldingDetail('crypto', 'c-btc_1'), true);
    assert.deepStrictEqual(calls, [['panel', 'stocks', 'stock_seed_aapl'], ['panel', 'crypto', 'c-btc_1']]);
    // a holding that is gone (the panel says so and returns false) is not reported as opened
    sb.openHoldingPanel = () => false;
    assert.strictEqual(sb.openHoldingDetail('stocks', 'stock_gone'), false);
    sb.openHoldingPanel = (table, id) => { calls.push(['panel', table, id]); return true; };
    calls.length = 0;
    ['cash', 'cpfHistory', 'realestate', '', null, undefined, 'constructor', '__proto__'].forEach(t => assert.strictEqual(sb.openHoldingDetail(t, 'x1'), false, String(t)));
    assert.deepStrictEqual(calls, []);
    ['', null, undefined, 'a b', 'x"y', '<img>', 'a'.repeat(65)].forEach(id => assert.strictEqual(sb.openHoldingDetail('stocks', id), false, String(id)));
    assert.deepStrictEqual(calls.map(c => c[0] + ':' + c[1]), Array(7).fill('toast:error'));
    // the rows and the delegated action go through it, nothing else opens a holding
    const actions = extractFunction('installEventDelegation');
    assert.ok(actions.includes('openHolding:         (el) => { const [a0, a1] = A(el); openHoldingDetail(a0, a1); },'));
    assert.ok(extractFunction('_holdingRowHtml').includes('data-click="openHolding"'));
    assert.ok(extractFunction('openHoldingDetail').includes('openHoldingPanel(table, id)'));   // was openEntityModal(table, id)
    assert.strictEqual(extractFunction('openHoldingDetail').includes('openEntityModal'), false);
  });

  test('renderStocks - the phone list and the desktop table come from the same rows: same symbols in the same order, same values, same totals, under a filter and a sort', () => {
    const sb = listSandbox(stockFixture(), 'USD');
    const els = stocksBox(sb);
    const cols = stockCols(sb);
    const run = () => { sb.renderStocks(); return els['stocks-body'].innerHTML; };
    // Step 8a: the symbol cell holds a button that opens the side panel, so the symbol is the button's text (this helper read the cell's own text before)
    const tableSyms = html => Array.from(html.matchAll(/cell-sym sticky-col"><button[^>]*>([^<]*)</g)).map(m => m[1]);
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
    // Step 8a: the symbol cell holds a button that opens the side panel, so the symbol is the button's text (this helper read the cell's own text before)
    const tableSyms = html => Array.from(html.matchAll(/cell-sym sticky-col"><button[^>]*>([^<]*)</g)).map(m => m[1]);
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
    // Step 8a: the coin's symbol cell holds a button that opens the side panel, the symbol is the button's text
    const tableSyms = Array.from(html.matchAll(/<td class="tl cell-sym"><button[^>]*>([^<]*)</g)).map(m => m[1]);
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

  /* ═══════════════════════════════════════════════════════════════════════
     v2.76 Stocks page ledgers on the phone: Watchlist, Upcoming dividends and Trade history.
     Like the Cash and CPF ledgers, the list is built from the same view as the table, so these run the REAL renderers and hold the list against the table's cells.
     ═══════════════════════════════════════════════════════════════════════ */
  const wlFixture = () => ({
    watchlist:[
      { id:'w_msft', symbol:'MSFT', market:'US', sector:'Information Technology', targetPrice:300, notes:'Wait for a pullback' },
      { id:'w_o39', symbol:'O39', market:'SGX', targetPrice:null, notes:'' },
      { id:'w_nopx', symbol:'NOPX', market:'US', notes:'<b>x</b> "q" & co' },
      { id:'w_old', symbol:'OLD', market:'US', notes:'' }
    ],
    _priceCache:{
      MSFT:{ price:290.5, currency:'USD', changePct:-1.42, fetchedAt:TODAY_ISO },
      O39:{ price:15.5, currency:'SGD', changePct:0.5, fetchedAt:TODAY_ISO },
      OLD:{ price:10, currency:'USD', changePct:0, fetchedAt:'2020-01-01T00:00:00Z' }
    }
  });
  function wlSandbox(db, ccy){
    const sb = listSandbox(db, ccy || 'USD');
    sb.priceFor = (table, item) => sb.DB._priceCache[item.symbol] || null;
    return { sb, els: renderBox(sb, ['stocks-watchlist']) };
  }
  const wlRowsOf = html => Array.from(html.matchAll(/<div class="dash-hrow hl-row hl-split">[\s\S]*?<\/a><\/div>/g)).map(m => m[0]);
  const wlTableCells = (html, sym) => { const m = new RegExp('<tr>\\s*<td class="tl cell-sym">' + sym + '<\\/td>([\\s\\S]*?)<\\/tr>').exec(html); return m ? Array.from(m[1].matchAll(/<td class="([^"]*)">([\s\S]*?)<\/td>/g)).map(c => [c[1], c[2]]) : null; };

  test('renderWatchlist - the phone list reads the same rows as the table, in its order: symbol and market over the note, the price over the day move, Edit on the row and Analyse beside it', () => {
    const { sb, els } = wlSandbox(wlFixture(), 'USD');
    sb.renderWatchlist();
    const html = els['stocks-watchlist'].innerHTML;
    const rows = wlRowsOf(html);
    assert.strictEqual(rows.length, 4);
    assert.ok(html.includes('<div class="tbl-wrap hd-only"><table class="holdings">') && html.includes('<div class="hl hl-2" role="group" aria-label="Watchlist">'));
    const tableSyms = Array.from(html.matchAll(/<td class="tl cell-sym">([^<]*)<\/td>/g)).map(m => m[1]);
    assert.deepStrictEqual(tableSyms, ['MSFT', 'NOPX', 'O39', 'OLD']);
    assert.deepStrictEqual(rows.map(r => /<span class="hl-t">([^<]*)</.exec(r)[1].trim()), tableSyms);
    // MSFT: the price is the table's Price cell, the day move its Day % cell, with its arrow and sign, and the target flag shows
    const msft = wlTableCells(html, 'MSFT');
    assert.strictEqual(msft[2][1], 'US$290.50');
    assert.ok(rows[0].includes('<span class="hl-amt money-chip">US$290.50</span>'));
    assert.strictEqual(msft[3][1], '<span class="neg">▼ -1.42%</span>');
    assert.ok(rows[0].includes('<span class="dash-chg down">▼ -1.42%</span>'));
    // (v2.77) the sub line is one target piece (the table's Target cell figure in a chip as its td.num is, with a check mark in front when the price is at it), then the note after a dot
    assert.ok(msft[7][1].includes('✓ At target') && rows[0].includes('<span class="hl-s"><span class="hl-tgt">✓ Target <span class="money-chip">US$300.00</span></span><span class="hl-nt">· Wait for a pullback</span></span>'));
    assert.ok(rows[0].includes('<span class="hl-t">MSFT <span class="hl-k">· US</span></span>'));
    // a Singapore quote converts to the display currency exactly as the table does
    const o39 = wlTableCells(html, 'O39');
    assert.strictEqual(o39[2][1], 'US$12.40');
    assert.ok(rows[2].includes('class="hl-amt money-chip">US$12.40<') && rows[2].includes('<span class="dash-chg up">▲ +0.50%</span>'));
    assert.strictEqual(rows[2].includes('At target'), false);                       // no target, no flag
    // the row edits the entry, as the table's Edit button does, and Analyse is a link beside it that opens the same page
    assert.ok(rows[0].includes('<button type="button" class="hl-hit" data-edit-table="watchlist" data-edit-id="w_msft" aria-haspopup="dialog" aria-label="Edit MSFT, US, price US$290.50, day -1.42%, target price US$300.00, at target price, Wait for a pullback">'));
    assert.ok(rows[0].includes('</button><a class="btn btn-sm btn-ghost hl-go" href="../Trading/index.html?symbol=MSFT" target="_blank" rel="noopener" aria-label="Analyse MSFT, opens the chart in a new tab">Analyse</a>'));
    assert.ok(html.includes('href="../Trading/index.html?symbol=MSFT" target="_blank" rel="noopener" title="Open chart analysis for MSFT">Analyse</a>'));
    assert.strictEqual((html.match(/class="btn btn-sm btn-ghost btn-edit" data-edit-table="watchlist"/g) || []).length, 4);   // the table's own Edit buttons are all still there
    // Hide amounts: the price is a chip as the td.num cell is, the day move is not (its td is .pct)
    assert.strictEqual(/money-chip">[^<]*%/.test(rows[0]), false);
    assert.ok(msft[2][0] === 'num' && msft[3][0] === 'num pct');
    // the day move is a sign and an arrow as well as a colour
    assert.ok(rows[0].includes('▼') && rows[2].includes('▲'));
  });

  test('renderWatchlist - a missing price or day move is an en dash, a stale quote says so, a price with no FX rate keeps its native amount, notes are escaped, and the empty card is the one it was', () => {
    const { sb, els } = wlSandbox(wlFixture(), 'USD');
    sb.renderWatchlist();
    const html = els['stocks-watchlist'].innerHTML, rows = wlRowsOf(html);
    // NOPX has no quote: dashes in the list where the table has its tokens, never NaN or undefined
    assert.ok(rows[1].includes('<span class="hl-amt money-chip">' + DASH + '</span>') && rows[1].includes('<span class="dash-chg">' + DASH + '</span>'));
    assert.ok(rows[1].includes('aria-label="Edit NOPX, US, price not available, &lt;b&gt;x&lt;/b&gt; &quot;q&quot; &amp; co"'));
    assert.ok(wlTableCells(html, 'NOPX')[2][1].includes('price-stale') && wlTableCells(html, 'NOPX')[3][1] === '—');
    assert.strictEqual(/NaN|undefined|null/.test(rows.join('')), false);
    // hostile note text is escaped in the visible line and in the spoken label, and never reaches the page as markup
    assert.ok(rows[1].includes('<span class="hl-s"><span class="hl-nt">&lt;b&gt;x&lt;/b&gt; &quot;q&quot; &amp; co</span></span>'));
    assert.strictEqual(/<b>x<\/b>/.test(rows[1]), false);
    // a quote older than a day: the table's (stale) hint, the list's "· stale" in the day line and in the label, a zero move reads as a gain without an arrow
    assert.ok(wlTableCells(html, 'OLD')[2][1].includes('<span class="hint">(stale)</span>'));
    assert.ok(rows[3].includes('<span class="dash-chg up">+0.00% <span class="price-stale">· stale</span></span>') && rows[3].includes('price US$10.00, stale, day +0.00%'));
    // an FX rate that is missing: the native amount in the dim italic, the reason in the spoken label
    const fx = wlSandbox(Object.assign(wlFixture(), { settings:{ fxOverrides:{}, fxRates:{} } }), 'SGD');
    fx.sb.renderWatchlist();
    const fxRows = wlRowsOf(fx.els['stocks-watchlist'].innerHTML);
    assert.ok(fxRows[0].includes('<span class="hl-amt money-chip"><span class="price-stale">USD 290.50</span></span>'));
    assert.ok(fxRows[0].includes('price USD 290.50, FX rate missing'));
    assert.ok(fx.els['stocks-watchlist'].innerHTML.includes('USD 290.50 · FX missing'));
    // a sort set on the desktop headers orders the list too
    sb.DB.settings.watchlistSort = { key:'symbol', dir:'desc' };
    sb.renderWatchlist();
    const sorted = els['stocks-watchlist'].innerHTML;
    assert.deepStrictEqual(Array.from(sorted.matchAll(/<td class="tl cell-sym">([^<]*)<\/td>/g)).map(m => m[1]), ['OLD', 'O39', 'NOPX', 'MSFT']);
    assert.deepStrictEqual(wlRowsOf(sorted).map(r => /<span class="hl-t">([^<]*)</.exec(r)[1].trim()), ['OLD', 'O39', 'NOPX', 'MSFT']);
    // an empty watchlist: the same empty card, no table and no list
    sb.DB.watchlist = [];
    sb.renderWatchlist();
    assert.ok(els['stocks-watchlist'].innerHTML.includes('Nothing on watch') && !els['stocks-watchlist'].innerHTML.includes('hl-row') && !els['stocks-watchlist'].innerHTML.includes('hd-only'));
  });

  test('_wlListModel and _wlLabel - the view of one watchlist row: dashes for what is missing, the target flag, and a label a screen reader can use', () => {
    const sb = listSandbox({}, 'USD');
    const m = (w, px, ccy) => navPlain(sb._wlListModel({ w, px, ccy: ccy || 'USD' }));
    const hit = m({ id:'w1', symbol:'AAPL', market:'US', targetPrice:100, notes:'  buy  ' }, { price:99, changePct:2, fetchedAt:TODAY_ISO });
    assert.deepStrictEqual(hit, { id:'w1', sym:'AAPL', market:'US', note:'buy', price:'US$99.00', fx:false, stale:false, day:'▲ +2.00%', dir:'up', atTarget:true, target:'US$100.00', targetFx:false, href:'../Trading/index.html?symbol=AAPL' });
    assert.strictEqual(m({ id:'w', symbol:'A', targetPrice:99 }, { price:99, fetchedAt:TODAY_ISO }).atTarget, true);        // at the target counts
    assert.strictEqual(m({ id:'w', symbol:'A', targetPrice:98.99 }, { price:99, fetchedAt:TODAY_ISO }).atTarget, false);
    assert.strictEqual(m({ id:'w', symbol:'A', targetPrice:null }, { price:1, fetchedAt:TODAY_ISO }).atTarget, false);
    assert.strictEqual(m({ id:'w', symbol:'A', targetPrice:5 }, null).atTarget, false);                                  // no quote, no flag
    const bare = m({ id:'w2' }, null);
    assert.deepStrictEqual([bare.sym, bare.market, bare.note, bare.price, bare.day, bare.dir, bare.stale, bare.fx], ['', '', '', DASH, DASH, '', false, false]);
    assert.strictEqual(m({ id:'w3', symbol:'A' }, { price:5, changePct:'x', fetchedAt:TODAY_ISO }).day, DASH);              // a day move that is not a number is a dash
    assert.strictEqual(m({ id:'w3', symbol:'A' }, { price:5, changePct:-0.4, fetchedAt:TODAY_ISO }).dir, 'down');
    assert.strictEqual(m({ id:'w4', symbol:'A' }, { price:5 }).stale, true);                                              // no fetch time counts as stale, as the table says
    assert.strictEqual(m({ id:'w5', symbol:'A/B C', market:'SGX' }, { price:5, fetchedAt:TODAY_ISO }, 'SGD').href, '../Trading/index.html?symbol=A%2FB%20C');
    assert.strictEqual(sb._wlLabel(hit), 'Edit AAPL, US, price US$99.00, day +2.00%, target price US$100.00, at target price, buy');
    assert.strictEqual(sb._wlLabel(bare), 'Edit watchlist entry, price not available');
  });

  const divDays = n => new Date(Date.now() + n * 86400000);
  test('renderDividendTimeline - the phone list reads the same payments as the table: symbol and dates on the left, the estimate on the right over shares by per-share, in the same order', () => {
    const sb = listSandbox({}, 'USD');
    const els = renderBox(sb, ['stocks-dividends']);
    const iso = n => sb._isoDateSG(divDays(n));
    const rows = [
      { s:{ symbol:'D05', divPerShare:1.8, divExDate:iso(40), divPayDate:'' }, shares:100, ccy:'SGD' },
      { s:{ symbol:'AAPL', divPerShare:1, divExDate:iso(12), divPayDate:iso(30) }, shares:30, ccy:'USD' },
      { s:{ symbol:'<b>X</b>', divPerShare:0.5, divExDate:iso(55), divPayDate:iso(75) }, shares:1234.56789, ccy:'USD' },
      { s:{ symbol:'FAR', divPerShare:1, divExDate:iso(200), divPayDate:iso(210) }, shares:1, ccy:'SGD' }
    ];
    sb.renderDividendTimeline(rows);
    const html = els['stocks-dividends'].innerHTML;
    const list = Array.from(html.matchAll(/<div class="hl-row"><span class="hl-main">[\s\S]*?<\/span><\/span><\/div>/g)).map(m => m[0]);
    const table = Array.from(html.matchAll(/<tr>\s*<td class="tl">([\s\S]*?)<\/tr>/g)).map(m => Array.from(('<td class="tl">' + m[1]).matchAll(/<td class="[^"]*">([\s\S]*?)<\/td>/g)).map(c => c[1]));
    assert.strictEqual(list.length, 3);                                              // FAR is outside the 90 days, in neither
    assert.strictEqual(table.length, 3);
    assert.deepStrictEqual(table.map(r => r[0]), ['AAPL', 'D05', '&lt;b&gt;X&lt;/b&gt;']);
    assert.ok(html.includes('<div class="tbl-wrap hd-only"><table class="tbl">') && html.includes('<div class="hl hl-2" role="group" aria-label="Upcoming dividends">') && html.includes('class="card-body p0 hl-host"'));
    // each row: symbol, ex-date and pay date (an en dash for none) on the left, the Est. income cell as the amount, shares by Div/share under it
    table.forEach((cells, i) => {
      assert.ok(list[i].includes('<span class="hl-t">' + cells[0] + '</span>'), 'symbol ' + i);
      assert.ok(list[i].includes('<span class="hl-s hl-dates"><span>Ex ' + cells[1] + '</span><span>Pay ' + (cells[2] === '—' ? DASH : cells[2]) + '</span></span>'), 'dates ' + i);
      assert.ok(list[i].includes('<span class="hl-amt money-chip">' + cells[5] + '</span>'), 'estimate ' + i);
      assert.ok(list[i].includes('<span aria-hidden="true">' + cells[3] + ' × ' + cells[4] + '</span>'), 'shares by per-share ' + i);
      assert.ok(list[i].includes('<span class="sr-only">' + cells[3] + ' shares at ' + cells[4] + ' per share</span>'), 'spoken ' + i);
    });
    assert.strictEqual(table[1][2], '—');                                            // D05 has no pay date: the table's token, and the list's dash
    assert.ok(list[1].includes('<span>Pay ' + DASH + '</span>'));
    assert.strictEqual(table[0][5], 'US$30');                                         // 30 shares of a US$1 dividend
    assert.ok(list[0].includes('<span aria-hidden="true">30 × US$1.00</span>'));
    // hostile symbols are escaped, a fractional share count keeps its decimals, and amounts blur under Hide amounts
    assert.strictEqual(/<b>X<\/b>/.test(list.join('')), false);
    assert.ok(list[2].includes('&lt;b&gt;X&lt;/b&gt;') && list[2].includes('1,234.5679 × '));
    assert.ok(list.every(r => (r.match(/money-chip/g) || []).length === 2));
    // a dividend only reads: no button, no link, nothing to tap
    assert.strictEqual(/<button|<a /.test(list.join('')), false);
    // the empty states are the card's own, no list: no holdings, no ex-dates set, none in the next 90 days
    sb.renderDividendTimeline([]);
    assert.strictEqual(els['stocks-dividends'].innerHTML, '');
    sb.renderDividendTimeline([{ s:{ symbol:'A', divPerShare:0 }, shares:1, ccy:'SGD' }]);
    assert.ok(els['stocks-dividends'].innerHTML.includes('No ex-dates set') && !els['stocks-dividends'].innerHTML.includes('hl-row'));
    sb.renderDividendTimeline([rows[3]]);
    assert.ok(els['stocks-dividends'].innerHTML.includes('No payments due in the next 90 days') && !els['stocks-dividends'].innerHTML.includes('hl-row') && !els['stocks-dividends'].innerHTML.includes('hd-only'));
  });

  const txnFixture = () => ({
    stocks:[ { id:'s_aapl', symbol:'AAPL', market:'US', currency:'USD', shares:30, avgCost:150 }, { id:'s_d05', symbol:'D05', market:'SGX', currency:'SGD', shares:0, avgCost:0 } ],
    stockTxns:[
      { id:'t1', stockId:'s_aapl', date:'2026-03-10', side:'sell', shares:10, price:290, fees:5, notes:'Trim' },
      { id:'t2', stockId:'s_aapl', date:'2026-01-05', side:'buy', shares:40, price:150, fees:0, notes:'<i>open</i> "q"' },
      { id:'t3', stockId:'s_d05', date:'2026-02-11', side:'buy', shares:100, price:30, fees:1.5, notes:'' }
    ]
  });
  function txnSandbox(db, view){
    const sb = listSandbox(db || txnFixture(), 'USD');
    vm.runInContext("var _ledgerView = '" + (view || 'flat') + "';", sb);
    return { sb, els: renderBox(sb, ['stocks-ledger']) };
  }
  const txnRowsOf = html => Array.from(html.matchAll(/<button type="button" class="dash-hrow hl-row" data-edit-table="stockTxns"[\s\S]*?<\/button>/g)).map(m => m[0]);
  const txnTableRows = html => Array.from(html.matchAll(/<tr>\s*<td class="tl">([\s\S]*?)<\/tr>/g)).map(m => Array.from(('<td class="tl">' + m[1]).matchAll(/<td class="[^"]*">([\s\S]*?)<\/td>/g)).map(c => c[1]));

  test('renderStockTxns - the flat trade list reads the same trades as the table, newest first: side, quantity and symbol over date, fees and note, the value over the price', () => {
    const { sb, els } = txnSandbox();
    sb.renderStockTxns();
    const html = els['stocks-ledger'].innerHTML;
    const rows = txnRowsOf(html);
    const table = txnTableRows(html);
    assert.strictEqual(rows.length, 3);
    assert.strictEqual(table.length, 3);
    assert.deepStrictEqual(table.map(r => r[0]), ['10/03/2026', '11/02/2026', '05/01/2026']);
    assert.ok(html.includes('<div class="tbl-wrap hd-only"><table class="holdings">') && html.includes('<div class="hl hl-2" role="group" aria-label="Trade history">'));
    // the sell: a red word and a tag, the table's own quantity, price, fees and value
    assert.deepStrictEqual(table[0].slice(0, 7), ['10/03/2026', 'AAPL', '<span class="tag neg">SELL</span>', '10', 'US$290.00', 'US$5.00', 'US$2,895']);
    assert.ok(rows[0].includes('<span class="hl-t"><span class="neg">Sell</span> <span class="money-chip">10</span> AAPL</span>'));
    assert.ok(rows[0].includes('<span class="hl-s">10/03/2026 · Fees <span class="money-chip">US$5.00</span> · Trim</span>'));
    assert.ok(rows[0].includes('<span class="hl-amt money-chip">US$2,895</span><span class="dash-sub money-chip">@ US$290.00</span>'));
    // a buy with no fees has no fees part (the table shows its dash), a Singapore stock converts as the table does
    assert.deepStrictEqual(table[2].slice(0, 7), ['05/01/2026', 'AAPL', '<span class="tag pos">BUY</span>', '40', 'US$150.00', '—', 'US$6,000']);
    assert.ok(rows[2].includes('<span class="pos">Buy</span> <span class="money-chip">40</span> AAPL') && !rows[2].includes('Fees'));
    assert.strictEqual(table[1][4], 'US$24.00');                                      // S$30 in US$ at 1.25
    assert.ok(rows[1].includes('@ US$24.00') && rows[1].includes('Fees <span class="money-chip">US$1.20</span>') && rows[1].includes('class="hl-amt money-chip">US$2,401<'));
    // the row edits the trade, as the table's Edit button does, with a label that names everything
    assert.ok(rows[0].includes('data-edit-table="stockTxns" data-edit-id="t1" aria-haspopup="dialog" aria-label="Edit Sell 10 AAPL, 10/03/2026, price US$290.00, fees US$5.00, value US$2,895, Trim"'));
    assert.strictEqual((html.match(/class="btn btn-sm btn-ghost btn-edit" data-edit-table="stockTxns"/g) || []).length, 3);
    // the table keeps its columns
    assert.ok(html.includes('<th class="tl">Date</th><th class="tl">Stock</th><th class="tl">Side</th><th>Shares</th><th>Price</th><th>Fees</th><th>Value</th><th class="tl">Notes</th>'));
    // side is a word and colour never alone, quantity and money blur under Hide amounts
    assert.ok(rows.every(r => /<span class="(pos|neg)">(Buy|Sell)<\/span>/.test(r) && (r.match(/money-chip/g) || []).length >= 3));
    // hostile note text is escaped in the line and in the label
    assert.ok(rows[2].includes('&lt;i&gt;open&lt;/i&gt; &quot;q&quot;') && /<i>open/.test(rows.join('')) === false);
    // the card head keeps its controls wrapping, up to five of them
    assert.ok(html.includes('style="display:flex;gap:.5rem;align-items:center;flex-wrap:wrap"'));
    assert.strictEqual((html.slice(0, html.indexOf('<div class="tbl-wrap')).match(/<button/g) || []).length, 5);
    assert.ok(html.includes('type="file" id="ibkr-file-input"'));
  });

  test('renderStockTxns - By stock: a heading for each stock with its count, its trades without the symbol, then the position line with the realised P&L as an arrow and a sign', () => {
    const { sb, els } = txnSandbox(null, 'by-stock');
    sb.renderStockTxns();
    const html = els['stocks-ledger'].innerHTML;
    const list = html.slice(html.indexOf('<div class="hl hl-2"'));
    const groups = Array.from(list.matchAll(/<div class="hl-group" role="heading" aria-level="4"><span class="hl-group-t">([^<]*)<\/span><span class="hl-group-n">([^<]*)<\/span><\/div>/g)).map(m => [m[1], m[2]]);
    assert.deepStrictEqual(groups, [['AAPL', '2 trades'], ['D05', '1 trade']]);
    // the list runs heading, trades (oldest first), position, then the next stock, as the table does
    const order = Array.from(list.matchAll(/hl-group-t">([^<]*)<|data-edit-id="(t\d)"|class="hl-total"/g)).map(m => m[1] || m[2] || 'position');
    assert.deepStrictEqual(order, ['AAPL', 't2', 't1', 'position', 'D05', 't3', 'position']);
    const tableOrder = Array.from(html.matchAll(/ledger-group-row"><td colspan="9" class="tl"><strong>([^<]*)<|data-edit-id="(t\d)"|subtotal-row/g)).map(m => m[1] || m[2] || 'position');
    assert.deepStrictEqual(tableOrder.filter(x => x !== 't2' && x !== 't1' && x !== 't3'), ['AAPL', 'position', 'D05', 'position']);
    // under its heading a trade drops the symbol from the line (the label still names the stock)
    const rows = txnRowsOf(html);
    assert.ok(rows[0].includes('<span class="hl-t"><span class="pos">Buy</span> <span class="money-chip">40</span></span>'));
    assert.ok(rows[0].includes('aria-label="Edit Buy 40 AAPL, 05/01/2026,'));
    // the position line: the table's subtotal figures, the realised P&L with its arrow and sign
    const sub = Array.from(html.matchAll(/<tr class="subtotal-row">[\s\S]*?<\/tr>/g)).map(m => m[0]);
    assert.ok(sub[0].includes('<td class="num">60</td>') && sub[0].includes('<td class="num"><span class="pos">▲ +US$1,395</span></td>'));
    const totals = Array.from(list.matchAll(/<div class="hl-total">[\s\S]*?<\/span><\/div>/g)).map(m => m[0]);
    assert.strictEqual(totals.length, 2);
    assert.ok(totals[0].includes('<span class="hl-t">Position</span><span class="hl-s"><span class="money-chip">60</span> shares · avg <span class="money-chip">US$150.00</span></span>'));
    assert.ok(totals[0].includes('<span class="hl-amt money-chip up">▲ +US$1,395</span><span class="dash-sub">realised P&amp;L</span>'));
    assert.ok(totals[1].includes('<span class="hl-amt money-chip up">US$0</span>'));      // nothing realised yet reads as the table does: the gain class, no arrow
    // a loss is an arrow and a minus as well as red
    sb.DB.stockTxns.push({ id:'t4', stockId:'s_aapl', date:'2026-04-01', side:'sell', shares:60, price:100, fees:0, notes:'' });
    sb.renderStockTxns();
    const loss = els['stocks-ledger'].innerHTML;
    assert.ok(/<span class="neg">▼ -US\$[\d,]+<\/span>/.test(loss) && /<span class="hl-amt money-chip down">▼ -US\$[\d,]+<\/span>/.test(loss));
    // the flat list is back when the view is
    vm.runInContext("_ledgerView = 'flat';", sb);
    sb.renderStockTxns();
    assert.strictEqual(els['stocks-ledger'].innerHTML.includes('hl-group'), false);
  });

  test('renderStockTxns - the empty states are the card\'s own with no list, and a trade for a stock that is gone still shows, with a dash for the symbol', () => {
    const { sb, els } = txnSandbox();
    sb.DB.stockTxns = [];
    sb.renderStockTxns();
    assert.ok(els['stocks-ledger'].innerHTML.includes('No trades logged') && !els['stocks-ledger'].innerHTML.includes('hl-row') && !els['stocks-ledger'].innerHTML.includes('hd-only'));
    assert.ok(els['stocks-ledger'].innerHTML.includes('＋ Add trade'));                 // the head, and its controls, are still there
    sb.DB.stocks = [];
    sb.renderStockTxns();
    assert.strictEqual(els['stocks-ledger'].innerHTML, '');
    const orphan = txnSandbox({ stocks:[{ id:'s_a', symbol:'AAPL', market:'US', currency:'USD', shares:1, avgCost:1 }], stockTxns:[{ id:'t9', stockId:'s_gone', date:'2026-05-01', side:'buy', shares:2, price:3 }] });
    orphan.sb.renderStockTxns();
    const rows = txnRowsOf(orphan.els['stocks-ledger'].innerHTML);
    assert.strictEqual(rows.length, 1);
    assert.ok(rows[0].includes('<span class="pos">Buy</span> <span class="money-chip">2</span> ' + '—') && !/undefined|NaN/.test(rows[0]));
  });

  test('_stockTxnView, _stockPositionView and the row builders - one definition of a trade, hostile text escaped once, an unknown side counts as a buy as the table does', () => {
    const sb = listSandbox({}, 'USD');
    const symbolOf = id => ({ a:'AAPL', e:'<b>EVIL</b>' })[id] || '—';
    const ccyOf = id => id === 'e' ? 'SGD' : 'USD';
    const v = navPlain(sb._stockTxnView({ id:'t', stockId:'a', date:'2026-05-02', side:'sell', shares:'3', price:'10', fees:'1', notes:null }, symbolOf, ccyOf));
    assert.deepStrictEqual(v, { id:'t', dateText:'02/05/2026', sym:'AAPL', sell:true, side:'Sell', cls:'neg', qty:3, priceText:'US$10.00', feesText:'US$1.00', valueText:'US$29', notes:'' });
    const odd = navPlain(sb._stockTxnView({ id:'u', stockId:'e', side:'weird', shares:'x', price:null }, symbolOf, ccyOf));
    assert.deepStrictEqual([odd.side, odd.cls, odd.qty, odd.feesText, odd.valueText, odd.sym], ['Buy', 'pos', 0, '', 'US$0', '<b>EVIL</b>']);
    const row = sb._stockTxnRowHtml(Object.assign(odd, { notes:'<script>1</script>', id:'"><x' }), true);
    assert.strictEqual(/<b>EVIL|<script|<x/.test(row), false);
    assert.ok(row.includes('&lt;b&gt;EVIL&lt;/b&gt;') && row.includes('&lt;script&gt;1&lt;/script&gt;') && row.includes('data-edit-id="&quot;&gt;&lt;x"'));
    assert.strictEqual(/aria-label="[^"]*"[^>]*aria-label=/.test(row), false);
    assert.deepStrictEqual(navPlain(sb._stockPositionView({ shares:12.5, avgCost:100, realisedPL:-40 }, 'USD')), { shares:12.5, avgText:'US$100.00', plText:'▼ -US$40', plCls:'neg' });
    assert.deepStrictEqual(navPlain(sb._stockPositionView({ shares:1, avgCost:1, realisedPL:0 }, 'SGD')), { shares:1, avgText:'US$0.80', plText:'US$0', plCls:'pos' });
    assert.strictEqual(sb._stockGroupHtml('<b>x</b>', 1), '<div class="hl-group" role="heading" aria-level="4"><span class="hl-group-t">&lt;b&gt;x&lt;/b&gt;</span><span class="hl-group-n">1 trade</span></div>');
    assert.ok(sb._stockGroupHtml('A', 0).includes('0 trades') && sb._stockGroupHtml('A', 2).includes('2 trades'));
  });

  test('Stocks page ledgers - the phone styles live in the 640px block: the Watchlist row is a div of two controls, a trade row a button, the by-stock heading a band, and above 640px none of it shows', () => {
    const start = indexSrc.indexOf('/* MOBILE LIST ROWS, CHIP FILTERS AND ACTIONS (v2.73)');
    const css = indexSrc.slice(start, indexSrc.indexOf('</style>', start));
    const phone = css.slice(css.indexOf('@media (max-width:640px){'), css.indexOf('/* At 360px and below the share drops its words'));
    ['.hl-split{cursor:default}', '.hl-hit{display:grid;grid-template-columns:minmax(0,1fr) auto;', '.hl-hit:focus-visible{outline:2px solid var(--accent);outline-offset:2px}', '.hl-go{justify-self:end}',
      '.hl-dates{display:flex;flex-wrap:wrap;column-gap:10px}', '.hl-dates > span{white-space:nowrap}',
      '.hl-group{margin-top:10px;', '.hl-group-t{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}', '.card-body.hl-host{padding:0}', '.hl-total .hl-s{font-weight:400}']
      .forEach(rule => assert.ok(phone.includes(rule), rule));
    assert.ok(css.includes('.m-actions,.m-more,.chip-row,.hl,.m-fresh{display:none}'));      // above 640px every list is hidden, the tables carry the page
    // the row of five card-head controls wraps, it never widens the card
    assert.ok(indexSrc.includes('.card-head{flex-wrap:wrap}'));
    // no stray inline handlers in the three renderers
    ['renderWatchlist', 'renderDividendTimeline', 'renderStockTxns', '_wlRowHtml', '_dividendRowHtml', '_stockTxnRowHtml', '_stockPositionRowHtml', '_stockGroupHtml'].forEach(fn => {
      const src = extractFunction(fn);
      assert.strictEqual(/\son[a-z]+="/i.test(src.replace(/\bon[A-Z]\w+\s*=/g, '')), false, fn);
    });
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
    assert.strictEqual(hidden, 8);                                                 // Stocks, Crypto, Cash accounts, Cash movements, CPF history, and (v2.76) Watchlist, Upcoming dividends, Trade history
    ['renderStocks', 'renderCrypto', 'renderCash', 'renderCashTxns', 'renderCpf', 'renderWatchlist', 'renderDividendTimeline', 'renderStockTxns'].forEach(fn => {
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
    // the hover rule really moves the dim text up a step (v2.77: the row re-points --text3 at --text2, so the currency prefix and every other dim part follow, on the
    // desktop dashboard rows as well as the phone lists, and a touch press does the same)
    assert.ok(indexSrc.includes('@media (hover:hover){.dash-hrow:not(.dash-hhead):hover{--text3:var(--text2)}}'));
    assert.ok(indexSrc.includes('@media (hover:none){.hl-row:active{background-color:var(--bg3);--text3:var(--text2)}}'));
    assert.strictEqual(indexSrc.includes('.hl-row:hover .dash-sub'), false);
  });

  test('light --text3 (v2.76, kept in v2.77) - clears 4.5:1 on the page surfaces, dark keeps its value, the rules that put dim text on --bg4 take --text2, and the comments quote the real ratios', () => {
    const block = s => { const i = indexSrc.indexOf(s); assert.ok(i > -1, s); return indexSrc.slice(i, indexSrc.indexOf('\n}', i)); };
    const light = block(':root{'), dark = block('html.dark{');
    const token = (blk, name) => { const m = new RegExp('--' + name + ':([^;]+);').exec(blk); assert.ok(m, '--' + name + ' missing'); return m[1].trim(); };
    const rgb = h => { h = h.replace('#', ''); return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)); };
    const lin = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    const lum = c => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
    const ratio = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
    assert.strictEqual(token(light, 'text3').toLowerCase(), '#6f6a60');
    assert.strictEqual(token(dark, 'text3'), '#7C87A0');                             // dark is left as it was
    const t3 = rgb(token(light, 'text3'));
    // the figures the comments quote are the figures the tokens give
    [['bg', '4.89'], ['bg2', '5.38'], ['bg3', '4.59'], ['sidebar', '4.55']].forEach(([n, quoted]) => {
      const r = ratio(t3, rgb(token(light, n)));
      assert.ok(r >= 4.5, 'light --text3 on --' + n + ' ' + r.toFixed(2));
      assert.strictEqual(r.toFixed(2), quoted, n);
    });
    assert.ok(indexSrc.includes('4.89:1 on --bg, 5.38 on --bg2, 4.59 on --bg3 and 4.55 on --sidebar'));
    // on --bg4 it is 4.23, and the v2.77 --text2 (6.21 there) clears it, so the rules that put dim text on --bg4 take --text2 (v2.76 had to step up to --text, the old --text2 was only 4.48)
    const bg4 = rgb(token(light, 'bg4'));
    assert.strictEqual(ratio(t3, bg4).toFixed(2), '4.23');
    assert.strictEqual(ratio(rgb(token(light, 'text2')), bg4).toFixed(2), '6.21');
    // no rule sets a --text3 or --tx3 colour and a --bg4 background together any more: the not-applicable coverage pill is --text2 in both themes, with no light-only override
    const css = indexSrc.slice(indexSrc.indexOf('<style>'), indexSrc.indexOf('</style>')).replace(/\/\*[\s\S]*?\*\//g, '');
    const rules = Array.from(css.matchAll(/([^{}]+)\{([^{}]*)\}/g)).map(m => ({ sel: m[1].trim(), body: m[2] }));
    const onBg4 = rules.filter(r => /(^|;)\s*background(-color)?:\s*var\(--bg4\)/.test(r.body) && /(^|;)\s*color:\s*var\(--(text3|tx3)\)/.test(r.body));
    assert.deepStrictEqual(onBg4.map(r => r.sel), []);
    const na = rules.find(r => r.sel === '.cov-pill.na');
    assert.ok(na && /(^|;)\s*color:\s*var\(--text2\)\s*(;|$)/.test(na.body) && /background:\s*var\(--bg4\)/.test(na.body));
    assert.strictEqual(rules.some(o => o.sel === 'html:not(.dark) .cov-pill.na'), false);
    // the other one is a hover: the palette pill goes from --bg3 to --bg4 and its label (--text3) rides along, so the hovered label takes --text2, and in dark the label does at rest too
    assert.ok(rules.some(o => o.sel === '.cb-field-pill:hover' && /background:\s*var\(--bg4\)/.test(o.body)));
    assert.ok(rules.some(o => o.sel === '.cb-field-pill .pill-type' && /color:\s*var\(--text3\)/.test(o.body)));
    assert.ok(rules.some(o => o.sel === '.cb-field-pill:hover .pill-type,html.dark .cb-field-pill .pill-type' && /^\s*color:\s*var\(--text2\)\s*$/.test(o.body)));
    assert.strictEqual(rules.some(o => o.sel === 'html:not(.dark) .cb-field-pill:hover .pill-type'), false);
    // no other rule puts --bg4 behind text of its own, so these are every case (the others are tracks, borders and the skeleton shimmer)
    const bg4Rules = rules.filter(r => /var\(--bg4\)/.test(r.body)).map(r => r.sel);
    assert.deepStrictEqual(bg4Rules.sort(), ['.cb-field-pill:hover', '.cov-pill.na', '.hp-foot .btn:not(.btn-primary):hover', '.kjr-arrange-move:hover:not(:disabled)', '.px-ext-tag', '.skel', '.switch-track', 'td']);
    // the comments that quoted the old ratios say what the ratios are now
    assert.strictEqual(/Light --text3 is only 3\.83:1/.test(indexSrc), false);
    assert.strictEqual(/--text3 is under 4\.5:1 on --bg3 in the light theme/.test(indexSrc), false);
    assert.ok(indexSrc.includes('--text3 is 4.59:1 on --bg3 in light and 4.26:1 in dark, --text2 is 6.74:1 and 6.14:1'));
    assert.strictEqual(indexSrc.includes('--text2 is 4.87:1 and 6.14:1'), false);
    const dark3 = rgb(token(dark, 'text3')), dark2 = rgb(token(dark, 'text2')), darkBg3 = rgb(token(dark, 'bg3'));
    assert.strictEqual(ratio(dark3, darkBg3).toFixed(2), '4.26');
    assert.strictEqual(ratio(dark2, darkBg3).toFixed(2), '6.14');
    assert.strictEqual(ratio(rgb(token(light, 'text2')), rgb(token(light, 'bg3'))).toFixed(2), '6.74');
  });

  /* ═══════════════════════════════════════════════════════════════════════
     v2.77 polish: the light --text2 step, dim text on the dark tints, and the target on a phone Watchlist row.
     Light --text2 is #55514a (7.17:1 on --bg), so there are two distinct dim levels again, and the two rules that had to step up to --text on --bg4 go back to --text2.
     The dark surfaces that carried --text3 under 4.5:1 (--bg3, --bg4, a hovered table row) re-point it at --text2. Ratios come from the declared tokens, composited the way
     the browser stacks them (the same maths as the v2.76 tests above), and the stylesheet is read as text.
     ═══════════════════════════════════════════════════════════════════════ */
  const p277 = (() => {
    const rgb = h => { h = h.replace('#', ''); return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)); };
    const lin = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    const lum = c => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
    const ratio = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
    const over = (top, alpha, bottom) => top.map((v, i) => v * alpha + bottom[i] * (1 - alpha));
    const block = s => { const i = indexSrc.indexOf(s); assert.ok(i > -1, s); return indexSrc.slice(i, indexSrc.indexOf('\n}', i)); };
    const light = block(':root{'), dark = block('html.dark{');
    const hex = (blk, name) => { const m = new RegExp('--' + name + ':([^;]+);').exec(blk); assert.ok(m, '--' + name + ' missing'); return m[1].trim(); };
    const rgba = v => { const m = /rgba\((\d+),(\d+),(\d+),([\d.]+)\)/.exec(v); assert.ok(m, v); return { c:[+m[1], +m[2], +m[3]], a:+m[4] }; };
    const scrim = +/\.overlay\{[^}]*background:rgba\(0,0,0,([\d.]+)\)/.exec(indexSrc)[1];
    /* Every surface a text colour can sit on in a theme: the solid tokens, the glass top bar over the page and over a card, and the More sheet and its rows (glass over the scrim). */
    const surfaces = blk => {
      const s = {};
      ['bg', 'bg2', 'bg3', 'bg4', 'sidebar', 'red-soft', 'blue-soft', 'green-soft', 'amber-soft', 'accent-soft'].forEach(n => { s[n] = rgb(hex(blk, n)); });
      const glass = rgba(hex(blk, 'glass')), strong = rgba(hex(blk, 'glass-strong')), solid = hex(blk, 'surface-solid');
      s['surface-solid'] = solid.charAt(0) === '#' ? rgb(solid) : over(rgba(solid).c, rgba(solid).a, s.bg);
      s['bar over bg'] = over(glass.c, glass.a, s.bg);
      s['bar over bg2'] = over(glass.c, glass.a, s.bg2);
      s.sheet = over(strong.c, strong.a, over([0, 0, 0], scrim, s.bg));
      s['sheet row'] = over(glass.c, glass.a, s.sheet);
      return s;
    };
    // the stylesheet without its comments, as flat rules (a rule inside @media is its own entry)
    const css = indexSrc.slice(indexSrc.indexOf('<style>'), indexSrc.indexOf('</style>')).replace(/\/\*[\s\S]*?\*\//g, '');
    const rules = Array.from(css.matchAll(/([^{}]+)\{([^{}]*)\}/g)).map(m => ({ sel: m[1].trim(), body: m[2].trim() }));
    return { rgb, ratio, over, light, dark, hex, rgba, surfaces, rules };
  })();

  test('light --text2 (v2.77) - a second dim level again: #55514a clears 4.5:1 on every light surface, sits a clear step between --text3 and --text, and the comments and the Design tokens line quote the real figures', () => {
    const { rgb, ratio, light, dark, hex, surfaces } = p277;
    assert.strictEqual(hex(light, 'text2').toLowerCase(), '#55514a');
    assert.strictEqual(hex(light, 'text3').toLowerCase(), '#6f6a60');                // --text3 itself is not touched
    assert.strictEqual(hex(light, 'text').toLowerCase(), '#1f1d1a');
    assert.strictEqual(hex(dark, 'text2'), '#9AA4BA');
    assert.strictEqual(hex(dark, 'text3'), '#7C87A0');
    const t = rgb(hex(light, 'text')), t2 = rgb(hex(light, 'text2')), t3 = rgb(hex(light, 'text3'));
    // 4.5:1 or better on every surface a light text colour can sit on, the grey More sheet included
    const s = surfaces(light);
    assert.deepStrictEqual(Object.keys(s).sort(), ['accent-soft', 'amber-soft', 'bar over bg', 'bar over bg2', 'bg', 'bg2', 'bg3', 'bg4', 'blue-soft', 'green-soft', 'red-soft', 'sheet', 'sheet row', 'sidebar', 'surface-solid']);
    Object.keys(s).forEach(n => assert.ok(ratio(t2, s[n]) >= 4.5, 'light --text2 on ' + n + ' ' + ratio(t2, s[n]).toFixed(2)));
    // the figures the comments quote are the figures the tokens give
    [['bg', '7.17'], ['bg2', '7.89'], ['bg3', '6.74'], ['bg4', '6.21'], ['sidebar', '6.68'], ['sheet', '5.48'], ['sheet row', '6.86'], ['bar over bg', '7.60'], ['bar over bg2', '7.89']]
      .forEach(([n, quoted]) => assert.strictEqual(ratio(t2, s[n]).toFixed(2), quoted, n));
    ['Light --text2 (v2.77) is 7.17:1 on --bg, 6.21 on --bg4 and 5.48 on the grey More sheet', 'so light keeps --text2 (6.68:1)', '--text2 is 7.60:1 and 7.89:1', '--text2 (6.86:1 light, 6.34:1 dark)', 'where --text2 is 5.48:1 in light and 7.19:1 in dark']
      .forEach(frag => assert.ok(indexSrc.includes(frag), frag));
    // the step: 6.5 to 7.5:1 on --bg, a clear ratio step either side, and RGB channels well apart (v2.76 had --text2 four channel values from --text3, so the two read as one grey)
    assert.ok(ratio(t2, s.bg) >= 6.5 && ratio(t2, s.bg) <= 7.5, 'light --text2 on --bg ' + ratio(t2, s.bg).toFixed(2));
    assert.ok(ratio(t2, s.bg) / ratio(t3, s.bg) >= 1.4);
    assert.ok(ratio(t, s.bg) / ratio(t2, s.bg) >= 2);
    [0, 1, 2].forEach(i => { assert.ok(t3[i] - t2[i] >= 20, 'channel ' + i + ' of --text3 over --text2'); assert.ok(t2[i] - t[i] >= 40, 'channel ' + i + ' of --text2 over --text'); });
    assert.ok(t2[0] >= t2[1] && t2[1] >= t2[2]);                                       // a warm neutral, as --text and --text3 are
    // dark --text2 clears 4.5:1 on every dark surface too, --bg4 (where --text3 does not) included
    const ds = surfaces(dark), d2 = rgb(hex(dark, 'text2'));
    Object.keys(ds).forEach(n => assert.ok(ratio(d2, ds[n]) >= 4.5, 'dark --text2 on ' + n + ' ' + ratio(d2, ds[n]).toFixed(2)));
    assert.strictEqual(ratio(d2, ds.bg4).toFixed(2), '5.20');
    // the Design tokens line in the app's CLAUDE.md quotes the new value and no longer the v2.76 workaround
    const doc = fs.readFileSync(path.join(__dirname, '..', 'CLAUDE.md'), 'utf8');
    assert.ok(doc.includes('#55514a') && doc.includes('#6f6a60'));
    assert.strictEqual(doc.includes('steps up to `--text` in light'), false);
  });

  test('dim text on the --bg3, --bg4 and hover tints (v2.77) - the rules that carried --text3 there take --text2, each pairing clears 4.5:1, and no rule can put --text3 on --bg3 or --bg4 unnoticed', () => {
    const { rgb, ratio, over, light, dark, hex, rgba, rules } = p277;
    const pick = (blk, n) => rgb(hex(blk, n));
    const l2 = pick(light, 'text2'), l3 = pick(light, 'text3'), d2 = pick(dark, 'text2'), d3 = pick(dark, 'text3');
    // why: dark --text3 is under 4.5:1 on --bg3 and --bg4, light --text3 is under it on --bg4, and --text2 clears all three
    assert.strictEqual(ratio(d3, pick(dark, 'bg3')).toFixed(2), '4.26');
    assert.strictEqual(ratio(d3, pick(dark, 'bg4')).toFixed(2), '3.62');
    assert.strictEqual(ratio(l3, pick(light, 'bg4')).toFixed(2), '4.23');
    assert.strictEqual(ratio(d2, pick(dark, 'bg3')).toFixed(2), '6.14');
    assert.strictEqual(ratio(d2, pick(dark, 'bg4')).toFixed(2), '5.20');
    assert.strictEqual(ratio(l2, pick(light, 'bg4')).toFixed(2), '6.21');
    // a hovered table row in dark: --surface-solid at 93% and --text at 7% (premultiplied, as color-mix does), over the card
    const tx = pick(dark, 'text'), sa = rgba(hex(dark, 'surface-solid'));
    const alpha = 0.93 * sa.a + 0.07, mixed = [0, 1, 2].map(i => (0.93 * sa.c[i] * sa.a + 0.07 * tx[i]) / alpha);
    const tint = over(mixed, alpha, pick(dark, 'bg2'));
    assert.strictEqual(ratio(d3, tint).toFixed(2), '4.05');
    assert.strictEqual(ratio(d2, tint).toFixed(2), '5.83');
    assert.ok(ratio(d3, tint) < 4.5 && ratio(d2, tint) >= 4.5);
    ['Dark --text3 is 4.05:1 on that 7% hover tint (--text2 is 5.83:1)', 'Dark --text3 is 4.26:1 on the popover\'s --bg3', 'On --bg4 --text3 is 4.23:1 in light and 3.62:1 in dark, so the pill takes --text2 in both themes (6.21:1 and 5.20:1)']
      .forEach(frag => assert.ok(indexSrc.includes(frag), frag));
    const body = sel => { const r = rules.find(o => o.sel === sel); assert.ok(r, sel + ' rule missing'); return r.body; };
    // the not-applicable coverage pill is --text2 in both themes, and no light-only override is left (v2.76 had two, and the version line)
    assert.ok(/(^|;)color:var\(--text2\)(;|$)/.test(body('.cov-pill.na')) && /(^|;)background:var\(--bg4\)(;|$)/.test(body('.cov-pill.na')));
    assert.strictEqual(rules.some(o => /^html:not\(\.dark\) \.(cov-pill\.na|cb-field-pill:hover \.pill-type|sheet-version)/.test(o.sel)), false);
    // the palette pill's label: --text2 while hovered (on --bg4) in both themes, and at rest in dark (on --bg3), --text3 at rest in light
    assert.strictEqual(body('.cb-field-pill:hover .pill-type,html.dark .cb-field-pill .pill-type'), 'color:var(--text2)');
    assert.ok(/(^|;)color:var\(--text3\)(;|$)/.test(body('.cb-field-pill .pill-type')));
    // the dark surfaces that hold dim parts of their own re-point --text3 (and the --tx3 alias) at --text2 on themselves, so every dim part inside follows without a rule per part
    const repoint = '--text3:var(--text2);--tx3:var(--text2)';
    ['html.dark .info-pop', 'html.dark .ins-rider-row td', 'html.dark tbody tr:hover td'].forEach(sel => assert.strictEqual(body(sel), repoint, sel));
    assert.ok(indexSrc.includes('@media (hover:hover){html.dark tbody tr:hover td{' + repoint + '}}'));
    // a hovered dashboard or phone row (on --bg3, both themes) and a pressed phone row do the same, and the v2.76 list of named children is gone
    assert.strictEqual(body('.dash-hrow:not(.dash-hhead):hover'), '--text3:var(--text2)');
    assert.ok(indexSrc.includes('@media (hover:hover){.dash-hrow:not(.dash-hhead):hover{--text3:var(--text2)}}'));
    assert.strictEqual(body('.hl-row:active'), 'background-color:var(--bg3);--text3:var(--text2)');
    assert.strictEqual(indexSrc.includes('.hl-row:hover .'), false);
    // fence: the only rules that set a --text3 or --tx3 colour on a --bg3 or --bg4 fill themselves are a disabled button and two empty-state icons, which the text rule exempts
    // (a disabled control is inactive, an icon is a graphic that needs 3:1 and has 4.26:1). Any new rule that does it fails here and has to be thought through.
    const on = bg => rules.filter(r => new RegExp('(^|;)background(-color)?:var\\(--' + bg + '\\)(;|$)').test(r.body) && /(^|;)color:var\(--(text3|tx3)\)(;|$)/.test(r.body)).map(r => r.sel).sort();
    assert.deepStrictEqual(on('bg4'), []);
    assert.deepStrictEqual(on('bg3'), ['.btn:disabled', '.empty-icon', '.hp-empty-icon']);
    assert.ok(ratio(d3, pick(dark, 'bg3')) >= 3);
  });

  test('renderWatchlist target (v2.77) - a phone row reads one target piece (a check mark in front when the price is at it, the Target figure the table prints, its amount in a money chip as td.num is) and then the note, prints nothing when no target is set, and the spoken label carries the target and the at-target phrase', () => {
    const fixture = {
      watchlist:[
        { id:'w_msft', symbol:'MSFT', market:'US', targetPrice:300, notes:'Wait for a pullback' },    // price 290.50, at target, with a note
        { id:'w_above', symbol:'ABOVE', market:'US', targetPrice:250 },                                // price 290, above the target, no note
        { id:'w_d05', symbol:'D05', market:'SGX', targetPrice:20, notes:'' },                          // an SGX target is in SGD and shows in the display currency
        { id:'w_noq', symbol:'NOQT', market:'US', targetPrice:12.5 },                                  // a target and no quote
        { id:'w_str', symbol:'STR', market:'US', targetPrice:'45.5', notes:'string target' },          // a numeric string, read as the table reads it
        { id:'w_blank', symbol:'BLANK', market:'US', targetPrice:'', notes:'blank' },
        { id:'w_nan', symbol:'NAN', market:'US', targetPrice:'abc', notes:'not a number' },
        { id:'w_none', symbol:'NONE', market:'US', notes:'none set' },
        { id:'w_null', symbol:'NULLT', market:'US', targetPrice:null }
      ],
      _priceCache:{
        MSFT:{ price:290.5, currency:'USD', changePct:-1.42, fetchedAt:TODAY_ISO }, ABOVE:{ price:290, currency:'USD', changePct:1, fetchedAt:TODAY_ISO },
        D05:{ price:36.4, currency:'SGD', changePct:0.5, fetchedAt:TODAY_ISO }, STR:{ price:50, currency:'USD', changePct:0, fetchedAt:TODAY_ISO }
      }
    };
    const bySym = rows => { const out = {}; rows.forEach(r => { out[/<span class="hl-t">([^<]*)</.exec(r)[1].trim()] = r; }); return out; };
    const subOf = r => /<span class="hl-s">([\s\S]*?)<\/span><\/span><span class="hl-end">/.exec(r)[1];
    const labelOf = r => /aria-label="([^"]*)">/.exec(r)[1];
    const piece = (fig, hit) => '<span class="hl-tgt">' + (hit ? '✓ ' : '') + 'Target <span class="money-chip">' + fig + '</span></span>';   // the one box: check mark, the word, the amount
    const note = text => '<span class="hl-nt">· ' + text + '</span>';                                                                              // the note after a dot, the only part with an ellipsis
    const { sb, els } = wlSandbox(fixture, 'USD');
    sb.renderWatchlist();
    const html = els['stocks-watchlist'].innerHTML, rows = bySym(wlRowsOf(html));
    assert.strictEqual(Object.keys(rows).length, 9);
    // the figure is the table's Target cell figure from the same formatter: the amount before the At target flag
    const tableTarget = sym => wlTableCells(html, sym)[7][1].split(' <span class="wl-hit">')[0];
    assert.strictEqual(subOf(rows.MSFT), piece('US$300.00', true) + note('Wait for a pullback'));               // at target: the check mark joins the target in one box, then the note
    assert.strictEqual(tableTarget('MSFT'), 'US$300.00');
    assert.strictEqual(subOf(rows.ABOVE), piece('US$250.00'));                                                    // above the target: no check mark, no note, the target alone
    assert.strictEqual(tableTarget('ABOVE'), 'US$250.00');
    assert.strictEqual(subOf(rows.D05), piece('US$16.00'));                                                       // 20 SGD at 0.8, as the table's cell does
    assert.strictEqual(tableTarget('D05'), 'US$16.00');
    assert.strictEqual(subOf(rows.NOQT), piece('US$12.50'));                                                      // no quote, the target still shows
    assert.strictEqual(tableTarget('NOQT'), 'US$12.50');
    assert.strictEqual(subOf(rows.STR), piece('US$45.50') + note('string target'));
    assert.strictEqual(tableTarget('STR'), 'US$45.50');
    // the old words are gone from the line (the check mark is the sign, and the spoken label says "at target price"), and the target is never split across boxes
    assert.strictEqual(/At target/.test(Object.values(rows).map(subOf).join('')), false);
    assert.strictEqual((subOf(rows.MSFT).match(/hl-tgt/g) || []).length, 1);
    // the spoken label carries the target, before the at-target phrase and the note
    assert.strictEqual(labelOf(rows.MSFT), 'Edit MSFT, US, price US$290.50, day -1.42%, target price US$300.00, at target price, Wait for a pullback');
    assert.strictEqual(labelOf(rows.ABOVE), 'Edit ABOVE, US, price US$290.00, day +1.00%, target price US$250.00');
    assert.strictEqual(labelOf(rows.NOQT), 'Edit NOQT, US, price not available, target price US$12.50');
    // Hide amounts: the amount is a chip (blurred as the table's td.num cell is), the check mark and the word Target are not, and nothing else in the sub line is
    assert.ok(/<span class="hl-tgt">(✓ )?Target <span class="money-chip">[^<]+<\/span><\/span>/.test(subOf(rows.MSFT)));
    assert.strictEqual((subOf(rows.MSFT).match(/money-chip/g) || []).length, 1);
    assert.ok(wlTableCells(html, 'MSFT')[7][0] === 'num');
    // no target set (missing, null, blank, not a number) means no target text, in the line and in the label, and never NaN or a 0.00
    ['NONE', 'NULLT', 'BLANK', 'NAN'].forEach(sym => {
      assert.strictEqual(/Target|hl-tgt|NaN|undefined|0\.00/.test(subOf(rows[sym])), false, sym + ' sub line');
      assert.strictEqual(/target/i.test(labelOf(rows[sym])), false, sym + ' label');
    });
    assert.strictEqual(subOf(rows.NONE), '<span class="hl-nt">none set</span>');                                    // a note alone has no dot in front of it
    assert.strictEqual(subOf(rows.NULLT), '');
    assert.strictEqual(subOf(rows.BLANK), '<span class="hl-nt">blank</span>');
    assert.strictEqual(subOf(rows.NAN), '<span class="hl-nt">not a number</span>');
    // the pure model: an empty target and no FX flag when none is set, the formatter's own text when it is
    const m = (w, px, ccy) => navPlain(sb._wlListModel({ w, px, ccy: ccy || 'USD' }));
    assert.deepStrictEqual([m({ id:'a' }, null).target, m({ id:'a' }, null).targetFx, m({ id:'a', targetPrice:'' }, null).target, m({ id:'a', targetPrice:'  ' }, null).target, m({ id:'a', targetPrice:'x' }, null).target], ['', false, '', '', '']);
    assert.strictEqual(m({ id:'a', targetPrice:99.5 }, null).target, 'US$99.50');
    // a missing FX rate keeps the native amount in the dim italic (as the price does) and the label says so once
    const fx = wlSandbox(Object.assign({}, fixture, { settings:{ fxOverrides:{}, fxRates:{} } }), 'SGD');
    fx.sb.renderWatchlist();
    const fxRows = bySym(wlRowsOf(fx.els['stocks-watchlist'].innerHTML));
    assert.strictEqual(subOf(fxRows.MSFT), piece('<span class="price-stale">USD 300.00</span>', true) + note('Wait for a pullback'));
    assert.strictEqual(labelOf(fxRows.MSFT), 'Edit MSFT, US, price USD 290.50, FX rate missing, day -1.42%, target price USD 300.00, at target price, Wait for a pullback');
    assert.strictEqual(labelOf(fxRows.NOQT), 'Edit NOQT, US, price not available, target price USD 12.50, FX rate missing');
    assert.strictEqual(m({ id:'a', targetPrice:5 }, { price:9, fetchedAt:TODAY_ISO }, 'USD').targetFx, false);
    // at target with no figure to print (a blank target and a price of zero is the one way in): the piece falls back to the words, so the sign is never lost
    const odd = sb._wlRowHtml(m({ id:'odd', symbol:'ODD', targetPrice:' ' }, { price:0, fetchedAt:TODAY_ISO }));
    assert.ok(odd.includes('<span class="hl-s"><span class="hl-tgt">✓ At target</span></span>') && /aria-label="[^"]*at target price/.test(odd));
    // the CSS: the second line is a flex line whose target box wraps out whole (and a clip keeps the wrapped line, with its blur, out of sight), the note is the only part with an
    // ellipsis, the base .hl-s the other lists use is untouched, and at 480px and below the line takes the row's whole width so the target shows whole at 320px
    assert.ok(indexSrc.includes('.hl-s{display:block;overflow:hidden;font-size:12px;line-height:1.4;color:var(--text3);text-overflow:ellipsis;white-space:nowrap}'));
    ['.hl-split .hl-s{display:flex;flex-wrap:wrap;row-gap:3em;max-height:1.4em}', ".hl-split .hl-s:not(:empty)::before{content:'';flex:none;height:1.4em}", '.hl-tgt{flex:none;white-space:nowrap}',
      '.hl-nt{flex:1 1 0;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}', '.hl-tgt + .hl-nt{margin-left:.25em}']
      .forEach(frag => assert.ok(indexSrc.includes(frag), frag));
    assert.strictEqual(indexSrc.includes('.hl-tgt{display:inline-block}'), false);                                // the v2.77 inline-block draft, whose dropped chip still painted a blur
    const stacked = '@media (max-width:480px){\n  .hl-split .hl-main{display:contents}\n  .hl-split .hl-t{grid-column:1;grid-row:1}\n  .hl-split .hl-end{grid-column:2;grid-row:1}\n  .hl-split .hl-s{grid-column:1 / -1;grid-row:2}\n  .hl-split .hl-s:not(:empty){margin-top:3px}\n}';
    assert.ok(indexSrc.includes(stacked));
    assert.ok(indexSrc.indexOf(stacked) > indexSrc.indexOf('.hl-split .hl-s{display:flex'));                      // after the 640px block, so its equal-specificity grid rules win
    // every typed value still goes through kjrEscape: the target adds no raw interpolation
    const rowSrc = extractFunction('_wlRowHtml');
    assert.ok(rowSrc.includes('kjrEscape(m.note)') && rowSrc.includes("'<span class=\"hl-tgt\">' + (m.atTarget ? '✓ ' : '') + 'Target <span class=\"money-chip\">' + m.target + '</span></span>'"));
  });

  test('release strings - the display version, the cache name and every script tag agree', () => {
    const ver = vm.runInContext('APP_VERSION', freshSandbox());
    assert.ok(/^v\d+\.\d+$/.test(ver));
    const num = ver.slice(1).replace('.', '\\.');
    assert.ok(new RegExp('^' + ver.replace('.', '\\.') + ' \\(\\d{2} [A-Z][a-z]{2}\\)$').test(vm.runInContext('APP_DISPLAY_VERSION', freshSandbox())));
    const sw = fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8');
    assert.ok(sw.includes("const CACHE_NAME = 'kjr-portfolio-" + ver + "';"));
    assert.strictEqual((indexSrc.match(new RegExp('\\.js\\?v=' + num + '"', 'g')) || []).length, 7);
    assert.strictEqual((sw.match(new RegExp('\\.js\\?v=' + num + "'", 'g')) || []).length, 7);
    assert.strictEqual((indexSrc.match(/\.js\?v=[\d.]+"/g) || []).length, 7);
  });

  /* ═══════════════════════════════════════════════════════════════════════
     Step 8a: the holding side panel and the command palette.
     The model and markup builders are pure, so they run on the list sandbox (real fmt and kjrEscape) with a fixed net worth. The overlays (open, close,
     repaint, focus) run against a very small fake DOM.
     ═══════════════════════════════════════════════════════════════════════ */
  const NET_CLASSES = { stocks:6550, cash:10000, cpf:5000, realestate:0, crypto:0, insurance:0 };   // 21,550 with CPF, 16,550 without

  /* The list sandbox plus the state the new code reads, a fixed net worth and a quiet clock. */
  function panelSandbox(db, ccy){
    const sb = listSandbox(db, ccy || 'SGD');
    vm.runInContext('var _hp = null; var _hpHistSeq = 0; var _cp = null; var _dashShowCpf = false; var _stockChartRows = [];', sb);
    sb._netWorthValueInfo = () => ({ classes:Object.assign({}, NET_CLASSES), total:21550, incomplete:false });
    sb.relTime = () => '3d ago';
    sb.kjrFmtAxis = core.kjrFmtAxis;
    return sb;
  }

  /* The stock fixture with what the panel shows: AAPL pays US$2 a share, has a name and a day move (100 against a close of 98), and the coin BTC. */
  function panelFixture(){
    const f = stockFixture();
    f.stocks[0].divPerShare = 2;
    f._priceCache.AAPL = { price:100, currency:'USD', fetchedAt:TODAY_ISO, shortName:'Apple Inc', previousClose:98, change:2, changePct:2.0408163265306123 };
    f.crypto = [{ id:'c_btc', symbol:'BTC', coingeckoId:'bitcoin', amount:0.25, avgCost:60000, currency:'USD' }];
    f._priceCache.bitcoin = { sgd:152000, usd:112600, change24h:1.8, fetchedAt:TODAY_ISO };
    return f;
  }

  /* A very small fake DOM for the overlays: elements by id with a class list, attributes, an innerHTML that counts its writes (and a fresh .hp-body after each,
     as a real repaint gives), focus() and contains(), and a document that finds them. */
  function fakeDom(ids){
    const doc = { els:{}, activeElement:null, body:{ tagName:'BODY' }, openOverlay:null, found:{},
      getElementById(id){ return this.els[id] || null; },
      querySelector(sel){ return sel === '.overlay.open' ? this.openOverlay : null; },
      querySelectorAll(sel){ return this.found[sel] || []; } };
    ids.forEach(id => {
      const el = { id, tagName:'DIV', attrs:{}, kids:[], writes:0, _html:'', hidden:false, value:'', title:'', textContent:'', body:{ scrollTop:0 },
        classList:{ on:new Set(), add(...n){ n.forEach(x => this.on.add(x)); }, remove(...n){ n.forEach(x => this.on.delete(x)); }, contains(n){ return this.on.has(n); } },
        setAttribute(k, v){ this.attrs[k] = String(v); }, getAttribute(k){ return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; },
        removeAttribute(k){ delete this.attrs[k]; }, focus(){ doc.activeElement = this; }, blur(){ if (doc.activeElement === this) doc.activeElement = doc.body; },
        contains(n){ return n === this || this.kids.indexOf(n) !== -1; },
        querySelector(sel){ return sel === '.hp-body' ? this.body : null; }, querySelectorAll(){ return []; } };
      // a repaint removes what had focus, as the real DOM does, and hands out a fresh scroll body
      Object.defineProperty(el, 'innerHTML', { get(){ return this._html; }, set(v){ this._html = v; this.writes++; this.body = { scrollTop:0 }; if (this.contains(doc.activeElement) && doc.activeElement !== this) doc.activeElement = doc.body; } });
      doc.els[id] = el;
    });
    return doc;
  }

  /* The panel sandbox on a fake DOM, with the modal helpers, toasts and entity modal recorded into calls. No sync connection unless a test sets one. */
  function overlaySandbox(db){
    const sb = panelSandbox(db, 'SGD');
    const doc = fakeDom(['holding-panel', 'hp-panel', 'hp-close', 'hp-record', 'hp-edit', 'hp-retry', 'hp-trades-toggle', 'cmd-palette', 'cp-input', 'cp-list', 'cp-empty', 'cp-status',
      'cp-trigger', 'cp-trigger-m', 'cp-kbd', 'vault-gate', 'nas-auth-gate']);
    const calls = [];
    // the panel's controls sit inside the panel, as they do once it is painted
    doc.els['hp-panel'].kids = ['hp-close', 'hp-record', 'hp-edit', 'hp-retry', 'hp-trades-toggle'].map(id => doc.els[id]);
    sb.document = doc;
    sb.console = { error(){} };   // the sandbox has no console, refreshHoldingPanel logs a failed repaint
    sb.openModalFocus = (overlay, fn) => calls.push(['trap', overlay.id, typeof fn === 'function' ? fn.name : null]);
    sb.closeModalFocus = overlay => calls.push(['release', overlay.id]);
    sb._modalFocusVisible = el => !!(el && el.visible);
    sb.closeShellMenus = () => {};
    sb.showToast = (msg, kind) => calls.push(['toast', msg, kind || '']);
    sb.openEntityModal = (table, id, defaults) => calls.push(['modal', table, id === undefined ? null : id, defaults ? plain(defaults) : null]);
    sb.getSyncUrl = () => '';
    return { sb, doc, calls };
  }

  test('panel figures - decimals follow the value, quantities drop trailing zeros, a share is a percentage that never prints NaN', () => {
    const sb = panelSandbox();
    // two decimals from 1 up, below 1 as many as the value needs (a penny price keeps its third digit), six at most
    [[152.3456, 2], [1, 2], [0.215, 3], [0.2, 2], [0.0425, 4], [0.123456789, 6], [0, 2], [NaN, 2], [-3.5, 2]].forEach(([n, dp]) => assert.strictEqual(sb._hpDp(n), dp, String(n)));
    [[10, 4, '10'], [12.5, 4, '12.5'], [0.25, 8, '0.25'], [1234.5678, 4, '1,234.5678'], [0.123456789, 8, '0.12345679'], ['x', 4, DASH], [undefined, 4, DASH], [Infinity, 4, DASH]]
      .forEach(([n, dp, text]) => assert.strictEqual(sb._hpQty(n, dp), text, String(n)));
    assert.ok(Math.abs(sb._hpShare(1250, 16550) - 7.5528700906) < 1e-6);
    [[null, 100], [100, 0], [100, -5], [100, NaN], [NaN, 100], [undefined, 100], ['5', 100]].forEach(([mv, net]) => assert.strictEqual(sb._hpShare(mv, net), null, mv + ' of ' + net));
    assert.deepStrictEqual([7.5529, null, 0.03, 0, 100, 0.05, undefined, NaN].map(p => sb._hpShareText(p)), ['7.6%', DASH, '<0.1%', '0.0%', '100.0%', '0.1%', DASH, DASH]);
    // an amount in a stated currency is printed as given, never converted (the figure is already in that currency)
    assert.strictEqual(sb._hpMoney(100, 'usd', { dp:2 }), 'US$100.00');
    assert.strictEqual(sb._hpMoney(1250, 'SGD', { dp:0 }), 'S$1,250');
    assert.strictEqual(sb._hpMoney(250, 'SGD', { dp:0, signed:true }), '+S$250');
    assert.strictEqual(sb._hpMoney(-250, 'SGD', { dp:0, signed:true }), '-S$250');
    assert.deepStrictEqual([null, undefined, NaN, Infinity, '5'].map(v => sb._hpMoney(v, 'SGD')), Array(5).fill(DASH));
  });

  test('_hpNetWorth - the figure the dashboard hero shows with Include CPF respected, and a known subtotal flagged', () => {
    const sb = panelSandbox();
    assert.deepStrictEqual(plain(sb._hpNetWorth()), { displayNet:16550, incomplete:false });   // CPF off: stocks and cash
    vm.runInContext('_dashShowCpf = true;', sb);
    assert.deepStrictEqual(plain(sb._hpNetWorth()), { displayNet:21550, incomplete:false });   // CPF on: the CPF class joins
    sb._netWorthValueInfo = () => ({ classes:Object.assign({}, NET_CLASSES), total:21550, incomplete:true });
    assert.strictEqual(sb._hpNetWorth().incomplete, true);
    // the same call the hero makes
    assert.ok(extractFunction('renderDashboard').includes('_allocationData(valuation.classes, _dashShowCpf)'));
    assert.ok(extractFunction('_hpNetWorth').includes('_allocationData(valuation.classes, _dashShowCpf)'));
  });

  test('_holdingPanelModel - a stock: its price in its own currency with the S$ beside it, the day move, and the stats from the row the table reads (CPF off and on)', () => {
    const sb = panelSandbox(panelFixture(), 'USD');   // the Stocks tab on USD must not change the panel
    const row = sb.buildStockChartRows()[0];
    const m = navPlain(sb._holdingPanelModel('stocks', 's_aapl', sb._hpNetWorth()));
    assert.deepStrictEqual({ table:m.table, id:m.id, cls:m.cls, sym:m.sym, sub:m.sub, ysym:m.ysym, ccy:m.ccy, canTrade:m.canTrade }, { table:'stocks', id:'s_aapl', cls:'stocks', sym:'AAPL', sub:'Apple Inc · US', ysym:'AAPL', ccy:'USD', canTrade:true });
    assert.deepStrictEqual(m.price, { has:true, nativeText:'US$100.00', sgdText:'S$125.00', fxMissing:false, staleText:'' });
    // the day: the quote's own percentage (the pill carries an arrow and a sign), and the position's S$ move from the row
    assert.deepStrictEqual(m.day, { dir:'up', pctText:'▲ +2.04%', when:'today', sgdText:'+S$25' });
    assert.strictEqual(row.changeSgd, 25);
    const stat = key => m.stats.find(s => s.key === key);
    assert.deepStrictEqual(m.stats.map(s => s.key), ['holding', 'avgCost', 'value', 'unrealised', 'dividends', 'share']);
    assert.strictEqual(stat('holding').text, '10 shares');
    assert.strictEqual(stat('avgCost').text, 'US$80.00');                 // per share, in the stock's own currency
    assert.strictEqual(stat('value').text, 'S$1,250'); assert.strictEqual(row.mv, 1250);
    assert.deepStrictEqual(stat('unrealised').ret, { dir:'up', pct:'▲ +25.00%', amount:'+S$250' });   // the percentage carries the arrow, the amount only its sign
    assert.strictEqual(row.pl, 250); assert.strictEqual(row.plPct, 25);
    assert.strictEqual(stat('dividends').text, 'S$25');                   // US$2 a share on 10 shares at 1.25
    assert.strictEqual(row.divAnnualSgd, 25);
    // share of net worth: 1,250 over the hero's figure, 16,550 with CPF off and 21,550 with it on
    assert.strictEqual(stat('share').text, '7.6%');
    vm.runInContext('_dashShowCpf = true;', sb);
    assert.strictEqual(navPlain(sb._holdingPanelModel('stocks', 's_aapl', sb._hpNetWorth())).stats.find(s => s.key === 'share').text, '5.8%');
    // an unknown or unsafe id, and a table that is not a holding, give no model
    ['s_gone', '', null, undefined, 'a b', '<img>'].forEach(id => assert.strictEqual(sb._holdingPanelModel('stocks', id, {}), null, String(id)));
    ['cash', 'cpfHistory', '', null, 'constructor', '__proto__'].forEach(t => assert.strictEqual(sb._holdingPanelModel(t, 's_aapl', {}), null, String(t)));
  });

  test('_holdingPanelModel - an SGD stock shows no second price line, a stock without a dividend has no Dividends stat, a stale price says how old it is', () => {
    const f = panelFixture();
    f._priceCache.D05 = { price:35, currency:'SGD', fetchedAt:new Date(Date.now() - 3 * 86400000).toISOString() };
    const sb = panelSandbox(f);
    const m = navPlain(sb._holdingPanelModel('stocks', 's_d05', sb._hpNetWorth()));
    assert.deepStrictEqual(m.price, { has:true, nativeText:'S$35.00', sgdText:'', fxMissing:false, staleText:'Last updated 3d ago' });
    assert.strictEqual(m.sub, 'SGX · Financials');                        // no quote name, so the market and sector
    assert.deepStrictEqual(m.stats.map(s => s.key), ['holding', 'avgCost', 'value', 'unrealised', 'share']);
    assert.strictEqual(m.stats[0].text, '100 shares'); assert.strictEqual(m.stats[1].text, 'S$30.00');
    assert.strictEqual(m.day, null);                                      // no day figure in the quote, no pill
    assert.strictEqual(navPlain(sb._holdingPanelModel('stocks', 's_d05', sb._hpNetWorth())).trades.total, 0);
    // a single share reads "1 share", a fractional holding keeps its decimals
    f.stocks[1].shares = 1; assert.strictEqual(navPlain(panelSandbox(f)._holdingPanelModel('stocks', 's_d05', {})).stats[0].text, '1 share');
    f.stocks[1].shares = 12.5; assert.strictEqual(navPlain(panelSandbox(f)._holdingPanelModel('stocks', 's_d05', {})).stats[0].text, '12.5 shares');
  });

  test('_holdingPanelModel - a missing price and a missing FX rate show dashes with the reason, never NaN, and what is known stays', () => {
    const sb = panelSandbox(panelFixture());
    const nopx = navPlain(sb._holdingPanelModel('stocks', 's_nopx', sb._hpNetWorth()));
    assert.strictEqual(nopx.price.has, false);
    assert.strictEqual(nopx.day, null);
    const s = key => nopx.stats.find(x => x.key === key);
    assert.deepStrictEqual({ v:s('value').text, n:s('value').note, share:s('share').text }, { v:DASH, n:'No price yet', share:DASH });
    assert.deepStrictEqual(s('unrealised').ret, { dir:'', pct:DASH, amount:'' });
    assert.strictEqual(s('unrealised').note, 'No price yet');
    assert.strictEqual(s('avgCost').text, 'US$10.00');                    // the position itself is still known
    // no USDSGD rate: a USD stock keeps its price and its average cost in US$, the S$ figures say why they are missing
    const noFx = panelSandbox(Object.assign(panelFixture(), { settings:{ fxOverrides:{}, fxRates:{} } }));
    const m = navPlain(noFx._holdingPanelModel('stocks', 's_aapl', noFx._hpNetWorth()));
    assert.deepStrictEqual(m.price, { has:true, nativeText:'US$100.00', sgdText:'', fxMissing:true, staleText:'' });
    const t = key => m.stats.find(x => x.key === key);
    assert.strictEqual(t('avgCost').text, 'US$80.00');
    assert.deepStrictEqual({ v:t('value').text, n:t('value').note }, { v:DASH, n:'FX rate missing' });
    assert.deepStrictEqual({ pct:t('unrealised').ret.pct, n:t('unrealised').note }, { pct:DASH, n:'FX rate missing' });
    assert.deepStrictEqual({ v:t('dividends').text, n:t('dividends').note }, { v:DASH, n:'FX rate missing' });   // there is a dividend, it can not be converted, so it is not hidden
    assert.strictEqual(t('share').text, DASH);
    // an SGD stock does not need the rate
    const d05 = navPlain(noFx._holdingPanelModel('stocks', 's_d05', noFx._hpNetWorth()));
    assert.strictEqual(d05.stats.find(x => x.key === 'value').text, 'S$3,500');
    // an incomplete valuation flags the share as a share of a known total
    const flagged = navPlain(sb._holdingPanelModel('stocks', 's_aapl', { displayNet:16550, incomplete:true }));
    assert.strictEqual(flagged.stats.find(x => x.key === 'share').note, 'of the known total');
    assert.strictEqual(navPlain(sb._holdingPanelModel('stocks', 's_aapl', { displayNet:16550, incomplete:false })).stats.find(x => x.key === 'share').note, '');
  });

  test('_holdingPanelModel - a coin: US$ first and S$ after for a USD coin, the 24 hour move, an amount in coins, no trades and no dividends', () => {
    const sb = panelSandbox(panelFixture());
    const m = navPlain(sb._holdingPanelModel('crypto', 'c_btc', { displayNet:50000, incomplete:false }));
    assert.deepStrictEqual({ table:m.table, cls:m.cls, sym:m.sym, sub:m.sub, ysym:m.ysym, ccy:m.ccy, canTrade:m.canTrade, trades:m.trades }, { table:'crypto', cls:'crypto', sym:'BTC', sub:'Crypto', ysym:'', ccy:'USD', canTrade:false, trades:{ total:0, rows:[] } });
    assert.deepStrictEqual(m.price, { has:true, nativeText:'US$112,600.00', sgdText:'S$152,000.00', fxMissing:false, staleText:'' });
    assert.deepStrictEqual(m.day, { dir:'up', pctText:'▲ +1.80%', when:'past 24 hours', sgdText:'+S$672' });
    assert.deepStrictEqual(m.stats.map(s => s.key), ['holding', 'avgCost', 'value', 'unrealised', 'share']);
    const stat = key => m.stats.find(s => s.key === key);
    assert.strictEqual(stat('holding').text, '0.25 BTC');
    assert.strictEqual(stat('avgCost').text, 'US$60,000.00');
    assert.strictEqual(stat('value').text, 'S$38,000');
    assert.deepStrictEqual(stat('unrealised').ret, { dir:'up', pct:'▲ +102.67%', amount:'+S$19,250' });   // cost 0.25 x 60,000 x 1.25 = 18,750
    assert.strictEqual(stat('share').text, '76.0%');
    // an SGD coin shows S$ only, a coin with no price shows dashes with the reason, and an unset average cost is a dash
    const f = panelFixture(); f.crypto[0].currency = 'SGD'; f.crypto.push({ id:'c_foo', symbol:'FOO', amount:5, currency:'USD' });
    const sg = panelSandbox(f);
    const sgd = navPlain(sg._holdingPanelModel('crypto', 'c_btc', {}));
    assert.deepStrictEqual(sgd.price, { has:true, nativeText:'S$152,000.00', sgdText:'', fxMissing:false, staleText:'' });
    assert.strictEqual(sgd.stats.find(s => s.key === 'avgCost').text, 'S$60,000.00');
    const foo = navPlain(sg._holdingPanelModel('crypto', 'c_foo', { displayNet:50000 }));
    assert.strictEqual(foo.price.has, false); assert.strictEqual(foo.day, null);
    assert.deepStrictEqual({ avg:foo.stats[1].text, v:foo.stats[2].text, n:foo.stats[2].note, share:foo.stats[4].text }, { avg:DASH, v:DASH, n:'No price yet', share:DASH });
    assert.strictEqual(sg._holdingPanelModel('crypto', 's_aapl', {}), null);   // a stock id is not a coin
  });

  test('trades - newest first, the entry that came later first on a tied date, an undated one last, fees in the value, in the stock\'s own currency', () => {
    const f = panelFixture();
    f.stockTxns = [
      { id:'t1', stockId:'s_aapl', date:'2026-02-01', side:'buy', shares:10, price:150, fees:5 },
      { id:'t2', stockId:'s_aapl', date:'2026-03-10', side:'sell', shares:4, price:160, fees:2 },
      { id:'t3', stockId:'s_d05', date:'2026-03-11', side:'buy', shares:1, price:30, fees:0 },        // another stock's trade never shows
      { id:'t4', stockId:'s_aapl', date:'2026-03-10', side:'buy', shares:1, price:0.215, fees:0 },    // the same date as t2, entered after it
      { id:'t5', stockId:'s_aapl', side:'buy', shares:2, price:100, fees:1 }                           // no date
    ];
    const sb = panelSandbox(f);
    const t = navPlain(sb._hpTrades('s_aapl', 'USD'));
    assert.strictEqual(t.total, 4);
    assert.deepStrictEqual(t.rows.map(r => r.id), ['t4', 't2', 't1', 't5']);
    assert.deepStrictEqual(t.rows.map(r => r.dateText), ['10/03/2026', '10/03/2026', '01/02/2026', '']);
    assert.deepStrictEqual(t.rows[1], { id:'t2', sell:true, sideText:'Sold', dateText:'10/03/2026', qtyText:'4', priceText:'US$160.00', valueText:'US$638.00', feesText:'US$2.00' });   // 4 x 160 less 2
    assert.deepStrictEqual({ side:t.rows[2].sideText, value:t.rows[2].valueText, fees:t.rows[2].feesText }, { side:'Bought', value:'US$1,505.00', fees:'US$5.00' });   // 10 x 150 plus 5
    assert.deepStrictEqual({ price:t.rows[0].priceText, value:t.rows[0].valueText, fees:t.rows[0].feesText }, { price:'US$0.215', value:'US$0.22', fees:'' });   // a penny price keeps its third digit
    // the model carries the same list, an unknown stock has none, a coin has no ledger
    assert.strictEqual(navPlain(sb._holdingPanelModel('stocks', 's_aapl', {})).trades.total, 4);
    assert.deepStrictEqual(navPlain(sb._hpTrades('s_gone', 'USD')), { total:0, rows:[] });
  });

  test('_holdingPanelHtml - a stock: heading the dialog is labelled by, price and day pill, six stats, the empty trades line and both buttons, every holding amount in a .money-chip', () => {
    const sb = panelSandbox(panelFixture());
    const model = sb._holdingPanelModel('stocks', 's_aapl', sb._hpNetWorth());
    const html = sb._holdingPanelHtml(model, { showAll:false, hist:{ state:'nosync' } });
    assert.ok(html.startsWith('<div class="hp-head"><span class="mono" style="background:var(--c-stocks-soft);color:var(--c-stocks-ink)" aria-hidden="true">A</span>'));
    assert.ok(html.includes('<h2 class="hp-title" id="hp-title">AAPL</h2><p class="hp-sub" title="Apple Inc · US">Apple Inc · US</p>'));
    assert.ok(html.includes('id="hp-close" data-click="closeHoldingPanel" aria-label="Close holding details"'));
    // price in its own currency with the S$ beside it (the prefix dimmed), the pill carries the arrow and the sign, the day move of the position is a chip
    assert.ok(html.includes('<span class="hp-px-v"><span class="ccy">US$</span>100.00</span><span class="hp-px-s">S$125.00</span>'));
    assert.ok(html.includes('<span class="dash-pill up">▲ +2.04%</span><span class="hp-when">today · <span class="money-chip">+S$25</span> on this holding</span>'));
    // the stats grid: quantity, cost, value, unrealised (percentage with arrow over a signed amount) and dividends in chips, the share as a plain percentage
    assert.ok(html.includes('<dl class="hp-stats">'));
    assert.ok(html.includes('<div class="hp-stat"><dt>Holding</dt><dd><span class="money-chip">10 shares</span></dd></div>'));
    assert.ok(html.includes('<div class="hp-stat"><dt>Average cost</dt><dd><span class="money-chip"><span class="ccy">US$</span>80.00</span></dd></div>'));
    assert.ok(html.includes('<div class="hp-stat"><dt>Market value</dt><dd><span class="money-chip"><span class="ccy">S$</span>1,250</span></dd></div>'));
    assert.ok(html.includes('<div class="hp-stat"><dt>Unrealised</dt><dd><span class="hp-ret up"><span class="hp-ret-pct">▲ +25.00%</span><span class="hp-ret-amt money-chip">+<span class="ccy">S$</span>250</span></span></dd></div>'));
    assert.ok(html.includes('<div class="hp-stat"><dt>Dividends a year</dt><dd><span class="money-chip"><span class="ccy">S$</span>25</span></dd></div>'));
    assert.ok(html.includes('<div class="hp-stat"><dt>Share of net worth</dt><dd>7.6%</dd></div>'));
    assert.strictEqual((html.match(/money-chip/g) || []).length, 6);   // the day move, holding, cost, value, unrealised amount and dividends
    // trades and the foot: Record trade is the primary action of a stock, Edit holding follows, both through the one delegated action
    assert.ok(html.includes('<section aria-labelledby="hp-trades-h"><div class="hp-sect"><h3 class="hp-h" id="hp-trades-h">Trades</h3></div><p class="hp-none">No trades recorded yet.</p></section>'));
    assert.ok(html.endsWith('<div class="hp-foot"><button type="button" class="btn btn-primary" id="hp-record" data-click="holdingPanelAction" data-a0="record">Record trade</button><button type="button" class="btn" id="hp-edit" data-click="holdingPanelAction" data-a0="edit">Edit holding</button></div>'));
    assert.strictEqual(/\son[a-z]+="/i.test(html), false);   // CSP: no inline handler
    // a stock without a price: a dash in place of the price and a reason, no pill, nothing blurred that is not the holder's
    const nopx = sb._holdingPanelHtml(sb._holdingPanelModel('stocks', 's_nopx', sb._hpNetWorth()), { hist:{ state:'nosync' } });
    assert.ok(nopx.includes('<span class="hp-px-v">' + DASH + '</span><span class="hp-px-s">No price yet, refresh prices</span>'));
    assert.strictEqual(nopx.includes('dash-pill'), false);
    assert.ok(nopx.includes('<dt>Market value</dt><dd><span class="money-chip">' + DASH + '</span><span class="hp-stat-note">No price yet</span></dd>'));
  });

  test('_holdingPanelHtml - a coin has no Record trade, no Trades section and says history is not there yet, its heading names Crypto', () => {
    const sb = panelSandbox(panelFixture());
    const html = sb._holdingPanelHtml(sb._holdingPanelModel('crypto', 'c_btc', { displayNet:50000 }), { hist:{ state:'coin' } });
    assert.ok(html.includes('<h2 class="hp-title" id="hp-title">BTC</h2><p class="hp-sub" title="Crypto">Crypto</p>'));
    assert.ok(html.includes('class="mono" style="background:var(--c-crypto-soft);color:var(--c-crypto-ink)" aria-hidden="true">₿</span>'));
    assert.ok(html.includes('<span class="hp-px-v"><span class="ccy">US$</span>112,600.00</span><span class="hp-px-s">S$152,000.00</span>'));
    assert.ok(html.includes('<span class="hp-when">past 24 hours · <span class="money-chip">+S$672</span> on this holding</span>'));
    assert.ok(html.includes('Price history is not available for coins yet.'));
    assert.strictEqual(html.includes('hp-record') || html.includes('Record trade') || html.includes('hp-trades') || html.includes('Trades'), false);
    assert.ok(html.includes('id="hp-edit"') && html.includes('<dd><span class="money-chip">0.25 BTC</span></dd>'));
    assert.ok(html.includes('<dd>76.0%</dd>'));
  });

  test('chart block - every history state has its own plain line and no emoji, Retry belongs to an error only, a coin never charts', () => {
    const sb = panelSandbox(panelFixture());
    const stock = sb._holdingPanelModel('stocks', 's_aapl', {}), coin = sb._holdingPanelModel('crypto', 'c_btc', {});
    const text = h => h.replace(/<[^>]*>/g, '').trim();
    assert.strictEqual(text(sb._hpChartHtml(stock, { state:'nosync' })), 'Price history needs your sync connection.');
    assert.strictEqual(text(sb._hpChartHtml(stock, { state:'loading' })), 'Loading price history…');
    assert.strictEqual(text(sb._hpChartHtml(stock, { state:'sparse' })), 'Not enough price history yet.');
    const err = sb._hpChartHtml(stock, { state:'error' });
    assert.strictEqual(text(err), 'Price history is unavailable right now.Retry');
    assert.ok(err.includes('<button type="button" class="btn btn-sm" id="hp-retry" data-click="holdingPanelAction" data-a0="retry">Retry</button>'));
    ['nosync', 'loading', 'sparse', 'ok'].forEach(s => assert.strictEqual(sb._hpChartHtml(stock, { state:s, series:[{ date:'2026-10-01', value:5 }, { date:'2026-10-02', value:6 }] }).includes('hp-retry'), false, s));
    // an unknown or missing state reads as unavailable, never as a blank hole
    [undefined, null, {}, { state:'weird' }].forEach(h => assert.ok(text(sb._hpChartHtml(stock, h)).startsWith('Price history is unavailable right now.'), JSON.stringify(h)));
    // a coin says so whatever the state says, and a loading line is only a line (no icon tile)
    ['nosync', 'loading', 'error', 'ok', 'coin'].forEach(s => assert.strictEqual(text(sb._hpChartHtml(coin, { state:s })), 'Price history is not available for coins yet.', s));
    assert.strictEqual(sb._hpChartHtml(stock, { state:'loading' }).includes('hp-empty-icon'), false);
    const all = ['nosync', 'loading', 'sparse', 'error'].map(s => sb._hpChartHtml(stock, { state:s })).join('') + sb._hpChartHtml(coin, { state:'coin' });
    assert.strictEqual(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(all), false);   // line icons only, no emoji
    assert.ok(all.includes('class="hp-empty-icon" aria-hidden="true"><svg'));
  });

  test('_hpSeries - one point per Singapore day (a later point of the day wins), oldest first, only real positive prices', () => {
    const sb = panelSandbox();
    const at = (iso, h) => Date.parse(iso + 'T' + h + ':00:00+08:00');
    const out = navPlain(sb._hpSeries([
      { t:at('2026-10-02', '10'), c:101 }, { t:at('2026-10-01', '10'), c:100 }, { t:at('2026-10-02', '15'), c:102 },
      { t:at('2026-10-03', '10'), c:null }, { t:at('2026-10-04', '10'), c:'x' }, { t:at('2026-10-05', '10'), c:0 }, { t:at('2026-10-06', '10'), c:-4 },
      { t:null, c:105 }, { t:'nope', c:106 }, { t:8.64e15 + 1, c:107 }, null, undefined, 'x', { c:5 },
      { t:at('2026-10-07', '23'), c:103 }
    ]));
    assert.deepStrictEqual(out, [{ date:'2026-10-01', value:100 }, { date:'2026-10-02', value:102 }, { date:'2026-10-07', value:103 }]);
    [null, undefined, {}, 'x', 5, []].forEach(v => assert.deepStrictEqual(navPlain(sb._hpSeries(v)), [], String(v)));
    // a point just after midnight in Singapore is that day's, not the previous UTC day's
    assert.deepStrictEqual(navPlain(sb._hpSeries([{ t:at('2026-10-08', '00'), c:9 }, { t:at('2026-10-09', '00'), c:10 }])), [{ date:'2026-10-08', value:9 }, { date:'2026-10-09', value:10 }]);
  });

  /* A daily series of `days` points ending on endIso, running from `from` to `to` in a straight line. */
  const histSeries = (from, to, days, endIso) => Array.from({ length:days }, (_, i) => ({
    date:new Date(Date.parse((endIso || '2026-10-09') + 'T00:00:00Z') - (days - 1 - i) * 86400000).toISOString().slice(0, 10),
    value:+(from + (to - from) * i / (days - 1)).toFixed(4) }));

  test('_hpAxisDp and _hpAxisLabel - labels carry the decimals the chart needs so each reads exactly, from 1,000 up the hero\'s compact form', () => {
    const sb = panelSandbox();
    const g = (...v) => v.map(value => ({ value }));
    assert.deepStrictEqual([g(3.2, 3.3), g(100, 105), g(0.215, 0.22), g(2.5, 5), g(), g(0.0005, 0.001)].map(x => sb._hpAxisDp(x)), [1, 0, 3, 1, 0, 4]);
    assert.strictEqual(sb._hpAxisLabel(3.3, 'S$', 1), 'S$3.3');
    assert.strictEqual(sb._hpAxisLabel(105, 'US$', 0), 'US$105');
    assert.strictEqual(sb._hpAxisLabel(-2, 'S$', 0), '-S$2');
    assert.strictEqual(sb._hpAxisLabel(1250, 'US$', 0), 'US$1.3k');
    assert.strictEqual(sb._hpAxisLabel(1250000, 'S$', 0), 'S$1.25M');   // the hero's own form, up to two decimals from a million
    assert.deepStrictEqual(['USD', 'sgd', 'HKD', undefined, null].map(c => sb._hpCcySym(c)), ['US$', 'S$', 'HKD ', 'S$', 'S$']);
  });

  test('_hpSeriesHtml - the hero chart\'s geometry and classes at panel size: gain colour for a rise, labelled gridlines, human date ticks, an end dot, a result under it', () => {
    const sb = panelSandbox();
    const up = sb._hpSeriesHtml({ state:'ok', ccy:'USD', series:histSeries(100, 120, 64) });
    assert.ok(up.startsWith('<div class="hero-chart hp-chart up" role="img" aria-label="Price over the past 3 months, up 20.0%">'));
    assert.ok(up.includes('<div class="hero-grid" aria-hidden="true">') && up.includes('<div class="hero-ticks" aria-hidden="true">'));
    const grid = Array.from(up.matchAll(/<i style="top:[^"]*"><b>([^<]*)<\/b><\/i>/g)).map(m => m[1]);
    assert.deepStrictEqual(grid, ['US$100', 'US$105', 'US$110', 'US$115']);   // round numbers inside the padded range
    const ticks = Array.from(up.matchAll(/<span style="left:[^"]*">([^<]*)<\/span>/g)).map(m => m[1]);
    assert.deepStrictEqual([ticks.length, ticks[0], ticks[ticks.length - 1]], [5, '7 Aug', '9 Oct']);
    assert.ok(up.includes('<defs><linearGradient id="hp-fill"') && up.includes('fill="url(#hp-fill)"') && up.includes('vector-effect="non-scaling-stroke"'));
    assert.strictEqual(up.includes('hero-fill'), false);                    // the hero's own gradient id is not reused
    assert.ok(/<i class="hero-dot end" style="left:100\.000%;top:[\d.]+%"><\/i>/.test(up));
    assert.ok(up.endsWith('<p class="hp-caption"><span>3 months</span><span class="hp-res up">▲ +20.00%</span></p>'));
    // a fall takes the loss colour and a sign, a level series is level (no arrow, no colour)
    const down = sb._hpSeriesHtml({ state:'ok', ccy:'USD', series:histSeries(120, 100, 64) });
    assert.ok(down.includes('class="hero-chart hp-chart down"') && down.includes('aria-label="Price over the past 3 months, down 16.7%"'));
    assert.ok(down.endsWith('<span class="hp-res down">▼ -16.67%</span></p>'));
    const flat = sb._hpSeriesHtml({ state:'ok', ccy:'USD', series:histSeries(50, 50, 30) });
    assert.ok(flat.includes('class="hero-chart hp-chart up"') && flat.includes('aria-label="Price over the past 3 months, level"') && flat.endsWith('<span class="hp-res">+0.00%</span></p>'));
    // a low-priced stock labels its gridlines to the tenth (the hero's own labels would all read S$3) and its line fills the plot, the hero's one-dollar floor
    // on the padded range would have squeezed it into a third of the height
    const small = sb._hpSeriesHtml({ state:'ok', ccy:'SGD', series:histSeries(3.2, 3.6, 40) });
    assert.deepStrictEqual(Array.from(small.matchAll(/<i style="top:[^"]*"><b>([^<]*)<\/b><\/i>/g)).map(m => m[1]), ['S$3.2', 'S$3.3', 'S$3.4', 'S$3.5']);
    const ys = Array.from(/<path d="(M[^"]*)L1000 300L0 300Z"/.exec(small)[1].matchAll(/L?[\d.]+ ([\d.]+)/g)).map(m => +m[1]);
    assert.ok(Math.max.apply(null, ys) - Math.min.apply(null, ys) > 0.7 * 300, 'the line spans ' + (Math.max.apply(null, ys) - Math.min.apply(null, ys)));
    // the same shape at a level of 100 or more is the hero's own geometry, unscaled
    assert.deepStrictEqual([3.6, 0.215, 99.9, 100, 250, 0, NaN, Infinity].map(top => sb._hpScale([{ value:top }, { value:top / 2 }])), [100, 1000, 10, 1, 1, 1, 1, 1]);
    // a long history labels its ticks by month, a hostile currency code reaches the page escaped
    const long = sb._hpSeriesHtml({ state:'ok', ccy:'USD', series:histSeries(10, 20, 200) });
    assert.ok(long.includes('class="hero-ticks month"'));
    const evil = sb._hpSeriesHtml({ state:'ok', ccy:'<b>', series:histSeries(100, 120, 64) });
    assert.strictEqual(evil.includes('<B>'), false);   // the markup's own label tags are lowercase <b>, an upper-case one could only be the currency code
    assert.ok(evil.includes('<b>&lt;B&gt; 100</b>'));
  });

  test('the panel markup - a hostile symbol, name, sector and currency reach the page only as escaped text, in the heading, the title, the stats and the chart', () => {
    const evil = '<img src=x onerror="window.__x=1">';
    const sb = panelSandbox({
      stocks:[{ id:'s_evil', symbol:evil, market:'US', sector:'"><script>alert(1)</script>', shares:1, avgCost:5, currency:'<i>', divPerShare:1 }],
      crypto:[{ id:'c_evil', symbol:'<svg onload=1>', coingeckoId:'x', amount:2, avgCost:1, currency:'USD' }],
      _priceCache:{ [evil]:{ price:5, currency:'USD', fetchedAt:TODAY_ISO, shortName:'<b onmouseover=alert(2)>Evil</b>', previousClose:4 }, x:{ sgd:3, usd:2, change24h:1, fetchedAt:TODAY_ISO } }
    });
    const stock = sb._holdingPanelHtml(sb._holdingPanelModel('stocks', 's_evil', sb._hpNetWorth()), { hist:{ state:'ok', ccy:'<i>', series:histSeries(4, 5, 30) } });
    const coin = sb._holdingPanelHtml(sb._holdingPanelModel('crypto', 'c_evil', { displayNet:100 }), { hist:{ state:'coin' } });
    [stock, coin].forEach(html => {
      assert.strictEqual(/<img|<script|<svg onload|<b onmouseover|<i>|<I>/i.test(html.replace(/<svg viewBox[^>]*>/g, '')), false, 'raw markup');
      assert.strictEqual(/\son[a-z]+="/i.test(html), false);
    });
    assert.ok(stock.includes('<h2 class="hp-title" id="hp-title">&lt;img src=x onerror=&quot;window.__x=1&quot;&gt;</h2>'));
    assert.ok(stock.includes('title="&lt;b onmouseover=alert(2)&gt;Evil&lt;/b&gt; · US"'));            // an attribute can not be broken out of
    assert.ok(stock.includes('class="mono"') && stock.includes('>&lt;</span>'));                              // the monogram letter
    assert.ok(stock.includes('&lt;I&gt; 5.00'));                                                               // fmt prints a code it can not format as typed, the builder escapes it
    assert.ok(coin.includes('<dd><span class="money-chip">2 &lt;svg onload=1&gt;</span></dd>'));
    assert.ok(coin.includes('id="hp-title">&lt;svg onload=1&gt;</h2>'));
  });

  test('the panel markup never prints NaN, undefined, null or Infinity, whatever the holding or its quote holds', () => {
    const odd = [null, undefined, NaN, Infinity, -Infinity, 0, -5, 5, '7', 'x'];
    const sb = panelSandbox({ stocks:[{ id:'s_odd', symbol:'ODD', market:'US', sector:'', shares:1, avgCost:1, currency:'USD' }], crypto:[{ id:'c_odd', symbol:'ODD', coingeckoId:'odd', amount:1, avgCost:1, currency:'USD' }], _priceCache:{} });
    let n = 0;
    const bad = html => /NaN|undefined|null|Infinity/.test(html);
    odd.forEach(shares => odd.forEach(avg => odd.forEach(price => odd.forEach(div => {
      const s = sb.DB.stocks[0];
      Object.assign(s, { shares, avgCost:avg, divPerShare:div });
      sb.DB._priceCache.ODD = { price, currency:'USD', fetchedAt:TODAY_ISO, changePct:price, previousClose:avg, change:div };
      const html = sb._holdingPanelHtml(sb._holdingPanelModel('stocks', 's_odd', sb._hpNetWorth()), { hist:{ state:'nosync' } });
      assert.strictEqual(bad(html), false, JSON.stringify({ shares, avg, price, div }) + ' -> ' + html.replace(/<[^>]*>/g, ' '));
      n++;
    }))));
    odd.forEach(amount => odd.forEach(avg => odd.forEach(sgd => odd.forEach(pct => {
      Object.assign(sb.DB.crypto[0], { amount, avgCost:avg });
      sb.DB._priceCache.odd = { sgd, usd:sgd, change24h:pct, fetchedAt:TODAY_ISO };
      const html = sb._holdingPanelHtml(sb._holdingPanelModel('crypto', 'c_odd', { displayNet:pct }), { hist:{ state:'coin' } });
      assert.strictEqual(bad(html), false, JSON.stringify({ amount, avg, sgd, pct }) + ' -> ' + html.replace(/<[^>]*>/g, ' '));
      n++;
    }))));
    assert.ok(n >= 20000);
  });

  /* Price history points in the Apps Script's shape ({ t: ms epoch, c: close }), one a day ending today. */
  const histPoints = (from, to, days) => Array.from({ length:days }, (_, i) => ({ t:Date.now() - (days - 1 - i) * 86400000, c:+(from + (to - from) * i / (days - 1)).toFixed(2) }));
  const flush = () => new Promise(resolve => setImmediate(resolve));

  test('openHoldingPanel - paints the panel, opens the overlay, gives the focus trap to openModalFocus with Escape closing it, and asks for the 3 month history by its range key', () => {
    const { sb, doc, calls } = overlaySandbox(panelFixture());
    sb.getSyncUrl = () => 'https://example.invalid/sync';
    const asked = [];
    sb.fetchStockHistory = (syms, range) => { asked.push([syms, range]); return new Promise(() => {}); };   // never answers, the panel stays loading
    assert.strictEqual(sb.openHoldingPanel('stocks', 's_aapl'), true);
    const overlay = doc.els['holding-panel'], host = doc.els['hp-panel'];
    assert.ok(overlay.classList.contains('open') && overlay.classList.contains('hp-in'));
    assert.deepStrictEqual(calls.filter(c => c[0] === 'trap'), [['trap', 'holding-panel', 'closeHoldingPanel']]);
    assert.ok(host.innerHTML.includes('id="hp-title">AAPL</h2>') && host.innerHTML.includes('Loading price history…'));
    assert.deepStrictEqual(plain(asked), [[['AAPL'], 'THREE_MONTHS']]);
    assert.strictEqual(vm.runInContext('_hp.hist.state', sb), 'loading');
    // THREE_MONTHS is the PB_PERIODS key fetchStockHistory maps to 3mo. A bare '3mo' is not a key and would fall back to six months.
    assert.strictEqual(vm.runInContext('HP_HISTORY_RANGE', sb), 'THREE_MONTHS');
    assert.ok(appSrc.includes("THREE_MONTHS:'3mo'") && extractFunction('fetchStockHistory').includes("PB_PERIODS[range] || '6mo'"));
    assert.ok(extractFunction('fetchStockHistory').includes('_pbHistCache[s][range]'));   // the cache is keyed by the same key
  });

  test('openHoldingPanel - a coin loads no history, no sync connection is its own state, a holding that is gone says so, and a bad id or table opens nothing', () => {
    const { sb, doc, calls } = overlaySandbox(panelFixture());
    let asked = 0;
    sb.fetchStockHistory = () => { asked++; return new Promise(() => {}); };
    assert.strictEqual(sb.openHoldingPanel('crypto', 'c_btc'), true);
    assert.strictEqual(vm.runInContext('_hp.hist.state', sb), 'coin');
    assert.ok(doc.els['hp-panel'].innerHTML.includes('Price history is not available for coins yet.'));
    assert.strictEqual(sb.openHoldingPanel('stocks', 's_aapl'), true);   // getSyncUrl is '' here: nothing to ask
    assert.strictEqual(vm.runInContext('_hp.hist.state', sb), 'nosync');
    assert.ok(doc.els['hp-panel'].innerHTML.includes('Price history needs your sync connection.'));
    assert.strictEqual(asked, 0);
    // switching holding while the panel is open keeps one trap per call and the new content
    assert.ok(doc.els['hp-panel'].innerHTML.includes('id="hp-title">AAPL</h2>'));
    sb.closeHoldingPanel(); calls.length = 0;
    const before = doc.els['hp-panel'].writes;
    assert.strictEqual(sb.openHoldingPanel('stocks', 's_gone'), false);
    assert.deepStrictEqual(calls, [['toast', 'That holding no longer exists, it may have been deleted elsewhere', 'error']]);
    ['', null, undefined, 'a b', '<img>', 'x'.repeat(65)].forEach(id => assert.strictEqual(sb.openHoldingPanel('stocks', id), false, String(id)));
    ['cash', 'watchlist', '', null, 'constructor'].forEach(t => assert.strictEqual(sb.openHoldingPanel(t, 's_aapl'), false, String(t)));
    assert.strictEqual(doc.els['hp-panel'].writes, before);
    assert.strictEqual(doc.els['holding-panel'].classList.contains('open'), false);
    assert.strictEqual(vm.runInContext('_hp', sb), null);
    // no overlay in the page (the markup is missing): false, not a throw
    doc.els['holding-panel'] = null;
    assert.strictEqual(sb.openHoldingPanel('stocks', 's_aapl'), false);
  });

  test('closeHoldingPanel - closes the overlay and releases the trap, a second close does nothing, and it empties nothing the page still needs', () => {
    const { sb, doc, calls } = overlaySandbox(panelFixture());
    assert.strictEqual(sb.closeHoldingPanel(), false);   // nothing open
    sb.openHoldingPanel('stocks', 's_aapl'); calls.length = 0;
    const overlay = doc.els['holding-panel'];
    assert.strictEqual(sb.closeHoldingPanel(), true);
    assert.strictEqual(overlay.classList.contains('open') || overlay.classList.contains('hp-in'), false);
    assert.deepStrictEqual(calls, [['release', 'holding-panel']]);
    assert.strictEqual(vm.runInContext('_hp', sb), null);
    assert.strictEqual(sb.closeHoldingPanel(), false);
    assert.deepStrictEqual(calls, [['release', 'holding-panel']]);
    // the router closes it too, so Back or a hash change never leaves a panel over the next page
    assert.ok(extractFunction('showPage').includes('closeHoldingPanel();'));
  });

  await testAsync('panel history - success draws the chart, a failure shows Retry and Retry asks again, a missing symbol is unavailable, under two days is sparse', async () => {
    const { sb, doc } = overlaySandbox(panelFixture());
    sb.getSyncUrl = () => 'https://example.invalid/sync';
    const host = doc.els['hp-panel'];
    const state = () => vm.runInContext('_hp.hist.state', sb);
    const good = () => ({ AAPL:{ ccy:'USD', points:histPoints(231, 254.3, 64), fetchedAt:TODAY_ISO } });
    let mode = 'reject', asked = 0;
    sb.fetchStockHistory = async () => { asked++; if (mode === 'reject') throw new Error('boom'); if (mode === 'empty') return {}; if (mode === 'one') return { AAPL:{ ccy:'USD', points:histPoints(100, 100, 1), fetchedAt:TODAY_ISO } }; return good(); };
    sb.openHoldingPanel('stocks', 's_aapl');
    assert.strictEqual(state(), 'loading');
    await flush();
    assert.strictEqual(state(), 'error');
    assert.ok(host.innerHTML.includes('Price history is unavailable right now.') && host.innerHTML.includes('id="hp-retry"'));
    // Retry asks again (it is loading at once), and the answer replaces the error with the chart
    mode = 'ok';
    assert.strictEqual(sb.holdingPanelAction('retry'), true);
    assert.strictEqual(state(), 'loading'); assert.ok(host.innerHTML.includes('Loading price history…'));
    await flush();
    assert.strictEqual(asked, 2); assert.strictEqual(state(), 'ok');
    assert.ok(host.innerHTML.includes('class="hero-chart hp-chart up"') && host.innerHTML.includes('<span>3 months</span>') && !host.innerHTML.includes('hp-retry'));
    // a quote the proxy has no history for, a single day, and a reply that is not usable are not charts
    mode = 'empty'; sb.closeHoldingPanel(); sb.openHoldingPanel('stocks', 's_aapl'); await flush();
    assert.strictEqual(state(), 'error');
    mode = 'one'; sb.closeHoldingPanel(); sb.openHoldingPanel('stocks', 's_aapl'); await flush();
    assert.strictEqual(state(), 'sparse'); assert.ok(host.innerHTML.includes('Not enough price history yet.'));
    // Retry belongs to stocks, a coin has nothing to retry
    sb.closeHoldingPanel(); sb.openHoldingPanel('crypto', 'c_btc');
    assert.strictEqual(sb.holdingPanelAction('retry'), false);
  });

  await testAsync('panel history - an answer that arrives after the panel was closed, or reopened, paints nothing', async () => {
    const { sb, doc } = overlaySandbox(panelFixture());
    sb.getSyncUrl = () => 'https://example.invalid/sync';
    const host = doc.els['hp-panel'];
    const answers = [];
    sb.fetchStockHistory = () => new Promise(resolve => answers.push(resolve));
    const reply = () => ({ AAPL:{ ccy:'USD', points:histPoints(231, 254.3, 64), fetchedAt:TODAY_ISO }, D05:{ ccy:'SGD', points:histPoints(48, 52.4, 64), fetchedAt:TODAY_ISO } });
    sb.openHoldingPanel('stocks', 's_aapl');            // request 1
    sb.closeHoldingPanel();
    const afterClose = host.writes;
    answers[0](reply()); await flush();
    assert.strictEqual(host.writes, afterClose);          // closed: the late answer is dropped
    assert.strictEqual(vm.runInContext('_hp', sb), null);
    sb.openHoldingPanel('stocks', 's_aapl');            // request 2
    sb.closeHoldingPanel();
    sb.openHoldingPanel('stocks', 's_d05');             // request 3, another stock
    answers[1](reply()); await flush();
    assert.strictEqual(vm.runInContext('_hp.hist.state', sb), 'loading');   // request 2's answer is not request 3's
    assert.strictEqual(host.innerHTML.includes('hero-chart hp-chart'), false);
    answers[2](reply()); await flush();
    assert.strictEqual(vm.runInContext('_hp.hist.state', sb), 'ok');
    assert.ok(host.innerHTML.includes('id="hp-title">D05</h2>') && host.innerHTML.includes('class="hero-chart hp-chart up"'));
  });

  test('refreshHoldingPanel - repaints the open panel in place, skips a repaint that would change nothing, keeps scroll and focus, and closes when the holding is gone', () => {
    const { sb, doc, calls } = overlaySandbox(panelFixture());
    assert.strictEqual(sb.refreshHoldingPanel(), false);     // nothing open, nothing to do
    sb.openHoldingPanel('stocks', 's_aapl');
    const host = doc.els['hp-panel'];
    const first = host.writes;
    assert.strictEqual(sb.refreshHoldingPanel(), true);       // nothing moved: not a single write, so focus and the chart are undisturbed
    assert.strictEqual(host.writes, first);
    // a new price repaints in place, the share and the figures follow
    sb.DB._priceCache.AAPL.price = 110;
    doc.activeElement = doc.els['hp-edit'];
    host.body.scrollTop = 120;
    assert.strictEqual(sb.refreshHoldingPanel(), true);
    assert.strictEqual(host.writes, first + 1);
    assert.ok(host.innerHTML.includes('<span class="ccy">US$</span>110.00') && host.innerHTML.includes('<span class="ccy">S$</span>1,375'));   // 10 x 110 x 1.25
    assert.strictEqual(host.body.scrollTop, 120);             // the scroll position survives the repaint
    assert.strictEqual(doc.activeElement, doc.els['hp-edit']); // and so does focus (the control has an id, it is found again)
    // a focused control that is gone after the repaint hands focus to the dialog, so Escape and Tab keep working
    doc.activeElement = doc.els['hp-retry']; doc.els['hp-retry'] = null;
    sb.DB._priceCache.AAPL.price = 111;
    sb.refreshHoldingPanel();
    assert.strictEqual(doc.activeElement, doc.els['holding-panel']);
    // the same call from every place data moves
    assert.ok(extractFunction('renderAll').includes('refreshHoldingPanel();'));
    // the two price refreshes repaint the panel right after their own render (checked on the source text)
    assert.ok(appSrc.includes('    renderStocks();\n    refreshHoldingPanel();   // an open holding panel takes the new price'));
    assert.ok(appSrc.includes('    renderCrypto();\n    refreshHoldingPanel();   // an open holding panel takes the new price'));
    // the holding deleted elsewhere: the panel closes, saying so
    calls.length = 0;
    sb.DB.stocks = sb.DB.stocks.filter(s => s.id !== 's_aapl');
    assert.strictEqual(sb.refreshHoldingPanel(), false);
    assert.strictEqual(vm.runInContext('_hp', sb), null);
    assert.strictEqual(doc.els['holding-panel'].classList.contains('open'), false);
    assert.deepStrictEqual(calls, [['release', 'holding-panel'], ['toast', 'This holding was removed, so its panel was closed', '']]);
  });

  test('refreshHoldingPanel - never throws into a render, whatever the data does', () => {
    const { sb } = overlaySandbox(panelFixture());
    sb.openHoldingPanel('stocks', 's_aapl');
    sb._holdingPanelModel = () => { throw new Error('bad row'); };
    assert.doesNotThrow(() => assert.strictEqual(sb.refreshHoldingPanel(), false));
    assert.ok(vm.runInContext('_hp', sb) !== null);           // still open, the next repaint may recover
  });

  test('holdingPanelAction - Record trade and Edit holding close the panel first, then open the entity modal for this holding, and nothing else is accepted', () => {
    const { sb, doc, calls } = overlaySandbox(panelFixture());
    const rec = () => calls.filter(c => c[0] === 'modal' || c[0] === 'release' || c[0] === 'toast');
    sb.openHoldingPanel('stocks', 's_aapl'); calls.length = 0;
    assert.strictEqual(sb.holdingPanelAction('record'), true);
    assert.deepStrictEqual(rec(), [['release', 'holding-panel'], ['modal', 'stockTxns', null, { stockId:'s_aapl' }]]);   // closed first, the trade is for this stock
    assert.strictEqual(vm.runInContext('_hp', sb), null);
    sb.openHoldingPanel('stocks', 's_d05'); calls.length = 0;
    assert.strictEqual(sb.holdingPanelAction('edit'), true);
    assert.deepStrictEqual(rec(), [['release', 'holding-panel'], ['modal', 'stocks', 's_d05', null]]);
    sb.openHoldingPanel('crypto', 'c_btc'); calls.length = 0;
    assert.strictEqual(sb.holdingPanelAction('record'), false);   // a coin has no trade ledger, the panel stays open
    assert.deepStrictEqual(rec(), []); assert.ok(vm.runInContext('_hp', sb) !== null);
    assert.strictEqual(sb.holdingPanelAction('edit'), true);
    assert.deepStrictEqual(rec(), [['release', 'holding-panel'], ['modal', 'crypto', 'c_btc', null]]);
    // the stock vanished between opening the panel and pressing Record trade: no form for a stock that is not there
    sb.openHoldingPanel('stocks', 's_o39'); calls.length = 0;
    sb.DB.stocks = sb.DB.stocks.filter(s => s.id !== 's_o39');
    assert.strictEqual(sb.holdingPanelAction('record'), false);
    assert.deepStrictEqual(rec(), [['release', 'holding-panel'], ['toast', 'That stock no longer exists, it may have been deleted elsewhere', 'error']]);
    // only the four named actions run, and only while a panel is open
    sb.openHoldingPanel('stocks', 's_d05'); calls.length = 0;
    ['close', 'delete', 'x', '', null, undefined, '__proto__', 'constructor', 'toString'].forEach(a => assert.strictEqual(sb.holdingPanelAction(a), false, String(a)));
    assert.deepStrictEqual(rec(), []);
    sb.closeHoldingPanel();
    ['record', 'edit', 'retry', 'trades'].forEach(a => assert.strictEqual(sb.holdingPanelAction(a), false, 'closed ' + a));
    assert.deepStrictEqual(navPlain(vm.runInContext('HP_ACTIONS', sb)), ['record', 'edit', 'retry', 'trades']);
  });

  test('trades in the panel - the first 10 newest first, a Show all control with the count, every trade after it, and Show fewer to go back', () => {
    const f = panelFixture();
    f.stockTxns = Array.from({ length:14 }, (_, i) => ({ id:'t' + i, stockId:'s_aapl', date:'2026-03-' + String(i + 1).padStart(2, '0'), side: i % 2 ? 'sell' : 'buy', shares:1, price:100 + i, fees:0 }));
    const { sb, doc } = overlaySandbox(f);
    sb.openHoldingPanel('stocks', 's_aapl');
    const host = doc.els['hp-panel'];
    const rows = () => Array.from(host.innerHTML.matchAll(/<li class="hp-trade">[\s\S]*?<\/li>/g)).map(m => m[0]);
    assert.strictEqual(rows().length, 10);
    const dates = () => rows().map(r => /<div class="hp-trade-s">([^<]*)</.exec(r)[1]);
    assert.deepStrictEqual(dates().slice(0, 3), ['14/03/2026', '13/03/2026', '12/03/2026']);   // newest first
    assert.strictEqual(dates()[9], '05/03/2026');
    assert.ok(host.innerHTML.includes('<button type="button" class="dash-link" id="hp-trades-toggle" data-click="holdingPanelAction" data-a0="trades" aria-expanded="false">Show all 14</button>'));
    // a sell is worded Sold and a buy Bought, the figures are chips
    assert.ok(rows()[0].includes('<span class="hp-side">Sold</span> <span class="money-chip">1 @ US$113.00</span>') && rows()[1].includes('<span class="hp-side">Bought</span>'));
    assert.ok(rows()[0].includes('<div class="hp-trade-v money-chip"><span class="ccy">US$</span>113.00</div>'));
    assert.strictEqual(sb.holdingPanelAction('trades'), true);
    assert.strictEqual(rows().length, 14); assert.strictEqual(dates()[13], '01/03/2026');
    assert.ok(host.innerHTML.includes('aria-expanded="true">Show fewer</button>'));
    sb.holdingPanelAction('trades');
    assert.strictEqual(rows().length, 10);
    // exactly 10 trades need no control, and the empty state reads as a line
    sb.DB.stockTxns = sb.DB.stockTxns.slice(0, 10); sb.refreshHoldingPanel();
    assert.strictEqual(host.innerHTML.includes('hp-trades-toggle'), false); assert.strictEqual(rows().length, 10);
    sb.DB.stockTxns = []; sb.refreshHoldingPanel();
    assert.ok(host.innerHTML.includes('<p class="hp-none">No trades recorded yet.</p>') && rows().length === 0);
    assert.strictEqual(vm.runInContext('HP_TRADES_SHOWN', sb), 10);
  });

  test('_hpRestoreFocus - when a repaint replaced the opener the same holding\'s control gets focus, and a focus already outside the panel is left alone', () => {
    const { sb, doc } = overlaySandbox(panelFixture());
    const overlay = doc.els['holding-panel'];
    const st = { table:'stocks', id:'s_aapl' };
    const visible = { id:'row', visible:true, focus(){ doc.activeElement = this; } };
    const hidden = { id:'hidden-copy', visible:false, focus(){ throw new Error('a hidden control must not be focused'); } };
    doc.found['[data-click="openHolding"][data-a0="stocks"][data-a1="s_aapl"]'] = [hidden, visible];   // the table and the phone list both carry one, only one is on screen
    doc.activeElement = doc.body;
    assert.strictEqual(sb._hpRestoreFocus(st, overlay), true);
    assert.strictEqual(doc.activeElement, visible);
    doc.activeElement = doc.els['hp-edit'];                   // still on the button that was pressed, inside the closing overlay
    doc.els['holding-panel'].kids = [doc.els['hp-edit']];
    assert.strictEqual(sb._hpRestoreFocus(st, overlay), true);
    assert.strictEqual(doc.activeElement, visible);
    const trigger = { id:'cp-trigger', visible:true, focus(){ doc.activeElement = this; } };
    doc.activeElement = trigger;                              // opened from the palette: focus went back to the palette's opener already
    assert.strictEqual(sb._hpRestoreFocus(st, overlay), false);
    assert.strictEqual(doc.activeElement, trigger);
    doc.found['[data-click="openHolding"][data-a0="stocks"][data-a1="s_aapl"]'] = [hidden];
    doc.activeElement = doc.body;
    assert.strictEqual(sb._hpRestoreFocus(st, overlay), false);   // no visible control for it: nothing to focus, no throw
    // the holding is gone and focus is still on a control of the closing panel: it is dropped, so focus is never left on a hidden control
    doc.activeElement = doc.els['hp-edit'];
    assert.strictEqual(sb._hpRestoreFocus(st, overlay), false);
    assert.strictEqual(doc.activeElement, doc.body);
  });

  /* A synthetic palette model, so the matcher is tested on its own, away from the app's data. */
  const synthPalette = () => ({
    pages:[{ key:'dashboard', label:'Dashboard', sub:'Overview' }, { key:'stocks', label:'Stocks', sub:'Assets' }, { key:'insurance', label:'Insurance', sub:'Assets' }, { key:'settings', label:'Settings', sub:'' }],
    holdings:[
      { table:'stocks', id:'h1', cls:'stocks', sym:'QAP', name:'', sector:'', sub:'US' },                                // substring in the symbol
      { table:'stocks', id:'h2', cls:'stocks', sym:'APX', name:'Zeta', sector:'', sub:'US' },                           // prefix in the symbol
      { table:'stocks', id:'h3', cls:'stocks', sym:'ZZZ', name:'Apple Inc', sector:'Retail', sub:'Apple Inc · US' },     // prefix in the name
      { table:'stocks', id:'h4', cls:'stocks', sym:'WWW', name:'Maple', sector:'', sub:'US' },                           // substring in the name
      { table:'stocks', id:'h5', cls:'stocks', sym:'VVV', name:'', sector:'Apparel', sub:'US · Apparel' },               // prefix in the sector
      { table:'crypto', id:'h6', cls:'crypto', sym:'UUU', name:'', sector:'Retail Apps', sub:'Crypto' }                  // substring in the sector
    ],
    actions:[
      { id:'add:stocks', op:'add', arg:'stocks', label:'Add stock', sub:'' },
      { id:'add:stockTxns', op:'add', arg:'stockTxns', label:'Record trade', sub:'Add a stock first', disabled:true },
      { id:'refresh', op:'refresh', label:'Refresh prices', sub:'' },
      { id:'theme', op:'theme', label:'Switch to light theme', sub:'' }
    ]
  });
  const ids = r => r.groups.map(g => g.items.map(i => i.id));

  test('_paletteResults - case-insensitive substring, prefix matches first, and symbol before name before sector, then the model\'s own order', () => {
    const sb = panelSandbox();
    const r = navPlain(sb._paletteResults('ap', synthPalette()));
    assert.deepStrictEqual(r.groups.map(g => g.key), ['holdings']);
    // APX (symbol prefix), Apple Inc (name prefix), Apparel (sector prefix), then the substrings: QAP (symbol), Maple (name), Retail Apps (sector)
    assert.deepStrictEqual(r.groups[0].items.map(i => i.label), ['APX', 'ZZZ', 'VVV', 'QAP', 'WWW', 'UUU']);
    assert.strictEqual(r.query, 'ap'); assert.strictEqual(r.count, 6);
    // the same results whatever the case, and the query is trimmed
    ['AP', 'aP', '  ap  ', '\tAp\n'].forEach(q => assert.deepStrictEqual(ids(navPlain(sb._paletteResults(q, synthPalette()))), ids(r), JSON.stringify(q)));
    // pages, holdings and actions rank on their own, and a group with no match is left out
    const s = navPlain(sb._paletteResults('s', synthPalette()));
    assert.deepStrictEqual(s.groups.map(g => g.key), ['pages', 'holdings', 'actions']);
    assert.deepStrictEqual(s.groups[1].items.map(i => i.label), ['UUU']);   // only the sector Retail Apps holds an s
    assert.deepStrictEqual(s.groups[0].items.map(i => i.label), ['Stocks', 'Settings', 'Dashboard', 'Insurance']);   // two prefixes in order, then the two substrings in order
    assert.deepStrictEqual(s.groups[2].items.map(i => i.label), ['Switch to light theme', 'Add stock', 'Refresh prices']);   // the prefix first, then the substrings in order
    // ties keep the model's order
    const tie = synthPalette(); tie.holdings = ['A1', 'A2', 'A3'].map((sym, i) => ({ table:'stocks', id:'t' + i, cls:'stocks', sym, name:'', sector:'', sub:'' }));
    assert.deepStrictEqual(navPlain(sb._paletteResults('a', tie)).groups.find(g => g.key === 'holdings').items.map(i => i.label), ['A1', 'A2', 'A3']);
    // characters that mean something in a pattern are only characters here
    ['.*', '(', '[', '\\', '^$', '+'].forEach(q => assert.doesNotThrow(() => sb._paletteResults(q, synthPalette()), q));
    assert.strictEqual(sb._paletteResults('.', synthPalette()).count, 0);
  });

  test('_paletteResults - groups in the order Pages, Holdings, Actions, items carry what running them needs, no match leaves no group', () => {
    const sb = panelSandbox();
    const all = navPlain(sb._paletteResults('a', synthPalette()));
    assert.deepStrictEqual(all.groups.map(g => [g.key, g.label]), [['pages', 'Pages'], ['holdings', 'Holdings'], ['actions', 'Actions']]);
    assert.deepStrictEqual(all.groups[0].items[0], { id:'page:dashboard', kind:'page', key:'dashboard', label:'Dashboard', sub:'Overview' });
    const hold = all.groups[1].items.find(i => i.id === 'holding:stocks:h2');
    assert.deepStrictEqual(hold, { id:'holding:stocks:h2', kind:'holding', table:'stocks', hid:'h2', cls:'stocks', sym:'APX', label:'APX', sub:'US' });
    assert.deepStrictEqual(all.groups[2].items.find(i => i.op === 'add' && i.arg === 'stockTxns'), { id:'action:add:stockTxns', kind:'action', op:'add', arg:'stockTxns', label:'Record trade', sub:'Add a stock first', disabled:true });
    assert.deepStrictEqual(navPlain(sb._paletteResults('zzzzqq', synthPalette())), { query:'zzzzqq', groups:[], count:0 });
    // a model with nothing in it, or none at all, gives an empty result, not a throw
    [undefined, null, {}, { pages:[], holdings:[], actions:[] }].forEach(m => assert.deepStrictEqual(navPlain(sb._paletteResults('a', m)).groups, []));
    [undefined, null, 5].forEach(q => assert.strictEqual(sb._paletteResults(q, synthPalette()).query, q === 5 ? '5' : ''));
  });

  test('_paletteResults - at most 8 a group for a typed query, an empty query lists every page and action (they are menus) and no holdings', () => {
    const sb = panelSandbox();
    const big = { pages:Array.from({ length:12 }, (_, i) => ({ key:'p' + i, label:'Page ' + i, sub:'' })),
      holdings:Array.from({ length:12 }, (_, i) => ({ table:'stocks', id:'h' + i, cls:'stocks', sym:'A' + String(i).padStart(2, '0'), name:'', sector:'', sub:'' })),
      actions:Array.from({ length:12 }, (_, i) => ({ id:'a' + i, op:'add', arg:'x', label:'Act ' + i, sub:'' })) };
    const typed = navPlain(sb._paletteResults('a', big));
    assert.deepStrictEqual(typed.groups.map(g => g.items.length), [8, 8, 8]);
    assert.deepStrictEqual(typed.groups[1].items.map(i => i.label), ['A00', 'A01', 'A02', 'A03', 'A04', 'A05', 'A06', 'A07']);   // the first eight in order
    assert.strictEqual(typed.count, 24);
    assert.strictEqual(vm.runInContext('PALETTE_CAP', sb), 8);
    const empty = navPlain(sb._paletteResults('', big));
    assert.deepStrictEqual(empty.groups.map(g => [g.key, g.items.length]), [['pages', 12], ['actions', 12]]);
    assert.strictEqual(empty.count, 24);
    assert.deepStrictEqual(navPlain(sb._paletteResults('   ', big)).groups.map(g => g.key), ['pages', 'actions']);   // blanks are an empty query
    assert.deepStrictEqual(navPlain(sb._paletteResults('', synthPalette())).groups.map(g => g.key), ['pages', 'actions']);
  });

  test('_paletteMark and _paletteHtml - the first match is marked, everything is escaped, options number across the groups and carry the combobox attributes', () => {
    const sb = panelSandbox();
    assert.strictEqual(sb._paletteMark('Dashboard', 'da'), '<mark class="cp-mark">Da</mark>shboard');
    assert.strictEqual(sb._paletteMark('Dashboard', ''), 'Dashboard');
    assert.strictEqual(sb._paletteMark('Dashboard', 'zz'), 'Dashboard');
    assert.strictEqual(sb._paletteMark('<img src=x>', 'img'), '&lt;<mark class="cp-mark">img</mark> src=x&gt;');
    assert.strictEqual(sb._paletteMark('A&B', 'a&b'), '<mark class="cp-mark">A&amp;B</mark>');
    assert.strictEqual(sb._paletteMark('İstanbul', 'st'), 'İstanbul');    // a lower-case form of another length is left unmarked rather than cut in the wrong place
    assert.strictEqual(sb._paletteMark(null, 'a'), '');
    const r = sb._paletteResults('s', synthPalette());
    const html = sb._paletteHtml(r, 1);
    assert.ok(html.startsWith('<div class="cp-group" role="group" aria-labelledby="cp-g-pages"><div class="cp-label" id="cp-g-pages" role="presentation">Pages</div>'));
    assert.ok(html.includes('<div class="cp-opt" role="option" id="cp-o-0" data-i="0" data-click="paletteRun" data-a0="0" aria-selected="false">'));
    assert.ok(html.includes('<div class="cp-opt" role="option" id="cp-o-1" data-i="1" data-click="paletteRun" data-a0="1" aria-selected="true">'));
    assert.strictEqual((html.match(/aria-selected="true"/g) || []).length, 1);
    assert.ok(html.includes('<span class="cp-t"><mark class="cp-mark">S</mark>tocks</span><span class="cp-s">A<mark class="cp-mark">s</mark>sets</span>'));   // the sub text is marked too
    assert.ok(html.includes('aria-labelledby="cp-g-actions"') && html.includes('id="cp-o-4"'));      // four pages, so the first action is the fifth option
    assert.strictEqual(html.includes('aria-disabled'), false);                                          // Record trade holds no s, so no disabled option is in this list
  });

  test('_paletteHtml - a holding row has a monogram, a disabled action says so, add and refresh and the toggles have their own icon, nothing is a raw handler', () => {
    const sb = panelSandbox();
    sb.privacyOn = () => false;
    const html = sb._paletteHtml(sb._paletteResults('', synthPalette()), 0);
    assert.ok(html.includes('aria-disabled="true"') && html.includes('<span class="cp-s">Add a stock first</span>'));
    assert.ok(html.includes(vm.runInContext('CP_PLUS_ICON', sb)) && html.includes(vm.runInContext('CP_REFRESH_ICON', sb)));
    assert.ok(html.includes('class="cp-ico"><svg aria-hidden="true" focusable="false"'));             // a page uses its tab's line icon
    const hold = sb._paletteHtml(sb._paletteResults('apx', synthPalette()), 0);
    assert.ok(hold.includes('class="mono" style="background:var(--c-stocks-soft);color:var(--c-stocks-ink)" aria-hidden="true">A</span>'));
    assert.ok(hold.includes('<span class="cp-t"><mark class="cp-mark">APX</mark></span><span class="cp-s">US</span>'));
    assert.strictEqual(/\son[a-z]+="/i.test(html + hold), false);
    // hostile text reaches the page only as escaped text, in the label, the sub text and the attributes
    const evil = { pages:[{ key:'dashboard', label:'<img src=x onerror=1>', sub:'"><script>1</script>' }],
      holdings:[{ table:'stocks', id:'h"1', cls:'stocks', sym:'<svg onload=1>', name:'<b>n</b>', sector:'', sub:'<i>sub</i>' }], actions:[{ id:'a1', op:'add', arg:'x', label:'<u>act</u>', sub:'' }] };
    ['', 'img', 'svg', 'u'].forEach(q => {
      const out = sb._paletteHtml(sb._paletteResults(q, evil), 0);
      assert.strictEqual(/<img|<script|<svg onload|<b>|<i>|<u>/i.test(out.replace(/<svg viewBox[^>]*>/g, '')), false, 'raw markup for ' + JSON.stringify(q));
    });
    assert.ok(sb._paletteHtml(sb._paletteResults('img', evil), 0).includes('&lt;<mark class="cp-mark">img</mark> src=x onerror=1&gt;'));
  });

  test('_paletteModel - every live page under the sidebar\'s labels, every stock and coin, and actions named for what they will do now', () => {
    const { sb } = overlaySandbox(panelFixture());
    sb.ENTITY_SCHEMAS = { stocks:{}, stockTxns:{}, crypto:{}, cash:{}, realestate:{}, insurance:{}, income:{}, expenses:{} };
    let privacy = false, theme = 'dark';
    sb.privacyOn = () => privacy; sb.currentTheme = () => theme;
    const m = navPlain(sb._paletteModel());
    assert.deepStrictEqual(m.pages.map(p => p.label), ['Dashboard', 'Projections', 'Explore', 'Stocks', 'Crypto', 'Cash', 'CPF', 'Real estate', 'Insurance', 'Income & spending', 'Watchlist', 'Settings']);
    assert.deepStrictEqual(m.pages.map(p => p.key), ['dashboard', 'projections', 'explore', 'stocks', 'crypto', 'cash', 'cpf', 'realestate', 'insurance', 'cashflow', 'board', 'settings']);
    assert.deepStrictEqual(m.pages.map(p => p.sub), ['Overview', 'Overview', 'Overview', 'Assets', 'Assets', 'Assets', 'Assets', 'Assets', 'Assets', 'Money', 'Money', '']);
    assert.deepStrictEqual(m.holdings.map(h => [h.table, h.id, h.sym, h.name, h.sector, h.sub]), [
      ['stocks', 's_aapl', 'AAPL', 'Apple Inc', 'Information Technology', 'Apple Inc · US'],
      ['stocks', 's_d05', 'D05', '', 'Financials', 'SGX · Financials'],
      ['stocks', 's_nopx', 'NOPX', '', '', 'US'],
      ['stocks', 's_o39', 'O39', '', 'Financials', 'SGX · Financials'],
      ['crypto', 'c_btc', 'BTC', 'Bitcoin', 'Crypto', 'Bitcoin · Crypto']]);
    // every + Add flow in the + Add menu's order, then the four actions
    assert.deepStrictEqual(m.actions.map(a => a.label), ['Add stock', 'Record trade', 'Add coin', 'Add cash account', 'Add property', 'Add policy', 'Add income', 'Add expense',
      'Refresh prices', 'Hide amounts', 'Switch to light theme', 'Include CPF']);
    assert.deepStrictEqual(m.actions.slice(0, 8).map(a => a.arg), ['stocks', 'stockTxns', 'crypto', 'cash', 'realestate', 'insurance', 'income', 'expenses']);
    assert.deepStrictEqual(m.actions.map(a => !!a.disabled), Array(12).fill(false));
    // the toggles read what they will do
    privacy = true; theme = 'light'; vm.runInContext('_dashShowCpf = true;', sb);
    assert.deepStrictEqual(navPlain(sb._paletteModel()).actions.slice(8).map(a => a.label), ['Refresh prices', 'Show amounts', 'Switch to dark theme', 'Exclude CPF']);
    // a trade needs a stock to belong to: with none, Record trade stays on the list, disabled, with the reason
    sb.DB.stocks = [];
    const bare = navPlain(sb._paletteModel());
    const rec = bare.actions.find(a => a.arg === 'stockTxns');
    assert.deepStrictEqual({ label:rec.label, disabled:rec.disabled, sub:rec.sub }, { label:'Record trade', disabled:true, sub:'Add a stock first' });
    assert.deepStrictEqual(bare.holdings.map(h => h.sym), ['BTC']);
  });

  test('_paletteModel - a page parked in PHASE_2_TABS is left out of the pages, its holdings and its add flows', () => {
    const { sb } = overlaySandbox(panelFixture());
    sb.ENTITY_SCHEMAS = { stocks:{}, stockTxns:{}, crypto:{}, cash:{}, realestate:{}, insurance:{}, income:{}, expenses:{} };
    sb.privacyOn = () => false; sb.currentTheme = () => 'dark';
    vm.runInContext("PHASE_2_TABS.add('crypto'); PHASE_2_TABS.add('cpf');", sb);
    let m = navPlain(sb._paletteModel());
    assert.strictEqual(m.pages.some(p => p.key === 'crypto' || p.key === 'cpf'), false);
    assert.strictEqual(m.pages.length, 10);
    assert.strictEqual(m.holdings.some(h => h.table === 'crypto'), false);
    assert.strictEqual(m.actions.some(a => a.arg === 'crypto'), false);
    assert.strictEqual(sb._paletteResults('crypto', sb._paletteModel()).groups.some(g => g.items.some(i => i.key === 'crypto' || i.table === 'crypto' || i.arg === 'crypto')), false);
    assert.strictEqual(sb._paletteResults('cpf', sb._paletteModel()).groups.filter(g => g.key === 'pages').length, 0);
    vm.runInContext("PHASE_2_TABS.add('stocks');", sb);
    m = navPlain(sb._paletteModel());
    assert.strictEqual(m.holdings.length, 0);
    assert.strictEqual(m.actions.some(a => a.arg === 'stocks' || a.arg === 'stockTxns'), false);
    assert.deepStrictEqual(m.actions.map(a => a.label).slice(-4), ['Refresh prices', 'Hide amounts', 'Switch to light theme', 'Include CPF']);
  });

  /* The overlay sandbox with the palette's collaborators recorded, and a listbox that finds its options in the markup it was given (aria-selected is read back from them). */
  function paletteSandbox(db){
    const o = overlaySandbox(db || panelFixture());
    const { sb, doc, calls } = o;
    sb.ENTITY_SCHEMAS = { stocks:{}, stockTxns:{}, crypto:{}, cash:{}, realestate:{}, insurance:{}, income:{}, expenses:{} };
    sb.privacyOn = () => false; sb.currentTheme = () => 'dark';
    sb.navigate = key => calls.push(['navigate', key]);
    sb.openHoldingDetail = (table, id) => calls.push(['holding', table, id]);
    sb.addMenuPick = table => calls.push(['add', table]);
    sb.refreshDashPrices = () => calls.push(['refresh']);
    sb.togglePrivacy = () => calls.push(['privacy']);
    sb.toggleTheme = () => calls.push(['theme']);
    sb.toggleDashCpf = () => { calls.push(['cpf']); vm.runInContext('_dashShowCpf = !_dashShowCpf;', sb); };
    doc.els['cmd-palette'].kids = [doc.els['cp-input']];   // the field sits inside the palette, as it does in the page
    const opts = {}, scrolled = [];
    const list = doc.els['cp-list'];
    list.querySelectorAll = sel => sel === '.cp-opt'
      ? Array.from(list.innerHTML.matchAll(/id="cp-o-(\d+)"/g)).map(m => (opts[m[1]] = opts[m[1]] || { id:'cp-o-' + m[1], attrs:{}, setAttribute(k, v){ this.attrs[k] = v; }, scrollIntoView(){ scrolled.push(this.id); } }))
      : [];
    return Object.assign(o, { opts, scrolled, input:doc.els['cp-input'], list, empty:doc.els['cp-empty'], status:doc.els['cp-status'], overlay:doc.els['cmd-palette'] });
  }
  const cpState = sb => navPlain(vm.runInContext('({ query:_cp.query, active:_cp.active, n:_cp.items.length })', sb));

  test('openCommandPalette - opens the dialog on an empty query, focus in the field, the trap on the overlay with Escape closing it, and the combobox pointing at the first result', () => {
    const { sb, doc, calls, input, list, overlay, status, empty } = paletteSandbox();
    input.value = 'left over';
    assert.strictEqual(sb.openCommandPalette(), true);
    assert.ok(overlay.classList.contains('open'));
    assert.deepStrictEqual(calls.filter(c => c[0] === 'trap'), [['trap', 'cmd-palette', 'closeCommandPalette']]);
    assert.strictEqual(input.value, '');
    assert.strictEqual(doc.activeElement, input);                       // focused now, not a frame later
    assert.strictEqual(input.getAttribute('aria-expanded'), 'true');
    assert.strictEqual(input.getAttribute('aria-activedescendant'), 'cp-o-0');
    assert.strictEqual(list.hidden, false); assert.strictEqual(empty.hidden, true);
    assert.deepStrictEqual(cpState(sb), { query:'', active:0, n:24 });   // 12 pages and 12 actions on an empty query
    assert.strictEqual(status.textContent, '24 results');
    assert.ok(list.innerHTML.includes('id="cp-g-pages"') && list.innerHTML.includes('id="cp-g-actions"') && !list.innerHTML.includes('id="cp-g-holdings"'));
    // already open: a second open does nothing
    calls.length = 0;
    assert.strictEqual(sb.openCommandPalette(), false);
    assert.deepStrictEqual(calls, []);
    // the field and the phone icon both reach it through the one delegated action
    const wiring = extractFunction('installEventDelegation');
    assert.ok(wiring.includes('openCommandPalette:  () => openCommandPalette(),') && wiring.includes('closeCommandPalette: () => closeCommandPalette(),'));
  });

  test('closeCommandPalette - closes, releases the trap (focus returns to the opener), and a second close does nothing', () => {
    const { sb, calls, overlay } = paletteSandbox();
    assert.strictEqual(sb.closeCommandPalette(), false);
    sb.openCommandPalette(); calls.length = 0;
    assert.strictEqual(sb.closeCommandPalette(), true);
    assert.strictEqual(overlay.classList.contains('open'), false);
    assert.deepStrictEqual(calls, [['release', 'cmd-palette']]);
    assert.strictEqual(vm.runInContext('_cp', sb), null);
    assert.strictEqual(sb.closeCommandPalette(), false);
  });

  test('closeCommandPalette - focus goes back to the opener when it can take it, and is never left on the hidden field when it cannot', () => {
    const { sb, doc, input } = paletteSandbox();
    const opener = { id:'cp-trigger', visible:true, focus(){ doc.activeElement = this; } };
    // an opener that is still on the page: closeModalFocus returns focus to it, and it is left there
    sb.closeModalFocus = () => opener.focus();
    sb.openCommandPalette(); assert.strictEqual(doc.activeElement, input);
    sb.closeCommandPalette(); assert.strictEqual(doc.activeElement, opener);
    // an opener that is gone (a repaint replaced it, its page was hidden): the field is not left holding focus inside the hidden palette
    sb.closeModalFocus = () => {};
    sb.openCommandPalette(); assert.strictEqual(doc.activeElement, input);
    sb.closeCommandPalette(); assert.strictEqual(doc.activeElement, doc.body);
  });

  test('paletteQuery - searches again from the top, the combobox follows, no match shows a No matches state and Enter then does nothing', () => {
    const { sb, input, list, empty, status, calls } = paletteSandbox();
    sb.openCommandPalette();
    assert.strictEqual(sb.paletteQuery('aap'), true);
    assert.deepStrictEqual(cpState(sb), { query:'aap', active:0, n:1 });
    assert.ok(list.innerHTML.includes('id="cp-g-holdings"') && list.innerHTML.includes('<mark class="cp-mark">AAP</mark>L'));
    assert.strictEqual(status.textContent, '1 result');
    assert.strictEqual(input.getAttribute('aria-activedescendant'), 'cp-o-0');
    // typing moves the active result back to the top
    sb.paletteQuery('a'); sb._paletteMove(2);
    assert.strictEqual(cpState(sb).active, 2);
    sb.paletteQuery('ap'); assert.strictEqual(cpState(sb).active, 0);
    // nothing matches
    sb.paletteQuery('zzzzqq');
    assert.deepStrictEqual(cpState(sb), { query:'zzzzqq', active:0, n:0 });
    assert.strictEqual(list.hidden, true); assert.strictEqual(empty.hidden, false); assert.strictEqual(status.textContent, 'No matches');
    assert.strictEqual(input.getAttribute('aria-expanded'), 'false'); assert.strictEqual(input.getAttribute('aria-activedescendant'), '');
    calls.length = 0;
    const key = { key:'Enter', preventDefault(){ this.prevented = true; } };
    assert.strictEqual(sb.paletteKeydown(key), true);                   // Enter is taken, and it runs nothing
    assert.strictEqual(key.prevented, true);
    assert.deepStrictEqual(calls, []); assert.ok(vm.runInContext('_cp', sb) !== null);
    // clearing the field shows the menus again
    sb.paletteQuery(''); assert.strictEqual(cpState(sb).n, 24); assert.strictEqual(empty.hidden, true);
    // a long paste is cut at 80 characters, and a closed palette ignores the call
    sb.paletteQuery('x'.repeat(200)); assert.strictEqual(cpState(sb).query.length, 80);
    sb.closeCommandPalette(); assert.strictEqual(sb.paletteQuery('a'), false);
  });

  test('palette keys - Arrow Down and Up move through every result and wrap at both ends, Enter runs the active one, other keys and IME composition are left alone', () => {
    const { sb, input, opts, scrolled, calls } = paletteSandbox();
    sb.openCommandPalette();
    const press = (key, extra) => { const e = Object.assign({ key, prevented:false, preventDefault(){ this.prevented = true; } }, extra || {}); return [sb.paletteKeydown(e), e.prevented]; };
    assert.deepStrictEqual(press('ArrowDown'), [true, true]);
    assert.strictEqual(cpState(sb).active, 1);
    assert.strictEqual(input.getAttribute('aria-activedescendant'), 'cp-o-1');
    assert.strictEqual(opts[1].attrs['aria-selected'], 'true'); assert.strictEqual(opts[0].attrs['aria-selected'], 'false');   // exactly one is selected
    assert.ok(scrolled.includes('cp-o-1'));                                                                                  // and it is scrolled into view
    assert.deepStrictEqual(press('ArrowUp'), [true, true]);
    assert.deepStrictEqual(press('ArrowUp'), [true, true]);               // from the first, up wraps to the last
    assert.strictEqual(cpState(sb).active, 23); assert.strictEqual(input.getAttribute('aria-activedescendant'), 'cp-o-23');
    assert.deepStrictEqual(press('ArrowDown'), [true, true]);              // and down from the last wraps to the first
    assert.strictEqual(cpState(sb).active, 0);
    const selected = Object.keys(opts).filter(k => opts[k].attrs['aria-selected'] === 'true');
    assert.deepStrictEqual(selected, ['0']);
    // keys that are not the palette's are not taken (Home and End move the caret, letters type)
    ['Home', 'End', 'a', 'Tab', 'Escape', 'PageDown', 'Backspace'].forEach(k => assert.deepStrictEqual(press(k), [false, false], k));
    // IME composition: the browser's own Enter picks a candidate, the palette must not run a result
    calls.length = 0;
    assert.deepStrictEqual(press('Enter', { isComposing:true }), [false, false]); assert.deepStrictEqual(calls, []);
    // Enter runs the active result (the palette closes first), and only while it is open
    sb._paletteMove(3);
    assert.deepStrictEqual(press('Enter'), [true, true]);
    assert.deepStrictEqual(calls, [['release', 'cmd-palette'], ['navigate', 'stocks']]);   // the fourth page, Stocks
    assert.deepStrictEqual(press('ArrowDown'), [false, false]);
  });

  test('palette hover - the pointer makes a result active (one active result, never two), out of range or on the active one it does nothing', () => {
    const { sb, input, opts } = paletteSandbox();
    sb.openCommandPalette();
    assert.strictEqual(sb.paletteHover('5'), true);
    assert.strictEqual(cpState(sb).active, 5); assert.strictEqual(input.getAttribute('aria-activedescendant'), 'cp-o-5');
    assert.strictEqual(opts[5].attrs['aria-selected'], 'true'); assert.strictEqual(opts[0].attrs['aria-selected'], 'false');
    assert.strictEqual(sb.paletteHover(5), false);      // already the active one
    [-1, 24, 99, 'x', null, undefined, 1.5, NaN, '', ' 5', '5.5', '-1', '1e1', '+2', {}, [3]].forEach(i => assert.strictEqual(sb.paletteHover(i), false, String(i)));   // a missing data attribute is not result 0
    assert.strictEqual(cpState(sb).active, 5);
    sb.closeCommandPalette(); assert.strictEqual(sb.paletteHover(1), false);
  });

  test('runPaletteItem - the palette closes first, then a page navigates, a holding opens its panel, and every action runs its own function', () => {
    const { sb, calls } = paletteSandbox();
    const run = (query, id) => {
      sb.openCommandPalette(); sb.paletteQuery(query);
      const at = vm.runInContext('_cp.items', sb).findIndex(i => i.id === id);
      assert.ok(at >= 0, id + ' for ' + JSON.stringify(query)); calls.length = 0;
      assert.strictEqual(sb.runPaletteItem(at), true);
      return calls.slice();
    };
    assert.deepStrictEqual(run('', 'page:cashflow'), [['release', 'cmd-palette'], ['navigate', 'cashflow']]);
    assert.deepStrictEqual(run('aap', 'holding:stocks:s_aapl'), [['release', 'cmd-palette'], ['holding', 'stocks', 's_aapl']]);
    assert.deepStrictEqual(run('btc', 'holding:crypto:c_btc'), [['release', 'cmd-palette'], ['holding', 'crypto', 'c_btc']]);
    assert.deepStrictEqual(run('add coin', 'action:add:crypto'), [['release', 'cmd-palette'], ['add', 'crypto']]);
    assert.deepStrictEqual(run('record', 'action:add:stockTxns'), [['release', 'cmd-palette'], ['add', 'stockTxns']]);   // addMenuPick says "Add a stock first" itself when there is none
    assert.deepStrictEqual(run('refresh', 'action:refresh'), [['release', 'cmd-palette'], ['refresh']]);
    assert.deepStrictEqual(run('hide', 'action:privacy'), [['release', 'cmd-palette'], ['privacy']]);
    assert.deepStrictEqual(run('theme', 'action:theme'), [['release', 'cmd-palette'], ['theme']]);
    // Include CPF flips the switch and says what it did (the dashboard may not be on screen)
    assert.deepStrictEqual(run('cpf', 'action:cpf'), [['release', 'cmd-palette'], ['cpf'], ['toast', 'CPF included in net worth', '']]);
    assert.deepStrictEqual(run('cpf', 'action:cpf'), [['release', 'cmd-palette'], ['cpf'], ['toast', 'CPF left out of net worth', '']]);
    // an index that is not a result runs nothing and leaves the palette open
    sb.openCommandPalette(); calls.length = 0;
    [-1, 99, NaN, 1.5, 'x', undefined, null, '', '1e1', '-1', ' 2', {}, [1]].forEach(i => assert.strictEqual(sb.runPaletteItem(i), false, String(i)));
    assert.deepStrictEqual(calls, []); assert.ok(vm.runInContext('_cp', sb) !== null);
    sb.closeCommandPalette(); assert.strictEqual(sb.runPaletteItem(0), false);
    // the click on an option goes through the delegated action with its number
    const wiring = extractFunction('installEventDelegation');
    assert.ok(wiring.includes('paletteRun:          (el) => runPaletteItem(A(el)[0]),') && wiring.includes('paletteInput:        (el) => paletteQuery(el.value),'));
    assert.deepStrictEqual(['3', 3, '0', '12'].map(v => sb._paletteIndex(v)), [3, 3, 0, 12]);
  });

  test('the shortcut - Cmd+K and Ctrl+K open the palette from anywhere, with no Shift or Alt, and a second press closes it', () => {
    const { sb, calls } = paletteSandbox();
    const press = e => { const ev = Object.assign({ prevented:0, preventDefault(){ this.prevented++; } }, e); return [sb.paletteShortcut(ev), ev.prevented]; };
    assert.deepStrictEqual(press({ key:'k', metaKey:true }), [true, 1]);
    assert.ok(vm.runInContext('_cp', sb) !== null);
    assert.deepStrictEqual(press({ key:'k', metaKey:true }), [true, 1]);      // Cmd+K again closes it
    assert.strictEqual(vm.runInContext('_cp', sb), null);
    assert.deepStrictEqual(press({ key:'k', ctrlKey:true }), [true, 1]);
    assert.ok(vm.runInContext('_cp', sb) !== null);
    sb.closeCommandPalette();
    assert.deepStrictEqual(press({ key:'K', ctrlKey:true }), [true, 1]);      // caps lock
    sb.closeCommandPalette();
    // anything else is not the shortcut and is left to the browser: no open, no preventDefault
    [{ key:'k' }, { key:'k', shiftKey:true, metaKey:true }, { key:'k', altKey:true, ctrlKey:true }, { key:'j', metaKey:true }, { key:'Enter', ctrlKey:true }, { key:undefined, metaKey:true }, { key:12, ctrlKey:true }, { key:'k', metaKey:false, ctrlKey:false }]
      .forEach(e => assert.deepStrictEqual(press(e), [false, 0], JSON.stringify(e)));
    assert.strictEqual(vm.runInContext('_cp', sb), null);
    assert.strictEqual(sb._isPaletteShortcut(null), false); assert.strictEqual(sb._isPaletteShortcut(undefined), false);
    // the listener runs it for every keydown, ahead of the field's own keys
    const wiring = extractFunction('installEventDelegation');
    assert.ok(wiring.includes("if (paletteShortcut(e)) return;\n    if (e.target && e.target.id === 'cp-input') paletteKeydown(e);"));
    assert.deepStrictEqual(calls.filter(c => c[0] === 'toast'), []);
  });

  test('the shortcut - ignored while the unlock gate is up, while any modal or sheet is open, and while the side panel is open', () => {
    const { sb, doc } = paletteSandbox();
    const press = (e) => { const ev = Object.assign({ key:'k', metaKey:true, prevented:0, preventDefault(){ this.prevented++; } }, e); return [sb.paletteShortcut(ev), ev.prevented, vm.runInContext('_cp', sb) !== null]; };
    const ignored = [false, 0, false];            // not handled, the browser keeps the key, no palette
    assert.strictEqual(sb._commandPaletteBlocked(), false);
    // the vault unlock gate and the NAS sign-in gate (both are .overlay.open)
    doc.els['vault-gate'].classList.add('open');
    assert.strictEqual(sb._commandPaletteBlocked(), true);
    assert.deepStrictEqual(press({}), ignored); assert.deepStrictEqual(press({ ctrlKey:true, metaKey:false }), ignored);
    doc.els['vault-gate'].classList.remove('open');
    doc.els['nas-auth-gate'].classList.add('open');
    assert.deepStrictEqual(press({}), ignored);
    doc.els['nas-auth-gate'].classList.remove('open');
    // a vault that is on and locked has nothing to search, even before its gate paints
    sb._vaultManager = { isEnabled:() => true, isUnlocked:() => false };
    assert.deepStrictEqual(press({}), ignored);
    sb._vaultManager = { isEnabled:() => true, isUnlocked:() => true };
    assert.strictEqual(sb._commandPaletteBlocked(), false);
    sb._vaultManager = { isEnabled:() => false, isUnlocked:() => false };
    assert.strictEqual(sb._commandPaletteBlocked(), false);
    sb._vaultManager = null;
    // any open modal: the entity form, the sync details, the More sheet, the conflict dialog, the setup wizard (all are .overlay.open)
    ['entity-modal', 'sync-details-modal', 'more-sheet', 'conflict-modal', 'setup-wizard'].forEach(id => {
      doc.openOverlay = { id, classList:{ contains: n => n === 'open' } };
      assert.strictEqual(sb._commandPaletteBlocked(), true, id);
      assert.deepStrictEqual(press({}), ignored, id);
    });
    doc.openOverlay = null;
    // the side panel, by its state and by its class
    sb.openHoldingPanel('stocks', 's_aapl');
    assert.strictEqual(sb._commandPaletteBlocked(), true);
    assert.deepStrictEqual(press({}), ignored);
    assert.strictEqual(sb.openCommandPalette(), false);       // the field button and the phone icon are blocked the same way
    sb.closeHoldingPanel();
    doc.els['holding-panel'].classList.add('open'); vm.runInContext('_hp = null;', sb);
    assert.strictEqual(sb._commandPaletteBlocked(), true);
    doc.els['holding-panel'].classList.remove('open');
    // all clear: it opens
    assert.deepStrictEqual(press({}), [true, 1, true]);
    // and the check reads the live DOM each time, not a remembered answer
    sb.closeCommandPalette(); doc.els['vault-gate'].classList.add('open');
    assert.strictEqual(sb.openCommandPalette(), false);
  });

  test('palette hint - Cmd K on a Mac, an iPhone or an iPad, Ctrl K elsewhere, set on the field, its title and the phone icon at boot', () => {
    const sb = panelSandbox();
    [[{ platform:'MacIntel' }, true], [{ userAgentData:{ platform:'macOS' }, platform:'Win32' }, true], [{ platform:'iPhone' }, true], [{ platform:'iPad' }, true], [{ userAgent:'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' }, true],
      [{ platform:'Win32' }, false], [{ platform:'Linux x86_64' }, false], [{ userAgent:'Mozilla/5.0 (Linux; Android 14; Pixel 8)' }, false], [{ userAgentData:{ platform:'Windows' } }, false], [{}, false]]
      .forEach(([nav, apple]) => { assert.strictEqual(sb._isApplePlatform(nav), apple, JSON.stringify(nav)); assert.strictEqual(sb._paletteHint(nav), apple ? '⌘K' : 'Ctrl K'); });
    assert.strictEqual(sb._isApplePlatform(), false);   // no navigator at all (the sandbox has none)
    const { sb: ov, doc } = overlaySandbox(panelFixture());
    ov.navigator = { platform:'MacIntel' };
    ov._syncPaletteHint();
    assert.strictEqual(doc.els['cp-kbd'].textContent, '⌘K');
    assert.strictEqual(doc.els['cp-trigger'].title, 'Search or jump to (⌘K)'); assert.strictEqual(doc.els['cp-trigger-m'].title, 'Search or jump to (⌘K)');
    ov.navigator = { platform:'Win32' }; ov._syncPaletteHint();
    assert.strictEqual(doc.els['cp-kbd'].textContent, 'Ctrl K'); assert.strictEqual(doc.els['cp-trigger'].title, 'Search or jump to (Ctrl K)');
    assert.ok(extractFunction('boot').includes('_syncPaletteHint();'));
  });

  test('the dashboard Holdings card - every row is one button that opens the holding\'s side panel, a row with no safe id falls back to its tab', () => {
    const sb = panelSandbox(panelFixture(), 'SGD');
    const rows = sb._dashHoldingRows(sb.buildStockChartRows());
    assert.deepStrictEqual(navPlain(rows.map(r => [r.table, r.id, r.nav])), [['stocks', 's_aapl', 'stocks'], ['stocks', 's_d05', 'stocks'], ['stocks', 's_nopx', 'stocks'], ['stocks', 's_o39', 'stocks'], ['crypto', 'c_btc', 'crypto']]);
    const html = sb._dashHoldings(rows, 16550);
    const buttons = Array.from(html.matchAll(/<button type="button" class="dash-hrow"[^>]*>/g)).map(m => m[0]);
    assert.strictEqual(buttons.length, 5);
    // Step 8b: each row also carries data-px, the price-cache key of its holding, which the price flash finds the row by
    assert.ok(buttons.includes('<button type="button" class="dash-hrow" data-click="openHolding" data-a0="stocks" data-a1="s_aapl" aria-haspopup="dialog" data-px="AAPL">'));
    assert.ok(buttons.includes('<button type="button" class="dash-hrow" data-click="openHolding" data-a0="crypto" data-a1="c_btc" aria-haspopup="dialog" data-px="bitcoin">'));
    assert.strictEqual(html.includes('data-click="navigate"'), false);   // a row no longer only opens its tab
    assert.strictEqual(/\son[a-z]+="/i.test(html), false);
    assert.ok(html.includes('class="dash-hval money-chip"') && html.includes('<b>AAPL</b>'));
    // an id that is not safe never reaches the action: the row opens its tab as before, and a hostile id stays out of the markup
    const odd = rows.slice(0, 2).map(r => Object.assign({}, r));
    odd[0].id = '"><b>x</b>'; odd[1].id = undefined;
    const fallback = sb._dashHoldings(odd, 16550);
    assert.strictEqual((fallback.match(/data-click="navigate" data-a0="stocks"/g) || []).length, 2);
    assert.strictEqual(fallback.includes('openHolding') || fallback.includes('<b>x</b>'), false);
    // the empty card is unchanged
    assert.ok(sb._dashHoldings([], 0).includes('No holdings yet'));
  });

  test('the Stocks and Crypto tables - the symbol cell is a button that opens the side panel, Edit and Analyse are untouched, hostile text stays escaped', () => {
    const sb = listSandbox(stockFixture(), 'USD');
    const els = stocksBox(sb);
    sb.renderStocks();
    const html = els['stocks-body'].innerHTML;
    assert.ok(html.includes('<td class="tl cell-sym sticky-col"><button type="button" class="sym-btn" data-click="openHolding" data-a0="stocks" data-a1="s_aapl" aria-haspopup="dialog" aria-label="Open AAPL details">AAPL</button></td>'));
    assert.strictEqual((html.match(/class="sym-btn"/g) || []).length, 4);
    assert.ok(html.includes('<button class="btn btn-sm btn-ghost btn-edit" data-edit-table="stocks" data-edit-id="s_aapl">Edit</button>'));
    assert.ok(html.includes('target="_blank" rel="noopener" title="Open chart analysis for AAPL">Analyse</a>'));
    // the phone rows already opened the holding through the same action
    assert.strictEqual((html.match(/data-click="openHolding" data-a0="stocks"/g) || []).length, 8);   // four buttons in the table, four rows in the list
    // a hostile symbol and id stay inside their attributes and text
    const evil = '<img src=x onerror="window.__x=1">';
    const bad = listSandbox({ stocks:[{ id:'s_"><b>x</b>', symbol:evil, market:'US', shares:1, avgCost:1, currency:'USD' }], _priceCache:{} }, 'USD');
    const badEls = stocksBox(bad); bad.renderStocks();
    const cell = /<td class="tl cell-sym sticky-col">[\s\S]*?<\/td>/.exec(badEls['stocks-body'].innerHTML)[0];
    assert.strictEqual(/<img|<b>/.test(cell), false);
    assert.ok(cell.includes('data-a1="s_&quot;&gt;&lt;b&gt;x&lt;/b&gt;"') && cell.includes('aria-label="Open &lt;img src=x onerror=&quot;window.__x=1&quot;&gt; details">&lt;img src=x onerror=&quot;window.__x=1&quot;&gt;</button>'));
    // Crypto: the same cell, and the coin's Edit button as before
    const cs = listSandbox({ crypto:[{ id:'c_btc', symbol:'BTC', coingeckoId:'bitcoin', amount:0.25, avgCost:60000, currency:'USD' }], _priceCache:{ bitcoin:{ sgd:152000, change24h:1.8, fetchedAt:TODAY_ISO } } });
    const cEls = renderBox(cs, ['crypto-body', 'crypto-summary', 'freshness-crypto']);
    cs.renderCrypto();
    const cHtml = cEls['crypto-body'].innerHTML;
    assert.ok(cHtml.includes('<td class="tl cell-sym"><button type="button" class="sym-btn" data-click="openHolding" data-a0="crypto" data-a1="c_btc" aria-haspopup="dialog" aria-label="Open BTC details">BTC</button></td>'));
    assert.ok(cHtml.includes('<button class="btn btn-sm btn-ghost btn-edit" data-edit-table="crypto" data-edit-id="c_btc">Edit</button>'));
  });

  test('Step 8a markup - the panel and the palette are labelled dialogs, the combobox carries its attributes, the triggers sit in the top bar, nothing is an inline handler', () => {
    assert.ok(indexSrc.includes('<div class="hp-overlay" id="holding-panel" role="dialog" aria-modal="true" aria-labelledby="hp-title" tabindex="-1">\n  <div class="hp-panel" id="hp-panel"></div>\n</div>'));
    assert.ok(indexSrc.includes('<div class="cp-overlay" id="cmd-palette" role="dialog" aria-modal="true" aria-label="Search or jump to" tabindex="-1">'));
    const input = /<input type="text" class="cp-input"[^>]*>/.exec(indexSrc)[0];
    ['id="cp-input"', 'role="combobox"', 'aria-expanded="false"', 'aria-controls="cp-list"', 'aria-autocomplete="list"', 'aria-activedescendant=""', 'aria-label="Search or jump to"', 'placeholder="Search or jump to"',
      'autocomplete="off"', 'spellcheck="false"', 'maxlength="80"', 'data-input="paletteInput"'].forEach(a => assert.ok(input.includes(a), a));
    assert.ok(indexSrc.includes('<div class="cp-list" id="cp-list" role="listbox" aria-label="Results" hidden></div>'));
    assert.ok(indexSrc.includes('<p class="cp-empty" id="cp-empty" hidden>No matches</p>'));
    assert.ok(indexSrc.includes('<p class="sr-only" id="cp-status" role="status" aria-live="polite"></p>'));
    assert.ok(indexSrc.includes('<button type="button" class="icon-btn cp-x" data-click="closeCommandPalette" aria-label="Close search">'));
    // after the other overlays, before the toast host (a toast stays above them)
    assert.ok(indexSrc.indexOf('id="sync-details-modal"') < indexSrc.indexOf('id="holding-panel"') && indexSrc.indexOf('id="holding-panel"') < indexSrc.indexOf('id="cmd-palette"') && indexSrc.indexOf('id="cmd-palette"') < indexSrc.indexOf('id="toast-host"'));
    // the top bar: the field first, then the currency switch, the phone dot, the phone icon, Hide amounts and + Add
    const bar = indexSrc.slice(indexSrc.indexOf('<div class="tb-actions">'), indexSrc.indexOf('</header>'));
    const order = ['id="cp-trigger"', 'class="ccy-toggle"', 'id="sync-dot"', 'id="cp-trigger-m"', 'id="privacy-toggle"', 'id="add-btn"'].map(k => bar.indexOf(k));
    assert.ok(order.every((v, i) => v > -1 && (i === 0 || v > order[i - 1])), JSON.stringify(order));
    ['class="tb-search" id="cp-trigger" data-click="openCommandPalette" aria-haspopup="dialog" aria-keyshortcuts="Control+K Meta+K" aria-label="Search or jump to" title="Search or jump to"',
      '<span class="tb-search-lbl">Search or jump to</span>', '<kbd class="tb-kbd" id="cp-kbd" aria-hidden="true">Ctrl K</kbd>',
      'id="cp-trigger-m" class="icon-btn tb-search-m" data-click="openCommandPalette" aria-haspopup="dialog" aria-label="Search or jump to" title="Search or jump to"'].forEach(f => assert.ok(bar.includes(f), f));
    // CSP: no inline handler in any of it
    const fresh = bar + indexSrc.slice(indexSrc.indexOf('<!-- HOLDING SIDE PANEL (Step 8a)'), indexSrc.indexOf('<!-- TOAST HOST -->'));
    assert.strictEqual(/\son[a-z]+="/i.test(fresh), false);
    // every data-click in the new markup and in the markup builders is a key of the delegated action map (a dead button is the loss this guards)
    const wiring = extractFunction('installEventDelegation');
    const keys = new Set(Array.from(wiring.matchAll(/^ {4}([A-Za-z0-9_]+):\s/gm)).map(m => m[1]));
    const sources = [fresh].concat(['_hpHeadHtml', '_hpChartHtml', '_hpTradesHtml', '_hpFootHtml', '_paletteOptHtml', '_dashHoldings'].map(n => extractFunction(n))).concat([extractFunction('renderStocks'), extractFunction('renderCrypto')]);
    const used = new Set(); sources.forEach(src => Array.from(src.matchAll(/data-(?:click|input)="([A-Za-z0-9_]+)"/g)).forEach(m => used.add(m[1])));
    ['closeHoldingPanel', 'holdingPanelAction', 'openCommandPalette', 'closeCommandPalette', 'paletteRun', 'paletteInput', 'openHolding'].forEach(k => assert.ok(used.has(k), 'unused ' + k));
    used.forEach(k => assert.ok(keys.has(k), 'data-click without an action: ' + k));
    // the backdrop closes both, through the same lookup the modals use
    assert.ok(wiring.includes("'holding-panel':    closeHoldingPanel,") && wiring.includes("'cmd-palette':      closeCommandPalette"));
    assert.ok(wiring.includes('closeHoldingPanel:   () => closeHoldingPanel(),') && wiring.includes('holdingPanelAction:  (el) => holdingPanelAction(A(el)[0]),'));
    // Escape closes either one even when focus sits outside it
    assert.ok(wiring.includes("if (_cp) closeCommandPalette();\n    else if (_hp) closeHoldingPanel();"));
    // the palette's options keep focus in the field (no focus on press), and the pointer drives the active result
    assert.ok(wiring.includes("if (_cp && e.target.closest && e.target.closest('.cp-list')) e.preventDefault();") && wiring.includes("if (opt) paletteHover(opt.getAttribute('data-i'));"));
    // the panel and the palette use the shared focus helpers, there is no second trap
    ['openHoldingPanel', 'openCommandPalette'].forEach(n => assert.ok(extractFunction(n).includes('openModalFocus(overlay, close'), n));
    ['closeHoldingPanel', 'closeCommandPalette'].forEach(n => assert.ok(extractFunction(n).includes('closeModalFocus(overlay);'), n));
    assert.strictEqual(/addEventListener\('keydown'[^)]*Tab/.test(extractFunction('openHoldingPanel') + extractFunction('openCommandPalette')), false);
  });

  test('Step 8a styles - a 400px panel sliding in over 280ms on the house curve, full width at 768px and below, still under reduced motion, a solid backing, tokens only, the v2.73 block last', () => {
    const start = indexSrc.indexOf('/* HOLDING SIDE PANEL, COMMAND PALETTE AND THEIR TRIGGERS (Step 8a).');
    const end = indexSrc.indexOf('/* MOBILE LIST ROWS, CHIP FILTERS AND ACTIONS (v2.73).');
    assert.ok(start > -1 && end > start);
    const css = indexSrc.slice(start, end);
    assert.ok(css.includes('.hp-panel{position:absolute;top:0;right:0;bottom:0;display:flex;flex-direction:column;width:min(400px,100%);background:linear-gradient(var(--surface-solid),var(--surface-solid)),var(--bg);border-left:1px solid var(--border2);box-shadow:var(--glass-shadow);transform:translateX(102%);transition:transform 0.28s cubic-bezier(.2,.8,.2,1)}'));
    assert.ok(css.includes('.hp-overlay.hp-in .hp-panel{transform:none}') && css.includes('.hp-overlay.hp-in::before{opacity:1}'));
    // closed overlays hide by visibility (so the close can animate and nothing inside is focusable), open ones take the pointer, both sit at the modal layer
    assert.ok(css.includes('.hp-overlay,.cp-overlay{position:fixed;inset:0;z-index:200;visibility:hidden;pointer-events:none;transition:visibility 0s linear 0.28s}'));
    assert.ok(css.includes('.hp-overlay.open,.cp-overlay.open{visibility:visible;pointer-events:auto;transition-delay:0s}'));
    assert.ok(/\.overlay\{[^}]*z-index:200/.test(indexSrc) && /#toast-host\{[^}]*z-index:300/.test(indexSrc));   // the same layer as the modals, under toasts
    // the palette: a centred dialog, its top placed so the full-height dialog would sit mid-window, a solid backing
    assert.ok(css.includes('.cp-overlay{display:flex;align-items:flex-start;justify-content:center;padding:max(48px,calc(50vh - 260px)) 16px 16px;'));
    assert.ok(/\.cp\{[^}]*max-width:560px[^}]*background:linear-gradient\(var\(--surface-solid\),var\(--surface-solid\)\),var\(--bg\)/.test(css));   // --surface-solid over an opaque --bg: the dark one is 94% opaque and the page must not ghost through it
    // phone: the panel is full width, the palette sits at the top, the field text is 16px so iOS does not zoom, Esc and the footer hint give way to a close button
    assert.ok(/@media \(max-width:768px\)\{\s*\.hp-panel\{width:100%;border-left:0\}\s*\.hp-foot \.btn\{min-height:44px\}\s*\}/.test(css));
    const phone = css.slice(css.indexOf('@media (max-width:640px){\n  .cp-overlay'));
    assert.ok(phone.includes('.cp-input{font-size:16px}') && phone.includes('.cp-esc,.cp-foot{display:none}') && phone.includes('.cp-x{display:flex}'));
    assert.ok(css.includes('.cp-x{display:none}'));
    // reduced motion: the panel, its scrim, the palette and the trigger do not move
    assert.ok(css.includes('@media (prefers-reduced-motion:reduce){\n  .hp-overlay,.hp-overlay::before,.hp-panel,.cp-overlay{transition:none}\n}'));
    assert.ok(css.includes('@media (prefers-reduced-motion:reduce){.tb-search{transition:none}}'));
    // the trigger: icon only from 769px to 940px (the bar has no room beside the currency switch), an icon button on the phone, and the title keeps its word at 320px
    assert.ok(css.includes('@media (min-width:769px) and (max-width:940px){.tb-search-lbl,.tb-kbd{display:none}.tb-search{padding:6px 9px}}'));
    assert.ok(css.includes('@media (max-width:768px){.tb-search{display:none}.tb-search-m{display:flex}}') && css.includes('.tb-search-m{display:none}'));
    assert.ok(css.includes('@media (max-width:360px){.ccy-toggle button{padding-inline:6px}}'));
    // floating and solid: no blur on either surface, and no block of the panel gives way to the others (a block with overflow set shrinks to zero otherwise)
    assert.strictEqual(/\.(hp-panel|cp)\{[^}]*backdrop-filter/.test(css), false);
    assert.ok(css.includes('.hp-body > *{flex:none}'));
    // tokens only, bar the scrim black (the literal the modal overlay uses): no hex, and the only two rgba are the two scrims
    assert.strictEqual(/#[0-9a-fA-F]{3,8}\b/.test(css), false);
    assert.deepStrictEqual(css.match(/rgba?\([^)]*\)/g), ['rgba(0,0,0,0.5)', 'rgba(0,0,0,0.5)']);
    assert.ok(indexSrc.includes('.overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,0.7)'));
    // the symbol button reads as the text it replaced
    assert.ok(css.includes('.sym-btn{padding:0;border:0;border-radius:4px;background:none;color:inherit;font:inherit;text-align:left;cursor:pointer}'));
    // the v2.73 block still closes the stylesheet
    assert.strictEqual(indexSrc.slice(end).includes('\n.btn{'), false);
  });

  test('Step 8a contrast - the dim text, the match mark, the gain and loss text and the trigger clear 4.5:1 on the panel, the palette and the top bar in both themes', () => {
    const block = s => { const i = indexSrc.indexOf(s); assert.ok(i > -1, s); return indexSrc.slice(i, indexSrc.indexOf('\n}', i)); };
    const light = block(':root{'), dark = block('html.dark{');
    const token = (blk, name) => {
      const m = new RegExp('--' + name + ':([^;]+);').exec(blk);
      assert.ok(m, '--' + name + ' missing');
      const ref = /^var\(--([a-z0-9-]+)\)$/.exec(m[1].trim());
      return ref ? token(blk, ref[1]) : m[1].trim();
    };
    const colour = text => {                                   // #rrggbb or rgba(r,g,b,a) to { rgb, a }
      const hex = /^#([0-9a-f]{6})$/i.exec(text);
      if (hex) return { rgb:[0, 2, 4].map(i => parseInt(hex[1].slice(i, i + 2), 16)), a:1 };
      const m = /^rgba?\(([^)]*)\)$/.exec(text); assert.ok(m, text);
      const p = m[1].split(',').map(Number); return { rgb:p.slice(0, 3), a:p.length > 3 ? p[3] : 1 };
    };
    const lin = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    const lum = c => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
    const ratio = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
    const over = (top, bottom) => top.rgb.map((v, i) => v * top.a + bottom[i] * (1 - top.a));
    [['light', light], ['dark', dark]].forEach(([name, blk]) => {
      const c = n => colour(token(blk, n));
      // The dark --surface-solid is 94% opaque and the panel and the palette paint an opaque --bg under it, so the surface is --surface-solid over --bg. The light one is opaque white.
      const bg3 = c('bg3').rgb, chk = (what, fg, bg, min) => assert.ok(ratio(fg, bg) >= (min || 4.5), name + ' ' + what + ' ' + ratio(fg, bg).toFixed(2));
      const surface = over(c('surface-solid'), c('bg').rgb);
      ['text3', 'text2', 'text', 'accent', 'gain', 'loss'].forEach(t => chk('--' + t + ' on the panel and palette surface', c(t).rgb, surface));
      // the active result's tint: its text, the dim text that steps up to --text2, and the mark
      ['text', 'text2', 'accent'].forEach(t => chk('--' + t + ' on the active result (--bg3)', c(t).rgb, bg3));
      // the trigger: --text2 on the glass bar over a card or the page, the two surfaces that can scroll behind it
      [['bg2', c('bg2').rgb], ['bg', c('bg').rgb]].forEach(([n, rgb]) => chk('--text2 on the top bar glass over --' + n, c('text2').rgb, over(c('glass'), rgb)));
      // the monogram letters in the panel header sit on their tint over the surface
      ['stocks', 'crypto'].forEach(k => {
        const tint = over({ rgb:c('c-' + k).rgb, a:0.16 }, surface);
        chk('--c-' + k + '-ink on its tint', colour(token(blk, 'c-' + k + '-ink')).rgb, tint);
      });
    });
    // the dim text rules say what they mean: the active result's sub text and the trigger use the stronger tokens
    assert.ok(indexSrc.includes('.cp-opt[aria-selected="true"] .cp-s{color:var(--text2)}'));
    assert.ok(/\.tb-search\{[^}]*color:var\(--text2\)/.test(indexSrc));
  });

  /* ═══ Step 8b: motion and feedback. Hide amounts, the hero number roll, the price flash, loading skeletons, Undo on delete toasts, reduced motion ═══ */

  test('_reducedMotion - asks prefers-reduced-motion afresh on every call, and falls back to animating when matchMedia is missing, throws or answers nothing', () => {
    const sb = freshSandbox();
    assert.strictEqual(sb._reducedMotion(), false);                           // the sandbox window has no matchMedia at all
    const asked = [];
    sb.window.matchMedia = q => { asked.push(q); return { matches:true }; };
    assert.strictEqual(sb._reducedMotion(), true);
    sb.window.matchMedia = q => { asked.push(q); return { matches:false }; };
    assert.strictEqual(sb._reducedMotion(), false);
    assert.deepStrictEqual(asked, ['(prefers-reduced-motion: reduce)', '(prefers-reduced-motion: reduce)']);   // not cached, a changed setting needs no reload
    sb.window.matchMedia = () => { throw new Error('blocked'); };
    assert.doesNotThrow(() => assert.strictEqual(sb._reducedMotion(), false));
    sb.window.matchMedia = () => null;
    assert.strictEqual(sb._reducedMotion(), false);
    sb.window.matchMedia = 'not a function';
    assert.strictEqual(sb._reducedMotion(), false);
    sb.window = undefined;                                                    // no window at all (a non-browser host)
    assert.strictEqual(sb._reducedMotion(), false);
  });

  test('hero roll maths - ease-out cubic is 0 at the start and 1 at the end, monotonic and fastest first, and a rolled figure starts at from, ends exactly on to and never overshoots', () => {
    const sb = freshSandbox();
    const ease = sb._easeOutCubic;
    assert.strictEqual(ease(0), 0); assert.strictEqual(ease(1), 1);
    let last = -1;
    for (let i = 0; i <= 100; i++){ const v = ease(i / 100); assert.ok(v >= last && v >= 0 && v <= 1, 'monotonic at ' + i); last = v; }
    assert.ok(ease(0.25) > 0.25 && ease(0.5) > 0.5);                          // ahead of linear
    assert.ok(ease(0.1) - ease(0) > ease(1) - ease(0.9));                     // fastest at the start, slowest at the end
    assert.deepStrictEqual([-5, 9, NaN, Infinity, -Infinity, 'x', null, undefined].map(ease), [0, 1, 0, 1, 0, 0, 0, 0]);
    assert.strictEqual(vm.runInContext('HERO_ROLL_MS', sb), 450);
    const D = 450;
    assert.strictEqual(sb._rollValue(100, 200, 0, D), 100);
    assert.strictEqual(sb._rollValue(100, 200, D, D), 200);
    assert.strictEqual(sb._rollValue(100, 200, D + 999, D), 200);
    assert.strictEqual(sb._rollValue(100, 200, -20, D), 100);                 // a first frame stamped just before the start
    [[100, 200], [200, 100], [-50, 50], [0, 1e6], [621435, 723075]].forEach(([from, to]) => {
      let prev = from;
      for (let t = 0; t <= D; t += 15){
        const v = sb._rollValue(from, to, t, D);
        assert.ok(to >= from ? (v >= prev && v <= to) : (v <= prev && v >= to), from + ' to ' + to + ' at ' + t);
        prev = v;
      }
      assert.strictEqual(sb._rollValue(from, to, D, D), to);
    });
    // anything that is not a number ends on the real figure, never on NaN
    assert.strictEqual(sb._rollValue(NaN, 200, 100, D), 200);
    assert.strictEqual(sb._rollValue(100, 200, NaN, D), 200);
    assert.strictEqual(sb._rollValue(100, 200, 100, 0), 200);
  });

  test('_heroRollPlan - rolls only a real change on a visible dashboard, never on the first paint, a scrub, a currency switch or under reduced motion, and lets a running roll to the same figure finish', () => {
    const sb = freshSandbox();
    const ok = { reduced:false, scrubbing:false, visible:true, running:null };
    const plan = (prev, next, o) => navPlain(sb._heroRollPlan(prev, next, Object.assign({}, ok, o)));
    const sgd = value => ({ value, ccy:'SGD' });
    assert.deepStrictEqual(plan(sgd(621435), sgd(723075)), { action:'roll', from:621435 });
    assert.deepStrictEqual(plan(sgd(723075), sgd(621435)), { action:'roll', from:723075 });      // down as well as up
    assert.deepStrictEqual(plan(null, sgd(723075)), { action:'jump' });                          // the first paint
    assert.deepStrictEqual(plan(sgd(5), sgd(5)), { action:'jump' });                             // nothing changed
    assert.deepStrictEqual(plan(sgd(5.2), sgd(5.4)), { action:'jump' });                         // the same whole figure on screen
    assert.deepStrictEqual(plan({ value:5, ccy:'SGD' }, { value:9, ccy:'USD' }), { action:'jump' });   // a currency switch is another unit
    assert.deepStrictEqual(plan(sgd(1), sgd(2), { reduced:true }), { action:'jump' });
    assert.deepStrictEqual(plan(sgd(1), sgd(2), { scrubbing:true }), { action:'jump' });
    assert.deepStrictEqual(plan(sgd(1), sgd(2), { visible:false }), { action:'jump' });
    assert.deepStrictEqual(plan(sgd(1), { value:NaN, ccy:'SGD' }), { action:'jump' });
    assert.deepStrictEqual(plan({ value:NaN, ccy:'SGD' }, sgd(2)), { action:'jump' });
    assert.deepStrictEqual(plan(sgd(1), null), { action:'jump' });
    assert.deepStrictEqual(plan(sgd(1), undefined, undefined), { action:'jump' });
    // a roll already heading for this very figure goes on in the new markup, one heading elsewhere is replaced
    assert.deepStrictEqual(plan(sgd(650000), sgd(723075), { running:sgd(723075) }), { action:'keep' });
    assert.deepStrictEqual(plan(sgd(650000), sgd(700000), { running:sgd(723075) }), { action:'roll', from:650000 });
    assert.deepStrictEqual(plan(sgd(650000), sgd(723075), { running:sgd(723075), reduced:true }), { action:'jump' });
    assert.deepStrictEqual(plan(sgd(650000), sgd(723075), { running:sgd(723075), scrubbing:true }), { action:'jump' });
    assert.deepStrictEqual(navPlain(sb._heroRollPlan(sgd(1), sgd(2))), { action:'jump' });      // no options at all: not visible, so no roll
  });

  test('_heroValueHtml - the final figure once for screen readers in a visually hidden span, the figure people see aria-hidden, and the text escaped', () => {
    const sb = realEscape(freshSandbox());
    assert.strictEqual(sb._heroValueHtml('S$723,075', '<span class="ccy">S$</span>650,000'), '<span class="sr-only">S$723,075</span><span class="hero-num" aria-hidden="true"><span class="ccy">S$</span>650,000</span>');
    assert.strictEqual(sb._heroValueHtml('<b>x</b>', '1'), '<span class="sr-only">&lt;b&gt;x&lt;/b&gt;</span><span class="hero-num" aria-hidden="true">1</span>');
    const markup = sb._heroValueHtml('S$1', 'S$0');
    assert.strictEqual((markup.match(/aria-hidden="true"/g) || []).length, 1);                  // only the moving figure is hidden, the final text is not
    assert.ok(markup.indexOf('sr-only') < markup.indexOf('hero-num'));
  });

  test('_heroRollStart - frames roll the visible figure and end on the exact final one, a timer ends the roll when frames never come, cancel stops it, and a missing span never throws', () => {
    const mk = () => {
      const sb = freshSandbox();
      const env = { span:{ innerHTML:'' }, frames:[], timers:[], now:1000, ccySets:0 };
      sb.document = { querySelector: sel => sel === '#hero-value .hero-num' ? env.span : null };
      sb.setRenderCcy = () => { env.ccySets++; };
      sb.fmt = n => 'S$' + Math.round(n).toLocaleString('en-SG');
      sb.requestAnimationFrame = cb => { env.frames.push(cb); return env.frames.length; };
      sb.cancelAnimationFrame = () => {};
      sb.performance = { now: () => env.now };
      sb.setTimeout = (fn, ms) => { env.timers.push({ fn, ms }); return env.timers.length; };
      sb.clearTimeout = () => {};
      env.frame = at => { const cb = env.frames.shift(); env.now = at; cb(at); };
      return { sb, env };
    };
    // a roll from 100 to 200: in-between figures climb, the end is exactly 200, and nothing is left running
    let { sb, env } = mk();
    sb._heroRollStart(100, 200, 'SGD');
    assert.strictEqual(vm.runInContext('_heroRoll', sb).to, 200);
    assert.strictEqual(env.frames.length, 1); assert.strictEqual(env.timers[0].ms, 450 + 120);
    const shown = [];
    [1000, 1100, 1225, 1340].forEach(at => { env.frame(at); shown.push(Number(env.span.innerHTML.replace(/<[^>]*>/g, '').replace(/[^\d]/g, ''))); });
    assert.ok(shown.every((v, i) => v >= 100 && v <= 200 && (i === 0 || v >= shown[i - 1])), JSON.stringify(shown));
    assert.strictEqual(shown[0], 100); assert.ok(shown[3] > shown[1]);
    assert.ok(vm.runInContext('_heroShown', sb).value > 100);
    env.frame(1450);
    assert.ok(env.span.innerHTML.includes('200') && !env.span.innerHTML.includes('199'));
    assert.deepStrictEqual(navPlain(vm.runInContext('_heroShown', sb)), { value:200, ccy:'SGD' });
    assert.strictEqual(vm.runInContext('_heroRoll', sb), null); assert.strictEqual(env.frames.length, 0);
    assert.ok(env.ccySets > 0);                                                // each frame sets the dashboard's currency (and hands the render currency back)
    // frames paused (a hidden tab): the timer ends it on the exact figure
    ({ sb, env } = mk());
    sb._heroRollStart(100, 200, 'SGD');
    env.timers[0].fn();
    assert.ok(env.span.innerHTML.includes('200')); assert.strictEqual(vm.runInContext('_heroRoll', sb), null);
    assert.deepStrictEqual(navPlain(vm.runInContext('_heroShown', sb)), { value:200, ccy:'SGD' });
    // a newer render or a scrub cancels it: the queued frame and the timer then change nothing
    ({ sb, env } = mk());
    sb._heroRollStart(100, 200, 'SGD'); sb._heroRollCancel();
    env.span.innerHTML = 'scrubbed';
    env.frame(1100); env.timers[0].fn();
    assert.strictEqual(env.span.innerHTML, 'scrubbed'); assert.strictEqual(vm.runInContext('_heroRoll', sb), null);
    // a second roll replaces the first
    ({ sb, env } = mk());
    sb._heroRollStart(100, 200, 'SGD'); const first = env.frames.shift();
    sb._heroRollStart(100, 300, 'SGD');
    first(1100);
    assert.strictEqual(env.span.innerHTML, '');                                // the first roll's frame knows it was replaced
    assert.strictEqual(vm.runInContext('_heroRoll', sb).to, 300);
    // reduced motion switched on mid-roll ends it at once
    ({ sb, env } = mk());
    sb._heroRollStart(100, 200, 'SGD');
    sb.window.matchMedia = () => ({ matches:true });
    env.frame(1050);
    assert.ok(env.span.innerHTML.includes('200')); assert.strictEqual(vm.runInContext('_heroRoll', sb), null);
    // the span is gone (the markup was replaced): the roll stops quietly on the final figure
    ({ sb, env } = mk());
    sb._heroRollStart(100, 200, 'SGD');
    sb.document.querySelector = () => null;
    assert.doesNotThrow(() => env.frame(1100));
    assert.strictEqual(vm.runInContext('_heroRoll', sb), null);
    assert.deepStrictEqual(navPlain(vm.runInContext('_heroShown', sb)), { value:200, ccy:'SGD' });
  });

  test('Hero roll wiring - renderDashboard plans the roll from the figure kept outside the DOM, a scrub cancels it and the end of a scrub restores the live figure at once', () => {
    const dash = extractFunction('renderDashboard');
    assert.ok(dash.includes('const heroNow = { value:displayNet, ccy:displayCcy() };'));
    assert.ok(dash.includes('_heroRollPlan(_heroShown, heroNow, {') && dash.includes("visible:_isPageActive('dashboard')") && dash.includes('reduced:_reducedMotion()'));
    assert.ok(dash.includes('scrubbing:!!(_heroView && _heroView.idx !== null)'));
    assert.ok(dash.includes("if (roll.action !== 'keep') _heroRollCancel();"));
    assert.ok(dash.includes("if (roll.action === 'roll') _heroRollStart(roll.from, displayNet, heroNow.ccy);") && dash.includes("else if (roll.action === 'jump') _heroShown = heroNow;"));
    assert.ok(dash.includes('id="hero-value">${valueShownHtml}</div>') && dash.includes('_heroValueHtml(valueText, _moneyHtml(valueText))'));
    // the live figure the end of a scrub restores is the final markup, with its number and currency kept for the next roll
    assert.ok(dash.includes('restValue:valueHtml') && dash.includes('restNum:displayNet, restCcy:heroNow.ccy'));
    // a scrub: cancel first, write the pointer's figure directly in the same markup, and the end of a scrub puts the live figure back instantly
    const set = extractFunction('_heroSetScrub'), end = extractFunction('_heroEndScrub');
    assert.ok(set.indexOf('_heroRollCancel();') > -1 && set.indexOf('_heroRollCancel();') < set.indexOf('_heroValueHtml('));
    assert.ok(end.includes('valueEl.innerHTML = v.restValue;') && end.includes('_heroShown = { value:v.restNum, ccy:v.restCcy };'));
    assert.strictEqual(set.includes('requestAnimationFrame'), false); assert.strictEqual(end.includes('requestAnimationFrame'), false);
    // the roll runner is the only place that animates, and it asks first
    assert.ok(extractFunction('_heroRollStart').includes('_reducedMotion()') && extractFunction('_pxFlashPaint').includes('_reducedMotion()') && extractFunction('_pxFlashNote').includes('_reducedMotion()'));
  });

  test('Price flash maths - _quotePrice reads price, then sgd, then usd, real positive numbers only', () => {
    const sb = freshSandbox();
    assert.strictEqual(sb._quotePrice({ price:254.3, sgd:1 }), 254.3);
    assert.strictEqual(sb._quotePrice({ sgd:152000, usd:112600 }), 152000);
    assert.strictEqual(sb._quotePrice({ usd:5 }), 5);
    assert.strictEqual(sb._quotePrice({ price:'12.5' }), 12.5);
    assert.strictEqual(sb._quotePrice({ price:0, sgd:3 }), 3);                  // a zero price is no price, the next field counts
    [null, undefined, 0, 'x', [], {}, { price:null }, { price:'' }, { price:'abc' }, { price:NaN }, { price:Infinity }, { price:-4 }, { price:0 }, { fund:{ beta:1 } }, { previousClose:3 }]
      .forEach(q => assert.strictEqual(sb._quotePrice(q), null, JSON.stringify(q)));
  });

  test('_priceSnapshot - cache key to price for the keys with a real price now, own keys only, taken before a refresh overwrites the cache', () => {
    const sb = freshSandbox({ _priceCache:{ AAPL:{ price:254.3 }, bitcoin:{ sgd:152000, usd:112600 }, 'D05.SI':{ price:0 }, NOPX:{ fund:{ beta:1 } }, NULLQ:null } });
    assert.deepStrictEqual(navPlain(sb._priceSnapshot(['AAPL', 'bitcoin', 'D05.SI', 'NOPX', 'NULLQ', 'MISSING', 'constructor', '__proto__', 'toString'])), { AAPL:254.3, bitcoin:152000 });
    assert.deepStrictEqual(navPlain(sb._priceSnapshot([])), {}); assert.deepStrictEqual(navPlain(sb._priceSnapshot(undefined)), {}); assert.deepStrictEqual(navPlain(sb._priceSnapshot('AAPL')), {});
    const taken = sb._priceSnapshot(['AAPL']);
    sb.DB._priceCache.AAPL = { price:300 };                                      // the refresh writes the new quote
    assert.strictEqual(taken.AAPL, 254.3);                                       // the snapshot kept the old price
    const none = freshSandbox(); none.DB._priceCache = undefined;
    assert.deepStrictEqual(navPlain(none._priceSnapshot(['AAPL'])), {});
  });

  test('_priceDiff - up, down, unchanged, a new symbol, a missing price and junk: only a price that really moved is flashed', () => {
    const sb = freshSandbox();
    const diff = (a, b) => navPlain(sb._priceDiff(a, b));
    assert.deepStrictEqual(diff({ AAPL:254.3, NVDA:190, 'D05.SI':52.4 }, { AAPL:255.1, NVDA:186.5, 'D05.SI':52.4 }), { AAPL:'up', NVDA:'down' });   // unchanged stays out
    assert.deepStrictEqual(diff({ bitcoin:152000 }, { bitcoin:152000.01 }), { bitcoin:'up' });
    assert.deepStrictEqual(diff({ AAPL:100 }, { AAPL:100, NEW:50 }), {});                                          // a new symbol has nothing to compare with: a first load never flashes
    assert.deepStrictEqual(diff({}, { AAPL:100 }), {});
    assert.deepStrictEqual(diff({ AAPL:100 }, {}), {});                                                            // missing after: nothing to show
    assert.deepStrictEqual(diff({ AAPL:100 }, { AAPL:null }), {}); assert.deepStrictEqual(diff({ AAPL:null }, { AAPL:100 }), {});
    assert.deepStrictEqual(diff({ AAPL:0 }, { AAPL:100 }), {}); assert.deepStrictEqual(diff({ AAPL:100 }, { AAPL:-1 }), {});
    assert.deepStrictEqual(diff({ AAPL:'100' }, { AAPL:'101' }), {});                                              // the snapshots hold numbers, anything else is skipped
    assert.deepStrictEqual(diff({ AAPL:NaN }, { AAPL:NaN }), {}); assert.deepStrictEqual(diff({ AAPL:Infinity }, { AAPL:1 }), {});
    assert.deepStrictEqual(diff(null, { AAPL:1 }), {}); assert.deepStrictEqual(diff({ AAPL:1 }, undefined), {}); assert.deepStrictEqual(diff(undefined, undefined), {});
    // keys that exist on every object are not prices
    assert.deepStrictEqual(diff({}, { constructor:5, toString:5 }), {});
    const before = { A:1 }, after = { A:2 };
    sb._priceDiff(before, after);
    assert.deepStrictEqual(navPlain(before), { A:1 }); assert.deepStrictEqual(navPlain(after), { A:2 });          // inputs untouched
  });

  test('_pxFlashNote and _pxFlashPaint - classes on the rows that carry a moved price\'s key, fading from where a repaint finds them, dropped after 1.2s, nothing under reduced motion', () => {
    const sb = freshSandbox();
    const mk = key => {
      const classes = new Set(); const props = {}; const listeners = [];
      return { classes, props, listeners, offsetWidth:0, style:{ setProperty:(k, v) => { props[k] = v; } }, getAttribute:a => a === 'data-px' ? key : null,
        classList:{ add:c => classes.add(c), remove:(...c) => c.forEach(x => classes.delete(x)), contains:c => classes.has(c) },
        addEventListener:(t, fn, o) => listeners.push([t, fn, o]) };
    };
    const els = ['AAPL', 'NVDA', 'D05.SI', 'bitcoin', 'AAPL'].map(mk);          // AAPL shows twice (the dashboard row and the Stocks row)
    const root = { selectors:[], querySelectorAll(sel){ this.selectors.push(sel); return els; } };
    assert.strictEqual(sb._pxFlashPaint(root, 5000), 0); assert.deepStrictEqual(root.selectors, []);                // nothing flashing: no DOM scan at all
    assert.strictEqual(sb._pxFlashNote({ AAPL:'up', NVDA:'down', junk:'sideways', other:undefined }, 10000), 2);
    assert.deepStrictEqual(Array.from(sb._pxFlashes.keys()).sort(), ['AAPL', 'NVDA']);
    assert.strictEqual(sb._pxFlashPaint(root, 10200), 3);                        // both AAPL rows and NVDA
    assert.deepStrictEqual(root.selectors, ['[data-px]']);
    assert.deepStrictEqual([els[0], els[4]].map(e => Array.from(e.classes)), [['flash-up'], ['flash-up']]);
    assert.deepStrictEqual(Array.from(els[1].classes), ['flash-down']);
    assert.strictEqual(els[2].classes.size, 0); assert.strictEqual(els[3].classes.size, 0);                         // unchanged and unrelated rows stay quiet
    assert.strictEqual(els[0].props['--px-delay'], '-200ms');                    // a repaint 200ms in carries on from there
    assert.strictEqual(els[0].listeners[0][0], 'animationend'); assert.deepStrictEqual(navPlain(els[0].listeners[0][2]), { once:true });
    els[0].listeners[0][1]();                                                    // the fade ends: the class goes
    assert.strictEqual(els[0].classes.size, 0);
    assert.strictEqual(sb._pxFlashPaint(root, 10300), 0);                        // every row is already painted for this flash: a repaint of the same markup never replays it
  });

  test('_pxFlashPaint - a second flash restarts a row, an expired flash is dropped, and reduced motion paints and notes nothing', () => {
    const sb = freshSandbox();
    const mk = key => {
      const classes = new Set(['flash-up']); const props = {}; let reflows = 0;
      return { classes, props, get offsetWidth(){ reflows++; return 0; }, get reflows(){ return reflows; }, style:{ setProperty:(k, v) => { props[k] = v; } },
        getAttribute:() => key, classList:{ add:c => classes.add(c), remove:(...c) => c.forEach(x => classes.delete(x)), contains:c => classes.has(c) }, addEventListener(){} };
    };
    const el = mk('AAPL');
    const root = { querySelectorAll:() => [el] };
    sb._pxFlashNote({ AAPL:'down' }, 20000);                                      // a new flash on a row still showing the last one
    assert.strictEqual(sb._pxFlashPaint(root, 20050), 1);
    assert.deepStrictEqual(Array.from(el.classes), ['flash-down']); assert.ok(el.reflows >= 1);   // removed, reflowed, added: the animation restarts
    // expired: 1.2s after the note the entry is gone and nothing is painted
    sb._pxFlashNote({ AAPL:'up' }, 30000);
    assert.strictEqual(sb._pxFlashPaint(root, 30000 + vm.runInContext('PX_FLASH_MS', sb)), 0);
    assert.strictEqual(sb._pxFlashes.size, 0);
    assert.strictEqual(vm.runInContext('PX_FLASH_MS', sb), 1200);
    // reduced motion: noted nothing, painted nothing
    sb.window.matchMedia = () => ({ matches:true });
    assert.strictEqual(sb._pxFlashNote({ AAPL:'up' }, 40000), 0); assert.strictEqual(sb._pxFlashes.size, 0);
    sb.window.matchMedia = () => ({ matches:false });
    sb._pxFlashNote({ AAPL:'up' }, 40000);
    sb.window.matchMedia = () => ({ matches:true });                              // the setting changes between the refresh and the repaint
    const fresh = mk('AAPL'); fresh.classes.clear();
    assert.strictEqual(sb._pxFlashPaint({ querySelectorAll:() => [fresh] }, 40010), 0);
    assert.strictEqual(fresh.classes.size, 0); assert.strictEqual(sb._pxFlashes.size, 0);
  });

  test('_pxAttr - the price-cache key as an escaped data-px attribute, nothing for no key', () => {
    const sb = realEscape(freshSandbox());
    assert.strictEqual(sb._pxAttr('AAPL'), ' data-px="AAPL"');
    assert.strictEqual(sb._pxAttr('D05.SI'), ' data-px="D05.SI"');
    assert.strictEqual(sb._pxAttr('"><b>x</b>'), ' data-px="&quot;&gt;&lt;b&gt;x&lt;/b&gt;"');
    ['', null, undefined, 0].forEach(k => assert.strictEqual(sb._pxAttr(k), ''));
  });

  test('Price flash wiring - both refreshes take the old prices before the fetch, note what moved after the write and before the repaints, and repaint the dashboard after the panel', () => {
    const stocks = appSrc.slice(appSrc.indexOf('async function refreshStockPrices'), appSrc.indexOf('async function refreshFundamentals'));
    const crypto = appSrc.slice(appSrc.indexOf('async function refreshCryptoPrices'), appSrc.indexOf('SOFT DELETE'));
    [[stocks, 'symbols', 'DB._priceCache[sym] = q;', 'renderStocks();'], [crypto, 'ids', 'DB._priceCache[id] = {', 'renderCrypto();']].forEach(([src, keys, write, render]) => {
      assert.ok(src.includes('const pxBefore = _priceSnapshot(' + keys + ');'));
      assert.ok(src.indexOf('const pxBefore') < src.indexOf('await fetch(') && src.indexOf('await fetch(') < src.indexOf(write));
      const note = '_pxFlashNote(_priceDiff(pxBefore, _priceSnapshot(' + keys + ')));';
      assert.ok(src.indexOf(write) < src.indexOf(note) && src.indexOf(note) < src.indexOf(render));
      assert.ok(src.includes(render + '\n    refreshHoldingPanel();   // an open holding panel takes the new price\n    _repaintDashAfterPrices();'));
      // the skeletons: raised when a first load starts, cleared in finally when no data came back
      assert.ok(src.includes('skeleton = _skeletonOn(true, ') && src.includes('if (skeleton) _repaintPriceSurfaces();'));
      assert.ok(src.indexOf('let skeleton = false, repainted = false;\n  try {') > -1 && src.indexOf('skeleton = _skeletonOn(') > src.indexOf('  try {'));   // inside the try: the finally always clears the in-flight flag
      assert.ok(src.includes('if (skeleton && !repainted){') && src.includes('try { _repaintPriceSurfaces(); } catch (err){'));
      assert.ok(src.indexOf('} finally {') < src.indexOf('if (skeleton && !repainted)'));
    });
    assert.ok(stocks.indexOf('_stockRefreshInFlight = false;\n    if (btn) btn.disabled = false;\n    if (skeleton && !repainted){') > -1);
    assert.ok(crypto.indexOf('_cryptoRefreshInFlight = false;\n    if (btn) btn.disabled = false;\n    if (skeleton && !repainted){') > -1);
    // the dashboard repaint: only when it is the page on screen, never the saved charts
    const repaint = extractFunction('_repaintDashAfterPrices');
    assert.ok(repaint.includes("_isPageActive('dashboard')") && repaint.includes('renderDashboard({ keepCharts:true })'));
    const all = extractFunction('_repaintPriceSurfaces');
    ['renderStocks();', 'renderCrypto();', '_repaintDashAfterPrices();', 'refreshHoldingPanel();'].forEach(call => assert.ok(all.includes(call), call));
    const dash = extractFunction('renderDashboard');
    assert.ok(dash.includes('if (opts && opts.keepCharts){') && dash.indexOf('if (opts && opts.keepCharts){') < dash.indexOf('pbSeedDefaults();'));
    assert.ok(dash.includes('_pxFlashPaint();') && dash.lastIndexOf('_pxFlashPaint();') > dash.indexOf('arrangeBtn.style.display'));
    // every surface that repaints paints the flash last: the two tables and lists, the dashboard rows, the panel
    ['renderStocks', 'renderCrypto', '_hpRender'].forEach(name => assert.ok(extractFunction(name).includes('_pxFlashPaint('), name));
    assert.ok(extractFunction('_hpRender').includes('_pxFlashPaint(host);'));
    // the rows carry the key they are found by
    assert.ok(extractFunction('_dashHoldingRows').includes('px:r.ysym') && extractFunction('_dashHoldingRows').includes('px:r.cid'));
    assert.ok(extractFunction('_dashToday').includes('_pxAttr(r.px)') && extractFunction('_dashHoldings').includes('_pxAttr(r.px)'));
    assert.ok(extractFunction('_hpPriceHtml').includes('_pxAttr(m.px)') && extractFunction('_stockListModel').includes('px:r.ysym') && extractFunction('_cryptoListModel').includes('px:r.cid'));
    assert.ok(extractFunction('renderStocks').includes('<tr${_pxAttr(r.ysym)}>') && extractFunction('renderCrypto').includes('<tr${_pxAttr(r.cid)}>'));
    assert.ok(extractFunction('_holdingRowHtml').includes('_pxAttr(m.px)'));
  });

  test('_skeletonOn - up only while a fetch is in flight and no holding on show has a price yet', () => {
    const sb = freshSandbox();
    const on = (inFlight, keys, cache) => sb._skeletonOn(inFlight, keys, cache);
    assert.strictEqual(on(true, ['AAPL', 'D05.SI'], {}), true);                                   // a first load
    assert.strictEqual(on(false, ['AAPL'], {}), false);                                           // nothing in flight: the rows' own dashes say it
    assert.strictEqual(on(true, [], {}), false); assert.strictEqual(on(true, undefined, {}), false);   // nothing to show
    assert.strictEqual(on(true, ['AAPL', 'D05.SI'], { AAPL:{ price:254.3 } }), false);              // one priced holding: the real rows take over
    assert.strictEqual(on(true, ['AAPL'], { AAPL:{ price:254.3, fetchedAt:'2020-01-01T00:00:00Z' } }), false);   // a stale last-known price still counts
    assert.strictEqual(on(true, ['bitcoin'], { bitcoin:{ sgd:152000 } }), false);
    assert.strictEqual(on(true, ['AAPL'], { AAPL:{ fund:{ beta:1 } } }), true);                      // a cache entry with no price is no price
    assert.strictEqual(on(true, ['AAPL'], { AAPL:null }), true);
    assert.strictEqual(on(true, ['AAPL'], { MSFT:{ price:5 } }), true);                              // a price for something else
    assert.strictEqual(on(true, ['constructor'], {}), true);                                         // not fooled by the keys every object has
    assert.strictEqual(on(true, ['AAPL'], undefined), true); assert.strictEqual(on(true, ['AAPL'], null), true);
    assert.strictEqual(on(1, ['AAPL'], {}), true); assert.strictEqual(on(0, ['AAPL'], {}), false);
  });

  test('_pricesLoading - reads the stock and coin in-flight flags, and only the ones the list is fed by', () => {
    const sb = freshSandbox({ _priceCache:{} });
    const loading = (stocks, crypto) => sb._pricesLoading(['AAPL'], stocks, crypto);
    assert.strictEqual(loading(true, true), false);                                                 // nothing in flight
    sb._stockRefreshInFlight = true;
    assert.strictEqual(loading(true, false), true); assert.strictEqual(loading(false, true), false); assert.strictEqual(loading(true, true), true);
    sb._stockRefreshInFlight = false; sb._cryptoRefreshInFlight = true;
    assert.strictEqual(loading(false, true), true); assert.strictEqual(loading(true, false), false); assert.strictEqual(loading(true, true), true);   // the dashboard counts both
    sb.DB._priceCache.AAPL = { price:1 };
    assert.strictEqual(loading(true, true), false);                                                 // a price arrives: the skeleton goes
  });

  test('_skelIf - a "nothing yet" cell becomes one shimmering bar while loading, a real figure never does, and nothing changes when not loading', () => {
    const sb = freshSandbox();
    const bar = vm.runInContext('SKEL_BAR', sb);
    assert.strictEqual(bar, '<span class="skel" aria-hidden="true"></span>');
    ['\u2014', '\u2013', '<span class="price-stale">\u2014</span>'].forEach(dash => { assert.strictEqual(sb._skelIf(true, dash), bar); assert.strictEqual(sb._skelIf(false, dash), dash); assert.strictEqual(sb._skelIf(undefined, dash), dash); });
    ['US$254.30', '▲ +1.80%', '', '-', '<span class="price-stale">\u2014 FX missing</span>', '0', 'AAPL'].forEach(real => assert.strictEqual(sb._skelIf(true, real), real, real));
    assert.strictEqual(vm.runInContext('SKEL_STATUS', sb), '<span class="sr-only" role="status">Loading prices</span>');
  });

  test('Loading skeletons - the holdings list and the dashboard Holdings card show bars for the figures that are not here yet, are aria-busy with a Loading prices status, and read exactly as before when not loading', () => {
    const sb = panelSandbox(panelFixture(), 'SGD');
    const rows = sb._dashHoldingRows(sb.buildStockChartRows());
    const nopx = rows.find(r => r.sym === 'NOPX');
    // the dashboard card: only the row with no price has dashes, so only it shimmers
    const idle = sb._dashHoldings(rows, 16550), idleExplicit = sb._dashHoldings(rows, 16550, false);
    assert.strictEqual(idle, idleExplicit); assert.ok(!idle.includes('class="skel"') && !idle.includes('aria-busy') && !idle.includes('Loading prices'));
    const busy = sb._dashHoldings(rows, 16550, true);
    assert.ok(busy.includes('<div class="dash-hold" aria-busy="true"><span class="sr-only" role="status">Loading prices</span>'));
    const nopxRow = /<button[^>]*data-px="NOPX"[\s\S]*?<\/button>/.exec(busy)[0];
    assert.strictEqual((nopxRow.match(/class="skel"/g) || []).length, 4);                         // value, share, day and return
    assert.ok(!nopxRow.includes('–'));                                                       // no dash left in it
    assert.ok(nopxRow.includes('<b>NOPX</b>') && nopxRow.includes('class="mono"'));              // who it is stays
    const aaplRow = /<button[^>]*data-px="AAPL"[\s\S]*?<\/button>/.exec(busy)[0];
    assert.ok(!aaplRow.includes('class="skel"'));                                                  // a priced row keeps its figures
    // all rows unpriced (a true first load): every row shimmers, the card is busy once
    const bare = rows.map(r => Object.assign({}, r, { mv:null, pl:null, plPct:null, dayPct:null, daySgd:null }));
    const first = sb._dashHoldings(bare, 16550, true);
    assert.strictEqual((first.match(/class="skel"/g) || []).length, 4 * bare.length);
    assert.strictEqual((first.match(/aria-busy="true"/g) || []).length, 1); assert.strictEqual((first.match(/role="status"/g) || []).length, 1);
    // the phone list rows and their container
    const m = { table:'stocks', id:'s_aapl', sym:'AAPL', cls:'stocks', sub:'US', value:DASH, share:DASH, shareOf:'of stocks', fx:false, dir:'', pct:DASH, amount:'', px:'AAPL' };
    const row = sb._holdingRowHtml(m, true), plain = sb._holdingRowHtml(m);
    assert.strictEqual((row.match(/class="skel"/g) || []).length, 3); assert.ok(!row.includes('– ') && !/>–</.test(row));
    assert.strictEqual(plain, sb._holdingRowHtml(m, false)); assert.ok(plain.includes('>–<') && !plain.includes('skel'));
    assert.ok(row.includes('data-px="AAPL"'));
    const list = sb._holdingsListHtml([m], { label:'Total', value:DASH, fx:false, dir:'', pct:DASH, amount:'' }, 'Holdings', true);
    assert.ok(list.startsWith('<div class="hl" role="group" aria-label="Holdings" aria-busy="true"><span class="sr-only" role="status">Loading prices</span>'));
    assert.strictEqual((list.match(/class="skel"/g) || []).length, 5);                              // three in the row, two in the total
    const calm = sb._holdingsListHtml([m], null, 'Holdings');
    assert.ok(calm.startsWith('<div class="hl" role="group" aria-label="Holdings"><div class="dash-hrow dash-hhead hl-head"') && !calm.includes('aria-busy'));
  });

  test('Loading skeletons - the Stocks and Crypto pages draw them only while their fetch is in flight with nothing cached, keep the symbol, market, shares and cost, and clear when a price arrives', () => {
    const noCache = () => Object.assign(stockFixture(), { _priceCache:{} });
    const sb = listSandbox(noCache(), 'USD'); const els = stocksBox(sb);
    sb.renderStocks();
    assert.ok(!els['stocks-body'].innerHTML.includes('class="skel"') && !els['stocks-body'].innerHTML.includes('aria-busy'));   // idle: dashes, as ever
    sb._stockRefreshInFlight = true; sb.renderStocks();
    let html = els['stocks-body'].innerHTML;
    assert.ok(html.includes('<div class="tbl-wrap hd-only"><span class="sr-only" role="status">Loading prices</span><table class="holdings" aria-busy="true">'));
    assert.ok(html.includes('<div class="hl" role="group" aria-label="Holdings" aria-busy="true"><span class="sr-only" role="status">Loading prices</span>'));
    const tr = /<tr data-px="AAPL">[\s\S]*?<\/tr>/.exec(html)[0];
    assert.ok(tr.includes('>AAPL</button>') && tr.includes('<span class="tag us">US</span>') && tr.includes('US$80.00'));      // who it is and what it cost stay real
    assert.ok((tr.match(/class="skel"/g) || []).length >= 4);                                                                   // price, value, P&L, P&L %, updated
    assert.ok(!/<td class="num">\u2014<\/td>|price-stale">\u2014/.test(tr));
    // a price for one holding ends the first load: the real rows come back with their own dashes
    sb.DB._priceCache.AAPL = { price:100, currency:'USD', fetchedAt:TODAY_ISO }; sb.renderStocks();
    html = els['stocks-body'].innerHTML;
    assert.ok(!html.includes('class="skel"') && !html.includes('aria-busy'));
    // the fetch ends (or fails) with nothing cached: not in flight any more, no skeleton
    const done = listSandbox(noCache(), 'USD'); const doneEls = stocksBox(done);
    done._stockRefreshInFlight = true; done.renderStocks(); assert.ok(doneEls['stocks-body'].innerHTML.includes('class="skel"'));
    done._stockRefreshInFlight = false; done.renderStocks(); assert.ok(!doneEls['stocks-body'].innerHTML.includes('class="skel"'));
    // a coin fetch does not put the stock lists into loading, and Crypto follows its own flag
    const mixed = listSandbox(Object.assign(noCache(), { crypto:[{ id:'c_btc', symbol:'BTC', coingeckoId:'bitcoin', amount:0.25, avgCost:60000, currency:'USD' }] }));
    const sEls = stocksBox(mixed);                                                        // the stocks elements, and the document that serves them
    const cEls = {}; ['crypto-body', 'crypto-summary', 'freshness-crypto'].forEach(id => { cEls[id] = { id, innerHTML:'', textContent:'', className:'' }; });
    const stocksDoc = mixed.document.getElementById.bind(mixed.document);
    mixed.document.getElementById = id => cEls[id] || stocksDoc(id);                       // ...which now serves the crypto elements too
    mixed._cryptoRefreshInFlight = true; mixed.renderStocks(); mixed.renderCrypto();
    assert.ok(!sEls['stocks-body'].innerHTML.includes('class="skel"'));
    assert.ok(cEls['crypto-body'].innerHTML.includes('<table class="holdings" aria-busy="true">') && cEls['crypto-body'].innerHTML.includes('role="status">Loading prices'));
    assert.ok(/<tr data-px="bitcoin">[\s\S]*?class="skel"[\s\S]*?<\/tr>/.test(cEls['crypto-body'].innerHTML));
    assert.ok(cEls['crypto-body'].innerHTML.includes('>BTC</button>') && cEls['crypto-body'].innerHTML.includes('S$75,000.00'));       // the symbol and the cost stay (US$60,000 at the sandbox's 1.25)
    mixed.DB._priceCache.bitcoin = { sgd:152000, usd:112600, change24h:1.8, fetchedAt:TODAY_ISO }; mixed.renderCrypto();
    assert.ok(!cEls['crypto-body'].innerHTML.includes('class="skel"') && !cEls['crypto-body'].innerHTML.includes('aria-busy'));
  });

  test('Hide amounts - 7px over 250ms on every amount, the percentage cells and figures are left out, the money-chip selector and the hover reveal stay, and reduced motion switches the transition off', () => {
    const start = indexSrc.indexOf('/* PRIVACY MODE (Hide amounts)'), end = indexSrc.indexOf('/* SYNC STATE.');
    assert.ok(start > -1 && end > start);
    const css = indexSrc.slice(start, end);
    assert.ok(css.includes('html.privacy .money-chip,'));
    assert.ok(css.includes('html.privacy td.num:not(.pct){filter:blur(7px);'));
    assert.ok(css.includes('html.privacy .h-summary-value:not(.pct),') && css.includes('html.privacy .dash-hero-value,') && css.includes('html.privacy .metric-value,'));
    assert.strictEqual(/blur\(0\.45em\)/.test(css), false);
    assert.strictEqual((css.match(/blur\(/g) || []).length, 1); assert.strictEqual((css.match(/blur\(7px\)/g) || []).length, 1);
    // no selector can reach a percentage cell: td.num is always :not(.pct), and a summary value that is a percentage opts out the same way
    assert.strictEqual(/html\.privacy td\.num(?!:not\(\.pct\))/.test(css), false);
    assert.strictEqual(/html\.privacy \.h-summary-value(?!:not\(\.pct\))/.test(css), false);
    // the transition is on the figures, so the blur eases in and out, 250ms
    assert.ok(css.includes('.dash-hero-value,.h-summary-value,.metric-value,.money-chip{transition:filter .25s ease}'));
    assert.ok(css.includes('td.num{transition:background 0.12s ease,filter .25s ease}'));                 // the row hover fade the cells already had is kept
    // pointer devices reveal one figure on hover, the same list
    const hover = css.slice(css.indexOf('@media (hover:hover){'));
    ['html.privacy .dash-hero-value:hover,', 'html.privacy .h-summary-value:not(.pct):hover,', 'html.privacy .metric-value:hover,', 'html.privacy .money-chip:hover,', 'html.privacy td.num:not(.pct):hover{filter:none;'].forEach(s => assert.ok(hover.includes(s), s));
    // reduced motion: on and off at once
    assert.ok(/@media \(prefers-reduced-motion:reduce\)\{\s*\.dash-hero-value,\.h-summary-value,\.metric-value,\.money-chip,td\.num\{transition:none\}\s*\}/.test(css));
  });

  test('Hide amounts - every Stocks column that prints a percentage carries .pct and no amount column does, whatever the column set', () => {
    const f = panelFixture();
    f.stocks[0].divPerShare = 2;
    f._priceCache.AAPL = Object.assign({}, f._priceCache.AAPL, { week52Low:60, week52High:120, dayLow:98, dayHigh:101, volume:1200000, prevClose:98,
      fund:{ trailingPE:34.2, forwardPE:30.1, priceToBook:11.2, payoutRatio:0.25, marketCap:3.8e12, beta:0.9, sma200:90, sma50:95, currency:'USD' } });
    const sb = panelSandbox(f, 'SGD');
    sb.rangePosition = (p, lo, hi) => (p - lo) / (hi - lo); sb.vsBaseline = (p, ma) => (p - ma) / ma; sb.fmtCompactSgdOrNative = () => 'US$3.8T'; sb.sectorClass = () => 'sensitive';
    const row = sb.buildStockChartRows().find(r => r.s.id === 's_aapl');
    const seen = { pct:[], amount:[] };
    vm.runInContext('STOCK_COLUMNS', sb).forEach(c => {
      const classes = c.cls.split(' ');
      if (classes.indexOf('num') === -1) return;
      const text = sb._plainText(c.render(row, { dc:'SGD', totMv:1000 })).trim();
      if (!text || text === '\u2014') return;                                               // nothing in this cell for this holding (no sells for Realised): nothing to judge
      const isPct = text.endsWith('%');
      assert.strictEqual(classes.indexOf('pct') !== -1, isPct, c.key + ' prints "' + text + '"');
      seen[isPct ? 'pct' : 'amount'].push(c.key);
    });
    ['dayChangePct', 'pos52w', 'vs200d', 'vs50d', 'plPct', 'weight', 'divYoc', 'divYield', 'payout'].forEach(k => assert.ok(seen.pct.indexOf(k) !== -1, k + ' is a percentage column'));
    ['avgCost', 'price', 'mv', 'pl', 'cost', 'divIncome', 'shares', 'volume', 'mktCap'].forEach(k => assert.ok(seen.amount.indexOf(k) !== -1, k + ' stays blurred'));
    // the totals row, the crypto table, the cash APY, the savings rate and the projections inputs say the same in markup
    assert.ok(extractFunction('renderStocks').includes('case \'plPct\':    return `<td class="num pct">'));
    const cs = listSandbox({ crypto:[{ id:'c_btc', symbol:'BTC', coingeckoId:'bitcoin', amount:0.25, avgCost:60000, currency:'USD' }], _priceCache:{ bitcoin:{ sgd:152000, change24h:1.8, fetchedAt:TODAY_ISO } } });
    const cEls = renderBox(cs, ['crypto-body', 'crypto-summary', 'freshness-crypto']); cs.renderCrypto();
    const cells = Array.from(cEls['crypto-body'].innerHTML.matchAll(/<td class="([^"]*\bnum\b[^"]*)">([\s\S]*?)<\/td>/g)).map(m => [m[1].split(' '), cs._plainText(m[2]).trim()]);
    assert.ok(cells.length >= 8);
    cells.forEach(([cls, text]) => { if (text === '\u2014') return; assert.strictEqual(cls.indexOf('pct') !== -1, text.endsWith('%'), cls.join(' ') + ' "' + text + '"'); });
    assert.ok(appSrc.includes('<td class="num pct ${cls}">${rate != null ? fmtPct(rate)') && appSrc.includes("<td class=\"num pct\">${r.apy ? r.apy.toFixed(2) + '%' : '—'}</td>"));
    assert.ok(appSrc.includes('<td class="num pct">${fmtPctPlain(returnPct,1)}</td>') && appSrc.includes('<td class="num pct">${fmtPctPlain(inflationPct,1)}</td>'));
    assert.ok(appSrc.includes('<td class="num pct">${dayCell}</td>') && appSrc.includes('<td class="num pct">${posCell}</td>'));                 // the Watchlist table
    assert.ok(appSrc.includes("accent: savingsRate != null && savingsRate >= 0 ? 'pos' : 'neg', sub: 'of take-home', pct:true }") && appSrc.includes("<div class=\"h-summary-value${it.pct ? ' pct' : ''}\">"));
  });

  test('Hide amounts - the amounts the audit found outside a .money-chip now sit in one, the split bar tooltip no longer carries an amount, and money axes on canvas charts are masked', () => {
    // Stocks dividend line, CPF accrual line, Income & spending subs and meta lines, the Settings tax estimate and bucket preview
    ["sub: '<span class=\"money-chip\">' + fmtSgdOrNative(roundMoney(totDivAnnual/12), 'SGD') + ' / mo</span>'",
      "'<span class=\"money-chip\">+' + kjrEscape(fmt(accrued, {dp:0})) + '</span>'", "sub: 'gross <span class=\"money-chip\">' + fmt(totGross,{dp:0}) + '</span>'",
      "incomeMeta.innerHTML = kjrEscape(", "expenseMeta.innerHTML = kjrEscape(", '<div class="bucket-amt money-chip">', 'take-home of <span class="money-chip">${fmt(takeHome,{dp:0})}</span>'
    ].forEach(s => assert.ok(appSrc.includes(s), s));
    ['annualGross', 'annualEmpCpf', 'reliefs', 'chargeableIncome', 'annualTax', 'monthlyProvision'].forEach(k => assert.ok(new RegExp('<div class="money-chip" style="[^"]*">\\(?\\$\\{fmt2\\(est\\.' + k + '\\)\\}').test(appSrc), k));
    // the dashboard's split bar tooltip: name and share, never an amount (a native tooltip shows while the mode is on)
    const where = extractFunction('_dashWhereItSits');
    assert.ok(where.includes("title=\"' + kjrEscape(r.key) + ' · ' + r.share.toFixed(0) + '%\"") && !/title="[^"]*fmt\(/.test(where));
    // Chart.js draws ticks to canvas, so a money axis reads the mode through _privacyMaskAxis and applyPrivacy redraws the live charts
    assert.strictEqual((appSrc.match(/_privacyMaskAxis\(/g) || []).length, 7);                       // the definition and the six money axes (Chart Builder y and y2, price history, net worth series, insurance premiums, projections)
    assert.strictEqual(/callback:\s*v => kjrFmtAxis\(/.test(appSrc) || /callback:v => kjrFmtAxis\(/.test(appSrc), false);
    const sb = freshSandbox();
    sb.privacyOn = () => true;
    vm.runInContext(extractFunction('_privacyMaskAxis'), sb);
    assert.strictEqual(sb._privacyMaskAxis('S$650k'), '••••'); assert.strictEqual(sb._privacyMaskAxis('S$650k', 'money'), '••••');
    assert.strictEqual(sb._privacyMaskAxis('12', 'count'), '12'); assert.strictEqual(sb._privacyMaskAxis('40%', 'pct'), '40%');          // counts and percentages stay readable
    sb.privacyOn = () => false;
    assert.strictEqual(sb._privacyMaskAxis('S$650k', 'money'), 'S$650k');
    assert.ok(appSrc.includes("Object.keys(_pbCharts).forEach(id => { const c = _pbCharts[id]; if (c && typeof c.update === 'function') c.update('none'); });"));
  });

  test('_chipAmounts - every currency amount in an escaped sentence goes into a .money-chip, the words around it and plain numbers stay as they are', () => {
    const sb = freshSandbox();
    const chip = a => '<span class="money-chip">' + a + '</span>';
    assert.strictEqual(sb._chipAmounts('DBS is negative (-S$1,234.50), so a deposit is missing.'), 'DBS is negative (' + chip('-S$1,234.50') + '), so a deposit is missing.');
    assert.strictEqual(sb._chipAmounts('deposit +S$3,200 and US$56.70'), 'deposit ' + chip('+S$3,200') + ' and ' + chip('US$56.70'));
    assert.strictEqual(sb._chipAmounts('S$650k to S$1.25M'), chip('S$650k') + ' to ' + chip('S$1.25M'));
    assert.strictEqual(sb._chipAmounts('JP\u00a5500, A$5 and CHF 40'), chip('JP\u00a5500') + ', ' + chip('A$5') + ' and ' + chip('CHF 40'));
    assert.strictEqual(sb._chipAmounts('-\u2212S$5'.slice(1)), chip('\u2212S$5'));                    // the typographic minus is part of the amount
    ['2 trades reference a deleted stock', '50% of take-home', 'Jan 2026', '12 trades and 3.5 shares', ''].forEach(t => assert.strictEqual(sb._chipAmounts(t), t, t));
    assert.strictEqual(sb._chipAmounts(null), ''); assert.strictEqual(sb._chipAmounts(undefined), ''); assert.strictEqual(sb._chipAmounts(12), '12');
    // the integrity bar and the hero estimate note use it, so the amounts in those sentences blur
    assert.ok(extractFunction('renderDashboard').includes('${_chipAmounts(kjrEscape(i.msg))}'));
    assert.ok(extractFunction('renderDashboard').includes('without a live price (<span class="money-chip">${fmt(estimateAmount,{dp:0})}</span>)'));
  });

  test('Recently deleted - the label of a trade, movement, CPF entry, income or expense carries an amount, so it blurs, and a stock, coin or account name does not', () => {
    const sb = freshSandbox();
    const tables = vm.runInContext('TRASH_AMOUNT_TABLES', sb);
    assert.deepStrictEqual(Array.from(tables).sort(), ['cashTxns', 'cpfHistory', 'expenses', 'income', 'stockTxns']);
    const src = extractFunction('renderTrash');
    assert.ok(src.includes('<span class="trash-label${TRASH_AMOUNT_TABLES.indexOf(e.table) !== -1 ? \' money-chip\' : \'\'}">${kjrEscape(trashLabel(e.table, e.data))}</span>'));
    // every table that is in the list builds a label with a number in it, and none of the others does
    sb.DB.stocks = [{ id:'s1', symbol:'AAPL' }];
    const label = (table, data) => vm.runInContext('trashLabel', sb)(table, data);
    sb.fmtDateSG = d => d;
    const digits = x => /\d/.test(x);
    assert.ok(digits(label('stockTxns', { stockId:'s1', side:'buy', shares:10, date:'2026-03-01' })) && digits(label('cashTxns', { type:'deposit', amount:3200 })) && digits(label('cpfHistory', { type:'contribution', account:'OA', amount:2300 }))
      && digits(label('income', { gross:8000 })) && digits(label('expenses', { category:'food', amount:45 })));
    ['stocks', 'watchlist', 'crypto', 'realestate', 'cash', 'insurance', 'insuranceRiders'].forEach(t => assert.strictEqual(tables.indexOf(t), -1, t));
  });

  test('_hpTradeHtml - the fee is the one amount in the sub line, so it alone sits in a .money-chip, the date and the words stay readable', () => {
    const sb = realEscape(freshSandbox());
    sb._hpAmountHtml = text => text;
    const row = extra => sb._hpTradeHtml(Object.assign({ sideText:'Bought', qtyText:'5', priceText:'US$100.00', valueText:'US$502.00', dateText:'10/03/2026', feesText:'' }, extra));
    assert.ok(row({ feesText:'US$2.00' }).includes('<div class="hp-trade-s">10/03/2026 \u00b7 fees <span class="money-chip">US$2.00</span></div>'));
    assert.ok(row({}).includes('<div class="hp-trade-s">10/03/2026</div>'));                                      // no fee: the same line as before
    assert.ok(row({ dateText:'', feesText:'US$2.00' }).includes('<div class="hp-trade-s">fees <span class="money-chip">US$2.00</span></div>'));
    assert.ok(row({ dateText:'', feesText:'' }).includes('<div class="hp-trade-s"></div>'));
    assert.ok(row({ feesText:'<b>x</b>', dateText:'<i>d</i>' }).includes('&lt;i&gt;d&lt;/i&gt; \u00b7 fees <span class="money-chip">&lt;b&gt;x&lt;/b&gt;</span>'));   // both parts escaped
  });

  test('Undo toast - _deletedText names the record by its symbol or name, falls back to the kind of record, and is capped', () => {
    const sb = freshSandbox();
    assert.strictEqual(sb._deletedText('stocks', { symbol:'AAPL' }), 'Deleted AAPL');
    assert.strictEqual(sb._deletedText('watchlist', { symbol:' MSFT ' }), 'Deleted MSFT');
    assert.strictEqual(sb._deletedText('crypto', { symbol:'BTC' }), 'Deleted BTC');
    assert.strictEqual(sb._deletedText('realestate', { name:'HDB Punggol' }), 'Deleted HDB Punggol');
    assert.strictEqual(sb._deletedText('cash', { name:'DBS Multiplier' }), 'Deleted DBS Multiplier');
    assert.strictEqual(sb._deletedText('insurance', { insurer:'Seed Life', plan:'Term 65' }), 'Deleted Seed Life Term 65');
    assert.strictEqual(sb._deletedText('insurance', { insurer:'Seed Life' }), 'Deleted Seed Life');
    assert.strictEqual(sb._deletedText('stockTxns', { id:'t1' }), 'Deleted trade'); assert.strictEqual(sb._deletedText('cashTxns', {}), 'Deleted cash movement');
    assert.strictEqual(sb._deletedText('cpfHistory', undefined), 'Deleted CPF entry'); assert.strictEqual(sb._deletedText('insuranceRiders', null), 'Deleted rider');
    assert.strictEqual(sb._deletedText('stocks', { symbol:'' }), 'Deleted stock'); assert.strictEqual(sb._deletedText('stocks', { symbol:null }), 'Deleted stock');
    assert.strictEqual(sb._deletedText('nonsense', {}), 'Deleted entry'); assert.strictEqual(sb._deletedText('__proto__', {}), 'Deleted entry'); assert.strictEqual(sb._deletedText('constructor', {}), 'Deleted entry');
    const long = sb._deletedText('realestate', { name:'N'.repeat(200) });
    assert.strictEqual(long, 'Deleted ' + 'N'.repeat(39) + '…');
    assert.strictEqual(sb._deletedText('stocks', { symbol:'<b>x</b>' }), 'Deleted <b>x</b>');                      // plain text: the toast sets textContent
  });

  /* The real undo stack and the three functions around it in a sandbox of their own (the shared sandbox's pushUndo stays a no-op), ids that stay distinct, and every
     toast and dialog recorded. saveData bumps the save revision like the real one, so "something else saved in between" can be staged. */
  function undoSandbox(db){
    const sb = freshSandbox(Object.assign({ trash:[], stockTxns:[], cashTxns:[], insuranceRiders:[] }, db));
    vm.runInContext('var _undoStack = [], _redoStack = []; var UNDO_MAX = 20;\n' + [extractFunction('_undoSnapshot'), extractFunction('pushUndo'), extractFunction('undoAction')].join('\n'), sb);
    installStockRestoreSchema(sb);
    let n = 0; sb.uid = t => t + '_u' + (++n);
    sb.saveData = () => { vm.runInContext('_localSaveRevision++', sb); return true; };
    const log = { toasts:[], confirms:[], answer:true, renders:0 };
    sb.showToast = (m, k, a) => log.toasts.push({ m, k, a });
    sb.confirm = m => { log.confirms.push(m); return log.answer; };
    sb.renderAll = () => { log.renders++; };
    sb.closeEntityModal = () => { sb._modalState = null; };
    return { sb, log, stack: () => vm.runInContext('_undoStack.length', sb) };
  }
  const stockRow = (id, symbol) => ({ id, symbol, market:'US', sector:'', shares:3, avgCost:10, currency:'USD', notes:'n', createdAt:'2026-09-01T00:00:00.000Z', updatedAt:'2026-09-02T00:00:00.000Z' });

  await testAsync('entityModalDelete - a delete nothing points at goes straight to the trash with no dialog, then Undo puts the database back exactly, record, place and trash list', async () => {
    const rows = [stockRow('s1', 'AAA'), stockRow('s2', 'BBB'), stockRow('s3', 'CCC')];
    const { sb, log, stack } = undoSandbox({ stocks:JSON.parse(JSON.stringify(rows)), trash:[{ id:'tr_old', table:'stocks', ts:'2026-01-01T00:00:00.000Z', data:stockRow('s0', 'OLD') }] });
    const before = JSON.stringify(sb.localPersistPayload());
    sb._modalState = { table:'stocks', item:JSON.parse(JSON.stringify(rows[1])), isNew:false };
    assert.strictEqual(await sb.entityModalDelete(), true);
    assert.strictEqual(log.confirms.length, 0);                                                      // no dialog
    assert.deepStrictEqual(sb.DB.stocks.map(s => s.id), ['s1', 's3']); assert.strictEqual(sb.DB.trash.length, 2);
    assert.strictEqual(sb._modalState, null); assert.strictEqual(stack(), 1);
    const t = log.toasts.at(-1);
    assert.deepStrictEqual([t.m, t.k, t.a.label, typeof t.a.fn], ['Deleted BBB', 'success', 'Undo', 'function']);
    assert.strictEqual(await t.a.fn(), true);
    assert.strictEqual(JSON.stringify(sb.localPersistPayload()), before);                           // the whole database, byte for byte
    assert.deepStrictEqual(navPlain(sb.DB.stocks), rows);                                            // the record and its place
    assert.deepStrictEqual(navPlain(sb.DB.trash.map(e => e.id)), ['tr_old']);                         // the trash as it was
    assert.strictEqual(log.toasts.at(-1).m, 'Undone');
    assert.strictEqual(vm.runInContext('_redoStack.length', sb), 1);                                  // Redo (Ctrl+Y) can put the delete back
  });

  await testAsync('entityModalDelete - the cascade cases keep their confirm, a refusal changes nothing, and Undo still restores exactly after a yes', async () => {
    const stock = stockRow('s2', 'BBB');
    const cash = { id:'c1', name:'DBS', account:'Savings', amount:100, asOf:'2026-01-01', currency:'SGD' };
    const mk = () => undoSandbox({ stocks:[stockRow('s1', 'AAA'), stock], cash:[cash], stockTxns:[{ id:'t1', stockId:'s2', date:'2026-03-01', side:'buy', shares:1, price:1, fees:0 }, { id:'t2', stockId:'s1', cashAccountId:'c1', date:'2026-03-02', side:'buy', shares:1, price:1, fees:0 }],
      cashTxns:[{ id:'m1', type:'deposit', cashAccountId:'c1', date:'2026-03-03', amount:5 }] });
    // a stock with trades
    let { sb, log, stack } = mk();
    const before = JSON.stringify(sb.localPersistPayload());
    log.answer = false;
    sb._modalState = { table:'stocks', item:JSON.parse(JSON.stringify(stock)), isNew:false };
    assert.strictEqual(await sb.entityModalDelete(), false);
    assert.strictEqual(log.confirms.length, 1);
    assert.ok(log.confirms[0].startsWith('This stock has 1 trade in the ledger that will be left orphaned.\n\nMove this entry to trash?'));
    assert.strictEqual(JSON.stringify(sb.localPersistPayload()), before); assert.strictEqual(stack(), 0); assert.strictEqual(log.toasts.length, 0);   // nothing moved, no undo step burned, no toast
    log.answer = true;
    assert.strictEqual(await sb.entityModalDelete(), true);
    assert.strictEqual(sb.DB.stocks.length, 1); assert.strictEqual(log.toasts.at(-1).m, 'Deleted BBB'); assert.strictEqual(log.toasts.at(-1).a.label, 'Undo');
    await log.toasts.at(-1).a.fn();
    assert.strictEqual(JSON.stringify(sb.localPersistPayload()), before);
    // a cash account that movements and linked trades point at
    ({ sb, log, stack } = mk());
    log.answer = false;
    sb._modalState = { table:'cash', item:JSON.parse(JSON.stringify(cash)), isNew:false };
    assert.strictEqual(await sb.entityModalDelete(), false);
    assert.ok(log.confirms[0].startsWith('This account is referenced by 1 cash movement and 1 linked trade. Deleting it will leave those entries pointing at a missing account and unbalance the books.'));
    assert.strictEqual(sb.DB.cash.length, 1);
    // the source says so too: the dialog sits under `if (refWarning)` and the delete order is unchanged
    const src = extractFunction('entityModalDelete');
    assert.ok(src.includes('if (refWarning){') && src.indexOf('if (refWarning){') < src.indexOf('confirm(') && src.indexOf('confirm(') < src.indexOf('pushUndo()'));
    assert.strictEqual((src.match(/confirm\(/g) || []).length, 1);
    assert.ok(src.indexOf('pushUndo()') < src.indexOf('sendToTrash(') && src.indexOf('sendToTrash(') < src.indexOf('showToast(_deletedText('));
  });

  await testAsync('entityModalDelete - a policy with riders deletes without a dialog (its riders are never removed) and a record the save did not keep gets no Undo', async () => {
    const policy = { id:'p1', insurer:'Seed Life', plan:'Term 65', type:'Term Life', status:'Active' };
    const { sb, log } = undoSandbox({ insurance:[policy], insuranceRiders:[{ id:'r1', policyId:'p1', name:'CI rider', benefit:'Critical Illness', cover:1 }] });
    sb._modalState = { table:'insurance', item:JSON.parse(JSON.stringify(policy)), isNew:false };
    const before = JSON.stringify(sb.localPersistPayload());
    assert.strictEqual(await sb.entityModalDelete(), true);
    assert.strictEqual(log.confirms.length, 0); assert.strictEqual(log.toasts.at(-1).m, 'Deleted Seed Life Term 65');
    assert.strictEqual(sb.DB.insuranceRiders.length, 1);
    await log.toasts.at(-1).a.fn();
    assert.strictEqual(JSON.stringify(sb.localPersistPayload()), before);
    // the save fails: the records are still gone from memory, but nothing is announced and there is nothing to undo
    const bad = undoSandbox({ stocks:[stockRow('s1', 'AAA')] });
    bad.sb.saveData = () => false;
    bad.sb._modalState = { table:'stocks', item:stockRow('s1', 'AAA'), isNew:false };
    assert.strictEqual(await bad.sb.entityModalDelete(), false);
    assert.strictEqual(bad.log.toasts.length, 0);
  });

  await testAsync('undoDeleteToast - when something else was saved since the delete only that record comes back, from the trash, and with nothing left to restore it says so', async () => {
    const rows = [stockRow('s1', 'AAA'), stockRow('s2', 'BBB')];
    const { sb, log } = undoSandbox({ stocks:JSON.parse(JSON.stringify(rows)) });
    sb._modalState = { table:'stocks', item:JSON.parse(JSON.stringify(rows[1])), isNew:false };
    await sb.entityModalDelete();
    const toast = log.toasts.at(-1);
    // an ordinary edit lands before Undo is pressed
    sb.pushUndo(); sb.DB.stocks[0].shares = 99; sb.saveData();
    assert.strictEqual(await toast.a.fn(), true);
    assert.deepStrictEqual(sb.DB.stocks.map(s => [s.id, s.shares]), [['s1', 99], ['s2', 3]]);       // the later edit is kept, the record is back
    assert.strictEqual(sb.DB.trash.length, 0);
    const back = sb.DB.stocks.find(s => s.id === 's2');
    assert.deepStrictEqual([back.symbol, back.market, back.avgCost, back.notes, back.createdAt], ['BBB', 'US', 10, 'n', '2026-09-01T00:00:00.000Z']);
    assert.strictEqual(log.toasts.at(-1).m, 'Restored');
    // the same, and the trash entry is already gone (purged): a plain message, no state change
    const two = undoSandbox({ stocks:JSON.parse(JSON.stringify(rows)) });
    two.sb._modalState = { table:'stocks', item:JSON.parse(JSON.stringify(rows[1])), isNew:false };
    await two.sb.entityModalDelete();
    const t2 = two.log.toasts.at(-1);
    two.sb.pushUndo(); two.sb.saveData(); two.sb.DB.trash = [];
    const snap = JSON.stringify(two.sb.localPersistPayload());
    assert.strictEqual(await t2.a.fn(), false);
    assert.strictEqual(two.log.toasts.at(-1).k, 'error'); assert.ok(/can no longer be undone from here/.test(two.log.toasts.at(-1).m));
    assert.strictEqual(JSON.stringify(two.sb.localPersistPayload()), snap);
    // no step at all (pushUndo was mocked out, a save revision from elsewhere): never throws
    const bare = freshSandbox({ trash:[] }); bare.showToast = (m, k) => { bare.last = [m, k]; };
    vm.runInContext('var _undoStack = [], _redoStack = [];', bare);
    assert.strictEqual(await bare.undoDeleteToast(undefined), false); assert.strictEqual(await bare.undoDeleteToast({}), false); assert.strictEqual(bare.last[1], 'error');
    // a failure inside the undo is reported, never an unhandled rejection from a toast click
    const boom = undoSandbox({ stocks:JSON.parse(JSON.stringify(rows)) });
    boom.sb.console = { error(){} };
    boom.sb._modalState = { table:'stocks', item:JSON.parse(JSON.stringify(rows[1])), isNew:false };
    await boom.sb.entityModalDelete();
    const t4 = boom.log.toasts.at(-1);
    boom.sb.undoAction = async () => { throw new Error('disk full'); };
    assert.strictEqual(await t4.a.fn(), false);
    assert.strictEqual(boom.log.toasts.at(-1).k, 'error'); assert.strictEqual(boom.log.toasts.at(-1).m, 'Undo failed: disk full. The record is still in Settings, Recently deleted.');
    // a snapshot that is still the newest step but whose save revision moved is not trusted either
    const moved = undoSandbox({ stocks:JSON.parse(JSON.stringify(rows)) });
    moved.sb._modalState = { table:'stocks', item:JSON.parse(JSON.stringify(rows[1])), isNew:false };
    await moved.sb.entityModalDelete();
    const t3 = moved.log.toasts.at(-1);
    vm.runInContext('_localSaveRevision++', moved.sb);                                              // a background write (FX, salary engine, a pull) saved in between
    assert.strictEqual(await t3.a.fn(), true);
    assert.strictEqual(moved.log.toasts.at(-1).m, 'Restored');                                       // from the trash, not a whole-database rollback
  });

  /* ═══ Orphaned trades in Recently deleted: a trade comes back with its stock or cash account, a trade whose parent is gone says so, the trim keeps every parent ═══ */

  /* A sandbox with the real ENTITY_SCHEMAS (so the trade form's Stock and Funded from rules apply), the real undo stack, counted saves and undo steps, every toast
     and dialog recorded, a fake Recently deleted host so renderTrash can be read, the real kjrEscape, and ids that stay distinct. */
  function orphanSandbox(db){
    const sb = realEscape(freshSandbox(Object.assign({ stocks:[], cash:[], stockTxns:[], cashTxns:[], trash:[], insuranceRiders:[] }, db)));
    vm.runInContext('var _undoStack = [], _redoStack = []; var UNDO_MAX = 20;\n' + [extractFunction('_undoSnapshot'), extractFunction('pushUndo'), extractFunction('undoAction')].join('\n'), sb);
    sb.SG_INSURERS = [];
    const start = appSrc.indexOf('const ENTITY_SCHEMAS = '), end = appSrc.indexOf('/* Normalise one externally', start);
    vm.runInContext(appSrc.slice(start, end).replace('const ENTITY_SCHEMAS =', 'ENTITY_SCHEMAS ='), sb);
    let n = 0; sb.uid = t => t + '_u' + (++n);
    const log = { toasts:[], confirms:[], answer:true, saves:0, renders:0 };
    sb.saveData = () => { log.saves++; vm.runInContext('_localSaveRevision++', sb); return true; };
    sb.showToast = (m, k, a) => log.toasts.push({ m, k, a });
    sb.confirm = m => { log.confirms.push(m); return log.answer; };
    sb.renderAll = () => { log.renders++; };
    sb.closeEntityModal = () => { sb._modalState = null; };
    const host = { innerHTML:'' }, meta = { textContent:'' }, emptyBtn = { style:{} };
    sb.document = { getElementById: id => id === 'trash-list' ? host : id === 'trash-meta' ? meta : id === 'trash-empty-btn' ? emptyBtn : null };
    return { sb, log, host, stack: () => vm.runInContext('_undoStack.length', sb), payload: () => JSON.stringify(sb.localPersistPayload()) };
  }
  const clone = v => JSON.parse(JSON.stringify(v));
  const AAPL = { id:'s_aapl', symbol:'AAPL', market:'US', sector:'Information Technology', shares:30, avgCost:150, currency:'USD', divPerShare:1, notes:'', createdAt:'2026-01-01T00:00:00.000Z', updatedAt:'2026-01-02T00:00:00.000Z' };
  const IBKR = { id:'c_ibkr', name:'IBKR USD', account:'Brokerage', amount:0, asOf:'2025-12-31', currency:'USD', notes:'' };
  const DBS  = { id:'c_dbs', name:'DBS', account:'Savings', amount:1000, asOf:'2025-12-31', currency:'SGD', notes:'' };
  const SELL = { id:'t_sell', stockId:'s_aapl', date:'2026-03-10', side:'sell', shares:10, price:290, fees:5, cashAccountId:'c_ibkr', notes:'' };
  const BUY  = { id:'t_buy', stockId:'s_aapl', date:'2026-02-01', side:'buy', shares:5, price:200, fees:1, cashAccountId:'c_ibkr', notes:'' };
  const CLEAN_CONFIRM = n => 'Move ' + n + ' orphaned trade' + (n > 1 ? 's' : '') + ' to trash? A trade can only be restored from Settings → Recently deleted while the stock or cash account it points to is still there as well.';

  await testAsync('cleanOrphanedTrades - keeps its confirm, worded as it is: one undo step and one save for the batch, no Undo toast, and an orphan whose stock or account is gone is blocked on restore with the reason', async () => {
    const trades = [{ id:'t1', stockId:'ghost', date:'2026-03-01', side:'buy', shares:1, price:1, fees:0 }, { id:'t2', stockId:'s1', date:'2026-03-02', side:'buy', shares:1, price:1, fees:0 },
      { id:'t3', stockId:'s1', cashAccountId:'gone', date:'2026-03-03', side:'buy', shares:1, price:1, fees:0 }];
    const s1 = { id:'s1', symbol:'AAA', market:'US', shares:3, avgCost:10, currency:'USD' };
    const { sb, log, stack, payload } = orphanSandbox({ stocks:[clone(s1)], stockTxns:clone(trades) });
    const before = payload();
    log.answer = false;
    await sb.cleanOrphanedTrades();
    assert.strictEqual(log.confirms.length, 1);
    assert.strictEqual(log.confirms[0], CLEAN_CONFIRM(2));
    assert.strictEqual(payload(), before); assert.strictEqual(log.toasts.length, 0); assert.strictEqual(stack(), 0); assert.strictEqual(log.saves, 0);   // a refusal changes nothing
    log.answer = true;
    await sb.cleanOrphanedTrades();
    assert.deepStrictEqual(sb.DB.stockTxns.map(t => t.id), ['t2']);
    assert.strictEqual(stack(), 1); assert.strictEqual(log.saves, 1);                                                                                   // one step, one save for the batch
    assert.deepStrictEqual([log.toasts.at(-1).m, log.toasts.at(-1).k, log.toasts.at(-1).a], ['Moved 2 orphaned trades to trash', 'success', undefined]);   // a plain toast, no Undo promised
    // each orphan's stock or account is gone (never in the trash), so each is blocked with its reason and nothing moves
    const ids = sb.DB.trash.map(e => e.id);
    assert.strictEqual(ids.length, 2);
    const snap = payload();
    for (const id of ids) assert.strictEqual(await sb.restoreFromTrash(id), false);
    assert.deepStrictEqual(log.toasts.slice(-2).map(t => [t.m, t.k]), [['This trade cannot be restored: its stock is no longer in Recently deleted.', 'error'], ['This trade cannot be restored: its cash account is no longer in Recently deleted.', 'error']]);
    assert.strictEqual(payload(), snap); assert.strictEqual(sb.DB.trash.length, 2); assert.strictEqual(sb.DB.stockTxns.length, 1); assert.strictEqual(log.saves, 1); assert.strictEqual(stack(), 1);
    // Ctrl+Z puts the batch back in one go
    await sb.undoAction();
    assert.deepStrictEqual(clone(sb.DB.stockTxns.map(t => t.id)), ['t1', 't2', 't3']); assert.deepStrictEqual(clone(sb.DB.trash), []);
    // nothing orphaned: nothing happens
    const calm = orphanSandbox({ stocks:[clone(s1)], stockTxns:[clone(trades[1])] });
    await calm.sb.cleanOrphanedTrades();
    assert.strictEqual(calm.log.confirms.length + calm.log.toasts.length + calm.stack() + calm.log.saves, 0);
    // the source: one confirm, then the one undo step, then the moves (which do not save), the trim, and the one save, and no Undo toast is wired to it
    const src = extractFunction('cleanOrphanedTrades');
    assert.strictEqual((src.match(/confirm\(/g) || []).length, 1);
    assert.ok(src.indexOf('confirm(') < src.indexOf('pushUndo();') && src.indexOf('pushUndo();') < src.indexOf("_moveToTrash('stockTxns', id)"));
    assert.ok(src.indexOf("_moveToTrash('stockTxns', id)") < src.indexOf('_trimTrash();') && src.indexOf('_trimTrash();') < src.indexOf('saveData()'));
    assert.strictEqual((src.match(/saveData\(/g) || []).length, 1);
    assert.ok(!src.includes('sendToTrash(') && !src.includes('undoDeleteToast'));
    assert.ok(extractFunction('sendToTrash').includes('_trimTrash();') && !extractFunction('_moveToTrash').includes('saveData'));
  });

  await testAsync('Recently deleted - a trade whose stock is in the trash comes back with it in one step: one undo step, one save, ids kept, no stock field invented, the position and the balance as before the delete', async () => {
    const { sb, log, host, stack } = orphanSandbox({ stocks:[clone(AAPL)], cash:[clone(IBKR)], stockTxns:[clone(BUY), clone(SELL)] });
    const positionBefore = clone(sb.deriveStockPosition('s_aapl')), balanceBefore = sb.deriveCashBalance(sb.DB.cash[0]);
    assert.strictEqual(sb.runReconciliation().ok, true);
    // the stock goes (the cascade dialog says its two trades are left orphaned), then Remove orphaned moves both: one dialog, one undo step, one save
    sb._modalState = { table:'stocks', item:clone(AAPL), isNew:false };
    assert.strictEqual(await sb.entityModalDelete(), true);
    assert.strictEqual(sb.runReconciliation().ok, false);
    const s1 = stack(), v1 = log.saves;
    await sb.cleanOrphanedTrades();
    assert.strictEqual(log.confirms.at(-1), CLEAN_CONFIRM(2));
    assert.strictEqual(stack(), s1 + 1); assert.strictEqual(log.saves, v1 + 1);
    assert.deepStrictEqual(sb.DB.stockTxns, []); assert.strictEqual(sb.DB.trash.length, 3);
    assert.deepStrictEqual(log.toasts.at(-1), { m:'Moved 2 orphaned trades to trash', k:'success', a:undefined });
    // the list: the trades read AAPL (from the stock's own trash entry), never "?", and their button promises the stock
    sb.renderTrash();
    assert.strictEqual(host.innerHTML.includes('?'), false);
    assert.ok(host.innerHTML.includes('Sell 10 AAPL · 10/03/2026') && host.innerHTML.includes('Buy 5 AAPL · 01/02/2026') && host.innerHTML.includes('AAPL · US'));
    assert.strictEqual((host.innerHTML.match(/>Restore stock and trade</g) || []).length, 2);
    assert.strictEqual((host.innerHTML.match(/>Restore</g) || []).length, 1);                                  // the stock's own row
    assert.strictEqual(host.innerHTML.includes('trash-note'), false);
    // restore the sell: the stock comes back first, with its id and every field as stored, then the trade, still pointing at it
    const sellEntry = sb.DB.trash.find(e => e.table === 'stockTxns' && e.data.id === 't_sell');
    const s2 = stack(), v2 = log.saves;
    assert.strictEqual(await sb.restoreFromTrash(sellEntry.id), true);
    assert.strictEqual(stack(), s2 + 1); assert.strictEqual(log.saves, v2 + 1);
    assert.deepStrictEqual(log.toasts.at(-1), { m:'Restored stock and trade. 1 more trade of AAPL is still in Recently deleted', k:'success', a:undefined });
    const back = sb.DB.stocks.find(s => s.id === 's_aapl');
    ['symbol', 'market', 'sector', 'shares', 'avgCost', 'currency', 'divPerShare', 'createdAt'].forEach(k => assert.strictEqual(back[k], AAPL[k], k));
    const sell = sb.DB.stockTxns.find(t => t.id === 't_sell');
    ['stockId', 'date', 'side', 'shares', 'price', 'fees', 'cashAccountId'].forEach(k => assert.strictEqual(sell[k], SELL[k], k));
    assert.deepStrictEqual(sb.DB.trash.map(e => e.data.id), ['t_buy']);
    // the sibling is one plain click now
    sb.renderTrash();
    assert.ok(host.innerHTML.includes('>Restore<') && !host.innerHTML.includes('Restore stock'));
    assert.strictEqual(await sb.restoreFromTrash(sb.DB.trash[0].id), true);
    assert.strictEqual(log.toasts.at(-1).m, 'Restored');
    // money: the position and the balance are what they were before the delete, and the books reconcile
    assert.deepStrictEqual(clone(sb.deriveStockPosition('s_aapl')), positionBefore);
    assert.strictEqual(sb.deriveCashBalance(sb.DB.cash[0]), balanceBefore);
    assert.strictEqual(sb.runReconciliation().ok, true);
    assert.deepStrictEqual(sb.DB.trash, []);
  });

  await testAsync('Recently deleted - a trade whose stock is gone from the trash is blocked with a plain reason: nothing changes, nothing is saved, no undo step, and the label reads unknown stock, never "?"', async () => {
    const { sb, log, host, stack, payload } = orphanSandbox({ cash:[clone(IBKR)], trash:[{ id:'tr_sell', table:'stockTxns', ts:'2026-10-01T00:00:00.000Z', data:clone(SELL) }] });
    const before = payload();
    sb.renderTrash();
    assert.ok(host.innerHTML.includes('Sell 10 unknown stock · 10/03/2026'));
    assert.strictEqual(host.innerHTML.includes('?'), false);
    assert.ok(host.innerHTML.includes('<span class="hint trash-note">This trade cannot be restored: its stock is no longer in Recently deleted.</span>'));
    assert.ok(host.innerHTML.includes('>Restore<') && !host.innerHTML.includes('Restore stock'));
    assert.strictEqual(await sb.restoreFromTrash('tr_sell'), false);
    assert.deepStrictEqual(log.toasts.at(-1), { m:'This trade cannot be restored: its stock is no longer in Recently deleted.', k:'error', a:undefined });
    assert.strictEqual(payload(), before); assert.strictEqual(log.saves, 0); assert.strictEqual(stack(), 0); assert.strictEqual(log.confirms.length, 0);
    // the toast's Undo fallback inherits the block: it reports false and leaves the entry
    assert.strictEqual(await sb.undoDeleteToast({ snapshot:'stale', revision:-1, trashIds:['tr_sell'] }), false);
    assert.strictEqual(payload(), before);
    // a symbol the row carries is named, and both gone reads as one sentence
    const two = orphanSandbox({ trash:[{ id:'tr_x', table:'stockTxns', ts:'2026-10-01T00:00:00.000Z', data:Object.assign(clone(SELL), { symbol:'AAPL' }) }] });
    assert.strictEqual(await two.sb.restoreFromTrash('tr_x'), false);
    assert.strictEqual(two.log.toasts.at(-1).m, 'This trade cannot be restored: its stock (AAPL) and its cash account are no longer in Recently deleted.');
    assert.strictEqual(two.sb.trashLabel('stockTxns', two.sb.DB.trash[0].data), 'Sell 10 AAPL · 10/03/2026');
  });

  await testAsync('Recently deleted - a trade whose cash account is in the trash restores the account and the trade, the balance as before', async () => {
    const { sb, log, host, stack } = orphanSandbox({ stocks:[clone(AAPL)], cash:[clone(IBKR)], stockTxns:[clone(SELL)] });
    const balanceBefore = sb.deriveCashBalance(sb.DB.cash[0]), positionBefore = clone(sb.deriveStockPosition('s_aapl'));
    sb._modalState = { table:'cash', item:clone(IBKR), isNew:false };
    assert.strictEqual(await sb.entityModalDelete(), true);
    await sb.cleanOrphanedTrades();
    assert.strictEqual(log.confirms.at(-1), CLEAN_CONFIRM(1));
    sb.renderTrash();
    assert.ok(host.innerHTML.includes('>Restore cash account and trade<') && host.innerHTML.includes('Sell 10 AAPL · 10/03/2026'));
    const entry = sb.DB.trash.find(e => e.table === 'stockTxns');
    const s1 = stack(), v1 = log.saves;
    assert.strictEqual(await sb.restoreFromTrash(entry.id), true);
    assert.strictEqual(stack(), s1 + 1); assert.strictEqual(log.saves, v1 + 1);
    assert.deepStrictEqual(log.toasts.at(-1), { m:'Restored cash account and trade', k:'success', a:undefined });
    assert.deepStrictEqual(sb.DB.cash.map(c => [c.id, c.name, c.account, c.currency, c.amount, c.asOf]), [['c_ibkr', 'IBKR USD', 'Brokerage', 'USD', 0, '2025-12-31']]);
    assert.deepStrictEqual(sb.DB.stockTxns.map(t => [t.id, t.cashAccountId]), [['t_sell', 'c_ibkr']]);
    assert.strictEqual(sb.deriveCashBalance(sb.DB.cash[0]), balanceBefore);
    assert.deepStrictEqual(clone(sb.deriveStockPosition('s_aapl')), positionBefore);
    assert.strictEqual(sb.runReconciliation().ok, true); assert.deepStrictEqual(sb.DB.trash, []);
  });

  await testAsync('Recently deleted - a trade missing both comes back with the stock and the cash account in one step (one undo step, one save, ids kept), and a trade whose id is taken gets a new one that still points at them', async () => {
    const { sb, log, host, stack, payload } = orphanSandbox({ stocks:[clone(AAPL)], cash:[clone(IBKR)], stockTxns:[clone(SELL)] });
    const positionBefore = clone(sb.deriveStockPosition('s_aapl')), balanceBefore = sb.deriveCashBalance(sb.DB.cash[0]);
    sb._modalState = { table:'stocks', item:clone(AAPL), isNew:false }; await sb.entityModalDelete();
    sb._modalState = { table:'cash', item:clone(IBKR), isNew:false }; await sb.entityModalDelete();
    await sb.cleanOrphanedTrades();
    assert.strictEqual(sb.DB.trash.length, 3);
    sb.renderTrash();
    assert.ok(host.innerHTML.includes('>Restore stock, cash account and trade<'));
    const entry = sb.DB.trash.find(e => e.table === 'stockTxns');
    const s1 = stack(), v1 = log.saves, before = payload();
    assert.strictEqual(await sb.restoreFromTrash(entry.id), true);
    assert.strictEqual(stack(), s1 + 1); assert.strictEqual(log.saves, v1 + 1);
    assert.strictEqual(vm.runInContext('_undoStack[_undoStack.length - 1]', sb), before);                   // the one snapshot is the state just before
    assert.deepStrictEqual(log.toasts.at(-1), { m:'Restored stock, cash account and trade', k:'success', a:undefined });
    assert.deepStrictEqual([sb.DB.stocks[0].id, sb.DB.cash[0].id, sb.DB.stockTxns[0].id, sb.DB.stockTxns[0].stockId, sb.DB.stockTxns[0].cashAccountId], ['s_aapl', 'c_ibkr', 't_sell', 's_aapl', 'c_ibkr']);
    assert.deepStrictEqual(clone(sb.deriveStockPosition('s_aapl')), positionBefore);
    assert.strictEqual(sb.deriveCashBalance(sb.DB.cash[0]), balanceBefore);
    assert.strictEqual(sb.runReconciliation().ok, true); assert.deepStrictEqual(sb.DB.trash, []);
    // Ctrl+Z puts the whole step back: all three rows to the trash
    await sb.undoAction();
    assert.strictEqual(sb.DB.trash.length, 3); assert.deepStrictEqual(clone([sb.DB.stocks, sb.DB.cash, sb.DB.stockTxns]), [[], [], []]);
    // a live trade already holds the trashed trade's id: the trade takes a new id, the stock keeps its own, the trade points at it, and the live trade is untouched
    const other = { id:'t_sell', stockId:'s_other', date:'2026-04-01', side:'buy', shares:1, price:1, fees:0, cashAccountId:'c_ibkr', notes:'' };
    const col = orphanSandbox({ stocks:[{ id:'s_other', symbol:'OTH', market:'US', shares:1, avgCost:1, currency:'USD' }], cash:[clone(IBKR)], stockTxns:[clone(other)],
      trash:[{ id:'tr_s', table:'stocks', ts:'2026-10-01T00:00:00.000Z', data:clone(AAPL) }, { id:'tr_t', table:'stockTxns', ts:'2026-10-02T00:00:00.000Z', data:clone(SELL) }] });
    assert.strictEqual(await col.sb.restoreFromTrash('tr_t'), true);
    const restored = col.sb.DB.stockTxns.filter(t => t.stockId === 's_aapl');
    assert.strictEqual(restored.length, 1); assert.notStrictEqual(restored[0].id, 't_sell'); assert.strictEqual(restored[0].cashAccountId, 'c_ibkr');
    assert.strictEqual(col.sb.DB.stocks.find(s => s.id === 's_aapl').symbol, 'AAPL');
    assert.deepStrictEqual(col.sb.DB.stockTxns.find(t => t.id === 't_sell').stockId, 's_other');
    assert.strictEqual(col.sb.runReconciliation().ok, true);
  });

  await testAsync('Recently deleted - the trade form\'s guards run on a restore: a declined over-sell question, a funding account in another currency or a parent that fails validation leaves everything unchanged, nothing saved, no undo step', async () => {
    const big = Object.assign(clone(SELL), { shares:50 });
    const { sb, log, stack, payload } = orphanSandbox({ cash:[clone(IBKR)], trash:[{ id:'tr_s', table:'stocks', ts:'2026-10-01T00:00:00.000Z', data:clone(AAPL) }, { id:'tr_t', table:'stockTxns', ts:'2026-10-02T00:00:00.000Z', data:big }] });
    const before = payload();
    log.answer = false;
    assert.strictEqual(await sb.restoreFromTrash('tr_t'), false);
    assert.deepStrictEqual(log.confirms, ['This sells 50 shares of AAPL but only 30 were held as of 10/03/2026.\n\nRestore anyway?']);
    assert.strictEqual(payload(), before); assert.strictEqual(log.saves, 0); assert.strictEqual(stack(), 0); assert.strictEqual(log.toasts.length, 0);
    assert.deepStrictEqual([sb.DB.stocks, sb.DB.stockTxns], [[], []]);                                           // the staged stock is gone again
    // a yes goes through, as in the trade form
    log.answer = true;
    assert.strictEqual(await sb.restoreFromTrash('tr_t'), true);
    assert.deepStrictEqual([sb.DB.stocks.length, sb.DB.stockTxns.length, stack(), log.saves, sb.DB.trash.length], [1, 1, 1, 1, 0]);
    // a USD trade funded from an SGD account is refused with the form's reason
    const mis = orphanSandbox({ cash:[clone(DBS)], trash:[{ id:'tr_s', table:'stocks', ts:'2026-10-01T00:00:00.000Z', data:clone(AAPL) }, { id:'tr_t', table:'stockTxns', ts:'2026-10-02T00:00:00.000Z', data:Object.assign(clone(SELL), { shares:5, cashAccountId:'c_dbs' }) }] });
    const before2 = mis.payload();
    assert.strictEqual(await mis.sb.restoreFromTrash('tr_t'), false);
    assert.deepStrictEqual(mis.log.toasts.at(-1), { m:'Cannot restore this trade: it is in USD but DBS holds SGD. It remains in Recently deleted.', k:'error', a:undefined });
    assert.strictEqual(mis.payload(), before2); assert.strictEqual(mis.log.saves, 0); assert.strictEqual(mis.stack(), 0);
    // a parent that fails its own validation stops the whole step before anything moves
    const bad = orphanSandbox({ cash:[clone(IBKR)], trash:[{ id:'tr_s', table:'stocks', ts:'2026-10-01T00:00:00.000Z', data:Object.assign(clone(AAPL), { symbol:'<img>' }) }, { id:'tr_t', table:'stockTxns', ts:'2026-10-02T00:00:00.000Z', data:clone(SELL) }] });
    const before3 = bad.payload();
    assert.strictEqual(await bad.sb.restoreFromTrash('tr_t'), false);
    assert.strictEqual(bad.log.toasts.at(-1).m, 'Cannot restore this stock: Symbol is invalid. It remains in Recently deleted.');
    assert.strictEqual(bad.payload(), before3); assert.strictEqual(bad.log.saves, 0); assert.strictEqual(bad.stack(), 0);
  });

  await testAsync('_trimTrash - past TRASH_MAX the oldest entries go first but never the stock or cash account a trashed trade points to, a batch of 100 orphans keeps every parent, and the list exceeds the cap only by such parents', async () => {
    const sb = freshSandbox({ trash:[] });
    const MAX = vm.runInContext('TRASH_MAX', sb);
    assert.strictEqual(MAX, 100);
    const old = (i, table) => ({ id:'tr_old' + i, table:table || 'expenses', ts:'2026-01-01T00:00:00.000Z', data:{ id:'x' + i, amount:1 } });
    // the stock parent is the oldest entry, 99 expenses after it, then the trade that needs it: the second-oldest expense goes, the stock stays
    sb.DB.trash = [{ id:'tr_stock', table:'stocks', ts:'2025-12-01T00:00:00.000Z', data:{ id:'s1', symbol:'AAA' } }].concat(Array.from({ length:99 }, (_, i) => old(i)));
    sb.DB.trash.push({ id:'tr_trade', table:'stockTxns', ts:'2026-02-01T00:00:00.000Z', data:{ id:'t1', stockId:'s1', side:'buy', shares:1 } });
    sb._trimTrash();
    assert.strictEqual(sb.DB.trash.length, 100);
    assert.deepStrictEqual([sb.DB.trash[0].id, sb.DB.trash[1].id, sb.DB.trash.at(-1).id], ['tr_stock', 'tr_old1', 'tr_trade']);
    // one more delete on the full list: the same rule
    sb.DB.expenses = [{ id:'e_new', amount:2 }]; sb.saveData = () => true;
    assert.strictEqual(sb.sendToTrash('expenses', 'e_new'), true);
    assert.strictEqual(sb.DB.trash.length, 100); assert.strictEqual(sb.DB.trash[0].id, 'tr_stock'); assert.strictEqual(sb.DB.trash.at(-1).data.id, 'e_new');
    // a batch of 100 orphans on a list already at the cap: the two stocks and the cash account those trades point to stay, the oldest others go
    const two = freshSandbox({ trash:[], stocks:[], cash:[], stockTxns:[] });
    two.saveData = () => true; two.confirm = () => true; two.showToast = () => {};
    let n = 0; two.uid = t => t + '_' + (++n);
    two.DB.trash = Array.from({ length:MAX - 4 }, (_, i) => old(i));
    two.DB.trash.push({ id:'tr_s1', table:'stocks', ts:'2026-01-02T00:00:00.000Z', data:{ id:'s1', symbol:'AAA' } });
    two.DB.trash.push({ id:'tr_s2', table:'stocks', ts:'2026-01-02T00:00:00.000Z', data:{ id:'s2', symbol:'BBB' } });
    two.DB.trash.push({ id:'tr_c1', table:'cash', ts:'2026-01-02T00:00:00.000Z', data:{ id:'c1', name:'DBS' } });
    two.DB.trash.push(old(999));
    assert.strictEqual(two.DB.trash.length, MAX);
    two.DB.stockTxns = Array.from({ length:100 }, (_, i) => ({ id:'t' + i, stockId: i % 2 ? 's1' : 's2', cashAccountId: i % 3 ? 'c1' : '', date:'2026-03-01', side:'buy', shares:1, price:1, fees:0 }));
    await two.cleanOrphanedTrades();
    assert.strictEqual(two.DB.stockTxns.length, 0);
    assert.strictEqual(two.DB.trash.length, MAX);
    assert.deepStrictEqual(two.DB.trash.filter(e => e.table !== 'stockTxns').map(e => e.id), ['tr_s1', 'tr_s2', 'tr_c1']);                           // every parent, no expense
    assert.deepStrictEqual(two.DB.trash.filter(e => e.table === 'stockTxns').slice(0, 2).map(e => e.data.id), ['t3', 't4']);                            // the three oldest of the batch made room, the rest are there
    // the cap can only be met by dropping a parent: it is raised instead, the list holds every parent and nothing else
    const three = freshSandbox({ trash:[] });
    three.DB.trash = [];
    for (let i = 0; i < MAX + 1; i++){
      three.DB.trash.push({ id:'tr_s' + i, table:'stocks', ts:'2026-01-01T00:00:00.000Z', data:{ id:'s' + i, symbol:'S' + i } });
      three.DB.trash.push({ id:'tr_t' + i, table:'stockTxns', ts:'2026-01-02T00:00:00.000Z', data:{ id:'t' + i, stockId:'s' + i, side:'buy', shares:1 } });
    }
    three._trimTrash();
    assert.strictEqual(three.DB.trash.length, MAX + 1);
    assert.ok(three.DB.trash.every(e => e.table === 'stocks'));
    three._trimTrash();                                                                                      // nothing points at them now, so the next trim treats them as ordinary entries
    assert.strictEqual(three.DB.trash.length, MAX);
    // under the cap nothing moves, and a null entry is dropped first
    const four = freshSandbox({ trash:[old(1), null, old(2)] });
    four._trimTrash();
    assert.strictEqual(four.DB.trash.length, 3);
    assert.ok(appSrc.slice(appSrc.indexOf('Keep the trash within TRASH_MAX'), appSrc.indexOf('function _trimTrash(')).includes('max(TRASH_MAX, protected parents)'));   // the bound is documented above the function
  });

  await testAsync('undoDeleteToast - still restores from the trash when the delete step is no longer the newest, and brings a trade\'s trashed stock back with it', async () => {
    // a plain trade delete, an edit saved in between, Undo: the trade comes back from the trash as before
    const { sb, log } = orphanSandbox({ stocks:[clone(AAPL)], cash:[clone(IBKR)], stockTxns:[clone(SELL)] });
    sb._modalState = { table:'stockTxns', item:clone(SELL), isNew:false };
    assert.strictEqual(await sb.entityModalDelete(), true);
    assert.strictEqual(log.confirms.length, 0);
    const toast = log.toasts.at(-1);
    assert.strictEqual(toast.m, 'Deleted trade');
    sb.pushUndo(); sb.DB.stocks[0].notes = 'edited'; sb.saveData();
    assert.strictEqual(await toast.a.fn(), true);
    assert.strictEqual(log.toasts.at(-1).m, 'Restored');
    assert.deepStrictEqual(sb.DB.stockTxns.map(t => t.id), ['t_sell']); assert.strictEqual(sb.DB.stocks[0].notes, 'edited'); assert.deepStrictEqual(sb.DB.trash, []);
    // the stock and its trade both in the trash, a step naming the trade: the compound restore runs through the toast's fallback
    const two = orphanSandbox({ cash:[clone(IBKR)], trash:[{ id:'tr_s', table:'stocks', ts:'2026-10-01T00:00:00.000Z', data:clone(AAPL) }, { id:'tr_t', table:'stockTxns', ts:'2026-10-02T00:00:00.000Z', data:clone(SELL) }] });
    assert.strictEqual(await two.sb.undoDeleteToast({ snapshot:'stale', revision:-1, trashIds:['tr_t'] }), true);
    assert.deepStrictEqual([two.sb.DB.stocks.length, two.sb.DB.stockTxns.length, two.sb.DB.trash.length], [1, 1, 0]);
    assert.strictEqual(two.log.toasts.at(-1).m, 'Restored stock and trade');
  });

  test('trashLabel - a trade names its stock from the live row, else the stock\'s trash entry (the newest), else a symbol on the row, else "unknown stock", and never "?"', () => {
    const sb = freshSandbox({ stocks:[{ id:'s1', symbol:'AAPL' }], trash:[
      { id:'tr_a', table:'stocks', ts:'2026-01-01T00:00:00.000Z', data:{ id:'s2', symbol:'OLD' } },
      { id:'tr_b', table:'stocks', ts:'2026-02-01T00:00:00.000Z', data:{ id:'s2', symbol:'NEW' } }] });
    const label = data => sb.trashLabel('stockTxns', data);
    assert.strictEqual(label({ stockId:'s1', side:'buy', shares:10, date:'2026-03-01' }), 'Buy 10 AAPL · 01/03/2026');
    assert.strictEqual(label({ stockId:'s2', side:'sell', shares:3 }), 'Sell 3 NEW');
    assert.strictEqual(label({ stockId:'s9', side:'buy', shares:1, symbol:'ROW' }), 'Buy 1 ROW');
    assert.strictEqual(label({ stockId:'s9', side:'buy', shares:1 }), 'Buy 1 unknown stock');
    assert.strictEqual(label({ side:'buy', shares:1 }), 'Buy 1 unknown stock');
    assert.strictEqual(label(null), 'Buy 0 unknown stock');
    [{ stockId:'s1' }, { stockId:'s2' }, { stockId:'s9' }, {}].forEach(d => assert.strictEqual(label(d).includes('?'), false, JSON.stringify(d)));
    assert.ok(extractFunction('trashLabel').includes("case 'stockTxns': return (data.side === 'sell' ? 'Sell ' : 'Buy ') + (Math.abs(Number(data.shares)||0)) + ' ' + _trashTradeSymbol(data) + d;"));
    // the row's note sits on its own line, and the restore action is the one handler for both the plain and the compound restore
    assert.ok(indexSrc.includes('.trash-note{flex-basis:100%}'));
    assert.ok(extractFunction('renderTrash').includes('data-click="restoreFromTrash"') && !extractFunction('renderTrash').includes('data-click="restoreWith'));
  });

  test('Chart.js draws without animation under reduced motion, every chart config asks _reducedMotion for its duration', () => {
    assert.strictEqual((appSrc.match(/animation:\{duration:_reducedMotion\(\) \? 0 : 300\}/g) || []).length, 5);
    assert.strictEqual(/animation:\{duration:300\}/.test(appSrc), false);                        // no chart keeps a fixed 300ms
    // the five configs above are every chart config: three through _pbMountChart and two built directly (insurance premiums, projections)
    assert.strictEqual((appSrc.match(/new Chart\(canvas\.getContext\('2d'\), \{|_pbMountChart\(host\.canvasId, \{/g) || []).length, 5);
  });

  test('Toasts with an action - the Undo is a real button with a focus ring, the toast holds still while the pointer or the keyboard is on it, and the host announces it politely', () => {
    const src = extractFunction('showToast');
    assert.ok(src.includes("btn.className = 'toast-act'") && src.includes("document.createElement('button')") && src.includes("btn.type = 'button'"));
    assert.strictEqual(src.includes('style.cssText'), false);                                          // no inline style on the button, the class carries it
    ['mouseenter', 'focusin', 'mouseleave', 'focusout'].forEach(ev => assert.ok(src.includes("el.addEventListener('" + ev + "'"), ev));
    assert.ok(src.includes('arm((action || kind === \'error\') ? 8000 : 5000);') && src.includes('arm(3000)'));
    assert.ok(src.indexOf('if (hasAction){\n    // A toast with an action holds still') > src.indexOf('arm((action'));        // a plain toast never pauses
    assert.ok(indexSrc.includes('<div id="toast-host" aria-live="polite" role="status"></div>'));
    assert.ok(indexSrc.includes('.toast-act{margin-left:12px;padding:2px 4px;border:0;border-radius:4px;background:none;color:inherit;font:inherit;font-weight:700;text-decoration:underline;cursor:pointer}'));
    assert.ok(indexSrc.includes('.toast-act:focus-visible{outline:2px solid var(--accent);outline-offset:2px}'));
    assert.ok(extractFunction('togglePrivacy').includes("showToast(on ? 'Amounts hidden' : 'Amounts shown');"));    // plain toasts keep their shape
  });

  test('Step 8b styles - the flash fades over 1.2s from the gain and loss soft tokens behind the content, the skeleton shimmers on the surface tokens, and every animation has a reduced-motion override', () => {
    const start = indexSrc.indexOf('/* PRICE FLASH AND LOADING SKELETONS (Step 8b).');
    assert.ok(start > -1);
    const css = indexSrc.slice(start, indexSrc.indexOf('</style>', start));
    assert.ok(css.includes('@keyframes flash-fade{from{opacity:1}to{opacity:0}}'));
    assert.ok(css.includes('animation:flash-fade 1.2s ease-out var(--px-delay,0s) both'));
    assert.ok(css.includes('.flash-up:not(tr)::before,tr.flash-up > td::before{background:var(--gain-soft)}') && css.includes('.flash-down:not(tr)::before,tr.flash-down > td::before{background:var(--loss-soft)}'));
    assert.ok(css.includes('z-index:-1') && css.includes('isolation:isolate') && css.includes('pointer-events:none'));                       // a layer behind the content, the layout never moves
    assert.ok(css.includes('tr.flash-up > td.sticky-col,tr.flash-down > td.sticky-col{position:sticky}'));                                  // the sticky symbol column stays sticky
    assert.ok(css.includes('@keyframes skel-shimmer{from{background-position:200% 0}to{background-position:-200% 0}}'));
    assert.ok(css.includes('background:linear-gradient(90deg,var(--bg3) 25%,var(--bg4) 50%,var(--bg3) 75%)') && css.includes('animation:skel-shimmer 1.4s linear infinite'));
    assert.strictEqual(/#[0-9a-fA-F]{3,8}\b|rgba?\(/.test(css), false);                                                                      // tokens only
    // reduced motion: no flash layer at all, a still bar
    const rm = css.slice(css.indexOf('@media (prefers-reduced-motion:reduce){'));
    assert.ok(rm.includes('.flash-up:not(tr)::before,.flash-down:not(tr)::before,tr.flash-up > td::before,tr.flash-down > td::before{content:none;animation:none}') && rm.includes('.skel{animation:none}'));
    // every keyframe in the page has its override: a new one without a line here fails this on purpose
    const names = Array.from(indexSrc.matchAll(/@keyframes ([a-z-]+)/g)).map(m => m[1]).sort();
    assert.deepStrictEqual(names, ['flash-fade', 'hero-pulse', 'pulse', 'skel-shimmer', 'tin']);
    const overrides = { pulse:'.sync-pill::before,.sync-dot::before{animation:none}', tin:'.toast{animation:none}', 'hero-pulse':'.hero-dot.end::after{animation:none', 'flash-fade':'content:none;animation:none', 'skel-shimmer':'.skel{animation:none}' };
    const regions = Array.from(indexSrc.matchAll(/@media \(prefers-reduced-motion: ?reduce\)/g)).map(m => indexSrc.slice(m.index, m.index + 400)).join('\n');
    names.forEach(n => assert.ok(regions.includes(overrides[n]), n + ' has no reduced-motion override'));
    // the panel slide and the palette fade were already covered, and stay so
    assert.ok(indexSrc.includes('@media (prefers-reduced-motion:reduce){\n  .hp-overlay,.hp-overlay::before,.hp-panel,.cp-overlay{transition:none}\n}'));
  });

  console.log(`\nTests completed: ${passed} passed, ${failed} failed.`);
  if (failed > 0) process.exit(1);
}

runTests().catch(err => {
  console.error(err);
  process.exit(1);
});
